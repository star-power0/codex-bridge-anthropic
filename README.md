# CodexBridge (Claude/Anthropic 协议兼容 Fork)

本仓库是 [wangzhezbz/codex-bridge](https://github.com/wangzhezbz/codex-bridge) 的一个 fork，基于其 `0.3.13` 发行版源码，在此基础上新增了 **Anthropic `/v1/messages` 原生协议支持**（主要用于 Claude 系模型经第三方中转站接入时的稳定性问题），以及若干桌面端可用性修复。

原项目是本地多模型网关和桌面管理器，让 Codex / ChatGPT Desktop 可以通过一个本地 Router 同时使用 GPT、DeepSeek、Kimi、Claude 等 OpenAI-compatible 或 Anthropic-compatible 模型。原项目的完整介绍见下方 Upstream 部分或访问原仓库。

## 这是什么，为什么 fork

上游 0.3.13 版本的 Claude 系模型走的是 OpenAI-compatible 的 `chat/completions` 转换路径。实测发现部分中转站（如本例中的 Baiyuan）在这条路径上会返回 `503 No available accounts`，但同一个 Key 走 Anthropic 原生的 `/v1/messages` 协议是正常的。也就是说问题出在协议路径，不是 Key 失效。

于是本 fork 把 Anthropic Messages 协议从"隐藏 fallback"提升为独立的一等协议（`anthropic_messages`），和已有的 `responses` / `chat_completions` 并列。

## 相对上游的改动

### 1. Anthropic Messages 协议支持（核心改动）

- 新增 `src/claude-messages.js`（约 1100 行）：负责 OpenAI chat 格式 <-> Anthropic Messages 格式的双向转换，包括流式 SSE 解析、工具调用（tool use）映射、历史消息重建等。
- `src/upstream.js`：新增 `proxyAnthropicMessages()` 入口，`handleResponsesRequest` 按路由的 `api` 字段分发到该协议；保留旧的 chat_completions 兜底路径。
- `src/adapter-profile.js`：为 `anthropic_messages` 协议单独定义工具调用轮次上限、参数丢弃规则（如 `response_format`、`parallel_tool_calls` 等 Anthropic 不支持的字段会被自动过滤）。
- `src/config.js`：模型配置的 `api` 字段允许取值新增 `anthropic_messages`。
- `src/route-snapshot.js`：路由快照/诊断信息接受该协议类型。

### 2. 桌面端（`desktop/`）配套修复

- **Provider 重命名同步**：重命名一个 Provider 后，其下所有模型卡片、分组标题、简称前缀会同步更新，不再遗留旧名字。
- **删除 Provider 功能**：自定义 Provider 编辑卡片新增"删除供应商"按钮（带确认弹窗），会级联清理其下的模型和引用。
- **非 ASCII Provider ID 冲突修复**：中文/中英混合 Provider 名称（如"百元kiro"和"瓦片kiro"）此前会因为 slug 化时中文被剥离，导致生成同一个 Provider ID 而互相覆盖。修复后基于完整名称哈希生成唯一 ID。
- **自定义模型 Provider 归属修复**：从已有 Provider 卡片入口新增模型时，如果用户改写了 Provider 名称或 Base URL，会正确创建新 Provider 而不是强行归并到原 Provider。
- **Context Window 快捷预设**：为所有 Context Window 输入框增加快捷按钮（64K / 128K / 256K / 500K / 1M / 2M）。
- **Gateway 502/503 稳定性增强**：针对第三方中转站瞬时连接失败增加自动重试。
- **Skills / MCP 离线兜底扫描**：当系统 PATH 中找不到 `codex` CLI 导致 `codex app-server` 不可用时，直接扫描 `~/.codex/skills/` 磁盘目录显示已安装的 Skills/MCP，而不是显示"无法读取"。

以上改动均在真实环境下人工验证过（详见改动过程记录，未收录进本仓库的调试脚本已清理）。

## 快速开始

安装、配置、启动方式与上游一致，参见下方 Upstream README 内容，或直接查看 `docs/` 目录下的详细文档。

关键差异：如果你的第三方 Claude 中转站也出现"账号池为空/503"但 Key 本身有效的情况，可以在自定义模型里把协议（`api`）设置为 `anthropic_messages`，走 Anthropic 原生协议而不是 chat_completions 转换路径。

## 致谢 / Upstream

本项目基于 [wangzhezbz/codex-bridge](https://github.com/wangzhezbz/codex-bridge)（MIT License）修改。原作者保留其所有权利，本仓库仅为个人使用场景下的功能扩展 fork，非官方发布，不代表上游项目立场。

原始 License 见 `LICENSE` 文件（保留上游版权声明）。

---

## Upstream README（原始说明，供参考）

> 以下内容为上游项目原始 README，部分内容可能与本 fork 的实际行为略有差异（例如协议支持已扩展为三种）。

# CodexBridge

Local multi-model gateway and desktop manager for Codex.

Codex 多模型本地网关与桌面管理器。

CodexBridge lets Codex use GPT, DeepSeek, Kimi, and more OpenAI-compatible models from one local router and one model picker.

CodexBridge 让 Codex 通过一个本地 Router 和一个模型栏同时使用 GPT、DeepSeek、Kimi 以及更多 OpenAI-compatible 模型。

详见原仓库 [wangzhezbz/codex-bridge](https://github.com/wangzhezbz/codex-bridge) 的完整 README，包含下载链接、计费模式、Codex 配置示例、故障排查等内容。本 fork 未修改这些通用使用说明，为避免重复冗余，此处不再复制全文，请以上游仓库或 `docs/` 目录为准。

## License

MIT，见 `LICENSE`。版权归原作者 wangzhezbz 所有；本 fork 的新增/修改部分同样以 MIT 方式开源。
