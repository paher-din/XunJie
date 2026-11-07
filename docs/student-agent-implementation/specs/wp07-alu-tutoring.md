# WP07 #202：真实 ALU 辅导

需求和验收以 [#202](https://github.com/paher-din/XunJie/issues/202) 为准。复用 [通用工具](wp07-agent-tools.md) 与 [ALU 预测和引用](wp04-alu-learning.md)，不增加执行器、结果 owner 或另一套活动 UI。

## 开工核对

2026-11-07 从独立工作树的 `wp07` / `087e7f9c7df5fdd593cd8f581537094ac0724858` 开始。实时原生 blocker 为 #198、#192、#193、#194，均以 completed 关闭。通过正常 merge 集成 #194 固定交付 `54216d99bd78829e8e1f9245a27561766b3a1bdd` 及其前置链；不集成 #195 在途工作。WP04 旧验收只证明前置交付，不作为本票新组合验收。

| 前置 | 实际入口 |
| --- | --- |
| #198 | `createTeachingTools`、RunDriver、ModelGateway 原生工具往返、可信 Agent 命令及浏览器 broker、持久 Wait |
| #192 | `aluCoursePackage`、runtime preparation、V3 公共执行、真实 Icarus Worker、执行资源 owner |
| #193 | 原 ALU 虚拟板、`run-single` / `observe-enabled` / `check-all`、4096 组检查与反例 |
| #194 | 固定用例、预测与解释修订、原 VCD、`alu-case` / `alu-observation` / `alu-waveform` / `alu-reflection` 语义引用 |

合并保留双方公共边界。ALU 课程包增加显式帮助策略，使用新导入/发布身份，已有组件定义及历史活动不被就地升级。开工集成检查包括完整 typecheck、真实 PostgreSQL 引用/解释所有者与通用工具回归，以及 Worker/检查/波形定向回归。

## 实施选择

课程贡献层从固定 manifest 和课程运行方案声明获准验证操作，把本次已授权的不可变代码、输入、运行包、预算和可信 Agent 关联固定为原 V3 执行。RunDriver 不处理课程信号、编译或 ALU 分支。组件适配参数，既有执行 owner 再次验证固定依据与权限，真实浏览器 broker 使用同一 Worker、IndexedDB、接收、停止和资源同步路径。

Agent 不创建学生预测或解释修订、不改变已启用作品。对话中的验证来源与原学生观察有明确区别；读取原用例、反例或波形不重新仿真。已接受、完成、行为失败、编译失败、未知与未运行分别保留。晚结果归原代码，学生新编辑不继承原验证结论。

帮助策略覆盖模型请求、最终回答、过程、摘要、工具反馈和展开内容。无代码修改、testbench、shell 或补丁操作。固定工具定义/版本、计划、输入及结果沿原 Agent session log 和各 owner 资源保留机制持久化；日常恢复在本票验证。

## 公开验证边界

按本轮已授权的公共边界 TDD，一次一个行为切片：

| 边界 | 验证内容和限度 |
| --- | --- |
| `createTeachingTools` / 固定工具 schema | 获准操作、固定代码/输入/版本、帮助限制、跨活动拒绝；不以此证明浏览器实际运行 |
| 正式 HTTP / Agent broker / 执行资源 | 可信来源、真实所有者校验、原身份恢复/停止、session log、维护保留；模型 transport 仅在故障时序测试受控 |
| 实际 Chrome / 正式产品与学校 HTTPS | 固定失败依据→模型查证并真实验证→解释→学生修改→再次观察；另含正常输入、引用、重开、等待/停止与未知 |

最终运行完整工程验证和 Standards/Spec 双轴 code-review。Apple Silicon Mac 与 Windows 11 x64 的桌面验收均先原子获取共享桌面锁，核对实时持有会话和前台状态，在 finally 释放。学校使用独立机器的实际 HTTPS，保留既有数据和配置。具体实跑结果和前后截图在本票交付记录登记；工程、仿真、Agent、浏览器/部署与教学效果分别报告。
