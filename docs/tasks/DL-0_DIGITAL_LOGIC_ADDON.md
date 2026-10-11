# DL-0：数字逻辑课程增量与本地演示总协调

日期：2026-10-11（Asia/Shanghai）。任务编号：DL-0。协调沿用 A 的应用集成职责；A/B/C/UI 保持原模块责任。

状态：负责人已批准前序核对提出的新增课程范围和实施顺序，并要求在独立工作树中交付；随后指定 `course_matrial/data_logic` 为课程材料来源，并确认“采用 PDF 已定义范围与 DDR Rev. C”。本工作项已在独立工作树完成文档增量、任务拆分与静态验证；提交/推送与 main 状态见第 6 节。实验 3 ALU 与板卡范围已确认，运行/初始化/扫描配置、Build/Session 共享契约及数据库方案待评审，应用实现与演示验收未执行。DL-* 为本地任务代号，尚未发布对应 GitHub Issue。

## 1. 来源、依据与写入范围

提案输入为负责人提供的 `xunjie_digital_logic_addon_lead_handoff_2026-10-11.md`。该附件自述为“负责人执行交接与变更提案”；附件中的任务发布、迁移和运行指令不自动构成执行授权。下文纳入团队独立查阅所需的范围、差异、依赖和验收入口。

已按顺序阅读 [AGENTS](../../AGENTS.md)、[README](../../README.md)、[PRD](../product/PRD.md) §1/3/4/5/6/9、[MVP_SPEC](../product/MVP_SPEC.md) §1/2/4～8、M-02/03/04/05/10、[TECH_DESIGN](../product/TECH_DESIGN.md) §1～3/8/9/12，以及 [TEAM_WORK_PLAN](../planning/TEAM_WORK_PLAN.md)、[I0 提案](I0_STUDENT_VERTICAL_SLICE.md)、[工程衔接说明](../reference/ENGINEERING_HANDOFF.md)。对应 PRD-02/03/04/05/09/10；原 M、AC、NFR 与 G0～G4 仍有效。

本次基于 `main` 固定提交 `0afd008c91373f82bde707aaeb26bc6b3dfd74e4`，分支为 `codex/digital-logic-baseline`。主工作副本的未提交内容和十个冲突路径未带入、不处理。

| 可写文件 | 本次维护范围 |
| --- | --- |
| 本文 | 决定与待评审项、源码差异、任务批次、验证与交付事实 |
| `AGENTS.md` | 新增课程决定与数字逻辑 UI 提前接入的最小例外；保留文档权限、学生操作和红线 |
| `docs/product/PRD.md` | 新增第二课程与本地演示范围，保留原 C 课程及教学原则 |
| `docs/product/MVP_SPEC.md` | 数字逻辑演示链及独立验收，保留原 TextScope、M/AC/NFR 和完成定义 |
| `docs/product/TECH_DESIGN.md` | 同架构课程执行分流与 HDL 设计约束；具体接口/schema 保持待评审 |
| `docs/planning/TEAM_WORK_PLAN.md` | 数字逻辑增量任务、依赖与提前接入例外；原 A/B/C/UI 职责与 P5 验收保留 |
| `README.md` | 两课程范围和任务导航；不填写未经验证的演示启动命令 |
| `course_matrial/data_logic/` | 将负责人指定的四份未跟踪输入原样复制到独立工作树并核 SHA-256；负责人于 2026-10-11 确认有分发权并明确授权四份材料一并公开推送，不改写原材料 |
| `course_matrial/data_logic/.gitattributes` | 仅对原始 XDC 设置 `-text` 保留提交/检出的原始字节，不修改全局 Git 配置或关闭 diff/空白检查 |

只读：`docs/reference/**`、其他成员任务稿、应用/测试/配置/锁文件、UI 仓库。本次不安装依赖、不改数据库、凭据或 CI、不发布或关闭 Issue、不执行模型付费调用或部署。

