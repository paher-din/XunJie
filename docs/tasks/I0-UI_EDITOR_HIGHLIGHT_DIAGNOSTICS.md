# I0-UI：代码高亮与编辑诊断缺口

日期：2026-10-15。责任：本会话 UI Agent。状态：已实现并接入本机正常 WebUI，专项验收通过；正式产品/教学与基线汇总仍分别保留。

## 依据、授权与写集

- 当前用户要求：WebUI 代码界面缺代码高亮、编辑错误提示，参考 [XunJie-StudentIDE](https://github.com/paher-din/XunJie-StudentIDE)。该指令授权排查和现有编辑器范围修复；不据此扩大为跨模块共享接口批准。
- 已读正文：PRD §1、§4.2～6；MVP_SPEC §1.4、M-03～M-10、§4～6；TECH_DESIGN §3.2～3.3、§7.4、§8.1～8.2、§11；TEAM_WORK_PLAN §2；I0_UI_SPEC Implementation/Testing Decisions；I0_UI_CLIENT_CONTRACT §4、§6；I0_UI_02_EDITOR_DRAFTS；ENGINEERING_HANDOFF「编辑与对象版本」「编辑时诊断」；docs/DESIGN.md 现役令牌及主题约定；apps/student/IMPORT_SOURCE.md 来源与选择性同步边界。
- 适用：PRD-03/09/10、M-03/05/10、AC-03/04/07/11、NFR-01/04/05、DL-AC-02/03。只报告本次实际覆盖，不宣称上述整项通过。
- 开工高亮写集：`apps/student/src/lib/projectFiles.ts`、对应单测、`apps/student/src/components/workspace/monacoSetup.ts`、`apps/student/e2e/editorHighlight.spec.ts`、本任务；后续诊断和运行接入写集按下方两次明确批准扩展。
- 始终只读：产品/规划/参考文档、规范、依赖/lock、数据库schema、其他人的任务和源码差异。开工已有 hdlWorkspace.ts/test、G3_OVERALL_COORDINATION.md 及本机模型/远程同步任务与证据差异，保留不处理。服务端和准确认证入口仅在下方各自批准后写入。
- 开工高亮静态交付：按 REMOTE_SYNC_WEBUI_20261015 核对原静态目录，备份index并追加hash assets，不删除旧产物、不重启。后续负责人批准诊断和环境恢复后，才进行下方独立服务和正常应用切换。本任务没有操作既有学生作品/Job/模型。

## 参考实现与差异

参考固定版本：[0d95ba640d1ec6822797f24988e9b97107d97367](https://github.com/paher-din/XunJie-StudentIDE/tree/0d95ba640d1ec6822797f24988e9b97107d97367)。通过 GitHub API 只读核对 `web/app.mjs`、`src/diagnostics.mjs`、`docs/LANGUAGE_CONTRACT.md`，不整包复制或作为依赖导入。

1. 参考 UI 明确注册语言与 Monarch tokenizer，再设置 model language；诊断经独立接口取得，再调用 setModelMarkers。编辑即清理旧标记，检查原 model/version 及暂停状态后才接纳结果。
2. 参考 C/C++ 使用 GCC `-fsyntax-only`，不是 Monaco 自带 C 编译诊断。其本机进程模型不能直接搬入正式应用宿主；当前项目要求专用执行隔离。
3. 当前 WebUI 已接 C/C++/Python/Markdown 的 Monaco 定义，但扩展名映射未包含 `.v/.vh/.sv/.svh`，也未载入 Monaco 已安装的 systemverilog 定义。这是 HDL 纯文本的明确缺口。C 是否存在额外高亮问题由浏览器回归核验。
4. 当前公开服务有显式 C 运行/HDL 构建诊断，没有编辑时静态分析接口；现有 HDL 行定位不等于编辑中自动检查。

## 实施方案与待决策

2026-10-15 负责人回复：**“批准 C 与 HDL 的编辑时诊断（推荐）”**，对应问题为“是否批准按此方向细化契约并实现”。授权 C/HDL 隔离静态诊断及必要 A/C/UI 接线；不授权受保护基线、schema、密钥/CI、删除历史或生产发布。

### 批准方向下的具体契约与写集

- 新增只读分析命令 `POST /api/attempts/:id/editor-diagnostics`（沿现有 Session/CSRF、学生归属、分配可用性、受信代际）。输入 `recoveryGeneration/workspaceRevision/captureRevision/fileId` 与当前源集内各已确认实例的 `fileId/documentVersion/contentHash/text`。text 是本轮临时分析副本，允许与已确认作品不同；已确认版本/hash用于核对基线，绝不隐式 sync、冻结业务快照或写学习观察。新建但未确认的文件提示先确认保存，不猜服务端实例。所有 active 文件的临时副本参与，避免头文件编辑后其他源文件检查失真。
- 服务端读取授权当前基线，校验完整实例清单/版本/hash及限额，形成临时源集 hash；仅当前 collecting/active、非限定帮助检查、分配有效时分析。等外部执行后重新核权限、代际、captureRevision、workspaceRevision，变化则返回 stale/paused 而不接纳旧结果。无 schema/Job/Run/过程记录变更。
- 返回 `status/sourceHash/provider/diagnostics`；status 为 ready/unsupported/paused/busy/stale/timeout/unavailable。诊断含获准 fileId/path/contentHash、severity、message、可选一基 UTF-16 range、line（缺列明确整行），最多100条/64KiB。只有 ready 表示完成；不把基础设施错误标成代码错误。
- 执行节点提供固定 SSH RPC `editor_diagnostics`，校验来源集和代际；仅在原固定 GCC/HDL build 镜像的无网络/非root/只读容器中运行固定 `gcc -fsyntax-only` 或 `iverilog -tnull`，不执行产物，不接受命令。全局一个诊断、500ms输入防抖、编译5秒/容器总10秒/HTTP等待20秒、至多0.25CPU/256MiB/32进程、临时空间16MiB/输出64KiB。显式运行/构建优先，诊断被抢占返回busy；无永久队列。临时源通过stdin传入容器tmpfs，结束销毁该次诊断容器，不写宿主源码临时文件。节点源指纹变化必须按原真实验收门禁处理，不能伪造ready或覆盖原验证。
- 前端沿现有CodeWorkspace/CodeEditorHost增加小型诊断状态与问题列表、Monaco波浪线和hover；复用原文→LF模型范围映射。每次编辑立即清除旧标记，500ms后发临时分析；当前文件/任意依赖正文、版本、身份、采集状态变化即失效。旧响应不覆盖新源集；不自动保存或运行。
- 扩展可写：`apps/teaching/contracts/{runner,workspace}/` 中新增诊断契约，runner 的新诊断模块/controller.ts/ssh-control.ts、server/records/runner.ts、server/workspace 的诊断模块/application.ts及必要测试；学生 editorDiagnostics/useEditorDiagnostics、CodeWorkspace/CodeEditorHost/PrepWorkspacePage 与相称测试。依赖、schema、其他任务和保护基线只读。准确变更以本任务最终写集列出。

### 现役指纹兼容与准确红线请求

独立服务路线为上述方向的实施细化：现役节点完整源码hash也是活动已冻结HDL运行配置的一部分。直接替换原controller会使原活动不再匹配；不修改旧活动、原配置、旧验证或学生作品以迁就新实现。因此保留原执行节点源码及课程版本，新增独立 `editor-diagnostics-service.ts` 与 `editor-diagnostics-entry.ts`：只为新RPC调用诊断服务；原有RPC仍交原ssh-control.ts处理，显式提交先抢占诊断。此前在controller/hdl-node/ssh-control的临时接线已撤回，仅撤回本人插入行，没有回退他人内容或文件。

准确待批准对象：**专用本机执行VM `/root/.ssh/authorized_keys` 中唯一 application 公钥行的 `command="..."` 受限入口选项**，由原固定node+ssh-control.ts改为固定node+新entry.ts、私有Unix socket与原ssh-control.ts路径；同一行公钥、私钥、maintenance入口、限制项、known_hosts不变。新诊断服务作为root600私有Unix socket服务部署于原执行VM独立目录，不改原C/HDL控制器/配置/镜像/代际/库。切换前备份原授权文件、校验唯一行与原command，保留maintenance通道，测试原readiness/新诊断/拒绝未知操作；切换失败恢复原command。

理由：浏览器后端当前只持有原受限application通道，新诊断RPC必须有明确的受限接收入口。风险：强制入口路径或参数错误会使应用SSH调用失败，影响运行/构建；错误放宽入口也会扩大权限。因此仅改已测试固定代理命令，并核旧指纹和原调用不变。该对象命中AGENTS.md“修改密钥/token”红线中的认证入口配置，尚未实际修改，不以功能批准代替此准确授权。

2026-10-15 负责人明确回复 **“批准限定入口修改并完成本机接入（推荐）”**，覆盖上段准确认证配置范围。随后用 [安装工具](../../tools/i0-hdl/install-editor-diagnostics.mjs) prepare核对、apply执行，仅替换唯一application行的command。原command实际指向 `/opt/xunjie-runner/source/runner/ssh-control.ts`，与controller配置的source-i0目录不同；保留原准确入口，不据配置猜路径。公私钥、maintenance入口与其余限制项不变。原授权备份与公开hash见 [node-install.json](evidence/editor-diagnostics-20261015/node-install.json)。原C/HDL源码、配置、镜像和代际保留；新增root私有socket服务在原VM的独立目录。

### 本机环境恢复核对

验证中3444与VM曾不可连接。最初基于另一套目录说明把不存在的 `/opt/xunjie-ui-local`/frozen-source当作被清理，判断不准确；已向负责人纠正。本机实际原库和TLS/签名配置均在 `/opt/xunjie-runner/tests/i0-entry-20261013-01`，原VM磁盘完好，触发者未知，未发现本任务删除行为。负责人明确要求“没有主动清理，请排查环境并恢复”。以与原批准脚本相同的仓库vm.sh（SHA256 9da8f18f…5586f）恢复既有VM；发现3444随后已由现有shared host监听，未覆盖或停止未知进程。实核健康200后按准确cmdline与无在途条件组织本批接入。没有重建库、恢复旧数据、改schema/代际或改密钥值。

本次小范围修复：复用已安装 Monaco 0.57.0 的 Verilog/SystemVerilog 定义，补齐四种扩展名及语言标签；保留现有原文、保存、主题、布局及多文件模型语义，不新增依赖。先以真实浏览器合成场景断言 C 与 HDL 可见关键字/数字着色，修复后复跑。

**开工时初始提案（已由上方负责人回复批准方向并细化契约）：** 编辑停顿后对已确认基线及当前临时草稿做静态分析，在现有编辑器画波浪线并显示诊断消息；复用现有身份/Attempt/确认版本/暂停采集与执行隔离。仅分析、不运行学生程序，不自动保存。位置无列时整行标注，旧结果失效，资源有界；诊断不可用与完成且无问题分开。

产品基线与 MVP_SPEC §10：待授权维护者汇总。本任务批准和实现不替代受保护基线。

## 验收与结果

- 复现命令（学生目录，Node24.15.0）：设置 XUNJIE_E2E_BROWSER_CHANNEL=chrome、XUNJIE_E2E_PREP_PORT=5721、XUNJIE_E2E_REAL_PORT=5722 后，`npx playwright test e2e/editorHighlight.spec.ts --workers=1`。修改前 C 通过、Verilog/SystemVerilog 两项在可见关键字/数字颜色断言失败；修改后相同命令 3/3 通过，覆盖浅深主题。这是隔离合成工作区，未操作学习会话。
- 初次默认 Chromium 运行：3项均因本机未安装对应 Playwright Chromium executable 而未执行；随后使用既有真实 Chrome，不安装新依赖或浏览器。
- `npm run typecheck`：通过。`npm test -- src/lib/projectFiles.test.ts src/lib/originalText.test.ts`：44/44 通过，包含四种 HDL 扩展名、未知类型纯文本回退和原文保真。
- `npm run build`：通过；保留既有 chunk >500kB 提示。开发浏览器过程保留既有 public 资产导入提示，未为本次高亮越界调整品牌资产。
- 初期高亮在服静态由 index-BjElIjC5.js 更新为 index-CqJKWDNO.js；原index备份在本机独立目录，正常HTTPS健康200。随后完整诊断交付使用下方独立产物与服务，不把初期高亮结果冒充完整诊断通过。

### 完整诊断验收及实际接入

- 学生 `npm run typecheck` 与 `npm test`：通过，45文件584项，无跳过。`npm run build -- --outDir <独立交付目录>`：通过，最新入口 `index-CU-S1j_0.js`；保留既有chunk体积提示，没有清理在服目录。
- 真实Chrome四组专项 `editorDiagnostics.spec.ts editorHighlight.spec.ts editorProtection.spec.ts hdlRealWorkflow.spec.ts --workers=2`：16/16通过；增加暂停后无诊断POST的专项后，`editorDiagnostics.spec.ts` 2/2再通过。C/HDL未保存正文、波浪线、hover、迟到拒绝、当前草稿不自动保存，以及浅深高亮、原草稿/布局/构建等覆盖分开断言。
- 只读诊断虽用POST，不能按方法当成业务写入。更新既有helper/fixture的计数定义，作品/快照/Run计数断言继续保留；暂停禁发诊断有独立网络检查。HDL长pending原测试以跨进程“当前时间+1ms”暂停时钟，曾触发past错误；改为创建pending输入前暂停到当前+1秒，60轮/阈值/断言原样保留，专项通过。
- 教学Node24.21.0/Linux原native依赖，`tsc --noEmit`：通过。诊断/原workspace integration/review/i0 host及parser专项：27通过、1个原真实C1链条件skip（未计通过）；不宣称全量服务端已验。首次隔离目录缺学生dist导致一项环境失败，补齐正确apps/teaching与apps/student布局后复跑上述结果。
- 显式开启 `XUNJIE_C1_SSH=1` 与指定非秘密节点配置路径的 `runner/editor-diagnostics.runtime.test.ts`：真实专用VM通过。覆盖C正确/语法错误、中文/emoji UTF-8→UTF-16、BOM+CRLF、多文件头文件、HDL正确/语法错误、抢占/并发、临时容器清理；独立服务及受限代理、未知命令/旧代际拒绝、跨流分块的大段Unicode。原C/HDL完整fingerprint前后相等。仅用隔离合成源码，不创建学生Run或仿真。
- 真实Node/GCC回归暴露并修正：固定镜像GCC路径是 `/usr/local/bin/gcc`；GCC15输出可带格式化换行，不能逐行解析JSON；文件BOM由GCC先消费，字节列须映回包含BOM的原文。保留原格式及一基UTF-16，不改坐标规格。格式选项依据：[GCC官方诊断文档](https://gcc.gnu.org/onlinedocs/gcc-14.1.0/gcc/Diagnostic-Message-Formatting-Options.html)。调试输出已移除。
- 正式dist + 独立HTTPS/SQLite + 实际VM/application SSH的 `editorDiagnosticsService.spec.ts`：1/1通过。真实表单合成登录、未保存C错误返回GCC范围1:13～1:14并显示波浪线；服务器确认文件、快照、Run及业务计数前后不变。[实际界面截图](evidence/editor-diagnostics-20261015/actual-c-editor.png)。首次用默认WSL用户无法读取root受限材料，明确选择获准root执行用户后通过；没有放宽文件权限、复用真人会话或打印口令。
- 本机正常宿主按原systemd service精确cmdline识别，先核pending Job0/未终止HDL Session0，再备份原非秘密host脚本、切换已验源码及独立dist并restart原service；原service环境中的模型key/预算配置保留，未触发模型调用。严格TLS ready200；原控制、作品、快照、Job、Build、Session、Operation、消息九组全行摘要前后相同，见 [activation.json](evidence/editor-diagnostics-20261015/activation.json)。没有执行回退或改库。
- 最终HTTP实读入口 `index-CU-S1j_0.js`、SHA256 `773bd24885d797af4978e603fd9c38769a84cb7274b2b9095d0ffa6809bb595f` 与独立build一致，ready200，见 [http-final.json](evidence/editor-diagnostics-20261015/http-final.json)。在服六个诊断模块逐一与仓库SHA核对相同；私有socket为600，最终模块及认证文件摘要见 [node-final.json](evidence/editor-diagnostics-20261015/node-final.json)。后续UTF-8流解码、BOM及抢占期间的准备阶段修复只更新本任务独立服务源码，保留前版副本，未再改认证入口。
- 收尾：学生typecheck再次通过；Linux Node24.21.0教学typecheck及parser/HTTP诊断3项再次通过。`node tools/a0-review/check.mjs` errors=[]，`git diff --check`通过；调试标记与密钥形态扫描无命中。保护基线、原controller/hdl-node/ssh-control无本任务差异；开工既有hdlWorkspace和G3等他人差异保留。
- 未执行：全仓浏览器、完整负载/性能、C/HDL全部隔离攻击、真人学习和教学效果；HDL浏览器协议验收与真实VM编译分层报告，不冒充同一完整教学会话。

## 最终代码与维护交接

| 责任 | 位置 |
| --- | --- |
| 语言识别/注册、原文映射后的标记、hover/问题列表 | apps/student/src/lib/projectFiles.ts及测试；components/workspace/monacoSetup.ts、CodeEditorHost.tsx、CodeWorkspace.tsx；styles/app.css |
| 草稿分析防抖、当前性、响应验证与页面接线 | apps/student/src/workspace/editorDiagnostics.ts及测试、useEditorDiagnostics.ts；pages/PrepWorkspacePage.tsx |
| HTTP输入/结果与固定RPC | apps/teaching/contracts/workspace/editor-diagnostics.ts；contracts/runner/index.ts；server/workspace/editor-diagnostics.ts、application.ts；server/records/runner.ts |
| 固定容器分析、独立root私有服务与受限入口 | apps/teaching/runner/editor-diagnostics.ts、editor-diagnostics-service.ts、editor-diagnostics-entry.ts；parser/runtime测试 |
| 宿主停机闸与原替身适配 | server/app/i0.ts、digital-logic.ts；i0-browser-runner.ts、i0.test.ts；workspace/integration.test.ts、review.test.ts；tests/dl-a-support.ts、review-support.ts |
| 隔离浏览器宿主与验收 | server/app/i0-browser-fixture.ts；学生e2e/sessionHost.ts、helpers.ts、hdlRealWorkflow.spec.ts、editorDiagnostics*.spec.ts、editorHighlight.spec.ts |
| 认证入口安装与使用 | tools/i0-hdl/install-editor-diagnostics.mjs；apps/student/README.md；本任务及evidence/editor-diagnostics-20261015 |

只交付本任务写集，不暂存/提交/推送他人改动；实现交付时尚未执行Git提交或推送，后续实际交付见下一节。回退仅恢复原已备份host脚本并restart原service、按原授权备份恢复application的command；不回滚数据库或删除历史。原引擎源码/活动固定版本/代际没有变化，后续必要契约及进度由授权维护者汇总。

## 2026-10-15 PR交付

负责人本会话明确要求“推送PR”，授权本任务提交、分支推送及创建PR，不含合并或生产发布。原工作区main基线为4fdf2f0；fetch实核origin/main已到4ea3c73。使用独立工作区接入最新main，只带本任务明确写集；原hdlWorkspace.ts/test、G3记录及本机模型/远程同步任务和证据保留，不暂存或提交。接入后的验证与实际PR地址在本节续记。

- 独立分支 `codex/editor-highlighting-diagnostics` 以远程main 4ea3c73为基线，44个本任务文件。README只有新增说明相邻冲突，保留上游共享入口/教师说明与本任务编辑器说明；其余补丁三方接纳，没有改动受保护基线或引入原工作区的其他差异。
- 接入后学生typecheck、build通过；Vitest 53文件644/644通过。教学Node24.21.0/Linux typecheck及parser/HTTP诊断/正常I0宿主13/13通过，无跳过。原真实VM和HTTPS/SQLite证据按上方原批次版本保留，不把它们重标为新main的全量验收。
- 接入后四组Chrome专项首轮15通过、1项在暂停检查的虚拟时钟推进时触发React Performance计时异常；改为真实观察完整2秒防抖/重试窗口，未关闭断言或修改产品逻辑。诊断两项随后2/2通过，其余高亮/编辑保护/HDL工作流14项首轮通过。仅本任务新测试相应调整，原时钟60轮阈值仍保留。
- 代码提交 `bb26015058ea91f2d72857fa6233d22251de1dbf` 已推送至 origin/codex/editor-highlighting-diagnostics，并创建 [PR #91](https://github.com/paher-din/XunJie/pull/91)，已关联当前聊天。创建后实读为 OPEN、非草稿、MERGEABLE/CLEAN；远程base为4ea3c73，没有返回CI检查，不称CI通过。PR地址以本独立文档提交回填；未合并或生产发布。原工作区main的暂存区仍为空，其他任务及原差异保留。
