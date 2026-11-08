# #216 Standards / Spec 双轴审查

基线 `cb104e33604cbfcb8c5c4f294dd5c745e723834c`，初审候选 `8cdd22bf`。审查使用 code-review skill 的两个独立 subagents；没有使用 codex security。

## Standards

初审发现 1 项 hard violation、0 项 judgement：给旧贡献新增 `purpose/resultSchema` 后比较完整摘要，会把基线已保存且执行定义未变的旧绑定拒绝，违反未结记录升级兼容要求。

已补生产入口负例，先复现 `not-dispatched`，再仅对旧绑定未包含的描述字段做兼容；输入 schema、来源/版本、效果、资源范围与 executor 仍完整匹配，不改写旧快照。

## Spec

初审发现 3 项缺口，无 scope creep：

1. 派生范围读取只检查直接目标，可能借另一个 reader Command 绕过原来源撤权。改为沿原 Command 参数逐层复核授权链，不信任结果正文指定来源。
2. 目录实际读取发生在准备阶段，早于预算与串行许可。先复现一次剩余额度触发 9 次读取；改为准备仅冻结输入，实际目录读取在原派发许可内进行。
3. 同一步多个加载未统计尚未配对但已经完成的前项，可从 24 项加载到 40 项。先复现 40 项，再共享计入当前步骤已结加载；装配仍只在配对完成后采用。

另在自检中补充 SHA 版本选择与完整资源维护：接受、完成和清理事实可追加新结果，范围读取应定位原事件资源，不能按 Command 的 latest 结果替换旧字节。维护格式 2 收集历史结果资源，格式 1 继续按其原闭包核验。

## 最终增量

`2342fa3f` 首轮复审确认初审四项修复；Standards 无剩余 hard/judgement。Spec 又发现停止清理历史未完整进入版本索引：`95f0a9eb` 在同一事务登记原步骤、原调用、资源身份与实际持久化的完整 outcome。真实 native 负例先在缺 `stepId` 处失败，修复后原清理案例通过；native 恢复全文件 23/23、维护恢复全文件 5/5。

第二次 Spec 复审确认版本索引与维护闭包闭合，另发现后续模型上下文仍沿用启动时 `sessionOngoing:true`。`b6a0b40` 保留原操作反馈，单独记录实际 cleanup state 与有限布尔事实；未知值保留 null，兼容旧 stop-only 事件。换段携带该事实，同一模型段再提问也沿原用户输入/容量检查传递，不新增 transport 或运行循环。

实际后续请求负例确认 0 条终态清理事实（应为两条），[目标红日志](runtime-cleanup-context-red.log) 保留。新断言检查真实 native SDK payload 中两个原命令各自的终态清理事实，不能由旧反馈里的字符串误通过。

最终 Spec 又核对旧 stop-only 事件：其 outcome.state 仅证明清理状态，不证明原操作失败。最终兼容修正把该分支 operationState 保留 null；新完整事件仍保留真实原操作状态。

## 最终结论

- Standards：初审 1 项 hard 已修复；最终复审剩余 hard 0、judgement 0。
- Spec：初审 3 项及后续 3 项 P2 均闭合；最终复审无剩余已识别缺口、无 scope creep。
- 工程：`b6a0b40` 完整门禁通过；native 恢复 23/23，清理上下文 1/1；最后旧分支 null 修正通过全项目 typecheck/build 和现成 native 清理上下文 1/1。最后这一标量兼容修正未重复整套广门禁；旧 stop-only 分支由源码审查确认，未单独伪造运行结果。

[工程汇总](engineering.json) 固定各次验证候选、实际范围及原始日志。审查员仅只读源代码，测试结论来自对应真实执行记录。
