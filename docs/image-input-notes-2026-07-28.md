# CodexBridge 图片输入说明（2026-07-28）

## 当前结论

不能承诺“任何图片、任何大小、任何路径都一定成功”。当前已经验证：

- 小型 WebP：`11.webp` 可通过本地路径读取并被上游识别。
- 普通 PNG：`image-1.png` 可通过本地路径读取并被上游识别。
- 大型 PNG：`imagestudio-history-1785116494518.png` 原始尺寸为 `3840 x 2160`、文件约 `9.5 MB`。直接作为聊天附件可以读取；通过本地路径读取后的桥接续传已验证过尺寸识别，但在一次内容描述请求中出现过上游未收到图像的响应。因此，本地路径的大图链路仍应视为“有条件可用”，不是完全稳定的保证。

## 这次修改后的桥接行为

修改位置：`E:\CodexBridge\app-0.3.13\resources\app\src\responses-to-chat.js` 和 `src/claude-messages.js`

当图片是 WebP，或解码后的原始图片数据超过 `750,000` 字节时，Windows 上的 CodexBridge 会自动：

1. 在系统临时目录写入一次输入文件。
2. 调用 Windows 的图像解码组件读取图片。
3. 转为 JPEG，质量为 `78`。
4. 将最长边缩放到不超过 `1600 px`。
5. 将转换结果作为图片附件发送给上游模型。
6. 删除本次转换产生的临时目录。

这一步由桥接进程在每次需要时自动执行，不需要手动运行命令，也不会修改或删除原始图片文件。

## 路径与直接上传的差别

直接上传到聊天框：客户端把图片作为当前消息附件交给模型。这是首选方式，链路较短。

发送本机路径：模型需要先调用本地 `view_image` 工具读取路径，再由桥接层把该工具输出中的图片继续转发给上游。这多了一次工具调用和一次续传，失败点更多。路径本身不是图片内容，不能被上游模型直接访问。

对于本次 9.5 MB 的大 PNG，直接上传附件已经可读；路径方式不是必然不行，但仍出现过一次续传不稳定。因此，默认应直接上传附件；只有图片无法上传或确实需要指定本机文件时，再发完整路径。

## 保留最近四条图片消息

桥接不会删除你的原始文件，也不是把聊天记录物理地只保存一张图片。

为避免每一轮请求重复携带大量 Base64 图片数据，桥接发给上游模型的请求会清掉较早历史消息中的图片数据，并保留最近 `4` 条含图片的消息。每条保留的消息中如果同时附了多张图片，这些图片都会一起保留。

后果是：模型在后续轮次可以继续看到最近四条图片消息的视觉内容；更早图片则只保留此前生成的文字结论。需要比较较早图片、核对小字或重新分析时，应在同一条新消息中重新附上所需图片。

本规则由 `src/responses-to-chat.js` 与 `src/claude-messages.js` 在组装每次上游请求时执行。修改源码后，需要重启 CodexBridge 桌面程序一次才会加载新规则。

## 压缩的影响

转换确实会损失信息：JPEG 是有损格式，且超过 `1600 px` 的图会缩小。对主体、场景、常见物品和一般构图的识别通常足够；对小字号文字、界面像素、精细纹理、局部瑕疵、需要逐像素判断的任务则可能不够。

需要保留细节时，优先：

- 直接上传原图附件，而不是只给路径。注意：这能保留本地原始文件并减少一次工具续传；但当前桥接对 WebP 和超过阈值的图片仍会在发给上游前自动转为 JPEG，不能保证上游拿到原始像素。
- 将需要检查的小区域单独裁剪后上传，避免整张大图缩小。
- 在请求中明确说明要读取的文字或区域。
- 要比较多张图时，把它们放在同一条消息中上传。

## 推荐操作

1. 日常图片分析：直接把图片拖入或粘贴到聊天框。
2. 本机路径作为备选：发完整路径，并明确要求读取该图。
3. 大图、文字图或细节图：裁剪关键区域后作为附件一并上传。
4. 需要持续讨论旧图：重新附图，不依赖模型自动保留很早之前的视觉内容。

## Claude Messages 与跨模型历史

