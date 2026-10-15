# I0-UI：个人模型配置、真实聊天与设计增量接入

日期：2026-10-15（Asia/Shanghai）。负责人：Robert；实施：本会话 Agent。状态：设计增量与真实通道实现完成，工程/合成协议验证通过；本机3444已升级到本次 main，待本人设置 Key 后验证两处真实回复。此前执行边界保留于历史记录，最新现场事实见 §10。

## 1. 目标与当前授权

Robert 当前明确要求：设置页模型配置接通前后端；每账号独立配置，支持 OpenAI 兼容供应商；配置同时用于项目辅导和独立 Agent 聊天页，后者必须实现真实回复；拉取本地 XunJie_Design 最新远程并迁入独立聊天 UI 优化。

用户另指定独立 worktree、在 main 分支实施。本工作区为 main@a71e962；原工作区在途改动保留。该任务批准不取代产品基线，数据库 schema/迁移、真实凭据与实际付费调用按明确范围另列；不推导真实学生数据发送许可。

## 2. 已读依据与适用契约

- README：当前宿主、学生前端与模型入口。
- PRD §1.1 C-02/C-05/C-08、§5 PRD-04/09/10、§8/9 D-02：沿实际 UI 接线，身份与数据边界、故障可恢复。
- MVP_SPEC §2、M-04/05/09/10：真实帮助、原始消息与历史、账号隔离、故障不伪造回复。
- TECH_DESIGN §6.1/6.2、§9、§10：现有辅导校验/政策/版本、3 次/45 秒、服务端会话、持久化与成本；配置改变需可追溯。
- I0_UI_SPEC Implementation Decisions 与 I0_UI_CLIENT_CONTRACT §1～3：准备模式不外发，真实失败不回退替身；会话/账号与异步接纳边界。
- apps/student/IMPORT_SOURCE.md §4：按固定来源增量逐项接收，保留主仓库业务语义，禁止整包覆盖。
- 设计来源固定为 wubq511/XunJie_Design@8df47963ebf9d4b27a4c3b084c8c5304f3d6e23c；审阅 16558426ce70524218eacbf7ce8fde35681c0503 到该提交的 app 增量及 docs/DESIGN、home-design、agent-page-design、frontend-architecture 对应正文。

## 3. 写集与方案

允许写入：本任务；apps/student 的 Agent 聊天页、聊天组件/类型/适配层、必要 AppShell 与样式、设置/模型客户端及适当验证、IMPORT_SOURCE 来源记录；apps/teaching 与 tools/i0-hdl 中模型配置/真实聊天接线涉及的实施文件（具体持久化契约待后续收敛后记录）。

