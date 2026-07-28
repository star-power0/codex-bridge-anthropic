import assert from "node:assert/strict";
import {
  assistantHistoryMessageFromClaude,
  claudeMessageToResponse,
  responsesToClaudeMessagesRequest,
} from "../src/claude-messages.js";

const image = (label) =>
  `data:image/png;base64,${Buffer.from(label).toString("base64")}`;
const route = {
  id: "claude-test",
  model: "claude-test",
  api: "anthropic_messages",
};
const gptHistory = [
  { role: "system", content: "Keep answers precise." },
  ...Array.from({ length: 5 }, (_, index) => ({
    role: "user",
    content: [
      { type: "input_text", text: `GPT history image ${index + 1}` },
      { type: "image_url", image_url: { url: image(`history-${index + 1}`) } },
    ],
  })),
  {
    role: "assistant",
    content: null,
    tool_calls: [{
      id: "call_prior",
      type: "function",
      function: { name: "lookup", arguments: '{"query":"weather"}' },
    }],
  },
  { role: "tool", tool_call_id: "call_prior", content: "sunny" },
];
const history = new Map([["resp_gpt", gptHistory]]);
const converted = responsesToClaudeMessagesRequest({
  model: "claude-test",
  previous_response_id: "resp_gpt",
  input: [{
    role: "user",
    content: [
      { type: "input_text", text: "Please inspect the newest image." },
      { type: "input_image", image_url: image("newest") },
    ],
  }],
  tools: [{
    type: "function",
    name: "lookup",
    description: "Look up a value.",
    parameters: { type: "object", properties: { query: { type: "string" } } },
  }],
}, route, history);

assert.equal(converted.body.model, "claude-test");
assert.ok(Array.isArray(converted.body.messages));
assert.ok(converted.body.messages.every((message) => message.role === "user" || message.role === "assistant"));
assert.equal(
  converted.body.messages.flatMap((message) => message.content).filter((part) => part.type === "image").length,
  4,
  "only the latest four image messages should be sent to Claude",
);
assert.ok(
  converted.body.messages.flatMap((message) => message.content).some(
    (part) => part.type === "tool_use" && part.id === "call_prior",
  ),
  "GPT tool calls should become Claude tool_use blocks",
);
assert.ok(
  converted.body.messages.flatMap((message) => message.content).some(
    (part) => part.type === "tool_result" && part.tool_use_id === "call_prior",
  ),
  "GPT tool results should become Claude tool_result blocks",
);

const claudeMessage = {
  id: "msg_test",
  usage: { input_tokens: 10, output_tokens: 5 },
  content: [{ type: "tool_use", id: "toolu_next", name: "lookup", input: { query: "next" } }],
};
const response = claudeMessageToResponse(claudeMessage, "claude-test", converted.toolContext);
assert.equal(response.output[0].type, "function_call");
assert.equal(response.output[0].call_id, "toolu_next");
const historyMessage = assistantHistoryMessageFromClaude(claudeMessage);
assert.equal(historyMessage.tool_calls[0].id, "toolu_next");
assert.equal(historyMessage.tool_calls[0].function.name, "lookup");

console.log("PASS: native Claude Messages preserves tool history and retains the latest four images");
