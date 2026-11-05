# WP06 #168 · Windows 验收记录

2026-11-03，Windows x64，Node 24.21.0，PostgreSQL 18.6。实现提交 `879c8f8`。正式完整包及测试数据存放在 D 盘。产品包 `distribution.json` 的 SHA-256 为 `2128dcb751d3a199a8eba1703a817284d99279073ea2ca11c6cb0f856bdccdc4`。

| 项目 | 结果 |
| --- | --- |
| 工程与正式包 | 类型检查、文档检查、Windows 完整包、包内独立 `model` 装配启动与停止通过。独立环境包含 `model-connection`，无 `learning-data`。 |
| 桌面 Chrome | 完整包 11/11 通过，0 跳过。普通 Web 回归包含模型选用断连后恢复和接管提示。 |
| 同机双进程与 PostgreSQL | 普通装配及独立模型装配完成学校排队、设备拉取、固定图片、原生工具往返及在途取消。取消后复查保留原尝试，重复派发没有额外上游请求。 |
| 独立模型接管 | 备份、隔离还原和接管通过，原结果、固定图片和待结清工具可继续使用。 |
| 旧 schema 升级 | 用 `cf076b5` 构建 schema 9 完整包，经正式 `upgradeProductRecovery`、隔离还原和接管至 schema 10。保留连接、凭据、原结果引用和用量。旧实例无法启动，重复派发历史尝试不外发，新调用可正常完成。 [脱敏证据](evidence/wp06-schema9-to-10-windows.json) |
| 真实 DeepSeek Chat | `deepseek-flash` 共 6 次请求，SDK 重试 0。固定图片、双工具和重启原生续接通过，续接读到了工具返回图片并核对了标记。JSON 模式应用校验通过，原生 strict schema 和 thinking 下强制具名工具探测返回 HTTP 400。 [脱敏证据](evidence/wp06-device-model-deepseek-windows.json) |

DeepSeek 可用 `node scripts/probe-model-chat.mjs --provider deepseek --out <脱敏报告路径>` 重跑，读取已配置的 `DEEPSEEK_API_KEY` 和 `XUNJIE_PRODUCT_POSTGRES_BIN`。生成上限为 6 次，每次最多 2048 输出 token、30 秒。真实端点用例在单机运行。真实跨机验收已于 2026-11-03 执行：macOS 学校宿主 ↔ Windows 学生侧独立模型 owner，经 WP01 通道主动拉取任务，完成 DeepSeek 文本、固定图片、工具往返、在途取消、断连重连与原结果查询，具体见 [Mac 验收记录](wp06-device-model-mac-acceptance.md) 与 [脱敏跨机证据](evidence/wp06-device-model-cross-machine-mac-win.json)。Command Code 复验已豁免，Mac 实机已按[交接文档](wp06-device-model-mac-acceptance.md)执行并回填，结果见 [#183](https://github.com/paher-din/XunJie/issues/183)；DeepSeek 核心用例在上游 503 事件恢复后通过，教学效果未评估。
