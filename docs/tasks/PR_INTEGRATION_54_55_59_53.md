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

三处文本冲突：contracts/tutoring import、real-model helper 开关、helper gate 测试，均因 #54 上游 B3 代码而起。仅保留 HDL 的类型/两组独立模型门禁，未引入 AnalysisBinding/ClaimBody 或 B3 probe/测试。其余 6 个文件原 blob 完全一致。#55 原 HTTPS/持久库/执行节点交接文件及所有历史证据不改。

Node 24.21.0/Linux/WSL2 原 lock 安装成功，typecheck/build 通过。默认 Windows Node 24.15.0 不满足精确运行时，未绕过检查；未安装新依赖或修改锁文件。全部 tutoring + 原 C 交接 verifier：156 项、150 通过、6 项真实模型门禁跳过、0 失败/取消；供应商请求 0。文档静态检查 69 份/1020 内链/0 错误（README 导航加入前），空白与冲突检查通过。

#55 交付方式：仅本批 11 文件（上述 9 文件、README 最小任务导航、本文）合成一个来源可追溯的提交；完成后普通推送原 `codex/c-entry-preparation-handoff`，不强推，遇远端推进先重新核差异。
