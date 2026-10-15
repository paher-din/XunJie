# I1 教师设计 AI：个人模型接线与独立预算（2026-10-15）

## 依据与授权

负责人在云端实测"AI 协助设计"三条路径均返回 `429 BUDGET_EXHAUSTED` 后，要求解决预算问题。已读本任务前序记录 [教师设计 AI 接口接入](I1_TEACHER_DESIGN_AI_UI_20261015.md)（尤其 §46–58 的接线提案）、TECH_DESIGN §9–10、PRD §4.1/4.3/5/8、MVP_SPEC M-01/02/07/08/10。

负责人本轮确认的决定（本记录据此实施）：

1. **额度**：每任务最多 **1** 次供应商请求、本轮最多 **3** 次、单次输入 ≤ 16000 token、输出 ≤ 4096 token；遇错**不自动重发**。
2. **获准范围**：仅当前演示教师 + C 程序设计两个班。
3. **授权范围**：授权实现代码侧接线与离线测试并开 PR；配置**默认关闭**；是否在云主机打开开关并承担真实调用费用由负责人/Robert 决定。

可写：`apps/teaching/server/app/{config,personal-models,digital-logic}.ts`、`server/design/teacher-agent.ts`、`server/main.ts`、`tools/i0-cloud/cloud-host.mjs`、新增测试与本记录。共享契约、产品/规划/参考/AGENTS、凭据与数据库只读。

## 实施

| 文件 | 改动 |
| --- | --- |
| `server/app/config.ts` | 新增 `teacherDesign` 段（`strictObject`，**全部字段必填**：`callsAuthorized: true`、`allowedTeacherIds`、`allowedCourseIds`、`maximumCallsPerRequest`（1–3）、`maximumCallsPerRound`、`maximumOutputTokens`（≤4096）、`roundStartsAt`）。缺任一批准值即解析失败，不会退化成"无上限可调用"。 |
| `server/design/teacher-agent.ts` | 新增**可选**钩子 `providerForTeacher` / `versionsForTeacher` / `budgetAvailableInTransaction`；存在时按教师解析并**在接纳时把个人模型版本写入 `StoredTeacherRequest.versions`**，派发与结果接纳都以该版本复核，因此换模型/停用配置会让旧请求 `stale` 而不是贴上新的配置。预算判定升级为可在调用方事务内查询（嵌套事务被禁止，故不能用回调自开事务）。原有静态 `provider`/`versions`/`budgetAvailable` 语义保持不变。 |
| `server/app/personal-models.ts` | 新增 `teacherDesignAgentOptions()`：复用现有 `personalModels` 服务与同一 `compatibleTransport`，把教师的个人模型选择接到 `providerForTeacher`/`versionsForTeacher`；`budgetAvailableInTransaction` 逐个校验"个人 callsEnabled → 获准教师/课程 → 每任务上限 → 存在有效 selection → 其输出上限不超过批准值 → 本轮账目未超限"。另新增 `teacherDesignRoundCalls()`：从既有 `teacher_design_requests`（按 `actor_id`/`course_id`）与 `jobs` 的 `acceptedAt` 统计本轮已预留/已消耗调用数，**不新增表、不建内存计数器**；`unknown` 预留计入消耗（已发未确认不返还额度）。 |
| `server/app/digital-logic.ts` | 仅当 `personalModels` 与 `teacherDesign` **同时**存在时，把上述钩子合并进教师 agent 选项；否则保持原样（fail-closed）。新增 `DigitalLogicApplicationOptions.teacherDesign`。 |
| `server/main.ts`、`tools/i0-cloud/cloud-host.mjs` | 把配置里的 `teacherDesign` 透传；云宿主新增守卫：配了 `teacherDesign` 却没有 `personalModels` 直接启动失败。云宿主原有的"必须关闭 `config.tutoring` 遗留模型调用"不变（本能力走个人模型存储，不经该路径）。 |

未改动：`personal-agent/*`（未新增服务方法）、任何共享字段/错误码/既有权限语义、`docs/product|planning|reference`、`AGENTS.md`。

## 验证

| 验证 | 结果 |
| --- | --- |
| `node node_modules/typescript/bin/tsc --noEmit`（apps/teaching） | 通过（exit 0） |
| 新增 `tests/teacher-design-budget.test.ts` | **4/4 通过**（闸门矩阵、轮次账目范围、版本绑定、派发前拒绝） |
| 既有 `tests/design-agent.test.ts`（默认关闭路径回归） | 26 项：**25 通过、0 失败、1 跳过**（跳过者为真实模型用例） |

新增测试覆盖：全批准时放行一次；未获准教师/课程、个人开关关闭、无 selection、输出上限超出批准值分别拒绝且**不产生调用**；每任务上限在已有一次未确认预留时也拒绝；轮次账目只统计本轮且缺少 job 归属的行不计入；`versionsForTeacher` 对无配置教师返回显式 `personal-unconfigured`；`providerForTeacher` 在版本变更时报 `stale`、无配置时报 `unavailable`，都不会退化为复用别的配置。

## 未执行与边界

- **未在云端或任何宿主打开该配置**，未发出任何真实供应商调用；演示额度与开关仍需负责人/Robert 决定后配置。真实价格/费用不能由 token 上限自行假设。
- **未覆盖**：经真实 DB 与完整 agent 流程的"本轮上限 3 次"端到端用例（当前轮次账目只由单元测试覆盖其范围语义）；`application-config.example.json` 的模板同步；README 使用说明同步。这几项建议在本 PR 评审后补齐或另开任务。
- 产品基线及 MVP_SPEC §10：待授权维护者汇总。

## 回滚

本改动默认关闭：不配置 `teacherDesign` 时行为与改动前一致（教师设计调用仍被拒绝）。撤回本分支提交即可完全恢复；不涉及数据库、迁移或凭据。
