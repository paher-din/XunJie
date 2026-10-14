# I0-UI：真实 HDL 页面与浏览器闭环

日期：2026-10-14（Asia/Shanghai）。负责：UI / Robert；实施：当前 Agent 与三个分工子 Agent。状态：实施中。

## 1. 要求、基线与已读依据

Robert 本轮明确授权先合并 PR68，再完成真实 HDL 页面接线和完整浏览器验收，并适当委派。PR68 已按确切 head f8e639c 普通 merge，合并提交 `8ef9dc0d438797cd14298d8fe02c373a0e626e10`；源分支保留，公开回读 merged=true。本任务在同一独立工作树的新分支 `codex/ui-hdl-real-browser` 从该 main 开始，不修改用户主目录的并行工作。

已读取 README、AGENTS、PRD §4.2～8（PRD-03/04/05/09/10），MVP_SPEC §1.4、§2、M-03～05（DL-AC-01～09、AC-03/04/06/12），TECH_DESIGN §7.3～7.4、§8.5（版本、原回执、有限持续仿真）；既有 I0_UI_SPEC、I0_UI_CLIENT_CONTRACT、IMPORT_SOURCE 与本人 UI30 操作表沿原记录，实施者补读其适用正文。当前要求直接消费 [C 的 PR67 回交](https://github.com/paher-din/XunJie/pull/56#issuecomment-6169341548) 与 [立即 UI 接线要求](https://github.com/paher-din/XunJie/issues/30#issuecomment-6170192513)、仓库 [H4 接线包](DLA_H4_UI_HANDOFF_20261014.md) 和已有 [UDL 操作表](I0-UI30_HDL_OPERATION_MAP.md)，不重制表或重审成熟服务端。

## 2. 写集、实施分工与边界

- 主 Agent：现有 `apps/student/src/pages/PrepWorkspacePage.tsx` / `TaskRoute.tsx` 的真实课程分流及集成；`workspace/contracts.ts` / `init.ts` 的既有 Activity 公共投影读取；需要时编辑/文件语言适配；新 `useHdlWorkspace.ts`；页面集成/故障/端到端用例；本任务记录、学生运行 README 与根 README 的必要入口。
- HDL 客户端子 Agent：新 `workspace/hdlContracts.ts`、`hdlWorkspace.ts`、`hdlStore.ts` 及专项测试；复用原冻结命令/HTTP/confirmation outbox，必要时仅扩充 `frozenCommand.ts` 命令种类与原存储读取支持，不新设服务端接口或本机 DB schema。
- 板卡组件子 Agent：新 `components/workspace/HdlToolArea.tsx` 及专项测试；现有 CenterToolArea 的 board/wave/run 注入槽，严格消费真实四态帧/时间/coverage，禁止 SEGMAP/本机计数器代算输出。
- 辅导子 Agent：原 `workspace/tutoringContracts.ts` / `tutoringCommand.ts` / `tutoringWorkspace.ts` / `tutoringEvents.ts` / `useTutoringWorkspace.ts` / `tutoringStore.ts` / `tutoringHistory.ts`，新 `tutoringHdl.ts` 与 `components/workspace/TutoringPane.tsx` 的显式 hdlSelection、冻结 basis、原 accepted hash、来源/当前性适配及其专项测试；不改任务页面或 HDL 客户端文件。

代码接口和公共状态由主 Agent 汇总协调，子 Agent 不提交/推送/操作现场。只读：产品、规划、参考、规范、A/B/C 代码/任务、他人 UI 任务。保留原 C 与准备模式、原布局/框架/依赖/锁文件；不接私有 H3 向量或后置 course_check，不改 schema、账号、密钥、认证规则、节点镜像/指纹/GRUB 或旧模型预算。

现场工具新增本人 `tools/i0-hdl/`：独立固定3444网关（复用原TLS/pin/静态和头部规则，不改共享3443工具）、限定SSH PermitOpen updater、双合成账号的RSA seal、PAHER同原业务宿主的ModelProvider RPC适配与本机模型worker/队列读写测试、README使用及去敏manifest。批准和模型key位置按§4.3更新，全部可复用工具/本机产物留D盘；本机key不会进入包或源码。主Agent另维护源/产物固定打包/入口脚本和必要只读现场校验，不把秘密/原运行配置写进Git。

现有现场为原 3443/24表 C 与 3444/35表 HDL；此次新验收应在统一35表宿主接两课程，避免不同端口同名 Cookie 互相覆盖。账号 B 的获准内存领取、3444窄 SSH 通路和新一轮有界模型预算需列确切方案与授权，先做不依赖其批准的源码/隔离/降级验证；不冒用学生A通道、旧已消费模型批次或历史提示作为新当前提示。

## 3. 验收与交付

UDL-01/02：正常获准 HDL Assignment/bootstrap，原 `.sv/.v` 编辑/确认 ACK/快照及刷新恢复；原 C 不回归。

UDL-03/04：真实 Build / 原 Job / 失败精度定位、成功后显式装载 / 原持续 Session，替换核原实例退出；失败/等待/unknown 保持原状态。

UDL-05/06：16 SW / 5 按钮按下松开 / resetN / 显式推进；LED/AN/SEG/DP/X/Z、精确模拟时间、有限 Trace 与覆盖来自原返回；pending不追加交互，停止须确认，刷新不隐式重建，未知原幂等键核对。

UDL-07/08：显式同快照 hdlSelection/ObjectRef、服务端冻结 basis 和 C3 来源/当前性；正文确实可见渲染后才 displayed，真人明确动作后才 acknowledged。新草稿、序号/停止/替换变化使旧引导失效；模型不可用仍能编辑/保存/仿真。

同一实际浏览器：合成开发账号错误编辑→确认快照→真实失败诊断→获准真实 Agent 提示展示→显式自行修订→新构建/装载→同输入输出改变→确认停止。保留固定源码/产物/引擎/原ID/版本/回执、截图、通过/失败/未执行；合成工程操作不计真人学习或教学效果。DL-AC完整条件/原AC/NFR/真人、H3目标节点与完整矩阵分层记录，产品基线及 MVP_SPEC §10 待授权维护者汇总。

完成相称客户端/组件/集成故障测试、typecheck/build、必要 C 回归和实际浏览器用例；不重复已交 C 服务端/模型批次。仅提交本人写集和任务记录，推送新的可审查 PR 并回交 #30/#38，不自动合并新功能 PR 或关闭 Issue。

## 4. 实施与现场事实

待随实施补记具体代码、命令/结果、中间失败、批准和未完成项。PR68 合并回执保留在本机工具目录，浏览器旧 b7 产物仍是旧批次，不自动转为本任务新源码证明。

### 4.1 原评论逐项完成与回交核对

Robert 本轮追加询问 [原执行评论](https://github.com/paher-din/XunJie/issues/30#issuecomment-6155068633) 是否全部完成、是否按要求回交。结论：尚未全部完成；原回交已公开，但不冒充所有门禁通过。

| 原要求 | 当前实质状态 | 回交与仍缺项 |
| --- | --- | --- |
| §1 浏览器位置/version/profile、窗口、信任、内存领取、正常登录/合法入口方案 | UI30 本人任务§4已列实际对象/来源/许可与现场事实；Chrome配置名称来自连接元数据，磁盘profile目录未读取；没有猜Default | [#30固定回交](https://github.com/paher-din/XunJie/issues/30#issuecomment-6169702024)，C方案沿其公开回交；未取得A逐人组合签认，不记“A已正式复核” |
| §2 身份→恢复→确认保存/ACK/快照→原Run/Stop/历史分批接线、H-01～06状态 | 正式UI已交，原24表的本轮合成浏览器实际验证/原对象核对已交；每个H明确限定覆盖，保留首次Stop迟到等失败 | PR68已合入；原24表本批未覆盖自然会话到期、实际多账号/多标签/换代际/离线丢ACK/教师暂停等，既有隔离证据不冒充本批现场；完整AC/NFR/真人继续#22/#23 |
| §3 UI交A/C/B的全部HDL操作/接口/版本/状态/已有模拟缺失表 | 全部操作已核真实协议，UDL-01～08缺项明确；固定805c76a的表保持，当前服务端已合入 | [#38固定回交](https://github.com/paher-din/XunJie/issues/38#issuecomment-6169700560)，#30已给共用入口与链接；原要求是#38“或”原#39，无须复制整包到二者 |
| HDL真实页面与同浏览器错误→引导→修复→重装演示 | 原评论§3要求表/方案，较新负责人要求扩大为立即真实实施；本轮正在实现，之前没有完成 | 本任务实现和现场证据完成后追加固定SHA/PR、环境/正常入口、对象/版本/回执及失败/未执行至#30/#38；不因表回交或PR68合并关闭原卡 |

每份回交包含固定源码/PR、H编号、环境/启停与去敏证据链接；没有将未完成项写成通过。原C20项、H3样例/共享接缝和A证据实审仍由原域交付，不重新计作UI工作。

### 4.2 当前现场接通提案（待准确批准，不当作已执行）

[C最终现场回执](https://github.com/paher-din/XunJie/issues/30#issuecomment-6170632785)已核：原3444/35表active服务为 `xunjie-dla-ui-main-87edd51-20261014.service`，源码 `/opt/xunjie-runner/tests/dla-main-fixed-87edd51-20261014`；原3443/24表仍固定f761dcd。维护SSH已实连；此前probe仍探旧已停unit而返回false，另读当前unit证明是旧探针对象，不冒充真实ready失败。

页面新源码/typecheck/build与正常模式隔离浏览器链已具备，现场剩余提案如下：

1. 仅 PAHER 的现有 `Match User xunjie-tunnel` 的 PermitOpen 追加 `127.0.0.1:3444`（保留3443），ForceCommand说明同步，先备份/sshd -t再正常reload。p3148的PermitOpen none、其它SSH/防火墙/密钥不动。本机新增loopback14444→PAHER3444与本机HTTPS3444网关，复用原确切TLS叶子/公钥pin/CurrentUser信任，不新增信任、不绕TLS。网关只本人固定新前端dist/API透明转发，原3443网关/别的并行浏览器工作不覆盖。
2. 原35表仅 `synthetic-i0-student-a` / `synthetic-i0-student-b` 的已有密码，经原PAHER root只读initializer、维护SSH和临时RSA-OAEP-SHA256密文进程内存通道，送入本机正常3444登录表单；没有新账号/口令重置/明文文件/日志/聊天。C/HDL同一35表浏览器分别核本人分配。操作只限合成开发作品/控制，不计真人学习。
3. 只在该35表的既有HDL Attempt `54bb4cfc-5d64-42a2-a1c9-58ea58458705` 为一条新 `student_help` Job 临时启用原DeepSeek Flash：最多2次外部HTTP（首轮及原政策允许的一次结构修复），SDK maxRetries=0，每次原输入上界16000 tokens/output上限4096。引用既有模型key在进程内存，不修改秘密/认证/数据库/教学政策；本轮持久计数防restart重复费用，不复用旧耗用标记。原3444服务无活跃工作后短暂停/启动同源码、同库/配置/原消费者，只加这个限定适配器；完成后恢复预算false的原unit并严格核ready/停止。C1 VM和镜像保持。

以上凭据目标/SSH新目的端口/新付费轮次不在旧3443学生A单轮范围内。对应文件和使用入口会保留在本人 `tools/i0-hdl/` 与本机D盘工具目录，只有获准后才实际修改SSH、领取新身份/启动付费适配；纯实现/隔离验证继续。

### 4.3 本轮负责人批准与当前实现核验

Robert 已明确批准上述限定接通/合成验证范围，并答复“全部批准，不需要设上限”。本次不再设额外费用上限；范围仍为本任务原35表合成账号与HDL浏览器链，应用本来的单Job调用、token、政策、版本和隔离限额保持。密钥仅在PAHER受控进程引用，不取到聊天/代码/commit/证据；若已有引用确实不存在才报告事实，不猜新key。原确认不重复请求。

随后 Robert 明确改为“在我的电脑上做，我要用自己的api key”。以上使用PAHER现有模型key的方案被取代；该文件只核过存在，没有读取正文/复制或使用。本轮改为本机有界原 B SDK 模型worker，API key只在本机进程读取；PAHER同原35表服务通过已批准维护SSH、本人root/0600任务RPC目录传获准B请求及结果，保持原生成前后/Job/政策/版本/ C3复核。不是浏览器直连模型，也不把本机生成体直接冒充teaching.delivered；无需新增反向隧道/端口或复制签名秘密/迁库。模型预算按最新本人key授权，原3444/账号通道批准不变。

当前主集成typecheck/build通过；全前端单元最初554/554（客户端随后加1项），子Agent正常模式Chrome隔离协议4项均执行通过（最初三项统一3/3、后续布局/求助专项各1/1，不累加成单轮5/5）。默认Playwright Chromium缓存缺失的首轮未启动失败保留，改用本机现有Chrome，无安装。辅导独立复查发现父传BuildView而非Build.result、代码求助缺同快照selection、轮询耗尽持续publish三项已修；真实数据/模型/现场尚待验证，不将这些隔离结果记为PAHER通过。

### 4.4 最新执行位置裁决：全部迁到 Robert 本机

Robert 随后明确要求“搬到我的电脑上，在我电脑上完成”，取代§4.2–4.3的 PAHER HDL 执行与本机模型 RPC 接线路线。停止新增PAHER SSH端口/临时模型服务部署，不读取或复制PAHER模型key。先核本机虚拟化、原C1镜像/源码与可搬材料，拟在D盘独立目录保留全本机前端、正常业务服务、专用执行VM和本人模型key入口；不修改并行主checkout、既有3443服务或PAHER冻结节点。API key只从本机环境在进程内使用。

已读C1第1–9节、TECH §8.1–8.5正文：执行必须在专用Linux节点/VM、原digest/资源限额/认证和终止判据下运行；不能把Windows/个人WSL直接执行HDL写成正式C1验收。新本机节点身份、镜像/内核/有效cgroup/seccomp和原sourceHash分别核验、重新形成真实就绪证据，不沿用PAHER的旧指纹/验证通过记录。具体资源、迁移对象与原始状态在核查后补记；新身份/秘密生成、受保护配置、数据库初始化等须有精确覆盖范围，先完成不依赖该确认的实现与迁移准备。

额外长pending检查发现远端操作pending被用于禁用“核对HDL状态”，自动轮询60次耗尽后无法按通知手动续读。父页面现将只读按钮的busy限定为本机读取/发送正在进行，原Build/Load/输入仍按远端pending禁写。对应长pending/显式续读浏览器反例由本批隔离协议检查，不改生产限额或伪造真实节点结果。

### 4.5 本机完整迁移已批准，进入实际搭建

Robert 已明确答复“批准上述本机完整迁移及验证范围”。对象为本机现有Ubuntu WSL2内必要QEMU/cloud-image组件（已模拟24新增/0升级/0删除）、新 `/opt/xunjie-runner` 专用2CPU/4GiB/20GiB VM与两套SSH身份/guest host身份；新 `/opt/xunjie-ui-local` 内签名secret/合成口令/config/原35表新合成库/TLS确切本机叶子受限复制。模型使用本机既有 `DEEPSEEK_API_KEY`，仅本机临时子进程env/WSLENV，不写key文件、argv或全局env。保留本机并行3443及PAHER原环境，正常新入口3444；原API、四个固定OCI、7f4ec冻结runner/资源限额与新实际指纹验收分别核查。新库与节点不接纳PAHER旧对象/代际/validation passed作为本机权威。

部署写集追加本人 `tools/i0-hdl/local-node-setup.*`、`receive-frozen-images.*`、`seed-local-courses.mjs`、本机正常应用宿主/Windows入口及README。节点Agent独占本机 `/opt/xunjie-runner`；镜像Agent仅接收原非秘密OCI档到本人D目录；教学seed Agent仅原本机教师认证API的两课程发布/分配工具；主Agent独占 `/opt/xunjie-ui-local` 业务宿主/本人key桥接/前端冻结产物/浏览器与最终回交。不编辑A/B/C原源码/保护文档，不在个人Docker或WSL宿主直接执行学生程序。

已经实际完成的准备：WSL内核6.6.87.2、systemd、vmx、`/dev/kvm` 和 KVM_GET_API_VERSION=12核查（没有创建VM）；公有Cloud/Node/Docker三档合计743,093,816 bytes接收逐size/SHA匹配，保留D目录收据；9fa76ad的runner/contracts公有Git archive 460,800bytes/SHA256 cfc0ab0c4b931cb012e39888491d138446d4f9bcfd98504949be63fd099a3468，主Agent逐Git blob复算34文件sourceHash精确7f4ec4f3d3ce420c41265f0011746557424ded9630f9b2b53e9833d382677852。没有复制PAHER guest磁盘/种子/密钥/数据库/ledger/旧passed。

当前UI typecheck、生产build和42文件555单元全部通过；正常Chrome隔离协议共7个独立用例已执行（前4项，随后长pending/迟到Assignment/键盘3项），新长pending最初失败如实留存，修复只读按钮与可见notice后单项1/1复验通过，其它已通过项不反复累计。最新dist主入口index-VCYCL3rF.js；这仍是开发协议验证，不是本机C1/模型/正式浏览器通过。本机节点、35表业务与真实演示正在搭建，后续实际状态另记。

### 4.6 2026-10-15：本机节点与业务库准备结果

本机Ubuntu安装实际0升级/24新增/0删除；新VM为kernel6.8.0-142-generic、Node24.21.0、Docker29.8.2、runc1.5.2、cgroup2、overlay2、swap0，原AppArmor `xunjie-dlc-v1 (enforce)` 持久载入；实际没有9p/virtiofs/drvfs共享挂载。新guest host公钥由本人serial通道固定，新双SSH身份仅本机root700/600。四OCI完整档1,917,330,944bytes/SHA2564645f0b0aaa2ad2c3030cc2dc8cecc3b41aded0893c7537023069f09d3175ee3；43条TAR记录/15层逐config/diffID校验，镜像反例4/4通过。最初接收90秒超时部分档没有加载；真实源readiness确认C runtime765d51df…fe99，早期清单e658候选是历史值，现据原当前节点修正。仅接收非秘密OCI，不拷原磁盘/库/账本/密钥/旧passed，不改PAHER环境。

原C验收首轮因搬运漏相邻公有HDL测试fixture而有3项失败，补固定9fa原blob后：guest58总/55通过/0失败/3明确跳过、真实应用/维护SSH10/10、strict类型退出0。HDL工具第一轮真实HDL10/10后C部分因本人setup的umask077使公有测试输入65534不可读而失败；仅恢复公有验收子进程原umask022，密钥/config权限保持。最终完整HDL工具真实10/10与C52总/51通过/0失败/1guest SSH明确跳过，并登记新实际validation；不把分轮重复或跳过累计成全仓通过。C指纹2ce8cb3324b8001a5e3929baf21e5b802b09b4aba82fa7c6ab2e93ecf67b9dcf，HDL指纹ed41d6ee92874c8a96bdb9530e28f9735f9e80005079708f358382ee5785c99d；受限应用key原readiness/hdl_readiness双ready=true、同代际synthetic-generation-c6772623-ba28-4c50-a853-337f77382452。原始失败与通过日志/实际node receipt留本机D目录。

本机业务副本的原lock npm ci70包、SQLite :memory:原生probe、Node24.21类型/构建通过；没有编辑原依赖/锁文件。原35表工厂实际创建新库，三个synthetic-robert账号/两课程/新签名与初始化材料仅本机root受限目录；库路径由原工厂生成，不绕path验证。仍待教师原发布/分配、真实Chrome与本人模型/C3闭环。

后续配置核对发现原BoardProfile允许buttons/resetN缺失或部分绑定。前端按原六个必需信号覆盖核验，额外防物理port bit重叠；optional输入从原binding决定可操作性，未绑定明确显示并disabled，不伪造已接线。新增3反例、受影响22项与typecheck/build通过；新dist主入口index-DVKKNh5Z.js。新本机工具的初始化失败重试、启动期间SIGTERM、默认模型关闭与仅student_help用途守卫3/3无副作用反例通过；启动入口以原flock排除pending阶段重复宿主，不覆盖原PID。模型与真实浏览器尚未据此算通过。

### 4.7 2026-10-15：本机正常浏览器与本人模型首次实测

原教师正常 HTTPS API 已发布并分配两个新合成活动，未直接写 SQL：C Assignment `fb0983e4-81bc-487b-8b50-7ffe984c38bb`，HDL Assignment `4c589f3c-18bc-447a-b6bb-6e3a86c442a7`。seed 首次正常 material.create 已成功，但本人解析器误期待旧扁平回执；改为原 `identity`/scope/hash 验证后复用原 prepared key 成功回读，未重复资料，失败历史保留。原教师 sample-run HTTP 路由不存在，未编造该步骤。

Chrome 155 的既有已连接 profile「您的 Chrome」在严格受信 `https://127.0.0.1:3444` 正常登录 synthetic-robert-student-b，原表单/Session/CSRF/bootstrap，HDL Attempt `c5d1cf8e-991b-431a-9d39-177260725964`。没有使用 PAHER 服务或读取其模型key。原固定UI `464b33e`/index-DVKKNh5Z.js 的确认保存/冻结、真实成功Build/装载/SW0输入与确认停止已经执行；baseline LED常量0，SW0=1时仍0，原Session `88c7960f-50f8-43d6-9e2b-04775e94dad9`、seq1/time10000ps。之后显式编辑漏分号，确认快照 `992df0be-69e1-47ea-a28b-436b55bbc22b`/workspace v2，真实 failed Build `2a28b361-05fa-4b35-bb92-4a57a7db208c`，原iverilog第10/11行诊断原样显示，只做整行定位。

显式同快照 Build + top.sv/file v2求助，经正常表单/原SDK/原Job消费者/C3：Job `03f58f2d-080e-4074-b69f-26a63b44cbb8` succeeded，Message `f688beaf-ca51-48a4-84c8-e9d8fac818dd`，服务端 received seq34；本人环境key只传本机子进程env。真实模型HTTP一次200，原SDK actual usage input2933/output507；没有直接模型脚本或假的 teaching.delivered。提示说明缺分号并建议自行验证，没有提供完整作品或改源码。初始辅导在Attempt创建前sync的通知通过正常“重新读取辅导”清除，不是新的模型请求。

真实小辅导滚动容器只有79px，整卡含来源1874px，原5% IntersectionObserver阈值导致正文可见仍无displayed。保留当前原Job/快照，先修正为观察实际正文的正面积交集并复验；当前不能把succeeded/received写成displayed或人工acknowledged。后续修改/同输入输出变化与最终停止证据另记。

可见性修复固定 `f03c033`，只观察原Markdown正文的正面积交集，来源/按钮不计，保留原visible/valid/C3；10项边界加既有HDL用例11/11通过。正常刷新实测另发现父current在初始idle/reading投影空Build，使收到但未展示的原消息被永久标过时。父current改为完整HDL read的ready才取得，暂时未知保持null；每次来源更新令下一次原channel普通轮询从0重新授权，不直接置valid或清缓存。恢复反例核原cursor、收到回执保留、unknown不展示、同来源恢复、实际草稿变化仍持久失效。原首条Job错误持久缓存不解锁，不补displayed；通过正常新请求做后续本机合成展示验证，实际模型Job/HTTP与失败分开统计。最新全前端43文件569项全部通过，类型/正常build通过；不是完整浏览器/AC/NFR或教学效果。
