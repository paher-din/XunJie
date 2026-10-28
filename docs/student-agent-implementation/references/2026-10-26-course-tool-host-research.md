# 课程组件与生成内容：宿主技术研究

核对日期：2026-10-26。服务于[课程工具与生成内容：接入、运行宿主和状态恢复](https://github.com/paher-din/XunJie/issues/117)，仅提供事实与工程建议，不形成产品决议。
已先读根 AGENTS.md、README 及 [2026-10-18 架构核查的相关小节](2026-10-18-architecture-checks.md#openintelligentui-复用)；本报告补充实现边界，不重复其总论。
方法：官方源码、规范与 API 文档阅读；未安装、构建或运行上游，未做浏览器、真实模型端点或教学效果实测，不证明生产支持。
范围：OpenIntelligentUI 的 renderer 及直接依赖、桥接、导出、架构说明；MCP/MCP Apps 的相关协议。未读取 docs/archive，未修改 GitHub。

## 版本与证据边界

- **固定版本 OIU：** `8391a94c1c3939c679e40ddd7bfc08a9ef690e70`，以下 OIU 代码链接全部固定到该提交。[O1]
- **当前 OIU：** 本次 GitHub `commits/main` 解析仍为上述提交，提交时间为 2026-10-13；本次未发现 main 上更新实现改变既有判断。不是对未合并分支的判断。[O1]
- **当前 MCP Core：** 官方 `specification/latest` 实际重定向到 **2026-07-28**；本报告使用该版，旧版协议的行为须另行兼容。[M1][M2]
- **MCP Apps 稳定规范：** 官方仓库当前仍链接 **2026-01-26 Stable**；另有 draft，不能混称为稳定能力。[A1][A2]
- **当前 Apps 源码快照：** `266a9e3b70dbd4a4f0546dda95da2a2c1a8be4b7`（2026-10-23），package.json 标为 `2.0.3`；这是源码包版本，未核验 npm 发布或任一宿主兼容性。[A3]
- Apps 的 `ui/initialize` 是 **View↔Host** 生命周期；不要因新 Core 去掉 server 连接握手，就删掉 Apps 自身握手，也不要默认两份规范的示例可直接拼接。[M2][A1]

## OpenIntelligentUI：可抽取的东西和真实缺口

| 源码事实（固定提交） | 对抽取的工程含义 |
| --- | --- |
| `schema.ts` 是 css/html/jsFunctions/jsExpressions、完成标志与初始高度等生成载荷，没有业务状态版本、实例身份、选区或恢复字段。[O2] | 可借用载荷形状，不应把它命名为工作区状态协议。 |
| renderer 按 1000ms 节流，并在 CSS/HTML 等关键完成边界立即刷新。[O3] | 可以抽取流式展示调度；没有测得其性能、正确率或 XunJie 集成成本。 |
| CSS 完成后才显示预览；`processPartialHtml` 清理不完整片段和 script/head/style 块，Idiomorph 渐进更新 body。[O3][O4] | 可复用预览机制；字符串清理不是完整 HTML 安全消毒，不能据此给预览开放业务写命令。 |
| 预览以空 local API 创建；`htmlComplete` 后销毁预览，另建最终 Websandbox，随后注入函数及顺序执行表达式。[O3] | 预览与最终实例不是同一个 DOM；输入、随机数、动画、Canvas 和 JS 堆状态不能指望自动迁移。 |
| 最终 frame 注入主题、importmap、动效和 CSP；renderer 还引用导出覆盖层、CopilotKit `useSandboxFunctions`。[O3][O5] | 不是可直接拷贝的独立 renderer 包；建议替换应用壳、主题和桥接注入点，再评估 Websandbox 是否值得保留。 |
| Websandbox loader 动态导入 1.2.1，并处理 UMD/CJS 双层 default。[O6][O7] | 抽取仍有打包器适配点；不能从 TypeScript 接口推断构建已通过。 |
| `localApi` 来自宿主注册的 sandbox functions；仓库提供 `sendPrompt`、`openLink`。[O3][O8] | 可以复用“只暴露显式能力”的边界；不自带通用课程命令、文件系统或执行器。 |
| `sendPrompt` 校验 1–4000 字符、同步 claim 防重复、忙时拒绝，加入 user 消息再运行 Agent；处理 run error 与卸载。[O8][O9] | 是新一轮对话入口，不是状态同步、教学事件确认、持久队列或 exactly-once 执行。 |
| `openLink` 只允许 HTTPS，可配 origin 白名单；resize 检查 iframe source 并钳制高度。[O3][O8] | 是可参考的消息边界，不能替代实例绑定、命令授权和业务参数校验。 |

**许可证与依赖：** OIU 为 MIT，复制实质代码需保留版权与许可声明；Websandbox 1.2.1 声明 Apache-2.0；内联 Idiomorph 标注 v0.3.0，其原始许可为 BSD-2-Clause，需保留相应声明。[O10][O7][O11][O12]
直接应用依赖包括 React 19、Next 16、Zod 3、CopilotKit `1.55.2-next.1` 和 workspace design-system；这是原应用依赖，不是最小抽取的必需全集。建议移除聊天/导出壳对核心渲染的依赖，而非整栈搬入。[O6]
importmap 的 three/gsap/d3/chart.js 指向未固定版本的 esm.sh URL；下载导出的 HTML 也仍可能依赖网络，不能称为自包含离线包。实际打包与分发时再核对所保留第三方资产的版本和各自许可，本次未做完整传递依赖清点。[O13][O14]

**隔离不是现成课程权限：** 最终 frame CSP 包含 inline/eval 及四个 CDN origin；预览 head 构造没有同一份 CSP 注入。源码并不支持“全部生成阶段都无网络”的结论；应在抽取 spike 中实际验证预览/最终策略，而非沿用注释当验收。[O5]

**保存生成代码 ≠ 保存用户进度：** 上游架构明确 checkpoint 在进程内存，跟进产生新的回答快照，任意 iframe 控件状态不会自动同步给 Agent；所读 schema/桥接也没有 serialize/restore 或业务写入确认协议。[O15][O2][O8]
卸载后重跑生成脚本只能重建初始页面，不能恢复学生当前答案、游标、选中器件或运行会话；随机值、时间和外部读取还可能使重放不同。这是由生命周期和协议缺口推导的工程判断，未实测。[O3]

**导出 ≠ 发布或恢复：** `assembleStandaloneHtmlFromActivity` 拼接生成载荷，给 `sendPrompt` 放空实现、给 HTTPS `openLink` 放浏览器实现；未读取当前 DOM/控件状态。导出不是受管理部署，也不保留原宿主能力。[O14]

**非文本引用缺口：** 所读协议没有图节点 ID、波形时间区间、画布区域、结构化选区或稳定语义锚点。`sendPrompt` 可手工携带选中值，但不保证对象身份、版本与失效检测；不能声称开箱即用“任意内容划选求助”。[O2][O8][O15]

## MCP / MCP Apps：责任实际落在哪里

| 能力 | 官方事实 | XunJie 仍需承担的边界（工程建议） |
| --- | --- | --- |
| 外部工具 | Core `tools/list`、`tools/call` 定义发现、参数与结果；不规定必须采用某种用户界面。[M3] | 将调用绑定到被授权活动/实例；管理意图、幂等键、结果未知及查询恢复。 |
| 资源 | Core 用 URI 暴露文本/二进制；由应用决定如何纳入上下文；列表可按每请求凭据变化。[M4] | 教师私有材料在服务端鉴权和过滤；`audience` 等提示不能当 ACL。 |
| UI 发现 | Apps 工具 `_meta.ui.resourceUri` 指向 `ui://`；通过 resources/read 获取 `text/html;profile=mcp-app` HTML。[A1] | 资源提供者负责打包页面；平台决定允许的构件版本、来源和实例映射。 |
| 隔离运行 | Apps 规定沙箱；web Host 必须经与 Host 不同 origin 的 sandbox proxy 中转，按规范加载内层 View。[A1] | iframe/proxy 的部署、origin、消息来源核验与生命周期是宿主集成工作。 |
| 双向桥接 | View↔Host 以 postMessage 承载 JSON-RPC；Host 可代理 `tools/call`、`resources/read`；App 与 AppBridge 是便利 SDK。[A1][A4][A5] | 不应直接把全平台 MCP client 权限交给每个页面；按来源服务器、实例和允许能力路由。 |
| 生成中数据 | Host 可发 tool-input-partial，须在初始化后发完整 tool-input；显示期间工具完成时发 tool-result。[A1] | 标准化的是输入/结果传递，不是生成 HTML 分片编译器；OIU 渐进页面仍需单独 adapter。 |
| 模型上下文 | `ui/update-model-context` 面向后续轮次；宿主可覆盖该 View 先前上下文、延后到下一消息；多次更新时规范建议只发送最后一次。[A1][A4] | 适合当前观察摘要；成功响应不代表进度已持久化，也不是事件历史或立即触发推理。 |
| 交互回传 | `ui/message` 发送对话消息；UI 可显式调用工具刷新/提交；日志是另一类通知。[A1] | 控件变化需 app 主动上报；业务事件、保存确认、模型消息和诊断日志分清用途。 |
| 可见性与权限 | `_meta.ui.visibility` 区分 model/app 可调用面；Host 应拒绝 app 调用未向 app 开放的工具。[A1] | `app` 可见不等于学生有权读教师资料；服务器还需验证主体、活动、对象及操作权限。 |
| CSP / 设备能力 | Host 按资源元数据构造 CSP，可收紧不可放开未声明域；camera/microphone 等是请求，不保证获准。[A1] | 服务器声明需求，宿主执行实际策略，app 做拒绝与缺能力降级；不能只信 HTML 自带 meta。 |
| 重开与销毁 | Stable 与当前 draft 都把 state persistence/restoration 列为后续能力；teardown 仅提供优雅退出机会。[A1][A2][A4] | 业务服务保存权威状态、版本与执行句柄；Host 重建后读取并注入，不能只在 teardown 保存。 |

**SDK 不代管业务存储：** 当前 AppBridge 的 `onupdatemodelcontext` 示例明确调用宿主自己的 `modelContextManager.update`；SDK 只分派回调，未替 XunJie 建立业务数据库或恢复策略。[A5]
**当前演变值得跟踪：** draft 与 SDK main 已有 app-provided tools / `registerTool`，支持模型按语义查询 app 状态或发命令；不能再笼统说 MCP Apps 永远只能被动接收数据。[A2][A4]
但这是 **draft 能力及源码实现**；draft 要求这些工具随 iframe 销毁、不得跨会话保留注册。它仍不自动提供持久状态、非文本锚点格式或跨宿主一致支持，适合作为后续适配候选。[A2]

### Transport 与恢复必须分开

MCP Core 2026-07-28 已移除协议级 session、Mcp-Session-Id 和 SSE Last-Event-ID 重投；跨调用状态使用显式服务端句柄作为普通参数，长驻通知改用 subscriptions/listen。[M2][M5]
transport 只负责封装、交付、元数据与取消；它不定义课程对象、控件状态、锚点或文件一致性。旧版有 SSE 恢复也只恢复消息交付，不自动恢复工作区事实。[M6]
因此工程上应分别固定 **Core 版本、Apps 版本、SDK 版本、宿主实现**；断线后先查询业务效果再决定是否重试有副作用操作，不能把“重发新 RPC”当作业务幂等保证。[M2][M5]

## 最小复用路径：建议，不替负责人定产品范围

1. 先把“渲染”当作可替换 adapter：优先提取 OIU 的纯片段处理、预览/最终生命周期和有界 resize；主题、聊天入口、导出 UI 与 CopilotKit hook 通过注入替换。保留 Websandbox 与采用 Apps AppBridge 的成本由 spike 比较，不同时建立两套权威状态。[O3][O4][A5]
2. 受控组件和隔离页面共享业务含义，但采用不同接入层：前者进程内调用，后者经受限桥接。不要声称一个 postMessage wrapper 就让二者有相同隔离级别；MCP Apps 是可选外部 UI adapter，不是课程领域模型。[A1][M6]
3. 给可恢复构件定义小的显式契约，以下仅是待讨论的工程草案，不宣称来自上游标准：

```text
definition: toolId, toolVersion, stateSchemaVersion, artifactRef, requiredCapabilities
instance: instanceId, activityId, definitionRef, revision, persistedState, executionRef?
bridge: initialize(snapshot), command(requestId, expectedRevision, payload), observe(), select(anchor)
anchor: instanceId, revision, kind, semanticId/range, humanReadableSummary
```

4. 按现有状态决议确定的归属处理 command；工作区对本机持久化与远端接收分别确认，本地操作不强制等待应用服务。Host 将已确认的状态身份交给视图，并按需把已同步观察映射给服务端 Agent。observe/选择可按需携带图片或结构化区域，但必须显式生成，不能从跨域 DOM 自动推断。上述字段/时序是填补上游缺口的建议。[O2][A1][A2]
5. 重开时按 artifactRef/版本加载、读取实例状态、完成握手后恢复，再刷新观察；有 executionRef 时查询运行后端，不能靠重建 iframe 恢复进程。版本不匹配应报告不可恢复或走显式迁移，不静默重置学生数据。[O3][A1][M2]
6. MCP 可承接外部工具与资源发现；Skills 承载操作指导，不替代代码运行宿主、资源授权、状态 API 或升级迁移。无需为仅在本工作区使用的第一件课程组件先建设完整 MCP server/插件市场；这是范围控制建议，不是排除未来标准适配。[M1][A1]

## 暂不应承诺

- 把 OIU 直接接入就能完整恢复任意生成页面、保持预览交互、追溯非文本引用或回传完整学习过程。[O2][O3][O15]
- 保存 HTML、导出文件、MCP transport 重连、update-model-context 任一种成功，就代表学生进度保存、执行结果确认或恢复成功。[O14][M2][A1]
- 任意依赖/后端程序能仅靠 iframe 或 MCP 跑起来，所有宿主兼容同一 draft 能力，或生成后即完成正式发布。[O6][A1][A2]
- 本次研究证明了抽取能构建、性能可接受、权限隔离经验证、生产可用或教学有效；这些均未实测。

## 确需后续 spike 的三点（本次不执行）

1. **抽离与沙箱边界：** 仅做一个流式生成控件，移除 CopilotKit hook/应用壳后构建；比较直接保留 Websandbox 与 Apps host 接入成本。验证预览→最终切换、CSP/网络、消息来源、卸载和失败呈现。产物是依赖清单与实际行为，不是通用平台。
2. **状态与效果恢复：** 一个可编辑表单加一次有副作用的模拟命令；覆盖确认前断线、确认后丢响应、刷新/崩溃、重复请求及旧 schema 重开。验收是业务状态一致、未知效果可查询且不重复执行，不是 iframe 能重新显示。
3. **非文本语义与 Apps 版本组合：** 用图节点或波形区间实现 select/observe/定位；验证 revision 变化后的锚点失效、模型收到的上下文，以及关闭 app 后行为。稳定协议先实现必要桥接，再单独比较 draft app tools 的收益，不据示例推断跨宿主支持。

## 官方主源索引

[O1]: https://api.github.com/repos/CopilotKit/OpenIntelligentUI/commits/main
[O2]: https://github.com/CopilotKit/OpenIntelligentUI/blob/8391a94c1c3939c679e40ddd7bfc08a9ef690e70/apps/app/src/components/generative-ui/open-generative-ui/schema.ts
[O3]: https://github.com/CopilotKit/OpenIntelligentUI/blob/8391a94c1c3939c679e40ddd7bfc08a9ef690e70/apps/app/src/components/generative-ui/open-generative-ui/renderer.tsx
[O4]: https://github.com/CopilotKit/OpenIntelligentUI/blob/8391a94c1c3939c679e40ddd7bfc08a9ef690e70/apps/app/src/components/generative-ui/open-generative-ui/process-partial-html.ts
[O5]: https://github.com/CopilotKit/OpenIntelligentUI/blob/8391a94c1c3939c679e40ddd7bfc08a9ef690e70/apps/app/src/components/generative-ui/open-generative-ui/frame-content.ts
[O6]: https://github.com/CopilotKit/OpenIntelligentUI/blob/8391a94c1c3939c679e40ddd7bfc08a9ef690e70/apps/app/package.json
[O7]: https://github.com/JetBrains/websandbox/blob/v1.2.1/package.json
[O8]: https://github.com/CopilotKit/OpenIntelligentUI/blob/8391a94c1c3939c679e40ddd7bfc08a9ef690e70/apps/app/src/lib/sandbox/sandbox-functions.ts
[O9]: https://github.com/CopilotKit/OpenIntelligentUI/blob/8391a94c1c3939c679e40ddd7bfc08a9ef690e70/apps/app/src/lib/sandbox/prompt-bridge.tsx
[O10]: https://github.com/CopilotKit/OpenIntelligentUI/blob/8391a94c1c3939c679e40ddd7bfc08a9ef690e70/LICENSE
[O11]: https://github.com/CopilotKit/OpenIntelligentUI/blob/8391a94c1c3939c679e40ddd7bfc08a9ef690e70/apps/app/src/components/generative-ui/idiomorph-inline.ts
[O12]: https://github.com/bigskysoftware/idiomorph/blob/v0.3.0/LICENSE
[O13]: https://github.com/CopilotKit/OpenIntelligentUI/blob/8391a94c1c3939c679e40ddd7bfc08a9ef690e70/packages/design-system/src/index.ts
[O14]: https://github.com/CopilotKit/OpenIntelligentUI/blob/8391a94c1c3939c679e40ddd7bfc08a9ef690e70/apps/app/src/components/generative-ui/export-utils.ts
[O15]: https://github.com/CopilotKit/OpenIntelligentUI/blob/8391a94c1c3939c679e40ddd7bfc08a9ef690e70/docs/architecture.md
[M1]: https://modelcontextprotocol.io/specification/latest
[M2]: https://modelcontextprotocol.io/specification/2026-07-28/changelog
[M3]: https://modelcontextprotocol.io/specification/2026-07-28/server/tools
[M4]: https://modelcontextprotocol.io/specification/2026-07-28/server/resources
[M5]: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
[M6]: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports
[A1]: https://github.com/modelcontextprotocol/ext-apps/blob/266a9e3b70dbd4a4f0546dda95da2a2c1a8be4b7/specification/2026-01-26/apps.mdx
[A2]: https://github.com/modelcontextprotocol/ext-apps/blob/266a9e3b70dbd4a4f0546dda95da2a2c1a8be4b7/specification/draft/apps.mdx
[A3]: https://github.com/modelcontextprotocol/ext-apps/blob/266a9e3b70dbd4a4f0546dda95da2a2c1a8be4b7/package.json
[A4]: https://github.com/modelcontextprotocol/ext-apps/blob/266a9e3b70dbd4a4f0546dda95da2a2c1a8be4b7/src/app.ts
[A5]: https://github.com/modelcontextprotocol/ext-apps/blob/266a9e3b70dbd4a4f0546dda95da2a2c1a8be4b7/src/app-bridge.ts
