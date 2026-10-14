# I0-UI：真实IME、依赖审计与证据入口收尾

日期：2026-10-15（Asia/Shanghai）；主责：UI / Robert；实施：当前Agent。状态：`completed-in-approved-synthetic-and-document-scope`，已推送并创建[PR #76](https://github.com/paher-din/XunJie/pull/76)，未合并。初始main与原分支`i0/ui-frontend`均为`37b628b75ec3a2238b9b77c8bd1882d36a2e55a6`（PR75）；原未跟踪`.zcodeignore`保留。

## 1. 依据与明确范围

Robert要求“完整完成这三个”，承接上一条明确排除并行HDL后列出的[清单](I0_REMAINING_WORK_CHECKLIST.md)UI-PREP-04/07/08：真实中文输入法验证、当前依赖审计与精确修复方案、文档与证据入口。另一个“完成PR55中分配给czr112的任务”会话已在独立`codex/ui-hdl-real-browser`实施UDL-01～08及本机环境迁移；本轮不重复该工作、不改它的工作树或运行环境。

已读README、根规范、PRD §3.2/4.2～4.4、MVP §2及M-03/09相关前端要求、TECH §7.4/11、I0_UI_SPEC Implementation/Testing、客户端§4/5、IMPORT_SOURCE许可/同步、原04/05与清单正文。适用原文/本机草稿与键盘输入、AC-03/04/12及NFR-05前端证据；不计完整验收或教学效果。

## 2. 写集、方案与完成判据

可写：本记录、本人清单/原交接状态与README必要导航；本轮`evidence/i0-ui-prep-04-07-08/`公开合成/审计摘要和独立证据索引；`apps/student/tools`独立IME取证辅助与合成准备页验证，`apps/student/e2e`必要独立反例。只有实际IME反例证明时才窄修现有编辑/搜索调用方，并保留原页面/原文/undo/存储和课堂语义。依赖/lock只读；07的原交付是“形成方案、获准后再改”，本轮完整交付当前审计、精确版本/影响/回归与可审查提案，不把升级本身列成已获准。

只读：保护文档/规范、其他作者任务、正常A/B/C源码与契约、数据库schema、CI、认证/配置/密钥、真实学生/PAHER与并行HDL环境。08对他人记录的差异给固定源和维护者交接，不修改、覆盖历史证据或擅自给其他会话发消息。

2026-10-15负责人明确纠正“wubq511就是我们”，因此旧UI的04/05文档勘误由本轮直接承担，不能再列成外部维护者待办。追加可写范围仅为`I0_UI_04_RECOVERY_CONFLICTS.md`的截图指针/基线误链和`I0_UI_05_FILE_HISTORY.md`的固定Design来源计数及勘误说明；不改原工程/验证事实、不触碰Design工作副本、其他成员或保护基线。初始16文件写集因此增加这两份本人记录至18；发布范围仍需对应新回执，当前尚未推送。

| 编号 | 交付与证明 |
| --- | --- |
| UI-PREP-04 | 正常真实浏览器/系统中文IME的composition、候选确认/取消、搜索与跨文件编辑；原正文/本机保护/刷新/undo与零自动业务写核对。中文insertText、CDP composition或脚本dispatch不计真实IME通过；工具无法驱动系统候选时准备可检查页面，由Robert实际操作并记录原生事件/正文，不缩成合成通过 |
| UI-PREP-07 | 当前固定lock完整/运行时audit、实际依赖路径与用途、每个通报的一手来源/可达性/精确修复候选及兼容回归，审计失败与未知分列；不沿用旧6项或运行audit fix/未批准升级 |
| UI-PREP-08 | 清单页首/当前行与PR75事实一致；Issue30早期状态、原04截图指针、原05的104/106统计逐项给原源/日期/真实含义及维护者；30编号和门禁保留，产品基线汇总继续交授权维护者 |

依赖审计与08只读索引独立委派；主Agent管理IME浏览器与共享文档。验证与改动相称，检查通过后不无理由重复全量业务/节点。原临时文件仅清本轮自有且不再需要的叶文件，必要证据保留。

## 3. 实际过程、失败与验证

开工实际状态：main/前端分支均PR75 merge，跟踪工作区干净；本轮还未改依赖/源码、未运行IME、未新建PR/推送或触发任何模型。后续在此追加实际结果，不把计划或工具探测当通过。产品基线/MVP_SPEC §10待授权维护者汇总。

### 3.1 独立IME入口与工具中止

上一轮取得当前audit和原维护者证据核查，属于有新证据的进展；本轮继续原三项，没有改成HDL或模拟输入验证。独立`npm run dev:prep -- --port 5841 --strictPort`进程存活，真实Chrome的独立合成scenario只写本轮本机草稿；没有连接PAHER、模型或并行HDL3444环境。`main.c`原正文为`// main seed \n`、`notes.c`为`// notes seed\n`，两个Monaco模型均LF；该基线是ASCII测试准备，不计中文输入验收。

读取原文件菜单后新建第二文件。首次直接找已关闭菜单的“新建文件”超时，随后按实际文件菜单入口打开，两个文件就绪；保留这是自动化定位失败，不是产品丢字反例。

Computer Use技能的官方`@oai/sky`正常导入且能枚举本轮Chrome。首次原生窗口观察被工具明确中止，理由是无法可靠识别Windows浏览器URL以执行策略校验；没有继续窗口输入、绕过校验或把它记成IME通过。浏览器页面仍可由正常浏览器工具只读取证和Robert实际操作。

已准备[只读IME观察辅助](../../apps/student/tools/native-ime-observer.mjs)，记录现有`.cw`内composition/beforeinput/input/keydown/up的`isTrusted`、组合标志、数据、字段与时间，不派发事件、不改正文、不发业务API。已请求Robert在本轮独立Chrome依次实际候选确认/取消、中文查找、第二文件输入及返回；待操作与原生事件一致后再做正文/undo/刷新/零自动保存核对。仅请求已获准的合成操作，不要求发送密码或截图。

### 3.2 文档当前入口

回读PR75公开REST：MERGED、merge=`37b628b75ec3a2238b9b77c8bd1882d36a2e55a6`、`merged_at=2026-10-14T15:41:36Z`。清单页首与当前保存/运行/停止/下载行已按该固定复验纠正，旧§9～12和他人原记录保留；本人A/C交接页首亦明确最新接包事实，README仅增加本任务导航。尚未发送成员、创建本批PR或改受保护基线。

### 3.3 真实IME完成与逐原文核对

Robert明确回复实际系统操作“完成”。[原事件/正文/草稿](evidence/i0-ui-prep-04-07-08/ime/native-ime-evidence.json)和[说明/截图](evidence/i0-ui-prep-04-07-08/ime/README.md)已落盘：人工阶段220事件，5可信compositionstart、40可信update和41组可信beforeinput/input；保留5个`trusted=false`的compositionend及其来源未知，不虚称全部可信。主文件“中文”确认、候选Process/Escape/229取消、Find确认“中文”且1 of 1、notes独立“测试”均与输入原文/本机草稿一致。中文组合阶段Agent无文本注入、CDP或dispatch。

Agent后续正常键盘undo/redo严格核实际分组：一组包含前期ASCII准备尾空格与中文，undo到`// main seed\n`，redo逐字恢复`// main seed 中文\n`，notes不变；两文件原fileId/LF保持。刷新最初过早读到临时空Monaco模型而断言失败；原草稿完整，等待项目模型并依次打开原文件后，正文/身份/EOL全匹配。失败与修正留JSON，不修改源/正文或重做IME掩盖。整个核对阶段业务写0，合成刷新Session建立1单独列出。具体IME产品名未独立识别、候选窗口未截图；本项实际输入/取消/搜索/跨文件由人工回执、原可信输入链和结果共同证明，不计真人教学效果。

### 3.4 依赖方案与原维护者交接材料

[UI-PREP-07精确提案](evidence/i0-ui-prep-04-07-08/dependencies/DEPENDENCY_REPAIR_PROPOSAL.md)及4份JSON齐备。当前固定lock：全audit退出1/6包级条目（2 critical、1 high、1 moderate、2 low），omit-dev退出1/2 low。6唯一公告逐一核实际用途/触发前置与补丁；source-map-js1.2.2、Vitest整组4.1.11、DOMPurify3.4.16分列。Monaco0.57实际内嵌3.4.15，单纯override或降Monaco消除audit计数不修实际运行链；局部构建映射只是精确待核提案，未实施。package/lock首尾SHA不变，原audit/registry元数据和36项证据自校保留；独立只读复核直接核路径/hash与一手公告通过。07原“形成方案”的判据完成，不能写漏洞已修复或升级后回归通过。

[UI-PREP-08交接索引](evidence/i0-ui-prep-04-07-08/documentation-handoff.md)齐备：Issue30历史/新回交、H-05获批PR73仍Open未合、04原图缺失及MVP误链、05固定Design提交正文104/新增10而旧106/新增12不符、历史统计/正确基线入口及各维护者动作。原他人记录/图像/产品/规划未改，30编号原序9/12/9保持。独立核查指出08还需共享Git渠道及确切回执，当前文稿落盘不等于已交原维护者；后续交付状态另记。

### 3.5 检查与限制

只读观察辅助`node --check`通过；README维护后的首轮文档检查发现5个本轮误写锚点，已按真实标题修正后111文档/1794内链、errors=[]，差异空白通过。后续证据/索引新增后最终检查另记；不重复旧464单元/真实C1/模型批次，也不把未来依赖升级验证计本次通过。发布前当前Git写集仍仅本任务，原`.zcodeignore`保留，产品基线/MVP_SPEC §10待授权维护者汇总。

### 3.6 本人原记录勘误及最终本地检查

负责人纠正后已直接修改本人旧04/05：04把未给共享产物的截图声明标为原报告、明确当前两可访问仓库未找回，修正确MVP §10目标；05据固定Design原提交正文104/新增10和静态fileLifecycle5改正文/表格，保留原错误数/日期与其他历史统计。限定两仓库扫描包含hidden/ignored并排除node_modules/.git，主仓36图、Design5736图及已有evidence/test-results未找回可绑定原2026-10-12的恢复图；不宣称从未截图，不重拍冒充旧源。

完整写集18文件：5份当前导航/清单/本人原记录、当前任务、只读观察辅助、11份公开证据。5份JSON全部解析，package/lock与两原audit的实际bytes/SHA一致；220原生事件、原Find输入、原Escape229/取消、逐正文/身份/LF恢复和业务写0/Session1均核对。30原编号与基线Git正文逐序比较完全相同，PREP9/REAL12/TUTOR9。公开文本认证/私钥值模式无命中，生产src、package/lock、保护文档/后端/契约无差异，`.zcodeignore`未纳入。

最终文档检查112文档/1813内链、errors=[]；观察辅助语法和Git差异空白通过。独立审查分别确认07精确方案和04实际IME符合原判据，08身份纠正前缺的是共享交付，现本人记录已直接勘误；A的共享状态/受保护汇总输入仍以实际Git发布回执为准。当前完成本地可审查材料，不提前声称已推送/已发给外部成员或已合main。原维护者身份误分及本轮新增锚点/刷新时序失败如实保留。

### 3.7 暂存完整写集的换行失败与修正

首次本地提交`77821af3f654b617e87ffdaf441683df92f7a64f`已纳入18文件。此前工作区差异空白检查没有覆盖未跟踪的JSON；真正暂存后原始`git diff --cached --check`发现audit-full/runtime的CRLF被判尾随空白。PowerShell命令序列没有因该原生命令非零中止，仍生成本地提交，这是本轮检查流程失误；不将其记为完整暂存检查通过，也不重置/改写历史掩盖。

后续只规范这两份新证据的外层CRLF→LF并正常追加修正：每份解析值完全相同，LF恢复CRLF可重建捕获字节；原字节另归档，摘要保留原sha/bytes并分列公开表示，方案表同步准确新hash。主audit公开6329 bytes/`254e0ed3…`、运行时2219 bytes/`d3fe3504…`，原采样时间/公告/计数/退出1全部不变，没有重跑audit或改package/lock。后续原始Git检查须显式核退出值，完整18文件相对基线再次检查；最终修正提交与共享交付按实际回执另记。

## 4. 本批共享Git发布授权与回执

2026-10-15，Robert明确选择“现在推送并建PR”，准确覆盖纠正身份后的18文件、原`i0/ui-frontend`正常推送及到main的PR；本次不升级依赖、不合并、不更改CI或保护对象。源/证据修正已固定`2faa918049b86e068e835111475a0bb673eb9a56`，生产src与package/lock仍相对PR75无差异。公开PR用于A读取当前Issue状态及获授权基线输入，我们自身原04/05勘误已完成；不自动给其他成员/聊天发送消息。

修正后完整分支原始`git diff 37b628b HEAD --check`退出0；112文档/1813内链/errors=[]，18文件精确写集且仅原`.zcodeignore`未跟踪。发布前实时main仍`37b628b`、无同head的Open PR。验证Chrome已正常关闭，独立5841进程通过本人exec会话中断结束（退出1为中断），随后端口无监听；本轮合成profile/草稿、原audit归档和必要证据保留供复查，其他进程/网关/HDL环境不改。以下实际URL/最终head/状态在成功发布后追加，不提前写已交。

### 4.1 实际PR与共享回执

已正常推送原`i0/ui-frontend`并创建[PR #76](https://github.com/paher-din/XunJie/pull/76)到main。首次公开head=`a5f5b4eaab6023496910ea1a2ad77dab4588c8fe`，base=`37b628b75ec3a2238b9b77c8bd1882d36a2e55a6`，18文件、非Draft、OPEN、MERGEABLE/CLEAN；远端ref实读与该head完全相同。GitHub没有报告检查项（statusCheckRollup=[]），不表述CI通过。后续仅补本PR文档回执，不改变真实IME/审计采样来源。

08的公开共享交付现在可由[固定交接索引](https://github.com/paher-din/XunJie/blob/a5f5b4eaab6023496910ea1a2ad77dab4588c8fe/docs/tasks/evidence/i0-ui-prep-04-07-08/documentation-handoff.md)及本PR独立读取，原UI维护者即我们且04/05已直接勘误；A只需据已有证据汇总#30当前状态，将产品基线输入交获授权维护者。PR公开并不代签A已阅读或基线已同步；没有私信、Issue更新或重复派C任务。发布授权不包含合并，main仍原PR75，实际合并继续另列。

完成核对：04原候选确认/取消、搜索、跨文件和原文/草稿/历史/刷新/零业务写已具实际人工+事件证据；07当前完整/运行时审计、用途/前置、精确候选与回归方案已交，升级待批准；08当前清单、本人04/05勘误、Issue旧/新状态和准确基线请求均有共享固定源。原图未找回/未来回补、他人成员状态维护、保护基线汇总、依赖实施、真人/模型和完整AC/NFR属于保留的后续项，没有缩减本轮三项判据或标成全部产品验收。