当路由接口类型为 `anthropic_messages` 时，CodexBridge 现在直接将 Responses 请求转换为 Anthropic 的 `/v1/messages` 请求，不再先构造 OpenAI Chat 请求再转换一次。网络层和内部上游载荷都使用 Claude 的原生结构：文本为 Claude content block，图片为 `image` block，工具为 `tool_use` / `tool_result`。

为了允许同一个对话切换模型，桥接保存的是中性会话历史：用户/助手文本、图片消息、标准工具调用和工具结果。具体行为如下：

- GPT/Chat 历史切到 Claude：历史工具调用会变成 `tool_use`，工具结果会变成 `tool_result`；最近四条图片消息继续作为 Claude 图片块发送。
- Claude 历史切到 GPT/Chat：Claude 的 `tool_use` 会保存为标准 assistant `tool_calls`，后续 GPT 路由可继续处理对应的工具结果；最近四条图片同样继续发送。
- 每次切换都不会恢复已经被历史保留规则省略的旧图片原始数据。较早图片仍保留文字占位和此前的文字结论；需要再次视觉分析时，应重新上传该图片。

这只是协议结构转换，不会绕过上游模型本身的图片、文件大小、上下文长度或工具兼容性限制。若 Claude 上游明确拒绝图片，桥接会自动改为不带图片的文字占位重试；若仍失败，则返回本地说明并保留后续可继续的历史。

## CodexBridge 模型设置中的协议选择

协议按上游服务实际提供的 HTTP 接口选择，不按模型名称选择。模型名中即使包含 Claude，只要服务商提供的是 OpenAI 兼容接口，也不应选择 Anthropic Messages。

| 上游服务实际接口 | CodexBridge 中应选择的协议 | 适用情况 |
| --- | --- | --- |
| `POST /v1/messages`，请求体使用 `model`、`max_tokens`、`messages`，并要求 `anthropic-version` 请求头 | `Anthropic Messages`（内部值：`anthropic_messages`） | Claude 官方接口，或真正兼容 Anthropic Messages 的中转接口 |
| `POST /v1/chat/completions`，请求体使用 OpenAI 的 `messages`、`tools` | `Chat Completions` | GPT，以及只提供 OpenAI 兼容接口的 Claude 中转服务 |
| `POST /v1/responses`，请求体使用 OpenAI Responses 结构 | `Responses` | 真正提供 OpenAI Responses API 的上游 |

选择 `Anthropic Messages` 后，当前修改的原生 Claude 转换才会启用，请求会直接发往 `/v1/messages`。若把实际只支持 `/v1/chat/completions` 的服务误设为 Anthropic Messages，服务会因路径、鉴权头或请求体不匹配而失败；反过来也一样。

配置 Claude 时，先以服务商文档中的请求路径为准：文档写 Anthropic SDK、`/v1/messages` 就选 `Anthropic Messages`；文档写 OpenAI Compatible、`/v1/chat/completions` 就选 `Chat Completions`。不同协议的模型仍可在同一对话中切换，桥接会转换可用的文本、最近四条图片和工具历史。

## 验证记录

`scripts/verify-claude-messages-native.mjs` 已验证以下构造场景：五条 GPT 图片历史加一条新图片时，原生 Claude 请求仅携带最新四条图片消息；GPT 的历史工具调用和工具结果分别映射为 Claude 的 `tool_use` 与 `tool_result`；Claude 返回的工具调用会保存为 GPT 可继续使用的标准工具调用历史。

已对本次编辑的 `src/claude-messages.js`、`src/upstream.js`、`src/tools.js`、`src/responses-to-chat.js` 执行 `node --check`，均通过；并用本地假上游完成端到端验证，确认实际请求 URL 为 `/v1/messages`、图片成为 Claude `image` 内容块、Claude 工具调用回写为 Responses `function_call` 且持久化为可跨模型继续的历史。

该打包源码目录当前不包含 `tests/` 及 `scripts/desktop-smoke.mjs`，所以完整 `npm run test:router` 与 `npm run check:syntax` 无法在此目录完成，失败原因是缺失这些文件，而不是本次转换代码的测试失败。
