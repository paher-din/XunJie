# 本地、学校与混合部署：四个产品的首轮研究

核对日期：**2026-10-27**。范围仅 Open WebUI、Dify、Immich、Supabase 的官方文档与一手部署源码；用于循阶部署讨论，不形成产品决议。不涉及服务安装、凭据、付费试用、GitHub 修改或归档材料。本次是文档与源码核对，没有运行验收、容量测试或教学效果验证。

## 结论先行

四者共同支持的思路是：**完整应用可以自托管，部分有明确协议的能力可以外接；部署位置可选，不代表每个功能都能独立搬迁。** 个人本机完整运行、学校共享实例、外接计算或存储是不同维度。没有一个案例足以证明“任意组件在本地/云端排列组合”开箱即用。

对循阶，优先借鉴 Open WebUI 的模型端点选择，以及 Immich 的明确远程计算接口；借鉴 Dify、Supabase 对真实服务、基础设施和共享状态的区分。部署单元应按独立运行、数据责任和计算需求划分；课程/组织、个人学习数据和 Agent 是否分别部署，要依据循阶的具体混合场景确定，不能照抄上游的集中边界。

| 产品 | 本机完整自托管 | 组织共享 | 已核对的远程组合边界 | 仍然耦合的部分 |
| --- | --- | --- | --- | --- |
| Open WebUI | WebUI、数据与本地模型服务可在同机运行。[O1] · [O4] | 单实例、多账户、分组及模型授权。[O3] | 同一 WebUI 对接本地/远程模型端点；另有实验性浏览器直连。[O2] · [O5] | 普通模型调用从后端发出；直连也没有移走完整应用后端。[O5] |
| Dify | 官方 Compose 提供应用进程及配套基础设施。[D1] · [D3] | 共享服务器入口及管理员初始化有明确说明。[D1] | 前端独立进程、可配置数据库/队列/存储、sandbox 与 plugin 服务地址。[D2] · [D3] · [D4] | API/worker 使用同一后端镜像、共享状态；plugin 有回调，文件也有可达性要求。[D3] · [D4] |
| Immich | 推荐生产 Compose 包含 server、ML、Redis 协议服务及数据库。[I1] · [I5] | 多用户各自拥有图库，管理员添加账户。[I4] | 官方 remote ML；主服务也可多实例，但共享基础设施。[I2] · [I3] | 主服务多实例要同一 Postgres、Redis、文件；不是各端各有独立数据。[I3] |
| Supabase | 官方 Docker 自托管可在电脑、服务器或云基础设施运行。[S1] | 可作为组织应用的共同后端；自托管 Studio 是单 project，不是托管平台多组织控制面。[S1] | 独立服务、外部 Postgres 配置及 S3 后端。[S2] · [S3][S4] | 服务共享 Postgres 角色/schema 与认证配置；Storage 仍依赖数据库和其他服务。[S2] · [S4] |

## 证据时间与版本

文档均按本次访问到的在线页面解释，**不是历史版本快照或某个发行版的完整支持矩阵**。Open WebUI、Immich、Supabase 所引页面没有绑定单一产品版本；Dify 文档也没有绑定单一发行版，Compose 页标注修改于 2026-10-23，独立前端页标注 2026-06-25。Immich remote ML 页标注更新于 2026-10-21。页面更新时间不等于能力首次发布日。

源码使用 GitHub commits API 按当天核对时点之前的提交解析，并实际读取以下固定提交中的 Compose 文件；分支上的源码与已发布版本不画等号。尤其不要把源码镜像标签当作已验证可安装的发行承诺。

