# DL-A：PR56 审查、main 合并与 UI 真实 HDL 接线

日期：2026-10-14（Asia/Shanghai）；执行：C。此前实现、授权和原始验证保留于 [C 续作](DLA_CONTINUATION_20261014.md)，本记录只承接本轮审查与交付。

## 1. 负责人决定与依据

负责人本会话明确要求：

1. 先审查、合并 #56，将成熟的 DL-A 服务端功能正式纳入 main。
2. 立即交给 UI 做真实 HDL 浏览器接线，完成学生操作、真实构建结果、Agent 提示展示和修复演示。
3. H3 剩余的教师绑定、course_check、节点部署及完整测试后置，不阻塞已经可用的 HDL 演示。

这取代此前“PR56 本轮仍供后续审阅、不自动合入 main”的交付限制；保留源分支和既有记录，不删除 Git 历史。不把后置项写为已实现或已验收。

已读 README/AGENTS、PRD §4.5/5–8（PRD-03/04/05/09/10）、MVP_SPEC §1.4/M-03–05/5–7（DL-AC-01–09，相关 AC/NFR）、TECH_DESIGN §5–7/8.5、TEAM §7/P3–P5、DL-0、DL-A §15–20、C 续作 §1–9、H4 接线包及 PR67 现场接线包。产品与 MVP_SPEC §10 汇总待授权维护者处理，不直接改保护文档。

## 2. 固定点、写集和方案

审查固定 main：`b7e73c5f65d457fb78d2fcbac7003e4e60ed7f43`；PR56 head：`be4305e844bf8aa594235c7c7252cd9bedade0ce`。`git diff b7e73c5...be4305e` 非空；`git log b7e73c5..be4305e --oneline` 为原完整接纳历史，339 文件主要为可追溯记录和证据，业务源码审查覆盖共用宿主、35表初始化、HDL授权与生命周期、H4冻结与C3当前性、已批准H3 runner内核。唯一规范源为根 AGENTS.md；code-review 技能要求 Standards/Spec 两个只读并行审查。

可写：本记录、本轮去敏证据、C 续作/UI交接包必要状态补正；审查若发现阻塞问题，仅修原 DL-A/runner/shared host 范围和必要调用方/验证，先在本记录列明差异。UI 页面/布局/框架交原 UI 负责人；不代学生学习操作。根工作区无关改动不动。产品/planning/reference/AGENTS、凭据/.env/CI、数据库schema/迁移均不新增修改。

顺序：两个轴审查 → 修复实际阻塞问题并必要验证 → 核远端 main/head 未漂移 → 普通发布本任务记录 → #56 ready、exact head 正常 merge → 回读 merge/main → 在原 UI Issue #30 交固定 main 和立即接线清单。不重开历史 PR、不部署 H3 新节点、不关闭 DL-A 整卡。

## 3. 证据与验收口径

沿用现有固定源码验证：最新组合68/68、UI类型/构建通过及464单元通过；H4冻结专项35通过/2模型门禁跳过；真实目标 HDL 构建/装载/两操作LED8/6/Trace/确认停止已有工程证据；真实DeepSeek一轮使用1请求（2615/388 tokens）并已耗用授权，不再次调用。H3隔离CLI2800向量/8400样本不替代目标节点验收。见 [PR67证据](evidence/dla-pr67-integration-20261014/verification.json)及 [C续作证据](evidence/dla-continuation-20261014/verification.json)。

本轮验收：两轴结论可核查；合并无阻塞发现、源/head/main确切；文档静态和新写集空白通过；UI收到固定主线、API/版本/运行源/信任身份边界、浏览器演示顺序与回交要求。原模型授权已耗用、Robert 本机3443 C入口与PAHER3444 HDL入口不混用；需要新的付费轮次或秘密/信任修改时沿准确门禁单列。实际UI接线、浏览器displayed回执与人工修复未执行，不能记为通过。

## 4. 实际结果

Spec 轴发现实际合并阻塞：`digital-logic.ts` 的 readiness 仅检查执行器/代际，没有接共享host消费者健康和 `teaching.isHealthy`，未启动或扫描失败可能仍ready。依据 TECH_DESIGN §10.2/8.5 正常宿主和依赖就绪，实际修复写集限 `server/app/original-job-host.ts`、`digital-logic.ts`、`pr53-56-readiness.test.ts`、`tests/dl-a-app.test.ts`。复用共享host既有消费者/数据库守卫，在DL-A两种执行器探测前后核查；保留C可选配置行为、不重复调度/新建共享HTTP契约。原I0的前后守卫判据不变。未修改 `dl-a-support.ts`。

## Standards

