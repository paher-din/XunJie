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

## 5. 2026-10-15 追加授权：推送及3444更新

Robert 对上一轮“尚未推送或更新3444服务”明确批注“现在做”。本轮授权推送既有 `codex/hdl-virtual-board-fix` 分支，并将板卡修复更新到本人本机3444；不合并main、不创建/关闭PR、不扩展模型调用、数据库/schema、凭据或执行节点范围。§2与§4.3的“不推送/不部署”保留为首批时点，由本节新指令更新当前执行范围。

写入前只读核对：3444无监听，host.pid记录2728但原进程已不存在；当前静态入口为 `index-B66OM0mG.js`，index.html SHA256=`280c205e362469e57a489c5379c88b35fe9d4a66cb14ea8dc60d058f562472bf`，与教师/模型任务记录一致（静态来源5d9c5e、后端613e586）。新fetch的 `origin/main@4ea3c73` 相对5d9c5e在学生及教学应用源码上无差异。

实施：将已批准main纳入本修复分支，保留已交付教师/个人模型能力；在独立工作树构建和专项验证后，留存逐SHA回退静态副本，再覆盖静态产物、最后切换index，保留旧assets供已打开页面使用。仅沿现有最新宿主工具启动原后端，原配置、TLS、身份、数据库、个人凭据、执行节点与代际不替换。部署前复查当前index仍是本轮读取版本，若发生并行发布则先重读并保留其结果。验证实际HTTPS产物hash、live/ready及新版页面。此处是执行方案，实际结果随后补记。

### 5.1 推送与实际更新完成

main整合无冲突，固定应用源码为 `cffa6e6f2445d64b5bbf582ee02e96770cb8bb4c`，包含原板卡修复 `4b8c0b3` 与 `origin/main@4ea3c73`。该head已正常推送到 `origin/codex/hdl-virtual-board-fix`，`git ls-remote --heads`精确回读一致；未合并main或创建PR。相对当前main生产差异仍仅板卡组件、页面接线及板卡禁用样式三处，教师/个人模型保留。

整合后重新执行：学生类型检查与生产build通过；52文件641/641单元通过；正常Chrome `hdlRealWorkflow.spec.ts teacher-ui.spec.ts personalAgent.spec.ts --workers=2` 为29/29通过，见[输出](evidence/board-interaction-20261015/rollout-browser.txt)。本轮未重跑首批已有12项非板卡失败的完整套件，不声明那些问题已解决。

2026-10-15 14:41（Asia/Shanghai），[限定静态更新脚本](evidence/board-interaction-20261015/deploy-static.mjs)完成：154份产物逐SHA核对；旧静态完整保留在 `/opt/xunjie-ui-local/releases/board-static-cffa6e6-20261015/student-dist-before` 并逐SHA验证；既有同名资源内容不同则拒绝，旧hash资源全部保留，index最后原子切换。新入口 `/assets/index-CbBvS58n.js`，index.html SHA256=`8ba010e4ed80e9edfc2e1f53d5842a8ed02b60e8de40f4a0f95e4db873bf4fa9`，见[实际部署收据](evidence/board-interaction-20261015/deployment.json)。

原宿主已停止，因此沿最新工具执行 `xunjie-local.ps1 start -EnableReview` 恢复现有41表宿主。原执行VM当时未运行，工具仅启动原冻结VM（vmStarted=true），同代际 `synthetic-generation-c6772623-ba28-4c50-a853-337f77382452`、C/HDL指纹和原就绪校验通过，没有重建VM/镜像/身份或重签readiness。后端PID433；静态更新前后209个后端/工具文件及application-config字节相同，数据库/个人存储未由部署脚本读取或修改。全局旧模型预算未启用，个人配置与已有开关沿原宿主保持；本轮无模型生成请求。

实际HTTPS和页面：严格TLS正常，148份可服务前端产物经HTTPS下载后逐SHA与新build相同；6份原MIME白名单外的JSON/字体许可文本仍按原守卫返回400。初次全文件HTTP断言在这些原受限文件上失败后，按既有服务器白名单分别核对允许200及受限400，没有修改服务规则。live/ready均200，未认证Session保持401，见[HTTPS回执](evidence/board-interaction-20261015/https-rollout.json)。独立正常Chrome实际3444页加载新入口、原登录表单可见且无pageerror，未登录/代操作学生记录，见[页面回执](evidence/board-interaction-20261015/live-browser.json)与[截图](evidence/board-interaction-20261015/deployed-login.png)。这次实际页面检查不冒充登录后的新一轮真实板卡或模型全链路。

