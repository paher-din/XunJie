# WP06 #167：Anthropic Messages 接入与验收

2026-11-03（Asia/Shanghai），依据 [#167](https://github.com/paher-din/XunJie/issues/167)、[母规范](specs/wp06-model-connections.md)与[实施方案](specs/wp06-messages.md)。同步基线为 `wp06 @ 92e8cea6b5ad06fb8b967bf56e1450be06f257a4`；继续在同一 `wp06` 提交，由已有 PR #177 承载，保持草稿且不合并。Mac 后续具体清单交接 [#178](https://github.com/paher-din/XunJie/issues/178)，完整独立部署/真实跨机接管仍属 #168。

## 已交付行为

正式设置现在可选择 Anthropic Messages，完成保存前检查、保存重开、原连接检查和取消。复用原表单、来源选择、身份/空间隔离、授权、费用及固定配置版本；学校默认和本机个人连接使用同一生产 Gateway。没有新增配置页、导航、学习聊天、Agent loop 或工具执行。界面只调整协议选项、检查可用性、地址提示与实际能力文案，使用原 token、焦点、状态及错误反馈。

模型 owner 直接使用固定 `@anthropic-ai/sdk@1.1.0`，adapter `xunjie-messages-native-v1`。DeepSeek base URL 为 `https://api.deepseek.com/anthropic`，实际路径 `/v1/messages`，明确发送兼容 header `anthropic-version: 2023-06-01`；不改写模型 ID，不改用 Claude。Base URL 已以 `/v1` 结束时可保留配置供修正，但检查在外发前拒绝，避免重复拼接。SDK `maxRetries: 0`，禁止重定向、自动多轮或自动工具 helper。每次最多 2048 输出 token、30 秒；正式检查仍为原有限短文本和原准入/并发限制。

使用直接 `messages.create(stream:true)` 的原始 SDK 事件，通过有界聚合记录完整 assistant content 和事件。SDK 1.1.0 的 `MessageStream` 对连续 signature delta 会覆盖旧值，因此本模块显式按块索引合并片段，再用持久事件重建并校验原生结果。content 顺序、thinking、signature、tool-use ID/参数保留；起始签名缺失/null 可等待后续片段，终态保留合法空字符串/null。未知关键块、错序、半截 JSON、未知工具/schema 不符、截断、拒绝、缺整体 message_stop 或流内错误均不可消费。只在整体成功且完整资源/引用可靠提交后才发布工具意图。

同段重启后读取原 request/result 并回放完整 content，不从可见聊天文本重建签名，不依赖 DeepSeek 可能提供的隐藏恢复。工具按 tool_use_id 配对，success/error/not-executed 由调用方明确给出；失败状态同时编码为配对文字和 is_error，不依赖 DeepSeek 忽略的标志。固定所属 PNG 在用户 image 和原生 tool_result image 中物化；图片上限只统计真正的图像块，不把工具参数里的普通元数据当图像。旧资源和新原生格式加入同一 owner 的引用、维护验证、备份还原及接管，没有新状态权威。

Messages↔Chat、Messages↔Responses 只在工具结清、物理调用结束后显式新建段；输入为获准可移植问题/可见结果，旧原件与出处保留，签名、隐藏块和原 response/tool/file ID 不跨协议复制。查询、重复接收、取消与重启沿原尝试，不隐式重新生成。

DeepSeek 用量采用最终 message_delta.usage，累计值覆盖而不相加；缺失不由初始占位零补齐。input_tokens 不含缓存命中，cachedTokens 分列；Messages 没有原生 total_tokens，因此不捏造总量。取消仅证明本机停止接收，服务端计算/费用仍未知。凭据回显时禁止消费并移除可能重建 key 的原生正文/分片；SDK 日志关闭，公开证据不含 key、推理正文或 signature。

## 真实端点与能力反例

[脱敏端点证据](evidence/wp06-messages-real-win.json)保存日期、路径、参数模式、SDK/adapter、终态、原生比较、用量及失败。探针 [probe-model-messages.mjs](../../scripts/probe-model-messages.mjs)从用户获准私有配置读取凭据；按 native/schemas/controls/check/cancel 分组在独立环境运行，单组最多 6 次，累计本轮 **11 次有限生成**，自动重试 0。真实原生探针通过独立宿主子进程，重启 PID 后从同一私有数据根读取，再观察下一轮真实 HTTPS wire；原生正文仅在内存比较。

| 路线/参数 | 结果与限制 |
| --- | --- |
| DeepSeek deepseek-flash / thinking + auto | 两次均 completed：用户图左侧颜色正确，两个无副作用工具正确配对；重启后同一 resultRef，完整 assistant content/thinking/signature/工具身份与下一轮 wire 相同；随机 nonce、tool_result 图像颜色正确 |
| 上述两轮用量 | 第一轮 input 585、output 222、cached 0；第二轮 input 298、output 73、cached 768，均 final。input 不含缓存命中，不把 cached 大于 input 误判为协议损坏 |
| plain 正式连接检查 | completed/end_turn；input 14、output 1、cached 0，final |
| plain 应用 schema | 初次输出不是合法 JSON，本地拒绝；明确要求双引号的 JSON 样本通过。合成上游同时覆盖合法/非法样本。应用校验不等于上游强制格式 |
| plain output_config.format | 有效/无效 schema 均 HTTP 200，输出未通过本地校验；不能宣称 native schema/strict。普通调用在未验证/不支持时拒绝原生格式请求，包括 strict:false，不静默降为应用校验；调用方可明确使用 applicationSchema |
| plain strict 工具 | 有效 schema 完成；不可满足 schema 仍返回 HTTP 200 和非法工具输出，本地拒绝且无工具意图。原生 strictTools 标为 unsupported |
| thinking + 强制具名工具 | HTTP 400，保留限制，不改成 auto |
| 真实客户端取消 | HTTP 200 后取消，cancelled/client-abort、物理请求结束、用量 partial；不声称上游停止 |
| Command Code deepseek/deepseek-v4.1-flash | 2026-11-03 目录 HTTP 200，只声明 /chat/completions 与 /responses；Messages 能力拒绝，不外发、不替换型号。目录是本次带日期证据，变化后须重新核对并更新 |

首轮 schemas 探针执行了 4 次外发，随后因本地不接受最初 oneOf 工具样本而停止，保留该失败；换用有效但不可满足的本地 schema 做负对照后，补齐剩余反例及 JSON 正例，没有把首轮探针记为全通过。Messages 未实现独立 JSON object mode；JSON mode、应用校验、原生 schema 与 strictTools 分开投影。能力证据只匹配实际 endpoint/model/protocol/dialect/mode、日期与 SDK/adapter；未知组合保持 unknown，plain 不继承 thinking 图片/原生回放标签。

官方资料仅作为编码依据，不代替实测：[DeepSeek Messages 兼容说明](https://api-docs.deepseek.com/guides/anthropic_api/)、[Anthropic SDK](https://github.com/anthropics/anthropic-sdk-typescript)、[Command Code supported_endpoints](https://commandcode.ai/docs/provider)。

## 工程、浏览器与恢复

主测试为生产宿主 Gateway + 真实 WP02 身份/PostgreSQL/资源 + 直接 SDK→受控 HTTP/SSE，见 [model-messages.runtime.test.mjs](../../apps/server/tests/model-messages.runtime.test.mjs)。不以内部 SQL 或私有类调用次数代替业务事实。

| 验证 | 记录 |
| --- | --- |
| 中间 build / 类型检查 | Messages 模块 build 与 learning-space:typecheck 已通过；最终工程检查待汇总 |
| 正式检查、工具/签名/图片/重启 | 已通过；含空/null、交错工具、UTF-8 分片的最终加强回归待汇总 |
| 故障与终态 | 10/10（9 个反例 + 父用例），0 跳过；负用量二次异常已 red→green 修复 |
| 用量、取消、HTTP 不重试、格式边界 | 各定向分组通过；缺最终字段、真实零值与累计覆盖分开断言 |
| 维护恢复 | 真实备份→隔离还原→严格接管后原签名/工具/固定图片续接通过，旧源被拒绝重开 |
| 跨协议段 | Messages↔Chat、Messages↔Responses 两组及父用例 3/3 通过 |
| Windows 桌面 Chrome | 原入口红灯及改动前截图已取得；普通正式 Web 的 Messages 两项 2/2；完整包和 legacy 设置/选择回归待汇总 |
| 全量本地测试 | 尚未执行最终一次全量运行，后续按实际任务数和失败清单回填；跳过不记通过 |
| Mac | 本票未执行，具体清单交接 #178，不沿用 #165/#166 的平台结果 |
| 教学效果 | 未评估；连接和合成工具验收不证明完整 Agent 或教学效果 |

Chrome 使用安装版 156.0.8078.76、Windows 11 x64（10.0.26200）、headed、单 worker；Node 24.21.0、原生 PostgreSQL 18.6。没有物理 Windows 中文输入法候选窗验收；既有 CDP 中文输入/焦点回归不冒充物理输入。最终包、脱敏工程 JSON、前后截图及双轴审查结果在交付前回填。

## Standards

待最终固定提交进行独立审查，并按发现补回归。

## Spec

待最终固定提交核对 #167/母规范；Mac 和完整跨机后续范围分别登记，不冒充通过。