| 仓库 | 固定提交 | 提交时间（UTC） | 本次读取文件 |
| --- | --- | --- | --- |
| open-webui/open-webui | `33c1978d5bad52a31df75ea55143025dfad18d16` | 2026-10-25 08:00:02 | `docker-compose.yaml` [O4] |
| langgenius/dify | `092526a5048b81475a78c5e45906ae7704684403` | 2026-10-27 06:20:08 | `docker/docker-compose.yaml` [D3] |
| immich-app/immich | `df50249c03ddac9417a2172cfbbaef848163ed4f` | 2026-10-26 19:29:14 | `docker/docker-compose.yml` [I5] |
| supabase/supabase | `fd058409acb24359714463d7f04f424a3db4fac5` | 2026-10-27 05:25:41 | `docker/docker-compose.yml` [S4] |

## Open WebUI：应用实例与模型服务分离

- **本机与学校：** 官方推荐 Docker，本机数据卷保存用户、聊天和配置；固定提交的 Compose 分为 `open-webui` 与 `ollama` 两个服务。学校可运行一个共享实例，由管理员审批账户、分组并分配模型权限，使用者通过浏览器登录。[O1] · [O3][O4]
- **真实混合路径：** 一个实例可同时配置本地模型服务器与云 API，按会话选模型；模型推理位置由选中的端点决定。配置本地模型不会自动让单独配置的 embedding、提取或其他云工具变成本地。[O2]
- **必须辨明请求发起方：** 普通路径是 browser → WebUI backend → provider。学校后端配置的 `localhost` 指学校服务所在环境，不能因此访问学生电脑上的模型。实验性 Direct Connections 改成 browser → OpenAI-compatible endpoint，需要管理员开启及端点 CORS 支持，个人 key 留在浏览器 local storage；后台标题、标签等步骤仍在服务端。它是局部推理调用直连，不是个人整套应用本地化。[O5]
- **对循阶：** 适合借鉴“个人/学校提供模型连接，业务应用不随模型位置迁移”；不适合据此推导本地文件、课堂数据或课程实验已支持任意分布。学生本机模型怎样被调用，必须明确是本机应用调用，还是浏览器直连，不能仅提供一个 URL 输入框。

## Dify：真实进程边界多，但共享应用状态

- **实际单元：** 在线部署文档列出 `api`、`api_websocket`、`worker`、`worker_beat`、`web`、`plugin_daemon`、`agent_backend` 七类核心服务，并列出依赖组件及一次性权限初始化任务。固定 Compose 中 `api_websocket` 有 `collaboration` profile，另有 KnowledgeFS 可选进程；因此不把文档容器数量当作所有安装的恒定清单。[D1] · [D3]
- **app 不等于独立后端：** `web` 是独立前端镜像；console/app URL 可分别配置，但 URL 名称本身不是两个独立业务后端的证据。源码中 API、worker、beat 使用同一个 `dify-api:1.18.0` 镜像，分别按 `MODE: api/worker/beat` 启动。API、worker 默认挂载同一 `./volumes/app/storage`，plugin daemon 有自己的持久目录及 plugin database 配置。[D2] · [D3]
- **可外接的真实接口：** 文档提供 `DB_HOST`、Redis/Celery broker、文件存储后端与 sandbox endpoint 配置。plugin daemon 还需回调 Dify 内部 API；文件内部 URL 与公开 URL 可不同。`sandbox` 执行工作流 Code/Template 节点；另有 `agent_backend` → `local_sandbox` 链路，不能把两种 sandbox 混为一个任意执行器。[D3] · [D4]
- **支持程度：** 官方明确描述独立前端启动和这些可配置连接；据此可以判断存在跨进程/网络接口，但没有完成任意跨机器拓扑验证。把 worker 搬走仍需满足同一数据库、队列、文件、回调和版本条件；“远程插件调试地址”也不等于完整远程插件部署方案。独立前端文档示例变量与较新的环境变量页名称存在差异，本研究不照抄旧命令作为当前部署指引。[D2] · [D3] · [D4]
- **对循阶：** 适合借鉴 API、后台任务与受控执行服务的职责分离；不适合照搬整套容器数量，也不宜把账户、课程和作业按功能标签逐个变成可跨云服务。可配置外部数据库是运维能力，不是用户数据自动跨实例同步。

