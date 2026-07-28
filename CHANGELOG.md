# Changelog（本 fork 相对上游 0.3.13 的改动）

本文件只记录本 fork 相对上游 `wangzhezbz/codex-bridge` 0.3.13 发行版的改动，不包含上游自身的历史变更（见上游仓库）。

## 2026-07-25

### Added
- 新增 Anthropic Messages 原生协议支持（`anthropic_messages`），作为与 `responses` / `chat_completions` 并列的第一等协议类型。
  - 新文件 `src/claude-messages.js`：OpenAI chat payload <-> Anthropic Messages 双向转换，含流式 SSE 解析、tool_use 映射、历史消息重建。
  - `src/upstream.js`：新增 `proxyAnthropicMessages()`，`handleResponsesRequest` 按路由 `api` 分发。
  - `src/adapter-profile.js`：Anthropic 协议专属的工具调用轮次上限与参数丢弃规则。
  - `src/config.js` / `src/route-snapshot.js`：接受 `anthropic_messages` 作为合法 api 类型。
  - `desktop/settings.mjs` / `desktop/config-import-validation.mjs`：自定义模型归一化、路由生成、配置导入均支持该协议；Claude 远程模型自动选用该协议且不污染 GPT 模型的协议选择。
  - `desktop/renderer/index.html` / `desktop/renderer/app.js`：UI 增加协议选项与展示标签。
- Context Window 输入框增加快捷预设按钮（64K/128K/256K/500K/1M/2M）。
- 自定义 Provider 编辑卡片增加"删除供应商"按钮及后端 `providers:remove` IPC。
- `scanDiskSkillsFallback`：`codex app-server` 不可用时直接扫描本地 `~/.codex/skills/` 目录展示已装 Skills/MCP。

### Fixed
- Provider 重命名后，模型卡片/分组标题/简称前缀未同步更新的问题。
- 非 ASCII（中文/中英混合）Provider 名称因 slugify 剥离中文字符导致 ID 冲突、互相覆盖的问题。
- 从已有 Provider 卡片新增自定义模型时，若用户改写了 Provider 名或 Base URL，仍被强行归并到原 Provider 的问题。
- 第三方 OpenAI-compatible 中转站瞬时 502/503 无自动重试的问题。

### Root cause note
部分第三方 Claude 中转站在 `/v1/chat/completions` 路径返回 503，但同一 Key 走 Anthropic 原生 `/v1/messages` 正常（账号池本身健康）。问题是协议路径选择而非凭证失效，因此新增原生协议支持而非仅做重试兜底。
