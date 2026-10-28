# 自有最小 driver 与 Pi core 接入探针

日期：2026-10-27。代码：[probe.mjs](probe.mjs)；完整精简结果：[results.json](results.json)。用于架构判断，不是生产运行时。实际使用 `@earendil-works/pi-agent-core@1.4.0` 和 `@earendil-works/pi-ai@1.4.0`；运行环境 macOS arm64、Node `24.18.0`。工程目标 Node `24.21.0` 未验收。

## 结果

两种模式分别执行 3 种原件 fixture × 11 种情形，共 66 个组合；另执行 Pi 的恢复入口限制、异步提交屏障和独立 Agent 取消 3 项检查，69 项均符合断言。真实模型请求为 0。它们复用同一 scratch SQLite 记录与模拟执行器，不能把相同宿主机制在两种模式下通过理解成两份独立持久化实现。

| 情形 | 实际结果 | 能力归属 |
| --- | --- | --- |
| 普通两步工具往返 | 两次模型替身调用、一次模拟效果；三协议原件序列化后相同 | Pi 提供循环、工具分派和事件；自有模式显式推进；原件保存和投影是共同的宿主代码 |
| 参数已出现但终态失败 | 没有工具效果 | 模型替身把失败映射为 `error`；Pi 不分派失败步骤工具。没有实测真实协议的缺失终态检测 |
| 原件提交失败 | 两种模式均停止且没有工具效果，原件没有被记录为已提交 | Pi `Agent.subscribe()` 的异常能阻止后续派发；宿主仍负责提交与记录失败 |
| 响应未完整提交时退出 | 新进程保留 `model_outcome_unknown`，模型尝试次数仍为 1 | 宿主显式状态与恢复规则；未验证提供商结果查询或实际计费 |
| 完整响应已保存、工具尚未执行时退出 | 新进程使用旧工具意图执行一次，再进行第二模型步骤 | 自有恢复机负责。裸 Pi `continue()` 实测拒绝以 assistant 消息结尾的历史；包装器先恢复工具并补入结果后才能继续 |
| 执行器已接收、调用方尚无回执时退出 | 查询原命令，效果仍为一次，第一模型步骤没有重做 | 共同的稳定命令身份、独立执行器记录与查询逻辑；并非 Pi core 自带幂等 |
| 外部工具等待 | 第一个进程持久退出，补入结果后由新进程继续 | 自有模式返回 waiting；Pi 包装器持久记录 waiting、用 `finishTurn` 结束，把未发送给模型的 pending 投影留在内存，恢复时补最终工具结果 |
| 等待中取消、随后到达结果 | 保留 cancelled，不新增模型尝试；外部已发生结果不被声称撤销 | 宿主持久取消标记；不使用仅在内存的 abort signal 替代它 |
| 第二次调用前预算不足 | 实际模型替身尝试数为 1 | 宿主入口检查；不是持久金额账本、并发预留或真实费用结算 |
| 响应保存后重启前撤权或对象版本变化 | 恢复时拒绝效果，仍可用拒绝结果完成后续回答 | 实际执行器的权限与对象条件核对 |
| 异步提交屏障 | `Agent.subscribe()` 等待 Promise 时工具次数为 0，解除屏障后为 1 | Pi 真实 awaited listener 行为；验证的是 `Agent`，不是低层事件流消费者 |
| 单个 Agent 取消 | 被取消实例为 aborted，另一个实例正常结束 | Pi 将独立实例的 signal 传给模型替身；底层调用必须响应 signal，不能推断远端费用停止 |

进程中断使用 child 的 `process.exit(73)`，重新启动不同进程读取 SQLite；不是断电、磁盘损坏或共享存储多写者测试。SQLite 使用 WAL 和 FULL，单条运行记录更新原子包含原件、投影与待处理命令；模拟执行器使用独立数据库制造接收与回执窗口。未验证真实跨机器传输。

## 对取舍的影响

Pi core 能稳定承担一次内存运行中的事件、工具循环、异步订阅屏障和取消传递。若应用需要它的输入队列和持续内存会话，这些能力有实际复用价值。

本次已经验证的恢复路径要求宿主另外维护原件/投影关联、持久运行阶段、工具意图与回执、未知结果查询、等待、取消标记、预算入口和最终执行条件。尤其 assistant→tool 未完成的恢复无法仅靠重新构造 `Agent` 后 `continue()` 完成。引入 Pi core 没有替代这套恢复所有权，还增加 Pi 消息/事件桥接；它仍是可行备选，不构成本身有缺陷或永远不适合循阶的结论。

自有模式只是同等情形的最小状态机示例，未实现生产并发、领取代际、按空间隔离、分布式消息、协议流解析、长期运行迁移或完整预算账本。它不能证明生产自研的代码量、性能或可靠性优于框架，也不能据探针短小推导教学任务只需少数步骤。

原生 fixture 被宿主原样保存，第二步通过模拟消息推进；没有进行真实 SDK 请求装配、原生历史重新发送、跨路线迁移、长历史压缩或图像工具往返。因此三协议保真结论仅限 fixture 的序列化存储，不替代[既有端点实测](../../../2026-10-23-model-endpoint-assessment.md)。

## 复现

在仓库根目录执行；依赖只安装在临时目录。Node 路径按本机调整。脚本自行创建并删除运行与执行器 scratch 数据库，任一断言失败返回非零。

```sh
probe_tmp=$(mktemp -d)
npm install --prefix "$probe_tmp" --ignore-scripts --no-audit --no-fund --save-exact @earendil-works/pi-agent-core@1.4.0 @earendil-works/pi-ai@1.4.0
PROBE_DEPS="$probe_tmp/node_modules" /opt/homebrew/opt/node@24/bin/node docs/student-agent-implementation/references/probes/2026-10-27-agent-kernel/core/probe.mjs
rm -rf "$probe_tmp"
```

固定发布接口参考：[Agent README](https://github.com/earendil-works/pi/blob/6c384aa30f619d7b28963f2bab24d8dacbe73cb6/packages/agent/README.md)、[循环源码](https://github.com/earendil-works/pi/blob/6c384aa30f619d7b28963f2bab24d8dacbe73cb6/packages/agent/src/agent-loop.ts)。实际执行的是 npm 1.4.0；未证明发布包与该 commit 字节一致。安装出现 `node-domexception@1.0.0` deprecated 提示，未影响运行。初轮记录未给提交失败写明确 failed 状态，补齐后重新运行全部组合。

没有改动应用依赖，也未进行项目工程测试、浏览器验收、性能比较或教学效果验证。
