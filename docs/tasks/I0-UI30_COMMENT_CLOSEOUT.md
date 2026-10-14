# I0-UI30：指定评论的 UI 接线与回交

日期：2026-10-14（Asia/Shanghai）；主责 UI / Robert，实施为当前 Agent。状态：`specified-comment-delivery / formal-ui-real-c1-verified`；完整产品与 HDL 浏览器验收单列。

## 1. 用户要求与依据

Robert 明确要求完成 [#30 执行安排](https://github.com/paher-din/XunJie/issues/30#issuecomment-6155068633) 和 [C 恢复回交](https://github.com/paher-din/XunJie/issues/30#issuecomment-6161397303) 中 @Robert/UI 的工作：实际浏览器访问及登录方案、分批接入 I0-A 并按 H-01～H-06 回交，以及给 A/C/B 的 HDL 操作对照表。复用已交材料和后续实施，不重做服务端20项或已完成审查，不重建库/账号/对象。

已读正文：README 与 AGENTS；PRD §3～8（PRD-03/04/09/10）；MVP_SPEC §1.4、§2、M-03～M-10、§4～7（AC-02/03/04/06/12、NFR-04/05，HDL 表对应 DL-AC-01～09）；TECH_DESIGN §3.3、§4～5、§7.3～8.5、§9；TEAM_WORK_PLAN §1～3；I0_UI_SPEC、I0_UI_CLIENT_CONTRACT；IMPORT_SOURCE；I0-UI_AUTH_SESSION_ENTRY、I0-UI_REAL_SAVE_RECOVERY、I0-UI_REAL_RUN_CONTROL_HISTORY 的相应实施和结果正文；I0-UI55_BROWSER_ENTRY 的批准、实际现场和交付边界。HDL 映射的补读和实际接口来源在独立对照表记录。

## 2. 起点、写集与方案

独立 managed worktree 从 main `b7e73c5f65d457fb78d2fcbac7003e4e60ed7f43` 创建，分支 `codex/ui30-comment-closeout`；初始干净。主目录另有 UI 任务并行，仅读取其状态，不修改或提交。PR67 已合入 main，原正式登录、保存和运行 UI 随 PR66 已交付；PR56 固定 `7100ea6b6c9182f4c1b36fdc0ddccdca32b70754` 的后端 H4 交接仅作 HDL 表依据，不把它写成 main 已接纳。

可写：本记录、`I0-UI30_HDL_OPERATION_MAP.md`、本任务去敏证据；README 只加必要任务导航。复用既有本机工具、证书/信任、SSH 和获准合成学生账号，构建固定正式 UI 并切换本任务网关的静态产物，按已批准入口进行浏览器验证。前端暴露缺口才最小修复本人 UI 并记录原因。产品/规划/参考/规范、A/B/C 实现与他人任务只读；不改共享契约、schema、账号口令、节点配置、模型预算或 PAHER 运行源。

本批交付按要求区分材料收到、接线、实际通过、失败及未执行。最新正式 UI 与旧宿主的 readiness 失配保持原失败；不以历史 Node/C1 成功代替当前浏览器。HDL 的明确要求是操作/接口表及缺项回交，真实 HDL UI 新增编码与完整 Demo 依原独立范围推进。

## 3. 验收与当前待完成

1. 明确浏览器位置/version/profile、批准信任对象、实际 Origin/SSH 路径、合成账号领取和正常获准深链、启动/核就绪/停止责任。
2. 接纳既有正式代码和对应隔离浏览器证据，补固定正式产物的实际 PAHER 浏览器登录、合法入口/材料、原作品恢复、退出/重进与健康失败呈现；其余 H 编号精确列已有证明和未覆盖项。
3. HDL 表覆盖评论所有操作，API/字段按固定源码核对，模拟/真实/缺口及原域负责人分开；回交 #38，#30 链接共用入口与 H 状态。
4. 文档引用、差异空白、公开证据去敏与实际源码/产物对应检查；只提交本写集，普通推送独立 PR 并在指定 Issue 回交，不自动关闭 Issue 或合并新 PR。

执行、失败、命令和交付结果在后续章节追加。产品基线及 MVP_SPEC §10：待授权维护者汇总。

## 4. 实际浏览器、信任、登录与运行方案回交

本节用已批准操作和本轮实测补齐评论要求的方案。C 的公开输入、运行/停止方法沿指定评论与 [PR56 接收 #67 交接](https://github.com/paher-din/XunJie/pull/56#issuecomment-6168703238)；UI 独立核对实际访问和页面消费。固定方案已落实下列已具备条件，不将历史 PAHER Default 候选写成本轮实际浏览器。

| 项目 | 本轮实际选择、权限与结果 |
| --- | --- |
| 浏览器／位置／profile | Robert 的 Windows `LAPTOP-S7A4IQFU`、用户 `h`、已有 Chrome **155.0.8059.40**；已连接 browser id `3`，profile 名为工具返回的「您的 Chrome」，复用原验收标签。没有创建 C 的旧提案独占 profile；当前 profile 的磁盘目录未读取，不猜作 Default。内部 version URL 被浏览器工具策略拒绝，未绕过；版本来自已有可执行文件，profile 标识来自已连接浏览器元数据。 |
| 实际同源路径 | Chrome → 本机 `https://127.0.0.1:3443` → 原严格 TLS 网关/SSH 的 `127.0.0.1:14443` → PAHER `192.168.3.15:22` → 原目标 `127.0.0.1:3443`。源/方法/Origin/Cookie/CSRF/幂等键不改写，没有 fixture 回退。主机 pin 和两端证书沿既有批准。 |
| 信任存储和许可 | 沿本会话已批准并保留的用户 `h` 的 `CurrentUser\\Root`：本机叶子 SHA256 `8d663b4dba93b1fb61df544fe3fe17022e561d88a559576381abf1220b3ac52e`；PAHER 公共叶子 `c3f8ed37e07c341b0fcc5558d0fc12fab47913ef71d1ec8077a0e08444475173`。用户应用受此显式信任影响，不只一个标签；本轮没有新增/更换证书或改 LocalMachine。浏览器无 TLS 警告绕过，Windows 严格信任与上游 pin 检查通过。 |
| 凭据领取／正常登录 | 只用已有 `synthetic-i0-student-a`。既有 root-only reader 经已批准维护 SSH → 临时接收者 RSA-OAEP-SHA256 → 接收进程内存 → 正常账号/密码表单；没有注入 Cookie、重置密码、保存密码、记录/公开明文或传整份 initializer。领取后释放内存私钥/明文引用。 |
| 合法入口 | 原 `/#/task/a2533386-4923-4dee-83bd-2d7a99fb06e9`；正常退出及重新登录后仍进入该分配，Activity `f0942cb7-75ef-4625-aa92-d649268d61cb`、Attempt `c9166463-5f46-4dc6-82c3-96456f394258`。没有重新初始化库/账号/对象或新增分配列表。 |
| UI 精确产物 | 正式 `main@b7e73c5f65d457fb78d2fcbac7003e4e60ed7f43`，生产源码无 dirty；原 lock、Node24.15.0，typecheck/build 通过。143 文件，ZIP SHA256 `4aaf9a7bf479b521b304e3cbe705503c5129b4815d473021ecd222d15d901059`；入口 `/assets/index-ChZeo2ZO.js` SHA256 `d7479c43cdbd834c189d56b17998c9cf0c261aede9b7607807fa483afe76ab25`。35 个准备边界模式零命中、ZIP/目录143文件字节核对通过。见[逐文件清单](evidence/i0-ui30-comment-closeout/ui-dist-manifest.json)。 |
| C 服务源与原数据 | 本轮只读观察 `xunjie-i0-entry-pr56-pr67-20261014.service` active，PID9775。C 现场 source-reception 记录固定 `f761dcddb2081fa7948fc7f6bd03cfe593d22b5f`、767源码零差异；见[源回交读本](evidence/i0-ui30-comment-closeout/runtime-source-reception.json)。该源码接收统计由 C 制作，本轮仅读取，不声称重做767文件验证。原库独立实读仍 **24 表**，与 HDL 3444/35表分开。 |
| 当前 readiness | [严格 TLS 实读](evidence/i0-ui30-comment-closeout/strict-health.json)为 live200、ready200/`data.status=ready`/`no-store`；不是沿用14:35的历史200。独立[当前 C1](evidence/i0-ui30-comment-closeout/c1-readiness.json) ready=true、原146内核、指纹与历史validation相同，代际/profile不变；该脚本用原归档 runner transport 实读，不将其 source 字段冒充新应用运行源。 |
| 窗口与启停责任 | 本轮2026-10-14晚间已实际登录/保存/运行。UI 只停/启本人网关和隧道以换正式静态包，C/PAHER 应用与 VM 未由本批改动；原 C 的 service 由 C 维护和按本人批准停机。之后使用前先 `status/check` 并核 C 当前服务；本机 `stop` 只结束工具所属进程，全部工具、产物与已批准信任保留。没有全天在线承诺。 |

两条旧评论中「UI尚未领取／登录」等当时状态由下节本轮证据更新；14:35、旧9fa候选及后续503记录均保持原时点，不覆盖历史。A/C复核的具体组合已可依据上述公开源码、信任范围和事实核查；本回交不冒充 A 逐人签认。

## 5. H-01～H-06 分批状态与证据

| H | 材料收到／接线 | 实际结果 | 剩余范围与责任 |
| --- | --- | --- | --- |
| H-01 HTTPS/Session | C 材料、既有 SSH/TLS/领取许可已收到；正式表单、Secure Session/CSRF 和退出已接 main | 本轮严格两端 TLS、正常退出→表单重新登录→原深链、刷新继续读取实际通过；工具 check **16通过/0失败/0未执行** | 原30分钟/8小时 Session自然到期、额外机器/profile、真人账号不计本批通过；维护 C，页面 UI |
| H-02 合法分配/活动/材料 | 正式获准深链/bootstrap、固定活动与资料已接 | Assignment revision3/active、controlRevision1、本人/课程、公开材料 available 和私有 redacted 原样呈现，见[页面](evidence/i0-ui30-comment-closeout/browser-assignment-materials.png) | 未分配/教师暂停的实际 PAHER 浏览器本轮未重复；现有真实隔离服务与协议证据沿[会话任务](I0-UI_AUTH_SESSION_ENTRY.md)/[保存状态任务](I0-UI_REAL_SAVE_RECOVERY.md)，不能迁为此次现场通过。无分配列表/跨设备发现仍按既有范围；A/C身份/分配，UI页面 |
| H-03 受信代际/恢复 | bootstrap及原确认/冻结/outbox接线、当前代际材料已收到 | 原Attempt v7恢复→新增显式保存v8/冻结v8→刷新后同版本恢复；C1与命令/快照/Run代际一致 | 缺代际、换代际、旧ACK、进程崩溃/旧备份/RPO沿既有隔离证据，未在本次PAHER故障注入；C/A现场恢复，UI接纳 |
| H-04 原执行持续消费 | 正式同源ready前置与服务端原节点守卫已接；当前C1实读通过 | 正式产物一次v8成功、一次v4程序超时、另一v4确认cancelled；原消费者推进，没有手工processJob或候选门禁补丁 | 不计整套AC-10/NFR/HDL/H3新镜像验收；C负责节点/事实，UI正式运行页面 |
| H-05 权威head/版本/控制 | main已交确认库、ACK、不可变快照和版本/状态重读 | 本轮main.c documentVersion5→6、workspaceRevision7→8；原sync seq113、snapshot seq114，正文及manifest SHA256独立通过。Attempt实际暂停→已暂停及限制说明→恢复进行中；分配仍revision3，无新Run | 教师分配暂停、submitted/reviewed、版本冲突、账号/多标签/迟到故障保留[原48项隔离证据](I0-UI_REAL_SAVE_RECOVERY.md#10-本批验收与交接)，不重记为本次PAHER；UI/C原域 |
| H-06 运行/停止/未知/历史公开投影 | 原公开端点、原命令/Job/Run参数及裁剪规则已接；既有[正式17项服务/60项兼容](I0-UI_REAL_RUN_CONTROL_HISTORY.md#6-最终结果与范围)复用 | 本轮停止受理 `cancelling`→原Job `cancelled`；刷新后Run/Job/snapshot/hash/profile与本机原参数一致。成功输出与程序超时分开，report.txt `missing`、取消产物 `unavailable` 不补正文/下载，见[历史](evidence/i0-ui30-comment-closeout/browser-history-v8-v4.png) | 正向Report下载在当前Core活动无能力，未强造；真实丢ACK、离线/unknown/账号与多标签反例沿原隔离证据，非本轮真实故障；C投影/产物，UI页面 |

H各行只对实际覆盖部分记通过，没有用“已接线”将全项自动打勾。评论要求的键盘、多标签、账号及故障矩阵，已交 main 与仍在其他 UI 任务推进的专项分开；主目录并行工作本批仅读状态，没有覆盖、重复实现或计其未提交结果为完成。完整 AC/NFR/真人缺项继续 [#22](https://github.com/paher-din/XunJie/issues/22)/[#23](https://github.com/paher-din/XunJie/issues/23)，本批不关闭 #30。

## 6. 本轮真实保存与运行核对

原合成main.c追加明确的 `// synthetic UI30 verification 2026-10-14`，由实际编辑器发起确认保存/冻结。没有修改真人作品；旧快照保留，测试注释留在合成审计版本。现有 scratch.txt 已回收，仅只读查看，没有擅自恢复或删除。

确认快照 `be814058-0ee7-4a68-95b1-521a543e75ac`，workspaceRevision8/hash=`53a10f0c04d644670b4ecea93107701d1fd073c41d14d1e782df0813cfd0dfce`；main.c 99 UTF-8字节、documentVersion6/hash=`110248d35ec027932dc23915bd00b36482da465b6e111be67fbfa2e2bd073e7a`。独立只读原24表库重算两文件正文及UTF-8路径排序的manifest全部相等；[事实](evidence/i0-ui30-comment-closeout/workspace-snapshot-facts.json)、[确认页面](evidence/i0-ui30-comment-closeout/browser-confirmed-v8.png)。没有将编辑器内部版本当服务版本。

| 新动作 | 原固定ID与结果 |
| --- | --- |
| v8 Core | Run `4fc8722a-e701-4187-acc3-6168d5b136ba` / Job `9b58090f-37ac-49f1-b42e-9009a72083c5`，succeeded，stdout `new snapshot`，stderr空，真实执行单元终止；[页面](evidence/i0-ui30-comment-closeout/browser-core-v8.png) |
| v4程序超时 | Run `c446d3e9-7d1d-40b3-8ae0-4072379d2851` / Job `2a5b78bd-e65d-43d7-aa54-bdf10527fd5b`，Job succeeded但failureKind=timeout，UI明确程序超时；不是C程序成功；[页面](evidence/i0-ui30-comment-closeout/browser-timeout-v4.png) |
| 独立v4停止 | Run `a51eea9d-d4b9-4145-8a61-b9378877b304` / Job `2fc7b1aa-fa13-4929-bb50-040efb6f4bfc`；取消回执 `5a71d62d-4d82-424d-bd2e-7806dd6aa946` seq157确认受理cancelling，原progress seq160确认cancelled；[停止页面](evidence/i0-ui30-comment-closeout/browser-stop-confirmed.png) |

[独立只读投影](evidence/i0-ui30-comment-closeout/server-run-projection.json)核原7→10项，每项原Job/Run/snapshot/代际/请求回执/摘要关系全部匹配，7 succeeded/3 cancelled、当前queued/running/cancelling/outcome_unknown=0。其中成功作业包含程序超时，不能把7解释为7个正确程序；取消项result为null时保留unitTerminated未知，不从null补造结果正文。

实际中间失败也保留：首次Stop控件观察后动作前程序已达timeout，定位无匹配控件，未发取消；确认终态后才明确发独立新Run及时取消。浏览器工具子进程不能完成原内存reader，加密工具在终端独立通过后用同一临时公钥密文交接，密码未持久化。历史stdout的DOM定位失败不记展开通过，Core真实stdout已实读；数据读取与截图没有伪造。暂停控件语义定位未观察到变化，改用已核视口操作后权威状态实际暂停，随后实际恢复；未将此工具操作差异定性为产品源码缺陷。

## 7. HDL 操作表、验证与交付

已完成[HDL操作对照表](I0-UI30_HDL_OPERATION_MAP.md)，覆盖指定评论全部操作/接口/对象版本/真实显示/模拟或缺失/负责人。PR56固定7100ea6的API、四态、pending/替换/终止/有限Trace、H4 selection/current/basis与回执均按原代码核对；main仍有8项具体HDL消费方缺口。此处完成的是评论要求的表与接缝交接，真实HDL UI编码/同浏览器Demo不自动标完成，也没有重消费已结束模型批次。表的固定交付交 #38，#30 链接共用入口和本记录。

本轮命令：学生目录 `rtk npm ci --offline --no-audit --no-fund`（仅原lock/已有缓存）、`rtk npm run typecheck`、`rtk npm run build`；固定归档入口 `package-student-dist.ps1`，原本机 `xunjie-ui55.ps1 stop/start/status/check`；原 `Read-C1Readiness.ps1` / `Read-BrowserRunServerProjection.ps1`；新增只读 `Read-Ui30WorkspaceFacts.ps1`。全部工具与产物留原本机入口，实际机器路径/凭据不成为仓库开工前置。

没有新生产源码/测试/依赖/lock/后端/规范变更，故不重复已通过单元/整批浏览器/原20项；本轮当前正式产物构建及真实浏览器验证如上，原专项计数只引用不累加。本写集最终静态检查 **88文档/1322内部链接/errors=[]**，差异空白通过，6份JSON秘密值字段零命中；该静态脚本不运行业务测试，真实浏览器/节点结果按前文另记。普通推送/PR及Issue回交回执待交付后补入；本地提交、远端PR、main合并和部署分别报告。产品基线/MVP_SPEC §10：待授权维护者汇总。
