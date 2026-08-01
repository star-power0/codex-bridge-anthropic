# Changelog（本 fork 相对上游 0.3.13 的改动）

本文件只记录本 fork 相对上游 `wangzhezbz/codex-bridge` 0.3.13 发行版的改动，不包含上游自身的历史变更（见上游仓库）。

## 2026-08-01

### Fixed
- 将 Cloudflare 常见的 HTTP `524` 纳入上游临时错误重试范围。
- 将 `502` / `503` / `504` / `524` 的单次重试等待从固定 `500ms` 改为 `1500–3500ms` 随机退避，减少短时间内重复撞击同一网关故障窗口。

### Unchanged
- 不改变最近四条含图片消息的历史保留策略。
- 不改变 Claude 的 `anthropic_messages` 原生协议路由。
- 不改变模型、供应商、图片压缩和请求格式配置。

### Verification
- `node --check src/upstream.js` 通过。
- 详细备份与修改前后文件位于 `E:\CodexBridge\patches\2026-08-01-minimal-upstream-retry\`。

## 2026-07-31（续）

### Changed
- 调整 Codex Dream Skin 预设 `abyssal-cyan-reverie`（深渊青梦）：正文 `text` 从冷白降到柔和青白，`muted` 提亮以改善右上角窗口控制和次级图标可见性。
- 加深本预设 `main` / `header` / `sidebar` / `composer` / `dialog` 的 Safe CSS 半透明表面，降低普通任务页和设置页背景杂感，避免文字与壁纸高频细节互相干扰。

### Verified
- `check_contrast.py` 全部必需对比度通过，`validate-safe-css-file.mjs` 返回 `status: validated`。

## 2026-07-31

### Added
- 新增 Codex Dream Skin 预设 `abyssal-cyan-reverie`（深渊青梦）：基于暗青蓝人物宽图，采用左侧安全区、右侧焦点构图与 `taskMode: full`，主题文件落地到 `%LOCALAPPDATA%\\CodexDreamSkin\\themes\\preset-abyssal-cyan-reverie`。
- 配色使用壁纸实测的深青蓝环境色、主体青 cyan 高光与冷白正文色；Safe CSS 仅在本预设内调 sidebar/header/composer/dialog 透明度和阴影，不改共享运行时。

### Verified
- `check_contrast.py` 全部必需对比度通过，`validate-safe-css-file.mjs` 返回 `status: validated`，并确认 `theme.json`、`theme.css`、`background.png` 三个主题文件均存在。

## 2026-07-29

### Performance
- 导航页改为按状态版本缓存：模型、能力、统计、设置等页面在状态未变化时切换不再重复拼接 HTML、重绑事件或重建整块 DOM；状态变化后才失效并重绘当前页。
- 后台用量和日志更新改为仅刷新当前可见的统计、概览或日志页，避免在其他页面操作时触发无关 DOM 更新。
- 详情状态读取按页面拆分：能力页不再附带读取会话树、资源快照和完整体检；会话、资源、体检各自首次进入时才加载对应数据，并保留已读取分片。
- 能力页历史记录首屏限制为最近 48 条能力执行记录和 36 条图片生成记录，减少缩略图编码、IPC 传输和首次渲染开销。
- 保存供应商设置不再同时广播完整状态并再次返回完整状态；返回模型列表时只读取一次轻量状态，消除保存阶段的重复状态构建与重复渲染。
- 模型图片上传开关保留原子配置事务，但改为局部更新当前按钮和模型状态，不再广播完整状态或重绘整页；新增运行时耗时日志用于排查配置写入延迟。
- 模型、能力等页面的失效内容重绘改到导航选中态完成首帧绘制之后执行；快速连续切页时丢弃旧页面的排队任务，避免大块 DOM 重建阻塞侧栏切换反馈。
- 首次体检和手动重新体检的完整扫描移入独立 Worker；会话、插件、资源、备份和安装位置等同步检查不再占用 Electron 主进程，体检运行期间仍可立即切换模型等页面。

### Verification
- `node --check desktop/main.cjs`、`node --check desktop/renderer/app.js`、`node --check desktop/settings.mjs` 和 `git diff --check` 通过。
- `node scripts/verify-claude-messages-native.mjs` 通过。
- 新增 `node scripts/verify-navigation-paint.mjs`，验证导航重绘不会占用点击回调且不会渲染已离开的页面。
- 新增 `node scripts/verify-preflight-worker.mjs`，验证体检详情和手动体检均由 Worker 执行，主进程不再直接运行同步体检构建。
- 本发行目录缺少 `node_modules/electron`、`scripts/desktop-smoke.mjs`、`scripts/route-sync-smoke.mjs`；`npm run desktop:smoke` 与 package 脚本指定的 route smoke 无法在该目录执行，改由已安装 EXE 的隔离 smoke 验证。

## 2026-07-29（续）

### Performance — 刷新模型卡顿
- `providers:refreshModels` IPC 返回时从 `getStatePayload(settings)` 改为 `getStatePayload(settings, { lite: true })`：原调用触发 `includeAllDetail = true`，会执行 `readCodexResourceSnapshotsRetained`（拉 Codex 插件市场数据，走网络）；该调用与模型刷新完全无关，却阻塞了整个 IPC 响应。
- 刷新模型按钮回调从 `render()`（全量重建所有页面 DOM + 重绑所有事件）改为仅调用 `renderModelPool() / renderProviderEditor() / renderSelectedModels()`，只重建模型页相关节点。
## 2026-07-28

### Changed
- Codex Dream Skin preset `xiao-xiao-hu-nan`: reduced right-side white dominance by changing `panel` from `#f0f6f9` to `#bed8e1` and `panelAlt` from `#e2ecf1` to `#adc9d4`.
- Darkened header-facing theme accents by changing `accent` from `#1d5e7a` to `#083044`, `accentAlt` from `#3d7fa0` to `#2e708e`, and `highlight` from `#9e6820` to `#72430f`, keeping正文 `text` / `muted` unchanged.
- Added preset-level header Safe CSS foreground/border tuning in `theme.css` without touching shared runtime CSS.

### Verified
- Contrast pairings all pass, Safe CSS validator returned `status: validated`, saved theme activated, live computed variables matched the new palette, and focused live Dream Skin verification passed for revision `f48147079f3b60afc6db`.

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
