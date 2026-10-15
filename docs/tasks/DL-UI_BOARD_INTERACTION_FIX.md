# DL-UI：虚拟板完整交互检查与修复

日期：2026-10-15（Asia/Shanghai）。负责人：Robert；实施：当前 Agent。状态：本任务修复及板卡专项完成；全量浏览器门禁未通过，失败与基线复现分列如下。

## 1. 当前授权与基线

Robert 明确要求新建工作树和分支，检查数字逻辑课程虚拟板按钮、开关点击无响应，并完成整块板的正确实现与可用性验证。本任务授权修复既有板卡交互及必要调用链，不扩大课程题目、板型、共享契约或教学判据。

- 基线：最新 `origin/main`，`d77c9cc`（PR89 merge）；工作树 `hdl-virtual-board-fix/XunJie`；分支 `codex/hdl-virtual-board-fix`。
- 原工作区存在其他人的未提交修改与未跟踪资料，保持原样。
- 已读：README、AGENTS、`docs/DESIGN.md` 的 Overview/Colors/Typography/Layout/主题约定；PRD §1.1、§4.5；MVP_SPEC §1.4、§2；TECH_DESIGN §8.5；DL-0 §2.1～2.3；I0_UI_SPEC；I0_UI_CLIENT_CONTRACT §1～8；IMPORT_SOURCE §1～3；I0-UI_HDL_REAL_BROWSER §1～3、§7；TEAM 的 P3/P4/P5 由只读审计补核。
- 适用：DL-AC-03～07/09、UDL-03～06；保留 M-03/09/10、AC-04/06/12 和既有版本、幂等、四态及独立隔离边界。

## 2. 写集与方案

可写：`apps/student/src/components/workspace/HdlToolArea.tsx`、`CenterToolArea.tsx`，必要的 `pages/PrepWorkspacePage.tsx`、`workspace/useHdlWorkspace.ts`、`workspace/hdlWorkspace.ts` 及对应既有接口消费点、板卡控件禁用样式 `styles/app.css`、相关测试、本任务记录。实际另新增 `apps/teaching/runner/hdl-board-inputs.runtime.test.ts` 验证既有引擎的完整输入，不修改引擎实现。

学生 `README.md` 同步实际板卡操作。只读：`docs/product/**`、`docs/planning/**`、`docs/reference/**`、全部 AGENTS、其他任务记录、密钥/配置和现有服务数据。保留 UI 来源、布局、框架与原依赖锁；不迁移数据库、不变更模型通道、不部署或重启既有 3444 服务。

方案：先用真实页面的隔离浏览器检查建立能判定点击响应的反馈环；定位真实课程和演示入口的实际表现；覆盖全部输入、真实输出、时钟推进、停止/重连和错误状态；修复根因后执行相称的单元、浏览器与构建验证。合成 HTTP 协议测试不当作实际 RTL 仿真通过。

## 3. 验收项

- 16 SW 均可切换，5 BTN 的按下/松开与低有效 resetN 正确表达。
- 点击后有可辨认输入状态；命令只按原顺序/版本提交，pending、unknown、停止时不误发或伪造成功。
- LED/AN/SEG/DP 与波形消费原返回帧，四态和精确模拟时间保留，不在 UI 代算 HDL 输出。
- 显式推进、已装载版本、刷新恢复及停止边界正确；原 C 与演示身份保留。
- 提交仅含本任务写集与记录。推送、PR、合并、部署如实际执行分别记录；不自动合并主线或发布。

## 4. 诊断与验证

### 4.1 实际发现与修复

当前基线的最小正常 Chrome 检查已能通过 SW0 输入；新增完整输入检查在修复前也通过。因此没有把反馈直接归因为丢失点击处理器。

确定复现的交互缺陷：运行中将“推进周期”填为 `0`（空值、超过上限、非整数同样适用），`validCycles=false` 会禁用全部 SW/BTN/resetN/推进，但原页面仍只显示“虚拟板运行中”，没有说明禁用原因与恢复方式。命令 `npm run test:e2e -- hdlRealWorkflow.spec.ts --grep '板卡禁用有原因' --workers=1` 在修复前对缺失的无效周期提示真实失败；修复后同调用链通过。

只读核对现有本机合成库：已有 HDL Session 均已结束，最后一条为 `failed` 且 `termination_confirmed=1`；不能将这些历史会话自动恢复为 active。原反馈缺少任务/步骤，因此本记录不声称已证明反馈当时唯一原因。

实际改动：

- 所有板卡禁用状态显示原因；推进周期错误有 `aria-invalid` 和关联说明，修正原输入框即可恢复。
- 板卡旁显示原确认帧的 SW/BTN/RESET_N，区分输入确认与 HDL 输出是否改变；未连接的按钮/复位保留禁用与原因。
- 未装载或确认退出后，可在板卡旁显式装载已成功构建的设计；另提供只读“读取板卡状态”。两者复用原 `onHdlLoad` / `hdl.read`，保留 canProgram、版本、pending、unknown、权限及替换确认门禁，没有隐式创建会话。
- 禁用按钮和开关有明确视觉区别；LED/AN/SEG/DP 仍消费原四态帧，不增加 UI 译码或模拟计数器。

### 4.2 实际验证

学生检查使用现有 Node `v24.15.0`、原 lockfile 已安装依赖和独立端口5821/5822/5823；浏览器为已安装正常 Chrome，不复用现有服务端口。工作树 node_modules 仅为已有依赖的开发目录链接，没有改依赖/lockfile。