回退：保留全部旧hash资源，需回退静态时从上述受限回退目录恢复原index即可；后端、41表库、TLS、个人Key与执行节点不参与此静态回退。D盘本轮构建归档保留作部署输入证据，未重试上一轮被自动审批拒绝的清理。

### 5.2 用户指定关联会话核对

已只读查看「实现登录与会话进入流程」（`01a1391d-6b93-7910-ba1c-66f6f4040104`）最新工作：负责人要求继续使用北京ECS，配置SSH/成员受限访问，将PAHER共享应用/后端/数据库迁入，C/HDL继续由成员本机执行。它与本任务的交集是应用发布版本及执行节点就绪接线；本次原基线的辅导展示失败是在隔离协议fixture中复现，不能由云迁移/PAHER状态解释。

本轮交付仅为上述Git分支和本机3444静态修复，没有操作ECS/PAHER共享库、SSH权限或云端发布；未擅自给其他会话发送指令。共享部署可显式接纳本分支的三处生产差异及原板卡/节点契约，不能仅复制旧d77c9cc构建或改变C/HDL输入/会话边界。

## 6. 2026-10-15 追加授权：合入main并推送

Robert 现明确要求“现在能合并到main做推送了吗？”。本轮将其作为执行指令，授权把本任务修复分支合入远端main并推送；此前“不合并main”为旧时点边界，本轮按新指令更新。不操作其他会话的main工作树/未提交修改，不删除分支或工作树，不新增部署、模型调用、schema、凭据或云端操作。

写入前已fetch并核对：远端main为 `4ea3c73`，修复分支为 `5ff26b71ca0c629cd73124738aaade4d7e998feb`；main已被修复分支包含，可普通fast-forward更新远端main，不需要冲突解决或重写历史。相对main的生产源码仍仅 `HdlToolArea.tsx`、`PrepWorkspacePage.tsx`、`styles/app.css`；另有本任务测试、README及记录/证据。产品、规划、参考、AGENTS无自写差异。

沿用同一生产源码已完成的641项单元、29项板卡/教师/个人聊天浏览器专项、27项隔离真实引擎检查及本机3444严格TLS/live/ready证据；本轮只补交付记录，无新生产改动，不重复这些检查。首批完整套件的12失败/39跳过继续如实保留，不把main合入称为全仓验收通过。最终运行文档引用与Git空白检查后，普通推送main，并回读远端head和修复提交祖先关系；若main并行前进导致非fast-forward，保留对方提交并重新核对，不使用force。

合入前原生 `git diff --check` 纠正了先前RTK空白检查未充分呈现的证据格式问题：5份公开文本副本含CRLF，另有完整浏览器日志的2行末尾空格。已先将5份原始字节完整保存到[原始归档](evidence/board-interaction-20261015/original-evidence-crlf.tar.gz)，逐字节解包比对后，再统一仓库可读副本为LF并去掉上述2处空格。原始字节hash及规范化hash见[格式核对](evidence/board-interaction-20261015/line-ending-normalization.json)，JSON值、原断言、通过/失败统计和实际输入结果不变；没有关闭检查或覆盖唯一原始证据。本轮最终采用原生Git空白检查结果，先前空白通过的描述由此纠正。

实际交付已完成：普通非force推送将远端main从 `4ea3c73` 快进至 `7059152`，修复分支同时推送到同一head；随后fetch及 `git ls-remote --heads` 回读均一致。原修复 `4b8c0b3`、已部署应用 `cffa6e6` 均为远端main祖先。原生 `git diff --check 4ea3c73..origin/main` 通过，5份原始归档/公开副本SHA复核通过，A0 errors=[]。当前补充回执作为纯文档续交，一并普通推送；没有切换、重置或更新其他会话占用的本地main工作树，也没有再次改动3444运行服务。
