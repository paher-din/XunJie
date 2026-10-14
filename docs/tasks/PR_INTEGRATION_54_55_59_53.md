# 指定 PR 集成：54 → 55、59 → 53、55 → 53

负责人：Robert；执行：本会话集成 Agent。日期：2026-10-14（Asia/Shanghai）。

## 1. 授权与基线

负责人当前明确批准仅处理 #54 → #55、#59 → #53、更新后的 #55 → #53，允许更新对应 PR 或提交集成结果供审核；不得合并 main、关闭原 PR、扩展 P4/P5、UI 或新业务。

固定接收头：#54 `c00b8ff87114e1522b02a8a0c288b0184799b099`；#55 `279f2145a33b0526f394f97739a204a1e5f0016c`；#53 `869f3c0fc53884e573761ba43cec72000fc91f98`；#59 `964abb4277c2cf58e81d6686f6349b6ef0fa2e39`。

已读正文：README；PRD §4.1–4.5、§5–8（PRD-02/04/05/09/10）；MVP_SPEC §1.4、M-04、M-10、§4–7（DL-AC-04/08/09，AC-02/04/05/06/07/12/15/16，NFR-04/06）；TECH_DESIGN §2、§4.3–6、§8.5–10.2；TEAM_WORK_PLAN §2/2.1、§7 DL-A/C/B；DL-0、DL-A 与 DL-B 当前实施及交接正文；C 的 DLA_C_CLOSEOUT_HANDOFF §15.9–18。#53 原宿主/初始化/静态入口及 #59 readiness 源码与专项测试已核。

## 2. 写集与方案

可写：#54 原有 `apps/teaching/contracts/tutoring/index.ts`、`server/tutoring/context.ts`、`core.ts`、HDL fixture/测试及模型测试 helper 的原 PR 增量；其两份原任务记录按原字节接收。#59 的 `server/app.ts`、`server/app/i0.ts`、readiness 测试、原任务/证据；#55 原交接任务、脚本、去敏证据按原字节接收；README 最小导航；本文与本次验证结果。

