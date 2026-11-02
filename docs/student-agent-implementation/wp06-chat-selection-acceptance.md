# WP06 #165：学校／个人选择与 Chat 原生续接

来源 [#165](https://github.com/paher-din/XunJie/issues/165)；依据[母规范](specs/wp06-model-connections.md)和[实施方案](specs/wp06-selection-chat-continuations.md)。开发基线 `wp06 @ f0c211ad27455063480b28cbfd8c6a33f97eacd4`，分支 `codex/wp06-165`，单独向 `wp06` 提 PR，不合并、不修改 PR #177。Windows 交付验证在本记录中；本票 Mac 验收追加到统一交接 [#178](https://github.com/paher-din/XunJie/issues/178)，完整独立部署/真实跨机接管归 [#168](https://github.com/paher-din/XunJie/issues/168)。

## 本次行为

学校维护者通过 `school-model --root … --file <私有 JSON>` 配置/更新/停用默认连接及检查许可/限额。学生在正式设置中直接使用默认模型，或明确“授权并选用”个人连接；当前模型在原侧栏入口内可见。授权按真实环境、空间、主体保存引用，无管理员开放个人模型的开关，不复制学校账户库、课程、画像或会话。

安装客户端用原 WP02 学校连接实时确认身份和目标。学校默认由学校持有并计学校额度，个人由本机持有并计个人费用；尝试 ID、输入摘要及持有方先持久绑定。切换选用不让原尝试改由另一方接收、重发或查询。撤销/停用/清除凭据会阻止已接收但未外发者；仍获准查询的主体可读原历史。配置更新固定旧请求的路线和版本，不补用最新配置或另一方额度。

同一 Gateway 的 `chat-probe` 公开契约承接图片、工具 schema/结果、观察和原生段；受控调用方使用真实身份、PostgreSQL、所属资源及直接 `openai@7.42.0`。这没有接通学习聊天、工具调度、Run 预算或 PDF 工具。旧教师、个人聊天和课程辅导保留原身份、预算和控制器。

工具必须在整体成功结束且完整结果可读后才发布意图；无副作用结果由调用方配对为 success/error/not-executed。DeepSeek `reasoning_content` 和实际 Command Code `reasoning`、分片 `reasoning_details` 原样组装/持久/回放；公开结果不泄漏推理。未知关键格式保留原 chunks，但不发布可执行工具或伪称可续接。

段固定路线、格式、system/工具/参数和顺序；工具未结清不能换段，不替调用方执行或取消工具。新段只接受显式可移植文本和本主体已完成结果引用，封存旧段并保留出处。新观察带调用方来源和版本追加，不覆写旧工具结果。PNG 从固定原件引用物化，变换保留来源；不接任意 URL、教师材料 ID 或路径。

具体 wire、限额、错误与维护操作见[模型 owner](../../packages/learning-space/src/model-connections/README.md)。

## 真实端点（2026-11-02）

最终原生 adapter `xunjie-chat-native-v2`，SDK `openai@7.42.0`；每次最多 2048 输出 token、30 秒、重试 0。通过正式产品宿主和 Gateway，网络边界透明记录真正发送到目标 HTTPS 地址的请求，并与实际收到的原生分片作保真比较。使用两张 64×64 合成双色 PNG、随机 nonce 和两个无副作用工具；凭据只由获准私有文件读取，报告不含 key、原生推理或签名。

| 路线与参数 | 图片/多工具/重启续接 | JSON 与反例 |
| --- | --- | --- |
| DeepSeek `https://api.deepseek.com/v1/chat/completions` / `deepseek-flash` / thinking enabled + auto tools | 首轮 2 工具，图片左侧颜色正确；重启查询同一结果引用，实际下一轮 assistant、完整参数/身份/reasoning 与原生输入一致；nonce 和工具图左侧颜色正确。最终两轮 usage：600/72/672、928/87/1015，均 final | plain JSON mode + 应用 schema 通过；有效及无效 `json_schema` 都返回 400；thinking 强制具体工具返回 400 |
| Command Code `https://api.commandcode.ai/provider/v1/chat/completions` / `deepseek/deepseek-v4.1-flash` / 默认参数 | 首轮 2 工具，图片读取正确；重启后的原生 `reasoning` 和 `reasoning_details`、工具顺序及参数与下一轮 wire 一致；nonce 和工具图读取正确。两轮 usage：600/78/678、935/70/1005，均 final | JSON mode + 应用 schema 通过；有效 native schema 返回 200；无效 schema 也返回 200，被本地应用验证拒绝，不能标为 native strict |

Chat 工具产图是“配对文本 + 紧邻用户图片”的实测装配，非原生 tool-image 能力。原生推理非空与实际 wire 保真均已比较，nonce 正确没有代替该比较。SDK/raw 请求正文和 reasoning 仅在私有 owner/探针内存中使用。

初轮发现 Command Code 实际字段与 DeepSeek 不同，先保留失败证据，再用合成反例完成 red→green 后复验。初轮 10 次、Command Code 修复复验 5 次、最终 DeepSeek v2 复验 6 次，共 21 次有限生成尝试，没有自动重试或改型号凑数。复验脚本 [probe-model-chat.mjs](../../scripts/probe-model-chat.mjs) 可以按 `--provider` 限定单条路线。

能力证据只匹配实际 endpoint/model/protocol/dialect/mode、日期及 SDK/adapter；名称不参与判断。未测组合维持 unknown，JSON mode、应用校验与 native strict 分列，已知 thinking/强制工具限制独立保留。旧样本不是所有未来版本的永久保证。

## 工程、恢复与浏览器

验证主缝为生产公开 Gateway + 真实 WP02 身份/原生 PG/资源/SDK→受控 HTTP/SSE。重点覆盖共享学校额度、个人授权及撤销、固定配置、图片格式/来源、交错多工具、空/非空推理、半截参数/拒绝/截断/未知字段、重复接收、重启和段边界。维护测试使用真实备份→隔离还原→接管，核对原授权、选择、图片、待配对工具和结果，并发送恢复后的下一轮实际 SDK 请求。

| 检查 | 当前记录 |
| --- | --- |
| 全工程 build / typecheck | 已通过；最终回归和审查后据实际结果更新 |
| 相关模型/可靠调用与真实恢复 | 正在完成最终隔离回归；首轮与全量套件的共享前端构建冲突导致缺产物，失败保留，不冒充代码通过 |
| 完整本地 `npm test` | 已执行本轮唯一全量运行，正在汇总；Windows 软链/路径/socket 等失败单列，不以跳过计通过 |
| 完整 Windows 独立候选包 | 已构建；包内 Node/PG/CLI 的桌面 Chrome 验证进行中；unsigned candidate |
| 学校网页与安装客户端的桌面 Chrome | 首轮选择/撤销、真实主体、空间隔离、键盘 Enter 和 720×900 深色布局 2/2；最终加入迟到回执/中文输入保护，并连同原设置回归复验 |
| Apple Silicon Mac | 未执行；登记到 #178，不记通过 |
| 教学效果 | 未评估；本次模型连接和合成工具验收不证明教学效果或完整 Agent 可用 |

Windows 为 Windows 11 x64，Node 24.21.0、PostgreSQL 18.6、安装版桌面 Chrome。前后截图及最终 JSON 随工程/包验收完成后补入本记录。物理中文输入法候选窗不由 CDP 组合输入代替；Mac 的物理输入、Meta 操作、独立包和受影响学校路径按交接逐项记录。

## 审查与剩余边界

双轴审查以 `f0c211ad...HEAD` 为固定差异，分别检查仓库规范和 #165/母规范；在最终提交前完成并处理发现。Responses/Messages 属于 #166/#167；真实跨机和独立持有组件恢复接管属于 #168；本票的具体 Mac 验收统一交接 #178。本票不关闭其依赖后续票，也不合并 PR。