## Immich：远程 ML 是强证据，主服务扩展有条件

- **本机与共享：** 推荐生产 Compose 有 `immich-server`、`immich-machine-learning`、名为 `redis` 的服务和数据库；所读源码的 `redis` 实际使用 Valkey 镜像。一个服务器支持多用户、独立图库及管理员建号。[I1] · [I4][I5]
- **明确支持远程 ML：** 主服务向远程 ML 容器发送图片预览，远端不持久化该数据或关联用户；Smart Search 和 Face Detection 使用它，Facial Recognition 处理已入库结果，仍在 server/database 路径。一个 ML 容器可服务多个 Immich 实例。配置多个 URL 是依次尝试，不是负载均衡；可保留本地 ML 作回退，或仅配置远端。[I2]
- **边界与耦合：** 两端版本不匹配可能出问题；该 ML 容器按内部服务设计，没有自己的安全措施，因此官方远程教程不是“直接作为公网多租户 API”的支持承诺。这里记录的是其接口边界，不是额外审批要求。[I2]
- **修正过窄结论：** 不能说 Immich“只能拆 ML”。官方也说明 backend 可多实例、分担转码和缩略图等任务，但每个实例须连接同一 Postgres、Redis，并挂载相同文件；跨机器具体实现没有现成通用步骤。已有 Postgres 接入有官方说明，却明确不推荐，且涉及权限与扩展准备。[I3] · [I6]
- **对循阶：** 适合借鉴窄接口计算服务：本地完整运行，也可换成学校共享计算，明确输入、输出和故障回退。不适合把课程实验直接等同于无状态 ML，也不能从多主服务推导学生与学校分别持有独立数据库还能透明协作。

## Supabase：服务可分，但围绕共同数据与身份工作

- **本机、学校与官方范围：** Docker 是官方推荐自托管路径，Kubernetes 方案标为社区维护；自托管本身是 community-supported。官方明确区分 CLI 的本地开发测试栈与正式自托管部署。自托管 Studio 为单 project，不具备托管平台的多组织、多项目管理语义。[S1]
- **实际单元：** 固定 Compose 有 Studio、API gateway、Auth、PostgREST、Realtime、Storage、imgproxy、postgres-meta、Edge Runtime、Postgres、Supavisor。当前文档与源码默认 gateway 已是 **Envoy**，不能沿用“默认一定是 Kong”的旧结论；日志组件在当前文档中为可选。文档允许删除不需要的部分服务及相应依赖。[S2] · [S4]
- **真实外部依赖：** Compose 对多个服务使用 `POSTGRES_HOST`，并注释外部 Postgres 时应调整本地 `depends_on`。但多个服务需要特定数据库角色、schema、扩展及初始化，不能简化为“任意托管 PostgreSQL 改一个地址即用”。Auth、REST、Realtime、Storage 的连接与认证配置仍须一致。[S2] · [S4]
- **S3 两个方向不能混淆：** Storage 暴露给客户端的 S3 协议入口，与 Storage 自己使用的 S3 后端相互独立。默认文件后端可改为 AWS S3、MinIO 等；这不会把 Storage API、数据库权限或 metadata 一起搬到对象存储。源码默认 Storage 与 imgproxy 共挂文件目录，Storage 还连接 PostgREST、数据库及 imgproxy；跨机器时这些依赖必须重新落实。[S3] · [S4]
- **对循阶：** 适合借鉴“应用服务外接对象存储/数据库，但数据与身份契约完整保留”；不适合把自托管与 Supabase Cloud 视为任意服务可混插的统一控制面，更不能据此承诺个人实例与学校实例自动共享账号、作业或离线状态。

## 循阶讨论用推论：先规划能力边界，再开放位置选择

以下由本轮用户方向和上述证据推导，属于建议，不是上游事实，也不替负责人确认产品范围。