只读：docs/product/**、docs/planning/**、docs/reference/**、AGENTS.md；其他任务及原工作区在途文件。设计仓库仅执行用户授权的远程拉取和只读审阅，不回写设计。

先接收聊天视觉/交互增量：消息复制/编辑、时间戳、流式 Markdown/表格/代码块、滚动跟随、落定 DOM 交接和无障碍状态；不接收演示素材来代替真实回复，不替换真实项目工作区页面。模型配置后续使用当前账号的服务端配置与现有辅导通道，独立聊天实现服务端真实生成与历史读取。

## 4. 已核对事实与待决策

- 设置页当前把 key 随 settings.v1 保存在 localStorage，保存没有后台 ACK；连接测试由浏览器直连供应商，学校测试为模拟成功。
- 独立 AgentPage 使用 mockAdapter；项目辅导已有真实 /attempts/:id/help 链，但不消费设置页模型选择。
- 标准宿主与本机 HTTPS 工具宿主入口不同，必须两侧接线；现有 provider 为启动时全局 DeepSeek。
- 首轮待决策包括持久化、供应商范围及生效条件；下节保存原提案与负责人随后给出的明确批准。真实付费验证仍须由使用者配置自己的 Key 并发起，未用测试替身宣称实际模型通过。

### 4.1 个人存储与调用方案（原提案及本轮批准）

2026-10-15 Robert 对 Q4/Q5/Q6 明确答复：批准上述独立库与加密凭据方案；本人保存并启用后下一次显式发送即可使用；首批只支持公网 HTTPS。该答复是本节初始化、凭据文件生成/读写和对应宿主接线的实施授权。设计已收敛，开始实施。

现有 teaching_messages 强制关联课程/Attempt/Job，jobs 要求 course_id；现有宿主精确校验 35 表，不能把独立聊天伪装成课程辅导，也不适合顺带改现有库。

提议新增个人专用 SQLite：user_model_configs（每人供应商列表、默认模型、配置版本、加密凭据）、agent_conversations（本人会话与当前分支）、agent_turns（幂等、固定配置版本、状态/截止/调用次数/usage）、agent_messages（本人原始输入与生成正文，保留旧分支）。配置与聊天重启后保留。该库与加密主密钥存于受控运行目录 personal-agent/，文件名 personal-agent.sqlite、credentials.key；本机工具宿主为 /opt/xunjie-ui-local/personal-agent/，Windows 独立运行可配置至 D 盘运行目录，不写源码目录或 .env。主密钥由服务端随机生成，AES-256-GCM 加密供应商 Key；接口只回 hasKey/掩码，输入空白保留原 Key。无新增依赖。

批准对象为 apps/teaching/server/personal-agent/** 中的四表新库初始化及凭据文件生成/读写；标准宿主与 tools/i0-hdl 的接线。现有课程库不迁移、不重建。已在隔离合成验证中初始化四表和测试凭据；没有替换现有冻结环境或触碰其课程库/真实模型 Key。

建议本人在设置页保存并启用后，下一次显式发送即可使用个人 Key，后端不回退其他账号或环境 Key；维护者保留明确总停用开关，在途请求固定原配置。独立聊天仅发送本人消息/本会话历史，不自动抓取课程材料；项目辅导继续原授权上下文与帮助政策。编辑重发只改变当前可见分支，后台保留原始回合，不截断教学证据。

## 5. 验收与实际记录

验收目标：来源增量可核查；前端 typecheck/test/build 与对应浏览器交互检查；配置保存以后台 ACK 为准、重读不返明文 key、账号间隔离；真实模式不回退 mock；独立聊天真实生成/停止/错误与历史，项目辅导消费配置并保留原门禁；模型、浏览器、合成验证分别记账。

当前执行：Design 初始干净，main 从 1655842 快进至 8df4796；首次 fetch 因全局代理 127.0.0.1:7890 无监听失败，单次 git -c http.proxy= fetch 成功，全局配置未改。

实际代码、验证及交付边界见第 7～9 节。未读取真实 Key，未发送付费模型生成请求，未迁移原课程库；交付限本地 main 提交，不推送、公开部署或改写原工作区。

产品基线及 MVP_SPEC §10：待授权维护者汇总。

## 6. 个人通道 HTTP 实施契约

本任务内接口均复用原会话、Origin/CSRF 与 requestId/data 信封；账号只取服务端 Session。

- GET/POST /api/model-settings：读取脱敏配置或保存 {expectedRevision, enabled, defaultModelId, providers, efforts?}。providers 为原 UI 供应商/模型元数据，读取只带 hasKey/keyHint；写入可选 apiKey，空白保留，clearKey 显式清除。读取含 revision、callsEnabled。默认模型标识沿 custom:<providerId>:<modelId>。
- POST /api/model-settings/test：{providerId?} 或未保存的 {baseUrl,apiKey?}，返回 ConnectionResult；服务端探测 /models，不自动发付费生成。
- GET /api/agent/conversations?includeArchived=true、GET /api/agent/conversations/:id：返回本人摘要或原 bridge Conversation（id/title/updatedAt/pinned/archived/messages/contextTokens）。
- POST /api/agent/conversations/:id：{action:rename|pin|archive|restore|delete,title?,pinned?}；delete 只隐藏本人会话，不硬删历史。
- POST /api/agent/conversations/:id/edit：{messageIndex,text,expectedMessageHash}，hash=sha256(JSON.stringify([原role,原text,原at或null]))；同事务核当前分支该位置的旧消息，过期 VERSION_CONFLICT，有在途回合 STATE_CONFLICT。更新当前可见分支，原消息仍保留；界面随后显式 retry。
- POST /api/agent/turns：{conversationId:string|null,mode:send|retry|resume,text?,requestKey}，幂等接纳后返回 {conversationId,turnId,message}，后台执行真实请求。
- GET /api/agent/turns/:id：返回同形进度；POST 同路径 /stop 保留实际部分。message 为 role:agent/text/at/phase，失败含明确 failure，禁止生成虚构正常回复。客户端有界轮询实际分块状态，展示层沿来源匀滑；每回合1次供应商调用、45秒内终结，不自动重试。

独立通道没有生成交互HTML、画像评估、自动工具或课程私有材料读取；新模型选择用于下一次发起的回合，在途固定其已接纳配置。旧请求/账号的异步结果不得污染新会话展示。

思考强度沿原 UI 低/高/最高保存，只在所选模型 reasoningLevels 明确包含 low/high/max 时用于独立聊天的 reasoning_effort；未声明支持的模型禁用对应选择。项目辅导保持原禁用 thinking 配置，不因个人显示偏好扩大教学通道。

## 7. 实际实现位置

- [个人通道服务](../../apps/teaching/server/personal-agent/service.ts)、[四表](../../apps/teaching/server/personal-agent/schema.ts)、[存储](../../apps/teaching/server/personal-agent/store.ts)、[凭据](../../apps/teaching/server/personal-agent/credentials.ts)：按 Session 隔离配置/聊天，配置 CAS，AES-GCM 的账号/供应商绑定；同账号最多一个有效独立回合，幂等接纳、固定配置快照、45 秒终结、显式停止/续发、重启未知终止、分支编辑保留原记录。软隐藏不硬删历史。
- [兼容供应商传输](../../apps/teaching/server/tutoring/openai-compatible.ts)：真实 HTTPS 请求与 SSE 增量、指定模型、输出/输入限额、实际或 unknown usage；拒绝重定向和非公网地址、固定经过校验的连接地址、忽略内部推理正文。不自动换供应商或重试。DeepSeek JSON/流式字段依据[官方 Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)与[模型列表](https://api-docs.deepseek.com/api/list-models/)。
- [宿主桥接](../../apps/teaching/server/app/personal-models.ts)、[标准入口](../../apps/teaching/server/main.ts)、[I0](../../apps/teaching/server/app/i0.ts)、[两课程宿主](../../apps/teaching/server/app/digital-logic.ts)、[本机入口](../../tools/i0-hdl/local-application-host.mjs)：均接同一服务；维护者可停用个人模型，不回退环境 Key。课程辅导在原 [application](../../apps/teaching/server/tutoring/application.ts)/[service](../../apps/teaching/server/tutoring/service.ts)固定本人配置版本；排队配置变化标 stale，在途固定原供应商，沿原 Job/权限/政策/三次及45秒校验。严格未发送的调用释放预留。
- [前端配置](../../apps/student/src/lib/modelSettings.ts)、[真实聊天适配器](../../apps/student/src/bridge/agentApi.ts)、[回合](../../apps/student/src/components/chat/useAgentTurn.ts)：同源 HTTP/CSRF、后台 ACK、配置/账号代次隔离、迟到结果拒收、错误保留原问题及部分正文。真实页不导入演示任务作为上下文，未知用量不补零或画演示容量环；准备模式显式使用隔离演示。
- [模型设置页](../../apps/student/src/components/settings/ModelTab.tsx)/供应商弹窗/输入框及独立 Agent 页消费同一后台配置。原 `settings.v1` 遗留 Key 字段移除，不自动上传给后端。UI 来源逐项映射及例外已记入 [IMPORT_SOURCE](../../apps/student/IMPORT_SOURCE.md#同步记录)。

本机系统将 `api.deepseek.com` 解析成代理保留地址 `198.18.0.103`。传输只在系统解析全部为该代理网段时，按[Cloudflare 官方 DoH JSON](https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/)重新查询公网地址，再固定该地址并保持原域名 TLS 校验；不向 DNS 请求发送 Key，不把私网/回环放开。无 Key 的真实 `/v1/models` 探测最终得到 HTTP401；这是连接可达/鉴权拒绝，不能记为模型生成通过。

## 8. 验证命令、结果及失败

| 层 | 实际命令或检查 | 结果/范围 |
| --- | --- | --- |
| 前端工程 | `npm run typecheck`；`npm test -- --silent --reporter=dot`；`npm run build` | Windows Node24.15，48 文件620项通过，类型/构建通过；保留原大 chunk 提示 |
| 后端类型/构建 | WSL root Node24.21：`npm run typecheck`；`npm run build -- --preserveSymlinks` | 通过；本轮复用已有 Linux 依赖软链，因此构建显式保留依赖符号链接解析 |
| 后端全量回归 | 已单独构建后 `npm --ignore-scripts test` | 521项，505通过、16按原条件跳过、0失败；跳过包含真实模型、C1/VM/容器及 H3 批次，不记通过 |
| 本批后端专项 | `node --test server/personal-agent/integration.test.ts server/app/personal-models.test.ts server/tutoring/test/openai-compatible.test.ts` | 最终22/22；真实 Session/Origin/CSRF、4表边界、隔离/加密、编辑并发、实际部分、停止/超时/恢复、usage、网络协议/地址、错误分型及输入预检 |
| 课程配置版本接缝 | `node --test --test-name-pattern="personal" server/app/personal-models.test.ts server/tutoring/test/student-help.test.ts` | 2/2；本人配置版本进入原教学记录，排队变更不调用/不虚增计数，在途变更仍交付原版本 |
| 本机启动/关停包装 | `node --experimental-vm-modules --test tools/i0-hdl/local-lifecycle.review.test.mjs` | 4/4；包括无环境 Key 的个人通道选项和总停用参数；原 VM 沙箱检查未重做 |
| Chrome 协议浏览器 | 现有 Google Chrome；最终 `XUNJIE_E2E_BROWSER_CHANNEL=chrome`、独立5681/5682/5683端口，`npm run test:e2e -- personalAgent.spec.ts --reporter=line` | 最终个人协议7/7（19.6秒）；另有准备模式供应商不外发1项通过。此前针对补验4/4；均为合成 HTTP 协议验证，没有冒充实际 HTTPS/模型付费结果 |
| 文档/写集 | `node tools/a0-review/check.mjs`；`git diff --check` | 静态检查及空白通过；未修改受保护基线 |

首次前端回归暴露来源 `useSmoothStreamText` 在 SSR 读取 `window`，已修复环境判定后全量通过。课程配置接缝检查发现严格未发出请求的预留未释放，修正原账本处理后通过。最初后端普通构建因跨目录依赖软链触发既有导出推导的 TS2883，未改业务代码或关闭类型检查；用 `--preserveSymlinks` 还原本地模块解析后构建通过。浏览器自带 Chromium 未安装，改用已有 Chrome，没有另装浏览器或运行依赖。

## 9. 交付与尚未执行

本批仅在独立 main worktree 完成实现和本地提交；Design 已拉取且保持干净。没有写入原工作区在途文件，没有推送、生产发布或替换当前3444冻结进程。没有新增项目依赖或改 lockfile，没有改原35表课程 schema。前端沿原 lockfile 安装于 D 盘独立依赖目录，后端复用本机已装 Linux 依赖；验证用的临时后端软链在交付前移除，依赖与构建产物不作为源码交付。

真实供应商成功生成、本人 Key 的实际页面配置/两处付费调用、冻结现场更新和真实浏览器全链路验收未执行。源码具备真实调用通道，真实失败保持失败；下一步在同步新宿主与前端后，由本人在设置页输入 Key 并显式发送验证，不把本轮协议替身、401探测或原历史模型证据升级为本功能真实通过。产品基线及 MVP_SPEC §10 仍待授权维护者汇总。

## 10. 2026-10-15 本机3444升级与本人配置验证

Robert 追加明确授权：将当前3444运行环境更新到本次 main；随后由本人在设置页填写 Key，再由本会话验证项目辅导与独立聊天两处真实模型回复。该授权覆盖受控本机应用源码、静态产物和启动工具替换/重启，以及本人启用配置后的两次合成验证调用；不扩大到生产发布、课程库 schema 变更或其他端口/执行 VM 更新。

升级目标为 main@a49993c。写入前核对实际宿主进程、路径及原35表库；保留旧应用源码/静态产物/工具及停机后一致数据库备份于受限运行目录，保留原身份、签名、TLS、配置与执行环境。新个人四表库及加密凭据按 §4.1 已有授权初始化。Key 由本人页面输入，不在聊天、命令或公开证据中读取/展示。两处真实生成在本人保存并启用后执行，工程就绪不计生成通过。

实际升级已完成：旧 PID 24784 的确切宿主收到 SIGTERM 后，核对 `/proc/24784` 消失且3444不监听，随后部署并启动新版。回滚包在受限 `/opt/xunjie-ui-local/releases/model-settings-a49993c-20261015/`，包含应用源码/静态产物/工具和一致 SQLite backup；D 盘日常启动工具另保留旧副本。课程库 schema 哈希及全部35表条数在替换前后一致，原 application-config 未变。新宿主424个 teaching 源文件与提交归档逐字节一致，前端来自该提交重新构建的 dist 并核对全部文件；未安装依赖或更新执行节点。

`xunjie-local.ps1 start` 实际返回 live/ready 均200，原 C/HDL readiness 同代际及指纹匹配、VM 已运行且未重新启动。未登录访问 `/api/model-settings` 返回401，保持原认证。个人库初始化为批准的四表，`credentials.key` 和 SQLite 均root600；核对时尚无账号配置（0行），没有模型生成。Chrome 实际3444页已刷新，显示新版原登录入口并交给本人登录/填写 Key。真实两处回复待本人保存启用后验证。前端本次重新 build 通过，保留大 chunk 提示；A0静态检查 errors=[]、diff --check通过。

### 10.1 页面保存与后台记录不一致排查

Robert 随后报告已保存并提供连接成功截图。最初仅查看 Chrome 的旧登录标签是不完整的：用户实际使用的是 Codex 应用内浏览器同源 `/#/settings/model`，账号 `synthetic-robert-student-a`。核对时个人库仍0条配置，应用内页面入口为 `/assets/index-C9P8IzGF.js`；HTTP根页面及磁盘静态目录也实际变为该构建。后端424文件与本次 main仍逐字节一致，说明偏差在静态交付，不是新版保存接口已接纳但丢失。旧前端本地配置及供应商连接成功不代表新版后台保存。

可复现判据：读取3444根页面入口脚本，断言等于已验证本批构建 `/assets/index-C0xkrcS_.js`。恢复前输出 `FAIL: live=/assets/index-C9P8IzGF.js expected=/assets/index-C0xkrcS_.js`；恢复后同一命令输出 `PASS: main frontend deployed`。变化来源/操作者未查明，不据此归因给其他会话。

将偏离静态目录完整保留为受限回滚包中的 `student-dist-diverged-before-restore/`，恢复本批归档所配套的143个前端产物并逐字节校验；未替换后台或重启服务。刷新用户实际应用内标签后，页面显示个人模型未启用、尚无供应商，符合后端0行事实。已预填公开供应商名称、Base URL和模型ID，交由本人重新录入并保存 Key；未读取旧浏览器本地 Key、自动上传旧凭据或生成模型回复。此次为运行产物偏差修复，没有源代码行为变更，原HTTP判据作为现场回归，不添加复述实现的源码测试。

### 10.2 并行现场覆盖与统一集成

第二次录入后复查，HTTP静态入口再次变为 `/assets/index-DcpLvnIQ.js`，个人库仍0行。只读核对活跃会话「实现登录与会话进入流程」的实际交付记录，确认其首页/显示名批次持续向同一静态目录发布不含本批个人接线的构建。此前来源未知结论由新证据补充，不将两次本地旧版保存记成新版后台成功。

Robert 随后明确批准“授权通知并统一部署”。已通知该会话暂停更新3444及应用内标签，由本会话统一集成两边已完成的提交。此次接收已合入远程main的首页真实分配、设计规范、原看板标记演示数据及显示名批次（origin/main@4fdf2f0）；只在本独立main工作树合并，不修改原工作区在途文件。允许解决README和IMPORT_SOURCE两处文档冲突，保留个人模型生效方式及首页真实入口、两条独立来源记录。其余合并自动完成，AppShell仍使用真实agentApi并保留显示名。新同步设计规范读作后续UI依据；不改受保护产品/规划/参考规范。完成合并检查后统一部署，再由本人在确切新页面完成凭据保存，随后验证两处真实回复。

统一合并完成于本地main@9cee9d3。另一会话终态明确“3444后续交由模型配置会话统一部署”，其PR87已合并的最终4fdf2f0已全部接收。合并后 `npm run typecheck`、49文件625项前端测试、正常build通过；A0静态检查127篇/1960链接/errors=[]、diff --check通过。新版143个前端产物逐字节核对，HTTP根页面与实际应用内标签均加载 `/assets/index-CUcnTw1p.js`；live/ready均200。后端继续原a49993c实现，没有新改动或重启，课程库/个人凭据目录保持不变。替换前静态目录保留在受限 `/opt/xunjie-ui-local/releases/unified-main-9cee9d3-20261015/student-dist-before/`，运行收据记录统一提交与index哈希。

实际设置页同时显示Robert展示名和真实个人配置入口，旧演示会话已消失，后台尚无配置。已再次预填非秘密供应商字段，待本人补入Key并保存确认；此时尚未发送真实生成请求。已有个人协议7项Chrome验证属于合并前工程证据，本轮625项测试与实际HTTPS页面为合并后新证据，不混报为两处模型生成通过。
