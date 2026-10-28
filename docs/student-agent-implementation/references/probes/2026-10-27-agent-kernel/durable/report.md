# Pi durable 最小真实接入探针

2026-10-27；服务总体架构议题，非生产代码或选型定论。使用 npm 发布包 `@earendil-works/pi-durable@1.4.0` 的公开 Harness、SQLite storage、Models/Provider、ToolTask hooks 和自定义 Task；模型是共享 fixture 驱动的确定性 Provider，不连接模型端点。没有实现或假定生产 ModelGateway。代码与逐项断言见 [probe.mjs](probe.mjs)、[wait.mjs](wait.mjs)，精简结果见 [results.json](results.json)。

## 结论与先前决策

此接入显示 durable 的 checkpoint、调度和恢复有可实证收益：工具执行中杀进程后，unsafe 不盲重放、safe 会恢复；自定义任务可以持久休眠并由新进程继续。收益必须与 Provider 投影、原件事务边界、业务回执查询、执行点授权、预算和单写者协调一起计价；尚无证据据此宣布整体优于自有 driver 或 core。

此前[内核判断](../../../2026-10-18-architecture-checks.md#内核取舍的工程判断)的自研建议并无各候选接入原型，且本来要求队列/恢复复杂时重新比较；[ADR 0002](../../../../adr/0002-own-teaching-state-and-effect-control.md)将教学事实和执行控制由循阶掌握与内核选择分开。直接 SDK 加薄 adapter 已在[模型调用层决议](../../../2026-10-23-model-endpoint-assessment.md#从目标推导模型调用层)选定，完整内核仍未定。原生签名和前缀不能任意重写；换路线在结清工具的步骤边界开启新的续接段。本探针未重复端点测试，也不证明跨路线迁移。本次新增的是以下真实发布包运行证据；此前调查的源码判断见[内核复用研究](../../../2026-10-27-agent-kernel-reuse-research.md)。

## 结果与归属

| 场景 | 上游实测 | 探针/宿主补充 | 限制 |
| --- | --- | --- | --- |
| Chat、Responses、Messages 原件与工具 | 真实 Provider → `Harness` → `ToolTask`，三种 fixture 均执行并结束；错误终态携带工具意图时未执行 | Provider 在发布完整投影终态前写入完整 fixture，工具读取并比较；保留 opaque/signature 字段；观察到保存先于执行 | 这是独立文件写入与 Pi SQLite 的双写，未 fsync、未原子提交，也未测写入失败或断电；并非生产持久屏障。投影仅包含工具调用，未测实际协议流、分片及真实 SDK |
| unsafe 执行后崩溃 | 工具写入模拟接收回执后 `SIGKILL`；新进程恢复同一提交，未重跑该工具，产生 `interrupted` 错误并继续下一模型步骤；第一次模型调用未重复 | 宿主单独按 `command-1` 读取本地模拟回执，核对只有一次模拟效果；原件在重启后仍与 Responses fixture 相同 | 上游没有自动查询业务回执；此查询未接入恢复流程，也未替换模型看到的 interrupted。未证明外部系统 exactly-once 或丢回执网络场景 |
| safe 撤权后恢复 | 真正杀进程后新进程重新进入 `execute`，`beforeTool` 只调用一次 | 第二进程前撤权，执行体再次检查并拒绝；模拟效果只有一次 | 初次模拟效果已发生；不是证明撤权可撤销效果。正式执行器须检查权限、对象版本及幂等身份 |
| 持久等待 | 自定义 Task 提交 `sleeping` checkpoint，进程正常关闭；不同 PID 打开 SQLite，在宿主推进时钟后恢复至下一 phase 并取得结果 | 宿主负责回执文件、虚拟时钟和启动/唤醒；恢复 phase 主动读取文件 | 测得的是 sleep/poll 形式，并非真实外部事件自动唤醒或长运行工具 Promise 可持久化；无负载和并发验收 |
| 取消及晚回执 | 休眠 task 在第二进程被 `root.abort()` 结算为 aborted；写入晚回执后第三进程恢复仍为 aborted，未进入投递 phase | 宿主提供模拟晚回执与唤醒 | 仅验证此自定义任务的取消路径，不代表已发送外部命令被撤销，也未测后台任务、竞态与真实消息投递 |
| 预算 | `pi.usage` 和重试配置为上游提供的记录/策略；所查设置没有找到总运行预算硬上限 | fixture Provider 在第二次调用入口返回宿主预算拒绝，提交以 `model_error` 结束 | 这只展示宿主可拦截，未实现持久预留、结算、跨重试/压缩/工具费用或并发预算。不能把统计用量等同硬上限 |

上游关于[持久任务、工具 replay 与单进程存储所有权的说明](https://github.com/earendil-works/pi/blob/6c384aa30f619d7b28963f2bab24d8dacbe73cb6/packages/durable/README.md)和 [ToolTask 实现](https://github.com/earendil-works/pi/blob/6c384aa30f619d7b28963f2bab24d8dacbe73cb6/packages/durable/src/harness/tool.ts)是固定源码参考；本次执行的是 npm 1.4.0 包，未核验发布包与该 commit 字节完全一致。Provider 入口参见[固定 Models 源码](https://github.com/earendil-works/pi/blob/6c384aa30f619d7b28963f2bab24d8dacbe73cb6/packages/ai/src/models.ts)。

## 最小维护职责

宿主需要维护：原生响应及 route/attempt 和 Pi 投影的可恢复关联与提交屏障；课程版本、授权及不可变输入在实际执行处校验；稳定 commandId、接收回执与 unknown 查询；等待/唤醒和取消后的回执处理；跨模型、工具、重试与等待的持久预算；SQLite 单写者协调和上游版本升级/迁移。探针的文件和固定命令身份只是可观察替身，不能直接作为这些生产机制。

## 复现与异常

实际环境 macOS，Node `v24.18.0`；工程目标 `24.21.0` 未验收。npm 安装使用系统 Node 26，探针运行使用本机 Node 24.18。发布包解析为 durable、pi-ai、chord 均 `1.4.0`，typebox `1.3.27`。npm 输出 `node-domexception@1.0.0` deprecated 警告；未阻碍探针。首次等待结果断言误读返回结构，将已完成/已取消误判为 false；修正断言路径后以全新数据目录重跑，最终全部断言通过。unsafe/safe 首进程 `SIGKILL` 是有意故障注入。

在仓库根目录执行，使用全新临时目录（Node 24 路径按本机调整）：

```sh
probe_tmp=$(mktemp -d)
npm install --prefix "$probe_tmp" --ignore-scripts --no-audit --no-fund @earendil-works/pi-durable@1.4.0
PROBE_DEPS="$probe_tmp" PROBE_RUN="$probe_tmp/run" /opt/homebrew/opt/node@24/bin/node docs/student-agent-implementation/references/probes/2026-10-27-agent-kernel/durable/probe.mjs
PROBE_DEPS="$probe_tmp" PROBE_RUN="$probe_tmp/run" /opt/homebrew/opt/node@24/bin/node docs/student-agent-implementation/references/probes/2026-10-27-agent-kernel/durable/wait.mjs
rm -rf "$probe_tmp"
```

脚本遇到断言失败返回非零；不得复用旧运行目录。仅做本探针工程运行；未做项目全量测试、浏览器验收、教学效果、性能、跨平台或真实模型/真实外部工具验收。原件提交前 crash、磁盘故障、未完成流、回执查询与上游恢复的完整集成，以及多进程争用均未实测。
