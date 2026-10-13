# I0-B-02：显式项目求助、停止与新求助替换

**What to build:** 学生明确发送项目问题，核对原 Job 状态并得到一次获准支持；可停止这次帮助或显式以新问题替换，停止后的迟到正文不出现，已显示历史保留，模型故障仍可保存作品。

**Blocked by:** [I0-B-01 消息与回执](I0-B-01_MESSAGES_RECEIPTS.md)。本批写集/测试接缝已按Robert委托定稿；真实接线需对应I0-A/正常宿主/B2-C3交接，准备路径不等新的供应商请求。

**Status:** prepared-verified / pending-real（显式项目求助、停止与替换准备链通过；真实服务未验）。

日期：2026-10-13（Asia/Shanghai）。主责：UI / Robert。父任务：[I0 #30](https://github.com/paher-din/XunJie/issues/30)。依据：[规格](I0-B_UI_TUTOR_SPEC.md)、[计划](I0-B_UI_TUTOR_PLAN.md)。覆盖 UI-TUTOR-01/06，M-04/M-05，AC-05/06/07/12/15、NFR-01/02/04/06 的前端责任。

## Acceptance criteria

- [ ] 页面读取、编辑、恢复和空历史不自动求助；学生可围绕项目发开放问题或合法 project ObjectRef，不强制代码/运行引用或完整计划。
- [ ] 发送前重读权威 Attempt、核固定活动政策/状态，冻结原 question/ObjectRef/revision/generation/幂等键并持久化；本机失败不发送，CSRF/凭据不落盘。
- [ ] 分别显示未发送、发送中、已受理、queued/running 与实际终态/失败，问题内容及接受返回 jobId/epoch/replacedJobIds 可核；没有公开排队位置时不编数字。
- [ ] 受理丢回执/断线只核或重发原键同正文，不拿新问题挂旧键，不换键补一个 Job；版本/代际拒绝保留原问题，重读后由学生明确新操作。
- [ ] 按原 Job、读轮次/上下文处理迟到状态和接受起截止；本地超时可说明等待已超限，不能自行写服务端 timed_out 或虚构 usage=0。
- [ ] 合法完整内容走01消息/回执链。缺 Action↔Job 公开关联时消息保持本尝试来源，不强绑最近问题；对象定位与完整归属仍按 D-01 阻塞，不能把项目准备链写成两类对象已通。
- [ ] 学生停止立即阻止本地旧在途展示，随后持久取消原 Job。处理取消回执 invalidatedActionIds 与 stopRequested/真实 Job 状态；Job 已 succeeded 时仍能停止未展示 Action，不等同普通运行取消。
- [ ] 已succeeded的教学Job停止后仍可保持succeeded；以持久stopRequested和invalidatedActionIds确认未展示内容已失效，不无限等待cancelled。在途或停止结果未知保持相应事实，不改写生成/已展示历史。
- [ ] 覆盖生成中、已生成未展示、停止丢 ACK、旧分页迟到、刷新/重连/另一标签和新代际；本地 abort 不冒充权威停止，停止未知不复活旧动作。
- [ ] 忙时明确发送新问题才替换旧帮助，按新 epoch/replacedJobIds 清理失效展示候选；本机输入可保留但不自动排队续发。停止后继续帮助由学生发新命令，不续旧 Action。
- [ ] 已显示的消息/回执不删除、不覆盖；后来失效有来源时标记依据变化，无法回取时明确缺项，不伪称学生从未见过。
- [ ] 采集暂停、提醒关闭的合成状态下显式求助仍可用；分配暂停、尝试暂停、限定检查、禁用帮助按服务拒绝。预算/模型/网络/超时故障保留问题与草稿，不阻断获准确认保存。
- [ ] 键盘可发送、停止、核对/新发；相关 typecheck/Vitest/build/浏览器正常与竞态检查有实际结果，无外部 provider 请求。

## Testing Decisions

以学生发送→原 help HTTP→公开 Job/事件→可见回答/停止结果为主接缝，同一准备 authority 按真实输入/回执形状推进。控制状态可由有来源合成场景预置，本票不等待06的开关组件；06随后负责实际开关设值行为。

采用01的延迟/丢 ACK与实际消息可见性反例，补新版求助替换旧响应、模型失败后保存和新键仅在明确新操作时出现。不得把演示自动队列/继续/覆盖重试带入新链。

## 交付与未完成

拟写集为批次计划02；原运行取消的冻结/摘要语义保留，教学取消按自己的 wire/回执实现。当前前置票、真实宿主接线及本票实现/应用验证均未执行。实现记录分别报告准备、真实服务、实际模型、真人，父卡不关闭。

## 2026-10-13 主整合结果

上述为规划交付时点。随后实施复用01状态机、[冻结/回执核验](../../apps/student/src/workspace/tutoringCommand.ts)及[8秒有界连接等待](../../apps/student/src/workspace/tutoringTransport.ts)。问题、原正文/键先保留到原metadata命名空间，再发help或教学cancel；权威Attempt重读、scope/generation/摘要/acceptedInputHash核验，失败保留原问题，页面读/编辑不自动求助。

[停止/替换专项](../../apps/student/e2e/tutoringHelpStop.spec.ts)3项通过：显式新键替换与原取消丢ACK核对、非法正文/模型失败不阻断保存、替换help迟到ACK跨明确停止不释放屏障。01另验证已succeeded停止未展示、真实displayed在received排队中发生后仍保留、新暂停挡旧页。停止代次持久化，较早help不能解除后来的屏障，已展示历史保留；不以浏览器abort/本机等待截止当远端终态。

06实际关闭采集/提醒后仍能明确求助的组合通过，规则与正式build/typecheck见[批次实际结果](I0-B_UI_TUTOR_PLAN.md#92-验证失败修复与证据分层)。预算/限定检查/各种超时的完整真实服务条件、真实宿主/模型/真人仍未验；D-01不猜Action到最近问题。完整票AC未全部通过，父卡不关闭，基线汇总待授权维护者。
