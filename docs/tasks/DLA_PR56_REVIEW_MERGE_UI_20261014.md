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

待远端exact-head合并和公开回执回读后填写。
