# DL-A：数字逻辑课程、共享契约与业务接入

日期：2026-10-12（Asia/Shanghai）。主责：A；对应 [Issue #38](https://github.com/paher-din/XunJie/issues/38)。状态：基线/源码核查和 A 域提案准备完成；正式评审、实现及业务验证未执行。本文是待评审提案，不是已批准共享契约。

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