## 2. 已确认范围与未冻结事项

### 2.1 课程和架构决定

以下保留交接提案中三项架构与课程决定的原意：

1. **总体架构不变**。沿用主仓库当前已开发的独立 Web 应用方案：团队现有 React UI、Node.js / TypeScript / Fastify 应用、SQLite、A/B/C 业务模块、独立执行节点/隔离边界及其权限、版本、回执、作业管理机制。**不启动 Electron/Tauri 重构，不新建一套并行后端，不将执行引擎替换为纯浏览器 WASM**。
2. **原 C 语言课程完整保留**。现有 C17/GCC、TextScope Core → Report、相关设计文档、接口、测试与历史验收记录继续有效；不得把原运行操作、代码或课程素材覆盖成数字逻辑版。
3. **增设第二门课程：「数字逻辑与部件设计」**。以 SystemVerilog/Verilog、真实 RTL 功能仿真、交互式虚拟开发板（按钮、拨码开关、LED、七段数码管）、必要的波形和 Agent 引导为核心；采用可扩展的**课程配置 / 执行配置分流**，不为第二门课程建另一套学生、作业和教学系统。

当前阶段出口为一个正式命名、可复现的实验及本地真实演示：错误设计 → 真实异常 → 有据可查的 Agent 引导 → 学生自行修复 → 新快照构建/虚拟装载 → 输出改变。按负责人指定材料与后续裁决，首个实验为「实验 3：4 位 ALU 与八位数码管显示」，板卡为 Nexys4 DDR Rev. C，行为按题目 PDF 已定义范围。计数/复位不是该题目的新增课程要求；按键和状态保持用例作为执行/板卡能力验证，不强加到 ALU 的学生评价。

虚拟装载为装载仿真构建并按规则重置会话，不生成实体 FPGA bitstream。本阶段不要求公网生产部署、云服务器、桌面安装包或全部长期功能；Demo、正式 MVP 工程验收、真人试点与教学效果分别记录。

### 2.2 实施前需要完成的评审

| 编号 | 待定内容与必须交付的依据 | 主责与阻止的工作 |
| --- | --- | --- |
| DL-D01 | 实验 3 ALU、Nexys4 DDR Rev. C 及 §2.3 的 PDF 优先/未定义域暂不判分已确认；顶层/映射/初始化/扫描与可信检查配置待评审 | A/C/UI 按已批范围提案，负责人确认；阻止具体实验配置和引脚协议实现，不重复请求已批课程范围 |
| DL-D02 | 实际本地演示机与独立 Linux 执行环境、引擎/VPI 来源与精确版本、镜像/启动及异常退出方式 | C 提案、负责人确认操作范围；阻止真实引擎实施/验收 |
| DL-D03 | Build/Session/信号/波形的授权、版本、幂等、交互顺序、重连/取消/失联/恢复规则及所需持久化增量 | A 汇总 B/C/UI，负责人评审；schema/迁移另授权，阻止共享接口实现 |
| DL-D04 | 编译和单次推进限时、会话总时长/空闲释放、会话数量、CPU/内存/输出/波形限额与 C 作业公平调度 | C 提案、A 协调，负责人确认；不能将 C 的两个作业槽和 10 秒执行规则改掉或直接当长期会话规则 |
| DL-D05 | 本地 HTTPS/同源/受信代理与账号准备；真实模型账号/API/数据/配额及调用许可 | A/B/C 按 D-02/D-03 与既有门禁落实；凭据、付费、真实数据发送另授权 |

新增接口、对象字段、错误码和数据库表尚未批准。总任务与文档交付不授权 A/B/C/UI 自行冻结上述事项或开始大规模实现。

### 2.3 课程材料核对与具体裁决提案

