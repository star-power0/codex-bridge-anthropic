/**
 * Claude / Anthropic Messages adapter for CodexBridge.
 *
 * Baiyuan and similar Claude relays often keep healthy Anthropic /v1/messages
 * account pools while their OpenAI /v1/chat/completions path returns:
 *   HTTP 503 No available accounts
 *
 * This module converts OpenAI chat payloads <-> Anthropic messages, preferring
 * streaming messages (which is what CC Switch / Claude Code successfully use).
 */

import { isDeepStrictEqual } from "node:util";
import { tryParseJson } from "./json.js";
import {
  buildToolContext,
  chatMessageFromToolOutput,
  chatToolCallFromResponseItem,
  isResponseToolCallItem,
  isResponseToolOutputItem,
  responseToolCallFromClaude,
  toolDiagnosticsFromContext,
} from "./tools.js";
import {
  attachmentGuidanceFromRequest,
  normalizeDataImageForChat,
  responseToolsForChatRequest,
  stripExactPersistedHistoryPrefix,
  systemInstructionsFromRequest,
  toolGuidanceFromContext,
} from "./responses-to-chat.js";

const MAX_CLAUDE_IMAGE_MESSAGES = 4;
const HISTORICAL_IMAGE_PLACEHOLDER =
  "[image from earlier conversation omitted to prevent repeated image upload]";
const TOOL_RESULT_IMAGE_PLACEHOLDER =
  "[image result forwarded as an image attachment]";

export function shouldUseClaudeMessagesUpstream(route = {}) {
  if (route?.preferClaudeMessages === false || route?.preferAnthropicMessages === false) {
    return false;
  }
  if (String(route?.api || "").toLowerCase() === "anthropic_messages") {
    return true;
  }
  if (route?.preferClaudeMessages === true || route?.preferAnthropicMessages === true) {
    return true;
  }
  if (String(route?.upstreamApi || route?.apiFormat || "").toLowerCase().includes("anthropic")) {
    return true;
  }
  if (String(route?.api || "").toLowerCase() === "responses") {
    return false;
  }
  return isClaudeLikeRoute(route);
}

export function isClaudeLikeRoute(route = {}) {
  const blob = [
    route.provider,
    route.providerId,
    route.providerFamily,
    route.model,
    route.id,
    route.displayName,
    route.sourcePresetId,
    route.baseUrl,
  ]
    .map((value) => String(value || "").toLowerCase())
    .join(" ");
  return (
    blob.includes("claude") ||
    blob.includes("anthropic") ||
    blob.includes("sonnet") ||
    blob.includes("opus") ||
    blob.includes("haiku")
  );
}

export function claudeMessagesUrlForRoute(route = {}, joinUpstreamUrl) {
  const base = String(route?.baseUrl || "").replace(/\/+$/, "");
  if (!base) {
    return "/v1/messages";
  }
  if (/\/v1\/messages$/i.test(base) || /\/messages$/i.test(base)) {
    return base;
  }
  if (/\/v1$/i.test(base)) {
    return `${base}/messages`;
  }
  // Baiyuan / CC Switch use https://host/v1/messages even when base is root.
  return joinUpstreamUrl ? joinUpstreamUrl(base, "/v1/messages") : `${base}/v1/messages`;
}

