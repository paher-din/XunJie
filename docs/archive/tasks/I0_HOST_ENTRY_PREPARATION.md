# I0-ENTRY：正常 HTTPS 与合成账号入口准备

日期：2026-10-13。关联 [Issue #30](https://github.com/paher-din/XunJie/issues/30)、[A Draft PR #53](https://github.com/paher-din/XunJie/pull/53)，对应 H-01，给 H-02～H-06 的正常宿主联调提供先行条件。

状态：2026-10-14，C @paher-din 的PR #55现场方案已通过A实审；A归档/政策说明修正与原入口21/21验证已交b64ebe1。负责人现已明确批准§9.3现场新增TLS/签名/五密码及严格单Node客户端信任，交C连续执行C-ENTRY-04～07，见§10。实际正常HTTPS/真实C Job链仍待C执行回交，UI浏览器信任/验收单列未授权/未执行。

## 1. 目标、依据与范围

交出一个真实可用的受控 HTTPS 入口：原正常 main 服务现有 UI real build，合成教师/学生可以经正常会话接口登录，A 能复核配置与当前 C 认证来源，UI 能按已有获准路径访问。完整“检查→确认→分配→保存→运行→暂停”仍在下一批联调，不借本任务宣称完成。

已读依据：[AGENTS](../../AGENTS.md)、[README](../../README.md)、[PRD §8–9](../product/PRD.md#8-数据控制权与评价边界)、[MVP_SPEC §1–2](../product/MVP_SPEC.md#1-首版交付定义)、[TECH_DESIGN §2/5](../product/TECH_DESIGN.md#2-部署与模块边界)、[TEAM §2/2.1](../planning/TEAM_WORK_PLAN.md#2-固定职责与修改边界)、[I0-A/C §11–12/16–17](I0_A_C_HANDOFF.md#11-本批实施授权与开工)。沿预置账号、私有访问、会话/课程授权以及 AC-02/NFR-04；这里只准备入口，不完成这些编号的全部业务验收。

本任务写集为本文、A 的 I0 任务记录及 README 导航；产品/分工基线只读，相关进度待授权维护者汇总。既有 §11 授权覆盖新建保留的原24表合成库、现有配置引用、正常宿主与模块去敏公开交接。本次整理不执行初始化或启动，不创建/改写 TLS、签名、SSH 凭据、.env 或 CI，不迁移旧库，不增加网络入口，不维护节点。

## 2. 责任到人

| 角色 | 本任务责任 | 回交对象 |
| --- | --- | --- |
| A（集成复核，当前账号 czr112） | 维护已交固定源/手册与 A 模块；审核 C 的配置方案、业务边界和原证据，协调需要负责人决定的具体动作；最终按 H 复核结论 | 项目负责人、C、UI |
| C（本任务准备与执行负责人，@paher-din） | 固定包接收、材料核查、缺失 TLS/签名/账号输入的具体方案、合成成员/政策输入编制、配置映射、获准初始化/启动、正常 HTTPS/原 Job 接口联调、原证据保留、账号与运行窗口安全交接均由 C 完成；需新增凭据/信任/通道先交具体方案待授权 | A；审核后向 UI 交操作材料 |
| 现有 TLS/签名材料的实际保管人 | 提供已有获准材料的受控引用与使用权限事实。此人当前未明确；C 核查后报姓名/角色，不能仅写“环境维护者” | C、A |
| UI（@wubq511 / Robert） | 接收 HTTPS 地址、获准访问/信任方式和账号安全领取方式；确认能访问现有页面及资产。正常登录接线及业务浏览器验收在后续 UI 批次 | A |
| 项目负责人 | 材料或访问条件缺失时，指定实际保管人，决定具体新增凭据/信任/网络操作及执行人 | A、指定执行人 |

沿原模块分工，负责人本次另明确将可由 C 完成的准备/操作全部交 C；不改 A 源码维护或 UI 实现责任。C 回交当前执行窗口与具体阻塞，不再等待 A 另编账号清单、字段映射或凭据方案。C 应明确材料实际保管人；不能从任务分派推导新增/替换秘密、网络或节点维护授权。A 负责复核与协调决定。

## 3. 执行顺序与每步出口

前一步出口通过后才执行依赖它的步骤。缺材料不影响 A 固定代码、填写非秘密字段清单或 C 核其他现有材料；不能用空值/随机凭据绕过缺口。

### 步骤 1：C 接收已交固定执行包并核现场条件

A 交：[固定可运行提交 9fa76adbfb37a60cc087f8bf2fbdd1e05cd18e77](https://github.com/paher-din/XunJie/tree/9fa76adbfb37a60cc087f8bf2fbdd1e05cd18e77)、[接收/构建原命令](I0_A_C_HANDOFF.md#172-接收和构建不触碰成员现有-checkout)、[配置/初始化与只读预检](I0_A_C_HANDOFF.md#173-初始化配置与只读预检)、本任务回交表。之后的纯文档提交不改变运行 SHA，不跟随移动分支执行。

C 回交 PAHER/WSL2 Ubuntu 的执行用户、已有 Node24.21.0 位置、可执行时间窗口、A 查阅原输出的受控方式。C [最新回交](https://github.com/paher-din/XunJie/issues/30#issuecomment-6147353266)已证明接收、构建与当前认证读取通过，保留这批证据，不要求重复整批构建；后续执行仍核环境当前性。不能把另一机器的 localhost 当 PAHER。

出口：执行位置/人/窗口明确；没有现场条件就标“步骤1待现场确认”，不启动 WSL/VM 来替代确认。

### 步骤 2：C 查现有材料，逐项明确实际保管人

仅核既有受控路径，先看文件是否存在、是否为普通文件及运行用户能否读取；不全盘搜私钥，不打印文件内容。逐项填写：

| 材料 | 必须确认的事实 |
| --- | --- |
| TLS certificate 与 key | 现有文件引用、保管人、原允许用途、运行用户读权限；证书主机/有效期及 key 匹配由原预检确认 |
| 应用 signingSecretFile | 现有受控引用、保管人与读取权限；由原校验器验证长度，不公开内容 |
| 应用 SSH key 与 known_hosts | 沿 C 已交 connection.json 的既有引用、固定主机/端口与严格主机验证；不是管理员交互 SSH 凭据 |
| C 当前登记与原身份 | current-readiness.json、runtime-evidence.json、connection.json 的受控位置/权限和生成批次 |
| 合成初始化输入 | 是否已有获准输入、谁提供账号安全领取渠道；只核结构与授权来源，不把密码复制进任务稿 |
| HTTPS/浏览器访问 | 已有获准访问位置、证书信任方式及必要的现有 CA 文件引用；谁能够使用这条路径 |

C 已回交的节点材料目录为 PAHER 的 `/opt/xunjie-runner/tests/i0-c-revalidation-cde69cc-20261013/handoff/`，见 [C 当前回交](https://github.com/paher-din/XunJie/issues/30#issuecomment-6142794517)。这是现场受控引用，不替代仓库手册；A 尚未读取其中原文件，当前值仍须认证核对。

每行填写“已有且获准 / 已有但权限或用途待确认 / 缺失 / 未知”，并给下一责任人。发现没有 TLS 或签名材料时，不默认 C 应自行生成；报给 A，按 §5 处理。

出口：材料逐项有状态和具体责任人；全都满足下一步所需条件才启动。

### 步骤 3：C 编制地址/访问方案，A 核边界

C 回交实际 HTTPS Origin、端口、证书覆盖主机和 UI 将在哪里访问。A 核配置使用同一个精确 Origin，PORT 等于其有效端口。不得把示例 `https://<approved host>:3443` 当现有地址。

原 main 监听 `127.0.0.1`。如果 UI 在 PAHER 同机浏览器访问，应明确这个事实；如果在另一台电脑访问，必须写清已有获准访问路径。没有路径则本步未完成，不临时绑定 0.0.0.0、不自行开防火墙/代理/隧道/VPN。现有 CA 信任不足时记录具体失败，不能关闭 TLS 验证或自行导入根证书。

出口：A、C、UI 都能理解同一地址在哪台机器可用，访问与证书信任有现有授权依据。UI 此时只需确认访问位置/方式，不等待业务接线完成。

### 步骤 4：C 编制合成账号/课程输入并执行获准原初始化

C 直接按本手册编制非秘密清单：教师、本人学生、同课程另一学生，以及第二课程的越权验证角色；每个账号和课程用 `synthetic-` 前缀 ID，角色来自 teacherId/studentIds 的课程归属。C 可选择满足原契约的唯一合成 ID/loginName；course-a用help-v1、course-b用help-v1-course-b，检查规则均为textscope-core-v1；原 schema/守卫/帮助强度不变。不再等待 A 提供另一个账号表。

C 在现场编制初始化 JSON 的非秘密部分和账号安全领取方案。若现有获准密码输入可用则引用；本次确认现场缺失，C 需提出新合成密码的生成方式、受控存放/权限、领取渠道和对象范围，由 A 复核并提交负责人授权后再生成/填入。秘密不经公开评论/仓库，不能用旧库 SQL 补账号、重置密码或伪造会话。分派准备工作不等于放行凭据生成。

C 按 §17.2 在全新保留副本构建两个应用，保留 Node/SQLite 版本、原 package/lock 前后摘要和结果。然后在 `apps/teaching` 使用已配置的 `XUNJIE_I0_INITIALIZE_CONFIG` 执行：

~~~sh
node dist/server/app/i0-initialize.js
~~~

原 initializer 只新建保留原24表库，打印库位置，不预造 Assignment/Attempt/Job。C 保留实际新库路径与初始化记录；有同次库就说明来源，不重复建库替换失败证据。

出口：新库来源/账号使用渠道/课程归属清楚，构建与初始化通过。合成账号表公开仅放 ID/课程归属，密码不进入命令行或日志。

### 步骤 5：C 完成字段映射并组合获准配置

C 在本任务受控目录创建新的非秘密引用配置，不覆盖旧配置。A 按 [§12 配置字段](I0_A_C_HANDOFF.md#121-初始化与启动) 审核：

| 字段/环境变量 | 本次取值来源 |
| --- | --- |
| synthetic / databaseFile | true；步骤4原 initializer 返回的保留新库 |
| origin / PORT | 步骤3核定的精确地址及匹配端口 |
| tls.keyFile / tls.certFile / signingSecretFile | 步骤2现有获准材料，绝对受控引用 |
| generationFile | C 当前受控 readiness 文件；原 `data.recoveryGeneration`，不用历史评论值或 UI 随机值 |
| ssh | 原 application SSH 的 binary/keyFile/knownHostsFile/host/port；沿当前 C 回交，不另开管理员权限 |
| staticDirectory | 本次固定副本 `apps/student/dist` 的绝对位置 |
| consumerIntervalMs | 沿原已允许值/默认值，记录实际选择 |
| XUNJIE_I0_CONFIG | 本次新引用配置路径 |
| XUNJIE_I0_ORIGINAL_EVIDENCE | C 原 runtime-evidence.json 的受控引用 |
| NODE_EXTRA_CA_CERTS（需要时） | 现有获准 CA 文件，保持证书验证 |

每项存在且可由实际应用用户读取。C 回交受控配置查阅方式，A 核字段与来源；公开只放去敏字段/引用方法，不放内部秘密或账号材料。

出口：配置能由原读取器接收，材料权限满足要求，没改写凭据/.env/known_hosts。权限不足时回交具体用户/文件/操作，不能自行放宽密钥权限。

### 步骤 6：C 只读预检，再启动原正常宿主

C 原样执行 [§17.3 只读预检](I0_A_C_HANDOFF.md#173-初始化配置与只读预检)，核当前认证 readiness、profile/sourceHash/fingerprint/validation/代际、原作业身份 query，以及 TLS 主机/期限/key 和配置。只读 query 不重新 submit；C 已通过的整套节点/HDL 验收不为本任务重复。

预检通过后，在本次副本 `apps/teaching` 的受控进程环境带上已核 `XUNJIE_I0_CONFIG`、PORT 和必要的现有 CA 引用，执行原命令：

~~~sh
npm start
~~~

正常 main 必须读取 I0 配置；只有健康入口不算正常宿主。按既有获准运行方式保留前台日志/进程，不安装服务/cron、不做生产部署，不启动或修复 C 节点。

出口：预检实际通过，正常 HTTPS main 启动，现有 real dist 可服务；记录原命令、运行用户/窗口。原消费者是否真实处理 Job 在下一批联调证明，启动本身不算业务组合通过。

### 步骤 7：C 验证入口，UI 接收访问条件

使用验证证书的实际 HTTPS 客户端，经过正常网络路径，分别验证：

1. GET `/` 和页面引用的实际资产成功；没有引用 prep fixture。
2. 匿名 GET `/api/session` 被拒绝（401）。
3. 使用受控合成账号，POST `/api/sessions` 只提交 loginName/password；使用精确 Origin、JSON 和原安全 cookie。不要请求体指定 role/studentId。
4. 用原登录 cookie GET `/api/session`，教师与学生的 userId/课程角色分别与步骤4匹配。原 cookie/CSRF 留在受控位置，公开去敏。
5. 登录失败/证书失败如实记录，不能关闭验证或生成 Session 来“补通过”。

不把密码写到命令参数/history、原日志或公开 HAR。C 保留原状态码/响应和安全查阅位置；A 核原登录与归属事实。UI 确认收到账号安全领取渠道，能通过步骤3的原路径打开现有页面/资产并保持证书验证。UI 登录接线尚未完成时列为后续工作，不要求 UI 先完成整套业务才允许本任务交接。

出口：实际 HTTPS、正常登录接口和现有页面资产通过；UI 已确认接收和页面访问。浏览器登录/保存/运行验收仍独立记账。

### 步骤 8：C 回交，A 复核后给 UI

C 按 §4 填完整回交；A 检查原输出与摘要、登录归属、配置来源及未执行项，完成 H-01 入口批次回交。随后接 [§17.5 正常 HTTP 业务执行链](I0_A_C_HANDOFF.md#175-真实-https-公共接口执行清单)，教师再走“检查→确认→分配”，给 UI 本人合法 Assignment；不在入口准备时造分配。

运行窗口结束按原正常停止方式 SIGINT/SIGTERM，保留库和原日志；不删除任务目录，不关停/维护 C 节点。后续谁启动/何时可访问必须交接，临时进程已停止就不能宣称入口持续在线。

## 4. 固定回交表与完成判据

C 向 A 回交以下清单；敏感路径的公开版用受控引用编号，原路径通过原安全渠道提供：

~~~text
任务：I0-ENTRY / H-01
现场执行人 / 材料实际保管人 / 运行用户 / 可用窗口：
A运行SHA / C当前来源 / Node / SQLite：
各材料：已有且获准 / 待权限确认 / 缺失 / 未知；下一责任人：
实际HTTPS Origin / PORT / UI访问位置与原获准路径：
证书有效期/主机匹配/现有信任方式（不含私钥）：
原初始化授权来源 / 保留库引用 / 合成用户与课程归属：
本次配置受控引用 / current-readiness与originalIdentity来源：
构建 / 初始化 / 只读预检 / 正常main：通过或失败；原日志引用：
HTTPS页面/资产 / 匿名401 / 教师登录 / 学生登录：实际状态码与去敏证据：
账号安全领取渠道（不含密码） / UI接收及页面访问结果：
原证据摘要与去敏证据摘要分别记录：
仍未执行的业务链 / 缺口及所需具体决定：
停止状态 / 后续启动人及时间：
~~~

本任务完成须同时满足：具体执行人/保管人明确；现有材料与授权可核；新库及字段来源清楚；实际 HTTPS/TLS/登录与归属通过；UI 接收到地址、访问/信任和账号使用方式；A 已复核原证据并回交。仅提供文件名、代码、历史节点 ready 或本任务文档不算完成。

## 5. 缺材料或失败时的操作

C 逐项报“缺什么、哪一步受阻、实际保管人是否已知、现有授权能否覆盖”，继续其他独立核查。A 在本任务集中登记，不再泛称“等环境维护者”。

| 情况 | 下一动作与决策人 |
| --- | --- |
| 保管人不明 | C 交现场事实；A 请项目负责人指定具体保管人/执行人 |
| TLS/签名/账号秘密输入不存在 | C 提出具体对象、生成方式、用途、路径/权限、保管/领取方式和风险；A 审核并交负责人决定。批准前只做方案和非秘密输入，不生成/替换 |
| CA不受信任、UI无既有访问路径 | C 收集 UI 的实际访问位置，编制具体信任/访问方案及范围；A 复核后交负责人决定，不自行禁校验/开端口 |
| 文件存在但运行用户不能读 | C 对接实际保管人并准备具体文件/用户/权限方案；需要调整时 A 复核、协调对应授权，不放宽密钥权限绕过问题 |
| 构建/配置/登录接口失败 | C 保留原输出；A 修 A 模块，C 修自己模块；不换依赖/关检查/改角色补结果 |
| 预检节点当前不可用或代际不一致 | C 回交认证事实；A 不开放运行；需要节点维护时另按 C 原任务权限处理 |

决策记录包含提出人、具体操作对象、范围、批准者与日期。等待决定期间保留原失败/缺口；未执行写“未执行”，跳过不算通过。

## 6. 本次整理与验证记录

2026-10-13：已将旧评论中“环境维护者提供配置与账号入口”独立为本任务，给出 A 总负责、C 现场核查/执行、UI 接收与负责人处理缺口的逐步流程。旧 I0 记录保留历史，当前责任按本文，实际保管人待现场明确。

本次只维护文档/导航。PAHER 材料核查、初始化、预检、HTTPS启动、登录及UI访问均未执行；C 此前节点回交不计本任务通过。实际静态验证：`node tools/a0-review/check.mjs` 检查65份文档、940条内链，errors=[]；`git diff --check` 通过。仅验证文档，未复跑无源码变更的既有业务测试。完整 H-02～H-06、UI 浏览器业务、模型、HDL宿主、AC/NFR 和 G1 产品验收不在本次完成范围。产品/分工基线未修改，待授权维护者汇总适用进度。

## 7. 负责人本次分派：可执行的准备和现场操作全部交 C

2026-10-13，负责人明确要求“能让c完成的全部分派给c”。这是本任务当前责任安排，取代上一版由 A 另行编制账号清单、字段映射和凭据方案的安排；不表示新凭据、CA/网络或节点维护已获具体实施授权。

### 7.1 接收 C 最新事实，不重复已完成工作

历史[C现场回交](https://github.com/paher-din/XunJie/issues/30#issuecomment-6147353266)曾称754份源文件与固定Git blob一致；PR #55现明确此旧结论仅核tar与CRLF归档一致，不能证明原blob。正确LF2副本754文件/10摘要以及实际typecheck/build以§9补正为准。旧Node24.21.0/SQLite3.53.4/原lock接收记录与失败均保留。原三文件读取、C/HDL当前认证就绪、原代际和原身份 query断言通过；没有 submit补跑。

C 同时明确：原获准目录/变量内没有 TLS、签名、正常宿主或账号初始化输入。本轮尚未初始化应用库或启动正常main。这是现场缺材料，不再仅登记“保管人未知”。本段为历史时点；§9已完成A去敏原输出的独立实审。历史true不替代下一次运行时的当前认证。

### 7.2 C 的完整执行清单

| 批次 | C 负责完成 | 本批回交/出口 |
| --- | --- | --- |
| C-ENTRY-01 | 接收已交固定源和手册，确认当前窗口/用户；复用已通过的接收/构建证据 | 固定SHA、现有副本/运行用户、窗口、原输出受控入口 |
| C-ENTRY-02 | 核现有材料；现场缺失时编制准确 TLS/签名/账号输入、证书信任和 UI 访问方案 | 一份可审批的具体方案，不只回交“请A提供” |
| C-ENTRY-03 | 编制完整非秘密合成成员、两课程归属、各课程唯一帮助政策/textscope-core-v1初始化输入和字段映射 | 原 schema 可校验的非秘密结构/ID清单；密码留待获准安全生成或现有获准引用 |
| C-ENTRY-04 | 对已有/另获批准的材料，组合受控配置，原24表工厂新建并保留库；完成原只读预检 | 配置/新库来源、认证当前性、原identity query、实际预检结果 |
| C-ENTRY-05 | 启动原正常HTTPS main/现有real dist，经实际HTTPS核页面、资产、教师学生登录与课程归属 | Origin/端口、运行窗口、TLS验证和正常登录去敏证据 |
| C-ENTRY-06 | 接入口后按[I0-A/C §17.5](I0_A_C_HANDOFF.md#175-真实-https-公共接口执行清单)执行原20项公共接口链：检查/确认/分配、bootstrap、显式创建、保存/head/快照、真实C1运行/可信检查/产物、原Job自动消费、取消/暂停、授权/重放/冲突等 | H-01～H-06逐项结果、原Assignment/Attempt/Snapshot/Job/Run和原输出；未触发故障写未执行 |
| C-ENTRY-07 | 保留库/原证据和去敏摘要；提供 UI 地址、安全账号领取、本人合法Assignment、启动/停止/窗口说明；修 C 模块故障 | A可复核原事实，UI可接收操作材料；UI代码和浏览器业务由UI完成 |

C-ENTRY-02 的方案须写清：每项是否现有、拟生成/修改对象、具体主机/端口与证书SAN/期限、TLS/签名/合成账号输入的创建方式及受控路径/权限、保管人、秘密领取渠道、现有浏览器信任/访问条件，以及新增信任/通道是否必要。给可执行命令或步骤，但审批前不运行产生秘密/改变信任/开通通道的操作。引用原配置 schema，保持严格证书与 pinned known_hosts 验证，不提供 secret 值。

C-ENTRY-03 可按以下非秘密 ID 模板直接编制（字段仍按原 schema，不把下表当 initializer JSON）：

| 合成ID | 用途/归属 |
| --- | --- |
| synthetic-i0-teacher-a | synthetic-i0-course-a 的 teacherId |
| synthetic-i0-student-a | course-a 的本人学生 |
| synthetic-i0-student-peer | course-a 的另一学生 |
| synthetic-i0-teacher-b | synthetic-i0-course-b 的 teacherId |
| synthetic-i0-student-b | course-b 的学生/跨课程读者 |

C 可使用满足原约束的唯一 loginName，两个课程的 studentIds 分别含对应学生；沿原政策/规则内容和已有字段校验。这批是全新合成数据，不能覆盖旧账号。非秘密清单准备无需等 A 再提供具体名字，生成新密码依旧须明确授权。

本次 I0 正常宿主只用原24表范围，不与 DL-A35表库合并，不把9fa76ad当成HDL业务宿主，不顺带执行DL-A/ALU新组合或重跑整套C/HDL节点验收。原Job/worker联调沿既有批准范围；新故障注入或节点维护另走原门禁。

### 7.3 A/UI 保留责任与下一动作

A 保留已交代码/手册维护、A模块缺陷修复、共享业务边界审核、C方案/证据复核、所需授权决定的协调，以及最终按H确认结论。具体现场材料核查、方案编制、非秘密账号输入、配置映射及公共接口执行不再要求 A 重做。

UI 保留已有界面的接线、实际浏览器业务验收和回交；C 收集其访问位置/需求并交入口材料，不能代替 UI 宣称浏览器业务通过。

本段保留2026-10-13的分派。2026-10-14已收到PR #55，C-ENTRY-02/03方案与输入的A实审完成，具体结论及后续C-ENTRY-04～07授权/执行顺序见§9；新凭据与实际业务仍不能靠时间推定授权。

本次只调整任务文档/README和公开分派，不生成凭据/初始化库/启动宿主。文档复查65份/949内链/errors=[]，git diff --check通过，原历史通过/失败/未执行记录保留；受保护分工/产品基线未改，待授权维护者汇总。

## 8. A 固定执行包交付清单（2026-10-13）

负责人要求“照着这个计划开始先完成我需准备的东西”。A 先交本节的固定执行包和可核对业务要求，C 仍负责 §7 的现场方案、非秘密初始化输入/配置及实际执行。此交付可直接用仓库读取，无需个人电脑入口。

### 8.1 固定包与接收方法

| A 交付项 | 固定材料 / 用法 |
| --- | --- |
| 可运行源 | [9fa76adbfb37a60cc087f8bf2fbdd1e05cd18e77](https://github.com/paher-din/XunJie/tree/9fa76adbfb37a60cc087f8bf2fbdd1e05cd18e77)，C已接收；不从当前移动分支取运行代码 |
| 源文件/lock核对清单 | [I0_A_EXECUTION_MANIFEST.json](I0_A_EXECUTION_MANIFEST.json)：10个原Git blob的SHA-256、Node24.21.0、启动/初始化命令及原政策/规则示例 |
| 接收与构建 | [§17.2](I0_A_C_HANDOFF.md#172-接收和构建不触碰成员现有-checkout)；原lock、全新保留副本，已通过批次沿C回交，不重复计数 |
| 宿主字段/初始化契约 | [§12.1](I0_A_C_HANDOFF.md#121-初始化与启动)、本任务§3/7和下方8.2；实际路径/账号输入由C准备 |
| 原只读预检/正常启动 | [§17.3](I0_A_C_HANDOFF.md#173-初始化配置与只读预检)、[§17.4](I0_A_C_HANDOFF.md#174-正常-main-启动与首批入口)；用当前认证来源，不重新submit旧run |
| 原公共请求/JSON样例与判据 | [§17.5](I0_A_C_HANDOFF.md#175-真实-https-公共接口执行清单)：20项链、完整manual蓝图、sync/run与工程产物样例 |
| 回交与停止规则 | 本任务§4/7、[§17.6](I0_A_C_HANDOFF.md#176-回交模板和第1步完成界限)：原ID、原输出/去敏摘要、实际状态、窗口和安全账号领取 |

manifest 的 files 摘要对原 Git blob 字节计算，不能拿 Windows CRLF 工作副本直接比较。PR #55纠正旧tar --compare范围：旧归档与CRLF副本相同不代表原Git blob一致。后续用单次core.autocrlf=false归档和最终LF2副本，754份普通文件0差异、10份摘要一致；需要核个别文件时从同一SHA的 git show 读取后计算SHA-256。manifest是公开核对清单，**不是** XUNJIE_I0_CONFIG 或 XUNJIE_I0_INITIALIZE_CONFIG，不能直接交CLI运行。其中示例政策/规则仅作原字段依据，不初始化账号/库，也不包含任何可登录密码。

### 8.2 A 明确交出的配置与账号边界

原字段以固定源为准，C可直接据此完成具体方案，不等待A再另写字段映射：

- 账号输入 strictObject：synthetic=true；users 2～20，每项 id/loginName 都是 synthetic- 前缀、11～128字符、字母数字下划线/连字符，受控 password 16～1024字符；courses 1～4，每项 id/teacherId/studentIds/helpPolicy/checkRule。每课程学生1～19；用户/登录名/课程ID唯一，引用的成员必须存在，教师不同时是本课程学生，studentIds不可重复。按§7两课程、五角色验证范围填具体输入。
- 帮助政策：course-a的help-v1、course-b的help-v1-course-b；versionId全库唯一，蓝图引用所属课程的政策。helpAllowed=true、wholeSolutionAllowed=false、limitedCheckHelpAllowed=false、非空description；检查规则：textscope-core-v1、textscope-validator-v2、limitedHelp=true、非空description。可校验的完整示例见manifest，不放宽整份代做或可信检查帮助限制。
- 本批仅原24表工厂新库、保留失败库；不接收旧目标库、不迁移/SQL补录账号，不预造分配/Attempt/Job。Teacher/Student权限只由正常会话和课程归属决定，请求体role/studentId不能授权。
- 宿主 JSON 是严格字段集合。databaseFile、TLS/签名/代际与SSH引用须现存绝对普通受控文件；staticDirectory须本次UI dist绝对普通目录；拒绝符号链接，POSIX配置/受控文件不可组/其他用户可写，JSON不超过1MiB。
- signingSecretFile为既有或另获批准的受控文本，trim后32～4096字符、文件最多4096字节；不公开内容。TLS主机/SAN、有效期、key匹配和浏览器信任须实际验证。
- origin为精确HTTPS Origin，PORT为1～65535整数并匹配有效端口；main监听127.0.0.1。地址和证书方案由C按实际访问位置提出，不把占位3443视为已批准端口。
- generationFile在本次真实组合必备，原data.recoveryGeneration须与当前认证一致；缺值不得随机补齐。SSH沿原application key/pinned known_hosts和原sshRunner，consumerIntervalMs范围50～10000毫秒，默认250；本批沿默认值即可，不新增消费者。
- 登录POST /api/sessions只交loginName/password和精确Origin；后续写命令走原cookie/CSRF/幂等键/预期版本。公开输出删除密码、cookie、CSRF、私钥与token；保留原输出于受控位置。

### 8.3 A 复核清单已准备

A收到C回交后核：固定源/原lock不变、具体材料授权与保管、精确Origin/信任/权限、新库来源、当前认证代际与原identity、正常会话及跨归属拒绝、无副作用bootstrap、原Job自动消费而非手动worker、原回执重放/冲突、保存后权威三版本、运行与旧快照绑定、私有产物裁剪、暂停/取消与停止确认，以及失败/跳过/未执行的真实统计。按H给UI结论，不提前宣称完整AC/NFR或浏览器业务验收。

以上为2026-10-13固定包交付状态。2026-10-14已收到并实审C具体方案/去敏原输出，A独立合成验证通过；详见§9。没有生成PAHER TLS/签名/密码或配置，也未启动正常宿主。

本批实际验证：10份原Git blob的manifest SHA-256逐项一致；原compiled helpPolicySchema/checkRuleSchema接收两份非秘密示例（Windows Node24.15.0，仅字段校验，无DB/网络）；文档首次发现1处新增标题锚点错误，已修复，复查65份/949内链/errors=[]、git diff --check通过。不复跑无代码变更的完整业务回归。


## 9. A 对 PR #55 的实质审查与后续精确范围（2026-10-14）

### 9.1 固定证据与两轴结论

审查固定[C PR #55](https://github.com/paher-din/XunJie/pull/55) head ea5a6523245ef25e2ab15712fa5aae5fc182deb8 / base cde69cc，16份新增文档，其中14份JSON。现场方案、非秘密输入、正确LF2接收/构建与C/HDL原证据均有仓库公开入口，A不重写C记录；[C原交接记录](https://github.com/paher-din/XunJie/blob/ea5a6523245ef25e2ab15712fa5aae5fc182deb8/docs/tasks/I0_C_HANDOFF.md)和[现场方案](https://github.com/paher-din/XunJie/blob/ea5a6523245ef25e2ab15712fa5aae5fc182deb8/docs/tasks/evidence/dla-c-handoff/i0-entry-host-plan.json)为固定来源。两轴由code-review独立只读审查：

| 轴 | 实质结论 | 处理 |
| --- | --- | --- |
| Standards | 阻断0；14份JSON可解析，27个logs输出摘要/已填字节数/TAP统计一致，7个C/HDL指纹可复算，33份HTTP样例存在；37处相关相对链接有效，未发现秘密值。P3：C closeout §11称“17段”，实际为27个logs条目/19个不同输出摘要 | 请C在本人记录澄清计数口径；不改变验收统计，不阻断本方案 |
| Spec | C方案无阻断契约错误；两课程政策ID隔离、帮助/限定检查强度、会话/课程授权、原Job/停止边界符合既有契约。发现A归档命令可能转CRLF，A原手册两课程共用help-v1会被原守卫拒绝 | A已改单次git -c core.autocrlf=false archive、course-b政策help-v1-course-b及蓝图说明；不改schema或源码 |

C材料自洽与历史实测已复核；A没有访问PAHER复测在线节点、文件权限或新TLS。旧CRLF接收错误及LF1依赖symlink导致TS2883失败均保留；正确LF2物理复用相同原依赖，两应用Node24.21.0 typecheck/build通过。旧tar --compare不能当原Git blob核对；754份原blob/10份清单核对以PR #55补正为准。正常宿主业务源仍固定9fa76adbfb37a60cc087f8bf2fbdd1e05cd18e77，不随移动main执行。

2026-10-14 fetch发现main已合入B3 PR #52（0e68325），PR #53/#55仍Draft/Open。该合入不改变本批固定运行源；本次未验证将新main/B3与I0组合，不将固定源结果计入新组合。

### 9.2 A 独立原入口验证

先在[I0-A/C §21](I0_A_C_HANDOFF.md#21-接收-pr-55-的-a-实审与验证方案2026-10-14)记录验证方案，后执行[可复跑验证脚本](evidence/i0-a-c55-review/verify.mjs)：在仓库根、原依赖就绪的Node24.21.0运行 node docs/tasks/evidence/i0-a-c55-review/verify.mjs。只用公开离线测试常量，原initializeI0→原24表工厂→createI0App/app.inject→真实Session/SQLite事务；不监听网络、不装配runner、不启动消费者，不生成PAHER登录材料。

[最终去敏结果](evidence/i0-a-c55-review/verification.json)：21/21通过、0失败、0跳过；SQLite3.53.4/WAL/foreign_keys=1/synchronous=2/busy_timeout=1000。覆盖五个正常登录/会话归属、2政策/2规则、跨课程复用政策FORBIDDEN与回滚、匿名/伪造role/Origin/CSRF、教师/学生跨归属写拒绝、私有资料裁剪、撤权后的原会话失效。没有预造Assignment/Attempt/Job，不等同C的20项真实联调。

[首次结果](evidence/i0-a-c55-review/verification-first-run.json)20通过/1失败：脚本以undefined传CSRF头而非省略头；改为实际缺头后原接口拒绝并全通过，应用代码未变。两次全新原24表测试库均保留，脚本仅含公开离线fixture常量；去敏结果不含任何密码/cookie/CSRF/签名值，二者都不含现场秘密。源码/lock清单保持原值。完整394项回归本轮未复跑；正常TLS/浏览器/当前真实C组合未执行。

### 9.3 待负责人授权的可执行精确方案

A技术结论：接受C-ENTRY-02/03的业务/宿主字段方案作为下批执行依据；这不构成新增秘密或信任许可。按[非秘密成员方案](https://github.com/paher-din/XunJie/blob/ea5a6523245ef25e2ab15712fa5aae5fc182deb8/docs/tasks/evidence/dla-c-handoff/i0-entry-input-plan.json)物化原strict initializer，users仅id/loginName/password，courses原字段；删除提案role/courseId/passwordSource元数据。权限始终来自原会话/课程归属。

待授权对象已明确：C paher-din在PAHER/WSL Ubuntu原root执行，独占新目录 /opt/xunjie-runner/tests/i0-entry-20261013-01 为0700；server.key.pem/server.cert.pem/signing-secret.txt/initializer.json/i0-host.json为0600，umask077，普通文件不覆写（目录/目标已存在即停止，不删除）。现有OpenSSL3.0.13生成RSA2048/SHA256自签server证书30天、CA:false/serverAuth，SAN IP127.0.0.1/DNSlocalhost/IP::1；Node随机32字节base64url签名、五个账号各24字节base64url密码。生成及使用留在PAHER受控文件/内存，不打印或放CLI参数、Git、公开日志、跨机新通道；C仅保管这批新增材料。

C沿已批准的原24表fresh-only initializer新建并保留合成库，i0-host.json只填实际databaseFile；origin=https://127.0.0.1:3443、PORT=3443、bind127.0.0.1，staticDirectory用正确LF2的student/dist，consumerIntervalMs=250，沿C方案现有generationFile/connectionFile/originalEvidence及原application key/pinned known_hosts，预检当前代际/指纹/原identity后启动原正常main。

客户端仅本次Node HTTPS请求显式ca信任该证书，rejectUnauthorized=true，保留默认主机核验；Node自签服务端作为显式ca的行为见[固定Node24.21 TLS文档](https://github.com/nodejs/node/blob/v24.21.0/doc/api/tls.md)。此为每客户端验证配置，不改变系统/浏览器信任。C通过实际HTTPS完成页面/资产/五账号会话及原20项公共链，由原消费者执行真实C Job，保留库/原输出，去敏按H交A复核。

本范围不包含系统CA/浏览器证书库、关闭校验/点击绕过、新公网/跨机入口、旧库迁移/删除、.env/CI、SSH凭据替换、节点维护、35表/HDL/ALU/真实模型或生产部署。浏览器实际访问位置与精确信任方案由UI/C另明确，获准确许可后执行；Node HTTPS通过不能代表浏览器通过。

### 9.4 执行顺序与 H 回交

1. A已完成实审、两处手册根因修正和21项独立验证；P3计数澄清交C。
2. 负责人批准§9.3新增凭据及单Node客户端信任范围后，C连续完成C-ENTRY-04预检/新库、05正常HTTPS、06原20项真实链和07证据/入口回交；原24表授权不重复申请。
3. A按原ID、真实版本、政策/会话、Job自动消费与取消/暂停/撤权停止事实逐项核H；A模块缺陷由A修。C未触发的故障仍写未执行。
4. UI并行明确同机访问/信任方案，接收安全账号领取与合法Assignment后执行浏览器接线/验收。A最终逐H汇总；#30/#22不关闭，完整H-01/G1/浏览器仍未完成。

本批写集仅本人I0任务、非秘密manifest和上述验证脚本/去敏记录；README无启动用法变化。产品/分工基线只读，MVP_SPEC §10的本批实现/验证与限制待授权维护者汇总。待授权方案不写为已批准。

### 9.5 按 UI 的 H 编号交回当前状态

| 编号 | A已交/已核 | 完成仍缺 / 下一负责人 |
| --- | --- | --- |
| H-01 | 原正常HTTPS宿主/会话/CSRF实现、固定执行包；C具体材料方案已实审，独立5登录/授权验证通过 | 精确凭据授权已取得→C实际HTTPS入口/账号领取→UI真实信任与页面验收 |
| H-02 | 原只读Assignment/bootstrap与空态边界已交，不创建Attempt | C正常教师流程产生合法本人Assignment并回交深链；UI读取 |
| H-03 | 受控generationFile及无副作用bootstrap来源明确；C认证/指纹材料可核 | C运行时重核当前代际、正常宿主首次创建/恢复重读；UI真实恢复 |
| H-04 | 原自动消费者实现/既有验证；C原节点证据摘要/指纹已实审 | C正常HTTPS宿主与当前C1组合，证明仅轮询仍自动消费；A核原Job/Run |
| H-05 | 原sync ACK/head/暂停分配样例已核；A两课程政策/蓝图说明修正 | C正常组合权威三版本与暂停样例；受保护基线差异由授权维护者汇总，UI实际保存 |
| H-06 | 33份原Session/SQLite公共样例已核，未知/产物故障transport仍标合成 | C真实正常链读取/保存/快照/运行/停止/历史产物按能力交；UI相应浏览器验收 |

“已交/已核”不等于完整H完成，准备与独立合成验证不替代正常宿主的真实链。B模型不阻塞本批。

本批交付复查：node tools/a0-review/check.mjs 为65份文档/955内链/errors=[]；git diff --check通过。10份原Git blob摘要逐项匹配，固定源至当前HEAD的teaching/student代码差异为空。新增3份JSON可解析，验证脚本Node24.21.0语法有效；仅本任务文件纳入提交，无公开现场秘密。

## 10. 精确授权已取得：交 C 连续执行（2026-10-14）

负责人对固定[b64ebe1的§9.3范围](https://github.com/paher-din/XunJie/blob/b64ebe15007e4b209e3e5fd208f7ecc1389c2fd1/docs/tasks/I0_HOST_ENTRY_PREPARATION.md#93-待负责人授权的可执行精确方案)明确答复，原文：“批准该精确范围，交 C 连续执行”。这是新增现场凭据与单Node客户端信任的精确许可；§9中“待授权”保留审批前历史，本节为当前状态。原24表合成初始化/原Job联调沿既有授权，不重复申请。

执行及新增材料保管人为C @paher-din，在PAHER/WSL Ubuntu原root身份完成：独占新目录 /opt/xunjie-runner/tests/i0-entry-20261013-01（0700）；server.key.pem/server.cert.pem/signing-secret.txt/initializer.json/i0-host.json为0600、不覆盖。原OpenSSL生成30天RSA2048/SHA256自签server TLS，CA:false/serverAuth、SAN 127.0.0.1/localhost/::1；Node随机32字节base64url签名、五账号各24字节base64url密码。秘密仅本机受控文件/内存使用，不进CLI参数/Git/公开日志，不复制到新跨机通道。

C沿原24表fresh-only initializer生成并保留新库，配置使用实际databaseFile、正确LF2 student/dist及原generationFile/connectionFile/originalEvidence/application key/pinned known_hosts。固定运行源仍9fa76adbfb37a60cc087f8bf2fbdd1e05cd18e77，Node24.21.0；Origin=https://127.0.0.1:3443、PORT=3443、bind127.0.0.1、consumerIntervalMs=250。Node客户端只对此次证书显式ca信任，rejectUnauthorized=true、默认主机核验；不改系统或浏览器证书库。

### 10.1 C 连续执行及出口

| 顺序 | C须完成 | 去敏回交/判据 |
| --- | --- | --- |
| C-ENTRY-04 | 核当前受控条件，按上述许可生成新增材料、原初始化器保留新库；原只读预检核当前指纹/validation/代际/原identity及证书SAN/期限/key配对 | 原配置/新库来源、模式/属主、证书公开指纹、当前预检输出及失败记录，不交秘密值 |
| C-ENTRY-05 | 启动原正常HTTPS main/real dist，严格Node HTTPS验证页面/资产、匿名拒绝、五账号登录与两课程归属 | 精确Origin/端口、启动命令/本人进程/运行窗口，正常会话与Origin/CSRF拒绝去敏证据 |
| C-ENTRY-06 | 按[I0-A/C §17.5](I0_A_C_HANDOFF.md#175-真实-https-公共接口执行清单)原20项链逐项执行；只通过公共接口发起并轮询，由原消费者处理原Job | H-01～H-06、原Assignment/Attempt/Snapshot/Job/Run、三版本/代际、重放/冲突/裁剪/停止事实及实际统计；不手工processJob、不改造执行协议 |
| C-ENTRY-07 | 保留库/受控原输出，交可复核去敏JSON/摘要和UI操作材料，澄清原P3日志计数 | 正常本人Assignment入口、原证据来源/摘要、当前运行窗口/停止方式；账号仅沿本机既有受控方式领取，公开评论不附秘密 |

目录/目标已存在、端口占用、当前认证/代际/原identity不一致、TLS严格验证失败或原初始化/业务失败时，保存事实并停止依赖步骤，回交具体错误/归属。不得删除/覆盖、替换路径、随机补代际、放宽校验或启动节点维护来继续；不受影响的非秘密整理可以继续。结束或失败按原正常宿主关闭/停止规则收束本人应用进程，保留停止未确认为cancelling/outcome_unknown，不强改Job状态、不广泛kill其他服务。未执行写未执行，失败写失败，不用历史C重验/合成transport替代本次。

### 10.2 A/UI 与保留门禁

A已实审并提供具体授权，继续承担身份/权限/宿主/契约与集成质量：C真实回交后核原ID/原输出与统计，按H回交并修A模块缺陷。当前授权不等于C已接收或执行，实际现场结果仍待C确认/回交，A没有自行访问PAHER执行。

UI @wubq511 与C并行明确实际同机访问位置、账号安全领取和具体浏览器信任方案；系统CA/浏览器信任、安装工具、跨机通道仍未授权，Node通过不等于浏览器通过。既有SSH凭据、.env/CI、旧库迁移/删除、节点维护、35表/HDL/ALU、真实模型及生产部署不在本许可中。PR #53/#55不自动合并，#30/#22仍Open；产品/分工基线及MVP_SPEC §10待授权维护者汇总。

本批仅授权/执行交接文档：静态复查65份文档/957内链/errors=[]，git diff --check通过；业务、现场初始化/HTTPS/节点测试未执行，原21/21结果不重复计数。
