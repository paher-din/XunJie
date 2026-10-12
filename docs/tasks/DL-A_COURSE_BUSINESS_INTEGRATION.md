# DL-A：数字逻辑课程、共享契约与业务接入

日期：2026-10-12（Asia/Shanghai）。主责：A；对应 [Issue #38](https://github.com/paher-din/XunJie/issues/38)。状态：2026-10-12 已获准提前评审准备；2026-10-13 已核 DL-C PR #48，A/C 逐调用差异、B/UI 任务对应和首批 33 表实施提案见 §8～10。共享消费/首批实施待批准；源码与业务验证未执行。本文提案不是已批准共享契约，旧记录保留其创建时点。

## 1. 基线、同步与写入范围

已读 [AGENTS](../../AGENTS.md)、[README](../../README.md)，按 [PRD](../product/PRD.md) §4.5/5/6/8、[MVP_SPEC](../product/MVP_SPEC.md) §1.4、M-02/03/04/05/09/10 与 DL-AC-01～09、[TECH_DESIGN](../product/TECH_DESIGN.md) §3.3/4/5/7.2.1/8.5 的正文核对；分工依据 [TEAM](../planning/TEAM_WORK_PLAN.md) §7/10.1，材料/已批边界见 [DL-0](DL-0_DIGITAL_LOGIC_ADDON.md) §2.1～2.3，进入条件见 [G3](G3_OVERALL_COORDINATION.md) §2/4.1。

远端已 fetch，本任务独立工作副本基于 `origin/main` 的 `a4e54c70734ce37aca24feac6d106ea7d9f21b2d`，分支 `codex/dl-a-course-business`。主副本的未提交文档、原分支/工作树和既有日志均保留，未带入本批。2026-10-12 回读 #38/#39/#40/#41 与 Open PR：只发现 P2 真实模型入口 PR #36，尚无 DL-C/DL-B 新共享提案或运行证据；“未发现”不等于其他成员未在本地工作。

本批可写本文、README 的任务导航/真实状态；未批准前不改源码、共享契约或数据库。后续拟写 A 的 app/access/design/db、contracts/common/design 及对应测试；新增共享文件按评审清单批准。C 的 runner/workspace/records、B 的 tutoring 和实际 UI 由各负责人交付。product/planning/reference/AGENTS、其他任务稿和原课程材料只读，基线汇总交获授权维护者。

## 2. 已批范围和实际门禁

| 项目 | 可核查决定/状态 | 实施条件 |
| --- | --- | --- |
| 第二课程与架构 | 数字逻辑与部件设计；保留同一 Web/Node/Fastify/SQLite、原 C17/GCC/TextScope 和独立执行边界 | 已批方向，不再请求重复批准课程范围 |
| 首实验 | 实验 3：4 位 ALU 与八位数码管显示；Nexys4 DDR Rev. C；PDF 优先，课件作解释 | 顶层/映射/初始化/扫描/可信检查具体配置待 A/C/UI 评审 |
| 未定义域 | M=1/S=10、11；A≤B 减法；未定义 Cout 暂不判分；示例 SW 分配不是唯一答案 | 不能通过补全材料或硬编码唯一映射缩减学生选择 |
| P2 进入 | A3/C3 已收原服务端批次；#11/#26/#24 仍 Open，P2 原预交付尚未确认 | DL 正式评审/实施仍等待确认；提前批次需负责人明确批准，不能把本次任务指令登记为 P2 已通过 |
| DL-D01～04 | 配置、Build/Session/信号/波形、引擎/限额、schema 未冻结 | 各域提案、消费核对、负责人决定与实际操作授权分别记录 |
| DL-D05 | 正常 HTTPS/同源登录、受信代际初始化、实际模型许可 | 不修改凭据/CI；真实账号、模型请求与运行操作未自动获准 |

## 3. 已有代码与最小接入差异

| 已核代码 | 当前行为 | DL-A 需要交付 |
| --- | --- | --- |
| [main](../../apps/teaching/server/main.ts) / [app](../../apps/teaching/server/app.ts) | 默认仅 health；ready=503，没有正常业务宿主和 Job 消费循环 | 在同一入口装配 P2 真实业务工厂和原消费者；受控配置缺失安全失败，不借维护脚本逐次补学生状态 |
| [Access](../../apps/teaching/server/access/app.ts) | 当前 Session、即时课程 membership、可信资源定位；HTTPS Origin/CSRF/Secure Cookie | Build/Session 使用同一授权链，资源 ID/客户端角色均不授予权限 |
| [Design inputs](../../apps/teaching/contracts/design/inputs.ts) / [activities](../../apps/teaching/server/design/activities.ts) | TextScope Core/Report 的不可变活动、配置和 readiness；新课程不在现有规则联合类型 | 课程执行分流提案，C 的原规则/指纹保持独立；获准 HDL 配置才可检查/确认/分配 |
| [Workspace](../../apps/teaching/server/workspace/application.ts) | 真实确认保存/不可变快照、Run Job、暂停/取消；可存 .v/.sv 不等于会构建 HDL | 复用文件/ACK/快照与原 Job，不把 HDL 伪装成 TextScope 参数或普通十秒 Run |
| [Teaching](../../apps/teaching/server/records/teaching.ts) | C3 原文/动作/展示回执/取消与同事务失效已交 | HDL 事件/引用复用原教学和记录链；具体消费 DTO 等 B/C/UI 输入 |
| [DB factories](../../apps/teaching/server/db/transaction.ts) | fresh-only；Access 5、Design 10、Completion 17、Workspace 22、TeacherDesign 24、Teaching 26 表 | 正常两课程宿主的完整表集合及 DL 增量需单独明确批准；不对旧库隐式加表或迁移 |

## 4. A 域共享提案（全部待评审）

### 4.1 固定课程与活动配置

沿现有课程 ID、成员、不可变 ActivityVersion/Assignment/Attempt；提出运行配置判别项 `kind=c_program|hdl_board`，仅固定活动引用批准的配置版本，不从请求体选择任意工具链。HDL 配置引用 BoardProfile/映射/实验检查/运行 profile 的 ID、版本/hash 和 C readiness 指纹；顶层名称、端口/宽度/极性、时钟/初始化/采样由 C 提可执行配置，UI 核其可表达性。名称仅为提案，不新增当前输入枚举。

教师按原编辑→检查→确认→分配流程形成不可变版本；检查/release 必须绑定本次 revision 与当前 C 指纹。C readiness 缺失/过时保留配置错误或待验证项，不假 ready；学生从本人 Assignment 创建/返回固定 Attempt，无需第二套学生或手工插入状态。两课程列表/详情由同一业务宿主及已授权读入口提供，UI 自行维护导航。

ALU 只对题目已定义组合设计可信检查：M=0 的 NOT/AND/OR/XOR；M=1、S=00 的 A+B+Cin；M=1、S=01 且 A>B 的 F。支持学生合法映射，通过独立映射版本解释输入而非强制示例 SW 位置；不预制译码输出、模拟成功或替学生运行。

### 4.2 授权、当前性与身份

A 向 C 交同 Transaction 的受信授权定位器：从持久 Build/Session 反查 courseId/studentId/attemptId/activityVersionId/snapshotId/hash，校验当前账号、活动/分配/Attempt 可用性及所需用途。学生限本人，教师可读取课程范围结果但不代学生装载/推进。学生操作一律显式发起；Agent 只读取获准确切版本。

建议所有变更绑定原资源身份、当前服务端恢复代际和相应 expectedRevision。快照/Build/BoardProfile/映射/运行指纹不可变；Session 身份与模拟时间不随草稿编辑变化，重装创建新身份并保留旧事实。代际从受控持久控制账本初始化/对账，不从客户端、随机重启常量或数据库空缺猜测；无法核实返回 RECOVERY_REQUIRED，不冒充原会话恢复。

### 4.3 命令与错误/恢复

建议有限 Build 复用原 Job/命令回执，成功后显式装载创建 Session；两者生命周期分开。C 提执行操作域，A 封装同源正常 HTTP 授权入口，B/UI 核请求与结果字段。暂不冻结路由、新 purpose、错误码或字段联合类型。

幂等沿可信账号+命令/资源+Idempotency-Key 和全部实质字段摘要。同键同结果返回原 IDs/版本，不重复构建、装载或推进；同键不同摘要 409。Session 输入/按下/松开/批量推进使用单调交互序号与原代际；C 对重复、迟到/乱序、旧代际、停止后操作提出可验证拒绝语义。A 不在超时后自动换键重做。

沿已有 INVALID_REQUEST/UNAUTHENTICATED/FORBIDDEN/VERSION_CONFLICT/IDEMPOTENCY_CONFLICT/STATE_CONFLICT/RECOVERY_REQUIRED/INVALID_REFERENCE/INVALID_CONFIGURATION/RUNTIME_NOT_READY/DEPENDENCY_UNAVAILABLE 等错误信封；若 C 确需新错误码，由评审解释恢复行动后统一批准，不扩枚举迁就实现。

无法确认 Build/Session 结果或退出时保持 unknown、原身份和保槽状态；应用/节点重启后先按原身份对账。权限撤回、活动/分配/Attempt 暂停的控制意图与命令/事件先同事务持久化，网络停止在提交后执行，由 C 给出真实退出确认与资源释放证据。重新获授权或恢复不能重投旧命令/动作。

### 4.4 持久化与正常宿主

A 现有课程表只有 ID，提出按固定活动保存运行配置关联，避免改课程主键/原 C 数据。是否单独建课程配置关联表、BoardProfile 的保存归属以及 Build/Session/交互账本/Trace 表，由 C 给出存储需求后汇总精确 DDL 和表数；本批不提供未经消费核对的最终 schema，也不请求含未知表集合的迁移授权。

普通宿主使用 P2 工厂、受控 DB/Origin/签名/当前代际/runner/provider 配置，唯一公共 Job 路由；保留教师和学生用途分派，消费者按原 Job 处理。初次课程/账号/活动准备须有受控、可重复的授权初始化入口和记录，不能以合成 fixture 当正常应用入口。健康页、工厂注入验证和真实浏览器接入分别验收。启动命令待实际配置交付验证后填写。

## 5. B/C/UI 输入与分批交接

| 输入 | 当前可核查情况 | 所需具体交付 |
| --- | --- | --- |
| C BoardProfile/Build/Session/信号/波形 | #39 发布；main 与 Open PR 未发现本人方案/代码 | 精确 DTO/存储归属、顶层与映射、实际 Linux/引擎来源版本、采样/初始化、限额/公平调度、恢复/退出、readiness/指纹 |
| B 最小教学消费 | #40 发布；尚无本人 HDL 消费方案 | 源码/诊断/输入/模拟时间/信号/有限波形最小引用、可见范围、当前性/过时规则；沿 B1/B2/C3，不新建帮助链 |
| UI 板卡/业务消费 | 原 I0 分支存在，不等于 HDL 已评审 | 实际 UI 的字段需求、四值/扫描/无效状态、输入顺序、装载/停止/重连/未知呈现；界面由 UI 维护 |
| 负责人 | P3 协调启动明确；P2/DL 原门禁仍保留 | P2 原预交付确认或准确提前批次决定；共享/实验配置评审；精确 schema 与运行操作另授权 |

推荐给 C/B/UI 的核对项已写入本表，不发送成员消息。输入到齐后先逐字段差异核对，再标批准版本/消费提交；不使用“原则一致”代替真实调用签名兼容。

## 6. 实施与验证顺序

1. 先确认原 P2 进入门禁或获准提前批次，收 C/B/UI 提案并形成逐项负责人决定。
2. 交精确共享文件/DDL/运行配置与可执行公共测试接缝，再获取实际范围授权；受保护基线由获授权维护者同步。
3. 先用合成账号在正常宿主完成两课程列表→固定活动→Assignment/Attempt 和授权；验证失败配置/旧 revision/重复/冲突请求。
4. A/C 联调真实 readiness/指纹→检查/确认/分配→Build/装载/暂停/停止，核原 ID、代际、快照隔离和未知恢复；保留原 C/活动/认证回归。
5. B/UI 各域接真实结果；A 组织 DL-E2E，同一实际浏览器错误→结果→有据引导→学生修复→新构建/装载。向 A6/B4/C5 交两课程系统验证待办。

| 验收 | 必须覆盖 | 当前结果 |
| --- | --- | --- |
| DL-AC-01 | 两课程同宿主正常进入/固定实验；跨学生、跨课程、撤权、未授权 Build/Session 拒绝 | 未执行 |
| DL-AC-03 | 固定快照/配置/指纹、失败位置诊断，旧配置不开放 | 未执行；等待 C |
| DL-AC-07 | 暂停/撤权/取消、迟到/代际、未知原 ID 对账与真实退出 | 未执行；等待获准 C 批次 |
| DL-AC-09 | 正常启动/停止与同浏览器因果链；C 回归及失败/未执行分列 | 未执行；等待真实宿主/引擎/模型/UI |

## 7. 收口与基线汇总请求

DL-A 尚未完成，不关闭 #38。当前只完成阅读、能力核查与 A 域输入准备；具体契约、DDL、源码、真实 C/模型/UI 验证都未交付。方案落文档不计为原 P2、DL Demo、完整 G3 或教学效果通过。

待获授权维护者汇总：本文确认后的课程运行关联、正常宿主、Build/Session 授权/版本/幂等/恢复及验收接缝应进入 TECH；MVP 第 10 节只汇总真实代码/命令/结果。本文未修改 protected 基线。A4 在等待 DL 批次期间按 #41 的独立依赖推进，见 [A4 方案](A4_LEARNER_STATE_REVIEW.md)。

### 7.1 编码前核对结果

2026-10-12，已同步基线的 typecheck/build 通过；DL-A 尚未修改源码，不计 DL 应用通过。文档静态检查 39 份/575 内部引用/errors=[]，README 空白检查通过。两轴只读方案审查：Standards 硬违反/判断建议均为 0，Spec 未发现 DL-A 提案规格问题；正式跨域契约评审、schema/业务测试、实际运行和浏览器仍未执行，原门禁保留。

### 7.2 负责人提前评审批准（2026-10-12）

负责人明确答复“允许提前评审，保留其余门禁”，仅放行本文 §4～5 的正式契约评审准备。未批准未知 schema、引擎、运行参数或实际业务开放；原 P2/模型/人工语义与完整 G2 条件保留，不能据此宣告 P2 已完成。A 域提案已准备，继续收 C/B/UI 具体输入后逐字段核对；原文旧门禁描述保留其创建时点。
### 7.3 最新工程收口与早期评审准备（2026-10-12）

再次 fetch 后 main 为 `37849f4fa2fd4cc1e058fb8559b33a89a60ceed2`，已正常合入 A4 工作分支。原基线与前文旧门禁记录保留创建时点；根据 [G2 §18.4](G2_OVERALL_COORDINATION.md#184-已完成收口与最终交付) 和 [P2 #24](https://github.com/paher-din/XunJie/issues/24)，负责人已收口本次 P2 工程审查，#11/#24/#26 及 A3/C3 原工程批次已关闭。未完成实际模型/人工语义集中到 [B 后续 #45](https://github.com/paher-din/XunJie/issues/45)，账号与真实调用仍暂缓，由负责人通知复审；不是完整 G2 或实际模型完成。

已按 §7.2 获准范围完成 A 域早期评审准备：核固定 Activity/Assignment/Attempt、现有 Session/权限/Job/回执、当前性与退出未知语义，§4 提案和 §5 跨域输入清单可直接交负责人评审。本次回读 #38/#39/#40/#41 评论均为空，Open PR 列表为空，main 未见 DL-C/DL-B 作者提案；只读检查更新的 I0 UI 分支任务文件也未见 HDL 消费提案。“未发现”限本次可查询交付，不推断成员本地进度。

| 评审项 | A 已准备 | 仍缺输入或决定 |
| --- | --- | --- |
| 固定活动/实验与课程分流 | 原 C 链保留；HDL 版本配置关联、授权/readiness 检查的差异位置 | C 的 BoardProfile/顶层/映射/初始化/扫描与可执行 profile；负责人确认 DL-D01 |
| Build/Session/交互/Trace | 同源授权、原身份/版本/幂等/旧代际/暂停撤权与未知恢复核对清单 | C 精确 DTO/持久化及退出确认；B/UI 的实际消费字段/状态；负责人逐字段确认 DL-D02 |
| 引擎/限额/资源 | 独立执行边界与公平调度/可信检查的业务要求 | C 当前引擎来源版本/资源/限额与获准运行证据；负责人确认 DL-D03 |
| 完整表集合/正常宿主 | 现有工厂/主入口/消费者缺口与 fresh-only 差异提案 | C/B/UI 数据归属后精确 DDL/表数、schema 授权与受控初始化/运行条件（DL-D04/05） |

跨域正式契约核对/批准和 DL 应用实现、DL-AC-01/03/07/09 仍未执行，不关闭 #38，不先编未知表或虚构运行指纹。A4 的 31 表授权只适用于其本人独立状态批次，不能扩为 DL 或共用宿主 schema。等待上述输入期间按已批准范围交付独立 A4，原早期评审许可和其他门禁保持有效。

### 7.4 2026-10-13 远端复核与本批交接

fetch 后 main 仍为 `37849f4fa2fd4cc1e058fb8559b33a89a60ceed2`，#38/#39/#40 正文与评论重新核对，三者均 Open、评论为空。新增 Open [P2 真实模型 PR #46](https://github.com/paher-din/XunJie/pull/46) 与 [C4 PR #47](https://github.com/paher-din/XunJie/pull/47)，前者不是完整 D-02/人工语义/采样收口，后者是作品提交/重开/恢复，均不是 DL-C/DL-B 的 HDL 契约输入。I0 UI 分支更新至 `f975b4203897a2449e90340cffe57bf3d4508b67`，其任务列表仍为原 I0 验证与规则记录，未见 HDL 消费提案；仅陈述本次可查交付，不推断成员本地状态。

A 已完成获准提前评审的本域准备与 §4/5/7.3 可核对清单。仍需 C 的精确 DTO/持久化/readiness/实际引擎配置，B/UI 的实际消费字段/状态，负责人逐项共享决定和精确 schema/运行授权，才可进入正式契约批准与业务实施。#38 不关闭，DL-AC-01/03/07/09 保持未执行；不把 A4 独立 31 表或新 C4 的 schema 批准扩为 DL 许可。独立 A4 的已批准服务端/43 项专项和真实全量失败见 [A4 最终记录](A4_LEARNER_STATE_REVIEW.md#11-最终固定源码验收证据与交付边界2026-10-13)。

## 8. 2026-10-13 A/C 实际消费核对

负责人要求先完成与 C 有关的 DL-A 工作，再交清 B/UI 的具体任务关系。本节完成只读调用核对；未把该指令当作 schema 或共享协议批准。独立本地分支 `codex/dl-a-ac-integration` 从 A4 交付 `6a4361b` 建立；A4 PR #49 不追加本批改动。main 固定为 `37849f4`，C 来源是 [PR #48](https://github.com/paher-din/XunJie/pull/48) 的 `dfb06cd7e78dffae681c4a42979bc2624178043a`。本批尚未合并/推送 PR，也未运行 C 的建库、节点维护或真实仿真。

### 8.1 已交接口与 A 需要完成的调用

| C 的真实入口（PR #48） | 已核对的含义 | A 接入工作 |
| --- | --- | --- |
| `createHdlWorkspace({db,currentGeneration,transport,approvedProfile})` | 配置读取回调在同一 Transaction 内按 attemptId 调用；同库才能复用 Job | 从持久 Attempt→固定活动→获准配置读取 BoardProfile/HdlRuntime，不从请求体收 runtime/角色/学生身份 |
| `build(actor,attemptId,key,generation,{expectedAttemptRevision,snapshotId})` | 保存固定快照/板映射/运行版本，原 Job kind=hdl_build，ACK 含 buildId/jobId | 正常登录 HTTP、课程/尝试授权、当前 readiness 与配置守卫；Build 不能伪装成旧 TextScope Run |
| `program(...)` | 显式装载成功 Build；替换时先写旧停止意图、网络停止、确认终止，再接纳新 Session | 新装载前核固定 Build/运行指纹；替换各事务重新核当前会话及课程授权，不能在等待后仅信任原 ActorContext |
| `interact(...)` | 完整 16 SW/5 按钮/1 resetN 二进制输入，advanceCycles，Session revision/单调 sequence；仅一项在途 | 严格字段解析、学生本人写权限、重复/冲突/迟到拒绝；按下和松开独立显式命令 |
| `readBuild/readSession/readTrace(tx,actor,...)` | 原文/诊断/会话/波形可回取；Trace 一次读下一操作，带 nextSequence；读不推进模拟/续空闲 | 同事务从持久资源定位课程和所属学生，复用 A 角色守卫；保留未知、原 snapshot/hash 和缺帧覆盖 |
| `stopInTransaction(tx,attemptId,reason,generation)` | 以 Attempt 为范围保存未终止 Session 的 stopRequested，并取消非终态 HDL Job；本身不做网络控制 | 活动/分配暂停、成员撤权/账号停用的控制事务调用；停止语义不能误写成仅停止某 Session 而实际取消整个 Attempt 的构建 |
| `pendingJobs/processJob/reconcileStops` | 原 Job 分派；网络执行/停止在 SQL 之外，最终事务核原 ID/代际/租约；未知保留 | 正常宿主消费者调度、启动对账和停止排空；读到停止意图不等于已确认退出 |
| `hdl_readiness` | ready/profile/recoveryGeneration/fingerprint/fingerprintHash/validation；HDL 与 C readiness 各自核实 | 重新计算 fingerprint hash，核 validation、sourceHash/镜像/profile 与当前代际，拒绝旧指纹；不硬编码 PR 的历史 ready |

原有限 Purpose、JobStatus 和唯一公共 Job GET/cancel 保留。C 已接个人 Attempt pause 和 Job cancel，A 不复制另一套处理；活动/分配/撤权接缝由 A 补齐。C4 的提交/重开仍为独立 [PR #47](https://github.com/paher-din/XunJie/pull/47)，本批不静默复制它的两张表或改其作者代码；其提交停止组合在 C4 合入后另作兼容核对，记录为 DL-A 剩余联调项。

### 8.2 需要在本批解决的实际差异

1. **事务授权。** A 的 `withAuthorizedCourse/Resource` 与 C 的 build/program/interact 均自行开启事务，直接嵌套会被数据库拒绝。C 现有 `permitted` 会在命令事务校用户/成员，但没有当前 HTTP Session 的验证能力。提案：A 增加显式接受现有 Transaction 的授权能力；C 的 build/program/interact 增加末尾可选 `authorize:(tx:Transaction,use:read或write)=>ActorContext` 参数（不持久化/不接受请求体），先在原回执读取事务以 read 调用，新接纳/替换停止事务以 write 调用，结果与已传 actor/attempt 所属核一致；原受信 worker 使用原域守卫，不绑定过期 HTTP 请求。网络前仅作预检查，最终事务不能省略此能力。
2. **固定配置/currentness。** C 的 approvedProfile 目前在 build 读取，program/interact 未直接核 A 的固定活动与当前 readiness。A 的事务授权能力同时验证活动/分配/Attempt、原 Build/profile/指纹和本命令已查询的 readiness 结果；Session 继续使用其原快照，不将当前草稿强加给旧会话。同键已提交回执先按当前 read 权限/同摘要/原代际读取，不依赖新的 readiness 或新 write 权限，不重新做已完成副作用；只有新接纳在网络查询后作 write/currentness 守卫。改 readiness/恢复代际不能复活旧命令；停止/对账允许使用原身份完成清理，原节点终止事实由受信清理事务保存，不能因发起者撤权丢失退出事实。
3. **可信检查覆盖。** C 已实现编译/真实顶层端口/映射校验，但 PR #48 没有可直接调用的 ALU 行为 validator。本批提案只把已定义题目域和合法 SW 语义映射冻结为实验配置，明确结构检查与 ALU 行为检查分开；行为检查保持 `unverified`，不借用 textscope-validator-v2 或编造 hdl validator 通过。具体 ALU 行为检查入口列为 C 待交接项，完成前不宣告整个 DL-A 或正式课程检查完成。
4. **配置表达。** C 实际 BoardProfile 只有版本、topModule 和 bindings；极性、100 MHz/1 ps/初始化/稳定相位在执行代码与受信运行版本中固定。A 的固定实验配置显式保存这些规则及引擎/sourceHash/镜像引用；核其与 C 实际代码一致，不假称 C 已有同名 DTO 字段。字符串 MSB-first，offset=0 对应最右字符；板段位/AN 顺序由批准配置明确，不让 UI 猜 a/g 顺序。
5. **Trace 游标。** C 当前 readTrace 在结果仍为 null/queued 时也推进 nextSequence，轮询消费会跳过后来产生的原结果。本批最小 C 修复：未完成或 outcome_unknown 的操作保留原消费游标，不将排队视为消费完成；确认成功正文存在后才推进。无正文的已确认失败/取消用原 Job/Session 的真实终态说明 unavailable，不冒充待处理或有波形，再允许消费方明确越过。结果仍按原 operationId/sessionId/sequence/hash 核验。补先读排队→原 worker 完成→仍读回原操作结果的公共测试。

6. **控制范围。** 活动/分配控制的已有 C3 同事务回调可组合 HDL stop；新授权成员控制必须同事务更改权限并登记停止，后台对账不依赖已被撤销的用户。停止后恢复只允许学生新命令/新 Session；旧波形可按读取权限回看，不恢复旧寄存器。

上述是具体实现提案，尚未批准；C 的内部实现许可与本次 A/C 共享消费许可分别记录。

### 8.3 执行配置和证据边界

复用 C 已实施的 Icarus `12.0-2build2`、Nexys4 DDR Rev. C、10000 ps 周期/5000 ps 半周期、SW=0/按钮=0/resetN=1/clock=0 的初始输入，不强制清零学生寄存器。沿 C 首批限额：构建 30 秒/有限 Job 120 秒，推进 2 秒/最多 5000000 周期，Session 最长 30 分钟/空闲 5 分钟/全节点 2 个，4096 帧/64 KiB 单包/1 MiB 累积 Trace；原 C 限额不变。A 不改节点 systemd/AppArmor、镜像或上述参数。

PR #48 作者报告目标 HDL 14/14、目标 C 50/51（1 跳过）、认证 SSH 10/10、最终领域 9/9、typecheck/build 通过；这些是 C 已交原始记录，本批没有复跑。只读审查已发现原 Trace 游标的待修竞态，不把作者专项通过当作无缺陷证明。作者 WSL 全量 291 项为 274 通过/9 失败/8 跳过，未修改基线 275 项为 264 通过/4 失败/7 跳过；九项失败未逐项证明同根因，完整回归不能记通过。C5 长测/资源极值/公平调度仍留在 C5，不阻止本批接口核对。

新指纹会使旧 C readiness 失效。A 对接时读取当前受控应用 SSH 通道；现有历史 fingerprint/sourceHash 只用作版本来源和反例，不能作为实时授权。实际连接使用已存在的 application/known_hosts 配置，只读路径，不索要、打印或改写私钥/密码/token。若当前机器缺少节点入口或节点未启动，记录真实联调未执行，不自行启动 VM 或执行带代际变更的维护验收脚本。

## 9. B/UI 的具体任务关联与最小输入

本节是交接清单，不发送成员消息，不改他人任务稿。无需等待 B/UI 完整源码才实施 §10 的 A/C 服务端批次；后续正式共享 ObjectRef 和界面消费在收到实际提案后评审，不预先扩大原联合类型。

| 接收方/原任务 | 现在请交的最小输入 | 后续由原负责人实施/验证 |
| --- | --- | --- |
| B：[DL-B #40](https://github.com/paher-din/XunJie/issues/40)「首批 HDL 上下文/版本过时规则」 | 代码/选区沿原 CodeObjectRef；列 Build 诊断、Session/operation 信号与 Trace 引用的必要 ID/hash/sequence/版本；选择当前求助对象的规则，切换/重装/新草稿/撤权何时拒绝或保留历史；区分私有检查资产 | 接 C 确切快照/readBuild/readSession/readTrace 和 A 固定配置，复用 B1/B2/C3，加入 HDL 上下文，不新增聊天/Job/回执系统 |
| B：#40「错误引导与反例」及 DL-AC-08/04/09 | 2～3 个错误场景需要哪些上下文（语法/端口宽度、段码/位选、X/Z/初始化）；需要的截断/coverage/unresolved 字段；模型不可用的降级要求 | 获准实际模型条件后做真实调用及人工语义审阅；学生自行编辑/构建/装载；帮助不计独立掌握。证据交 B4，不等待 A4/B3 完整画像或反馈 |
| UI：[TEAM §7 数字逻辑分批接入](../planning/TEAM_WORK_PLAN.md#p3-数字逻辑分批接入与演示出口)的 DL-UI | 当前实际工程所需的课程/分配/Attempt 进入字段；草稿/ACK/固定快照与已装载 Session 的身份和版本字段；明确接口适配差异 | 复用本人 I0 保存/快照/恢复能力，新增真实 HDL 构建/装载状态接线；不是重排当前 I0/P2 任务或另做前端 |
| UI：DL-AC-03/04/07 的命令状态 | Build 诊断跳转/line-only；装载/替换确认；SW/按钮按下松开/resetN/advanceCycles；单在途/sequence/revision/幂等键；停止意图、确认退出、unknown、重连对账 | 页面刷新只读取；不自动装载/重演按钮或换键重复推进；恢复同原 Session/operation，失败如实展示 |
| UI：DL-AC-05/06 的板卡与波形 | 需要的原始 16 位 LED、8 位 AN、7 位段选/DP、simTimePs、frames/finalFrame、sampleCount/droppedFrames/coverage、极性/位序；其能呈现 X/Z/全灭/多位选/无效状态的说明 | 从 C 帧绘制真实输出，不从 ALU F 补译码；波形容量/覆盖和稳定采样清楚，编辑新草稿不污染旧显示 |
| UI/B/A/C：DL-E2E 与 DL-AC-09 | 各域可消费提交/配置版本和真实入口；同浏览器错误→真实诊断/信号→帮助→学生修复→新构建/装载的分工清单 | A 组织，成员各修本模块；实际展示回执由 UI 产生。完整浏览器/真实模型/真人与工程测试分开验收 |

B 可先回复一张「引用对象/必须字段/读取范围/当前性规则」表；UI 可先回复一张「现有操作/请求字段/结果状态/缺项」表，并给本人任务稿/提交位置。尚不要求真实模型、最终页面或录制视频，也不要求他们替 A 实现课程授权。

## 10. A/C 第一实施批次（2026-10-13 已批准）

### 10.1 具体范围与文件

本批只接 §8 的 C 已交执行接口及 A 业务控制，不修改 B/tutoring、UI、产品/规划/参考/AGENTS、凭据、CI、真实数据库或节点维护配置。消费 C 固定提交使用独立本地集成分支，保留原提交来源；不合并远端 PR 或公开推送。

预计可写：`apps/teaching/server/app.ts`、`server/main.ts`、`server/app/config.ts`，A 的 `server/access/app.ts` 及受控成员控制模块，`server/design/{app,application,activities,readiness}.ts` 与新增 HDL 配置/readiness/HTTP 适配模块，`server/db/transaction.ts` 与新合成 schema，`contracts/design` 的加法式执行分流。仅必要 C 接缝补充：`server/workspace/hdl.ts` 的事务授权参数/调用与未完成 Trace 游标修复、`server/workspace/application.ts` 传递组合能力；C runner/引擎不改。对应公开 HTTP/原 worker 测试、本人任务稿和 README 同步。C 的 Snapshot、BoardProfile、HdlRuntime、frames/Trace DTO 直接复用；B/UI ObjectRef 暂不变。

课程/runtime 分流使用加法式 `kind=hdl_board` 的固定活动形状，原 C runtime/checkRule/validator 与历史活动 JSON 原样兼容。HDL 配置检查冻结顶层/板绑定/ALU 已定义域及合法 SW 语义映射，公开结果明确 `structural` 与 `behavior:unverified`；不宣称存在尚未交付的 ALU validator。不同合法顶层/端口/拨码方案可采用独立配置版本，不将示例映射写成唯一答案。

### 10.2 精确新合成库：33 表

新 `createDigitalLogicApplicationDatabase()` 仅创建并保留全新临时 `synthetic.sqlite`。集合为原 C3 教学工厂 26 表＋原 A3 的 teacher_design_requests/teacher_design_proposals 两表＋C 的 hdl_builds/hdl_sessions/hdl_operations 三表＋以下 A 两表，共 33 表。此处不含 A4 五表或 C4 两表；旧工厂和旧库不变，不 ALTER/迁移/删除，不把本批称为包含 A4/C4 的全模块宿主。

```sql
CREATE TABLE digital_logic_config_versions (
 id TEXT PRIMARY KEY NOT NULL,
 course_id TEXT NOT NULL REFERENCES courses(id),
 created_by TEXT NOT NULL REFERENCES users(id),
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
 config_json TEXT NOT NULL CHECK(json_valid(config_json)),
 content_hash TEXT NOT NULL CHECK(length(content_hash)=64)
);
CREATE INDEX digital_logic_config_course ON digital_logic_config_versions(course_id,id);
CREATE TABLE application_control (
 singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton=1),
 recovery_generation TEXT NOT NULL CHECK(length(recovery_generation)>0),
 control_revision INTEGER NOT NULL CHECK(control_revision>0),
 initialized_at_ms INTEGER NOT NULL CHECK(initialized_at_ms>=0)
);
```

配置 JSON 保存 BoardProfile/HdlRuntime、电平/位序/时基/初始化/采样规则、ALU 已定义域/学生合法映射及结构检查覆盖；同 ID 只能原正文/原 hash 重放，异正文冲突。固定活动保存配置正文/hash/版本及 release 当次 readiness，不能读到后续可变“当前配置”。application_control 初始化使用受控配置和节点实时读回一致的代际，不随机重启生成、不从客户端接受；启动在任何业务事务之前读取并验证持久控制行，向既有 currentGeneration 回调提供受信同步值；回调不得在 C 事务内另开 SQL 事务。运行中不改变代际；需要恢复/重新登记时先停止接纳与消费者，另获授权后重新初始化/启动。不一致安全返回 RECOVERY_REQUIRED，不自动修改节点/数据库代际。授权初始化只操作新合成账号/课程，不生成真实学生记录；新合成账号材料本地保管，不进入源码/日志/commit。

### 10.3 公共接口与正常宿主

| 接口提案 | 输入/结果与边界 |
| --- | --- |
| `GET /api/courses`、`GET /api/courses/:id/assignments` | 当前 Session 派生课程/角色；学生本人分配，教师本课程；返回固定活动和执行种类，拒绝跨域 |
| 原 Blueprint checks/releases、Activity assignments/controls、Assignment controls | 复用既有命令/回执，按固定 runtime 分流；当前 revision/配置/readiness/代际绑定，暂停同事务调用 C 停止能力 |
| `POST /api/courses/:id/hdl-configurations` | 教师写固定配置，key/generation；JSON/hash 验证，不接受任意引擎/镜像/脚本；批准 runtime 白名单来自受控部署配置 |
| `POST /api/attempts/:id/hdl/builds` | expectedAttemptRevision/snapshotId/recoveryGeneration＋Idempotency-Key；返回原 buildId/jobId 回执 |
| `POST /api/attempts/:id/hdl/programs` | expectedAttemptRevision/buildId/recoveryGeneration，可选 replaceSessionId/expectedSessionRevision；返回原 sessionId/operationId/jobId |
| `POST /api/attempts/:id/hdl/interactions` | expectedAttemptRevision/sessionId/expectedSessionRevision/expectedSequence/inputs/advanceCycles/recoveryGeneration＋key；原 operationId/jobId |
| `POST /api/attempts/:id/hdl/controls` | action=stop、reason、expectedAttemptRevision/代际＋key；明确停止本 Attempt 的 HDL 活动，ACK 为停止意图，真实退出读 Session/Job |
| `GET /api/hdl/builds/:id`、`GET /api/hdl/sessions/:id`、`GET /api/hdl/sessions/:id/trace?afterSequence=...` | 同事务可信定位，学生本人/教师本课程只读；C 原结果/正文/hash/游标，GET 不推进模拟/不补造结果；结果未完成时不推进消费游标 |
| `POST /api/courses/:id/memberships/:userId/controls` | 教师本课程，expectedControlRevision/action=deactivate/代际＋key；为本批新增成员控制增加独立可 CAS 的版本契约前需明确持久列；本 33 表方案未包含该列，故不实现此提案端点 |

撤权/账号停用用例先在获准受控管理事务验证“更改现有权限状态＋停止意图”组合能力，不伪装成尚未批准的公共成员管理 API；需要公共 CAS 撤权端点时先补精确 schema 提案。正式提交/重开在 C4 合入后验证，不关闭整卡。

正常 main 组合原 A3/C3/Workspace 工厂及两个课程的原 worker 分派，不另建第二应用或人工逐次 processJob。B 原帮助/模型工厂保持其既有配置入口；本批不扩 HDL 教学上下文，不作付费调用。原 C worker 排除 hdl kind；消费者依次调用 HDL 原 processJob 和 reconcileStops，启动先原身份对账，关停先持久停止再对账/确认或明确 unknown。未配置模型仍可编辑/保存/仿真，求助降级使用既有边界。

入口只读外部受控配置（DB、HTTPS Origin、已有 TLS 证书/密钥文件位置、已有 session 签名材料位置、应用 SSH/known_hosts 位置、批准 runtime/当前代际）。不在仓库建立或改 `.env`/凭据，不生成证书，不放宽 Secure Cookie/Origin/CSRF，不采信任意代理头。缺配置或当前节点证据不一致安全失败。合成 HTTP/事务验证可以先完成；实际 HTTPS/节点联调只使用已存在且获准的入口，无该入口时准确留未执行。

### 10.4 预定公共验证接缝与顺序

待批准后采用 TDD 公共接缝：真实 Session 登录＋Fastify HTTP 命令/读取、唯一 Job 查询/cancel、正常宿主原消费者和 C 的已交 transport。合成故障注入只发生在外部 transport；不 mock 事务、成员身份、固定活动或幂等接纳，不以直接 SQL 断言代替接口结果。受控初始化是合成账号/课程准备，测试业务经真实 HTTP 发起。

| 分批 | 必须验证 |
| --- | --- |
| AC1 固定配置/进入 | 原 C 不变、HDL 配置与活动冻结、两课程列表/分配/Attempt；非法字段/未知配置/错误指纹/私有资料/旧 revision/重复键/冲突键 |
| AC2 构建/装载/读取 | 学生本人正向命令、教师只读、跨学生/跨课程拒绝；确切快照/Build/Session/原 ID/hash；先读取 queued/null Trace，原 worker 完成后同游标仍取得同一操作的真实波形，重复读不跳序；无正文终态如实 unavailable；已提交回执在节点不可用/分配暂停后仍按读取权限返回原 ID，异摘要冲突；网络等待中 Session 撤销/成员撤权后最终新接纳事务拒绝 |
| AC3 交互/停止/恢复 | 顺序/重复/冲突/迟到、旧代际；新草稿不污染旧 Session；活动/分配/个人暂停和撤权同事务停止；rollback 不留下半份停止意图；受信清理仍可执行 |
| AC4 宿主/真实执行 | 正常启动/消费者/停止；真实 readiness→活动开放→Build→program→交互→暂停/真实退出；保留 C/活动/认证回归，所有失败/跳过/未执行分列 |

单文件/类型检查随每个实际改动执行，最终完整回归一次；没有新变更不无理由重复全套。实际模型/浏览器/TLS 未执行不能填通过；DL-AC-01/03/07/09 只登记本批覆盖，不整条勾选。新合成库保留，接口/共享差异和真实结果在本文同步，产品基线只提交汇总请求。

### 10.5 方案提交时完成项与待授权动作

本次完成：C 固定提交逐调用核对、A/C 事务授权/配置/停止及 Trace 游标差异、B/UI 原任务对应交接表，以及可批准的 33 表第一实施方案。源码接入、建库、业务测试、目标节点和浏览器均未执行。没有将 C 作者报告计为 A 验收，也没有发送团队消息或公开发布。

待负责人批准 §10.1～10.4 的 A/C 首批共享接口/合成 schema/公共验证范围后连续实施；这是 AGENTS 的 schema、共享契约与大改动确认，不重复申请已获准的课程方向或提前评审。ALU 行为 validator、C4 提交组合和 B/UI/浏览器仍为整卡剩余项，不通过批准本批静默豁免。

### 10.6 方案验证与两轴审查

2026-10-13，本批只改本人任务稿与 README。`node tools/a0-review/check.mjs` 通过：39 份文档、613 内部引用、errors=[]；`node --test tools/a0-review/check.test.mjs` 16/16、0 失败/0 跳过；`git diff --check` 通过。独立只读提取原 schema/C schema：28＋3＋2＝33、唯一表名 33，没有建库。文档工具使用本机 Node，仅用于静态检查，不计 Node 24.21.0 应用验收。

code-review 两轴：Standards 硬违反/判断建议 0；Spec 初审 1 项 Trace 未完成结果游标竞态，已补入最小 C 修复和公共测试方案，复核未解决 0/新增 0。这是方案问题关闭，源码缺陷仍待本批实施修复，业务、目标环境、TLS/浏览器测试均未执行。主工作区既有文档改动及独立工作树的原 typecheck 日志未改/未提交。

### 10.7 负责人批准实施（2026-10-13）

负责人明确答复“批准该具体范围并继续”，批准 §10 的固定 HDL 活动、33 表 fresh-only、正常宿主/原消费者、事务内授权与停止组合、Trace 游标最小修复及真实登录 HTTP/原 worker/事务验证。真实联调限已存在且获准 C 节点，不启动/维护节点；不迁移旧库、不改 B/UI/凭据/CI/受保护基线、不作真实模型调用/公开推送。ALU 行为 validator、C4 提交组合与浏览器保留独立未完成项。以下按该范围连续实施，预定公共测试接缝已同时批准。

## 11. 批次接缝落实

HDL 草稿使用加法式 `digitalLogicConfigVersionId` 引用独立不可变配置；`runtimeProfileVersionId` 继续表示 C 实际 runtime，不用配置 ID 冒充 runtime。发布后的 `runtimeProfile.kind=hdl_board` 包含完整配置、contentHash 与真实 runtimeProfileVersion。公开检查结果附 `execution: {kind: hdl_board, structural: validated, behavior: unverified}`；这里的结构验证仅指配置约束，端口实际 elaboration 在 C Build 执行，不宣称 ALU 行为通过。原 C JSON 和读取形状不新增默认字段。

正常宿主读取持久 application_control 后提供同步 currentGeneration；只读受控配置、existing synthetic DB 和认证材料。无配置的 main 保留原 health-only 入口且 readiness=503。配置好的宿主启用原业务工厂、Workspace/HDL Job 消费者。未提供模型执行配置的学生求助沿 B 原 budget-denied 降级，不接新增 HDL ObjectRef。所有新合成库保留，初始化材料禁止写入日志或仓库。

## 12. A/C 第一批实际实现与验证（进行中）

2026-10-13，独立 `codex/dl-a-ac-integration` 从方案提交 1d71698 消费 DL-C 固定 dfb06cd7e78dffae681c4a42979bc2624178043a，以本地 merge 保留 C 来源；A4 PR #49 不改，未公开推送、合并远端 PR 或关闭 Issue。C 引擎/安装/维护原字节保留；A/C 修改仅落实本批接口和最小事务接缝。

| 实际代码 | 状态与行为 |
| --- | --- |
| [配置契约](../../apps/teaching/contracts/design/hdl.ts)、[配置保存/readiness](../../apps/teaching/server/design/hdl-configurations.ts) | 已实现独立配置 ID、白名单 runtime、板绑定/ALU 定义域与合法 SW 映射；不可变正文/hash。固定活动含配置全文与释放当次指纹。检查明确配置结构已验证、ALU 行为未验证；实际端口检查仍在 C Build |
| [认证能力](../../apps/teaching/server/access/app.ts)、[原 HDL 服务](../../apps/teaching/server/workspace/hdl.ts) | 已实现借用当前 TX 的真实 Session/课程/学生用途授权；新接纳重新验证，回执重放先于新 readiness。重装外部 stop 等待后重新授权；登出/撤权拒绝新接纳，可信清理保留原退出事实。未完成 Trace 不推进消费游标 |
| [原活动发布/控制](../../apps/teaching/server/design/application.ts)、[原 Workspace](../../apps/teaching/server/workspace/application.ts) | 已按固定执行种类分流，HDL 不进入 TextScope Run；活动/分配/个人暂停的同 TX 停止意图，经 C reconcileStops 对账，已完成 Session 也可停止 |
| [正常宿主](../../apps/teaching/server/app/digital-logic.ts)、[正常 main](../../apps/teaching/server/main.ts)、[受控配置](../../apps/teaching/server/app/config.ts) | 已组合原 A3/C3/Workspace/B 工厂与 HDL，共用唯一 Job 接口；持久代际启动校验、同步 callback、定时原消费者、关停持久停止再对账。无配置维持 health-only；配置后只读已有 TLS/SSH/签名材料，不采信代理头 |
| [fresh-only 初始化](../../apps/teaching/server/app/initialize.ts)、[工厂](../../apps/teaching/server/db/transaction.ts) | 仅新建保留 33 表临时合成库；明确 synthetic 标志与合成 ID，按实际两课程/成员 manifest 初始化、密码只存原 scrypt；当前 C/HDL readiness 和代际必须一致。没有迁移/删除旧库 |
| [公共专项](../../apps/teaching/tests/dl-a-app.test.ts) | 真实登录/CSRF/HTTP/原 worker/SQLite TX；仅外部 transport 合成，覆盖两课程与原 C/HDL Job、固定快照、私有资产、权限、幂等/冲突、Trace、交互、新草稿、撤权并发与 rollback、停止/正常定时消费/重启读取。专项验证持续中，最终数字后补 |

模型配置未接本批正常进程。学生 help 沿原错误契约返回 DEPENDENCY_UNAVAILABLE，不创建无人消费的 Job；教师 Agent 用原预算守卫拒绝调用。没有付费调用、供应商网络或 B 新 HDL ObjectRef。撤权/账号停用只暴露受控管理事务能力，公共 CAS 成员管理端点仍未实现。

本机只读核查 WSL Ubuntu 的既有 `/opt/xunjie-runner/vm/keys/application` 与 `known_hosts`：所需材料不齐，输出为 Authorized application material unavailable，未发起认证 SSH。真实 readiness→发布→Build/program/interact/暂停链未执行；未启动 VM、安装/维护节点或改变代际。不用 C 作者已有真实记录替本批 A 通过。

本批 protected product/planning/reference/AGENTS 仍只读，汇总维护请求：MVP §10 登记此代码位置/实际专项、全量结果与下述未完成项；TECH 增加 fixed HDL 配置/runtime 分流、借用 TX 会话授权、pending Trace 游标及控制停止语义；不得将本批状态写成完整 G3/MVP 通过。

剩余整卡条件：真实获准 C 节点 A/C 指定业务联调、ALU 行为 validator、C4 提交组合、B 的 #40 上下文/过时/真实模型与人工语义、UI 的课程/工作区/装载/信号/恢复及同浏览器 DL-E2E、原 NFR/真人/TLS/浏览器。B/UI 具体对应原任务与要交字段见 §9。#38/#39/#41 等卡不据此关闭。