固定 `b7e73c5...be4305e` 审查0项明确AGENTS违例、0项可据此阻塞合并的设计异味。覆盖共用宿主、35表组合、HDL授权/停止/结果完整性、H4冻结/C3投递回执、ALU/VPI/SSH；公开证据未发现实际密钥、私钥、密码或会话头。初始化明确fresh-only已批准35表，不迁移原库；工程/模型/浏览器/真人分层记录。readiness补丁复核0项新增问题。

## Spec

修复前1项P1、0项越界：DL-A readiness未连接原消费者健康。TECH §8.5要求“避免两套入口或手工驱动 Job”；§10.2要求“健康检查分别报告应用、数据库、模型供应商和执行器状态”。上述补丁复核P1已消除、0项新增偏差；启动前/扫描失败时503、成功扫描后恢复，探测等待期间失效不能迟到返回ready。浏览器及H3明确后置项不计此次合并阻塞。

两轴统计：Standards 0；Spec原1个P1已修复，当前未解决0。审查为源码独立审查，不替代全部实际节点/浏览器/真人验收。

## 5. 修复后实际验证

Linux `/opt/xunjie-runner/tests/dla-pr56-review-20261014/source` 从已核767文件固定f761dcd副本复制，保留原依赖/dist，只替换上述4份源码/测试；未运行真实节点/模型或改原库。

命令：Node24.21.0 `npm run typecheck`、`npm run build`，`node --test server/app/*.test.ts tests/dl-a-app.test.ts tests/dl-a-hdl-help.test.ts server/workspace/submissions.test.ts`。最终70/70，失败/取消/跳过0；新增启动前、数据库/原run与teaching扫描失败和恢复、HDL探测等待时失效均通过，真实HTTP drain/shutdown原断言保留。最初typecheck因本人测试把重载inject的ReturnType当Promise失败，改确切Promise响应类型后通过，原失败日志保留，不关闭检查。

文档静态100份/1531内链/errors=[]（本段加入后另记最终数）；原PR相对main差异空白通过，本人写集检查通过。原main已有CRLF证据问题仍留原时点，不改其blob。日志及汇总见 [本轮证据](evidence/dla-pr56-review-20261014/verification.json)。真实模型请求0，H3节点部署0，浏览器HDL操作0。

## 6. 合并与UI回交

修复提交 `f28cafdfbd9450f8dbe0ccaab690207503297b78` 普通Git push连接失败，沿既有Git API精确树/原父/force=false发布，远端SHA与本地相同。PR56已ready并以match-head正常merge，合并 `b03b1b49728677a87876e8d71ccfb7c6c874a029`，2026-10-14 21:58:33（Asia/Shanghai）；源分支保留，Issue不关闭。

并发变化：merge首父是 `e12c944d070ec4f45b56990292954a5da74a2664`（PR65 A5），并非此前b7；随后PR69 UI合入main `87edd51e165b2bab660d73a551864ff8db0bed86`。#68 HDL操作表仍Open/Draft，引用其固定805c76a，不称合入。已用HTTP/1.1正常fetch并在本人独立工作树fast-forward到87edd51，未覆盖根工作区。新main的A5改动包括事务内recovery readFeedback、活动teacher投影与独立review工厂teacher_feedback，须补验实际组合；DL-A精确35表不接review表，不迁移原35/24表。UI#69也有生产源码变动，需重建当前正式dist，不能把旧f761的143字节当87edd51。

新增验证写集仍只本人记录/去敏证据；读A5批准与消费交接、UI69已交验证，复用源成果不改其文件。方案原始Git归档791 runtime文件、逐字节/mode/hash核接纳；在新受控副本按原Node24.21/lock/依赖跑teaching类型/构建、宿主/HDL/H4/C4+A4/A5受影响组合和当前UI类型/单元/构建；不重复UI作者全浏览器矩阵。仅在通过且旧HDL无未结Job/会话时，将C本人的3444联调进程正常停/启至准确当前源/新dist，保留原35表/配置/TLS/签名/SSH/节点/代际/预算关闭与旧副本/argv；3443由原C/UI批次继续，不因本轮切35表或修改凭据。换版后严格TLS live/ready/static并核原对象和冻结指纹，绝不部署H3新节点。

