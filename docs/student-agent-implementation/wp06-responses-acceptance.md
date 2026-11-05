# WP06 #166：Responses 接入与验收

2026-11-03（Asia/Shanghai），在既有 `wp06` 分支实现 [#166](https://github.com/paher-din/XunJie/issues/166)，基线 `478bac7`。范围见[实施方案](specs/wp06-responses.md)。Command Code 真实端点按负责人本会话明确要求豁免；其合成协议回归保留，不声称真实通过。Messages 尚未交付，不补验不存在的实现。

## 已交付行为

正式模型设置支持 Responses 的保存前检查、保存、重开、已存连接检查和取消。复用既有页面、学校/个人授权和费用来源、稳定尝试身份、资源和维护机制；卡片显示实际能力投影。只调整原协议选项和检查可用性，没有新增导航或布局。

`openai@7.42.0` 的直接低层 `responses.create`，adapter `xunjie-responses-native-v1`，`maxRetries: 0`，禁止重定向。系统前缀使用 `instructions`，模型标识不改写；DeepSeek 普通/思考模式分别为 `reasoning.effort: none/high`。每次 `store: false`，同段重发完整原生 input/output，不依赖 `previous_response_id`、`conversation`、background 或远端结果接口。

完整 SSE events、终态 response 和原生 output items 随原 owner 资源保存。原生 item 顺序、reasoning content/summary、空值、item ID 和 call_id 保留；function_call_output 只按 call_id 配对。暂缺 arguments 的 added 事件等待后续数据；已观察增量与完整终态互相校验。未知关键块、矛盾数据、无终态、失败、取消和不合 schema 的工具不交付可消费意图。完整结果与引用提交之后才发布成功。凭据回显时拒绝发布成功，保留脱敏公开正文和真实用量，整份敏感原生正文（包括可重建密钥的 delta 碎片）不保存。

图片由获准固定资源装配为 input_image；工具图片位于原生 function_call_output.output 中。资源随备份/还原保留，新格式加入模型 owner 的维护验证；没有新建恢复机制。新段沿用旧工具结清规则，只携带明确获准的可移植上下文，原生历史不跨协议搬运。

## 真实 DeepSeek

[脱敏证据](evidence/wp06-responses-deepseek-mac.json)记录实际日期、endpoint/model、参数、SDK/adapter、终态、原生比较和用量。所有请求经生产 Gateway、真实 PostgreSQL/资源和实际 SDK；每次最多 2048 输出 token、30 秒，最多六次外发/探针，无自动重试。五次探针累计 17 次外发，包含修复前失败。

| 检查 | 结果及边界 |
| --- | --- |
| thinking + auto，图片及两个无副作用工具 | 完成；正确识别原图颜色，工具参数通过应用校验 |
| 进程重启后的原生续接与工具图片 | 同一 resultRef 可读；下一轮实际 wire 与首轮完整 output 相同，含非空 reasoning、工具身份与顺序；nonce、工具图颜色正确，原图版本相同 |
| plain JSON mode + 应用 schema | 完成，输出通过独立应用校验 |
| plain 原生 json_schema | 有效布尔对象 schema 完成，无效 schema 返回 HTTP 400；证据只覆盖该平面对象样本及反例 |
| thinking + 强制指定工具 | HTTP 400，保留限制，不默改 auto |
| plain strict 工具声明 | 有效 schema 完成，wire 保留 strict；oneOf 反例仍被接受，负对照不足，strictTools 保持 unknown，不宣称普遍原生严格约束 |
| Command Code | 负责人豁免，未执行本票真实请求；通用接入可用，路线能力保持 unknown |

双轴审查还发现工具参数回显凭据、incomplete item 提前拒绝、completed 后断流和终态用量分类四项问题。均经生产 Gateway 回归先复现再修复：凭据回显拒绝发布工具意图，敏感原生正文不保存；完整终态独立于后续传输失败；用量完整性独立于回答成功。

首轮生产实测发现 `response.created` 的状态为 `in_progress`，原校验错误地期待 `created`。修复并增加生产回归后，重新完成原生往返；修复前失败记录保留。合成测试另覆盖合法空 reasoning、Command Code summary 方言和缺 arguments 的 added 事件，不以合成样本替代真实路线能力。

DeepSeek 的无服务端存储边界与[当前官方 Responses 文档](https://api-docs.deepseek.com/guides/responses_api/)一致；其他上游不因 SDK 存在 retrieve/cancel 方法就被标为支持。

## 工程、浏览器与剩余边界

工程与平台结果见下表及对应 JSON。浏览器使用安装版 Chrome、headed、单 worker、正式产品入口，普通 Web 与独立产品包分别验证；无跳过。教学效果未评估，本票不实现 WP07 的 Agent loop。独立模型组件和真实跨机恢复接管仍由 #168 交付；本票复用现有 owner 与客户端契约。


| 验证 | 实际结果 |
| --- | --- |
| 工程 | 全量 `npm run verify`：147 个测试文件任务通过；含 typecheck/build、11 个公共契约浏览器导出检查和受维护文档链接检查 |
| 模型主测试 | Responses 51/51；既有 Gateway/Chat/选择/安装客户端五文件 25/25；真实 PostgreSQL 18.6、所属资源和实际 SDK，无跳过 |
| Apple Silicon Mac Chrome | macOS 27.2 (26B123)、arm64、Chrome 156.0.8078.79；普通正式 Web 与完整 darwin-arm64 包各 8/8 |
| Windows 11 x64 Chrome | Chrome 156.0.8078.79；普通正式 Web 与完整 win32-x64 包各 8/8；源码/数据位于本票独立目录，不改用户原工作树 |
| Standards | 原发现含工具凭据回显、截断 item 及跨 delta 敏感内容；均修复，最终聚焦复核 0 剩余发现 |
| Spec | 原发现含截断、终态后断流、最终用量及正文保留；均修复，最终聚焦复核 0 剩余发现 |

[Mac 工程与浏览器记录](evidence/wp06-responses-mac-verification.json) · [Windows 浏览器记录](evidence/wp06-responses-win-verification.json) · [Mac 实际设置截图](evidence/wp06-responses-settings-mac.png) · [Windows 实际设置截图](evidence/wp06-responses-settings-win.png)。平台记录含产品分发清单摘要；源码与包内 Node/PG 启动均使用 24.21.0/18.6。中文组字、焦点和既有选择回归同时保留；本票没有重做与其改动无关的物理输入法验收。


## Standards

发现的工具凭据回显、incomplete item 校验和跨 delta 脱敏一致性三项问题已修复。敏感原生正文不保存，成功前执行同一原生回放校验；实际 SDK 定向复核通过。剩余发现 0，原最高级别 P1 已解决。

## Spec

截断状态、completed 后断流、终态最终用量、跨 delta 敏感内容及失败/截断终态正文五项发现已修复。正常完成可续接，协议矛盾仍失败；终态正文与用量在 reset/abort 后保留。剩余发现 0，原最高级别 P2 已解决。
