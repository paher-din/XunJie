# WP07 #198 双轴审查

2026-11-06（Asia/Shanghai），基线 `e39462c9362172e9f853c69e0d1f2f0ebfa94612`，范围为 `wp07` 本票全部差异及未跟踪源码、测试和文档。Standards 与 Spec 由独立 Agent 执行；已确认发现由实现者修复，Spec 的停止边界再作定向复核。验收结果见[交付记录](wp07-198-agent-tools.md)。

## Standards

对照 `AGENTS.md`、`DESIGN.md`、根目录和模块 README、工程入口及文档索引；smell 作为判断项，不重复格式或类型检查已经覆盖的内容。

| 发现 | 处置与验证 |
| --- | --- |
| [P2，明确规范] Agent 浏览器执行的关联与 HTTP envelope 在前后端重复定义，未从公共 wire 契约消费 | 将 association、browser ID、命令、停止与接收消息归入 `@xunjie/contracts/execution`；Web、HTTP 入口、执行 owner 和原生通道共同消费。契约类型检查与现有契约测试通过。 |
| [P2，Duplicated Code 判断项] 浏览器桥新增了第二份接受、状态与结果回传循环，且同步互斥各自独立 | 删除桥内同步器，统一调用现有 controller 的 `syncPending()`；互斥在第一次异步读取前占位。既有 controller 测试和真实丢回执 Chrome 场景通过。 |

## Spec

对照 [#198](https://github.com/paher-din/XunJie/issues/198) 的固定依据、可靠工具意图、实际宿主、等待、停止、恢复和独立实验边界。

| 发现 | 处置与回归 |
| --- | --- |
| [P1] 原生命令的 outbox 已提交，入队前中断后，恢复查询没有原派发资格，永久报 `missing` | 可信 Agent 查询携带原 guard；睡眠恢复可按原关联重建既有许可。通道只查询已经入队的事实，普通查询或失效许可不能补发。真实 submit 和连续输入的中断恢复先 RED、后 GREEN。 |
| [P1] Wait 到期后停止核对，晚结果无法归档且永久占用组件 lane | 到期只暂停 Run 自动推进；pending／expired 均继续有界查询。真实 Wasm 晚结果唯一归档并消费 Wait，暂停／停止的 Run 不复活，确认终态后释放 lane。 |
| [P2] `execution_stop` 接受了停止请求就报告完成 | 显式停止工具只在原执行确认终态后完成；此前保留 accepted／unknown 与结果 Wait。真实子进程尚存活与实际退出两个阶段均有回归。 |
| [P1] 先前输入已完成，停止 Run 后，其仍在运行的原生会话没有持久清理跟踪 | 增加独立 cleanup Wait，保留原输入的 completed 事实和模型配对；Agent 重开后核对实际进程退出，清理资源与消费只归档一次。真实同节点独立学生会话继续保留。 |
| [P1] submit 入队前中断后再停止或撤权，stop 因找不到原通道记录而永久失败 | Agent 原能力已关闭、原执行仍为确认排队且通道尚未接受时，所属 owner 持久记录未派发取消，保留原 stop 身份。正常停止和撤权清理均有真实数据库回归，未启动替代进程。 |
| [P1] 单条 Agent 输入取消被当作连接撤权，误清理学生独立会话 | 领取时将单命令取消／教学 permit 丢失结算为 cancelled，取消控制的回执为 rejected；真实连接撤权仍走原有清理。真实同节点两个进程验证原 Agent stop 继续到达，学生仍能输入。 |

修复后的 Chrome 回归还核对了学生可见语义：取消计算显示“已取消”，不会因清理完成显示“已完成”；完成输入背后的会话能区分仍运行、正在停止和已停止。

原发现为 Standards 2 项（最高 P2）与 Spec 6 项（最高 P1），均已落实修复及回归。最后对独立清理 Wait、入队前停止和单命令取消的三项 P1 定向复核确认：三项均已解决，无剩余阻塞。

最终未处理发现：Standards 0 项，Spec 0 项。