export function chatPayloadToClaudeMessages(payload = {}, route = {}) {
  const model = String(payload.model || route.model || "").trim();
  const messagesIn = Array.isArray(payload.messages) ? payload.messages : [];
  const systemParts = [];
  const messages = [];

  for (const message of messagesIn) {
    if (!message || typeof message !== "object") continue;
    const role = String(message.role || "").toLowerCase();

    if (role === "system" || role === "developer") {
      const text = contentToPlainText(message.content);
      if (text) systemParts.push(text);
      continue;
    }

    if (role === "tool") {
      const toolResult = {
        type: "tool_result",
        tool_use_id: String(message.tool_call_id || message.id || `tool_${messages.length}`),
        content: contentToPlainText(message.content) || "",
      };
      const last = messages[messages.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content)) {
        last.content.push(toolResult);
      } else {
        messages.push({ role: "user", content: [toolResult] });
      }
      continue;
    }

    if (role === "assistant") {
      const content = [];
      const text = contentToPlainText(message.content);
      if (text) {
        content.push({ type: "text", text });
      }
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      for (const toolCall of toolCalls) {
        const fn = toolCall?.function || {};
        let input = {};
        try {
          input = fn.arguments ? JSON.parse(fn.arguments) : {};
        } catch {
          input = { raw: String(fn.arguments || "") };
        }
        content.push({
          type: "tool_use",
          id: String(toolCall.id || `toolu_${content.length}`),
          name: String(fn.name || toolCall.name || "tool"),
          input: input && typeof input === "object" ? input : { value: input },
        });
      }
      if (content.length === 0) {
        content.push({ type: "text", text: "" });
      }
      messages.push({ role: "assistant", content });
      continue;
    }

    // user / default
    const content = openAiContentToClaudeContent(message.content);
    messages.push({
      role: "user",
      content: content.length ? content : [{ type: "text", text: "" }],
    });
  }

  if (messages.length === 0) {
    messages.push({ role: "user", content: [{ type: "text", text: "ping" }] });
  }

  // Anthropic requires alternating user/assistant and first message user.
  const normalized = normalizeClaudeMessageRoles(messages);

  const body = {
    model,
    max_tokens: Number(payload.max_tokens || payload.max_completion_tokens || 4096) || 4096,
    messages: normalized,
    stream: true,
  };

  if (systemParts.length) {
    body.system = systemParts.join("\n\n");
  }

  const tools = openAiToolsToClaudeTools(payload.tools);
  if (tools.length) {
    body.tools = tools;
  }

  const toolChoice = openAiToolChoiceToClaude(payload.tool_choice);
  if (toolChoice) {
    body.tool_choice = toolChoice;
  }

  if (payload.temperature !== undefined && payload.temperature !== null) {
    body.temperature = payload.temperature;
  }
  if (payload.top_p !== undefined && payload.top_p !== null) {
    body.top_p = payload.top_p;
  }
  if (payload.stop !== undefined && payload.stop !== null) {
    body.stop_sequences = Array.isArray(payload.stop) ? payload.stop : [payload.stop];
  }

  return body;
}

