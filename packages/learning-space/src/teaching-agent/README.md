# 可恢复的学习对话

`teaching-agent` 是正式学习对话的 PostgreSQL owner。它消费 WP02 的可靠 `ActionReceiver`、WP06 的 `ModelGateway` 和活动 owner，保存请求回执、取消记录、Run、输入、session log、不可变快照与持久待发项；浏览器不直接创建原生 attempt，也不持有推进权。

## 数据与推进

| 表 | 事实 |
| --- | --- |
| `teaching_requests` | 固定输入摘要、接收/取消状态、原回执与 `runId/inputId` 关联 |
| `teaching_runs` | 状态、停止请求、`attempt_id/segment_id/model/usage`、DB 时间 lease、generation、`previous_run_id` |
| `teaching_events` | 活动级稳定 `seq` 的输入、上下文装配、派发、增量进度、答复、终态与系统说明 |
| `teaching_sessions` | 活动连续的 native segment、固定前缀指纹 |
| `teaching_snapshots` | 外发前的不可变装配正文、来源、模型参数、`payloadSha256` 与资源引用 |

接收、Run、输入与事件在同一事务提交；同身份同内容返回原回执，换内容冲突。接收前取消写入持久取消记录，迟到派发不能复活。`RunDriver` 用 `clock_timestamp()` 领取代际与 lease，条件提交保证单一推进权；lease 只决定推进权，不是生成期限。过期接管先按原 attempt 身份查询/续接，已接受未派发的 attempt 由新推进者继续派发，不第二次付费生成。

停止先持久标记 `stop_requested`，等待中的 Run 取消原调用；已经发生的结果按 `assistant` + 终态事件保存，未确认的外发保持 unknown 并暂停。失败或停止后，`continue` 建立关联后继 Run，原终态不复活。

## 上下文与模型

`context.ts` 分开平台指令、平台运行职责、课程规则、本次引用/作品/问题和跨 Run 历史。课程发布固定帮助策略；策略禁止问答时在接收前直接取消，不产生模型调用。历史按真实 `student/assistant` 角色进入段的可移植前缀；只有连接、前缀或配置变化时才封存旧段并建新段。

每次外发使用保存的 `contextWindow` / `maxOutputTokens`，不套用探针的次数、步数、输出或时间限制。容量事实以最终原生 payload 字符数、输出预留和配置窗口记录为 `counter:"unavailable"` 的不确定性事实，不换算成 token，也不据粗略估算缩小配置窗口；输入超过学习传输边界（前缀 400,000 字符、用户文本 1,000,000 字符）时保留完整输入并暂停，不截断作品或历史。

学习正文由 Gateway 在解析协议增量时经过凭据尾部扣留后写入 `model_attempt_progress`；`RunDriver` 只读取已持久化的安全前缀，按 attempt 稳定身份追加 `assistant-progress` 增量事件。`conversation` 把同一 attempt 的增量与最终答复合并为一条消息（稳定 `eventId`），客户端刷新不会重复显示。完整结果落定后不再发布增量；凭据出现在正文时停止公开，最终结果仍按 Gateway 的敏感输出规则处理。

## 公开接口

`learning-entry` 暴露 `agent/<activityId>/conversation|events|capabilities`、`agent/<activityId>/runs/<runId>`、`.../stop`、`.../continue`、`.../requests/<requestId>` 和 `.../snapshots/<snapshotId>`。查询按所属活动与主体授权；`conversation` 以最后返回事件的 `seq` 为游标，重复读取不增加模型调用。快照重建只读取保存的 payload、来源与摘要。

活动页面使用同一个 `ActivityConversation` 控制器轮询对话、显示 Run 状态并提供停止/继续；问题草稿和固定引用仍由可靠草稿 owner 保存。首页“建立并开始对话”把首问写入持久草稿后创建无课程活动，活动页以固定 `requestId` 发送并隔离切换活动后的迟到回复。

## 验证

- `apps/server/tests/teaching-agent.runtime.test.mjs`：真实 PostgreSQL、三协议 SDK transport、长上下文、课程策略、增量发布、重启/停止/继续、快照重建、备份/还原/接管。
- `apps/server/tests/teaching-agent.driver.runtime.test.mjs`：两个独立 `driverId` 竞争同一 Run，验证 lease/generation 单一派发。
- `apps/server/tests/model-progress.test.mjs`：增量发布的凭据尾部扣留与停止公开。
- `apps/web/e2e/teachingConversation.spec.ts`：正式入口首问、刷新、追加问题、生成期间草稿阻塞、停止、课程问答、进程重启和缺模型设置入口；macOS 与 Windows 桌面 Chrome 均执行。
