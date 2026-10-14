# B4：P4 C/HDL 核心引导与模型故障降级验证

日期：2026-10-14（Asia/Shanghai）。任务编号：B4 / Issue #62。主责：B。

状态：**本任务有权完成的本地实现、证据复核和验证已完成，可提交 PR；实际课程审阅签字与 Issue 关闭仍由负责人处理。PAHER 部署及任何远程操作不在本任务权限内。**

## 1. 依据、基线与写集

最终集成基线为 `main@8b4130374289b71d737abe12ed4fc5e58adf55c5`。开工与本次基线更新均从 [README](../../README.md) 进入，并按顺序阅读 [PRD](../product/PRD.md) §1、§3～5、§8～9，[MVP_SPEC](../product/MVP_SPEC.md) §1.4、§6～8，[TECH_DESIGN](../product/TECH_DESIGN.md) §6.2、§8.5、§11～12；适用 M-03～05、AC-04/05/07/12/15/16、DL-AC-04/08/09、NFR-02/06。任务入口为 [P4 核心验证安排](P4_DEADLINE_CORE_VERIFICATION.md) 的 B4-CORE-01～03。

最新 `main` 已包含：

- PR #64/#66/#67 的真实登录、Session、确认保存、快照/版本冲突、C 运行历史与既有真实 C1 证据；
- PR #56 后续合入的正式 H4 链：显式 `hdlSelection`、同事务冻结 `HdlHelpBasis`、Build/Session/Operation 精确读取、调用前后及 Delivery/Receipt 当前性复核；
- 目标 Linux 环境的真实 HDL Build、持续 Session、四值信号、有限 trace、确认停止，以及一轮真实 DeepSeek → C3 接纳/投递证据。

因此本分支不重复实现旧的“自动选择最新 Session”接缝，不修改正式 HDL 读取、公共 DTO、schema、状态码或 UI。最终写集仅为：

- `apps/student/e2e/sessionHost.ts`；
- `apps/student/e2e/tutoringFailureService.spec.ts`；
- `apps/teaching/server/app/i0-browser-fixture.ts`；
- 本任务记录。

`docs/product/**`、`docs/planning/**`、`docs/reference/**`、`AGENTS.md` 保持只读；产品基线及 MVP_SPEC §10 为“待授权维护者汇总”。`.trae/` 不纳入提交。

## 2. 权限边界与纠正

本任务对 PAHER 的部署、SSH/TLS 连接、远程上传、服务启停、配置或密钥读取、真实 C1/C5 命令、数据库及远程数据变更均**无权限**。本轮只读取仓库内已经合入、已经去敏的证据，不连接或改变 PAHER。

此前远程分支提交 `837bc54` 错误声称“PAHER 部署已获授权”。负责人于 2026-10-14 在本会话明确要求“考虑撤回这次错误提交，并做出正确修改，一定不能出现越界行为”；授权对象和范围仅为 fork `scy404/XunJie` 的 `codex/b4-p4-core-verification` 分支，目的是移除该错误提交及其配套 revert，不涉及上游 `paher-din/XunJie`、其他分支或任何 PAHER 操作。整理后的本地分支据此移除错误文字；错误提交所述的一次 SSH `whoami` 前置连接尝试仍完整保留为历史事实：其在认证前超时，没有认证、命令执行、上传、部署、服务启停、秘密读取、数据写入或供应商请求。该尝试本身仍属于不应发起的越界步骤，本记录不以“无远程影响”掩盖它；后续不得重复。

若 fork 上同名远程分支尚指向旧历史，提交者可在上述明确授权范围内、先核对远端 head 后使用 `git push --force-with-lease` 更新该单一分支；lease 仅防并发覆盖，不构成独立授权。本任务不推送、不创建 PR、不发布评论。

## 3. 证据复用审计

| 来源 | 结论 | 可用于 B4 的范围 |
| --- | --- | --- |
| PR #67 / I0-UI55 | 有条件复用 | 固定源 `9fa76ad` 的真实 HTTPS、C1 Run/Stop/历史投影及 Run/Job/Snapshot/profile/generation/result hash 一致性；不冒充当前 main 已部署 |
| [P2 模型语义记录](B_P2_MODEL_SEMANTIC_VERIFICATION.md) | 有条件复用 | 历史真实 C 模型输出可在当前 schema/policy 下复核；不写成本轮新调用或当前现场同场证据 |
| [DL-A 续作](DLA_CONTINUATION_20261014.md) §6～8 | 可复用 | 真实目标 Linux HDL 构建、持续 Session、四值信号、有限 trace、停止与一轮 DeepSeek/C3 链；证据绑定 Node 24.21.0、Icarus 12、BoardProfile/Mapping、镜像、sourceHash、generation 和对象 hash |
| `real-hdl-model.json` | 可复用 | 1 次 `deepseek-flash` 请求，实际 usage 2615/388 tokens，回答绑定失败 Build 与确认快照，C3 delivery/received 成功；属于合成学生工程验收，不是教学效果 |
| `real-hdl-final-frozen.json` | 可复用 | 最终冻结守卫版本的错误/修正 Build、持续 Session、两次 Operation、有限 trace、确认停止；额外模型请求 0 |
| HR-DL-03-R1 | 可复用 | 仅固定 X/Z 场景的既有人工“通过”结论 |
| HR-DL-02 | 条件保留 | 仍为“有条件通过”；原模型正文、bit1/bit0 与未观察到 reset 转换的勘误不得改写，也不用于整批无条件结论 |

仓库证据能够证明目标运行配置、真实执行事实和当前 H4 接缝；它不授予本任务重新进入 PAHER 的权限，也不替代 C5 对其 Issue 全部范围的正式收口。

## 4. 本分支新增验证

本分支只补 B4-CORE-03 在实际学生应用上的最小组合缺口：

