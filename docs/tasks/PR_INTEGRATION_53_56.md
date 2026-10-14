# 指定 PR 集成：53 → 56

负责人：Robert；执行：本会话集成 Agent。日期：2026-10-14（Asia/Shanghai）。

## 1. 当前授权与来源

负责人明确要求将当前 #53 并入 #56，更新成功后关闭 #53；另要求在 #56 下发布 comment，记录本次合并信息。继续使用独立工作树，保护主副本并行修改；不合并 main、不开展 P4/P5、UI 扩展、现场部署/模型调用或新业务。

固定来源：#53 `2f6f158f563dca9f824c449a8895edb1e3b2563a`，已经接纳 #54 → #55、#59 → #53 和更新后 #55 → #53，来源记录见 [前批集成任务](PR_INTEGRATION_54_55_59_53.md)。目标 #56 `87a3b795b0e457445edbcd40ecf985e3a0dac012`，原实现固定 `89c85ed`。共同祖先为 `e3e3486d7ec636836c892433c953eb303a64eb6a`，说明 #56 已接纳早期 #53；本批不重复安装/复制其正常宿主实现。

已读正文：README、AGENTS；前批已读的 PRD §4.1–4.5/5–8（PRD-02/04/05/09/10）、MVP_SPEC §1.4/M-04/M-10/4–7（DL-AC-04/08/09、AC-02/04/05/06/07/12/15/16、NFR-04/06）、TECH_DESIGN §2/4.3–6/8.5–10.2、TEAM_WORK_PLAN §2/2.1/7、DL-0；受保护正文与前批固定来源差异为空。补读 DL-A 当前任务 §10–12/16–20 的实际实施、35表、共用宿主、授权与交接正文，以及 #56 的原宿主/HDL/健康入口和原测试，#53 的 readiness 与集成记录。

## 2. 可写范围与方案

可写：本文、README 最小集成导航、本次去敏测试日志/核验清单；正常 Git merge 接纳 #53 在共同祖先后的代码/原任务/证据。冲突适配仅限 `apps/teaching/server/app.ts`、`server/app/i0.ts` 与 `server/app/original-job-host.ts` 的既有 readiness/宿主组合；必要专项测试只验证原判据，保留 #56 原实现和原始证据。不得修改他人任务正文以伪造批准或当前验收。

