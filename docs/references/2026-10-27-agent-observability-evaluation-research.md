# Agent 调试与评估平台选型：Langfuse、Phoenix、LangSmith、Braintrust

访问与核实日期：**2026-10-27**。对象：Robert 后续长期开发学生 Agent 所用的调试、prompt 迭代和评估系统。本文包含官方资料核查与随后完成的临时本机对照试用。已启动 Phoenix/Langfuse、检查界面并验证选定记录跨独立实例传递；未接入产品、调用模型或执行付费实验，具体范围见[本机试用报告](2026-10-27-observability-local-trial.md)。

## 结论与代价

决策状态：负责人在对照试用后已确认下述本机 Phoenix 与固定包协作方案，见 [L33](../student-agent-decisions.md#来源与状态)。平台选择确认与产品接入验收分别记录。

**综合功能、操作体验、开发协作与本机运行，工程推荐各开发者按需使用 Phoenix + SQLite，共享选定调试包、固定数据集和实验结果。** 本轮以相同合成案例实际检查两平台：调用树、Prompt diff、逐案例实验比较均可用；两边的 24 个调用步骤、6 条评分与两组实验均在独立实例重建并核对成功。Phoenix 的案例比较默认直接显示参考与实际输出，结构化 spans 导入路径较直接，且本机运行占用更小。因此选择依据不再只是服务数量。团队文件链路仍需包采集/导入适配，不能把试用脚本当作已交付功能。详见[本机试用](2026-10-27-observability-local-trial.md)与[接入设计](2026-10-27-agent-evaluation-integration.md)。

**Langfuse 同样能在本机运行，是合格候选。** 在同一台 M5 / 16 GiB 电脑的 4 vCPU / 6 GiB 临时环境内，Langfuse 六容器在本轮小数据阶段合计约 2.45–2.52 GiB；Phoenix 约 453–461 MiB。该结果不能推广为最低硬件或大负载承诺。Langfuse 的灵活视图、Prompt labels/关联 generations、人工评审队列等对持续集中运营有价值；本轮各人本机、异步选定案例移交尚未要求这些工作流。不能声称 Phoenix 整体质量更高，也不能以官方服务器推荐规格排除 Langfuse。[Langfuse SDK](https://langfuse.com/docs/observability/sdk/overview)、[实验比较](https://langfuse.com/docs/evaluation/experiments/compare-experiments)、[人工评审队列](https://langfuse.com/docs/evaluation/evaluation-methods/annotation-queues)。

Phoenix 已具备 TS tracing、prompts、datasets、experiments 与评估入口；本轮验证了核心 UI 与选定字段传递，同时发现 example 内部 ID 与 Prompt 模板接口的易误用边界，报告没有隐去。服务器许可是 ELv2，单实例单租户；当前内部本机开发可用，不能把 Arize AX 的企业能力算作免费 Phoenix，也不承诺整个平台无损同步。[TS SDK](https://arize.com/docs/phoenix/sdk-api-reference/typescript/overview)、[架构](https://arize.com/docs/phoenix/self-hosting/architecture)、[固定版本 ELv2](https://github.com/Arize-ai/phoenix/blob/arize-phoenix-v20.26.1/LICENSE)。

**LangSmith 与 Braintrust 在本轮免费、可持续自托管约束下排除，保留比较证据。** 前者 TS 调试和评估能力真实存在，但完整自托管是 Enterprise add-on；后者的标准 self-host 需 Enterprise，且只部署数据面。它们的 SDK 开源与限额试用不能满足本轮平台部署约束。[LangSmith self-host](https://docs.langchain.com/langsmith/self-hosted)、[Braintrust self-host](https://www.braintrust.dev/docs/admin/self-hosting)。

## 输入、证据范围与版本

- 按本轮明确输入：Node/TypeScript，直接使用 `openai` SDK 的 Chat/Responses 与 `anthropic` SDK 的 Messages，自有持久 RunDriver；产品支持本机、学校、混合部署。平台服务于 Robert 的开发和评估，不据此要求每名学生安装，也不决定产品部署拓扑。
- 术语：**Course Component = 课程装配单元；Agent Tool = 模型可调用操作**。下文 tool span 对应 Agent Tool 调用；Course Component 如需关联，作为上下文标识记录，不与工具调用混称。
- 旧会话证据限制：据本轮补充，已通过 `read_thread` 和 Chrome 打开“Langfuse用途介绍”，两条用户提问可读，但两条 assistant 回复均显示“无法加载此回复”，复制为空且来源面板无内容。**本文无法核实原推荐，不将其作为过去决定或当前结论的依据。**
- 已读根 `AGENTS.md`、README 和当前研究文档格式，未读取 `docs/archive/`。既有研究只用于理解上下文，不作为平台能力的一手证据。
- 平台事实来自官方文档及官方仓库；“建议”“推论”表示本报告判断。免费 self-host 边界使用专门的自托管文档、许可证和固定源码核对，不从 Cloud 页面反推。

本次通过官方 GitHub Releases API 核实以下非 prerelease 锚点；SDK release 不等于平台服务器 release，也不保证仓库内所有包版本相同：

| 对象 | 核实锚点 | 时间与用途 |
| --- | --- | --- |
| Langfuse server | [v4.70.1](https://github.com/langfuse/langfuse/releases/tag/v4.70.1) | 2026-10-26 发布；核对许可证与 Compose |
| Langfuse JS/TS SDK | [v6.0.2](https://github.com/langfuse/langfuse-js/releases/tag/v6.0.2) | 2026-10-22 发布；当前 SDK 文档为 v6，不沿用 v3 server/v4 SDK 教程 |
| Phoenix server | [arize-phoenix-v20.26.1](https://github.com/Arize-ai/phoenix/releases/tag/arize-phoenix-v20.26.1) | 2026-10-25 发布；核对许可证及同 tag 的 TS experiments/prompts 源码 |
| LangSmith SDK repository | [v0.14.9](https://github.com/langchain-ai/langsmith-sdk/releases/tag/v0.14.9) | 2026-10-15 发布；仅为 SDK 仓库锚点，不作为 JS npm 或 server 版本声明 |
| Braintrust JS SDK | [braintrust@3.40.0](https://github.com/braintrustdata/braintrust-sdk-javascript/releases/tag/braintrust%403.40.0) | 2026-10-26 发布；核对手动 span、跨进程上下文和 SDK 许可证 |

Langfuse 官方兼容矩阵明确：JS/TS SDK v6 要求 server ≥ v4.59.0；旧 v3 self-host 不能只升级 SDK 后假定兼容。本次 server 锚点满足该最低版本。[兼容矩阵](https://langfuse.com/docs/compatibility)。网页是访问日动态快照；标记 beta、planned 或未来日期的能力不进入本次稳定能力基线。

## Langfuse 与 Phoenix：逐项比较

| 维度 | Langfuse | Phoenix | 对本项目的判断 |
| --- | --- | --- | --- |
| TS 手动 tracing | `@langfuse/tracing`、`@langfuse/otel`，可建自定义 observation，基于 OTel；支持标准 OTel 接入。[SDK](https://langfuse.com/docs/observability/sdk/overview) | `@arizeai/phoenix-otel` 与 OpenInference helpers；也可直接用 OTel API 建 span。[helpers](https://arize.com/docs/phoenix/tracing/how-to-tracing/setup-tracing/instrument) | 两者均能包住自有 RunDriver 和协议 adapter；无需新 Agent 框架 |
| Run/Step/Tool 表达 | 自定义 span、generation 等 observation；外部 ID 可映射为确定性 trace ID。[关联 ID](https://langfuse.com/docs/observability/features/trace-ids-and-distributed-tracing) | OpenInference 为 agent、chain、tool、LLM 等提供语义及 helpers。[TS SDK](https://arize.com/docs/phoenix/sdk-api-reference/typescript/overview) | 持久领域对象与 trace/span 之间仍须自己保存映射，不能只记录模型请求 |
| 跨进程与异步 | 可显式传 parent span context，并进行 distributed tracing。[说明](https://langfuse.com/docs/observability/features/trace-ids-and-distributed-tracing) | 依托 OTel context；应用须在传输边界 inject/extract。[Phoenix helpers](https://arize.com/docs/phoenix/tracing/how-to-tracing/setup-tracing/instrument)、[OTel JS propagation](https://opentelemetry.io/docs/languages/js/propagation/) | `AsyncLocalStorage` 不替代队列载荷和恢复记录中的上下文 |
| Prompt 版本与管理 | 自动版本 ID、可移动 labels、按版本或 label 获取；labels 可表示 staging/production。[版本控制](https://langfuse.com/docs/prompt-management/features/prompt-version-control) | Prompt Hub/Playground；TS 可按 name/tag/versionId 获取，管理 tags，并适配 `openai`/`anthropic`。[prompts](https://arize.com/docs/phoenix/sdk-api-reference/typescript/packages/phoenix-client/prompts) | 两者足够，不因 Phoenix 是 Python 服务就排除；三协议原生历史仍由项目保存 |
| Datasets/experiments | TS runner 接本地或平台 dataset，自有 task、item/run evaluator、并发及结果比较。[SDK experiments](https://langfuse.com/docs/evaluation/experiments/experiments-via-sdk) | TS `runExperiment` 接 task/evaluators；支持记录实验与后续评估。[文档](https://arize.com/docs/phoenix/sdk-api-reference/typescript/packages/phoenix-client/experiments)、[固定源码](https://github.com/Arize-ai/phoenix/blob/arize-phoenix-v20.26.1/js/packages/phoenix-client/src/experiments/runExperiment.ts) | 用 task 调自有完整运行入口；prompt playground 的单次调用不等于完整 Agent 验收 |
| 规则、LLM judge | 可由应用代码产 score；UI 有 code evaluator 和 LLM judge。[评估入口](https://langfuse.com/docs/evaluation/overview) | 支持确定性代码和 LLM judge，既有客户端 SDK，也有 UI server-side dataset evals。[评估说明](https://arize.com/docs/phoenix/evaluation/llm-evals) | 首选本地/CI 的规则评分和现有 SDK judge adapter，不要求平台接管模型路由 |
| 人工评分 | UI scores、annotation queues、反馈进入评分工作流。[评估说明](https://langfuse.com/docs/evaluation/overview) | UI 支持分类、连续、自由文本 annotation，可附理由并查看不同评审者。[UI annotation](https://arize.com/docs/phoenix/tracing/how-to-tracing/feedback-and-annotations/annotating-in-the-ui) | 均能支持 Robert 审核失败案例；不要据此宣称两者队列分派、权限完全等价 |
| 数据取回 | UI CSV/JSON、SDK/API，另有 blob export 路径。[导出](https://langfuse.com/docs/api-and-data-platform/features/export-from-ui) | 可取 spans 及其 annotations；TS 有 REST client。[导出](https://arize.com/docs/phoenix/tracing/how-to-tracing/importing-and-exporting-traces/exporting-annotated-spans)、[TS](https://arize.com/docs/phoenix/sdk-api-reference/typescript/overview) | 都可降低数据锁定，但无法自动迁移 UI、评分定义及 prompt 发布语义 |

源码交叉核实：Phoenix 固定 server tag 的 `runExperiment.ts` 实际暴露 task/evaluators 与 dataset version 关联，`createPrompt.ts` 实现创建/追加 prompt version，并含 OpenAI、Anthropic 等输入定义。因此 TS experiments 与 prompts 不是仅凭宣传推测。[runExperiment.ts](https://github.com/Arize-ai/phoenix/blob/arize-phoenix-v20.26.1/js/packages/phoenix-client/src/experiments/runExperiment.ts)、[createPrompt.ts](https://github.com/Arize-ai/phoenix/blob/arize-phoenix-v20.26.1/js/packages/phoenix-client/src/prompts/createPrompt.ts)。精确 helper 名称、npm 包版本及 ESM 初始化行为仍需接入时锁版本验证；本文不提供未经编译的接入代码。

### 自托管完整性、依赖与收费边界

**Langfuse OSS 可运行核心平台，但“核心完整”不等于所有 Cloud/EE 能力免费，也不等于只起一个容器。** 专门的 self-host 定价页明确核心 observability、evaluation、prompt management、datasets 和 API 属于免费范围；源码许可证将 `ee/` 等目录明确分开。[self-host 范围](https://langfuse.com/pricing-self-host)、[v4.70.1 LICENSE](https://github.com/langfuse/langfuse/blob/v4.70.1/LICENSE)。

- 常规栈是 web + worker、PostgreSQL、ClickHouse、Redis/Valkey、S3-compatible/blob storage；固定版本 Compose 实际含这些服务，使用 MinIO 提供对象存储。[架构](https://langfuse.com/self-hosting)、[v4.70.1 Compose](https://github.com/langfuse/langfuse/blob/v4.70.1/docker-compose.yml)。
- 官方 VM 起步建议至少 **4 cores / 16 GiB RAM**，存储示例 100 GiB；这是官方部署建议，不是本次实测最低要求或学校容量承诺。Compose 不自带 HA、扩缩容和备份保障。[部署指南](https://langfuse.com/self-hosting/deployment/docker-compose)。
- 项目级 RBAC roles、protected prompt labels、retention policies、audit logs、server-side masking 等需要 EE key。Langfuse OSS 的免费组织角色可支持同一开发项目内的成员查看和评分，但不能因定价页写有 SSO/RBAC 就推断所有项目隔离免费；这些是候选功能边界，不改变本轮推荐本机 Phoenix 的结论。[EE 清单](https://langfuse.com/self-hosting/license-key)、[组织角色](https://langfuse.com/docs/administration/rbac)。
- **UI 代码评分需配置 dispatcher**：可以在现有 worker 中使用 `insecure-local` 运行可信 TypeScript/JavaScript；它不提供不可信代码沙箱，且不支持 Python。AWS Lambda 是另一种可选后端，并非本机运行的必需项。最直接的起步方式是在自己的 TS/CI 程序跑规则后写 score，避免把“免费 code evaluator 功能”误解成默认 Compose 已具备生产代码执行环境。[self-host code evaluators](https://langfuse.com/self-hosting/configuration/code-evaluators)。
- LLM judge、playground 等调用模型的功能另需可用模型连接及相应推理资源/费用；免费平台许可不包含模型推理成本。[架构中的 LLM API/Gateway](https://langfuse.com/self-hosting)。

**Phoenix 的免费 self-host 范围由其自身文档直接确认**：tracing、evals、datasets、experiments、prompt management，无 feature gate；可完全 air-gap。这里的全功能仅指 Phoenix，不包括 Arize AX；外接 judge/model 服务是否出网取决于实际配置。[self-host 说明](https://arize.com/docs/phoenix/self-hosting)。

- UI/collector/SQL backend 可从一个应用配 SQLite 启动，本机数据目录需持久化；生产多人推荐 PostgreSQL，当前文档最低 PostgreSQL 14。常规架构没有 Langfuse 那组必需的 ClickHouse/Redis/S3 服务。[架构](https://arize.com/docs/phoenix/self-hosting/architecture)。本次没有查到可直接对照 Langfuse 4 cores/16 GiB 的统一官方硬件下限，不编造内存数字，也不把单进程起步等同于无限吞吐。
- 同一实例是一个 tenant；多团队隔离可分实例。架构页仍把细粒度 resource tags 权限标作 future，不因“计划在 2026”就算作 2026-10-27 已稳定上线。AX 的 organizations/spaces、多租户与专有 OLAP 不纳入免费 Phoenix。[tenancy 与 roadmap 原文](https://arize.com/docs/phoenix/self-hosting/architecture)。
- 固定版本 server 许可是 **ELv2，不是 MIT/Apache**：可使用和修改，但限制向第三方提供能访问软件实质功能集的 hosted/managed service。Robert 内部开发调试与把 Phoenix UI/能力作为对外产品服务，是不同使用方式。当前用途无需因此排除 Phoenix；未来若直接向学校客户提供其平台能力，应按实际交付方式重新核对许可，不能笼统写成“不可商用”或“完全无限制”。[固定 LICENSE](https://github.com/Arize-ai/phoenix/blob/arize-phoenix-v20.26.1/LICENSE)。

### Cloud 与免费 self-host 分开判断

| 平台 | Cloud/托管版本 | 免费或自有环境的确切边界 |
| --- | --- | --- |
| Langfuse | 当日 Cloud Hobby 标明 50k units/月、30 天 data access、2 users；不作为本团队长期共享方案，付费 Cloud 已被负责人排除。[Cloud 定价](https://langfuse.com/pricing) | OSS 核心与用户数无该 Cloud 配额，自担基础设施；免费 OSS 核心可在本机使用；本轮也已实测，其取舍由功能、协作和运行成本共同决定。[self-host 定价](https://langfuse.com/pricing-self-host)、[EE](https://langfuse.com/self-hosting/license-key) |
| Phoenix | 本次旧 `phoenix-cloud` 官方入口重定向到 self-host，未据此确认一个当前可购买的 Phoenix Cloud 套餐；不引用旧云端教程承诺免费托管。[实际入口](https://arize.com/docs/phoenix/phoenix-cloud) | 以 Phoenix self-host 核心为本次候选；Arize AX 是另一个产品，不把 AX 云端或企业能力搬进 Phoenix。[架构](https://arize.com/docs/phoenix/self-hosting/architecture) |
| LangSmith | SaaS 产品与 Enterprise self-host 分开；本次不将试用授权算作免费可持续部署 | self-host 需 Enterprise add-on，SDK 开源不能证明服务器免费。[官方 self-host](https://docs.langchain.com/langsmith/self-hosted) |
| Braintrust | SaaS、BYOC、self-host 是不同运维责任模式。[部署选项](https://www.braintrust.dev/docs/admin/deployment) | 标准 self-host 需 Enterprise，且托管控制面继续存在，不是免费完整离线平台。[self-host](https://www.braintrust.dev/docs/admin/self-hosting) |

Cloud 的 unit 统计 trace、observation（span、event、generation）和 score 等数据点，不能把 50k units 理解为 50k 次 Agent 对话；例如假设一次运行产生 20 个计费数据点，50k 只相当于约 2,500 次运行，这只是算例，尚未测得 XunJie 实际每次用量。30 天 data access 是可查看的历史窗口，不等同于到期删除。[官方计费说明](https://github.com/langfuse/langfuse-docs/blob/main/md-override/pricing.md)。OSS 不使用这套 Cloud 月度配额，容量受自有算力、存储及维护条件约束。

项目[2026-10-23 服务器核查](2026-10-23-development-server-assessment.md)记录共享服务器为 2 vCPU/2 GiB，并承担现有应用；这不是本轮实时资源检查，也不足以承诺承载官方建议 4 cores/16 GiB 的 Langfuse 栈。负责人明确没有这类大服务器，但团队开发电脑性能较好，因此不增设共享观测服务器；本机两平台均已临时试用，按综合结果推荐 Phoenix 与选定包共享。本轮没有扩容、采购或永久部署平台。免费版选择不能等同于基础设施和模型推理零成本，亦不需要为排除付费版本而另建采集平台。

## 接入自有持久 RunDriver 的建议

负责人澄清目的为开源发布的数据安全与便捷协作，并要求基于功能、质量、协作与本机能力综合选型。以下 span 映射在**同仓可选观测模块**集中完成，工程建议接入本机 Phoenix，产品尚未实现；评估程序和合成案例可随代码公开，实际平台数据与秘密配置在仓库外。观测默认关闭，启用后默认只到本机，分享选定包是另一个动作。Dify/Open WebUI 的源码参照、具体共享步骤与开销边界见[接入设计](2026-10-27-agent-evaluation-integration.md)。

以下为项目设计建议；平台提供记录能力，不能自动知道本项目领域对象的含义。手动 OTel span 足以实现，不需要更换直接 SDK，不要求模型请求走平台 gateway。模型自动 instrumentation 可后续补充，但不能替代 run/step/工具执行边界。[Langfuse 自定义 tracing](https://langfuse.com/docs/observability/sdk/overview)、[Phoenix helpers](https://arize.com/docs/phoenix/tracing/how-to-tracing/setup-tracing/instrument)。

| 项目事实 | 建议观测投影 | 要自己保留的标识/含义 |
| --- | --- | --- |
| 一次 Run 的一次活跃推进 | root agent/run span 或一个 trace segment | `run_id`、`execution_attempt_id`、代码版本、停止原因；Run 的持久身份不依赖平台 ID |
| Step | root 下 chain/span | `step_id`、阶段、状态、开始结束时间；模型重试另用 attempt 区分 |
| Chat/Responses/Messages 请求 | generation/LLM span | route、protocol、provider/model、request/response ID、usage、首 token 与总耗时；原生请求/响应引用由产品保存 |
| Agent Tool 意图和执行 | tool span，必要时拆 dispatch 与 executor receipt span | `tool_call_id`、稳定 `command_id`、`job_id`、结果/未知效果/失败；span 成功不等于副作用已可靠提交 |
| Course Component 上下文 | metadata/attribute | `course_component_id`、版本和课程上下文；不是 tool span 类型 |
| 等待、人工恢复、重启 | 等待事件/短 span + 后续新 segment | 持久 `wait_id`、前序 trace/span context、`resume_of`；是否恢复由 RunDriver 决定 |

**跨进程要传播上下文，跨重启要持久保存关联。** 同一进程的 async context 可自动维护父子关系；HTTP、队列、worker、CLI/子进程必须在实际 transport 中传 `traceparent`/`tracestate` 等 carrier，在消费者 extract 后创建 span。仅将 `run_id` 写进日志只能检索相关记录，不能自动恢复 trace 树。[OTel JS propagation](https://opentelemetry.io/docs/languages/js/propagation/)、[Langfuse distributed tracing](https://langfuse.com/docs/observability/features/trace-ids-and-distributed-tracing)。

对持久等待，建议不要让一个内存 root span 连续开几天：每次活跃推进形成有界 segment；通过自有 `run_id`、session 和因果字段关联，必要时加 OTel span link。单一长 trace 也可以作为备选，但平台对迟到 span、很长时间窗、link 的 UI 展示与保留期行为本次未测，不能承诺恢复后自动形成理想瀑布图。无论哪种策略，都不能复用旧 span ID 伪装成一次没有重启的调用。

还需处理 exporter flush/shutdown、重复导出和可观测服务不可用：建议采用有界缓存/可选 outbox，明确丢失策略；**遥测故障不决定产品 Run 的提交、预算扣费、命令去重或恢复。** 这部分是项目可靠性设计，而非任一平台 tracing SDK 自带的持久执行保证。

三协议直接 SDK 的兼容边界要单独保留：手动 LLM span 可覆盖任何协议，但“某平台有 OpenAI/Anthropic integration”并不能证明当前 SDK 版本所有 Responses 事件、streaming tool-call 片段、reasoning/signature 和自定义端点都被无损捕获。本次未运行这些兼容实验；未来应对照原生持久记录核验，不能用 tracing 投影替换原件。

Prompt 建议在 Run 开始时解析成**确切版本 + 渲染内容摘要/引用**，恢复时沿用该快照。Langfuse label 与 Phoenix tag 都可移动；只有保存 `production` 字符串不足以复现实验。prompt registry 用于管理与分发，运行恢复不能依赖“现在平台上的最新版”。[Langfuse versions/labels](https://langfuse.com/docs/prompt-management/features/prompt-version-control)、[Phoenix selectors/tags](https://arize.com/docs/phoenix/sdk-api-reference/typescript/packages/phoenix-client/prompts)。

## 评估工作流：要测整个 Agent，不能只比最终文案

建议在同仓开发评估工具中保留可导出的合成基准与案例清单作为可移植底本，平台 dataset 作为各本机的工作副本；每条 case 保存输入、初始教学/运行状态、工具回执 fixtures、允许/禁止行为、预期状态和证据。每次 experiment 固定代码 commit、dataset revision、prompt version、模型 route/参数、工具与评分器版本，保留失败项和成本，不只保存平均分。

1. **规则评分先行。** 核验 Run 状态转换、取消/预算停止、工具参数和命令去重、重启后未知效果处理、schema、产物或执行器回执；这些规则由自有测试/评估程序实现，将结果写入平台。Trace 可辅助定位，不是判定事实的唯一输入。
2. **LLM judge 处理难以硬编码的质量项。** 如提示是否适切、反馈是否具体、答案是否有证据；使用独立 judge adapter，固定 rubric/model/prompt，记录 judge 输出与不确定情况。平台 SDK 支持的 judge 可复用，但不必为运行评估改变生产协议层。
3. **人工评分校准 judge。** Robert 对分层失败案例盲评，保留评分者、理由与 rubric 版本，检查分歧；支持多个维度，不把点赞或单一 correctness 分数视为充分结论。两平台均有自动与人工结果入口。[Langfuse evaluation](https://langfuse.com/docs/evaluation/overview)、[Phoenix evaluation](https://arize.com/docs/phoenix/evaluation/llm-evals)、[Phoenix annotations](https://arize.com/docs/phoenix/tracing/how-to-tracing/feedback-and-annotations/annotating-in-the-ui)。

Langfuse SDK experiment 和 Phoenix `runExperiment` 都允许任务是自有应用逻辑，因此可以调用完整 RunDriver，而无需让平台执行学生 Agent loop。[Langfuse runner](https://langfuse.com/docs/evaluation/experiments/experiments-via-sdk)、[Phoenix runner 源码](https://github.com/Arize-ai/phoenix/blob/arize-phoenix-v20.26.1/js/packages/phoenix-client/src/experiments/runExperiment.ts)。涉及真实副作用的 benchmark 需由项目提供隔离执行环境/回执 fixtures；平台提供的 experiment 并不自动生成这些领域条件。

**工程质量、运行事实和教学成效必须分别报告。** 工程评估说明 Agent 在测试条件下是否可靠；产品持久事实说明学生做了什么、哪份作品、哪个命令及回执有效；教学成效还需学生独立完成、迁移、修订和长期学习证据。耗时、token、工具成功率、LLM judge 高分都不能直接证明学生学会了。这是本项目的验收边界，不是平台宣传能力。

## LangSmith、Braintrust 的针对性比较

| 问题 | LangSmith | Braintrust |
| --- | --- | --- |
| 是否必须使用其框架或托管 loop | 否。TS `traceable` 包普通函数，OTel 可接 non-LangChain 应用；不能把 LangChain 优势误写成强制依赖。[TS 示例](https://docs.langchain.com/langsmith/evaluate-llm-application)、[OTel](https://docs.langchain.com/langsmith/trace-with-opentelemetry) | 否。TS SDK 有 `traced`/`startSpan`，prompt 可 load/build 后交自有客户端调用；gateway/remote invocation 是选项。[固定 logger 源码](https://github.com/braintrustdata/braintrust-sdk-javascript/blob/153117ce3042d596a9529872fbf9579f4f687c84/js/src/logger.ts)、[prompt 调用方式](https://www.braintrust.dev/docs/evaluate/prompts/use-in-code) |
| 异步/跨服务关联 | 支持 OTel 与上下文传播，需遵循接入属性和 workspace 路由。[OTel 文档](https://docs.langchain.com/langsmith/trace-with-opentelemetry) | span export/parent 及 OTel bridge 有明确 TS 示例；兼容模式、ID 格式和版本须对齐。[link spans](https://www.braintrust.dev/docs/integrations/sdk-integrations/opentelemetry/link-spans) |
| Prompt、数据和评分 | TS `evaluate()`、datasets、代码 evaluator、LLM evaluator、人工 inline/queue；prompt hub 可管理版本。TS 拉取 prompt 的文档路径引入 LangChain 包，直接 SDK 项目需额外适配。[evaluate](https://docs.langchain.com/langsmith/evaluate-llm-application)、[人工评分](https://docs.langchain.com/langsmith/annotate-traces-inline)、[prompt API](https://docs.langchain.com/langsmith/manage-prompts-programmatically) | 数据集/experiment、custom code、LLM judge、人工 review、prompt 版本/环境均具备。[evaluation](https://www.braintrust.dev/docs/evaluate)、[annotation](https://www.braintrust.dev/docs/annotate)、[versions](https://www.braintrust.dev/docs/evaluate/prompts/versions) |
| Self-host 完整性与资源 | Enterprise add-on；基础安装含 observability/evaluation/prompt engineering，不强制打开 Deployment。常规栈含多应用服务、ClickHouse、PostgreSQL、Redis/Valkey，生产主路径 Kubernetes；不能将 Agent Server 的单独部署误认为完整 LangSmith 免费自托管。[self-host](https://docs.langchain.com/langsmith/self-hosted) | Enterprise 标准 self-host 为 API/PostgreSQL/Redis/object storage/Brainstore 数据面；UI、auth、组织及部分 metadata 在托管控制面。AWS ECS/EC2 或 GCP/Azure Kubernetes 参考部署，不是一个可完整离线运行的免费本机平台。[self-host](https://www.braintrust.dev/docs/admin/self-hosting) |
| 许可与付费判断 | SDK 是 MIT；这不是服务器许可。[固定 SDK LICENSE](https://github.com/langchain-ai/langsmith-sdk/blob/v0.14.9/LICENSE)。免费试用不能消除 Enterprise 条件 | SDK 是 Apache-2.0；不代表后端/控制面开源免费。[固定 SDK LICENSE](https://github.com/braintrustdata/braintrust-sdk-javascript/blob/153117ce3042d596a9529872fbf9579f4f687c84/LICENSE) |
| 导出与锁定 | SDK `listRuns`/API 可取原始 run；支持批量 export 路径。OTel 不能迁移其反馈配置与 prompt hub 对象语义。[查询与导出](https://docs.langchain.com/langsmith/export-traces) | UI/API 导出，SQL/BTQL 可取数据；异步大查询属 Enterprise。专用 query、experiment、scorer、prompt 发布语义仍需迁移。[export](https://www.braintrust.dev/docs/annotate/export) |

LangSmith 的 Cloud 与 self-host 也并非逐项相同：当日 OTel 文档区分 agent-based 与 project-based workspace，并明确 self-host 不支持前者的 agent addressing。它接纳标准 OTel，并不能据此推断 Cloud 新对象和路由全部已进入 self-host。[差异说明](https://docs.langchain.com/langsmith/trace-with-opentelemetry)。本文不以 beta gateway、可选 Engine 或其他运行托管功能为选择理由。

Braintrust 的 self-host 文档还区分数据类别：trace/dataset/experiment 内容在数据面，但组织级 provider secrets、项目/experiment 名称、登录及组织信息等可在控制面。故“敏感内容留在自己的云”不等于“没有任何外部依赖或元数据出域”。这使它适合接受商业混合交付的团队，不能作为本轮完整本机自托管的等价替代。[官方数据位置表](https://www.braintrust.dev/docs/admin/self-hosting)。

## 导出、供应商绑定与下一步判断

**OTel 解决观测传输与一部分语义互通，不解决整个平台可移植性。** 建议保留自有 run/step/command ID、原生模型记录引用、prompt 渲染快照、dataset 底本与评分器代码；平台返回的 trace/span/experiment ID 保存为外部映射。迁移时分别导出 spans、scores/annotations、datasets、prompt 版本和附件，而不是只导出最终回复 CSV。[Langfuse export](https://langfuse.com/docs/api-and-data-platform/features/export-from-ui)、[Phoenix annotated spans](https://arize.com/docs/phoenix/tracing/how-to-tracing/importing-and-exporting-traces/exporting-annotated-spans)。

本轮选择与切换条件：

1. **Phoenix：当前工程推荐。** 同仓可选观测模块与评估程序接本机服务；案例比较、版本 diff 和小型独立实例交接已实测，真实数据与秘密配置留在 Git 外。项目仍需实现可交付的采集/导入与文件包协作。
2. **Langfuse：功能合格的备选。** 本轮同机运行与记录重建均通过；未来若集中持续观测、人工评审分派或 Prompt 发布运营成为实际需求，可重新评估其收益。没有这类新增需求时不同时维护两套必备平台。
3. **LangSmith、Braintrust：当前排除。** 其标准 self-host 的商业条件不符合“不要付费版”，不把试用或免费 Cloud 配额当作长期前提。

产品接入仍需单独验证三协议流式内容、队列/跨进程关联、持久等待后的恢复、评分器版本与人工分歧、断连行为及必要附件。本轮合成案例的数据与 UI 验证，不替代这些工程或真实模型验收。

## 未知与未验证项

- 已完成 Phoenix/Langfuse 在一台 macOS M5 上的临时运行、内存样本、浏览器核心操作和小型独立实例传递；未运行 LangSmith/Braintrust。未测 Windows、高并发、长 trace、迟到 span、完整备份恢复或大批量导出。Phoenix 重复 span 拒绝已测；Langfuse 重复摄入/后台合并未测。没有产品工程验收或教学效果验证。
- 未核实当前三协议 SDK 的全部自动 instrumentation 覆盖；手动 span 可接入与自动捕获无损是两件事。
- 未逐项审计四个平台当前 Cloud 套餐的全部 entitlement，也未采购 Enterprise；报告仅使用决定选择的已核实门槛，不承诺免费 Cloud 与免费 self-host 同功能。
- Phoenix 细粒度资源权限仍按架构文档的 future 状态处理；PXI beta 等不作为已稳定收益。网页与 npm 包可能不同步，接入时必须锁定 server/SDK 组合。
- 报告中的源码锚点用于核对具体接口、依赖与许可，不等于已审查整个平台实现。旧聊天 assistant 推荐仍不可读，未恢复、引用或补造其内容。

本次形成选型、临时试用证据与接入设计；正式接入仍属后续开发任务。本轮方案采用免费本机服务，付费版已被负责人排除。


## 本机运行与按需共享能力核查

核查日期：**2026-10-27**。本节独立评估 Phoenix；遵照最新约束，只考虑免费、本机运行、选择性传递内容。本节记录资料核查与接口边界；后续已完成[本机试用](2026-10-27-observability-local-trial.md)，小型合成案例的传递结果以该报告为准。没有访问真实数据或调用模型。

**判断：Phoenix 适合作为各开发者本机的可选调试 UI。它提供足以编写选择性导入工具的 API，但没有在本轮找到“导出一个包，另一实例完整恢复所有 UI 对象”的官方 roundtrip 契约。协作的可靠底本应由项目保存标准调试包，再将可映射部分导入同事本机 Phoenix。不能承诺平台内置实例同步，也不应因此要求一个共享服务器。** 官方架构直接列出 per-developer 实例，SQLite 对应 local/single-user。[架构](https://arize.com/docs/phoenix/self-hosting/architecture)。

证据锚点：已核对 [server tag arize-phoenix-v20.26.1](https://github.com/Arize-ai/phoenix/tree/arize-phoenix-v20.26.1) 中 TS `logSpans`、REST span 路由及插入逻辑；更详细字段、导出器与 OpenAPI 使用当日 main 的固定 commit [14c193cfad309198168e3c2db522db0ec770a557](https://github.com/Arize-ai/phoenix/commit/14c193cfad309198168e3c2db522db0ec770a557)（committer 时间 2026-10-27 04:35:43 UTC）。main 细节不自动代表任意已安装 SDK；接入时需锁定实际发布包与 server 组合。本节源码链接均固定到上述 tag 或 commit，网页为访问日快照。

### 本机、TypeScript 与断网条件

- **单机依赖可从 Phoenix 服务 + SQLite 起步**，无需为此运行 PostgreSQL、Redis、ClickHouse。官方支持 CLI 或 Docker，默认 SQLite；应显式持久化 `PHOENIX_WORKING_DIR` 或设置 `PHOENIX_SQL_DATABASE_URL=sqlite:///...`，不要依赖临时目录或容器可写层。配置页对默认目录有临时目录表述，架构页写 `~/.phoenix/`，因此不把某个默认路径当交接保证。[架构](https://arize.com/docs/phoenix/self-hosting/architecture)、[配置](https://arize.com/docs/phoenix/self-hosting/configuration)。
- **TS 接入是正式支持路径**：`@arizeai/phoenix-otel` 的 `register({ projectName, url: "http://localhost:6006" })` 配置 OTel provider/exporter；可以手动建 span，不必替换自有 Agent loop。退出前执行 provider flush/shutdown。也可直接发送标准 **OTLP Protobuf** 到 `http://localhost:6006/v1/traces`，或 gRPC 4317。仅发普通 OTel span 不保证 LLM 专用 UI 字段齐全，需保留 OpenInference attributes。[固定 TS README](https://github.com/Arize-ai/phoenix/blob/arize-phoenix-v20.26.1/js/packages/phoenix-otel/README.md)、[接收端协议与端口](https://arize.com/docs/phoenix/self-hosting/configuration)。
- **断公网可浏览、查询、收集本机 traces，并运行不依赖外部服务的评分**，前提是 Python/镜像、JS 包和运行资产已经取得。设 `PHOENIX_ALLOW_EXTERNAL_RESOURCES=false`，可同时显式设 `PHOENIX_TELEMETRY_ENABLED=false`。前者关闭自发的字体、遥测、更新检查、PXI 文档/web/GitHub 请求和 WASM runtime 下载；WASM 沙箱若需要离线运行，另备本地 runtime 并设 `PHOENIX_WASM_BINARY_PATH`。外部模型、OAuth/LDAP、远程 DB、hosted sandbox 不因该开关变成本地；LLM judge/Playground 只有使用本地可达模型才可能断公网运行。**离线查看不等于模型评估免费离线，也不等于 collector 停机后 SDK 有持久补传队列。** 本轮没有验证后者。[官方 Air-Gapped Deployments](https://arize.com/docs/phoenix/self-hosting/security/network-security#air-gapped-deployments)、[固定隐私配置说明](https://github.com/Arize-ai/phoenix/blob/14c193cfad309198168e3c2db522db0ec770a557/docs/phoenix/self-hosting/security/privacy.mdx)。

### 对象级导出、导入与可恢复范围

以下 API 路径来自 [固定 OpenAPI](https://github.com/Arize-ai/phoenix/blob/14c193cfad309198168e3c2db522db0ec770a557/schemas/openapi.json)。REST/SDK 是迁移积木；表内广义能力为接口与源码判断。后续只验证了小型合成案例，不能把成功范围推广到表中全部对象和字段。

| 对象 | 可用出口与入口 | 能承诺的范围及缺口 |
| --- | --- | --- |
| Trace 下的 spans | TS `getSpans({project, traceIds, cursor})`；REST `GET /v1/projects/{project_identifier}/spans` 分页。另一实例用 TS `logSpans` 或同路径 `POST`，body `{data: spans}`。Python 对应 `client.spans.get_spans` / `log_spans` | 接口覆盖 `context.trace_id/span_id`、`parent_id`、name/kind、起止时间、status/message、attributes、events。必须导出选定 trace 的**所有页及所有相关 spans**，不能只取 root 或时间窗口内一部分。不要使用 trace 列表的轻量 span 摘要代替完整 spans。Phoenix `id` 是本实例 GlobalID，插入时被忽略并重建。[TS getSpans](https://github.com/Arize-ai/phoenix/blob/14c193cfad309198168e3c2db522db0ec770a557/js/packages/phoenix-client/src/spans/getSpans.ts)、[REST schema 与插入转换](https://github.com/Arize-ai/phoenix/blob/arize-phoenix-v20.26.1/src/phoenix/server/api/routers/v1/spans.py#L1412) |
| OTLP 及完整性 | 接收 `POST /v1/traces` Protobuf；另有 `GET /v1/projects/{project_identifier}/spans/otlpv1` | 可以重放项目保留的原始 OTLP payload，并保留传入 ID、parent 与时间的语义。但 `/spans/otlpv1` 是从数据库重建的 span 结果，**不是原始 ExportTraceServiceRequest 的无损备份**；其模型 `links` 明确为 TODO，简化 Span schema 也不含原始 resource/scope/trace-state 等全部 OTLP 字段。时间解析使用 Python datetime，不能承诺纳秒逐位不变。[OTLP 导出实现](https://github.com/Arize-ai/phoenix/blob/14c193cfad309198168e3c2db522db0ec770a557/src/phoenix/server/api/routers/v1/spans.py#L426)、[OTLP 解码及时间](https://github.com/Arize-ai/phoenix/blob/14c193cfad309198168e3c2db522db0ec770a557/src/phoenix/trace/otel.py#L97) |
| Annotations / scores | `GET /v1/projects/{project_identifier}/span_annotations`、`/trace_annotations`；写 `POST /v1/span_annotations`、`/v1/trace_annotations`。TS 有 `logSpanAnnotations`，Python 有 `get_span_annotations` / `log_span_annotations` | 需与 spans 分别导出；score 是 annotation.result 的一部分，可传 name、annotator_kind、label/score/explanation、metadata、identifier 和目标 OTel ID。不能假定导出 span 就包含人工分歧与全部评审。读模型含 `user_id`、created/updated time、source 等字段，写模型不接受同样的审计字段，因此不能承诺原用户归属/时间/UI 来源完整恢复。document/session annotations 也须各自单独处理。[官方取回示例](https://arize.com/docs/phoenix/tracing/how-to-tracing/importing-and-exporting-traces/exporting-annotated-spans)、[固定 annotation schema](https://github.com/Arize-ai/phoenix/blob/14c193cfad309198168e3c2db522db0ec770a557/schemas/openapi.json)、[TS 写入](https://github.com/Arize-ai/phoenix/blob/14c193cfad309198168e3c2db522db0ec770a557/js/packages/phoenix-client/src/spans/logSpanAnnotations.ts) |
| Datasets | `GET /v1/datasets/{id}/jsonl` 或 `/csv`，可传 `version_id`；`GET /v1/datasets/{id}/examples` 取结构化 examples；`POST /v1/datasets/upload` 接 JSON/JSONL/CSV/PyArrow；TS `createDataset`、Python datasets client 可创建 | 普通 JSONL 导出有 `id/node_id/input/output/metadata/splits`，是所选版本的样本快照；CSV flatten 嵌套内容，OpenAI FT/evals 格式又会转换内容，不应当平台备份。重新上传可恢复样本内容，需显式映射 ID/splits；不保证原 dataset/example/version GlobalID、完整修订历史或 source span 关系。`/examples` 另有 source 字段，普通 JSONL 不包含它，若需要必须另存。[JSONL 导出字段](https://github.com/Arize-ai/phoenix/blob/14c193cfad309198168e3c2db522db0ec770a557/src/phoenix/server/api/routers/v1/datasets.py#L2251)、[固定 API schema](https://github.com/Arize-ai/phoenix/blob/14c193cfad309198168e3c2db522db0ec770a557/schemas/openapi.json) |
| Experiments 与运行评分 | `GET /v1/experiments/{experiment_id}`、`/runs`；`/json`、`/csv` 下载。重建入口 `POST /v1/datasets/{dataset_id}/experiments`、`POST /v1/experiments/{experiment_id}/runs`、`POST /v1/experiment_evaluations` | JSON 是逐 run 结果，含 input/reference_output/output/error/timing/trace_id/tokens 及 annotations，**并非只有摘要**；但未包含完整 trace 树、实验/数据集完整元数据与 ID 映射，不能直接作为“恢复实验”包。可以创建新 experiment，将 example/run ID 映射后写已有 output、原 run 时间及 trace_id，再写 evaluation；这条记录重建路径不需要再次调用模型。`runExperiment(task, evaluators)` 是重新执行，可能产新输出与费用，不等于导入。旧 experiment/run ID、版本历史、全部 UI 状态不能承诺相同。[JSON 导出器](https://github.com/Arize-ai/phoenix/blob/14c193cfad309198168e3c2db522db0ec770a557/src/phoenix/server/api/routers/v1/experiments.py#L999)、[创建 run/evaluation 的固定 schema](https://github.com/Arize-ai/phoenix/blob/14c193cfad309198168e3c2db522db0ec770a557/schemas/openapi.json) |

### 分享到同事本机：关联、冲突与覆盖

1. **保留的是 OTel 身份，不能沿用 Phoenix 数据库身份。** REST 转换直接传递原 trace/span/parent ID 和原起止时间；在空实例、字段兼容且导出完整的条件下，足以重建 Phoenix 所保存的 span 树及 OpenInference 内容。跨实例 prompt/dataset/example/experiment/run GlobalID、附件链接等需要另存并重映射。标准 OTLP 本身不传 Phoenix annotation、dataset、experiment 对象。[固定 span 转换](https://github.com/Arize-ai/phoenix/blob/arize-phoenix-v20.26.1/src/phoenix/server/api/routers/v1/spans.py#L1445)。
2. **新 project 不能隔离重复 ID。** 数据库 `trace_id`、`span_id` 分别全实例唯一。REST createSpans 会查询全库已存在 span ID，遇到重复或无效 span 时整批 400，不入队；202 仅代表入队，仍需读回核对。OTLP 的底层 span 插入是 `DO_NOTHING`，重复 span 通常不更新内容；相同 trace ID 的新 spans 会沿用既有 trace 的 project/session 归属。因此“不覆盖 span”仍可能产生错误合并、漏导入或导入到旧 project。若要保留原 ID，应优先在空数据库/独立临时实例导入；需要多份并存时由项目一致重映射 trace/span/parent 和所有关联引用，并保留原 ID。[唯一约束](https://github.com/Arize-ai/phoenix/blob/14c193cfad309198168e3c2db522db0ec770a557/src/phoenix/db/models.py#L855)、[REST 重复检查](https://github.com/Arize-ai/phoenix/blob/arize-phoenix-v20.26.1/src/phoenix/server/api/routers/v1/spans.py#L1514)、[OTLP 共用插入逻辑](https://github.com/Arize-ai/phoenix/blob/14c193cfad309198168e3c2db522db0ec770a557/src/phoenix/db/insertion/span.py#L128)。
3. **评分有真实覆盖语义。** Span annotation 的 upsert key 为 `(name, span_rowid, identifier)`，trace annotation 类似；复用相同 identifier 会更新，不填 identifier 也不能假设自动保存多位评审。调试包应为评审来源分配稳定且互异的 identifier，并保留 reviewer 等项目自有 metadata；导入前显示冲突结果。[annotation 插入键](https://github.com/Arize-ai/phoenix/blob/arize-phoenix-v20.26.1/src/phoenix/server/api/routers/v1/spans.py#L1267)、[TS 接口覆盖说明](https://github.com/Arize-ai/phoenix/blob/14c193cfad309198168e3c2db522db0ec770a557/js/packages/phoenix-client/src/spans/logSpanAnnotations.ts)。
4. **`POST /v1/traces/transfer` 不是实例同步。** 它只在当前数据库中把 traces 移动到另一 project，源 project 不再显示；不能把 destination_project_identifier 指向同事独立实例。[固定 transfer 路由说明](https://github.com/Arize-ai/phoenix/blob/14c193cfad309198168e3c2db522db0ec770a557/src/phoenix/server/api/routers/v1/traces.py#L723)。

### 免费、许可与资源边界

官方 self-host 明确无许可费、使用额度或功能门禁；纯本机内部开发不需要购买 Phoenix/Arize AX。**服务器许可是 ELv2，不应误称 MIT 或无条件 OSI 开源。** 许可允许使用、复制、修改与分发，但禁止向第三方提供可访问其重要功能集合的 hosted/managed service，禁止绕过许可键或去掉许可/版权通知。本轮“各成员自己本机使用、分享选定数据”不构成把 Phoenix 平台作为第三方托管服务出售；本节不把这一判断延伸到未来客户托管方案。[官方免费 self-host](https://arize.com/docs/phoenix/self-hosting)、[固定 LICENSE](https://github.com/Arize-ai/phoenix/blob/14c193cfad309198168e3c2db522db0ec770a557/LICENSE)。

官方确认 SQLite 支持本机单用户与 per-developer 模式；本轮所读官方材料**未给出可据以承诺的本机最低 RAM/CPU 数字**；后续小数据试用观察到容器内存 453–461 MiB，但这不是官方最低要求或容量保证。SQLite 单服务依赖更少是架构事实，不是任意开发机容量保证；存储、trace 体积、查询并发与本地模型资源仍由实际使用决定。免费平台不免除自己选择的外部模型、存储或计算成本。[官方存储与部署场景](https://arize.com/docs/phoenix/self-hosting/architecture)。

### 对项目调试包的建议与未验证限制

**建议项目保存标准调试包，Phoenix 作为可替换查看器。** 最小内容应包含 manifest（schema、server/SDK 版本、导出范围、数量、源 ID）、完整选定 trace 的结构化 spans/可选原始 OTLP、独立 annotations、dataset 样本快照及稳定 example key、experiment/run/evaluation 原始记录与映射、prompt 渲染快照和代码/配置版本、需要共享的附件。项目自有 Run/Step/Tool ID 保持为主键；真实敏感内容按需选择与脱敏后传递。这里只提出格式与边界，未实现新导出服务或更改现有共享工具。

仍待后续获准接入时验证：固定发布包与 server 的兼容组合；两台本机离线导入后的 span 数量、父子关系、events/attributes、时间精度；annotations 重复导入与多评审共存；dataset source/splits/version 映射；experiment JSON + API 重建后 trace drill-down 与评分一致性；附件路径；collector 不可达后的丢失/补传行为。后续小型合成案例已完成运行、浏览器核心操作和选定记录往返，范围见[试用报告](2026-10-27-observability-local-trial.md)；上述更广的边界仍未验证，不能承诺另一实例完整恢复原 UI、全库同步或执行语义回放，也没有教学效果验证。


## Langfuse 本机与选择性共享对照

核查日期：**2026-10-27**。本节记录官方资料与固定源码核查。后续已做临时本机运行、浏览器核心操作和小型跨实例传递，范围见[试用报告](2026-10-27-observability-local-trial.md)；资料支持的广义能力不等于全部运行验收。

**结论：现有事实不足以排除 Langfuse。** 免费 OSS 能在开发机运行，也有选定 observations、scores、datasets 和 experiments 的公开读写积木及官方迁移示例。官方没有在已检查的当前部署文档中给出明确的本机最低内存；`4 cores / 16 GiB` 属于 VM 推荐，不是本机硬门槛。团队电脑是近两年新机型时，服务较多只能说明维护面较大，不能证明带不动、质量较低或开发体验较差。Langfuse 的 prompt diff、关联 generations 与逐样本比较已在同场景试用；人工队列、多人成员协作和 Agent API 的完整体验仍属资料确认，未实际操作。该有限试用支持两者核心功能充足，并呈现当前操作流程的差别，不构成普遍质量排名。

### 版本、免费边界与本机启动

- **版本事实**：官方 Releases API 当日最新非 prerelease 为 server [v4.70.1，2026-10-26](https://github.com/langfuse/langfuse/releases/tag/v4.70.1)、JS/TS [v6.0.2，2026-10-22](https://github.com/langfuse/langfuse-js/releases/tag/v6.0.2)。以下源码固定到这些 tag。SDK v6 要求 Node.js ≥22、self-host server ≥4.59.0；不能沿用旧 server v2 或 SDK `item.link()` 教程作为长期方案。[官方 v6 升级说明](https://langfuse.com/docs/observability/sdk/upgrade-path/js-v5-to-v6)。
- **免费事实**：核心能力与 APIs 在 OSS 中无产品用量限制；固定 [LICENSE](https://github.com/langfuse/langfuse/blob/v4.70.1/LICENSE) 将 EE 路径之外的主体代码置于 MIT。收费边界包括 project-level RBAC、protected prompt labels、自动 data retention policies、audit logs、server-side masking 等，不能把 Cloud 套餐限制套到 OSS，也不能把 EE 治理能力算进免费本机能力。[EE 边界](https://langfuse.com/self-hosting/license-key)。本机保存与离线查看既有记录不要求 Cloud 配额；外部模型或外部服务费用另计。
- **官方本机路径**：取得官方仓库与 Compose、修改占位 secrets 后 `docker compose up`，UI 为 `http://localhost:3000`。官方区分 Local 与 VM；Local 列出的前置是 Git、Docker/Compose，macOS/Windows 使用 Docker Desktop。VM 部分才推荐至少 4 cores / 16 GiB，并举 100 GiB 存储例子。**在本轮检查的 Local、容器 sizing、基础设施文档与官方站内检索中，未找到经官方保证的整栈 local minimum 或单容器/SQLite 裁剪配方**；不能把“未公布”改写成“小于 16 GiB 不支持”。[部署文档](https://langfuse.com/self-hosting/deployment/docker-compose)、[容器 sizing（生产推荐）](https://langfuse.com/self-hosting/deployment/infrastructure/containers)。上述是官方启动方案；本轮后续已在临时 VZ/Docker 环境执行同版 Compose，运行结果见[试用报告](2026-10-27-observability-local-trial.md)。
- **实际依赖**：固定 [Compose](https://github.com/langfuse/langfuse/blob/v4.70.1/docker-compose.yml) 是 Web、Worker、PostgreSQL、ClickHouse、Redis、MinIO 六个服务；Web/Worker 明确依赖后四项。MinIO 只是可替换实现，所需能力是 S3-compatible/blob storage；它保存 ingestion raw events，不因“不用图片、不做批量导出”就能直接删除。官方还支持 SeaweedFS 等自托管实现。把 DB 换成外部现有服务可减少本机容器，但并未消除依赖，且改变了全本机前提。[存储职责与替代实现](https://langfuse.com/self-hosting/deployment/infrastructure/blobstorage)。

**运行判断，已有有限实测**：本轮已在 M5 / 16 GiB 宿主的 4 vCPU / 6 GiB 临时环境跑通核心页面与选定记录传递，小数据阶段六容器内存约 2.45–2.52 GiB。支持该条件下可运行，不是高负载、长期稳态或与大型本地模型并行的容量保证；详见[试用条件](2026-10-27-observability-local-trial.md#本机资源与启动)。

### 选择性文件共享：当前可用 API 与实际恢复范围

下列 REST 路径均相对于各自本机实例；认证使用该实例 project keys 的 Basic Auth。**导出查询 JSON 不是可直接原样 POST 的统一 import 格式**，需字段转换、对象映射和分页。选择 trace IDs 后应遍历其全部 observations，不能只取 root 或一个过窄时间窗口。

| 对象 | 当前出口 | 当前入口与限制 |
| --- | --- | --- |
| 选定完整 trace / observations | `GET /api/public/v2/observations?traceId=...&fields=core,basic,time,io,metadata,model,usage,prompt,metrics,trace_context`，持续读取 `meta.cursor`；单页最多 1000。默认只有 core/basic，metadata 默认截到 200 characters，需用 `expandMetadata=key1,key2,...` 展开相关键；input/output 返回原始字符串 | `POST /api/public/otel/v1/traces`，按 OTel/OTLP 编码完整 spans，保留 traceId、spanId、parent、起止时间，并映射 Langfuse attributes；不是把 GET 的 JSON 直接重发。原始 OTLP 若由项目另存，可作为重放底本。当前查询视图不足以承诺还原原始 OTLP 全部 resource/scope/links 或外部附件字节。[固定 observation schema](https://github.com/langfuse/langfuse/blob/v4.70.1/fern/apis/server/definition/observations.yml)、[OTel 接收路由](https://github.com/langfuse/langfuse/blob/v4.70.1/web/src/pages/api/public/otel/v1/traces/index.ts) |
| Scores / 人工评分 | `GET /api/public/v3/scores`，cursor 分页，按目标筛选；请求 `fields=details,subject,annotation` 才涵盖 comment/config/metadata/关联对象/author/queue 等扩展信息；core 自动返回，不可写入 fields（未知组名返回 400）。可按 traceId 或 experimentId 筛选；observationId 须同时带 traceId。也要取 experiment 级 score，不能只取 trace 分数 | `POST /api/public/scores`，body 是 score 数组；可写 id、traceId/observationId/sessionId/datasetRunId、name、value、dataType、comment、metadata、configId、source、timestamp。202 接受，207 表示部分拒绝，需检查逐项错误。读出的 BOOLEAN 是 boolean，创建要求 0/1；`source` 只接受 API/ANNOTATION，EVAL 不接受；不可设置原 authorUserId。先迁移 score configs 并映射 configId；原 EVAL 来源、评审者身份放进 provenance，不伪称已完整恢复。[固定 schema](https://github.com/langfuse/langfuse/blob/v4.70.1/fern/apis/server/definition/scores.yml)、[写入事件保留 timestamp](https://github.com/langfuse/langfuse/blob/v4.70.1/web/src/features/public-api/server/scores-api-service.ts#L222) |
| Dataset 定义与选定样本 | `GET /api/public/v2/datasets/{datasetName}`；`GET /api/public/dataset-items?datasetName=...&version=...` 支持按源版本时间取 snapshot，page/limit 分页；单项 `GET /api/public/dataset-items/{id}` | `POST /api/public/v2/datasets` 建定义；`POST /api/public/dataset-items` 写 datasetName/input/expectedOutput/metadata/sourceTraceId/sourceObservationId/id/status。样本按 id upsert，id 在 project 内唯一。源 dataset ID 及历史版本时间不能靠此接口原样设置；目标会形成新历史，须保存 source revision 与 ID map。[datasets schema](https://github.com/langfuse/langfuse/blob/v4.70.1/fern/apis/server/definition/datasets.yml)、[items schema](https://github.com/langfuse/langfuse/blob/v4.70.1/fern/apis/server/definition/dataset-items.yml) |
| Experiment 汇总与逐项结果 | `GET /api/public/experiments?fromStartTime=...&id=...&fields=core,metadata,scores`；`GET /api/public/experiment-items?fromStartTime=...&experimentId=...&fields=core,dataset,io,metadata,itemMetadata,experimentMetadata,scores`。均 cursor 分页，单页最多 100；lower bound 必填。内嵌 scores 最多 50，完整评分另经 scores API 分页补齐 | 当前 experiment API 只有 GET，没有一个对称的 `POST /experiments` 恢复入口。恢复通过完整 trace 的 OTel experiment attributes 再摄入，并另写 scores；见下文。现成旧 `POST /dataset-run-items` 在 `events_only` 模式仅返回稳定 experiment ID，**不会写入关联**，不能把成功响应误认迁移成功。[固定 experiment schema](https://github.com/langfuse/langfuse/blob/v4.70.1/fern/apis/server/definition/experiments.yml)、[旧写入路由注释与分支](https://github.com/langfuse/langfuse/blob/v4.70.1/web/src/pages/api/public/dataset-run-items.ts#L18) |

**两个容易误判的当前版本问题：**

1. 不应规划用 legacy `POST /api/public/ingestion` 的 trace-create/span-create/generation-create 长期导入。v4.70.1 在 `events_only` 下只接收 score-create；还存在按组织创建日期配置的 cutoff。是否启用取决于部署配置，不能笼统说所有 self-host 已关闭；新方案直接选 OTLP。[固定处理分支](https://github.com/langfuse/langfuse/blob/v4.70.1/web/src/pages/api/public/ingestion.ts#L189)。
2. 官方 [migration cookbook](https://langfuse.com/guides/cookbook/example_data_migration) 仍写 score 创建不接受 timestamp，并跳过历史 dataset run items；**固定 v4.70.1 schema 与服务实现已接受 timestamp**，本节采用固定源码结论。SDK wrapper 也须匹配实际版本，不能照抄该 notebook 就宣称当前完整迁移。该 cookbook 使用 Python SDK v4（≥4.8.1、<5），不是本轮 Node SDK v6 的现成工具。

**Experiment 可恢复的官方路径**：官方 [v4 experiment 恢复 FAQ](https://langfuse.com/faq/all/experiment-runs-not-visible-v4) 明确要求重新摄入每条完整 trace 的全部 observations：每条带同一 `langfuse.experiment.id/name/dataset.id`，每个 item 内统一 `langfuse.experiment.item.id/root_observation_id`；保留原 parent、IDs 和精确 start/end，root 另带 expected output、item metadata，可带 item version/experiment description/metadata。跨实例时 dataset、item、prompt、score config 等引用必须映射到目标对象；不能只写返回的 experiment item JSON。官方同时说明同实例替换依赖 trace ID、observation ID 与**完全一致的 start time**，后台 merge 没有时限，错误改时间可能留下永久重复记录。此方案证明恢复有路径，不证明跨实例所有 UI 状态无损；本轮后续以小型合成案例验证了选定字段往返；完整 UI 状态与全部历史仍未验证。

**可规划的离线移交**：A 本机按 trace/experiment allowlist 读全分页，写一个版本化文件包；包含完整 observations、独立 scores、相关 configs、dataset snapshot/items、experiment/item 属性、ID map/provenance 与必要附件。B 收到文件后，仅对 B 的 localhost 调 API：先建 definitions/items/configs，再重放带 experiment attributes 的 OTLP，再写目标关联 scores，最后按数量、父子关系、逐样本输出和评分核对。A、B 无须同时在线，也无需共享常驻服务器；这是从上述公开接口推导的项目适配方案，**不是已有官方离线 pack/unpack 工具，后续只执行了[小型合成案例试用](2026-10-27-observability-local-trial.md)，尚未形成项目工具**。只读分享则可直接保留文件报告，不强迫还原平台 UI。

**不误用付费 export**：UI 支持按当前表过滤导出 CSV/JSON；不能把 trace 表导出自动理解为全部子 observations、评分、数据集、实验与附件都已装包。[UI export](https://langfuse.com/docs/api-and-data-platform/features/export-from-ui)。定时 [Blob Storage export](https://langfuse.com/docs/api-and-data-platform/features/export-to-blob-storage) 官方标记 Self Hosted Available，支持 S3-compatible 目标；Cloud 的套餐/add-on 条件不适用于这一 self-host 可用性。它偏定时分析导出，不能替代选择性完整恢复；官方 [ClickHouse 迁移说明](https://langfuse.com/faq/all/self-hosting-migrate-clickhouse-oss-to-cloud) 也明确 blob exports 不是数据库 restore 路径。本轮方案只依赖本机公共 API，不依赖 Cloud 付费导出。

**与已核实 Phoenix 的窄对照（判断）**：Langfuse 有官方 migration cookbook、experiment 恢复说明、原生 experiment/item 查询，这些让迁移设计更有据可依；但导出观察结果仍需重建 OTLP、映射引用、补评分和恢复实验属性，不能证明比 Phoenix 的 `getSpans/logSpans` 加独立 annotations/dataset/experiment APIs 更省事。两者的选定记录后续均已在独立实例核对成功，但都不等于“一包完整还原”。共享是否便捷还取决于项目工具的范围选择、映射与报告，不能仅据 API 能力判断。

### 开发体验：已核实能力、免费本机限制与待测判断

以下只确认操作入口及语义存在，不以 stars、组件数量或宣传口号代替质量判断。

| 具体开发任务 | Langfuse 官方证据与可用行为 | 对本机协作的实际含义 / 尚未证明项 |
| --- | --- | --- |
| 定位自有 RunDriver 的失败步骤、工具调用和延迟 | Trace UI 显示嵌套 observations、timing、input/output、metadata；固定源码存在 [TraceTree](https://github.com/langfuse/langfuse/blob/v4.70.1/web/src/features/traces/components/TraceTree.tsx) 与 [TraceTimelineCompact](https://github.com/langfuse/langfuse/blob/v4.70.1/web/src/features/traces/components/TraceTimelineDense/TraceTimelineCompact.tsx)。[官方 trace 示例](https://langfuse.com/docs/observability/overview) | 手动 OTel 可以包 Run/Step/Agent Tool，无需迁移 Agent loop；要获得专用模型/用量/prompt 字段仍需 Langfuse 属性映射。流式 Messages/Responses 原件是否完整、恢复后的因果展示、长 trace UI 响应未测，不能据截图判定优于 Phoenix |
| 改 prompt 后定位差异并追到使用它的调用 | 有 prompt version diff、固定 version、可移动 labels；generation 关联 prompt 后按版本看 latency、tokens、cost、score、count。[版本管理](https://langfuse.com/docs/prompt-management/features/prompt-version-control)、[关联与指标](https://langfuse.com/docs/prompt-management/features/link-to-traces) | 这是实际的一体化迭代入口。普通 version/label 属核心；protected labels 属 EE。RunDriver 仍应固定解析后的版本和渲染快照，label 不能作为重放依据。跨本机 label 不自动同步 |
| 比较同一批 case 上的两次完整 Agent 执行 | TS `langfuse.experiment.run({data,task,evaluators,runEvaluators,...})` 或 `dataset.runExperiment(...)`；task 可以调用完整 RunDriver。结果含 itemResults、runEvaluations、experimentId。UI 支持 baseline/candidate 输出并排、评分阈值筛选、cost/latency 差异。[固定 TS 实现](https://github.com/langfuse/langfuse-js/blob/v6.0.2/packages/client/src/experiment/ExperimentManager.ts)、[比较文档](https://langfuse.com/docs/evaluation/experiments/compare-experiments) | 固定 dataset snapshot、commit、prompt/model、evaluator 版本后能形成可审查比较；UI 选择 baseline 不会自动配置 CI gate。是否能更快发现 XunJie 的状态错误与教学反馈退化，需要共同案例试用 |
| 用 UI 快速试不同 prompt/model | UI prompt experiments 支持 dataset version，比较 prompt/model 输出，可加评分。[UI experiments](https://langfuse.com/docs/evaluation/experiments/experiments-via-ui) | 适合单次 prompt 迭代；不能把它当自有多步 RunDriver 的完整验证。实际生成/judge 仍需配置可达模型，不因平台免费而免模型成本 |
| Robert 或同事评审选定失败案例 | Annotation queues 可选择 trace/observation/session 子集，用 score configs 评分、评论、记录 corrected outputs，可分派队列用户。[人工队列](https://langfuse.com/docs/evaluation/evaluation-methods/annotation-queues)。固定 [队列源码](https://github.com/langfuse/langfuse/tree/v4.70.1/web/src/features/annotation-queues) 位于非 EE 路径，结合 LICENSE 与 EE 列表核对核心边界 | 能形成有评分维度的审阅流程。各自独立实例之间没有队列/身份/进度自动合并；选定文件需要显式 reviewer provenance 与冲突合并。API 重写评分也不能冒充保留原评审账号 |
| 编码 Agent 帮开发者查询 traces、整理实验与修改 prompts | 官方 CLI 包装公开 API；原生 MCP 为 project-scoped，提供读写工具，并列出 self-host/local 配置。[CLI](https://langfuse.com/docs/api-and-data-platform/features/cli)、[MCP](https://langfuse.com/docs/api-and-data-platform/features/mcp-server) | 有现成机器接口，Agent 不必只操作 UI；这对开发协作有潜在便利。本轮没装 CLI/MCP、没调用 Agent/model；具体工具覆盖与净节省操作量未测，不能断言 Phoenix 没有对应能力 |

**免费本机中需要额外配置的能力**：不能把“UI code evaluators 需要 AWS”写成一概限制。当前官方支持 `LANGFUSE_CODE_EVAL_DISPATCHER=insecure-local` 与 `QUEUE_CONSUMER_CODE_EVAL_EXECUTION_QUEUE_IS_ENABLED=true`，在 Worker 内运行可信 TypeScript/JavaScript evaluator；不提供不可信代码沙箱，且这个本地 dispatcher 不支持 Python。默认未配置 dispatcher 时该 UI 功能关闭；AWS Lambda 是另一个 dispatcher。项目自己的 Node/TS 规则评分和 experiment evaluator 则可直接在开发工具进程运行并记录 scores，不依赖 UI dispatcher。[当前 self-host 配置](https://langfuse.com/self-hosting/configuration/code-evaluators)。

**交给主任务的判断**：Langfuse 在功能充足性上有充分的一手证据进入同场景试用；“免费本机不够用”“只能付费 export”“没有选择性迁移路径”“16 GiB 必然带不动”均不成立或证据不足。可以确认的代价是多项持久服务与迁移适配工作，而不是产品质量差。最终比较应观察同一失败 trace 的定位、一次 prompt 修改到实验逐项比较、一次人工审阅、一个选定文件包在另一实例恢复的成功率/操作量，以及宿主资源与稳定性；其中核心界面、小数据资源与选定记录往返已经后续[本机试用](2026-10-27-observability-local-trial.md)补证；长 trace、生产流式接入、多人评审和大负载仍未测。最终建议依据资料与这次有限实测共同形成。