export function responsesToClaudeMessagesRequest(request = {}, route = {}, history, options = {}) {
  const toolContext = buildToolContext(responseToolsForChatRequest(request, options), { route });
  const persistedPriorMessages = history?.get?.(request.previous_response_id) || [];
  const currentMessages = stripExactPersistedHistoryPrefix(
    responseInputToCanonicalMessages(request.messages ?? request.input, toolContext, route),
    persistedPriorMessages,
  );
  const headerMessages = nativeClaudeHeaderMessages(request, toolContext);
  const sourceMessages = retainRecentCanonicalImages([
    ...missingHeaderMessages(headerMessages, persistedPriorMessages),
    ...persistedPriorMessages,
    ...currentMessages,
  ]);
  const claude = canonicalMessagesToClaudeMessages(sourceMessages);
  const body = {
    model: String(route.model || request.model || "").trim(),
    max_tokens: positiveNumber(
      request.max_output_tokens ?? request.max_tokens ?? request.max_completion_tokens,
      4096,
    ),
    messages: claude.messages.length
      ? claude.messages
      : [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    stream: true,
  };
  if (claude.system.length) {
    body.system = claude.system.join("\n\n");
  }
  const tools = openAiToolsToClaudeTools(toolContext.chatTools);
  if (tools.length) {
    body.tools = tools;
  }
  const toolChoice = responseToolChoiceToClaude(request.tool_choice, toolContext);
  if (toolChoice) {
    body.tool_choice = toolChoice;
  }
  copyScalar(request, body, "temperature");
  copyScalar(request, body, "top_p");
  if (request.stop !== undefined && request.stop !== null) {
    body.stop_sequences = Array.isArray(request.stop) ? request.stop : [request.stop];
  }
  return {
    body,
    toolContext,
    toolDiagnostics: toolDiagnosticsFromContext(toolContext, toolChoice?.type || "auto"),
    messagesForHistory: sourceMessages,
    wantsStream: Boolean(request.stream),
  };
}

export function claudeMessageToResponse(message = {}, requestedModel, toolContext, options = {}) {
  const contentBlocks = Array.isArray(message.content) ? message.content : [];
  const textParts = [];
  const output = [];
  const toolBlocks = [];
  for (const block of contentBlocks) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && block.text) {
      textParts.push(String(block.text));
    } else if (block.type === "tool_use") {
      toolBlocks.push(block);
    }
  }
  let text = textParts.join("");
  if (!text && toolBlocks.length > 0 && options.preferVisibleToolStatus) {
    text = `正在调用 ${toolBlocks.length} 个工具…`;
  }
  const id = `resp_claude_${safeResponseId(message.id)}`;
  if (text) {
    output.push({
      id: `msg_${safeResponseId(message.id)}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    });
  }
  for (const block of toolBlocks) {
    output.push(responseToolCallFromClaude(block, toolContext));
  }
  const usage = message.usage || {};
  const inputTokens =
    Number(usage.input_tokens || 0) +
    Number(usage.cache_read_input_tokens || 0) +
    Number(usage.cache_creation_input_tokens || 0);
  const outputTokens = Number(usage.output_tokens || 0);
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: requestedModel,
    output,
    output_text: text,
    parallel_tool_calls: true,
    error: null,
    incomplete_details: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      input_tokens_details: {
        cached_tokens: Number(usage.cache_read_input_tokens || 0),
      },
    },
  };
}

export function assistantHistoryMessageFromClaude(message = {}) {
  const contentBlocks = Array.isArray(message.content) ? message.content : [];
  const text = contentBlocks
    .filter((block) => block?.type === "text" && block.text)
    .map((block) => String(block.text))
    .join("");
  const history = { role: "assistant", content: text || null };
  const toolCalls = contentBlocks
    .filter((block) => block?.type === "tool_use")
    .map((block) => ({
      id: String(block.id || ""),
      type: "function",
      function: {
        name: String(block.name || "tool"),
        arguments: JSON.stringify(block.input ?? {}),
      },
    }));
  if (toolCalls.length) {
    history.tool_calls = toolCalls;
  }
  return history;
}

export function claudeHistoryWithoutImages(messages = []) {
  return (Array.isArray(messages) ? messages : []).map((message) => ({
    ...message,
    content: canonicalContentWithoutImages(message?.content),
  }));
}

function nativeClaudeHeaderMessages(request, toolContext) {
  const headers = [];
  const instructions = systemInstructionsFromRequest(request);
  if (instructions) {
    headers.push({ role: "system", content: instructions });
  }
  const toolGuidance = toolGuidanceFromContext(toolContext, request);
  if (toolGuidance) {
    headers.push({ role: "system", content: toolGuidance });
  }
  const attachmentGuidance = attachmentGuidanceFromRequest(request);
  if (attachmentGuidance) {
    headers.push({ role: "system", content: attachmentGuidance });
  }
  return headers;
}

function missingHeaderMessages(headers, priorMessages) {
  const prior = Array.isArray(priorMessages) ? priorMessages : [];
  return headers.filter((header) =>
    !prior.some((message) =>
      message?.role === "system" && isDeepStrictEqual(message.content, header.content)
    )
  );
}

function responseInputToCanonicalMessages(input, toolContext, route) {
  if (input === undefined || input === null) {
    return [];
  }
  if (typeof input === "string") {
    return [{ role: "user", content: input }];
  }

  const items = Array.isArray(input) ? input : [input];
  const messages = [];
  let pendingToolCalls = [];
  const flushToolCalls = () => {
    if (!pendingToolCalls.length) return;
    messages.push({ role: "assistant", content: null, tool_calls: pendingToolCalls });
    pendingToolCalls = [];
  };

  for (const item of items) {
    if (isResponseToolCallItem(item)) {
      pendingToolCalls.push(chatToolCallFromResponseItem(item, toolContext));
      continue;
    }
    flushToolCalls();

    if (!item || typeof item !== "object") {
      if (item !== undefined && item !== null) {
        messages.push({ role: "user", content: String(item) });
      }
      continue;
    }
    if (item.type === "compaction_trigger" || item.type === "reasoning") {
      continue;
    }
    if (item.type === "compaction" || item.type === "context_compaction") {
      const text = canonicalText(item.encrypted_content ?? item.content ?? item.text ?? item.output);
      if (text) messages.push({ role: "user", content: text });
      continue;
    }
    if (isResponseToolOutputItem(item)) {
      const toolMessage = chatMessageFromToolOutput(item);
      const image = imageDataUrlFromToolOutput(item);
      messages.push(image ? toolMessageWithoutInlineImage(toolMessage) : toolMessage);
      if (image) {
        messages.push({
          role: "user",
          content: [{
            type: "image_url",
            image_url: { url: normalizeDataImageForChat(image) },
          }],
        });
      }
      continue;
    }

    const role = String(item.role || (item.type === "message" ? "user" : "")).toLowerCase();
    if (role === "system" || role === "developer") {
      continue;
    }
    if (!["user", "assistant", "tool"].includes(role)) {
      continue;
    }
    const message = {
      role,
      content: canonicalContentFromResponse(item.content ?? item.text ?? item.output ?? "", route),
    };
    if (role === "tool") {
      const callId = item.tool_call_id || item.call_id || item.id;
      if (callId) message.tool_call_id = String(callId);
    }
    if (Array.isArray(item.tool_calls) && item.tool_calls.length) {
      message.tool_calls = item.tool_calls;
    }
    messages.push(message);
  }
  flushToolCalls();
  return messages;
}

function canonicalContentFromResponse(content, route = {}) {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    return canonicalPartFromResponse(content, route) ?? canonicalText(content);
  }

  const parts = [];
  for (const part of content) {
    if (typeof part === "string") {
      if (part) parts.push({ type: "input_text", text: part });
      continue;
    }
    const normalized = canonicalPartFromResponse(part, route);
    if (normalized) parts.push(normalized);
  }
  if (parts.length === 0) return "";
  return parts.some((part) => isCanonicalImagePart(part)) ? parts : canonicalText(parts);
}

function canonicalPartFromResponse(part, _route = {}) {
  if (!part || typeof part !== "object") return null;
  const type = String(part.type || "").toLowerCase();
  if (type.includes("image") || part.image_url || part.imageUrl) {
    const rawImage = part.image_url ?? part.imageUrl ?? part.url;
    const url = typeof rawImage === "string" ? rawImage : rawImage?.url || part.url;
    if (!url) return { type: "input_text", text: "[image input missing url]" };
    return {
      type: "image_url",
      image_url: { url: normalizeDataImageForChat(url) },
      ...(part.detail || rawImage?.detail ? { detail: part.detail || rawImage.detail } : {}),
    };
  }
  const text = typeof part.text === "string"
    ? part.text
    : typeof part.output_text === "string"
      ? part.output_text
      : typeof part.content === "string"
        ? part.content
        : "";
  if (text) return { type: "input_text", text };
  if (type.includes("audio")) {
    return { type: "input_text", text: "[audio input is not supported by this Claude Messages adapter]" };
  }
  if (type.includes("file") || type.includes("document") || type.includes("pdf")) {
    return { type: "input_text", text: "[file attachment is not directly supported by this Claude Messages adapter]" };
  }
  return Object.keys(part).length ? { type: "input_text", text: safeJson(part) } : null;
}

function canonicalMessagesToClaudeMessages(messages) {
  const system = [];
  const out = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const role = String(message.role || "user").toLowerCase();
    if (role === "system" || role === "developer") {
      const text = canonicalText(message.content);
      if (text) system.push(text);
      continue;
    }
    if (role === "tool") {
      const result = {
        type: "tool_result",
        tool_use_id: String(message.tool_call_id || message.id || "tool_result"),
        content: canonicalContentToClaudeBlocks(message.content),
      };
      appendClaudeMessage(out, "user", [result]);
      continue;
    }
    if (role === "assistant") {
      const content = canonicalContentToClaudeBlocks(message.content);
      for (const toolCall of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        const fn = toolCall?.function || toolCall || {};
        const rawArgs = fn.arguments ?? toolCall?.arguments ?? {};
        const input = typeof rawArgs === "string" ? tryParseJson(rawArgs) ?? { raw: rawArgs } : rawArgs;
        content.push({
          type: "tool_use",
          id: String(toolCall?.id || toolCall?.call_id || `toolu_${content.length}`),
          name: String(fn.name || toolCall?.name || "tool"),
          input: input && typeof input === "object" && !Array.isArray(input) ? input : { value: input },
        });
      }
      appendClaudeMessage(out, "assistant", content.length ? content : [{ type: "text", text: "" }]);
      continue;
    }
    const content = canonicalContentToClaudeBlocks(message.content);
    appendClaudeMessage(out, "user", content.length ? content : [{ type: "text", text: "" }]);
  }
  if (out.length && out[0].role !== "user") {
    out.unshift({ role: "user", content: [{ type: "text", text: "Continue." }] });
  }
  return { system, messages: out };
}

function appendClaudeMessage(messages, role, content) {
  const last = messages.at(-1);
  if (last?.role === role && Array.isArray(last.content)) {
    last.content.push(...content);
  } else {
    messages.push({ role, content });
  }
}

function canonicalContentToClaudeBlocks(content) {
  if (content === undefined || content === null) return [];
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  const parts = Array.isArray(content) ? content : [content];
  const blocks = [];
  for (const part of parts) {
    if (typeof part === "string") {
      if (part) blocks.push({ type: "text", text: part });
      continue;
    }
    if (!part || typeof part !== "object") continue;
    if (isCanonicalImagePart(part)) {
      const rawImage = part.image_url ?? part.imageUrl ?? part.url;
      const url = typeof rawImage === "string" ? rawImage : rawImage?.url || part.url;
      const image = dataUrlToClaudeImage(url);
      if (image) blocks.push(image);
      else if (url) blocks.push({ type: "text", text: `[image] ${url}` });
      continue;
    }
    const text = typeof part.text === "string"
      ? part.text
      : typeof part.output_text === "string"
        ? part.output_text
        : typeof part.content === "string"
          ? part.content
          : safeJson(part);
    if (text) blocks.push({ type: "text", text });
  }
  return blocks;
}

function retainRecentCanonicalImages(messages) {
  const source = Array.isArray(messages) ? messages : [];
  const retained = new Set(
    source.map((message, index) => canonicalContentHasImage(message?.content) ? index : -1)
      .filter((index) => index >= 0)
      .slice(-MAX_CLAUDE_IMAGE_MESSAGES),
  );
  return source.map((message, index) =>
    retained.has(index) ? message : { ...message, content: canonicalContentWithoutImages(message?.content) }
  );
}

function canonicalContentHasImage(content) {
  const parts = Array.isArray(content) ? content : [content];
  return parts.some((part) => {
    if (!isCanonicalImagePart(part)) return false;
    const rawImage = part.image_url ?? part.imageUrl ?? part.url;
    const url = typeof rawImage === "string" ? rawImage : rawImage?.url || part.url;
    return typeof url === "string" && /^data:image\//i.test(url);
  });
}

function canonicalContentWithoutImages(content) {
  if (!Array.isArray(content)) {
    return isCanonicalImagePart(content) ? HISTORICAL_IMAGE_PLACEHOLDER : content;
  }
  return content.map((part) =>
    isCanonicalImagePart(part) ? { type: "input_text", text: HISTORICAL_IMAGE_PLACEHOLDER } : part
  );
}

function isCanonicalImagePart(part) {
  if (!part || typeof part !== "object") return false;
  const type = String(part.type || "").toLowerCase();
  return type === "image_url" || type.includes("image") || Boolean(part.image_url) || Boolean(part.imageUrl);
}

function imageDataUrlFromToolOutput(item) {
  return safeJson(item?.output ?? item?.result ?? "")
    .match(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/i)?.[0] || "";
}

function toolMessageWithoutInlineImage(message) {
  return {
    ...message,
    content: String(message?.content || "").replace(
      /data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi,
      TOOL_RESULT_IMAGE_PLACEHOLDER,
    ),
  };
}

function canonicalText(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(canonicalText).filter(Boolean).join("\n");
  }
  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (typeof value.output_text === "string") return value.output_text;
    if (typeof value.content === "string") return value.content;
    return safeJson(value);
  }
  return String(value);
}

function responseToolChoiceToClaude(toolChoice, toolContext) {
  if (toolChoice === undefined || toolChoice === null) return null;
  if (toolChoice === "auto") return { type: "auto" };
  if (toolChoice === "none") return { type: "none" };
  if (toolChoice === "required") return { type: "any" };
  if (typeof toolChoice !== "object") return null;
  const responseName = String(toolChoice.name || toolChoice.function?.name || "").trim();
  if (!responseName) return { type: "auto" };
  const name = toolContext.responseNameToChatName.get(responseName) || responseName;
  return toolContext.chatToolNames.has(name) ? { type: "tool", name } : { type: "auto" };
}

function copyScalar(source, target, key) {
  if (source?.[key] !== undefined && source[key] !== null) target[key] = source[key];
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? "");
  }
}

function safeResponseId(value) {
  return String(value || Date.now().toString(36)).replace(/[^A-Za-z0-9_-]/g, "_");
}

export function claudeMessagesHeaders(route, context, requireApiKey, options = {}) {
  const key = requireApiKey(route);
  const headers = {
    "content-type": "application/json",
    accept: options.acceptEventStream === false ? "application/json" : "text/event-stream",
    "anthropic-version": "2023-06-01",
    "x-api-key": key,
    authorization: `Bearer ${key}`,
    // Some Claude relays (Cloudflare) are picky with non-browser clients.
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  };

  const customHeaders =
    route?.headers && typeof route.headers === "object" && !Array.isArray(route.headers)
      ? route.headers
      : {};
  for (const [name, value] of Object.entries(customHeaders)) {
    const keyName = String(name || "").trim();
    const headerValue = String(value ?? "").trim();
    if (!keyName || !headerValue) continue;
    headers[keyName] = headerValue;
  }
  return headers;
}

export async function readClaudeMessagesAsChatCompletion(upstream, context = {}) {
  return claudeMessageToChatCompletion(await readClaudeMessagesMessage(upstream, context));
}

export async function readClaudeMessagesMessage(upstream, context = {}) {
  const contentType = String(upstream.headers?.get?.("content-type") || "").toLowerCase();
  if (contentType.includes("text/event-stream") || contentType.includes("event-stream")) {
    const text = await readStreamText(upstream, context);
    const message = parseClaudeSseToMessage(text);
    if (!message) {
      throw new Error(`Failed to parse Claude SSE message: ${text.slice(0, 300)}`);
    }
    return message;
  }

  const text = await readStreamText(upstream, context);
  const parsed = tryParseJson(text);
  if (!parsed) {
    throw new Error(`Claude upstream returned non-JSON body: ${text.slice(0, 300)}`);
  }
  if (parsed.type === "error" || parsed.error) {
    const msg =
      parsed?.error?.message ||
      parsed?.message ||
      text.slice(0, 300) ||
      "Claude upstream error";
    const err = new Error(msg);
    err.statusCode = upstream.status || 502;
    err.bodyText = text;
    throw err;
  }
  return parsed;
}

export function claudeMessageToChatCompletion(message = {}) {
  const contentBlocks = Array.isArray(message.content) ? message.content : [];
  const textParts = [];
  const toolCalls = [];

  for (const block of contentBlocks) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text") {
      if (block.text) textParts.push(String(block.text));
      continue;
    }
    if (block.type === "tool_use") {
      toolCalls.push({
        id: String(block.id || `toolu_${toolCalls.length}`),
        type: "function",
        function: {
          name: String(block.name || "tool"),
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
  }

  const usage = message.usage || {};
  const promptTokens =
    Number(usage.input_tokens || 0) +
    Number(usage.cache_read_input_tokens || 0) +
    Number(usage.cache_creation_input_tokens || 0);
  const completionTokens = Number(usage.output_tokens || 0);

  let finishReason = "stop";
  if (message.stop_reason === "tool_use") finishReason = "tool_calls";
  else if (message.stop_reason === "max_tokens") finishReason = "length";
  else if (message.stop_reason === "stop_sequence") finishReason = "stop";

  const chatMessage = {
    role: "assistant",
    content: textParts.join("") || (toolCalls.length ? null : ""),
  };
  if (toolCalls.length) {
    chatMessage.tool_calls = toolCalls;
  }

  return {
    id: message.id || `chatcmpl_claude_${Date.now().toString(36)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: message.model || "claude",
    choices: [
      {
        index: 0,
        message: chatMessage,
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      // keep anthropic detail for debugging
      prompt_tokens_details: {
        cached_tokens: Number(usage.cache_read_input_tokens || 0),
      },
    },
  };
}

export function parseClaudeSseToMessage(sseText = "") {
  let message = {
    id: "",
    type: "message",
    role: "assistant",
    model: "",
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: {},
  };
  let sawEvent = false;

  const events = String(sseText || "").split(/\n\n+/);
  for (const rawEvent of events) {
    if (!rawEvent.trim()) continue;
    let eventName = "message";
    const dataLines = [];
    for (const line of rawEvent.split(/\r?\n/)) {
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      }
    }
    if (!dataLines.length) continue;
    const dataText = dataLines.join("\n");
    if (dataText === "[DONE]") continue;
    const data = tryParseJson(dataText);
    if (!data) continue;
    sawEvent = true;

    if (eventName === "message_start" && data.message) {
      message = {
        ...message,
        ...data.message,
        content: Array.isArray(data.message.content) ? [...data.message.content] : [],
        usage: { ...(data.message.usage || {}) },
      };
      continue;
    }

    if (eventName === "content_block_start" && data.content_block) {
      const index = Number(data.index || 0);
      message.content[index] = cloneBlock(data.content_block);
      continue;
    }

    if (eventName === "content_block_delta" && data.delta) {
      const index = Number(data.index || 0);
      if (!message.content[index]) {
        message.content[index] =
          data.delta.type === "input_json_delta"
            ? { type: "tool_use", id: "", name: "", input: {} }
            : { type: "text", text: "" };
      }
      const block = message.content[index];
      if (data.delta.type === "text_delta") {
        block.text = `${block.text || ""}${data.delta.text || ""}`;
      } else if (data.delta.type === "input_json_delta") {
        block._input_json = `${block._input_json || ""}${data.delta.partial_json || ""}`;
      }
      continue;
    }

    if (eventName === "content_block_stop") {
      const index = Number(data.index || 0);
      const block = message.content[index];
      if (block && block.type === "tool_use" && typeof block._input_json === "string") {
        try {
          block.input = JSON.parse(block._input_json || "{}");
        } catch {
          block.input = { raw: block._input_json };
        }
        delete block._input_json;
      }
      continue;
    }

    if (eventName === "message_delta") {
      if (data.delta?.stop_reason) message.stop_reason = data.delta.stop_reason;
      if (data.delta?.stop_sequence !== undefined) {
        message.stop_sequence = data.delta.stop_sequence;
      }
      if (data.usage) {
        message.usage = { ...(message.usage || {}), ...data.usage };
      }
      continue;
    }

    if (eventName === "message_stop") {
      continue;
    }

    if (eventName === "error" || data.type === "error") {
      const msg = data?.error?.message || data?.message || "Claude SSE error";
      const err = new Error(msg);
      err.bodyText = dataText;
      throw err;
    }

    // Non-stream JSON accidentally returned as one SSE data packet.
    if (data.type === "message" && Array.isArray(data.content)) {
      message = data;
    }
  }

  if (!sawEvent) return null;
  message.content = (message.content || []).filter(Boolean).map((block) => {
    if (block && block.type === "tool_use" && typeof block._input_json === "string") {
      try {
        block.input = JSON.parse(block._input_json || "{}");
      } catch {
        block.input = { raw: block._input_json };
      }
      delete block._input_json;
    }
    return block;
  });
  return message;
}

function cloneBlock(block) {
  if (!block || typeof block !== "object") return { type: "text", text: "" };
  if (block.type === "tool_use") {
    return {
      type: "tool_use",
      id: block.id || "",
      name: block.name || "",
      input: block.input && typeof block.input === "object" ? block.input : {},
      _input_json: "",
    };
  }
  return {
    type: block.type || "text",
    text: block.text || "",
  };
}

function openAiToolsToClaudeTools(tools) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  for (const tool of tools) {
    if (!tool) continue;
    if (tool.type === "function" && tool.function) {
      out.push({
        name: String(tool.function.name || "tool"),
        description: String(tool.function.description || ""),
        input_schema:
          tool.function.parameters && typeof tool.function.parameters === "object"
            ? tool.function.parameters
            : { type: "object", properties: {} },
      });
      continue;
    }
    if (tool.name && tool.input_schema) {
      out.push(tool);
    }
  }
  return out;
}

function openAiToolChoiceToClaude(toolChoice) {
  if (toolChoice === undefined || toolChoice === null) return null;
  if (toolChoice === "auto") return { type: "auto" };
  if (toolChoice === "none") return { type: "none" };
  if (toolChoice === "required") return { type: "any" };
  if (typeof toolChoice === "object") {
    const name = toolChoice?.function?.name || toolChoice?.name;
    if (name) return { type: "tool", name: String(name) };
  }
  return null;
}

function openAiContentToClaudeContent(content) {
  if (content == null) return [];
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) {
    const text = contentToPlainText(content);
    return text ? [{ type: "text", text }] : [];
  }
  const out = [];
  for (const part of content) {
    if (!part) continue;
    if (typeof part === "string") {
      if (part) out.push({ type: "text", text: part });
      continue;
    }
    const type = String(part.type || "").toLowerCase();
    if (type === "text" || type === "input_text" || type === "output_text") {
      const text = String(part.text || part.content || "");
      if (text) out.push({ type: "text", text });
      continue;
    }
    if (type === "image_url" || type === "input_image" || type === "image") {
      const imageUrl = part.image_url?.url || part.image_url || part.url || "";
      const image = dataUrlToClaudeImage(imageUrl);
      if (image) out.push(image);
      else if (imageUrl) out.push({ type: "text", text: `[image] ${imageUrl}` });
      continue;
    }
    const fallback = contentToPlainText(part);
    if (fallback) out.push({ type: "text", text: fallback });
  }
  return out;
}

