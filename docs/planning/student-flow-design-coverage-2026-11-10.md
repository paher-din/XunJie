# 按实施总览核对开发计划：实现覆盖与差异

2026-11-10；供第 2 组、负责人讨论和后续修复 Agent 使用。主依据是 [student-agent-implementation-overview.md](../student-agent-implementation/student-agent-implementation-overview.md) 的 **2026-11-08 版本**，逐项覆盖其 13 个工作包；第 2 组负责的学生流程进一步拆项。子票用于解释验收边界，不用旧演示页面或归档材料扩大当前需求。

配套：[易读工作安排](student-flow-week-plan-2026-11-10.md)、[AI 执行说明](student-flow-ai-brief-2026-11-10.md)、[本轮 Chrome 体验与 SF-01 修复记录](student-flow-first-pass-2026-11-10.md)。

## 1. 结论和证据口径

**总览中的预期功能没有全部实现。已进入本轮打磨范围的能力，大部分已有正式产品接线，但不能据此认定全部可用或验收通过。**

- WP01–04、WP06–09 共 8 个包有关闭的规范母票、主线代码和交付记录；“有交付记录”不等于本次逐项复验通过。
- WP05 明确暂缓；产品 MCP、Plugin、MCP Apps 也明确退出当前交付范围，不能算本周漏做项。
- WP10 的完整教师制作发布流程、WP11 的连续主动引导和学习画像、WP12 的教师提交反馈，以及 WP13 的新版复现评估链，不能认定已经完整交付。已有局部接口或旧版能力不等于这些包完成。
- 第 2 组的正式路径已覆盖课程进入、可靠作品、ALU 实验、学习对话、能力扩展和活动内生成内容。已确认的差异主要集中在活动恢复故障和页面表达；真实模型与跨机组合本轮仍待补验。

首轮核对基线为 `2cde3391`，含已授权的 SF-01 修复。11 月 11 日更新到 `codex/student-flow-polish` 的 `ab918bce` 加本地改动，复核第 2 组的已修项、接入状态和待讨论项。工作包的原设计与历史交付证据沿用首轮记录。

本报告使用以下状态，不能相互替代：

| 状态 | 含义 |
| --- | --- |
| 代码已接线 | 已核对正式页面、调用入口和所属实现；不是只找到文件名或类型 |
| 本轮局部实测 | 本轮 Chrome 或工程检查已覆盖表中明确指出的部分，其他分支仍未测 |
| 已确认差异 | 有源码或本轮复现依据；另注明是行为故障、呈现问题还是讨论项 |
| 待补验 | 有实现，但当前环境或本次检查尚不能证明目标路径通过；不直接判成缺功能 |
| 后续 / 暂缓 | 总览中的后续能力或明确暂缓能力，不自动转成本周实施任务 |

GitHub 母票状态在本次查询中核实。下表及相关子票即使已关闭，仍以当前源码和各自交付证据判断覆盖；未勾选的历史清单、单独一个 closed 状态，也都不能代替功能核对。代码核对不覆盖每条故障竞争和每个平台；本轮实际使用范围见第 6 节。

## 2. 总览的 13 个工作包逐项核对

