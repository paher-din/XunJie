# 实施规范

本轮工作包及依赖见[实施总览](../student-agent-implementation-overview.md)，各包规范集中放在本目录。

| 工作包 | 规范 | GitHub 规范母票 | 范围 |
| --- | --- | --- | --- |
| WP01 | [产品运行与数据底座](wp01-product-runtime-and-data.md) | [WP01：产品运行与数据底座](https://github.com/paher-din/XunJie/issues/142) | 工程入口与公共契约准备、原生 PostgreSQL 生命周期、独立环境与部署连接、所属事务和资源、备份升级及恢复交接 |
| WP02 | [学习空间与可靠工作区](wp02-learning-space-and-reliable-workspace.md) | [WP02：学习空间与可靠工作区](https://github.com/paher-din/XunJie/issues/148) | 个人/学校身份与隔离、课程发布基础记录、可无课程活动、作品与固定引用、静默自动保存、待同步/待发意图及同浏览器恢复 |
| WP03 | [课程组件宿主与公共执行](wp03-course-components-and-execution.md) | [WP03：课程组件宿主与公共执行](https://github.com/paher-din/XunJie/issues/162) | 固定组件与动态宿主、独立实例与语义引用、依赖准备和自检、有限作业/持续会话、真实结果与恢复、正式产品接线 |
| WP06 | [三协议模型连接](wp06-model-connections.md) | [WP06：三协议模型连接](https://github.com/paher-din/XunJie/issues/163) | 学校/个人模型配置与正式设置接入、三协议直接 SDK、能力证据、图像、持久调用结果、原生续接及错误/用量未知 |

WP06 的五张实施子票入口见[规范末尾](wp06-model-connections.md#further-notes)；实施前沿以[规范母票](https://github.com/paher-din/XunJie/issues/163)的原生子议题及阻塞关系为准。

## WP03 子票实施方案

| 实施票 | 文档 | 文档性质 |
| --- | --- | --- |
| [组件与执行数据的备份、还原和接管](https://github.com/paher-din/XunJie/issues/176) | [设计与验收计划](wp03-execution-recovery.md) · [实现与验证](../wp03-176-recovery-implementation.md) · [#188 跨平台与跨机验收](../wp03-188-cross-platform.md) | Windows 实际产品包恢复链路已验证；Mac 与 Windows 客户端连接独立学校节点的跨机验收见 #188，备份资源/恢复格式负例、执行器状态注入的 disposition 负例、真实停节点与 fence 后旧连接/可信晚回包负例均已在两客户端补跑，教学效果未评估 |
| [组件依赖准备、自检与失败恢复](https://github.com/paher-din/XunJie/issues/171) | [实施方案与验收计划](wp03-component-preparation.md) · [Mac 交接](../wp03-171-mac-handoff.md) · [Mac 与学校路径验收](../wp03-mac-school-acceptance.md) | Windows 实现与复审证据见记录；Mac 完整包、Chrome、系统输入法及学校跨机路径由 #179/#181 接续完成，实际结果与限制见验收记录，教学效果未评估 |
## WP06 子票实施方案

WP06 首张子票 [#164：个人模型设置与可靠连接检查](https://github.com/paher-din/XunJie/issues/164)的范围、owner 和测试边界见[实施方案](wp06-personal-model-checks.md)，实际结果与前后截图见[交付记录](../wp06-personal-models-acceptance.md)。

WP06 [#166：Responses 完整接入](https://github.com/paher-din/XunJie/issues/166)的原生结果、工具图像、续接及验收见[实施方案](wp06-responses.md)和[交付记录](../wp06-responses-acceptance.md)。

WP06 [#167：Anthropic Messages 完整接入](https://github.com/paher-din/XunJie/issues/167)见[实施方案](wp06-messages.md)和[交付记录](../wp06-messages-acceptance.md)，复用现有模型 owner，Mac 后续交接 #178。

[#165：学校／个人模型选择与 Chat 原生续接](https://github.com/paher-din/XunJie/issues/165)见[实施方案](wp06-selection-chat-continuations.md)、[模型 owner](../../../packages/learning-space/src/model-connections/README.md)及[分项验收](../wp06-chat-selection-acceptance.md)。Mac 后续验收统一交接 #178。

## WP02 子票实施方案

混合部署与恢复接管见 [#154 实施方案](wp02-hybrid-deployment.md) 与[生产操作及验收记录](../wp02-hybrid-deployment.md)。真实跨机与 Mac 结果分别登记，不以同机替代。

| 实施票 | 文档 | 文档性质 |
| --- | --- | --- |
| [固定依据与持久待发意图](https://github.com/paher-din/XunJie/issues/153) | [实施方案](wp02-durable-action-intents.md) · [接入与交接](../wp02-action-intents.md) | 当前分支实施；固定输入、可靠待发、取消、原请求核实与接收回执，Mac/跨机交接 #155 |
| [课程任务与固定发布版本](https://github.com/paher-din/XunJie/issues/150) | [实施方案与验收计划](wp02-course-task-releases.md) · [实施与验收记录](../wp02-course-releases-acceptance.md) | 已实施（`codex/wp02`，未合并 main）；工程及 Windows/Mac 分项验证范围见验收记录，教学效果未评估 |
| [固定引用与问题草稿恢复](https://github.com/paher-din/XunJie/issues/152) | [实施方案与验收计划](wp02-fixed-references-and-question-drafts.md) · [实施与验收记录](../wp02-fixed-references-acceptance.md) | 已实施（`codex/wp02` 工作树，未提交/合并）；Windows 工程、真实 PG 与 Chrome 已验证，Mac 与教学效果未执行 |

## 已有前端能力

以下保留此前已交付的两项前端能力规范与验收记录，供新工作包接入时复用。

这两项是负责人于 2026-10-23 明确授权实施的范围，与模型接入和总体架构研究并行。规范依据已确认的产品要求，限定在可复用前端能力；它们不代表相关研究议题已经解决。

| 实施范围 | 规范 | GitHub 实施票 |
| --- | --- | --- |
| 普通文本与代码选区、工具条、引用区 | [选区引用](workspace-selection-references.md) | [工作区选区工具条与上下文引用](https://github.com/paher-din/XunJie/issues/122) |
| IP、文字与卡片的受控展示及旧脚本适配 | [引导展示层](guidance-presentation.md) | [IP 教学引导展示层](https://github.com/paher-din/XunJie/issues/123) |

交付包括实际复用的组件、来源或课程适配和开发验收页；后端同步、教学状态机和模型接入不包含在这两项实现中。各项分别记录工程检查、浏览器验收和未验证范围。

## 组件接入与本地验收

在仓库根执行 `npm ci`，再运行 `npm run dev -w @xunjie/web`，使用终端显示的地址打开以下 hash 路由。两个验收入口及其样例仅在开发模式存在。

| 能力 | 代码入口 | 开发验收路由 |
| --- | --- | --- |
| 选区工具条、文本与代码来源、问题草稿和引用 | [references/index.ts](../../../apps/web/src/components/workspace/references/index.ts) | `/#/dev/workspace-references` |
| IP、文字与卡片的受控展示 | [GuidancePresentation.tsx](../../../apps/web/src/components/workspace/guidance/GuidancePresentation.tsx) | `/#/dev/guidance` |
| 已有课程脚本适配 | [GuideLayer.tsx](../../../apps/web/src/components/workspace/GuideLayer.tsx) | 引导验收页的“旧脚本适配”，以及原有课程入口 |

引用由 `WorkspaceReferencesProvider` 按 `workspaceKey` 隔离；来源身份应标识实际对象，不能只用可能被复用的显示名称。`onSubmit` 只收到明确发送的问题、选中片段与来源范围，完整原文仅用于本地定位校验。接收回调成功后清理未被继续编辑的草稿，失败则保留。

引导组件放在具有定位上下文的展示区域内，由调用方提供 `item`、`state` 和 `onAction`。替换为新的逻辑展示项时必须使用新的 `item.id`；旧课程脚本已通过 `GuideLayer` 使用同一组件。

## 本地验收记录（2026-10-23）

- 工程检查：学生端 `typecheck`、`build` 通过；相关 7 个单元测试文件共 72 项通过。生产产物中未发现两个开发入口及样例内容。构建仍提示部分既有大体积 chunk，不影响成功退出。
- 浏览器自动验收：`workspaceReferences.spec.ts`、`guidancePresentation.spec.ts`、`editor.spec.ts` 共 27 项通过。覆盖查找/替换输入不误引用、长选区纵向滚动，以及单行/多行选区横向滚动后入口保持可用。
- Chrome 实际操作：确认普通文本与代码混合引用、明确发送回执、水平滚动入口、IP 文字与卡片、键盘焦点，以及原有课程脚本推进。
- Standards 审查：两处设计偏离已修复（IP 焦点 token、普通文本引用字体）；两种来源的小范围按键判定重复为非阻塞建议，暂保留各自手势条件。
- Spec 审查：查找输入误引用、长选区滚动定位两类行为缺口已修复并补回归；最终只读复核未发现剩余已确认缺口。
- 教学效果未验证；本次验收不涵盖模型、后端同步和完整课程教学流程。