function dataUrlToClaudeImage(value) {
  const text = String(value || "");
  const match = text.match(/^data:([^;]+);base64,(.+)$/i);
  if (!match) {
    if (/^https?:\/\//i.test(text)) {
      return {
        type: "image",
        source: {
          type: "url",
          url: text,
        },
      };
    }
    return null;
  }
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: match[1] || "image/png",
      data: match[2],
    },
  };
}

function contentToPlainText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (typeof content === "number" || typeof content === "boolean") return String(content);
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        return part.text || part.content || part.output_text || "";
      })
      .filter(Boolean)
      .join("");
  }
  if (typeof content === "object") {
    return content.text || content.content || content.output_text || "";
  }
  return "";
}

function normalizeClaudeMessageRoles(messages) {
  const out = [];
  for (const message of messages) {
    if (!message) continue;
    const role = message.role === "assistant" ? "assistant" : "user";
    const last = out[out.length - 1];
    if (last && last.role === role && Array.isArray(last.content) && Array.isArray(message.content)) {
      // merge consecutive same-role messages
      last.content = [...last.content, ...message.content];
      continue;
    }
    out.push({ role, content: message.content });
  }
  if (out.length && out[0].role !== "user") {
    out.unshift({ role: "user", content: [{ type: "text", text: "Continue." }] });
  }
  return out;
}

