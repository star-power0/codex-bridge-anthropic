# codex-bridge-anthropic

> **基于 [wangzhezbz/codex-bridge](https://github.com/wangzhezbz/codex-bridge) v0.3.13 的个人 fork，在上游基础上新增了多项功能修复。**

---

## 已经装过 0.3.13 版本，想用这个 fork 怎么办

这个仓库发布的是**修改后的源码**，不是打包好的安装程序。如果你已经装了官方 CodexBridge 0.3.13（或来源类似的便携版/安装版），有两种方式升级：

### 方式一：用 install.ps1 自动安装（推荐）

1. 完全退出 CodexBridge（包括后台托盘图标）。
2. 克隆或下载本仓库到本地任意目录。
3. 打开 PowerShell，cd 到本仓库根目录，执行：

   ```powershell
   .\install.ps1
   ```

   脚本会自动在常见安装路径下查找 CodexBridge，找到后会：
   - 把即将被覆盖的原始文件备份到安装目录下的 `.fork-backup-<时间戳>` 文件夹
   - 用本 fork 修改后的文件覆盖安装目录里对应的文件

   如果脚本没找到安装目录（比如你用了自定义路径或便携版），手动指定：

   ```powershell
   .\install.ps1 -InstallDir "你的安装目录\resources\app"
   ```

   判断依据：这个目录下应该能看到 `package.json`、`src\`、`desktop\` 这些文件/文件夹。

4. 重新启动 CodexBridge。

### 方式二：手动复制文件

如果不想跑脚本，也可以手动把本仓库里的这些文件复制到安装目录的同名路径下（会覆盖原文件，建议先自行备份）：

```
src/claude-messages.js        (新文件)
src/upstream.js
src/adapter-profile.js
src/config.js
src/route-snapshot.js
desktop/settings.mjs
desktop/config-import-validation.mjs
desktop/main.cjs
desktop/preload.cjs
desktop/renderer/app.js
desktop/renderer/index.html
```

复制完成后重启 CodexBridge。

### 回滚

如果用了 install.ps1，回滚很简单：把它生成的 `.fork-backup-<时间戳>` 文件夹里的文件复制回原路径即可。

### 注意事项

- 本 fork 基于 **0.3.13** 开发，如果你的版本不是 0.3.13，文件结构或函数签名可能有差异，直接覆盖有风险，建议先确认版本一致。
- 如果你是从源码自己跑（`npm run desktop`），直接 `git pull` 或者把改动的文件覆盖到你自己的工作目录即可，不需要 install.ps1。


## 这个 fork 改了什么

以下是相对上游 0.3.13 版本的全部改动，按实际解决的问题分组描述。

---

### 1. Anthropic `/v1/messages` 原生协议支持（核心新功能）

**背景：** 部分第三方 Claude 中转站在 OpenAI-compatible 的 `/v1/chat/completions` 路径上会返回 `503 No available accounts`，但同一个 Key 走 Anthropic 原生的 `POST /v1/messages` 是完全正常的。问题出在协议路径的选择，不是 Key 失效。

上游版本只有隐式的 chat_completions fallback，没有真正走原生 Anthropic 协议的能力。本 fork 把 `anthropic_messages` 提升为与 `responses` / `chat_completions` 并列的第一等协议。

**涉及文件：**

- **新增 `src/claude-messages.js`**（约 1100 行，全新文件）
  - OpenAI chat payload → Anthropic Messages 请求格式完整转换
  - Anthropic SSE 流式响应 → OpenAI chat.completion 格式完整转换
  - tool_use 工具调用双向映射
  - 图片拒绝时自动去图重试
  - 历史消息重建（assistant/user 角色正确处理）

- **`src/upstream.js`**（新增约 427 行）
  - 新增 `proxyAnthropicMessages()` 专用入口
  - `handleResponsesRequest` 按路由 `api` 字段分发到该协议
  - 保留 chat_completions 兜底，不影响 GPT 系模型

- **`src/adapter-profile.js`**
  - `anthropic_messages` 协议工具调用轮次独立配置（默认 2 轮）
  - 自动过滤 Anthropic 不支持的参数：`response_format`、`parallel_tool_calls`、`logit_bias`、`n`、`user`
  - 新增 `isClaudeRoute()`，通过 provider/model 名称模糊识别 Claude 系路由

- **`src/config.js`** — `api` 字段合法值新增 `anthropic_messages`
- **`src/route-snapshot.js`** — 路由诊断接口接受该协议类型
- **`desktop/settings.mjs`** — 自定义模型归一化保留该协议；Claude 远程模型自动选用该协议；配置导入支持该协议
- **`desktop/renderer/index.html` + `desktop/renderer/app.js`** — UI 协议下拉框新增该选项

---

### 2. 自定义 Provider 作用域归属 Bug 修复

**问题：** 从某个现有 Provider 的卡片入口点击"添加模型"，如果用户改写了 Provider 名称或 Base URL，期望新建一个 Provider，但代码会忽略用户输入，把新模型强行归并到原来那个 Provider 下面。

**修复（`desktop/renderer/app.js`）：**
- `customModelFormPayload()` 和 `customProviderPayload()` 检测 `customProviderName` 和 `customBaseUrl`
- 若用户填写的名称或地址与 `scopedCustomProviderId` 不一致，自动创建新的 `custom-<name>` Provider，而不是强行归并

---

### 3. Provider 重命名同步 + 删除 Provider 功能

**问题 1：** 把 Provider 重命名后，该 Provider 下所有模型的 `providerName`、顶部标签卡、分组标题、模型卡片简称前缀都不会跟着更新，残留旧名字。

**修复（`desktop/settings.mjs`）：**
- `providers:save`、`customModel:save`、`applyProviderSettingsToModel`、`applyProviderOverride` 加入重命名同步逻辑
- 改名时下属模型的 `shortName`、`providerName`、`displayName` 前缀统一联动更新
- 修复 `applyProviderOverride` 中 `shortName` 的 fallback 优先级，顶部标签卡正确显示 `override.name`

**问题 2：** 没有删除自定义 Provider 的功能，只能逐个删模型。

**新增（`desktop/settings.mjs` + `desktop/main.cjs` + `desktop/preload.cjs` + `desktop/renderer/app.js`）：**
- 新增 `providers:remove` 事件及 IPC 绑定，级联清理下属模型、选择列表、provider-overrides 记录
- Provider 编辑卡片新增红色"删除供应商"按钮，带确认弹窗

---

### 4. Context Window 快捷预设按钮

**改动：** 在以下三处 Context Window 输入框旁新增快捷按钮（`64K` / `128K` / `256K` / `500K` / `1M` / `2M`）：
1. 新增/编辑自定义模型表单（`desktop/renderer/index.html`）
2. 模型目录页的内联上下文窗口控件（`desktop/renderer/app.js`）
3. 模型能力覆盖面板（`desktop/renderer/app.js`）

---

### 5. 中文 / 非 ASCII Provider ID 冲突修复

**问题：** Provider 名称为中文或中英混合时（如"百元kiro"和"瓦片kiro"），`slugify` 用 `/[^a-z0-9]+/g` 把中文全部剥离，导致两个不同的 Provider 被分配到相同的 ID `custom-kiro`，后者静默覆盖前者。

**修复（`desktop/settings.mjs`）：** slug 生成时引入中文字符的哈希摘要，保证唯一 ID。

---

### 6. Gateway 502/503 稳定性增强

**问题：** 第三方 OpenAI-compatible 中转站（OneAPI / NewAPI / Cloudflare 反代）会出现瞬时 502/503，或因缺少标准 User-Agent 而被拦截。上游遇到这类错误直接透传，不重试。

**修复：** 对上游 502/503 加入自动重试；补充标准 User-Agent 请求头。

---

### 7. Skills / MCP 离线磁盘兜底扫描

**问题：** 系统 `PATH` 里找不到 `codex` CLI 时，`codex app-server` 返回 `cli_not_found`，GUI 的 Skills 和 MCP 面板直接显示"无法读取"，即使 `~/.codex/skills/` 里已装了很多 skill。

**修复（`desktop/settings.mjs`）：** 新增 `scanDiskSkillsFallback()`，当 `codex app-server` 不可用时直接扫描本地 `~/.codex/skills/` 目录，不再依赖 CLI 进程。

---

## 上游项目

本 fork 基于 [wangzhezbz/codex-bridge](https://github.com/wangzhezbz/codex-bridge) v0.3.13，原始 License（MIT，版权归 wangzhezbz）见 `LICENSE` 文件。

关于下载安装、Codex 配置、计费模式、故障排查等通用使用说明请参考上游仓库 README，本 fork 未修改这些内容。

## License

MIT。原始版权归 wangzhezbz。本 fork 新增/修改部分同样以 MIT 方式开源。