只读：AGENTS.md、docs/product/**、docs/planning/**、docs/reference/**、未指定 PR、UI 源码、数据库 schema、凭据、CI/CD、现场服务与执行节点。原任务/原始证据不得重写成此次执行结果。

方案：比较 PR 的 merge-base 增量与目标头，排除通过 main 历史带入的其他 PR；只接纳指定差异并保留出处。#54 复用既有 HDL DTO 和 B 上下文实现，兼容性适配仅解决原接口位置，不新增字段语义/权限。#59 的 readiness 按 #53 原正常宿主结构适配，保留原 HTTPS、bootstrap、worker/停止/数据库守卫。更新后 #55 与 #53 原历史若确无额外代码，采用保留双方历史的 Git merge。

禁止实质变更 A/B/C 核心、共享契约语义或权限边界；如出现此类缺口，记录差异交对应负责人确认，只继续不依赖该决定的工作。HDL 正常宿主授权构造/读取的既有缺口不在本批补开发。

## 3. 验收与状态

验收：三条接纳关系可追溯；无未解冲突/重复实现；固定 Node 24.21.0 与原 lock 的 typecheck/build；受影响 B tutoring、宿主/readiness、C 交接验证器的必要专项测试；文档/空白及受保护写集检查；普通推送回对应原 PR，保留其状态。

当前：方案和范围已记录，正在实施。测试与交付结果随后追加；P4/P5、真实模型、现场 HTTPS/执行节点、浏览器、真人与教学效果均不在此次验证范围。产品基线/MVP_SPEC §10：待授权维护者汇总。

## 4. #54 → #55 实际接纳

只提取 `git diff origin/main...origin/pr-integration-54` 的 9 个 HDL 代码/测试/原任务文件，排除 README 的过期状态行及 main 中 B3 等其他 PR 变更。保留 #54 的实现与最新修复语义，来源提交包括 `7283172`、`c47ae58`、`e3c192a`、`9b719bb`、`5d34ffe`、`b698480`，最终证据/勘误按 `c00b8ff` 接收；全部对应 PR 差异作为一个集成提交保留来源，不逐条机械 cherry-pick 历史合并。

三处文本冲突：contracts/tutoring import、real-model helper 开关、helper gate 测试，均因 #54 上游 B3 代码而起。仅保留 HDL 的类型/两组独立模型门禁，未引入 AnalysisBinding/ClaimBody 或 B3 probe/测试。context、HDL fixture/测试与两份原任务共 5 个文件的 Git blob 与 #54 完全一致；core 仅接纳 HDL policy 增量，保留目标原执行循环，不复制上游 B3 的分析/计费改动。#55 原 HTTPS/持久库/执行节点交接文件及所有历史证据不改。

Node 24.21.0/Linux/WSL2 原 lock 安装成功，typecheck/build 通过。默认 Windows Node 24.15.0 不满足精确运行时，未绕过检查；未安装新依赖或修改锁文件。全部 tutoring + 原 C 交接 verifier：156 项、150 通过、6 项真实模型门禁跳过、0 失败/取消；供应商请求 0。文档静态检查 69 份/1020 内链/0 错误（README 导航加入前），空白与冲突检查通过。追加 README 导航后的静态检查为 69 份/1021 内链/0 错误。

#55 交付方式：仅本批 11 文件（上述 9 文件、README 最小任务导航、本文）合成一个来源可追溯的提交；完成后普通推送原 `codex/c-entry-preparation-handoff`，不强推，遇远端推进先重新核差异。

验证过程的偏差：第一次“6 个源 blob 全一致”检查在 core 报错，原因是 #54 core 同时已有 main/B3 代码。后续对比确认这是有意保留目标原 core 的基线差异，HDL policy 增量一致；上述当前结论已纠正，不将失败检查记通过。C 原交接/证据对基线的差异为空。

## 5. #59 → #53 实际接纳

接纳 `964abb4277c2cf58e81d6686f6349b6ef0fa2e39` 的 app 健康入口、readiness 逻辑与原任务/去敏证据；未合并其父 main（包含其他 PR 的 B3/UI/tutoring host）。app.ts 的补丁原样适用，i0.ts 将相同判据映射到 #53 原 24 表/运行消费者；保留原初始化、HTTPS/static、bootstrap 权限、自动消费和取消/关停对账，不改配置/schema/凭据。

适配细节：沿原 guarded runner 校验当前指纹/代际，检查数据库短事务与首次成功扫描；5 秒 health 查询期限和外部等待后的关停/数据库/代际重核保持 #59 原行为。#53 未具备 tutoring 宿主选项，故不新增 teaching consumer/28 表配置；#59 的第 6 项“disabled model + teaching scan”测试不适用于此目标，未伪装为已运行/跳过；其余 7 项原测试按原字节接纳（仅排除该项）。未来 tutoring 宿主集成由原负责人另批处理。

Node24.21.0 typecheck/build 通过。首次复制依赖不完整导致缺 @typescript/typescript-linux-x64，已以原 #55 lock 安装所得 Linux 依赖补齐，未修改 lock/配置；失败与修复区分记录。专项验收将在三条关系组合后的最终 #53 上执行。

## 6. 更新后 #55 → #53

#55 已普通推送原分支至 `08445bc5765ef21b54a3253e60daad086475eee0`（实现 `3d7a03e`、验证记录补正 `08445bc`）；#53 的 readiness 接纳提交为 `2c5b37c`。确认 #55 在共同基线外只有原 C 交接及本次 HDL 增量后，对 #53 执行保留双方历史的 `git merge --no-ff 08445bc`，没有引入 #54/#59 的 main 历史。代码文件自动合并无冲突，仅 README 两条相邻导航和本文 add/add 冲突：保留 A/C 两条导航、任务记录并集；没有覆盖原 A 交接或重写 C 历史。最终组合 typecheck/build/专项与只读写集检查待执行。

## 7. 组合验证、失败与复验

最终组合的 Node24.21.0 typecheck/build 通过。首次联合专项共186项：179通过、6个真实模型门禁跳过、1失败；唯一失败为原宿主静态 real UI 测试在独立工作树缺少 `apps/student/dist`（ENOENT），未改业务代码或判据。按学生端原 lock 构建原 UI 后复验；本操作只是原静态宿主测试的构建前置，不扩展 UI 功能、不开展浏览器/P5。首次失败原日志保留于 [组合首轮](evidence/pr-integration-20261014/pr53-tests-first.tap)，#55 独立日志见 [PR55 专项](evidence/pr-integration-20261014/pr55-tests.tap)。

可复现命令（使用原 lock、Node24.21.0，所有真实模型门禁关闭）：

```sh
cd apps/teaching
npm ci
npm run typecheck
npm run build
node --test --test-reporter=tap server/app/i0-readiness.test.ts server/app/i0.test.ts tests/app.test.ts tests/errors.test.ts tests/startup.test.ts server/tutoring/test/*.test.ts ../../docs/tasks/evidence/dla-c-handoff/entry-verification.test.mjs
```

该命令的静态宿主前置：在 `apps/student` 用原 lock `npm ci && npm run build`。#55 专项命令为仓库根 `node --test --test-reporter=tap apps/teaching/server/tutoring/test/*.test.ts docs/tasks/evidence/dla-c-handoff/entry-verification.test.mjs`。

写集保留核查：#53 原头除明确接纳的8个已有文件外，752个原 Git blob 与原头完全一致；#55 相对共同基线的90个代码/任务/证据 blob 原样纳入 #53，README/本文合并。首次按整个 #55 基线检查因 config.ts 命中 #53 原正常宿主差异而拒绝，随后纠正检查范围为 #55 实际增量，90/90一致；未为迎合检查覆盖原 A 配置。受保护路径、UI 源码、依赖/锁文件、runner/records/workspace 与原 #53 差异为空。

### 7.1 最终通过与遗留边界

原 UI `npm ci`/`npm run build` 成功，未改 UI/锁文件；随后按上述完全相同的联合专项命令复验：**186 项、180 通过、6 项真实模型门禁跳过、0 失败/取消**。其中 #59 适用 readiness 7/7、#53 原宿主 10/10、C verifier 35/35，其余为原健康/错误/启动与 B tutoring 回归。模型门禁已关闭、供应商请求 0；没有跳过失败的静态宿主项。结果与原日志/hash见 [最终核验](evidence/pr-integration-20261014/verification.json) / [组合最终日志](evidence/pr-integration-20261014/pr53-tests-final.tap)。

三项指定关系处理完成，代码无未解冲突；没有复制队列、worker、bootstrap、权限或模型实现。任务未新增需负责人确认的业务/共享语义：#54 原 HDL 正常业务授权构造/读取、C3/浏览器真实消费，以及 #53 后续 tutoring host 等既有缺口均留原负责人/任务处理。#54 人工语义仍保留 HR-DL-02 有条件通过，不据离线测试恢复整批语义结论。当前提交可供 A/B/C 审核。

#53 交付：正常合并更新后的 #55，保留其完整 Git 历史；普通推送原 `codex/i0-a-c-handoff`，远端若推进则重新核差异、不强推。#53/#55 保持 Draft/Open，#54/#59 不改状态；不合并 main、不关闭原 PR/Issue、不部署。P4/P5/现场/模型/真人/教学均未执行，产品基线/MVP §10 待授权维护者汇总。

回滚交接：如负责人拒绝本批集成，按两个目标上的本次提交/merge 做新的 revert 审核；不 reset/强推、不删除原交接和失败证据。后续由负责人审核对应原 PR，本次任务到交付即停止。