| 候选部署单元 | 首版个人完整本地 | 学校统一模式 | 有依据优先支持的混合组合 |
| --- | --- | --- | --- |
| 应用领域与其持久状态 | 学生/教师均可本机运行完整能力；可把多个服务合并交付 | 学校运行共享服务，管理账户与教学协作 | 课程/组织服务、学习数据服务与 Agent 的进一步分界需要循阶自己的用例；上游资料未替我们作出这项决定 |
| 模型服务/模型接入 | 本机模型服务及调用配置 | 学校统一模型端点与访问授权 | 本地应用接学校模型；学校应用接远程模型；学生本机模型需明确请求发起方与可达路径 |
| 课程实验执行宿主 | 尽量学生本机运行 | 教师按课程决定是否使用学校执行资源 | 学校课程核心 + 学生本地执行；运行位置按课程策略确定，与模型位置独立 |
| 基础设施依赖 | 本机数据库与文件存储，可随完整安装包启动 | 学校持有相应基础设施 | 本地或外部数据库、对象存储按选定服务组合配置；由部署方管理，正常学习无需逐项配置 |

用于检验接口的组合至少应覆盖：**个人全本机；学校统一服务配合学生本地实验；本地应用接学校模型；学校课程/账号服务配合本机 Agent 和学习数据服务。** 最后一种可以是同一个学校学习空间使用本机组件，不必引入个人与学校两个独立环境的互通。负责人已确认个人与学校学习空间逻辑隔离、同一客户端切换；具体语义及登录参照见[总体讨论稿](2026-10-27-overall-architecture-proposal.md)。这些是检查部署边界的例子，不是把其他模块组合推到首版之后的范围决定。教师个人完整本地模式同样属于首组；学校模式不应暗中替换学生的实验执行位置。

“使用方按部分选择本地或云”需要落实为有明确接口的部署单元。四个案例提醒我们核对跨实例身份、状态归属、同步与升级兼容，但不能用上游尚不支持某种组合来否定循阶已明确的产品目标。先确定每类数据的责任方和调用方向，再给出可配置、可验证的部署组合。

负责人随后明确学生设置须以实际使用价值为依据（L22）。据此，组件部署位置属于部署者的能力，不能直接变成学生的常规设置。学校或个人自托管者配置组合，产品负责准备与连接；学生保留个人模型、主动引导等有明确使用价值的选择。该角色分工是循阶的工程建议，不是上述开源产品的共同既有行为。

## 尚未查证与后续讨论点

1. 未安装或实际验证四个产品的跨主机配置、端到端离线能力、性能、故障恢复和多用户隔离。完整本机自托管不等于初次下载无需联网，也不自动涵盖外部模型/邮件等集成。
2. 未逐一核验 Dify 全部 profile、镜像可用性及每个发布版本；未验证 Supabase 任一托管数据库提供商是否满足初始化、权限和扩展要求。
3. 未验证“学校 HTTPS 网页直接调用学生 loopback 服务”在目标浏览器中的 CORS、混合内容及本地网络访问限制。Open WebUI 的实验性功能只证明存在此路径，不是循阶的兼容性验收。
4. 四者均不能作为本地与学校业务数据自动双向同步的证据；循阶离线协作、跨实例身份、课程发布/提交同步尚需单独定义。
5. 学校统一分发的究竟是应用账号、模型服务账号还是模型权重，需要在循阶讨论中明确；上文的学校模型默认指端点及访问授权，不宣称已调研权重分发。课程实验执行宿主的具体进程、文件交换与授权协议也尚未设计。

## 一手来源

### Open WebUI

