# I0-UI：个人模型配置、真实聊天与设计增量接入

日期：2026-10-15（Asia/Shanghai）。负责人：Robert；实施：本会话 Agent。状态：本人Key已加密保存启用；文本聊天、模型参数与跨页版本保护已部署3444并完成本轮验收。独立low/high/max和项目max已取得真实成功；附件仍未接入，范围已单独询问。最新事实见 §10.7，此前失败保留于历史记录。

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

### 10.3 真实调用诊断及完整配置生效变更批准

Robert 已完成本人Key保存，后台个人配置实际存在且启用；未输出明文Key。第一次独立调用因本会话预填旧演示ID `deepseek-v4.1-flash` 被供应商拒绝。受控只读模型列表探测HTTP200，实际模型ID为 `deepseek-flash`（显示名DeepSeek-V4.1-Flash）和 `deepseek-v4-pro`；已在实际UI修正ID，保留加密Key。随后high、low独立回合及一条项目辅导均在45秒内无正文并超时，失败保留，未冒充真实通过。额外关闭思考、max_tokens=64的底层诊断在1434ms取得HTTP200，仍于45006ms未完成正文，暂不能认定全部等待均由思考造成。

Robert 追加要求：low/high/max确实生效，设置中的模型配置全部真正实施。已说明原TECH_DESIGN §6.2与原教学通道强制关闭思考、45秒/4096输出冲突，Robert 明确答复“确认两处完整生效并采用新限额”：两处都使用本人保存的思考强度、上下文窗口与最大输出；回合最长300秒、可停止、单回合不自动重试。该批准覆盖个人通道及student_help的对应共享契约调整，保留原权限、课程上下文/政策、引用/结构/投递守卫、幂等及固定配置版本。教师/画像等非本轮通道沿旧默认，不扩大授权。产品基线仍只读，差异待授权维护者汇总。

实施写集在原范围追加：个人选型完整参数与能力校验、传输请求和真实思考状态/截断/错误处理、student_help的有界受信执行配置、对应前端状态/配置表单和专项回归。输入类型作为供应商能力声明必须校验，不能声称勾选即可让不支持该类型的供应商获得能力；未接入的附件协议不得伪装已经发送。真实调用验收与工程检查分别记录，既有失败不清除。