async function readStreamText(upstream, context = {}) {
  if (!upstream?.body) {
    return typeof upstream.text === "function" ? await upstream.text() : "";
  }
  if (!context.clientSignal) {
    return typeof upstream.text === "function"
      ? await upstream.text()
      : Buffer.concat(await collectReader(upstream.body.getReader())).toString("utf8");
  }
  if (context.clientSignal.aborted) {
    const err = new Error("client closed request");
    err.code = "client_closed_request";
    throw err;
  }
  const reader = upstream.body.getReader();
  const chunks = [];
  const _streamStartMs = Date.now();
  let _ttftCaptured = false;
  let abortHandler;
  const abortPromise = new Promise((_, reject) => {
    abortHandler = () => {
      reader.cancel(context.clientSignal.reason).catch(() => {});
      const err = new Error("client closed request");
      err.code = "client_closed_request";
      reject(err);
    };
    context.clientSignal.addEventListener("abort", abortHandler, { once: true });
  });
  try {
    while (true) {
      const result = await Promise.race([reader.read(), abortPromise]);
      if (result.done) break;
      if (!_ttftCaptured) { _ttftCaptured = true; context.ttftMs = Date.now() - _streamStartMs; }
      chunks.push(Buffer.from(result.value));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    if (abortHandler) {
      context.clientSignal.removeEventListener("abort", abortHandler);
    }
    reader.releaseLock();
  }
}

async function collectReader(reader) {
  const chunks = [];
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    chunks.push(Buffer.from(result.value));
  }
  return chunks;
}
