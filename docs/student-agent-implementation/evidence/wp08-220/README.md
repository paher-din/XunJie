# #220 验收证据

所有记录对应独立分支 `codex/wp08-220-context-compaction`。Node 24.21.0、PostgreSQL 18.6；Windows 使用独立依赖与构建，macOS 与 Windows 桌面 Chrome 分别执行。以下按实际执行结果更新，未执行不计通过。日志仅统一换行和行尾空白；初轮跨路线报告合并相同的交付重试并保留计数与原报告摘要。

## 真实供应商

- [三协议执行记录](real-protocols.json)：Chat Completions、Responses 均在原 Run 完成读取、摘要和后续回答；Messages 该次摘要被拒绝。
- [Messages 单路线复核](real-messages.json)：同一候选完成三步调用，原读取未重派，重启回看零新调用。

每条通过路线核对实际 transport 与保存快照的 payload 摘要相等、摘要工具集为空、原 Command/作品身份保留、三次预算预留及结算、完整对话保留。模型为 `deepseek-flash`，参数模式 `plain`。[先前 thinking 输出耗尽](rejected-thinking-summary.json)、[修复前重复读取](repeated-read-before-fix.json)和三协议记录中的无效摘要均保留为失败记录，不作为通过证据。

## 真实 accepted 作业跨路线

[执行记录](cross-route-report.json)与[日志](cross-route.log)由 `scripts/probe-compaction-effects.mjs` 生成：正式课程、生产公开 HTTP owner、真实 PostgreSQL、headed Chrome 的实际 table Worker/WASM，以及真实 DeepSeek Chat → Responses。只延迟浏览器结果交付，没有伪造 acceptance、计算结果或模型输出；物理计算本身很短，长作业恢复语义由原 accepted Command/Wait 在等待交付期间验证。

五次真实请求均 HTTP 200 且 TLS 校验通过：Chat 发起原操作、处理长补充、生成摘要、摘要后继续，随后 Responses 接回原迟到结果。结构化清单保留原 Command/Wait 和 deadline，换路线不新增请求，原结果只消费一次，没有重派原工具。实际计算总均值为 83.33333333333333，结果 artifact 摘要与原 executionRef 保持一致；每份保存快照均与观察到的真实请求 payload 摘要匹配。只读回看不触发新请求。

[已接受](cross-route-accepted.png)、[压缩后仍等待原结果](cross-route-compacted.png)、[原结果完成](cross-route-completed.png)均为实际运行截图。[初轮未触发摘要记录](cross-route-initial-wait.json)保留：读取后正常回到 waiting，验收驱动没有追加推进输入而超时；修正为真实短 steering 后完成上述通过样本。

## 工程、浏览器与维护

- [完整 verify](verify.json)：类型、构建、公共 contracts 浏览器边界、文档链接，以及 35 个 unit、92 个 server、45 个 tools 测试文件全部通过。
- [压缩回归原始记录](compaction-runtime.log)：44 个用例中 42 通过，新增两项来源修订用例先因测试误读 `continueRun` 返回契约失败；修正测试后独立复跑 [2/2 通过](source-revision-regression.json)。产品来源核对在恢复换段之前完成，close/create 丢回执两路均验证可继续。
- [装配兼容回归](assembly-regression.log)：26/26 通过，覆盖定义/配置、三协议固定装配、可移植事实、持久换段及快照恢复。
- [macOS Chrome 日志](chrome-darwin.log)、[Windows Chrome 日志](chrome-win32.log)均为实际桌面 Chrome。

Standards 复审没有硬性规则违反；重复计划构造仍有后续收拢空间，拒绝与换段撤销已收拢为事务操作。Spec 复审发现的来源变更阻塞与结果身份错连已修复；最终复审没有其它阻断项。

macOS 桌面 Chrome 1/1 通过（27.3 秒）；Windows 桌面 Chrome 1/1 通过（43.2 秒）。两平台均验证完整 8 轮学生/Agent 对话、摘要生成期间的新草稿与焦点、刷新/重启零模型调用、原模型设置和停止。macOS [机器记录](chrome-darwin.json)、[压缩期间](summary-pending-darwin.png)、[继续后](conversation-after-darwin.png)、[窄桌面深色停止入口](controls-after-darwin.png)。[Windows 压缩/恢复工程回归](compaction-win32.log) 42/42 通过（509.4 秒）；随后新增的两项来源修订回归在 macOS 单独通过。Windows 连接恢复后已回收完整工程日志及 [机器记录](chrome-win32.json)、[压缩期间](summary-pending-win32.png)、[继续后](conversation-after-win32.png)、[深色停止入口](controls-after-win32.png)。恢复回归已执行真实备份、隔离还原与接管，检查原完整对话和快照不变、只读回看零外发、旧安装失权。

## 判定范围

工程测试与受控模型/执行回执用于精确故障时点。真实供应商和实际浏览器执行另行记录。本票 Windows 独立验收目录和失败遗留 runtime 已在回收证据后停止并删除。Chrome 的中文验证使用 composition 事件，不代表操作系统输入法的物理候选窗验收。教学效果没有评估。
