# DL-A：合并后分支剩余文档与证据收口

日期：2026-10-14（Asia/Shanghai）；执行：C。负责人本会话要求处理GitHub `codex/dl-a-mainline-closeout had recent pushes` 提示。其含义据远端实际提交/比较核对，不把页面提示当构建失败。

## 1. 依据与实际差异

已读README/AGENTS、PRD §4.5/PRD-03/04/09/10、MVP_SPEC §1.4/7（DL-AC工程/模型/浏览器/真人分层）、TECH_DESIGN §8.5/11；原 [C续作](DLA_CONTINUATION_20261014.md)、[PR56合并及运行回执](DLA_PR56_REVIEW_MERGE_UI_20261014.md)、[UI交接](DLA_H4_UI_HANDOFF_20261014.md)的正式范围与失败/未执行。

GitHub回读：PR56已Merged，head f28cafdfbd9450f8dbe0ccaab690207503297b78、merge b03b1b49728677a87876e8d71ccfb7c6c874a029。指定source分支head `c30334693500c6d5ada72202a8053c4678745a77`，main `8b4130374289b71d737abe12ed4fc5e58adf55c5`；compare为ahead2/behind7。两个剩余提交为3d053bf（合并后准确main验证/现场换版/UI回交）和c303346（公开回执），差异31文件全为本人DL-A文档/证据；apps/**、AGENTS与保护product/planning/reference零差异。

因此成熟源码已经main；问题是事后两笔验证/交付记录未纳入main，主页比较入口仍显示该分支有新推送。实际差异需收口，不能仅靠删除分支或忽略记录掩盖。

## 2. 范围与方案

复用指定source分支，独立工作副本，固定远端c303346；正常合入当前main，保留历史和UI成果。可写：本记录/本人验证与公开回执、DLA_H4_UI_HANDOFF/DLA_PR67_RUNTIME_HANDOFF/DLA_PR56_REVIEW_MERGE_UI的最新状态补正，README必要导航。保护规范/product/planning/reference、源码、CI/配置/秘密/库/节点均只读。不接纳或修改独立H-05 PR73，不部署服务/调用模型，不关闭DL-A整卡或UI验收。

顺序：核source/main → 普通merge main → 补正当前3443/3444来源与H-05独立状态 → 两轴文档/证据审查、静态/空白/公开内容/hash检查 → 普通推送source → 单列仅文档收尾PR、审查合入main → 原source分支仅正常快进到合并main → 回读source/main/compare和PR事实。不删除分支/历史、不强推；页面的历史推送字样可能由GitHub继续显示，验收以source无待合差异为准。

## 3. 验收与边界

最终写集只有收尾文档/证据/导航，应用源树保持与main相同；没有新业务变化，因此复用原固定源回归（PR56 70/70，main137项首轮136/1静态产物前置失败后1补验、UI464、严格TLS/静态字节/对象与指纹保持），不重复测试节点或模型。文档引用/锚点/新写集空白必须通过；日志保留失败/受控跳过，不改历史计数或真实执行版本。

产品/TECH/MVP§10汇总待授权维护者。H3绑定/course_check/新节点/全矩阵仍后置，真实HDL UI演示仍UI推进；当前运行87edd51与H-05源码PR73分别记录，main合文档不是新的部署或教学验收。

## 4. 实际验证与交付

待本轮审查、静态核验、PR合并及分支快进回执填写。

实际普通merge当前main8b41303，无冲突，提交52434a0fdf7d579e5148cffd2c092665ce5f8766；GitHub实际source c303346与本地旧tracking be4305e分别核对，工作树先正常快进到确切c303346，再merge。网络fetch暂未完成不代替远端REST回读，不借此强推或覆盖工作。

补正本人运行交接：3443后续已由A/C正常接纳87edd51/24表，旧“仍f761dcd”保留其时点并附独立PR73的已公开核验引用；3444维持87edd51/35表。当前两个unit ExecStart实读均该源、active；只读核对，没有重新启动/部署。H-05未部署/未合main，本次源码零差异。

静态106文档/1712内链/errors=[]（后续审查记录另记最终数）、增量空白通过；原整个比较空白通过。新写集与历史证据将再核原始Git blob/字节摘要/秘密字段模式及原精确key零命中，固定main/app/protected零差异。两轴审查按项目code-review，记录规范/需求分别结论；仅文档变化不新增业务测试。

实际Git blob审计：[33文件/7份原始gzip核验](evidence/dla-postmerge-closeout-20261014/verification.json)；所有JSON可解析、精确秘密值0命中、原日志137首轮136/1及1补验、UI464、137可服务/6MIME拒绝和24/35表前后投影均一致。应用与保护树在固定8b41303/d6b7e9a相同。首次WSL Git因Windows工作树.git指针格式无法读取失败，改只读共享Git元数据位置后通过；不改Git配置/原数据。普通fetch网络300秒超时，远端source/main用REST实际回读并保留，未强推。

## Standards

固定8b41303…d6b7e9a：0明确规范违例、0需修改异味。仅本人文档/证据/README导航，源码与保护目录零增量；运行源和阶段分开、历史时点保留；没有将失败改为通过/扩大模型或学生B身份许可。公开证据无实际key/私钥/密码/认证头；README只做入口。

## Spec

同固定范围：缺失/部分0、越界0、错误表述0。MVP §1.4要求工程/模型/真人/教学收益分别报告，记录保持137首轮136/1与1补验、UI464/静态文件/对象原事实，不写浏览器完成。TECH §11要求未执行/失败/未知保留，87edd51与历史f761分开，H-05独立PR73/未部署、后置H3与模型预算保持。

两轴：Standards0/最严重无；Spec0/最严重无。后续只有审查回执/公开记录变动，不重复业务验证。

## 5. 并发main与最后交付

审计期间main正常合入PR71 A6合同消费，head3f4fbcda0f2e341abb225b12a9acbaf9a7e66489；PR73仍Open。该main成果原样保留，不把它带成本文档PR新增实现。本批在GitHub合并前核最新base/head/mergeable及文件清单；如需仅用Git API正常merge/快进，仍force=false并实际回读祖先/源引用，最终以source与main同SHA/compare零差异为准。

最终合并与源分支状态在本批收尾PR的Git合并事实及公开回执保存；本任务在合并前完成验证，不在合并后再补推source造成新的待合记录。没有删除/强推源分支或重写历史。页面可能保留历史推送文字，该缓存文字不作为Git差异验收。