| 检查 | 结果与范围 |
| --- | --- |
| `rtk npm run typecheck`（apps/student） | 通过 |
| `rtk npm test`（apps/student） | 44文件、578/578通过；含原客户端/组件/降级反例 |
| `rtk npm run build`（apps/student） | 通过；已有大 chunk 提示保留 |
| `rtk npm run test:e2e -- hdlRealWorkflow.spec.ts --workers=1` | 正常Chrome 9/9通过：16SW双向32步、5BTN两阶段、resetN、显式推进/最大周期、刷新、pending/失ACK/旧响应、停止重装、C入口和键盘；HTTP协议为明确测试替身，不计真实RTL |
| `rtk npm run test:e2e -- --workers=2` | 最终全量228项：177通过、12失败、39跳过，11.9分钟，退出1；其中本任务HDL 9/9全部通过（包含新增板内读取按钮）。[完整测试输出，不含重复工具警告](evidence/board-interaction-20261015/browser-full.txt) |
| 教学 TypeScript：WSL Node24.21.0执行 `node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | 通过；覆盖新增真实引擎测试类型 |
| 新 `hdl-board-inputs.runtime.test.ts` | 专用guest实际27/27、0跳过，52次连续操作，最终seq52/time730000ps，确认停止。全部SW双向、全部BTN两阶段、低有效复位、持续寄存器、真实八AN扫描、SEG/DP、X/Z、多AN/全灭及停止后拒绝通过。原始[TAP](evidence/board-interaction-20261015/runtime.tap)、[全部原观察](evidence/board-interaction-20261015/observations.json)、[摘要](evidence/board-interaction-20261015/runtime-summary.json) |
| `node tools/a0-review/check.mjs` / `git diff --check` | 当前通过，最终记录随全量回归更新 |

真实引擎范围：从既有受限guest配置派生独立临时state/config，使用本工作树 TypeScript runner 与原不可变容器镜像，维护 dispatch 不登记新readiness；未部署引擎或重签指纹。guest冻结runner与本树存在已核对差异，详见[源码审计](evidence/board-interaction-20261015/execution.json)；镜像内C/VPI依然是原冻结版本，不能宣称验证了本树尚未部署的C源码或新镜像。原config和validation账本字节前后不变，测试只终止自己创建的实例。

复现入口：在已有获准隔离Linux执行环境、固定镜像和Node24.21.0就绪后，从本仓库 `apps/teaching` 运行 `XUNJIE_DLC_CONFIG=<既有获准配置绝对路径> node --test --test-reporter=tap runner/hdl-board-inputs.runtime.test.ts`。测试自行派生独立state/config并保留其合成观察，不写原配置/账本或应用数据库；执行前按原工程流程核对实际节点/镜像来源，不据此登记正式readiness。

主Agent独立回核已入库52条Operation的resultHash、连续sequence、同Session和snapshotHash、最终stopped/terminationConfirmed及730000ps，全部通过。只读审查确认新入口复用原门禁；补强浏览器用例直接点击新增的板内“读取板卡状态”。

诊断工具失败亦保留边界：第一次使用系统 Windows PowerShell 5.1 被工具的7.0前置拒绝，改用已安装pwsh后只读健康检查通过；Windows教学tsc因既有依赖仅安装Linux平台二进制而无法运行，改用原WSL运行时通过。生命周期新用例首次修复后曾过早调用fixture的confirmStop，等待停止受理后再注入确认，测试通过；没有修改生产停止判据。

### 4.3 交付与未执行

全量12失败分布为 `fileHistory.spec.ts:219`（60秒超时）、`prepRestart.spec.ts:135`（Monaco未载入）、`runResults.spec.ts:66`（轮询次数18/19），以及9项辅导控制/停止/消息/资料返回用例。具体全部名称/断言见原输出。39跳过包含未提供显式教学服务运行时的受控HTTPS专项，跳过不计通过。

对 `tutoringControls.spec.ts:232` 另做未修改基线复核：固定 `d77c9cc8efdab1a55c54c5b711f2cf8fce8f1ed3`，独立5841/5842/5843端口、正常Chrome、逐包依赖链接和独立Vite缓存，单用例同样失败，Expected“展示：本机已发生”，Received“收到：已确认 · 展示：未发生 · 回应：未回应”；见[完整基线失败日志](evidence/board-interaction-20261015/baseline-tutoringControls.log)和[核对记录](evidence/board-interaction-20261015/baseline-review-result.json)。这只证明该项为已有失败，不能代替另外11项的归因。其余失败没有关闭检查、删用例或改无关生产代码迁就；请求UI/B/C相关维护者继续复核，未认证全仓回归通过。

最终源码和[隔离浏览器界面](evidence/board-interaction-20261015/board-rearmed.png)经只读审查。工作树与本地分支保留，提交仅含上述生产代码、测试、学生README及本任务/证据。未推送、未建PR、未合并、未部署/替换现有3444服务；没有新增模型调用、修改凭据、迁移数据库或代替真实学生操作。不以工程合成检查宣称完整产品/真人/教学效果验收。产品基线及 MVP_SPEC §10 待授权维护者汇总。

临时资源：自建guest源码/state、三只已退出的自建容器已按确切ID/名称/标签清理，两个worker MainPID均0，原服务资源未清理，见[清理回执](evidence/board-interaction-20261015/cleanup.json)。D盘 `D:\XunJie_Project\hdl-virtual-board-verification-20261015` 保留证据和最小复现脚本；其中冗余 `source.tar`、`guest-runner` 与三份清理脚本的清理被自动审批两次拒绝，原因仅返回 `blocked by policy`。已停止重试并原样保留，不把本轮标为所有临时文件均已删除。
