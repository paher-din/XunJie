# Phoenix 与 Langfuse：本机功能、操作和交接试用

日期：2026-10-27。对应负责人要求：共同考量功能充足性、质量与易用性、开发协作便利性及本机可运行性；团队电脑为近两年的高性能机型，不使用付费版，也不增设大服务器。

## 结论

负责人已确认下述平台与协作选择（[L33](../student-agent-decisions.md#来源与状态)）；分享形式及操作路由见[接入设计](2026-10-27-agent-evaluation-integration.md#分享的具体形式与交接步骤)。以下试用范围与未验证项保持原记录。

**工程推荐仍为本机 Phoenix + SQLite，按需共享选定案例与实验结果。** 依据是所需核心功能和独立实例交接路径都已跑通，逐案例比较默认呈现内容与评分，本机运行占用更小。资源消耗只是其中一个因素。Langfuse 同样通过本次核心功能与交接检查，当前电脑可以承载；不能以官方服务器建议 16 GiB 推断开发电脑运行不了，也不能据本次试用断言 Phoenix 整体质量高于 Langfuse。

Langfuse 的优势包括独立实验入口、灵活的表格/筛选/视图、Prompt labels 与关联 generations、人工评审队列等完整运营入口。若后续确有集中持续观测、分派评审或围绕 Prompt 发布运营的需求，应重新衡量这些收益。当前成员各自运行、异步移交固定案例的需求，尚未体现出足以抵消额外运行与数据重建工作的收益。两套平台不同时成为项目必备依赖。

## 条件与证据范围

- 宿主：Apple M5、16 GiB RAM、macOS arm64。这是一台实测机器，不代表已测遍团队电脑或 Windows。
- 共同运行条件：临时 VZ 虚拟机，4 vCPU、6 GiB RAM，Docker 29.5.2。两平台顺序运行，测量时另一平台停止；全部镜像为 arm64，不依赖 x86 模拟。
- Phoenix：官方 `arizephoenix/phoenix:version-20.26.1`，一个应用与独立 SQLite 卷。Langfuse：官方 `v4.70.1` Compose，web、worker、PostgreSQL 17、ClickHouse 25.12、Redis 7、MinIO 六个服务。
- 全部服务仅绑定本机端口，使用临时测试身份，关闭平台遥测；没有真实学生资料、现有账号、模型调用或付费实验。产品依赖和运行代码没有改变。
- 共同输入为[合成 fixture](probes/2026-10-27-observability/fixtures.json)：三条案例 × baseline/candidate，两组共六条 trace、24 个 span，六条预设规则分数及两版 Prompt。案例覆盖正常工具调用、工具超时与直接索取完整答案。输出和分数是预设值，不代表实际模型运行或教学改善。
- 通过公开 API 写入固定记录，再在本机浏览器检查 UI；这是平台数据与界面验证，不是项目 TypeScript SDK、RunDriver 或三个真实模型协议的集成验收。

固定版本及官方能力依据见[选型研究](2026-10-27-agent-observability-evaluation-research.md)。镜像 digest、测量样本与往返核对结果保存在[结果 JSON](probes/2026-10-27-observability/results.json)。首次下载发生过 Docker Hub 匿名鉴权网络超时，重试成功；网络下载不计入以下启动数据，也不作为产品质量差异。

## 功能与实际操作

| 任务 | Phoenix 实际观察 | Langfuse 实际观察 | 判断 |
| --- | --- | --- | --- |
| 找到失败步骤及上下文 | 运行列表进入调用树，工具节点明确显示 ERROR；同页能看学生输入、错误回答与评分 | 过滤 root observation 后进入 Tree，工具节点显示 Error；同页能看输入输出、分数，另有 Timeline/Graph 入口 | 两者均能定位本例。Graph 入口存在，不表示复杂图已验收 |
| 比较同一批 case 的两版结果 | 勾选两组实验后 Compare；默认显示输入、参考输出、两版输出及评分变化 | 勾选两组实验后 Compare；可换 baseline，视图更灵活。本次默认隐藏 Expected Output/Output，打开这两列后可并排读内容和分数 | 两者均满足；Phoenix 在本次典型操作中更直接，Langfuse 的显示配置更多 |
| 看 Prompt 修改 | 两版历史和 Diff 开关可显示文字变化，提供 TypeScript 使用入口 | 两版历史、labels、Compare 按钮可显示文字变化，并有 Linked Generations 入口 | 两者满足版本对照；本次未比较完整发布、回滚、多人编辑体验 |
| 评分与语义 | 能看到预设规则评分与逐案例差异 | 能看到预设规则评分与逐案例差异，也会呈现工具错误状态 | 工具超时、回答是否妥善处理超时是两项判断。不能把平台 error 数或合成 score 当教学成效 |
| 短时稳定性 | 已完成查看、查询、导出和独立导入；没有服务退出或 OOM | 已完成同样核心路径；检查 web/worker/ClickHouse 无重启或 OOM | 只支持本轮小数据核心路径可用，不构成长期稳定性或整个平台质量认证 |

界面证据：[Phoenix 调用树](probes/2026-10-27-observability/phoenix-trace.png)、[Phoenix 实验比较](probes/2026-10-27-observability/phoenix-compare.png)、[Langfuse 调用树](probes/2026-10-27-observability/langfuse-trace.png)、[Langfuse 实验比较](probes/2026-10-27-observability/langfuse-compare.png)。

Phoenix 接入中遇到的具体边界：dataset upload 默认异步，需 `sync=true` 才直接返回 ID；experiment run 使用 example 的 `node_id`，把返回的稳定 `id` 直接传入会得到 500；Prompt schema 含 string 分支，但当前服务返回“Only CHAT template type is supported”。按公开接口改用同步上传、内部 ID 映射和聊天模板后，核心流程通过。前者是调用约定，后两项体现接口易误用之处；不能将其隐去后笼统宣称质量完美，也不足以据此否定整个产品。

Langfuse 接入必须携带 `x-langfuse-ingestion-version: 4`，experiment 属性在整条 trace 的每个 observation 上一致传播。完整导出需主动选择 `io`、`metadata`、`usage`、`prompt` 等字段组，长 metadata 还需 `expandMetadata`；默认观察列表不是完整迁移包。这些都是适配成本，不能只看“支持 OTel”就忽略。

## 本机资源与启动

| 同一临时运行环境 | Phoenix | Langfuse |
| --- | --- | --- |
| 组成 | 1 个服务 + SQLite | 6 个服务 |
| 小数据查看阶段容器内存样本 | 453–461 MiB | 合计 2,504–2,584 MiB，约 2.45–2.52 GiB |
| 首次空数据环境 API 就绪，排除镜像下载 | 16.66 秒 | 25.32 秒 |
| 另一个空接收实例就绪 | 20.76 秒 | 24.82 秒 |

内存来自 `docker stats --no-stream`，不含虚拟机本身、浏览器、IDE、本地模型或完整机器总占用；启动时间是单次记录，不能据此宣称普适速度或最小硬件要求。6 GiB 虚拟机内，两者在本轮都没有逼近内存容量。**现代开发机上的小规模本地调试两者均可行；本次没有做高并发、长 trace、大数据量或同时运行大型本地模型的容量测试。**

## 按需移交到独立实例

两边各创建第二套独立数据库和服务，导出选定内容后重建接收端。Langfuse 源实例在接收端重建前已停止；Phoenix 导入后停止源实例，再读回接收端，确认不依赖源服务在线。没有共享活动数据库或重新运行模型。

| 核对项 | Phoenix | Langfuse |
| --- | --- | --- |
| 调用记录 | 24 spans；name、context、parent、时间、状态、attributes/events 逐项一致。本例 events 为空 | 24 observations；ID、parent、时间、类型、状态、输入输出、model/usage、prompt name/version 等选定字段一致 |
| 分数 | 6 annotations，目标、名称、类型、值、说明、metadata、identifier 一致 | 6 scores，目标、名称、类型、值、时间、comment、metadata 一致 |
| 案例与实验 | 3 examples、2 experiments、6 runs；重建内部 ID，逐案例输入、参考输出、输出、错误及评分一致 | 3 dataset items、2 experiments、6 experiment items；映射新 dataset ID，逐案例输入、预期输出、输出及评分一致 |
| Prompt | 源端两版及 Diff 已测；本次没有迁移全部 Prompt 历史 | 重建两版，generation 的 prompt name/version 字段核对一致；未保留全部发布审计身份 |
| 重复内容 | 向已导入实例再次发送相同 spans 返回 400，0 入队；不能把重发当幂等成功 | 本次未测重复摄入及 ClickHouse 后台合并，不承诺重发后立即去重 |

Phoenix 的导入路径主要为结构化 spans → annotations → datasets/examples → experiments/runs/evaluations，需内部 ID 映射。Langfuse 需把 observations/experiment context 重建为 OTLP，补 scores，映射 dataset/prompt 引用；步骤同样可实现，但不是现成的一键离线交接工具。这里的试用脚本只证明路径，不构成可交付的 `xj-dev` 功能。

本次没有证明完整平台 UI、原评审账号/审计时间、附件、全部 OTLP links/resource/scope 或纳秒精度无损恢复。Langfuse 查询时间为毫秒表示；Phoenix 本例微秒时间保留，但本例没有验证纳秒或非空 events。可靠交接底本仍是项目保存的固定 case、版本、输入输出与原导出，报告应可在不启动平台时阅读。

## 采用范围与剩余工作

当前推荐的工作流是：开发者在本机按需启用 Phoenix；固定合成案例和评分器跟随代码；真实 trace、平台数据库与私有案例留在仓库外；选定包通过现有团队私有文件链路传递，接收方先读报告，再按需导入或重跑。服务关闭不能阻塞产品 Run 或本地结果保存，具体设计见[接入与协作方案](2026-10-27-agent-evaluation-integration.md)。

真正接入时仍需实现并验证可选观测模块、TypeScript 评估 runner、选定包采集/导入和现有共享链路的包类型扩展。三协议流式内容、持久恢复关联、非空事件与附件、多人评价、版本升级、Windows 和真实模型质量均未在本轮验收。选型试用不替代这些工程检查，也不代表真实教学效果通过。

临时虚拟机、容器数据、下载的运行工具与镜像、测试身份和相关缓存已清理，六个试用端口均确认关闭；仅保留合成 fixture、脱敏测量结果和界面截图作为证据。