| 工作包及总览预期 | 当前实现与证据 | 本次判断及第 2 组处理 |
| --- | --- | --- |
| **WP01 产品运行与数据底座**：原生 PostgreSQL、资源、环境、安装启停、升级和备份恢复、部署组合 | [母票 #142](https://github.com/paher-din/XunJie/issues/142) 已关闭；[product-runtime](../../packages/product-runtime/src/runtime.ts)、[恢复入口](../../packages/product-runtime/src/recovery.ts)、[storage](../../packages/storage/src/storage.ts)、[本机 CLI](../../apps/local-runtime/src/cli.ts) 已有正式实现。本轮确实使用了原生 PostgreSQL、本机启动与备份迁移 | **已有交付；本轮局部实测。** 这里只核依赖，不重新审计全部运行底座；跨机组合仍待补验 |
| **WP02 学习空间与可靠工作区**：身份隔离、固定课程版本、无课程活动、作品、引用、自动保存、待发和返回恢复 | [母票 #148](https://github.com/paher-din/XunJie/issues/148) 已关闭；`LearningApp → ActivityReferences → ReliableWorkspace / ReliableQuestionDraft / ReliableActions → learning-entry → courses / learning-data` 已接线 | **已有实现，存在局部差异。** 重开后运行的 SF-01 已修；入口、材料与内部文件呈现继续打磨，详见第 3、5 节 |
| **WP03 组件宿主与公共执行**：固定组件、实例状态、语义引用、依赖准备、自检、有限作业和持续会话 | [母票 #162](https://github.com/paher-din/XunJie/issues/162) 已关闭；[ActivityPage](../../apps/web/src/product/ActivityPage.tsx) 按课程绑定挂载 `ComponentView`、`ExecutionPanel`、`NativeSessionPanel` 或 `RuntimeTool`，消费 [公共执行 owner](../../packages/learning-space/src/learning-data/executions.ts) | **已有交付；本轮只实测 ALU 消费路径。** 通用三类样例不宣称本次重新验收 |
| **WP04 ALU 浏览器实验**：真实 WASM、编辑/虚拟板/波形、4096 组、失败负对照、预测与观察、版本和恢复 | [母票 #190](https://github.com/paher-din/XunJie/issues/190) 已关闭；[正式实验组件](../../apps/web/src/course-tools/alu/AluExperimentTool.tsx) 与 [运行包](../../components/alu-experiment/package.mjs) 已接公共执行 | **主要能力已接线；本轮局部实测且有状态提示差异。** 编译错误、预测、真实 4096 检查和波形引用已有证据；行为错误反例等仍待补验 |
| **WP05 数据分析与报告**：R、表格/图表/报告、Flights | 总览明确暂缓，无恢复日期 | **暂缓。** 不列为本周缺口，不补接口或课程验收 |
| **WP06 三协议模型连接**：Chat Completions、Responses、Messages，个人/学校选择、能力、续接和错误 | [母票 #163](https://github.com/paher-din/XunJie/issues/163) 已关闭；[model-connections](../../packages/learning-space/src/model-connections/README.md) 中有三个 SDK 适配及选择/原生结果实现，正式设置接同一 owner | **已有交付；本轮缺可用模型，未重验真实端点。** 设置打磨主责第 1 组，第 2 组核对课程消费与恢复 |
| **WP07 持久 Agent 与学习对话**：RunDriver、会话/快照、命令与等待、预算、停止恢复、steering/queue、真实过程 | [母票 #196](https://github.com/paher-din/XunJie/issues/196) 已关闭；[正式对话](../../apps/web/src/product/ActivityConversation.tsx)、[Agent owner](../../packages/learning-space/src/teaching-agent/index.ts)、[RunDriver](../../packages/learning-space/src/teaching-agent/driver.ts) 和课程工具已接线 | **代码已接线，真实辅导本轮待补验。** 不能把缺模型暂停当作整个 Agent 未实现；也不能把该包当成完整 WP11 主动引导 |
| **WP08 能力、上下文与扩展**：版本化装配、工具发现、Skills、压缩、记忆读取、资料/PDF | [母票 #214](https://github.com/paher-din/XunJie/issues/214) 已关闭；装配、发现、Skills、压缩、学生明确事实和资料/PDF 有实际 owner 与正式消费入口，见第 3 节 | **代码已接线；课程组合待补验。** MCP / Plugin 不在本轮；偏好/事实记忆不等于学习画像 |
| **WP09 可交互教学内容**：渐进预览、校验启用、受控调用、保存、收纳重开、修订保留输入 | [母票 #224](https://github.com/paher-din/XunJie/issues/224) 已关闭；[实施记录](../student-agent-implementation/wp09-implementation.md) 与 [ArtifactCard](../../apps/web/src/teaching-artifacts/ArtifactCard.tsx)、[产物 owner](../../packages/learning-space/src/learning-data/teaching-artifacts.ts) 对应 | **已有正式实现，不能误列为未开始。** 本轮尚无真实生成使用证据；Agent 输出 UI 等第 1 组交接后复用 |
| **WP10 教师组件库与课程发布**：教师确认目标/评价/帮助策略，组件创作、装配、预览发布和复用同步 | [courses](../../packages/learning-space/src/courses/README.md) 有固定发布导入及 [execution-design](../../packages/learning-space/src/courses/execution-design.ts) 接口；正式 Web 仍将旧教师页列为 legacy 消费方，未找到该包完整新产品流程 | **局部基础存在，完整工作包未交付。** CLI 导入课程不等于教师产品发布流程；不由本周顺手补齐 |
| **WP11 连续引导与学习画像**：跨次目标、三档主动性/暂停、规则检测、提示失效/反馈、证据与可纠正画像 | `ActivityPage` 仅在已有待回答问题且对话关闭时显示 IP 提示；已有活动恢复、`student.ask` 和明确偏好读取。未找到三档设置、主动检测调度及画像复核的正式闭环 | **局部复用基础存在，完整能力未实现。** 本周验收已有引导呈现与求助，不新增整套主动教学策略 |
| **WP12 教师进展、固定提交与反馈**：课程摘要、点击时固定交付、教师回执/审阅/反馈、关联修订 | [正式 Web 接入表](../../apps/web/README.md) 将教学交付留给 WP12；[ALU 学习说明](../../components/alu-experiment/learning.md) 明确本阶段不生成教师提交/接收记录。当前正式活动只有作品、问题/执行动作、关闭与重开等 | **新活动的师生交付闭环未实现。** 保存、检查通过、收纳或关闭活动均不能代替提交；“本周最终交付”需明确阶段终点 |
| **WP13 开发复现与 Agent 评估**：新 PostgreSQL/对象基线、Phoenix、调试包、两成员独立复现 | 既有 `xj-dev` 有成员接入与业务复现；[当前工具说明](../development-tooling.md) 明确 Agent 调试包采集/Phoenix 导入仍待实现；[repro-data](../../tools/xj-dev/src/repro-data.mjs) 现有数据链仍处理 SQLite | **已有旧工具基础，新工作包未完整实现。** 不把已有直传或产品备份称作新版 Agent 复现完成；不是第 2 组本周补齐范围 |

本次按标题查询 GitHub 的 WP10/11/12/13 未返回对应工作包议题；这只是辅助信息，上述判断同时依据总览归属、正式产品入口和实际实现，不以“没搜到标题”单独推断未开发。

## 3. 第 2 组相关能力逐项展开

下表的“代码已接线”只确认当前正式链存在；真实模型、故障恢复和组合环境必须按“验证/差异”栏继续取证。

### 3.1 WP02：从课程入口到可靠作品

预期详见 [WP02 规范](../student-agent-implementation/specs/wp02-learning-space-and-reliable-workspace.md) 及 #149–153；UI 迁接见 [#159](https://github.com/paher-din/XunJie/issues/159)。

| 计划要求 | 实际实现和定位 | 验证 / 差异 |
| --- | --- | --- |
| 个人/学校身份隔离，只列获准课程和本人的活动 | [LearningApp](../../apps/web/src/product/LearningApp.tsx) 获取真实身份/课程；[learning-data](../../packages/learning-space/src/learning-data/index.ts) 的 `open/list` 核对主体与课程资格 | 代码已接线；本轮完成独立本机学校登录与课程进入，未重验多账号撤权矩阵 |
| 课程 → 任务 → 明确发布版本 → 新活动；原活动固定旧版 | `LearningApp.startCourse` 保存 requestId、查询原结果；[courses](../../packages/learning-space/src/courses/index.ts) 持有固定发布和 `prepare/confirm/authorize` | SF-02 已梳理入口与开始状态，合并后 Chrome 验证正常开始及原请求恢复。实际学校课程的开始和继续待人工复验 |
| 无课程也能学习，继续已有活动 | [ProductHome](../../apps/web/src/product/ProductHome.tsx)、`ProductAgent` 与相同活动入口；首页可打开已有活动 | 已接线。最近入口明确按“最近创建的进行中活动”选择；并未实现“最近编辑排序”，原计划无充分依据将其直接判成漏做 |
| 先看到目标、要求、材料和起始作品 | `LearningApp.CourseSections`、[CourseMaterials](../../apps/web/src/product/CourseMaterials.tsx)、`ActivityWorkspace` 使用固定课程内容 | SF-03 已提供按份预览、原文引用和旧引用定位。SF-07 已显示课程工具的可读名称与用途。待人工复验阅读、工具说明与下载落盘 |
| 作品创建/编辑/改名/删除，静默自动保存，无手动保存前置 | [ActivityWorkspace](../../apps/web/src/product/ActivityWorkspace.tsx) 消费 [可靠工作区](../../apps/web/src/reliable-workspace/README.md)；稳定 objectId 与类型化组件状态 | 编辑、返回、刷新恢复已实测；完整文件生命周期、多标签冲突/配额失败未在本轮复验 |
| 固定选文/语义引用；引用不自动发送；草稿和后续编辑分别保护 | [ActivityReferences](../../apps/web/src/product/ActivityReferences.tsx)、[draft](../../apps/web/src/reliable-workspace/draft.ts)、`TextReferenceSource`；ALU/PDF/产物均登记来源 | 波形引用进入草稿、草稿重开已实测；删除/改名后旧引用及全部来源组合仍待补验 |
| 点击固定问题/作品，依赖确认后派发；未知按原请求查询，取消不复活 | [ReliableActions](../../apps/web/src/reliable-workspace/actions.ts) 的 `create/createExecution/read/cancel/reconnect`；后端原意图与接收回执 | 正式接线存在；本轮发问到缺模型暂停，不等于真实回答通过；丢回包/取消竞争待补验 |
| 同浏览器返回、身份变化、离开保护、活动重开不损坏状态 | 聚合 `leave` 保护作品/草稿/动作；控制器按活动作用域存活 | 曾复现 SF-01，已授权修复，相关 30 项测试及 Chrome 原步骤两轮通过。不是整个 WP02 恢复矩阵通过 |

### 3.2 WP03 / WP04：ALU 的真实操作

预期：[编辑运行](../student-agent-implementation/specs/wp04-alu-edit-run.md)、[虚拟板与全量检查](../student-agent-implementation/specs/wp04-alu-board-check.md)、[波形与预测](../student-agent-implementation/specs/wp04-alu-learning.md)。

| 计划要求 | 实际实现和定位 | 验证 / 差异 |
| --- | --- | --- |
| 当前编辑作品经真实 Icarus/WASM 执行；编译失败不替换已启用作品 | [RuntimeTool](../../apps/web/src/product/RuntimeTool.tsx) 按固定版本挂载 ALU；[AluExperimentTool](../../apps/web/src/course-tools/alu/AluExperimentTool.tsx) 的 `run` 与成功后 activation 接公共执行 | 隔离学校已有真实运行、非法参数拒绝、编译错误行号和旧作品保留证据。SF-05 现提示“当前修改尚未启用”，失败后界面仍需在合并版本复验 |
| 虚拟板自由观察与 4096 输入行为检查，保留失败反例 | [AluBoard](../../apps/web/src/course-tools/alu/AluBoard.tsx)、[CheckReport](../../apps/web/src/course-tools/alu/CheckReport.tsx)、`check` 固定已启用作品 | 隔离学校已测 4096 组 / 16384 样本 / 4 轮通过。合并后提交改用统一通知，终态看报告。检查失败、未知/停止与 X/Z 等负对照待补验 |
| 当前编辑、已启用作品、旧观察和旧检查有明确归属 | 固定执行 basis、`enabledBasis`、请求身份及检查报告错配提示；失败不覆盖原结果 | 已接线且部分实测。不得用简化状态条掩盖“当前代码已变、显示的是旧报告” |
| 学生先记预测/理由，再运行比较，也允许直接观察；解释可修订 | [AluCases](../../apps/web/src/course-tools/alu/AluCases.tsx)、`compare` 捕获输入/预测和已启用作品 | 本轮单个预测、比较、解释保存与刷新已实测；多用例、先观察再预测等分支待补验 |
| 真 VCD 波形、时间/信号选择、固定范围引用和来源定位 | [AluWaveform](../../apps/web/src/course-tools/alu/AluWaveform.tsx)，`ActivityPage.locateTool` 定位结果/反例/波形 | 本轮 F/Cout 波形范围引用已实测；完整 X/Z、未完成结果和所有历史定位分支待补验 |
| 关闭/刷新/离线/重开恢复原输入与结果，不自动重跑 | 公共执行控制器、可靠组件状态和请求查询；[SF-01 回归](../../apps/web/src/product/ActivityReferences.test.tsx) | 本轮返回/刷新和修复后重开已测；真实远程断线、跨安装接管不是本次已测项 |

### 3.3 WP07：已有学习对话和学生求助

预期：[母票 #196](https://github.com/paher-din/XunJie/issues/196)、[#197](https://github.com/paher-din/XunJie/issues/197)、[#198](https://github.com/paher-din/XunJie/issues/198)、[#199](https://github.com/paher-din/XunJie/issues/199)、[#200](https://github.com/paher-din/XunJie/issues/200)、[#201](https://github.com/paher-din/XunJie/issues/201)、[#202](https://github.com/paher-din/XunJie/issues/202)；本次均查到关闭状态。

| 计划要求 | 实际实现和定位 | 验证 / 差异 |
| --- | --- | --- |
| 真模型问答、稳定会话、原请求快照、消息与内部上下文分离 | [ActivityConversation](../../apps/web/src/product/ActivityConversation.tsx) 消费公开对话投影；[Agent owner](../../packages/learning-space/src/teaching-agent/index.ts) 持有接收/事件/快照，Driver 经模型 owner 外发 | 代码已接线；本轮无模型，未收到真实回答。不能因为没跑通环境而写成“Agent 没实现” |
| 等待、停止、预算、服务重启恢复和未知状态保持原身份 | `driver.ts` 的固定步骤/命令/Wait、预算与权限复核；`index.ts` 的数据库 lease/generation；[AgentRunControls](../../apps/web/src/product/AgentControls.tsx) 接停止/继续 | 实现和既有交付记录存在；本轮未重验真实模型中断/竞争恢复 |
| Agent 明确提问，学生明确回答/跳过，原 Wait 只消费一次 | [student-questions](../../packages/learning-space/src/teaching-agent/student-questions.ts)、[StudentQuestionCard](../../apps/web/src/product/StudentQuestionCard.tsx)，`ActivityPage` 在问题等待时显示 IP | 已接线；实际回答/跳过待补验。这个 IP 不包含 WP11 的主动检测与三档设置 |
| 运行中默认 steering、可选 queue，修改/删除/提升/继续 | [AgentInteraction](../../apps/web/src/product/AgentInteraction.tsx)、`AgentInputRecord`、[input-controls](../../packages/learning-space/src/teaching-agent/input-controls.ts)、Driver 采纳逻辑 | 已接线；真实模型运行中补充/停止后的输入处理待补验 |
| 换模型、继续长会话，保留原历史和来源 | [run-controls](../../packages/learning-space/src/teaching-agent/run-controls.ts)、[segments](../../packages/learning-space/src/teaching-agent/segments.ts)、模型选择与继续入口 | 代码已接线；课程场景真实换路线未在本轮验证；模型配置 UI 归第 1 组 |
| ALU 求助读固定代码/材料/结果，调用获准验证并解释；学生自己修改 | [tools](../../packages/learning-space/src/teaching-agent/tools.ts)、[alu-tools](../../packages/learning-space/src/teaching-agent/alu-tools.ts)、[help-policy](../../packages/learning-space/src/teaching-agent/help-policy.ts)、浏览器执行接收器 | 真实 ALU 学生操作已测，真实 Agent 辅导未重验。#202 的历史四路径验收记录存在，不能抹去，也不能写成本轮通过 |

缺模型时，#197 要求保留活动和草稿并提示下一步。合并后的工作区已有模型选择入口。SF-06 先实测缺模型暂停、选择后继续原问题及真实回复，再判断可用性提示与设置返回路径是否需调整。是否在发送前提示仍待讨论。

### 3.4 WP08 / WP09：课程内扩展能力和生成内容

预期：[WP08 #214](https://github.com/paher-din/XunJie/issues/214) 的 #215–220、[WP09 #224](https://github.com/paher-din/XunJie/issues/224)；本次均查到关闭状态。

| 计划要求 | 实际实现和定位 | 验证 / 差异 |
| --- | --- | --- |
| AgentDefinition、能力/规则版本快照，按平台/课程发现工具 | [assembly](../../packages/learning-space/src/teaching-agent/assembly.ts)、[tool-discovery](../../packages/learning-space/src/teaching-agent/tool-discovery.ts) 的 `discover_tools/load_tools`、Driver 执行前复核 | 代码已接线；不是仅将所有工具写进提示词。本轮未用真实模型重验动态发现/失效 |
| 独立课程/个人 Skills，符合课程规则，保留实际读取版本 | [skills](../../packages/learning-space/src/teaching-agent/skills.ts)、[skill-runtime](../../packages/learning-space/src/teaching-agent/skill-runtime.ts)；`ActivityReferences` 读取目录并接入草稿选择 | 代码已接线；设置体验归第 1 组，课程选择/停用/历史版本待补验。Skill scripts 不自动获得执行权 |
| 上下文压缩有来源，原对话/工具/Wait 保留，换路线可继续 | [compaction](../../packages/learning-space/src/teaching-agent/compaction.ts)、`driver.prepareCompaction` 和共同换段入口 | 代码已接线；本轮真实长对话及失败恢复未验证 |
| 记忆读取、个人资料和课程材料检索，不伪造掌握画像 | [student-facts](../../packages/learning-space/src/teaching-agent/student-facts.ts) 记录明确表达及纠正；[personal-materials](../../packages/learning-space/src/learning-data/personal-materials.ts)、[material-search](../../packages/learning-space/src/learning-data/material-search.ts)；正式 `PersonalMaterials` | 已有偏好/事实与资料能力，不能称 WP11 学习画像完成；同名版本、移除后旧引用和跨课范围待补验 |
| PDF 按页阅读、页图/文本、页/区域固定引用及缺失说明 | [PdfMaterials](../../apps/web/src/product/PdfMaterials.tsx) 接资料 owner；[tools-pdf](../../packages/learning-space/src/teaching-agent/tools-pdf.ts) 由固定引用授权读取，模型图像能力由 WP06 判定 | 代码已接线；本轮未完成 PDF → 真模型回答的组合验收。外部课程 PDF 链接不等于原件已进入当前活动 |
| 生成页面/卡片渐进预览，校验后自动启用，失败保留旧页面 | `generate_teaching_artifact`、[ArtifactPreview](../../apps/web/src/teaching-artifacts/ArtifactCard.tsx) 无脚本静态预览、[useTeachingArtifacts](../../apps/web/src/teaching-artifacts/useTeachingArtifacts.ts) 校验/采用、[ArtifactView](../../apps/web/src/teaching-artifacts/ArtifactView.tsx) 正式交互 | 代码已接线；原对话和中心工具区均有入口。不是“只生成 HTML 字符串”，本轮真实生成待补验 |
| 普通控件只保存状态，明确点击才回应/实验；真实结果有来源 | `ArtifactView`、[受控执行桥](../../apps/web/src/teaching-artifacts/execution.ts)、`ArtifactExecutions` 复用原动作/执行 | 代码已接线；真实模型生成页 → 真 ALU 的组合未在本轮重验 |
| 未收纳也保存，收纳重开；兼容修订保留输入，不兼容另开实例 | `useTeachingArtifacts` 保护原操作身份；[teaching-artifacts.adopt](../../packages/learning-space/src/learning-data/teaching-artifacts.ts) 兼容映射/另建实例，状态沿 WP02 工作区 | 代码已接线；本轮未重验修订、输入竞争和恢复。既有 WP09 真实模型/跨机证据见其交付记录 |

## 4. “引导”和“最终交付”缺的具体是什么

| 总览中的目标 | 当前具备 | 尚未完整落地 | 本周边界 |
| --- | --- | --- | --- |
| WP11 连续引导与画像 | 活动/对话恢复、Agent 提问、等待提醒、明确偏好/事实记忆 | 仅提问/适时提醒/更多引导三档、暂停策略、规则检测和失效候选、提示反馈、证据驱动且可纠正的学科学习画像 | 既有求助和 IP 展示可以验收；不把新增主动引导系统塞进本周修复 |
| WP10 教师确认和发布 | 固定课程发布、开发导入、执行方案接口 | 教师面对正式产品完成组件创作、装配、预览、确认发布和复用同步的完整闭环 | 以已发布 ALU 课程检查学生端；缺教师产品不等于课程数据完全不存在 |
| WP12 师生最终交付 | 作品保存、实验记录、关闭重开，旧版曾有独立提交 UI | 新活动点击时固定交付、教师接收回执、教师审阅/反馈、关联修订和判断纠正 | 负责人需确认本周阶段终点。若要求真正教师收到，必须明确启动 WP12 范围；当前不能宣称全流程至教师交付通过 |

这里报告“未完整实现”，是回答整个开发计划的覆盖情况；不是请求立即实施这些后续包。

## 5. 已有范围内的 gap 与处理方案

以下保留首轮差异及修复原因，并更新当前状态。已落地项进入复验。其余行为调整先出方案，按讨论结论实施。

| 项目 | 原预期实现 / 体验 | 实际实现与 gap | 对应方案、边界与验收 |
| --- | --- | --- | --- |
| **SF-01 活动重开后等待**（已修复） | WP02/03/04：恢复原活动后可继续实际运行 | `activity` 对象变化曾让部分控制器重建，连带销毁仍在复用的队列/草稿；运行永久等待 | 已对齐控制器生命周期，保留当前授权复核。相关 30 项测试、类型检查、Chrome 两轮通过；保护已有改动 |
| **SF-07 课程工具提示过时**（已修正） | 总览要求后续 WP 在正式工作区完成真实接线、如实呈现能力 | 旧文案将已挂载工具也标为“尚未接入”。现显示课程声明中的名称与用途，内部编号折叠 | 转人工复验可读性。若需实时判断可用性，先出方案读取真实准备与授权状态 |
| **SF-05 实验状态说明冲突**（文案已改，状态待验） | WP04：准确区分未运行、编译失败、启用、检查终态及作品版本 | 旧的检查提交提示和“修改尚未运行”不易区分状态。现检查提交用通知，未启用修改有明确文案 | 按原请求及作品版本核对编译失败、检查终态、未知/停止和旧报告。根据复验结果拟状态映射方案 |
| **SF-03 材料阅读**（已落地） | WP02 正式材料阅读、固定引用，本周要求可用体验 | 旧版在左栏按原文展示长篇 Markdown。现中间区按份预览 Markdown/LaTeX，原文模式可选段并定位旧引用 | 已完成隔离 Chrome 引用定位回归。转人工验收下载、材料阅读、旧引用和回到作品编辑 |
| **SF-02 课程任务入口**（已落地） | WP02/#159：学生能找到任务、明确开始或继续活动 | 旧入口以发布日期为主，正常开始时也会短暂显示恢复提示。现强化任务要求与开始按钮，只有需要恢复时才显示原请求入口 | 合并后 Chrome 课程开始和恢复回归通过。继续人工验收原活动入口，涉及默认版本或排序的行为调整先出方案 |
| **SF-04 内部信息呈现**（已实测） | 正式工作区应支持编辑和理解结果，内部状态不妨碍主要任务 | 作品列表暴露只读 `components/alu.json`；对话过程呈现较多内部字段。内部文件不是可随意改写的作品 | 文件显示层与分类先拟最小方案，保留状态身份、备份和诊断可读性；不可直接删除状态。对话工具/过程输出 UI 等第 1 组，复用其交付组件 |
| **SF-06 求助可用性**（候选优化） | #197：缺模型保留活动/草稿并显示下一步 | 课程问题可在接收后因缺模型暂停。主线已在工作区加入模型选择，真实回答待补验 | 配置缺失、选模型后继续原请求及正常回答各验一次，依据结果讨论提示及返回路径。Agent 输出 UI 等第 1 组 |

另有**说明文档滞后**：总览的“后续推进”仍主要描述 WP09 规范发布，而当前 #224 已关闭且有实施记录；`learning-entry/README.md` 还保留旧 runtime 入口及“实验尚未接入”的表述。它们不是代码缺失证据。后续可做文档勘误，本次保留规划原文并在此记录实际状态。

### SF-03 材料阅读与引用方案（11 月 11 日确认）

学生应能读清课程发布时的内容，并引用当时选中的段落。首轮人工验收发现，工作区会在文件列表之外铺开所有文本材料，长文在窄栏占据数屏，Markdown 标记和公式也按原文显示。曾先把正文收进左栏折叠区，随后按用户确认改为中间预览。原文选择仍记录固定发布版本、材料校验值、字符范围和选段副本。直接把格式化后的显示文本交给现有引用组件，会让这些范围失去对应关系。

1. 建议从工作区文件列表按份打开，复用 PDF 与个人笔记所在的中间阅读区模式。默认预览标题、列表、表格、代码和 LaTeX 公式，同一份文件可切到「原文与引用」。点击已有引用时打开对应版本的原文，定位已保存的字符范围。仅按 `text/markdown` 或 `.md`、`.markdown` 文件名启用 Markdown，兼容以 `text/plain` 发布的 `learning.md`。
2. Markdown 优先复用现有标记解析和静态块样式。公式候选用随产品打包的 KaTeX，首批覆盖行内 `$…$` 和独立 `$$…$$`。解析时区分代码和转义符，错误公式回显原式，长表格和公式在各自区域内滚动。禁用公式的外部资源与 HTML 扩展，限制公式尺寸及宏展开，并保留可访问的数学标记。参见 [KaTeX 配置](https://katex.org/docs/options) 和 [不受信任输入的处理](https://katex.org/docs/security)。
3. 讨论时确认是否必须从预览直接选段。若需要，为渲染节点建立到固定原文的范围映射，校验所选范围后仍保存原文片段。公式只按完整表达式关联原文范围，跨节点或无法唯一定位的选区提示切换到原文。用同一份固定材料继续支持旧引用、草稿恢复与来源失效提示。

用户确认中间区预览、原文模式选段和历史材料引用定位，现已落地。Markdown 按材料 MIME 或文件名识别，公式和字体随本机产品打包。材料身份继续固定到发布版本与校验值。UTF-8 解码保留 BOM，与课程服务的原文偏移一致。旧客户端曾去掉 BOM 的位置仅在原摘录完全匹配时补偿。Chrome 用含 BOM、CRLF、行内公式、独立公式和表格的课程文档验证预览、引用保存、刷新后定位和切换空间后恢复。参见 [体验报告](student-flow-first-pass-2026-11-10.md)。

## 6. 验证情况与下一步

| 证据类型 | 已有证据 | 尚未完成 |
| --- | --- | --- |
| 本次计划/代码核对 | 13 包覆盖表；相关正式页面、owner、调用与恢复入口；8 个已交付包母票和本组主要子票的状态 | 不等于逐条重跑全部 issue 的故障矩阵；WP01/06/13 只核依赖和范围，不替代各组专项审查 |
| 本轮工程验证 | 首轮 SF-01 的 30 项测试通过。合入 `ab918bce` 后，前端类型检查与 37 项定向测试通过 | 全仓测试未执行 |
| 本轮桌面 Chrome | 隔离学校已测真实编译、4096 检查、预测、波形引用和重开运行。合并后课程入口、请求恢复、课程与代码引用 4 项回归通过 | 实际远程学校 + 本机 Agent/模型/执行、真模型答复与工具、PDF/Skill/生成内容组合、完整负对照和故障矩阵 |
| 既有包交付记录 | WP07/#202、WP08、WP09 留有真实模型、Chrome 和部署证据，按原候选和日期保留其效力 | 不冒称这次重跑，也不因当前环境未通而抹去历史证据 |
| 人工与教学 | 已有 AI 操作记录 | 你与同伴亲自走完整流程尚未完成；教学效果未评估 |

本机 `59712` 就绪，开发学校公网可达，学校账号登录后已看到两门课程，本机学校空间仍待设备配对。配对后核对目标 ALU 发布、访问资格、本机模型和执行上传连接，再继续真实学校验收。[学校接入说明](../../skills/xunjie-development/references/school-access.md)

接下来的工作顺序：

1. 完成真实学校配对和验收课程核对，人工复验已落地的课程入口、材料、旧引用和 ALU 重开。
2. 并行讨论第 5 节的 SF-04/05/06 和第 4 节交付终点，按 DESIGN.md 打磨人工验收发现的独立 UI。Agent 输出 UI 收到第 1 组组件和接口后再接入。
3. 验证“引用失败代码/结果 → Agent 查依据和获准验证 → 学生修改 → 再观察”，再补 Skills、PDF、生成卡片及输入修订/停止恢复组合。
4. 对批准的功能逐项实现、工程检查与 Chrome 复验；你和同伴再亲自体验。分别报告实现、操作验收和教学效果，不汇总成一个模糊的“全部完成”。

群同步文案统一使用 [本周工作安排第 10 节](student-flow-week-plan-2026-11-10.md#10-首批功能对齐讨论稿与群同步文案) 的待发送稿。