四份输入在主工作副本中尚未跟踪，因此从负责人指定目录原样带入独立工作树；源文件与副本字节数、SHA-256 全部一致。文档准备时未修改、提交或公开发布材料；负责人随后确认分发权并授权一并公开推送，实际交付见第 6 节。材料用于课程定义和工程评审查阅，不改变原 TXT/Markdown 资料导入范围，不自动发送给模型。

| 来源 | 已读范围与用途 | SHA-256 |
| --- | --- | --- |
| [实验01-入门](../../course_matrial/data_logic/实验01-入门.pptx) | 37 张 slide 文字；第 5 页板卡部件、第 9 页开发阶段、第 13 页 SystemVerilog、第 19～20 页约束用途 | `eaa05738aef03448c796bf6fde634d96dc3d19162fe064ebb413fd09e6bfe2cf` |
| [实验03-ALU 课件](../../course_matrial/data_logic/实验03-ALU.pptx) | 14 张 slide 文字；第 2～4 页分层数码管、第 7 页 ALU 控制/标志、第 10 页 X/Z。仅文字抽取，未宣称完整 PowerPoint 视觉审阅 | `a773a6c047df064df6672af28d5bf1a06d67213878a2c77e746413bb5f724459` |
| [实验03题目-ALU](../../course_matrial/data_logic/实验03题目-ALU.pdf) | 完整 2 页文字抽取并渲染检查；第 1 页要求/表 1，第 2 页显示样例/框图 | `313bd19d014be18c4b5018e46cad3d2fcf0f1eadc0106596ad6a7f4858c9da65` |
| [Nexys4DDR_Master.xdc](../../course_matrial/data_logic/Nexys4DDR_Master.xdc) | 完整引脚表；文件头 Rev. C，100 MHz 时钟、16 SW/LED、8 AN、CA～CG/DP、5 按钮与 CPU_RESETN | `eac2b40e302cd81fb73565b54225be88418d4d3fa502b80f6c064a1fdb49e859` |

**材料明确的行为：** 题目要求无符号 4 位 A/B、Cin，4 位 F 与 Cout；M=0 下 S1/S0=00/01/10/11 对应 NOT A、AND、OR、XOR，M=1 下 00 为 A+B+Cin，01 为 A−B−Cin 且写明 A>B。SW→LED，八位数码管显示十六进制输入/结果。SW 映射允许学生自行确定，题目给出的 SW[15]=M、SW[14:13]=S、SW[3:0]=A、SW[7:4]=B、SW[8]=Cin 是示例，不能升格为唯一正确答案。