已向原UI负责人@wubq511/Robert发布 [立即实施交接6170192513](https://github.com/paher-din/XunJie/issues/30#issuecomment-6170192513)，指定87edd51/UDL-01～08和同浏览器人工错误→真提示→自行修复→重构建装载链，沿原UI页面，不等H3；原3443/A身份通道与3444/B准确差异及已耗用模型预算明确单列。公开原文最初误把#68说成已合入，已回读merge历史并编辑纠正；未据此接纳其文件或重复合并。请求已发不代表UI已收到或完成。

### 6.1 合并后固定main的实际验证

791 runtime文件的Git blob/bytes/mode/hash一致；teaching与student类型/构建通过，UI单元464/464。实际main组合137项首轮136通过/1失败/0跳过：本人并行构建时宿主静态测试先于student/dist完成，唯一失败为i0.test的真实UI loopback测试ENOENT；不是功能拒绝。产物完成后只补跑该原用例，1/1、0失败/跳过，其余136项不重复跑、不把首轮写成137/137单轮通过。原失败和补验日志保留。命令与结果见 [汇总](evidence/dla-pr56-review-20261014/verification.json)。

A5原成果正常接纳：新增34表review工厂不扩展DL-A35表，事务内readFeedback接缝与其可选未装配unavailable路径在C4/A4/A5组合通过；teacher的sourceBlueprintId投影与学生私有边界在组合回归覆盖。未部署A5新库/反馈schema，未重复审查作者完整UI浏览器/NFR。

### 6.2 3444当前正常宿主与正式UI

切换前严格读原35表，pendingJob=0/未确认终止Session=0；正常停止本人旧f761dcd unit，启动 `xunjie-dla-ui-main-87edd51-20261014.service`，来源 `/opt/xunjie-runner/tests/dla-main-fixed-87edd51-20261014`，原serve-hdl脚本/原35表reference/Node24.21。没有改受控配置、秘密、24表服务或节点；model budget仍false。Windows loopback TCP3444可达，strictTLS live/ready/root均200，ready检查原消费者健康且no-store/requestId一致。

原24/35表Assignment/Attempt版本、原Job数与未结数前后投影一致；两种C/HDL readiness均true，原generation/fingerprint/profile/images/validation逐字段保持。实际0模型请求、0节点部署、0浏览器HDL操作。137可服务静态文件全部严格TLS/bytes/hash一致；143清单中的6项JSON/OFL按既有契约拒绝400，未改白名单。[现场回执](evidence/dla-pr56-review-20261014/hdl-main-runtime.json)、[原对象/指纹保留](evidence/dla-pr56-review-20261014/runtime-preservation.json)、[真实静态字节](evidence/dla-pr56-review-20261014/served-ui-main.json)。

正式ZIP：PAHER Windows `/C:/Users/p3148/XunJie_DLA_MAIN_87edd51_20261014/student-87edd51-dist.zip`，143文件，SHA256 `8e6a52a3a3fff7a36c91bc35589eb4a36dcb6160fcd412ad36d5357bf5a879bb`；同行 `student-dist-manifest.json`，可沿既有SFTP领取，校本机staticDirectory/来源后再验Robert浏览器。旧包/目录/argv保留。停止：`wsl -d Ubuntu -u root -- systemctl stop xunjie-dla-ui-main-87edd51-20261014.service`；回退只停新unit、按旧f761dcd保留argv启动，不重建库/重放Job/模型。3443仍f761dcd/24表，本轮不把两环境混成同账号入口。

UI实际接线与同浏览器演示尚未回交。最新main已经有成熟服务端；H3教师绑定/course_check/节点换版/完整矩阵后置。新现场模型批次与学生B受控通路需沿UI完成后的准确边界处理，旧单轮不再消费。完整DL-A整卡、DL-AC、原AC/NFR/真人/教学效果未宣称完成。

### 6.3 最终公开回执与后续责任

文档/证据提交 `3d053bf4cc9e8d71cf2920ad9f205f1020228f30` 已普通非强制发布原source分支，Git传输失败后API精确树/原父回读SHA一致；无新PR、未把事后记录提交误称PR56已合并源码。实际runtime仍87edd51，源分支和旧副本均保留。

公开交付：[UI当前源/ZIP/严格TLS/停止回执6170632785](https://github.com/paher-din/XunJie/issues/30#issuecomment-6170632785)、[PR56合并回执6170633658](https://github.com/paher-din/XunJie/pull/56#issuecomment-6170633658)、[DL-A整卡范围回执6170634483](https://github.com/paher-din/XunJie/issues/38#issuecomment-6170634483)。B已收到 [真实HDL上下文/语义核对与预算边界6170648839](https://github.com/paher-din/XunJie/issues/40#issuecomment-6170648839)，不再要求C重制已有包；B只复核已有真实提示/当前性和故障降级，新的实际调用仍需准确预算。

截至本次交付没有UI完成UDL-01～08的回复，不记“已接线”或“浏览器完成”。UI维护本人代码与浏览器演示，B配合语义/有限上下文，C已完成本批main集成、必要修复验证、原35表正常宿主和固定材料；具体跨机3444/B受控通路、新模型轮次在UI产物备齐后按准确门禁处理。不得恢复等待H3才接线。根工作区原README/planning/product/G3及原C材料无关差异仍未触碰。