1. 隔离测试宿主用锁定 Playwright 运行时生成临时自签证书，经私有 stdin 传入；不写证书文件、不修改系统或浏览器信任。
2. 学生经实际 HTTPS、SQLite、登录、Session 与 CSRF 进入已交付 UI，确认保存并冻结 v1。
3. 通过现有 C 运行链产生一个已确认结果，再把隔离合成 provider 切换为 `unavailable`。
4. 断言辅导 Job 进入 `failed`、教学 action 为 0，同时原 C 结果仍可读取。
5. 学生继续编辑并确认保存 v2，随后以固定 v1 snapshotId 回读原快照，并核对 snapshotId、manifest hash、文件清单与 `sample.txt` 原文仍为 v1。

故障开关只存在于隔离测试 IPC，不进入正常应用配置。测试没有代替学生执行真实学习活动，也没有写入真实学习记录。

## 5. CORE-01～03 结论

| 核心项 | 当前结论 | 边界 |
| --- | --- | --- |
| B4-CORE-01 C 代表性求助 | **工程证据具备**：确认快照、C1 Run/diagnostics、版本/hash 与历史真实模型回答均可追溯；当前 prompt/schema/policy 及帮助边界由回归覆盖 | 实际 C 场景的运行与模型输出来自分层历史证据，不冒充本轮同场调用；正式课程审阅仍由负责人填写 |
| B4-CORE-02 HDL 代表性求助 | **核心工程证据具备**：最新 main 已有真实 Build/Session/Operation/trace、显式授权冻结、1 次真实 DeepSeek、C3 投递及调用后/投递/回执过时守卫 | 真实模型场景为构建诊断求助；HR-DL-02 仍有条件，不推导全批语义或教学效果 |
| B4-CORE-03 模型故障降级 | **通过本任务核心范围**：既有 unavailable/timeout/取消/停止/三次与 45 秒守卫，加上本分支浏览器组合，证明失败不伪造回答且不阻止结果读取、编辑、保存和快照读取 | 未重跑完整故障矩阵、负载、备份恢复、真人流程；这些是 P4/P5 后续而非本次核心截止范围 |

按 [P4 核心验证安排](P4_DEADLINE_CORE_VERIFICATION.md) 的分层口径，可以报告“B4 本次核心工程范围完成并可进入审阅”；不能报告正式 P4、全部 AC/NFR、完整浏览器链、真人试点或教学效果完成。

## 6. 角色模拟预审

负责人允许本任务从学生和课程负责人视角检查效果。依据工作空间规范，这里只登记为 **Agent 角色模拟预审**，不冒充真实学生行为或实际课程负责人签字。

- C 代表场景：回答若只引用确认快照和可信诊断，给出一个由学生自行执行的核查步骤，不代写、不代运行、不作正式评价，则学生视角可继续行动，课程负责人视角可判本固定场景通过；历史证据仍须保持其原版本来源。
- 最新真实 HDL 构建诊断场景：模型把注意力限定在第 5 行赋值语句完整性，要求学生自行定位、修正并重构建；引用命中确认源码与失败 Build，未给完整代码、未代运行、未作正式评价。学生视角“可执行且保留自主修改”，课程负责人模拟结论为“该固定场景通过”。
- HR-DL-02 原模型正文：学生会被“最低位变化”和“复位后”的错误描述误导；课程负责人模拟结论仍为“不通过原正文”。结合后置勘误的历史包继续维持“有条件通过”，不被上述新场景覆盖。

## 7. 验证记录

最终验证在基于 `main@8b41303` 的分支 head 上执行并于交付前更新：

| 范围 | 结果 |
| --- | --- |
| 教学服务类型检查与构建 | Node 24.21.0；`tsc --noEmit` 与 `tsc -p tsconfig.build.json` 均通过 |
| 正式 H4 / tutoring / workspace HDL 聚焦回归 | 61 项：56 通过、0 失败、5 个真实模型门禁跳过 |
| 学生端类型检查与构建 | 均通过；保留既有大 chunk 警告。首次沙箱内构建因 Vite `realpath` 得到 `EPERM`，在获准本机环境按原命令复跑通过 |
| `tutoringFailureService.spec.ts` | Chromium 1/1 通过；实际 HTTPS/SQLite/Login/Session/CSRF/C 结果/模型失败/继续保存组合，且 v2 保存后固定回读 v1 snapshotId/hash/files/原文；PAHER 请求 0 |
| `tutoringService.spec.ts` | Chromium 1/1 通过；已改用同一隔离宿主启动入口，验证正常模型投递、展示回执与历史回取未因证书输入变更回归 |
| `node tools/a0-review/check.mjs` 与 checker 自测 | 106 份文档、1708 条内部链接、0 错误；checker 16/16 通过 |
| `git diff --check` | 通过 |

本轮新增外部模型请求数为 **0**；不读取或搜索 API key。复用证据中的一次真实调用明确属于已合入的 DL-A 批次，不重复计为本轮调用。

## 8. 交付与剩余事项

本地实现、最新 main 集成、证据复核、角色模拟预审和必要回归完成后，本任务即可提交独立 PR，关联 Issue #62。PR 应说明：

- 仅新增 CORE-03 的隔离浏览器组合测试和本任务证据审计；正式 H4 实现来自最新 main，不在本 PR 重复提交；
- CORE-01～03 的工程核心证据已具备，HR-DL-02 仍有条件；
- PAHER 全部操作无权限且本轮未执行；错误授权提交已从整理后历史移除；
- 实际课程审阅签字、Issue 是否关闭、完整 P4/P5/AC/NFR/真人与教学效果由负责人决定。

本任务不创建 PR、不推送、不发布 Issue/PR 评论。上述外部动作由提交者完成。