- [O1 · Quick Start](https://docs.openwebui.com/getting-started/quick-start/)
- [O2 · Connect Local and Cloud Models](https://docs.openwebui.com/getting-started/quick-start/connect-a-provider/)
- [O3 · Share Open WebUI with Your Team](https://docs.openwebui.com/getting-started/sharing/)
- [O4 · 固定提交 Compose](https://github.com/open-webui/open-webui/blob/33c1978d5bad52a31df75ea55143025dfad18d16/docker-compose.yaml)
- [O5 · Direct Connections（实验性）](https://docs.openwebui.com/features/chat-conversations/direct-connections/)

### Dify

- [D1 · Deploy Dify with Docker Compose](https://docs.dify.ai/en/self-host/deploy/quick-start/docker-compose)
- [D2 · Start Frontend Docker Container Separately](https://docs.dify.ai/en/self-host/deploy/advanced-deployments/start-the-frontend-docker-container)
- [D3 · 固定提交 Compose](https://github.com/langgenius/dify/blob/092526a5048b81475a78c5e45906ae7704684403/docker/docker-compose.yaml)
- [D4 · Environment Variables](https://docs.dify.ai/en/self-host/deploy/configuration/environments)

### Immich

- [I1 · Docker Compose（推荐）](https://docs.immich.app/install/docker-compose/)
- [I2 · Remote Machine Learning](https://docs.immich.app/guides/remote-machine-learning/)
- [I3 · Scaling Immich](https://docs.immich.app/guides/scaling-immich/)
- [I4 · User Management](https://docs.immich.app/administration/user-management/)
- [I5 · 固定提交 Compose](https://github.com/immich-app/immich/blob/df50249c03ddac9417a2172cfbbaef848163ed4f/docker/docker-compose.yml)
- [I6 · Pre-existing Postgres（不推荐）](https://docs.immich.app/administration/postgres-standalone/)

### Supabase

- [S1 · Self-Hosting](https://supabase.com/docs/guides/self-hosting)
- [S2 · Self-Hosting with Docker](https://supabase.com/docs/guides/self-hosting/docker)
- [S3 · Configure S3 Storage](https://supabase.com/docs/guides/self-hosting/self-hosted-s3)
- [S4 · 固定提交 Compose](https://github.com/supabase/supabase/blob/fd058409acb24359714463d7f04f424a3db4fac5/docker/docker-compose.yml)

[O1]: https://docs.openwebui.com/getting-started/quick-start/
[O2]: https://docs.openwebui.com/getting-started/quick-start/connect-a-provider/
[O3]: https://docs.openwebui.com/getting-started/sharing/
[O4]: https://github.com/open-webui/open-webui/blob/33c1978d5bad52a31df75ea55143025dfad18d16/docker-compose.yaml
[O5]: https://docs.openwebui.com/features/chat-conversations/direct-connections/
[D1]: https://docs.dify.ai/en/self-host/deploy/quick-start/docker-compose
[D2]: https://docs.dify.ai/en/self-host/deploy/advanced-deployments/start-the-frontend-docker-container
[D3]: https://github.com/langgenius/dify/blob/092526a5048b81475a78c5e45906ae7704684403/docker/docker-compose.yaml
[D4]: https://docs.dify.ai/en/self-host/deploy/configuration/environments
[I1]: https://docs.immich.app/install/docker-compose/
[I2]: https://docs.immich.app/guides/remote-machine-learning/
[I3]: https://docs.immich.app/guides/scaling-immich/
[I4]: https://docs.immich.app/administration/user-management/
[I5]: https://github.com/immich-app/immich/blob/df50249c03ddac9417a2172cfbbaef848163ed4f/docker/docker-compose.yml
[I6]: https://docs.immich.app/administration/postgres-standalone/
[S1]: https://supabase.com/docs/guides/self-hosting
[S2]: https://supabase.com/docs/guides/self-hosting/docker
[S3]: https://supabase.com/docs/guides/self-hosting/self-hosted-s3
[S4]: https://github.com/supabase/supabase/blob/fd058409acb24359714463d7f04f424a3db4fac5/docker/docker-compose.yml
