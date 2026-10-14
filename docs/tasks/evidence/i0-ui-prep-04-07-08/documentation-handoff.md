# UI-PREP-08 文档差异与维护者交接索引

日期：2026-10-15（Asia/Shanghai）；整理角色：UI / Robert 的本轮文档核查。范围与授权见[本轮任务](../../I0-UI_PREP_04_07_08_CLOSEOUT.md)。固定仓库基线为 [PR75](https://github.com/paher-din/XunJie/pull/75) merge `37b628b75ec3a2238b9b77c8bd1882d36a2e55a6`，于 2026-10-14 23:41:36 +08:00 合入；2026-10-15 00:05:41 +08:00 回读 GitHub main 仍为该提交。

这是可审查的交接文稿及后续共享Git输入。Robert于本轮明确指出wubq511就是我们，因此原UI的04/05勘误已由本人直接完成，不能再派外部维护者；最新事实见§6。A仍协调Issue当前状态及获授权基线汇总，C沿既有实现/运行职责。尚未发送成员、更新Issue评论或推送，不代签外部接收。文中旧行号均以固定PR75为准，历史日期、源码与验证计数保留各自范围。

## 1. 逐项差异、固定事实与维护动作

| 项目 | 旧说法与出处 | 可核事实与固定来源 | 当前入口及原维护者的具体动作 | 实际状态 |
| --- | --- | --- | --- | --- |
| Issue #30 早期正文 | [#30](https://github.com/paher-din/XunJie/issues/30) 的正文仍称未见可运行 UI、正常宿主/jobs 待组装、B1/B2 未交；[清单](../../I0_REMAINING_WORK_CHECKLIST.md)第17行仍引用 Draft PR53 核查时点 | #30 正文创建于2026-10-11，本轮只读回读为 Open、24条评论。原安排[6155068633](https://github.com/paher-din/XunJie/issues/30#issuecomment-6155068633)创建于2026-10-14 04:58:34 +08:00，引用当时 main `0e68325`，已交服务端20/20、174个严格TLS响应，并明确服务端通过不等于浏览器/H-01通过 | 当前 UI 入口注明 PR75/日期与最新记录；旧正文和清单早期快照保留其时点。A / czr112作为原集成协调人汇总 Issue 当前状态；UI / Robert维护本人证据入口，不覆盖其他成员历史评论 | 后续成员回交已经存在，不能再称完全未回交。本轮未更新 Issue 正文或评论 |
| 原浏览器方案及 H 回交 | 6155068633要求 UI/C先准备访问、运行窗口、信任、账号领取和登录方案，容易被当作今天仍未启动的任务 | UI[6169702024](https://github.com/paher-din/XunJie/issues/30#issuecomment-6169702024)已交浏览器方案、H-01～06及HDL操作表；原证据源 `805c76a6f230cb7f6a64bc94abf8adfa2616e955`，PR68最终 head `e4370f2c65f8db79cf8edd082914eb4db6a7cb3a`。正式 UI `b7e73c5` / Chrome155，工具16/0/0；v8成功、独立v4程序timeout与cancelled分列。最后7份JSON仅空白勘误，不重做或改贴现场版本 | UI当前行指向[PR75复验](../../I0-UI_PR69_REAL_BROWSER_RECHECK.md)，原[UI30记录](../../I0-UI30_COMMENT_CLOSEOUT.md)作为较早正式源。A/C按各自域接受固定材料；不重复派首次SSH/信任/账号方案或原20项服务端验收 | PR68回交及PR75后续新包复验已有固定证据；不表示12项UI-REAL或完整产品验收全部完成 |
| H-05旧“待裁决” | 清单第36/57行及早期 I0-B 摘要仍写待A/C、授权维护者裁决 | 最新[6171614259](https://github.com/paher-din/XunJie/issues/30#issuecomment-6171614259)更新于2026-10-14 23:13:52 +08:00：负责人已批准按现有基线修复，A/C已交[PR73](https://github.com/paher-din/XunJie/pull/73)。本轮两次REST回读均为 Open、`merged=false`、`merged_at=null`，head `40581e0b85a9abfde45a0acab444522f57f49564`；最终核对时点2026-10-15 00:11:57 +08:00。其115项为110通过/0失败/5门禁跳过，候选失败分轮保留 | 当前入口应写“裁决和修复源码已交PR73，尚未合main”；不重派首次裁决。A协调公共版本与验收，C提供实现/反例；合并、现场接纳和受保护基线汇总分别核查。UI继续ACK后GET分别读取两revision，不推算 | 源码材料已交，但PR75基线未合入PR73。本轮未核现场运行；不能把交源码写成已合并或已部署 |
| 原04截图指针 | [原04](../../I0_UI_04_RECOVERY_CONFLICTS.md)第144行写准备态及四恢复态截图“见04交付说明”，没有对应共享路径；[原07](../../I0_UI_07_BROWSER_HANDOFF.md)第145/159行已登记缺口 | 2026-10-12的原04实际文字记录为15文件184单元、47浏览器、typecheck/build通过及1280×800人工布局核对。当前主仓库受跟踪图像及只读Design固定树未找到这些原04恢复截图。后来的UI55/UI30/PR75图像属于另一个日期/源码 | 本人UI / Robert（wubq511）核原产物：若存在，回交原图、日期、来源SHA、校验与准确共享路径；若不能恢复，在原记录补勘误，明确没有共享归档。新截图必须另标新日期/源码，不能替代2026-10-12原图 | 原验证文字保留；本人UI已将原04截图声明标为原报告且明确缺共享图，当前两可访问仓库未找回；没有补造截图或重新执行原04 |
| 原05 Design 106/104计数 | [原05](../../I0_UI_05_FILE_HISTORY.md)第222行写10文件106例/新增12；第269行对同固定源`718f2ae`写104 | Design[固定原始提交](https://github.com/wubq511/XunJie_Design/commit/718f2aee58dd7b7b67ba0a1d1b92f6a89004168a)，作者wubq511，2026-10-12 21:09:14 +08:00；提交正文明确记录104例通过/新增10。只读该固定树10测试文件，按参数表展开静态声明也为104，明细见§2 | 本人UI / Robert（wubq511）按固定来源勘误第222行至104/新增10并保留纠正说明；第269行的104保留。若106另属独立轮次，须提供对应固定源/执行日志再分列，不静默择一或混用主仓浏览器104 | 已找到可审查的一手勘误依据，本人UI已于本轮直接纠正原05的104/新增10与fileLifecycle5，并保留旧数和日期；没有运行Design测试，静态104不计新通过 |
| 主仓104/108/169的范围 | 原05 Design单元104、PR50 Chrome104、PR51 Chrome108及I0-B Chrome169容易被合并或互替 | [收尾](../../I0_UI_CLOSEOUT.md)第172行：PR50源码`df7ce3c435247f0337dd0c16e0ef4cbeb3b28f0b` / Chrome154 / 104/104 / 7.0m；第209/215行及[BV](../../I0_UI_BV_EDITOR_BROWSER_VERIFICATION.md)第117行：PR51工程`bde0999c9cf273a11cc1ead9e3258d40365242f8` / Node24、Chrome155 / 108/108、3:38.71 / 238单元。[I0-B §13.3](../../I0-B_UI_TUTOR_PLAN.md#133-最终候选验证与交付)：34文件464单元、22文件169 Chrome，57辅导项包含在169中；原167/169及4规则红灯保留 | UI/原记录维护者在当前索引保留各自日期、固定源、测试类型与失败轮次。不把所有旧数替换成464，不累计多轮/专项，不用静态声明核查认证当前执行 | 固定历史记录可独立查阅；本轮没有重新运行这些套件或产生新的通过计数 |
| 基线汇总及原04误链 | 原04第160行的“MVP_SPEC §10”链接实际指向`I0_UI_SPEC.md`；原05第284行、收尾第75行、BV第48行、I0-B第447行继续请求授权维护者汇总 | 正确入口为[MVP_SPEC §10](../../../product/MVP_SPEC.md#10-实现进展与验证记录)。固定PR75第324～340行仅有之前基线/排程记录，没有本批I0工程及PR75汇总；[TEAM §2](../../../planning/TEAM_WORK_PLAN.md#2-固定职责与修改边界)第30/45行明确A协调、各人维护本人稿、保护基线按文件/范围授权写入 | 本人UI已修正原04链接并记录勘误；UI交固定工程/验证/未执行摘要，A汇总请求。负责人指定的获授权维护者写入产品/计划；不能把A角色自动当作产品写权限 | 请求已存在，实际保护基线尚未汇总。本轮仅提供正确入口和输入，继续写“待授权维护者汇总” |
| 当前清单和导航 | 清单页首第3行仍停PR69；第59行称新包未接收，第61行称正向下载待验，而§12已有PR75补充 | [PR75复验§4](../../I0-UI_PR69_REAL_BROWSER_RECHECK.md#4-修复包冻结与最终现场结果)已交新143文件包、严格TLS/网关16/16、新v9保存冻结、真实C1运行/原Job停止及已有完整产物21字节/hash核验；464单元，新增文件1/1与兼容7/7、服务2/2与辅导33/33各自分列 | 当前UI / Robert在获准清单/任务/README写集更新页首及当前行，链接PR75与较新事实；§9～11明确保留历史。UI-PREP-08可记差异索引及维护动作已准备，原记录勘误/截图回补/基线汇总仍待相应维护者，不写30项全关 | 本文是更新当前入口的具体输入；它本身不改变旧任务、Issue或保护文档，不要求重复接包/C1首接 |

上述原行可直接核对固定[PR75清单](https://github.com/paher-din/XunJie/blob/37b628b75ec3a2238b9b77c8bd1882d36a2e55a6/docs/tasks/I0_REMAINING_WORK_CHECKLIST.md)、[原04](https://github.com/paher-din/XunJie/blob/37b628b75ec3a2238b9b77c8bd1882d36a2e55a6/docs/tasks/I0_UI_04_RECOVERY_CONFLICTS.md#L135)、[原05](https://github.com/paher-din/XunJie/blob/37b628b75ec3a2238b9b77c8bd1882d36a2e55a6/docs/tasks/I0_UI_05_FILE_HISTORY.md#L208)、[原07](https://github.com/paher-din/XunJie/blob/37b628b75ec3a2238b9b77c8bd1882d36a2e55a6/docs/tasks/I0_UI_07_BROWSER_HANDOFF.md#L138)。仓库相对入口用于正常检出阅读；固定链接用于区分此后维护与原说法。

## 2. Design固定来源的静态计数核对

只读 GitHub 的`718f2aee58dd7b7b67ba0a1d1b92f6a89004168a`快照，树响应`truncated=false`；没有安装Design依赖或执行测试。该固定提交正文的历史执行结论为104通过/新增10；下表仅核源文件声明，与历史记录一致，不作为新执行结论。

| 固定Design源文件 | 展开后的声明数 |
| --- | ---: |
| [brand/asset-fidelity.test.js](https://github.com/wubq511/XunJie_Design/blob/718f2aee58dd7b7b67ba0a1d1b92f6a89004168a/app/src/brand/asset-fidelity.test.js) | 3 |
| [brand/motion.test.ts](https://github.com/wubq511/XunJie_Design/blob/718f2aee58dd7b7b67ba0a1d1b92f6a89004168a/app/src/brand/motion.test.ts) | 8 |
| [brand/playback.test.ts](https://github.com/wubq511/XunJie_Design/blob/718f2aee58dd7b7b67ba0a1d1b92f6a89004168a/app/src/brand/playback.test.ts) | 19 |
| [bridge/mockConversations.test.ts](https://github.com/wubq511/XunJie_Design/blob/718f2aee58dd7b7b67ba0a1d1b92f6a89004168a/app/src/bridge/mockConversations.test.ts) | 7 |
| [bridge/mockTurn.test.ts](https://github.com/wubq511/XunJie_Design/blob/718f2aee58dd7b7b67ba0a1d1b92f6a89004168a/app/src/bridge/mockTurn.test.ts) | 22 |
| [lib/fileComparison.test.ts](https://github.com/wubq511/XunJie_Design/blob/718f2aee58dd7b7b67ba0a1d1b92f6a89004168a/app/src/lib/fileComparison.test.ts) | 4 |
| [lib/fileLifecycle.test.ts](https://github.com/wubq511/XunJie_Design/blob/718f2aee58dd7b7b67ba0a1d1b92f6a89004168a/app/src/lib/fileLifecycle.test.ts) | 5 |
| [lib/projectFiles.test.ts](https://github.com/wubq511/XunJie_Design/blob/718f2aee58dd7b7b67ba0a1d1b92f6a89004168a/app/src/lib/projectFiles.test.ts) | 13 |
| [lib/tasks.test.ts](https://github.com/wubq511/XunJie_Design/blob/718f2aee58dd7b7b67ba0a1d1b92f6a89004168a/app/src/lib/tasks.test.ts) | 10 |
| [lib/theme.test.ts](https://github.com/wubq511/XunJie_Design/blob/718f2aee58dd7b7b67ba0a1d1b92f6a89004168a/app/src/lib/theme.test.ts) | 13 |
| 合计 | 104 |

`playback.test.ts`第169行的参数表`['hidden','offscreen']`用于三个`it.each`，各2例；另五个两行参数表各2例及3个普通`it`，共19。其他文件按实际普通声明核对，没有把用例内部循环算成独立用例。原05的106/新增12不能由这个固定来源解释；若原维护者保留106，需附另一个轮次的实际源和日志。

## 3. 30个原编号及门禁保留

[清单](../../I0_REMAINING_WORK_CHECKLIST.md)原序为9/12/9，编号唯一、无缺号。这里只索引，不新增编号、改名或移动原判据。

| 顺序 | 原编号 |
| --- | --- |
| 准备9项 | UI-PREP-01、UI-PREP-02、UI-PREP-03、UI-PREP-04、UI-PREP-05、UI-PREP-06、UI-PREP-07、UI-PREP-08、UI-PREP-09 |
| 真实接入12项 | UI-REAL-01、UI-REAL-02、UI-REAL-03、UI-REAL-04、UI-REAL-05、UI-REAL-06、UI-REAL-07、UI-REAL-08、UI-REAL-09、UI-REAL-10、UI-REAL-11、UI-REAL-12 |
| 辅导9项 | UI-TUTOR-01、UI-TUTOR-02、UI-TUTOR-03、UI-TUTOR-04、UI-TUTOR-05、UI-TUTOR-06、UI-TUTOR-07、UI-TUTOR-08、UI-TUTOR-09 |

UI-TUTOR-09的真实模型/人工语义与学生自主操作，后台逐次采集/分析/提醒，完整AC/NFR、原节点/恢复故障、真人及教学效果保持原范围和未覆盖条件。工程、隔离合成HTTP、现场浏览器、供应商及真人分别报告，不累计专项或重复轮次。并行HDL工作由其现有会话承接，不计这30项或本轮08完成证明。

## 4. 交付渠道与维护者回执

本文随本轮任务作为共享Git输入；实际commit/推送/PR回执由主Agent在当前任务追加。在真正发布前，状态为“交接文稿已准备，尚未发送/推送”。无需另外发源码压缩包或依赖个人旧截图目录；成员从仓库检出后可读原任务、固定GitHub源和准确差异。

| 接收方 | 输入与最小回交 | 当前回执 |
| --- | --- | --- |
| 本人UI / Robert（wubq511） | 原04截图存在性/共享入口或明确勘误；原04的MVP误链；原05固定来源104/新增10及勘误；保留各历史日期和源码 | 本人UI已直接完成原04指针/误链和原05计数勘误；不用派外部成员重复处理；共享Git状态另见当前任务 |
| A / czr112（协调） | 结合#30后续回交维护当前状态，汇总UI实际工程进度与H-05获批源码；确认PR73合并/接纳状态，保留完整验收缺口 | A/C旧回交已存在；PR73当前仍Open，本文没有新成员回执 |
| C / paher-din（实现与现场域） | 延续既有PR73实现/反例与环境责任，按变化核现场接纳；不重新制作原H-04/H-06、20项或首次SSH材料 | 原实现/运行材料沿原评论；本轮不操作或验证现场、不要求重复交付 |
| 负责人指定的获授权基线维护者 | UI固定源码/验证/未执行摘要，A汇总差异后按批准文件/范围同步MVP/TECH及必要排程 | 仍待授权维护者汇总；整理和普通PR合并不扩大保护文档写权限 |

## 5. 本轮核查边界

本轮取证仅读本仓库任务正文、保护文档相关职责/汇总段落、Git历史，以及GitHub #30正文/评论、PR75、PR73与固定Design提交/源码。RTK对带格式占位的`git log`未干净代理，已回退原始只读`git log`核作者/日期；工具错误不作为产品失败。原Design计数、PR73未合状态于2026-10-15 00:11:57 +08:00再次只读核对。随后按负责人身份纠正，在明确范围内维护本人原04/05，详情见§6。

本索引的取证没有运行工程/业务/浏览器/节点/模型测试，没有联系其他成员或操作SSH，没有新增账号、修改环境/信任/配置/数据库。取证Agent唯一写集是本文；主Agent后续只改获准的本人UI文档，当前批次写集见任务。原他人成员评论/保护基线未改，未完成项不代签。

## 6. 2026-10-15 本人UI直接完成的勘误

原UI维护者wubq511即Robert/我们，职责已按用户明确纠正，不另给自己派任务。已修改[原04勘误](../../I0_UI_04_RECOVERY_CONFLICTS.md#2026-10-15-文档勘误)和[原05勘误](../../I0_UI_05_FILE_HISTORY.md#2026-10-15-design计数勘误)：原04去掉无有效共享目标的“见交付说明”，保留原报告并明确当前缺图，修MVP误链；原05按固定来源改104/新增10及fileLifecycle5，原错误数/日期留新勘误，原验证表104和主仓统计不变。

原图核查限定当前主/Design两个可访问仓库，`rg --files --hidden --no-ignore`排除所有node_modules/.git，检查常见图像、04/i004/recovery/恢复相关名称和已有evidence/test-results/screenshots。主仓36图，test-results仅1张较新的辅导准备图；Design5736图，其中5347为参考工程、非参考研究截图8张为2026-10-11，test-results图0。没有找到可绑定2026-10-12原04的图。固定[原04提交63a485e](https://github.com/paher-din/XunJie/blob/63a485e91cb3bf8feb187e5b06992300db2aa699/docs/tasks/I0_UI_04_RECOVERY_CONFLICTS.md#L144)由wubq511于2026-10-12 17:29:05 +08:00记录曾截图；据此只纠正“没有共享/当前未找回”，不推断从未生成，也不拿新IME图替代旧源。

当前页首/接包/下载与PR75已一致；07精确方案和04真实IME由本批自身完成。共享Git材料主要供A接收当前状态和基线汇总输入，C只查其H-05/运行域已有事实，不增加重复节点/浏览器任务。实际发布回执仍由[当前任务](../../I0-UI_PREP_04_07_08_CLOSEOUT.md)记录，推送前不声称外部成员已收到；产品/计划仅由获授权维护者同步。
