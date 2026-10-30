# 个人模型调用预算

`app/personal-models.ts` 为每个业务进程创建一个 `ModelBudget` 和一个 compatible transport，供个人对话、学生帮助、教师设计及模型目录连接测试共用。预算只依赖业务身份和现有产品授权，不依赖开发接入服务、OSS 或 xj-dev。

初始候选限额：同时最多 **2 个操作、每成员 1 个**；最多 **20 个等待操作、120 秒等待、32 MiB 等待 payload 总量**。这些值是 #140 的工程边界，须由 #133 的真实端点互操作、五人 900 秒混合负载与内存峰值结果调整，当前不能视为容量验收通过。

名额保守地覆盖一次生成操作（包含原有、顺序执行的有限修复调用），不会在修复调用之间重新排队。扫描最早可运行的等待项，跳过仍占用名额的成员，保留同成员 FIFO。计数与字节上限中任一不足都拒绝新增等待；不截断内容、不自动重试。

等待 payload 按已有内容校验后的 UTF-8 JSON 字节计费：个人对话包括构造后的完整 messages（含历史、恢复 prefix 和图片 data URL）及原请求；学生帮助包括已授权上下文，教师设计包括原请求及引用材料。字节额度覆盖等待内容的序列化大小，不代表 V8 堆、SQLite 页缓存或活跃调用的总内存上限。活跃内容仍受现有请求、图片和模型上下文限额约束。

等待时个人对话保持 `phase: waiting`，教学 Job 保持 `queued`、`attemptCount: 0`，不提前写付费调用预记或启动 provider inactivity。取得名额后重新检查现有 Session/成员权限、恢复代次、业务版本和已选择模型版本；使用现有 CAS、幂等键和产品读接口。模型配置变更会使旧请求失效，不会静默改用新模型。教师的预算等待时间从原有 45 秒执行窗口排除；学生个人模型的网络空闲窗口在取得名额后开始。未接入该可选预算的原教学入口保留既有执行语义。

队列保存成员标识、payload 字节数、取消与执行状态，不保存解密的凭据。设置和模型版本预检只读取 metadata；服务器保存的 provider key 在取得名额后才解密。个人对话沿用已接受的模型版本，教学入口沿用已接受的个人模型绑定。日志和预算 `status()` 不包含 credential、请求正文或成员列表；`status()` 是进程内验证接口，没有新增 HTTP 管理端点。

取消等待立即移除并返还等待字节额度。取消已经发送的调用可立即反馈 stopped/cancelled，但名额和该成员占用一直保留到实际 transport/provider Promise settle。`close()` 拒绝等待、abort 已获准操作，并等待真实上游收尾；忽略 abort 且永不 settle 的 transport 会持续占用名额并阻止正常关闭，不能用超时强行释放而允许第三项连接。已发送但结果未知的请求仍记入原调用账本；重启只标记原中断，不恢复发送。

学生/教师教学执行层在取消或执行超时后，复用 `CALL_VERDICT_WINDOW_MS`（250 ms）短暂等待原调用的未发送确认。只有 provider 明确报告未发送且原预记已成功释放，返回的调用数才减少；确认缺失、超过窗口或预记释放失败均保留调用数和 unknown usage。窗口届满本身不构成退回调用或释放并发名额的证据。

| 结果 | 现有接口上的区别 |
| --- | --- |
| `MODEL_QUEUE_FULL` | 等待数或 payload 字节上限不足；尚未发送、calls 为 0 |
| `MODEL_QUEUE_TIMEOUT` | 等待超过 120 秒；尚未发送、calls 为 0 |
| `MODEL_QUEUE_CANCELLED` / `MODEL_QUEUE_CLOSED` | 等待取消或预算关闭；尚未发送 |
| `PROVIDER_IDLE_TIMEOUT` | 个人对话已进入 provider 阶段后的网络空闲超时 |
| `DEADLINE_EXCEEDED` / 教学 `deadline` | 教学执行窗口或 provider 阶段超时，沿用原教学结果 |

个人对话通过原 turn 的 `message.failure.code` 读取原因；教师通过原 Job 的 `failure` 读取队列失败；学生帮助通过原 Job/执行结果读取。模型目录测试沿用原测试结果，队列失败为 `ok: false, kind: unavailable` 并带上述队列 `code`。以上均不把排队超时标成 provider timeout。

回归使用实际生产组合、Session/CSRF、原 Job 账本和可控 transport，无真实 provider 费用。测试包括三成员争用、跨入口成员预算、幂等、队首绕过、等待数/字节/时间边界、授权/版本重检、取消与关闭、忽略 abort 的实际收尾及未发送预记回退。

从仓库根完成 `npm ci` 和 `npm run build` 后，在 `apps/server` 使用工程要求的 Node 24.21.0：

```sh
npm run typecheck
npm run build
node --test server/personal-agent/*.test.ts server/app/model-budget.test.ts server/app/personal-models.test.ts tests/teacher-design-budget.test.ts tests/design-agent.test.ts
npm test
```

真实 provider、浏览器互操作、五人负载及教学效果不由这些可控测试代替。