**板卡事实：** XDC 指定 `CLK100MHZ`=E3/10 ns，`SW[15:0]`、`LED[15:0]`、`AN[7:0]`、CA～CG/DP 与按钮；SW/LED/按钮行多为注释模板，不表示这些端口已经启用。板卡有效电平由 [Digilent Rev. C 手册](https://digilent.com/reference/_media/nexys4-ddr:nexys4ddr_rm.pdf) §7/10/10.1 补核：普通 LED 高电平亮，五个方向/中心按钮按下为高，CPU_RESETN 按下为低，AN 与段选/DP 低有效。XDC 是资料输入，不执行学生上传的任意 Tcl。

| 材料差异 | 裁决/提案 | 状态 |
| --- | --- | --- |
| 课件第 7 页的 `aluSel[2:0]`/nf/zf/ovf/cf 与题目 M/S1/S0/Cin/F/Cout 不同 | 首条实验以题目 PDF 为行为依据，课件用于解释；不额外要求四个标志或课件的八种运算 | 2026-10-11 负责人已确认 |
| 表 1 的 M=1、S=10/11 留空；减法只写 A>B，Cout 在减法/位运算中含义不明 | 空白组合、A≤B 的减法及未定义 Cout 暂不判分；材料定义的加法/位运算和 A>B 减法 F 仍保留，后续 A/C 在此范围内交可信检查配置 | 2026-10-11 负责人已确认范围，具体检查配置待评审 |
| PDF 泛称 NEXYS4，而入门课件和 XDC 明确 DDR Rev. C | 首条虚拟板按 DDR Rev. C 建模，保持板型/映射版本独立；不混用非 DDR 引脚表 | 2026-10-11 负责人已确认 |
| PDF 框图的 x7Seg/Hex7Seg 是参考结构；未提供实验 2 完整源文件及扫描频率/初值规则 | 保留分层设计目标和选择空间；A/C 提初始化/扫描/仿真推进方案，模板不预制学生译码输出 | 具体运行配置待评审 |

建议首条录制用题目明确的 NOT/AND/加法例子：A=1 的 NOT 得 E；A=1、B=0 的 AND 得 0；A=1、B=2、Cin=0 的加法得 Cout=0/F=3。故意错误可选段码/位选或加法逻辑，真实修改后在同输入下重现改变。以上仍是演示方案提案，不是已完成的录制或新增正式判分契约。

## 3. 固定提交的源码核对与证据边界

| 对象 | 已核实事实 | 最小衔接工作 |
| --- | --- | --- |
| [默认入口](../../apps/teaching/server/main.ts)、[健康工厂](../../apps/teaching/server/app.ts) | 默认只组装健康应用，ready 返回不可用 | A 统一交付两课程共用的业务宿主与作业消费者，不为数字逻辑另建后端 |
| [活动规则](../../apps/teaching/contracts/design/inputs.ts) | checkRule 仅接受 TextScope Core/Report 与原 validator | A/C 先提课程运行/检查配置分流及 readiness 方案 |
| [文件保存](../../apps/teaching/server/workspace/files.ts)、[快照](../../apps/teaching/runner/snapshot.ts) | 路径/文本/快照层没有 `.v/.sv` 扩展名白名单；compilerArgs 固定要求 `.c` 和 C17 | 复用保存/ACK/快照，新增独立 HDL 执行分支；不能将静态允许文件名计为 HDL 集成已验收 |
| [运行参数](../../apps/teaching/server/workspace/inputs.ts)、[节点契约](../../apps/teaching/contracts/runner/index.ts)、[worker](../../apps/teaching/server/workspace/worker.ts) | 仅 TextScope 一次性作业，调度全局两个运行槽，无 HDL 持续交互协议 | Build 作业与长期仿真 Session 分开管理，具体配额和恢复语义先评审 |
| [认证入口](../../apps/teaching/server/access/app.ts) | 工厂要求 HTTPS Origin，Secure Cookie 与 Origin/CSRF 校验 | 本地启动交接包含真实可用的认证/同源方案，保留安全约束 |
| [B1 PR #29](https://github.com/paher-din/XunJie/pull/29) | 核对时 Open，head `de794ba38e05a89683f0263d02d4df7f9792c16b`；作者报告 SDK 受控传输 45/45，供应商调用 0 | 状态比附件“invoker 未交付”已有进展；未合并、无真实调用，不计真实教学链完成 |

附件引用的 [Design 研究报告](https://github.com/wubq511/XunJie_Design/blob/6b6c40f/docs/research/virtual-board-feasibility-2026-10-11/README.md) 与 [Spike](https://github.com/wubq511/XunJie_Design/tree/6b6c40f/docs/research/virtual-board-feasibility-2026-10-11/spike) 在核对时读取返回 404。macOS arm64 Icarus/VPI 核心 8/8、扫描 5/5 为附件转述，未独立核验、未复测，不计主仓库或目标 Linux 环境通过。移植前由 C 核源码、依赖、许可和实际运行记录；不能复制原型二进制作为目标部署证据。

## 4. 增量任务与依赖交接

任务按既定角色领取，实际 GitHub 编号在获准发布后填写；不要求收集人员姓名作为前置，也不覆盖旧任务记录。共用业务宿主与 I0/A3 协调同一份交付；B1/B2/C3 共用教学链，原 [#11](https://github.com/paher-din/XunJie/issues/11)、[#22](https://github.com/paher-din/XunJie/issues/22)、[#23](https://github.com/paher-din/XunJie/issues/23)、[#24](https://github.com/paher-din/XunJie/issues/24)、[#30](https://github.com/paher-din/XunJie/issues/30) 继续原范围追踪。

| 任务 | 主责 | 必需工作和交付 | 进入条件与验收 |
| --- | --- | --- | --- |
| DL-0 | 负责人/A 总协调 | 范围与文档、板卡/接口评审、任务依赖、分层证据汇总 | 本次仅完成文档阶段；具体契约待确认，Demo 未执行 |
| DL-A | A | 两课程共用正常业务宿主、课程/活动配置和分配进入、可信代际初始化、公共契约/权限/readiness；提出数据库差异 | DL-D01/03/05 及必要授权；从正常入口进入课程，无需手工补状态，跨课程/学生拒绝，C 课程回归 |
| DL-C | C | 实际隔离 Linux 中的 HDL Build、虚拟装载、保持状态的 Session、输入/批量推进、真实信号/有限波形、停止/超时/异常回收及版本绑定 | DL-D01～04；真实输入输出/寄存器保持、编译失败、错误译码/位选、X/Z、取消/双实例隔离、C 回归；不等待模型或前端美化 |
| DL-B | B | 复用 B1/B2/C3，加入获准 HDL 选区、编译诊断、模拟时间/信号/波形摘要及版本守卫；2～3 个引导案例与反例 | 冻结上下文契约可先用合成数据；联调等待真实 B1/B2/C3 和 DL-C 结果；展示真实 AI 必须有获准真实调用证据，不等待全部 A3 |
| DL-UI | UI | 沿用实际工程，提前核操作/状态及 API Adapter；接编辑/ACK/构建/装载、真实板信号、推进/波形、版本化求助与失败状态 | 板卡/接口评审后可并行准备，真实接线等待对应 A/C/B 批次；同一浏览器完成修订/重装，Mock 只作明确标注的开发预览 |
| DL-E2E | A 协调，A/B/C/UI 各自验收 | 正常启动的错误→引导→自主修复→输出改变、复现说明、固定版本与录制证据、失败/未执行清单 | DL-A/C/UI 正向和 DL-B 真实链完成；按 MVP §1.4 独立验收，不能替代原完整 G1～G4 |

交付顺序：实验/板卡与共享契约评审 → A 公共宿主和 C 目标环境引擎分线推进，B 继续真实教学链，UI 提前准备冻结协议的状态/适配 → 分批真实接线 → DL-E2E。每项编码前建立本人任务记录并核准预计可写文件；单个成员的原任务与 DL 任务仍需安排个人顺序，不虚构人力并行。

## 5. 验证方案、交付状态与下一步

文档验证：仓库既有 `node tools/a0-review/check.mjs` 和 `node --test tools/a0-review/check.test.mjs`；另用只读断言核旧 TextScope 行为、M-01～10/AC-01～16/NFR-01～06 与原完成门槛保留、产品/规范/规划一致、改动仅在本次清单，运行 `git diff --check`。不安装应用依赖。

| 对象 | 当前结果 |
| --- | --- |
| `node tools/a0-review/check.mjs` | 通过；33 份 Markdown、448 处内部引用、原 27 条变更接口，`errors=[]` |
| `node --test tools/a0-review/check.test.mjs` | 16/16 通过，0 失败、0 跳过；本机 Node 24.15.0，静态文档检查不安装应用依赖，不宣称已核批准工具链 |
| `node --input-type=module` 内联只读范围断言 | 9 组通过：旧 TextScope/M/AC/NFR/完成定义、原 API/C 执行/隔离、权限/红线、历史/P5、九个独立 DL 验收、ALU 裁决一致性、文件范围、四材料哈希与主副本文档保留 |
| `git diff --check` | 通过；仅七份文档与四份输入材料副本，应用、工具、skills 未改 |
| 材料读取与原样复制 | 37/14 张课件文字已读，题目 PDF 2 页文字/渲染已查，XDC 已读；四副本与负责人指定源文件 SHA-256 全部一致，未声称完整 PPT 视觉验收 |
| 应用编码、typecheck/业务回归 | 未执行；本次无应用改动 |
| Icarus/VPI 目标节点、真实模型、浏览器 Demo | 未执行 |
| 真人试点与教学效果 | 未执行 |
| GitHub Issue/PR 发布、合并与主工作副本同步 | 未执行 |

额外范围断言首轮失败：TEAM 尚未直写已批准的“未定义项暂不判分”范围。补齐 §11 的具体裁决后，同一范围检查复跑 9 组通过；未修改原验收条件或关闭检查。全部交付保留在独立工作树，主副本受保护文档/README 与起始版本一致；渲染中间文件仅在 Git 已忽略的本地缓存保留，不纳入交付文件或删除操作。

下一步：A/C 按已确认的 ALU/DDR Rev. C 范围提交 DL-D01 剩余配置、DL-D02～04 和公共宿主/认证的具体方案；B 同步真实模型门禁与原任务交接。未批准部分继续保持待评审。文档验证通过只表示本工作项的文档阶段完成，不表示数字逻辑已实现或已验收。

## 6. 2026-10-11 分支发布授权与交付

项目负责人要求文档完成后推送。核对目标 `paher-din/XunJie` 为公开仓库后，负责人明确确认对以下四份材料有分发权，并授权“一并公开推送”：`实验01-入门.pptx`、`实验03-ALU.pptx`、`实验03题目-ALU.pdf`、`Nexys4DDR_Master.xdc`。这是材料公开分发的具体授权，不延伸到其他教材、模型发送或生产部署。

发布范围为本工作项七份文档、四份材料和一个局部 `.gitattributes`，共十二份文件，材料 SHA-256 与 §2.3 一致。目标分支为 `codex/digital-logic-baseline`；正常提交/推送，不修改主工作副本或合并 main，GitHub Issue/PR 尚未创建。文档阶段的“未推送”记录保留其准备时点，后续发布事实以本节为准。

提交检查发现本机 `core.autocrlf=true` 将 XDC 从原始 19,888 字节转换为暂存区 19,623 字节，SHA-256 从 §2.3 的 `eac2...e859` 变为 `630fbdd059dc20f19827d02f328ed023715599b77dc4eece10ab851310e22f02`。为保证材料归档可核验，局部属性仅给 `Nexys4DDR_Master.xdc` 设置 `-text`，按 [Git 官方属性语义](https://git-scm.com/docs/gitattributes) 保留原始换行，不改材料、不将其标为 binary、不关闭 diff 或 whitespace。原始文件末尾空行等格式提示单独保留并报告；文档空白检查仍须通过。

本批正在准备提交；实际提交、推送和远端核验结果在成功后追加。应用/引擎/模型/浏览器/真人验收仍未执行。

暂存区验证：四份材料的 Git blob、工作树副本与负责人指定源文件逐字节一致，SHA-256 全部通过。设置属性后以 `git add --renormalize -- course_matrial/data_logic/Nexys4DDR_Master.xdc` 重新处理该暂存文件，未改原文件。全范围 `git diff --cached --check` 返回 2，仅原始 XDC 的 CRLF/末尾空行产生提示；`git diff --cached --check -- AGENTS.md README.md docs course_matrial/data_logic/.gitattributes` 通过。前述文档阶段的空白通过不覆盖后来新增原始材料的格式提示。

发布前远端 main 已进入 `83e528ecd3d3de7a13e6addc57ba9111860b06f7`，B1 PR #29 已合并，真实供应商调用条件仍未完成。§3 的 Open/head 记录保留其核查时点；本发布将该上游更新合入文档分支并验证 README 双方内容，不改写其历史或将 SDK 适配计为真实模型验收。