Robert 随后进一步要求不要没有必要的思考时间限制，此最新指令替代前述固定300秒总时长方案。按[供应商保活机制](https://api-docs.deepseek.com/quick_start/rate_limit/)和[官方客户端超时语义](https://github.com/openai/openai-python#timeouts)核对：个人通道不设总思考/回合时间上限，仅在连续600秒完全没有收到HTTP/SSE数据时判定失联；保活/推理/正文数据续期，可主动停止，Token仍按本人保存限额控制。供应商自身排队关闭/Token限制仍生效，不自动重试或换供应商。

为避免无总时限的课程Job失去崩溃恢复，在Job的已有JSON记录新增受信可选 `inactivityTimeoutMs`，不改35表SQL schema：个人student_help的deadline/lease代表滑动失联窗口，实际供应商活动按节流续期；非个人通道仍沿原45秒默认。写集追加 `contracts/records/index.ts`、`server/db/records-adapter.ts`、`server/records/jobs.ts`、`server/records/teaching.ts` 的对应类型、JSON校验及同租约续期；仍只有受信应用可创建该标记，不采信浏览器。恢复后过期租约记unknown，不重发原调用。原批准300秒曾落入在途实现但未部署，最终以本段为准。产品基线差异待授权维护者汇总。

### 10.4 三项目实现采用与供应商故障核对

Robert 明确要求核对 ZCode、Kimi Code、DeepSeek Harness 的供应商/模型配置实现，可用部分直接采用。分别锁定官方源码与许可并读正文，形成 [ZCode](I0_UI_MODEL_PROVIDER_RESEARCH_ZCODE.md)、[Kimi Code](I0_UI_MODEL_PROVIDER_RESEARCH_KIMI.md)、[DeepSeek Harness](I0_UI_MODEL_PROVIDER_RESEARCH_DSH.md) 三份研究记录。没有安装整套框架或新增依赖；未读取这三个产品的用户凭据/私人配置。它们不是同一供应商协议：尤其 Harness 的专用 DeepSeek Messages 不能原样当成 OpenAI Chat Completions。

实际采用为独立实现的小模块 [model-protocol.ts](../../apps/teaching/server/personal-agent/model-protocol.ts)：目录兼容 data[]/models{} 和多种 context/output 字段，稀疏项保持未知；DeepSeek 思考开关+reasoning_effort、Kimi 官方端点 thinking.effort、OpenAI 官方端点 max_completion_tokens，未知兼容端点沿已声明 OpenAI 参数，不堆叠多个思考字段。所有模型保存的档位均按准确型号校验，不静默降档；取消没有供应商依据的统一1M上下文输入上限，仅验证安全正整数及输出小于窗口。未复制第三方实现片段，研究记录保留固定来源及许可链接；故不引入其账号、遥测、工具循环或自动重试体系。

SSE 改为完整帧组装，支持多行data、拆分UTF-8、注释保活；区分真实推理活动与正文，不保存原始思维链；结束后无正文、输出Token耗尽、内容过滤单列失败，保留已收到正文及实际usage。JSON兼容响应同样按收到数据续失联窗口。个人课程Job同一租约可随真实活动续期，合成16分钟调用仍单次并正常完成；没有新增300秒总时限参数。

前端修复编辑供应商时留空Key误停用个人模型，以及首轮自动发送排队问题时历史查询与乐观消息重叠的竞态；在途历史由回合终态统一交接。真实模型目录可导入准确ID/供应商公开能力，手填值仍由本人显式保存。输入类型目前只保存能力声明；附件上传与协议尚未接入，真实通道明确拒绝附件，未记作多模态已实现。

Robert 追问供应商是否故障。2026-10-15 12:45（Asia/Shanghai）只读核对 [DeepSeek官方状态](https://status.deepseek.com/)：网页/API部分中断，受影响包括V4.1 Flash、V4 Pro及对话服务，状态“已定位原因，正在实施修复”；[事件](https://status.deepseek.com/incidents/7116348214287)起点为当日00:11 UTC（08:11北京时间）。这支持“此前HTTP200但无生成正文很可能受上游故障影响”的推断，不能证明每个旧失败均仅由故障引起。模型ID填错与本地45秒截断仍为本任务实际缺陷，已分别修正；[官方保活机制](https://api-docs.deepseek.com/quick_start/rate_limit/)说明空行/注释可能只是排队，并不证明正在思考。连接测试成功不当作生成通过。

本批验证：前端类型/49文件625项测试及build通过，保留原大chunk提示；后端Node24.21类型/声明build通过；全量529项，513通过、16按原门禁跳过、0失败；个人/传输/记录/core/宿主专项82/82。随后删除未部署的可选总时限参数并补课程同租约长回合验证，personal两项接缝通过；Chrome个人协议最终7/7（21.4秒），含留空Key编辑保持启用、排队问题不重复。首次浏览器补验失败包含测试把“省略Key”误期望为空串，以及确实存在的历史刷新竞态，分别修正断言和根因后通过。工程/隔离协议结果不计真实供应商恢复或两处真实回复验收；现场部署及恢复后的真实验证另记。

### 10.5 完整配置批次3444部署与恢复监控阶段验证

本地main提交为 `e65a996`。2026-10-15 12:54已按原批准范围更新3444：停止并确认旧精确宿主及监听退出；受限备份旧源码/静态、课程库一致SQLite和个人库+凭据；提交归档的426个teaching文件逐字节部署，143个前端产物来自最终build，HTTP/实际应用内页面入口均为 `/assets/index-z5pF-uDd.js`。备份在受控 `/opt/xunjie-ui-local/releases/personal-options-e65a996-20261015/`。原application-config、课程35张应用表schema和停止后记录条数、个人库及Key字节在替换前后保持一致，Key仍root600。部署检查首次把SQLite内部sqlite_sequence也计入35表，断言在源码/静态替换前停止；核对36张物理表=35张应用表+1张内部表后，原断言按正确范围修正再继续，没有删/重建表。

标准start回报live/ready均200，运行PID530；本轮start实际重新启动已准备的执行VM（vmStarted=true），沿原代际和已验证C/HDL指纹，未重建磁盘或重新认证沙箱。没有隐去此次VM启动，不能沿用上一批“VM未启动”的历史结论。原Key无需重录，实际页面显示密钥已保存/个人模型已启用。临时后端依赖软链与D盘提交归档已移除，未删共享依赖或回滚包；工作树仅在main提交，无推送/公开发布。

随后官方状态变为Monitoring（“已实施修复，正在监控结果”，仍未标全恢复），据已有本人调用授权进行合成验证，旧失败原样保留：

| 通道/档位 | 实际对象 | 实际结果 |
| --- | --- | --- |
| 独立low | turn `f887b605-12ee-449f-99d9-d5a107ca1707` | settled，一次调用，70字真实正文；实际input117/output492；deadline=null，保存的context300000/output131072进入配置快照 |
| 独立high | turn `f1d9d5d2-9ca3-4320-83c7-558ea1ee8926` | settled，一次调用，40字真实正文；实际input204/output306；同一模型与保存Token配置 |
| 独立max | turn `5734d378-d682-402c-af81-bf7a76050335` | failed，DEPENDENCY_UNAVAILABLE/network，无正文、usage未知；一次调用；deadline=null，没有触发本地idle超时 |
| 项目high | Job `001ee073-3d52-4ef8-9984-c6132531bb23` | 12:56:17接纳，最终failed/unavailable，无新增模型回复；一次调用，滑动idle600000已持久化，终结早于其05:06:17Z失联窗口；原问题配置版本personal:0bc7e863c307d958c037948a:9 |

两处均只提交已批准开发合成问题；未修改/保存/冻结/运行学生作品。项目原始历史（包括旧重复问题和超时）保留，不算新配置真实成功证据。low/high正文与max/项目失败均在实际HTTPS页面核对；另一次无Key的非计费/models连通诊断1446ms返回401，说明该时刻地址可达，不代表生成恢复。13:00复核官方仍为Monitoring；没有后台自动重试，未持续反复发送付费调用。已恢复验证前low个人默认值，Key及300000上下文/131072输出保持。官方恢复与本地缺陷修正同时发生，不能由此次成功单独推断此前问题只有一个原因。max与项目真实成功、多模态附件仍未验收；未标完整功能完成，后续恢复后分别验证。

### 10.6 继续验收与跨页面模型选择一致性

Robert 随后报告最高档手动发送成功，并要求继续后续工作。只读核对新增两个成功回合（38abaa6a-b238-4306-8767-34ab6ca9c8db、88900991-5e4e-425b-b89e-4f9e5f9c76a7）：均settled、有实际usage，但其固定配置快照为low/revision11，与“最高”自述不同；保留两者差异，不把这两条当max出站验收。没有读取或重发本人原问题。实际浏览器另有多个页面，当前缺少跨页同步且接纳接口不校验发起页看到的配置版本，存在显示旧选择、实际使用服务器新选择的窗口。

在原“配置真实完整生效、两处接线”已批准范围内补救：为两处接纳请求添加可选expectedModelConfigRevision，正常前端携带已确认版本，后台幂等重放后、记录新问题及计费前核对；过期明确VERSION_CONFLICT并刷新配置，保留原问题，禁止悄悄换档发送。新增跨页非秘密配置版本通知与回焦重读，继续后台ACK/账号代次隔离/在途快照；不广播密钥或完整供应商配置。旧调用方不传该字段保持兼容，原课程政策/版本/账本/35表schema不变。针对旧页显示max而服务器已low的红绿验证先行；后续实现、命令和真实结果追加，不把本段方案写成已完成事实。

补验实际成功：独立max turn `736fdeab-d647-4331-90c6-8aa03bd8d1b1` settled，一次调用、45字真实正文，实际input276/output736；固定快照为reasoningEffort=max、context300000/output131072、deadline=null。项目max Job `5b95f95f-4965-41d7-ab6d-9ad60152f57a` succeeded，原模型Message `7dcdd555-df76-479c-b44e-d7fa8877de12`，modelConfigVersion为personal:0bc7e863c307d958c037948a:12，与当时保存的max一致；一次调用，实际input1827/output1073，elapsed7329ms。实际HTTPS页面核对完整正文、原Job/Message和来源；项目只发送获准项目目标/资料与未知学习者状态，没有假称已读未选择的源码，不修改/运行学生作品。

跨页修复已实现：[modelSettings](../../apps/student/src/lib/modelSettings.ts) 仅广播账号ID/配置revision，另一页重读，回焦重读；[独立发送](../../apps/student/src/bridge/agentApi.ts)、[项目发送](../../apps/student/src/workspace/tutoringWorkspace.ts) 携带配置revision，后端 [个人服务](../../apps/teaching/server/personal-agent/service.ts)/[辅导接纳](../../apps/teaching/server/tutoring/application.ts) 在新接纳前核对。共享可选字段同时加入 [辅导类型](../../apps/teaching/contracts/tutoring/index.ts)，不改SQL schema。配置冲突明确分型，原问题保留；新会话和已有会话均只能由本人显式重试未发出的原问题，不误重试上一个已回答问题，也不先调用供应商再发现冲突。

验证：独立/项目stale新增红例最初均400而非409，加入版本校验后5/5相关检查通过；个人服务最终16/16，含配置变更后的原幂等重放仍返回原回合。个人+宿主+课程专项48项，45通过、3项原真实门禁跳过；Node24.21类型/声明build通过。前端625项通过；最终Chrome个人协议10/10（24.9秒），含跨页通知、stale保留原问题、首次/已有会话显式重试恢复。扩展新会话重试时发现原页面只在已有conversationId时挂重试按钮，已修复并通过；未放宽原断言。前端最终正常build通过，入口index-stSs7RFV.js。A0与现场同步结果后续记录；产品基线及MVP_SPEC §10仍待授权维护者汇总。

### 10.7 配置一致性批次最终部署与真实闭环

本地main代码提交 `b9b192e`。13:24受控更新3444，确认无queued/running/cancelling Job及独立在途回合后停止原精确宿主，备份旧源码/静态、课程一致SQLite、个人库+凭据于 `/opt/xunjie-ui-local/releases/model-revision-b9b192e-20261015/`。归档426个teaching文件与143个前端产物已核对；入口 `/assets/index-stSs7RFV.js`。配置文件、原35表schema及替换时条数、个人DB/Key字节保持一致，Key仍root600。短时WSL存活进程跨越替换窗口，标准start确认vmStarted=false，同代际/原C与HDL指纹、live/ready均200，没有重建/重启执行VM。D盘临时归档和依赖软链已移除，回滚包保留。

最终代码部署后实际应用内两处页面均刷新到该入口；最高档保持revision12。再次各显式发送一条获准开发合成问题：

| 通道 | 实际对象 | 终态及实际供应商用量 |
| --- | --- | --- |
| 独立max | turn `fbb3cf28-cf0d-47e9-91de-60f1e865cbd2` | settled，29字正文，一次调用；input338/output541；快照max/context300000/output131072/deadline=null |
| 项目max | Job `00155754-d83c-4c2f-be36-fd6800add85d`，Message `e1463a3c-0edb-4084-ae8b-6ef75d6f4ea9` | succeeded，完整有界自检提问已在页面核对，一次调用；input1839/output1540；elapsed9782ms；原模型配置版本personal:0bc7e863c307d958c037948a:12 |

用已知合成问题和非秘密请求字段重算两处持久化request_hash，均与含expectedModelConfigRevision=12的精确请求一致，确认最终前端实际携带该字段；没有仅凭UI标签认定。两处截图留在本机任务证据目录，实际正文/原始Job与Message关联均可回读；未把已接收/背景截图当成学生阅读、理解或主动回应。保留用户自己的两条成功记录及所有旧失败，不把用户手动记录重新标成max。

当前交付结论：按账号加密Key、默认模型/思考强度/上下文/输出限额、真实流与停止、原幂等/版本/权限/教学守卫，以及跨页面选择一致性均已接通验证；两处个人通道不设总思考时限，仅失联窗口，单回合不自动重试。DeepSeek外部间歇故障仍可能发生，本轮成功不承诺供应商稳定性。图片/视频/PDF目前仍是保存的能力声明，实际附件发送未实现；已单独向Robert询问是否纳入下一步，不将附件计入本轮通过。未推送、公开发布或改受保护产品基线，维护者汇总待授权处理。

### 10.8 图片附件追加授权与实施范围

2026-10-15 Robert 对“实际附件发送尚未接通，是否本轮接入”的明确回答为“本轮再接图片附件”。本段是追加实施依据，不覆盖此前真实文本验收。沿用独立 Agent 聊天页已有附件入口，接通 PNG/JPEG/GIF/WebP 图片选择/拖入、真实内容发送、本人历史回显、纯图片提问及重试/编辑保留原图；视频/PDF不在此次追加范围，项目辅导保持既有文字和受信课程上下文。

依据复读：PRD §5～8（PRD-03/09/10、学生控制与数据归属）、MVP_SPEC §3 M-03/M-04（主动发送与故障保留）、TECH_DESIGN §6.1/6.2、§9/10（作用域、模型失败及小型二进制持久化）；沿本任务已批准的个人通道差异。UI依据为I0_UI_SPEC、I0_UI_CLIENT_CONTRACT §2/3、IMPORT_SOURCE及DESIGN.md，保持原输入框和消息气泡设计。

方案：图片与文字一起在既有个人消息JSON中原子保存，不加表、不迁移35表、不新增供应商Files存储或依赖。客户端传受限base64 data URL，服务端校验真实格式/尺寸/长度；图片只进入user的标准image_url内容块，不抓取外部URL。读取继续本人会话归属校验；重试使用持久化原图，切换到未声明image能力的模型须在计费前拒绝，不静默丢图。取消真实入口的模拟上传进度，读文件失败保留原输入。

公开一手依据：[DeepSeek Vision](https://api-docs.deepseek.com/guides/vision/)、[Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)。内联单图32MiB、请求48MiB；DeepSeek另按600图/8192边长（15图及以上4096）核验。base64字节不当作图片Token，DeepSeek用官方每图1024上界预检，其他兼容供应商的图片Token由其返回实际usage，不伪造精确估计。

写集追加：personal-agent图片协议/校验与消息投影、OpenAI兼容传输、student桥接类型/回合/输入框/消息展示及对应专项测试；当前任务和学生运行README。只读产品/规划/参考/AGENTS。验收：非法或不支持图片不计费且不留下半条问题；真实请求含原图；幂等/权限/重试/编辑/刷新恢复；浏览器通过真实入口发送无答案提示的合成图片并由实际模型识别，保留失败。产品基线仍待授权维护者汇总。

实现已补齐 [图片校验](../../apps/teaching/server/personal-agent/images.ts)、[原子消息接纳](../../apps/teaching/server/personal-agent/service.ts)、[客户端实际读取](../../apps/student/src/lib/chatImages.ts)及原聊天组件。图片-only乐观消息不依赖文字真假值；编辑只改文字并保留图片；排队/配置冲突重试携带原图。真实模式取消假上传动画，文件实际解码失败保留原输入与附件，离开组件释放缩略图URL。服务端只允许内联四种栅格格式，校验base64、格式头/容器及尺寸，不接受远程图片URL；完整解码由浏览器和供应商分别执行，不声称只靠文件头能证明所有压缩内容有效。已知DeepSeek准确Flash型号允许视觉，避免将不支持视觉的Pro当作已接入。

工程验证：服务端图片接纳红例最初400（协议尚未接通），实现后纯图片/原始字节/幂等/修改分支/权限/文本模型拒绝通过。新增超过默认1MiB的合法PNG请求及服务重启持久化通过。最终Node24.21类型、声明build通过；个人/传输/宿主/student_help专项65项，62通过、3个原真实批次门禁跳过。前端类型、625项测试及正常build通过，入口index-DjFSQclc.js；Chrome个人协议11/11（35.9秒）。首次浏览器图片测试因所选1像素测试PNG本身无法解码而失败，换成自行生成且CRC正确的PNG后通过，未绕过图片解码检查。原Vite public资源提示与大chunk提示保留。A0 130篇/1973链接/errors=[]、diff空白检查通过。实际3444部署和真实视觉回复尚待下段追加，工程检查不冒充真实模型验收。

### 10.9 教师版本协调、图片部署与真实验证

图片代码已提交本地main@56e7111，尚未部署时收到“设计教师端 UI”会话通知：它已按Robert另外批准的范围将本机课程库从35扩至41表，先前按另一主线同步时漏保留本会话已交付的个人模型接线。没有从本工作树再次覆盖运行目录或回退其数据库。Robert在本会话明确批准“授权协调并统一更新”，随后将完整固定基线025598d和图片56e7111交由教师会话统一合并、构建、部署；本会话仅做合成真实验收。Git来源为9dbe89f（接收个人基线）、a57e37f（接收图片）→613e586（教师整合）。本工作树main已ff-only到613e586；个人服务/传输/记录/模型前端与56e7111之间无差异，受保护基线和依赖清单亦无差异。协调不扩大对PAHER或个人密钥的操作范围。

教师会话给出的统一运行回执：sourceHead `613e5865e9f3ba4a9e5da11691a1b676a9256815`，PID2728，实际前端index-CY3WoEYu.js；严格TLS live/ready200，个人revision12/callsEnabled=true，教师模型总开关false。受限部署收据位于 `/opt/xunjie-ui-local/evidence/teacher-unified-cutover-2026-10-15T05-51-36-036Z/deployment.json`，SHA256 `eea26223961d5fb83027831c829e3be544e503aae42bd8e7a7b89d4c26553505`。其统一前端641项单元/20项教师和个人Chrome协议、类型和build通过由部署会话负责；不冒充本会话重新执行了641项。本会话实际浏览器重载确认该index，后台只读确认41表与个人Key字节和原备份一致，没有迁移或重建个人4表库。

2026-10-15 13:57～13:59（Asia/Shanghai）实际HTTPS页面完成：

| 验证 | 固定对象 | 实际结果 |
| --- | --- | --- |
| 独立max图片识别 | turn `365623f3-f3ad-47e3-96b0-7fd75548aa6c`，conversation `b0dedaec-7733-43cb-bcc6-da8682dd6bc3` | settled，一次调用，回复“47；圆形”与合成图黑色47/蓝色圆形一致；实际input337/output87；配置max/context300000/output131072/deadline=null |
| 统一版项目max | Job `06121531-a28e-4c5d-a1da-2608c26c79ac`，Message `1186a72b-13e7-4e14-945b-7e1273f5c0e6` | succeeded，一次调用，完整自检问题可读；envelope配置版本personal:0bc7e863c307d958c037948a:12；实际input1838/output1767，elapsed11046ms，原Job仍按600000ms失联滑动续期 |

图片是自行生成的3597字节PNG，文件名vision-fixture.png，问题未提示答案。后台消息保存的原图与选中文件逐字节一致；用实际消息和图片重算接纳request_hash，确认包含expectedModelConfigRevision=12。浏览器刷新后原图、正文、最高档与实际用量仍恢复；没有以连接测试或文件名代替视觉识别。图片测试的自动化输入出现问题文字重复，保留实际消息与哈希，不改历史，也未额外付费重发；这不改变所问内容或图中答案。

项目只重读当前依据后发送获准合成问题；main.c仍v3，不编辑/保存/冻结/运行作品，不点“我先试试”。教师反馈使此前旧action按原规则stale，历史明确保留该状态；新回复依当前basis生成，浏览器显示来源/原Job/Message并发生本机展示回执，不记作真人阅读理解或接棒。两处截图和合成图留在本机任务证据目录，未入库Key或完整运行配置。教师会话后续仅做静态窄屏CSS修正；最终静态head/index另记，按代码差异核对后只刷新已有结果，不重复计费。

本批图片范围已完成真实链路；视频/PDF未接附件，项目辅导维持文字及原受信课程上下文。供应商间歇故障仍可能出现，未把一次通过记为稳定性或完整教学效果验收。代码未由本会话推送/公开发布，产品基线差异仍待授权维护者汇总。

最终静态收口：main已ff-only到 `5d9c5e97271a43ae11dde2f69260477261adc223`，相对613e586仅教师CSS换行、材料文案及其任务记录。教师会话static-only同步154文件并逐SHA核对；入口index-B66OM0mG.js，index.html SHA256 `280c205e362469e57a489c5379c88b35fe9d4a66cb14ea8dc60d058f562472bf`。受限收据 `/opt/xunjie-ui-local/evidence/teacher-static-only-2026-10-15T06-02-32-522Z/deployment.json`，SHA256 `687dde42faddddb279ef63e1293dc679ad8bc7d072d22ea479771eb085e9f3d9`。后端仍613e586/PID2728，无重启、库/Key/模型参数变更。

最终刷新曾回到登录页：教师会话明确确认其在同localhost共享IAB中常规退出，使本会话Cookie失效；不是静态回归或数据丢失。本会话沿已批准合成账号重新登录，只读取原受控合成凭据，经既有seal-local-credential加密中转后仅在内存解密填入原站点；临时公开接收公钥和密文文件已清除，没有明文落盘或输出。两个实际页面重载均确认index-B66OM0mG.js，已有图片/“47；圆形”及项目完整正文/原Job/Message恢复，无新增付费调用。最终截图覆盖为该入口，两页保留可直接查看。本轮临时后端依赖软链已移除；本工作树仅提交本任务验收记录，不收他人.zcodeignore或在途工具修复。