只读：AGENTS、docs/product/**、docs/planning/**、docs/reference/**、UI 源码、schema/迁移、依赖/lock、凭据/CI、现场节点。#56 原课程/授权/HDL 路由、控制停止、原持久表集与配置能力保留；#53 原 C/HTTPS/交接证据原样承接。不引入其他 PR/main 的新增历史，不把 B 上下文实现当成 HDL 求助真实接线已完成。

方案：以 #56 为基线做保留双方提交历史的正常 merge；保留 #56 提取后的唯一 bootstrap、静态服务、原消费者与关停，不把 #53 旧 monolithic i0 覆盖回来。将 #59/#53 的 C 宿主就绪判据移入现有共用宿主，以 #56 已有 boolean `checkReadiness` 接入唯一 `/health/ready` 路由，保留原 HDL readiness 回调，避免两套重复 health API。纯兼容适配不改变核心业务/权限/共享字段语义；若需要此类实质变更，仅记录交原负责人确认。

## 3. 验收与交付顺序

必要检查：Node24.21.0/原 lock 的 typecheck/build；原 I0/readiness、DL-A 两课程与 HDL 授权/停止/恢复、受影响 tutoring 与 C verifier 专项；静态服务测试使用独立工作树原 UI 构建前置，不开展浏览器测试。检查没有未解冲突、保护写集变化或重复宿主；原证据不改。

通过后提交并普通推送原 #56 分支，回读确认 #53 head 是新 #56 的祖先，再关闭 #53（保留分支/历史），发布用户明确要求的 #56 comment。不关闭 #56 或 Issue。历史通过/本轮实际结果/未执行分别保存。产品基线/MVP_SPEC §10：待授权维护者汇总。

当前：范围与方案已记录，正在实施；最终结果随后追加。

## 4. 实际集成与冲突适配

以原 #56 做 `git merge --no-ff --no-commit origin/pr-integration-53`，保留两边完整提交历史。仅 README、app.ts 与 i0.ts 三个冲突；其余 #53 教学上下文/测试/交接任务/历史证据自动接纳，没有接纳其他 PR/main 历史。

- README 保留 #56 两模式启动说明、#53 的健康入口和 A/C/C 交接导航，增加本任务导航。
- app.ts 保留 #56 唯一 boolean `checkReadiness` 回调和原错误分类，接纳 #59 的 `Cache-Control: no-store`；不增加第二个 `checkReady` AppOptions 字段或重复健康路由。
- i0.ts 保留 #56 薄组合工厂与 guardHostTransport，C-only 就绪委托共用宿主的 `checkReady()`，返回原 boolean hook；不还原 #53 旧 bootstrap/worker/停止实现。
- original-job-host.ts 接纳 #53 原已批准的消费者健康、数据库短事务、当前 runner 指纹/代际、5秒健康查询限时、等待后复查，以及 Fastify 直接 preClose 撤销接纳。bootstrap/业务消费/停止事务/对账流程保留 #56；HDL 模式的原依赖 probe 完全不改。

新增一个交叉模块回归 `server/app/pr53-56-readiness.test.ts`，证明合并后的唯一健康路由仍使用 DL-A 原 HDL readiness（ready→依赖故障503→恢复ready），具有 no-store/requestId，且探测不创建 Job/Attempt/receipt；避免 I0 hook 冲突处理静默屏蔽 HDL probe。#53 原 readiness 7 项不改。

运行时与前批相同，复用前批原 lock 已安装的 Linux 依赖和同源码 UI dist；两个 lock/UI 源码差异为空，未安装新依赖、改 schema 或运行节点。Node24.21.0 的 typecheck/build 已通过；专项运行中。

## 5. 最终验证与保留核查

Node24.21.0/Linux/WSL2 的 typecheck/build 通过。受影响联合专项 **230项，224通过、6项真实模型门禁跳过、0失败/取消**，供应商请求0；包含 I0/readiness、DL-A两课程/HDL权限与关停、C4提交、全部 B tutoring 和 C交接 verifier，以及新增的原 HDL readiness 交叉回归。不是 P4/P5 或完整应用验收。详见 [核验结果](evidence/pr53-56-integration-20261014/verification.json) / [实际原日志](evidence/pr53-56-integration-20261014/affected-tests.tap)。

```sh
cd apps/teaching
npm run typecheck
npm run build
node --test --test-reporter=tap server/app/i0-readiness.test.ts server/app/i0.test.ts server/app/digital-logic.test.ts server/app/pr53-56-readiness.test.ts tests/app.test.ts tests/errors.test.ts tests/startup.test.ts tests/dl-a-app.test.ts server/workspace/hdl.test.ts server/workspace/submissions.test.ts server/tutoring/test/*.test.ts ../../docs/tasks/evidence/dla-c-handoff/entry-verification.test.mjs
```

按 merge-base 实际差异逐 Git blob 核查：除三处冲突外，#53 的115个原增量 blob 与源头完全一致；除 README/app/i0/原共用宿主适配文件外，#56 的112个既有变更 blob 完全一致。#56原 digital-logic.ts、配置/main、HDL权限/C4工作区与原独立证据不改；#53旧原始现场证据/集成日志不改。受保护路径、UI/依赖/lock/schema/runner/records/workspace写集差异为空，无未解冲突。

首次静态检查为74份文档/1127内链/errors=[]，空白检查通过；新增结果链接后的最终检查随后记录。没有新增业务共享字段、权限或协议；#56原HDL求助真实授权/current/C3接线和ALU行为检查等原缺口保留对应负责人，不凭离线集成关闭其业务Issue。真实模型/现场HTTPS/执行节点/浏览器/真人/教学均未执行，原HR-DL-02有条件通过等历史结论不改。产品基线/MVP§10待授权维护者汇总。

## 6. 审核交付与关闭顺序

本批正常 merge 保留 #53 与 #56 双方历史，仅普通推送原 `codex/dl-a-mainline-closeout`，不强推、不合并main、不删除分支。推送成功并确认来源head是目标head祖先之后，依负责人当前明确要求关闭#53，再在#56发布集成comment（来源、接纳方式、冲突、验证和关闭状态）。这些操作的实际回执随后追加；#56保持Open/Draft，其他Issue不关闭。回滚如需执行，应由负责人审核新的revert提交，保留原证据，不以reset/删除历史处理。
