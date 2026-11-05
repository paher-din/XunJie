# WP06 #167：Anthropic Messages 实施方案

依据 [#167](https://github.com/paher-din/XunJie/issues/167) 与[已批准母规范](wp06-model-connections.md)。同步基线 `wp06 @ 92e8cea6b5ad06fb8b967bf56e1450be06f257a4`；继续在同一 `wp06` 分支提交，由已有 PR #177 承载，不合并。Mac 具体验收交接 [#178](https://github.com/paher-din/XunJie/issues/178)。

1. 在原模型 owner 增加固定 `@anthropic-ai/sdk@1.1.0` 薄 adapter，经既有 Gateway 接收、派发、查询、取消。DeepSeek base URL 为 `https://api.deepseek.com/anthropic`，最终路径 `/v1/messages`；不改用 Claude，不静默拼接重复 `/v1`，不隐式重试或执行工具。
2. 在既有段契约装配 Messages 的 system、用户材料/固定 PNG、工具、参数与 `tool_result` 图像。完整 assistant content 按流索引保存，聚合 thinking/signature/input JSON 分片，并以整体 message_stop、合法终态及完整 schema 校验守住工具意图发布。
3. 原生记录及事件由同一 owner 保存/保留/维护；重启后使用完整 content 原样回放，支持合法空值，未知关键格式拒绝续接。取消、错误、截断、缺终态及部分用量保留真实事实。工具结清后验证 Messages↔Chat、Messages↔Responses 新段，跨协议只使用获准可移植内容。
4. 原正式设置仅解除已接入 Messages 的检查限制，复用表单、来源选择、错误与能力投影；不另建 UI，不推进学习 Agent。Command Code 目标型号保留带日期的 Messages 不支持目录/能力反例。JSON mode、应用校验、原生格式/schema 与 strict tools 分开记录，受控探针不自动晋升能力。
5. 完成真实 DeepSeek 的图片/多工具/工具图/重启原生 wire 保真、有限文本及取消、格式与 thinking 强制工具反例；仅用合成资料及无副作用工具，最多 12 次有限生成、每次 2048 token/30 秒、retries=0。凭据复用用户已授权私有配置，不公开 key、thinking 或 signature。

测试沿用母规范已批准的公开边界：生产宿主 Gateway + 真实 WP02 身份/PostgreSQL/资源 + 直接 SDK→受控 HTTP/SSE，以纵向 red→green 推进；不查内部 SQL 证明业务结果。分别验证正式检查、原生工具/图片续接、故障/取消、恢复/丢回执/身份及跨协议段，回归 Chat/Responses。正式桌面 Chrome 覆盖普通 Web 和完整 Windows 包的 Messages 设置/空间切换；一次全量套件、工程/契约/文档检查与双轴并行审查分别报告。Mac 不执行不记通过，教学效果不评估。
