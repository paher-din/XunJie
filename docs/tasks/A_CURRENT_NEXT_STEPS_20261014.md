# A 当前可独立完成的推进记录（2026-10-14）

本批依据[推进清单](I0_DLA_NEXT_STEPS.md) §3.1～3.3、I-4、D-1/3/4，以及负责人“按照下一步计划完成a目前能做的任务”。保留主目录及既有A工作区修改；只做本地复审、隔离组合验证和本人交接/会审材料，不发布评论、推送或合并PR。

## 1. 固定点、规范与写集

- main：`0e683251031f28b3d2458e9f9093c8d92aa859b3`；I0 #53：`fe6d301896603be258e5f6b942037c194429db93`；DL-A #56：`87a3b795b0e457445edbcd40ecf985e3a0dac012`；C #55：`d86e51e8b09f283e9249d0e85e70cc4df873aff9`。
- B #54新修复：`b6984801fcf63cf9cd6e72aab2cf3f94b6c1bd8b`；旧复审：`8ff68cd751c9c41423560c13f3135805820ae80b`。main已由B合入，不重派旧三处机械冲突。
- 已读各既有工作区AGENTS/README、PRD §4.1～4.4、MVP M-02/03/05/10、AC-02/03/06/15、数字逻辑DL-AC与完整门禁、TECH §4.3/6/7/8.5；I0手册§17.5，DL-A §18/19及H3/H4会审首稿、B任务与原HR-DL-02裁定。复审使用仓库code-review技能的独立Standards/Spec两轴；issue tracker直接采用现有GitHub固定PR/issue，不初始化新跟踪配置。
- 本人文档可写：本记录、推进清单及按需本人I0/DL-A交接记录；隔离副本和原测试输出可保留。B/C/UI源码、他人任务、产品/规划/参考/AGENTS只读。本批不改变共享契约、schema、凭据、CI、UI或后台安全默认。

## 2. 执行顺序与验收范围

1. 复审B固定新head：核原三项P2修复、实际SyntheticProvider输入反例、LED/reset离线回归、准确人工裁定及main/B3合并保留；以原测试执行结果和独立两轴结论分别记账。不调用已消费的真实模型。
2. 隔离核I0/最新main、DL-A/最新main、再加B修复的组合：保持原24/35表工厂/守卫，复用已批准新临时合成库与公共测试接缝；不迁移旧库、不运行物理节点。先类型/构建，后宿主/授权/消费者/停止及HDL/C4/B3相关回归。组合树不等于远端合并或发布版本。
3. 按H整理UI可接能力与固定证据；原手册visibility已本地补正，公开固定稿仍旧。材料准备完成与UI实际收到/浏览器通过分开，未授权新公开发布不冒充已交付。
4. 汇总H3/H4现有提案、A明确建议和仍需C/UI提供或负责人确认的具体输入；新字段、ALU执行器、模型/现场/浏览器工作不据本记录直接实施。

所有测试须使用批准Node 24.21.0及原锁依赖；不放宽runtime或测试门禁。未执行、失败、跳过按实际报告。既有C20项、A53项和Linux419项不迁移为新组合通过数。

## 3. 执行记录（随实际结果追加）

准备阶段：只读merge-tree显示#53与main、#56与main各自可机械合并；组合未验证。B新修复包含main，Github可机械合并，但仍保留旧CHANGES_REQUESTED记录且新head无独立通过结论。

隔离B源码首次archive命令的PowerShell参数构造失败，未产出可用包；已更正为单独output变量并成功保留固定源码副本。原工作区未受影响。系统Node24.15.0和桌面依赖Node24.19.0均不满足批准运行时，未用于业务测试；正在定位既有Linux24.21.0。

后续运行时准备：在本批独占临时目录取得Node24.21.0 Windows/Linux原发行包，核[官方SHA-256](https://nodejs.org/download/release/v24.21.0/SHASUMS256.txt)，未修改系统PATH或安装系统服务。只给本任务子进程设置PATH；真实节点/模型门禁关闭，未输出或修改原凭据。Windows复用既有原锁依赖，Linux隔离副本执行原锁npm ci成功（better-sqlite3安装脚本提示保留，未修改依赖/allowScripts）。完整回归时未装配Icarus；随后从[Ubuntu原包](https://archive.ubuntu.com/ubuntu/pool/universe/i/iverilog/iverilog_12.0-2build2_amd64.deb)取得同一已批准12.0-2build2 amd64版本，仅解压到本任务临时目录，时基专项5/5通过。未升级引擎、安装系统软件或操作节点，完整回归原跳过不倒写。

## 4. B新head独立复审

固定`b6984801fcf63cf9cd6e72aab2cf3f94b6c1bd8b`，比较旧已审`8ff68cd751c9c41423560c13f3135805820ae80b`与原人工裁定；两独立Agent按code-review技能分别只读，父Agent另执行测试。原审查/作者声明是历史，以下为本批独立结果，不表示新的GitHub批准。

### Standards

硬规范违反2项，判断性异味0项：

1. **P2：原模型正文被改写。** `docs/tasks/DL-B_HDL_TUTORING_HUMAN_REVIEW.md:94`的“模型完整可见正文 / unresolved”由原错误位值变成正确位值/复位边界，违反AGENTS原证据保存与本文件§3/勘误追加约定。恢复原输出；正确事实只追加到勘误，不修改原模型曾经说过什么。
2. **P2：PR正文仍宣称无条件通过。** [#54正文](https://github.com/paher-din/XunJie/pull/54)R54-R03称原审阅者重核为“通过”，与当前两份B任务稿“有条件通过”不一致。B应同步准确裁定、固定点与验证范围；新代码测试不能把人工条件裁定改成全部语义通过。

### Spec

可操作问题1项：同一历史模型正文被改写，违背R54-R03“保留原输出/旧裁定，追加勘误”要求。R54-R02实际C格式位置前缀清理/provider输入反例、R54-R04位值/reset观察限制及R54-R01信号白名单静态符合要求，无其他可操作行为偏差。

**两轴分别计数：Standards 2 / Spec 1；两轴最严重项均为原证据改写，Standards另有PR结论不一致。** 不合并重复发现或跨轴重排。B文件只读，本批未代修、发布review或发送新评论；残留交B→原审查者/A，不再要求重做已通过的代码或main合并。

| A独立执行（Windows Node24.21.0） | 结果 |
| --- | --- |
| 类型检查 / 构建 | exit0 / exit0 |
| real-model-support + hdl-help | 35总：33通过、0失败、2跳过 |
| tutoring全目录 | 160总：153通过、0失败、7跳过 |
| 原A0文档检查 | 66文档/914内链，errors=[]、exit0 |
| checker自身回归 | 16/16通过 |

tutoring覆盖main已合入的B3增量；原message单行`/snapshot/…:行号:`清理由实际SyntheticProvider输入断言验证。LED最低位0/次低位1、resetN全1按原帧验证，不新增DeepSeek调用。HR-DL-02维持有条件通过；全套真实模型、浏览器/真人/教学效果未执行。

## 5. 隔离组合、去重与实际验证

只在本批隔离目录解包Git固定树，没有切换、合并或覆盖原工作区。merge-tree生成对象不改变原分支/index，测试树没有远端发布。archive可能按现有属性转换行尾；本批未做773文件原Git字节包认证，不把这些副本作为已认证现场交付包。

| 组合 | 固定树 | 类型 / 构建 | 宿主或业务验证 |
| --- | --- | --- | --- |
| #53 + main | c1d35c5d3125c65077014c9cba0608bbab92d17d | 均exit0 | i0.test 10/10，0失败/跳过 |
| #56 + main | 8c8d2e072e7595b5757cde39e9dffddd3b8d37e5 | 均exit0 | i0 + digital-logic + dl-a-app，30/30，0失败/跳过 |
| #56 + #54（#54含main） | c7c9220843ee91d5d95d84544ba1638a17da9bab | Windows/Linux均exit0 | Windows完整464总/443通过/2失败/19跳过；Linux完整475总/458通过/1失败/1取消/15跳过；均未全通过，专项另列§8 |

Windows完整两项失败保留：I0宿主测试执行时副本缺gitignored UI dist；另一项`review.test.ts:118`要求Linux可信控制上下文，在win32以INVALID_CONFIGURATION拒绝。没有改测试判据/模拟该上下文。原student源码tree在各固定点相同；核既有135文件dist后等字节复制（SHA256差异0），三个宿主专项改正环境后成功；#56/B的I0失败项亦复验10/10。初轮失败和最后通过分列，不改写完整Windows失败总表或累计通过数。

原I0精确24表、DL-A精确35表及A4各自范围守卫保持；不是所有测试库均35表。工厂不删除新库，但工具默认临时目录在后续调用中无法取得：首次Linux清点birthtime=1970/文件0、Windows默认沙箱临时目录文件0，不能证明整批库已保留，也不据此声称库被删除。Linux初次输出与[初次工具观察摘要](evidence/a-next-20261014/retention-initial-observations.json)分别保留；Windows生成式清点收据在最终复验后刷新。最后将关键宿主测试TMP/TEMP/TMPDIR显式指向本任务独占保留目录，真实运行后只读清点，结果见§8；不迁移或复制旧库。

实际loopback HTTP、真实登录Session、原Job消费者及SQL事务涵盖权限/旧版本/重放冲突、C4提交/停止和关停等待期拒绝新派发。合成transport不等于认证物理C/HDL、严格TLS或同浏览器通过。

### 5.1 #53/#56去重与README合入准备

原9个交集文件4相同/5不同核对保留。直接#56/#53 merge-tree仅README冲突；对合成树`f9f0721914eb197ec1db6a7f83d66066dfd023bb`与#56逐项比较，**apps/teaching和apps/student没有差异**。因此本批#56/B组合的可执行源码已包含两A分支相同的应用能力；#53追加的是I0交接/证据文件，不能用这一事实宣称已经合入远端。

本地[README解冲突稿](evidence/a-next-20261014/readme-resolution.txt)保留#56的两模式、35表、H3/H4、C实审/发布记录，同时补#53的I0§17固定版本/PAHER步骤入口。它是合入准备，未覆盖主目录或任何工作区README、未解决原分支index/提交合并。树/字节摘要见[收据](evidence/a-next-20261014/verification.json)。实际合入须再核head增量及链接，PR合并仍按具体授权执行。

## 6. A交接/会审材料已本地完成

- [I0逐H的A复核接收包](I0_A_UI_REVIEWED_HANDOFF_20261014.md)：原C固定证据、入口与原ID/版本、Session/CSRF、读取/bootstrap、ACK/快照、Job/取消、私有结果、visibility勘误，以及UI/C的实际访问/信任/领取/窗口回交。没有重复发布#30现有任务；UI尚未实际收到新包。
- [H3/H4补充稿](DL_A_H3_H4_REVIEW_20261014.md)：A最小业务方案及准确接收人，查明未终止Session唯一索引冲突；已复用Build/Session读取，只向C追精确Operation/current与真实样例。保留共享确认/实施门禁，未写ALU执行器或移除help门禁。
- [推进清单](I0_DLA_NEXT_STEPS.md)：当前B状态更新至b698480，已闭代码项/未闭文档项分开，组合与下一责任同步；§8.1～8.3原时点记录保留。

上述三份当前文档独立两轴只读：Standards硬违反0/异味0，Spec偏差0；子Agent没有执行现场或测试。§7～8及最后结果收据是父Agent后续追加，另作静态核验，不冒充被子Agent完整审过。

## 7. 当前只等待哪些精确交付

| 责任人 | 提供什么给谁 | A接收后推进什么 |
| --- | --- | --- |
| B / #54 | 原模型正文恢复＋追加勘误，PR有条件裁定/固定验证范围→原审查者/A | 增量复核并给准确工程/语义结论；代码离线修复不重复 |
| C / H3 | 层级解析、稳定采样、独立Session占用准确写集、command/result/Job映射、2800限额覆盖与指纹运行计划→A | 冻结A绑定/配置/权限/投影提案，交负责人精确确认，再各域实施 |
| C / H4 | 精确Operation ID公共读者、同事务current/pending/停止/替换/终止投影与实际Build/Session/Operation样例→A/B | 与B/UI形成字段/哈希/事务/投递守卫完整写集及验证方案；确认后接线 |
| UI / #30、#38 | 与C定浏览器/profile/访问/信任精确范围/账号安全领取/运行窗口；HDL操作→请求→状态→缺项及显式选择表→A | 复核入口与消费差异；逐批浏览器接线/回执，最终DL-E2E |
| C / 35表真实组合 | 接已公开固定A源，在覆盖该批的范围内回真实登录/HDL原Job/Frame/Trace/C4/停止证据→A | 实审原ID/版本/权限/生命周期后交UI；不是重做I0原20项 |
| 项目负责人/授权维护者 | 收具体写集后确认共享契约/实际运行范围；保护产品/技术基线汇总人 | 明确记录已实现/已验证/未完成；不把本地材料完成当整卡完成 |

材料可以先审，不等待#39/#40整张关闭。远端本批发布尚未执行；A已完成的本地准备/独立验证不依赖这些输入，ALU/H4真实实施、现场和浏览器则依赖，不能提前勾通过。

## 8. 最终结果与证据

Linux完整组合：**475总/458通过/1失败/1超时取消/15跳过，exit1，未全通过**。失败是startup.test:20子进程5秒ETIMEDOUT，取消是:31编译入口10秒超时；业务断言未失败。未延长限时、改源码或关闭检查。

将同一完整源码/依赖/Node复制到新WSL原生临时目录后，startup.test **4/4通过**，原两个子进程约202ms/298ms，exit0。该对照支持挂载盘读取导致启动超时的归因，但原生目录未重新执行全部475项，不写完整Linux回归已通过。原生副本准备花费较长时间，无配置/业务行为改动。

HDL时基：原同版Icarus原包SHA256 `f19394cee05ad526e0eb3873bc6c17a5828f56df17fbe2db40cb66513a2d4667`，dpkg-deb元数据核12.0-2build2/amd64；1ps/100fs/1fs及低32位tick跨越**5/5通过**。完整回归15跳过=6真实节点/容器/SSH/链路门禁、8真实模型门禁、1时基工具路径门禁；专项5项含4子项，不加到完整475或改原跳过数。

最终#56/B明确保留目录的i0 + digital-logic + dl-a-app专项：**30/30通过、0失败/取消/跳过，exit0**。31个新合成.sqlite实查存在：24表10个、35表21个，读错误0。只读sqlite_master，不读取账号/业务行；保留库在本批临时目录，不发布SQLite文件。完整回归其他默认临时库的持久保留未核实，不以这31个覆盖整套统计。

本批四份当前文档静态UTF-8/围栏、相对链接、两个visibility JSON及日志hash核验结果见[document-check.json](evidence/a-next-20261014/document-check.json)，零错误；git diff --check通过。工作区五个原未提交文档hash与开始时一致；未覆盖其他人修改。

本批日志及摘要入口：[verification.json](evidence/a-next-20261014/verification.json)。保留首次命令/环境失败与最后专项；SQLite/依赖/发行包不作为文档交付，运行历史本地路径只是日志事实，团队入口均为仓库相对文件或固定公开链接。

保护文件README/TEAM_WORK_PLAN/PRD范围内MVP/TECH及既有A_WORK_PLAN原未提交字节均保持；既有I0工作区仍仅原visibility单行补正＋既有typecheck日志，DL-A工作区原clean。未修改产品/规划/参考、B/C/UI源码、schema、依赖锁、凭据/CI；未删除文件/Git历史、推送/合并PR、发评论/私信或关闭issue。MVP §10/TECH进度由授权维护者汇总；本批为本人任务记录与隔离验证，没有新功能实现。
