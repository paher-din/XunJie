# WP07 #197 双轴审查

2026-11-05，基线 `6b4c3ee`，审查范围为 `wp07` 工作树（含未跟踪的新模块）。工程结论见 [交付记录](wp07-197-recoverable-learning-conversation.md)。

## Standards

对照 `AGENTS.md`、`DESIGN.md`、package README 与模块现有约定；基线 smell 仅作判断项，工具已覆盖的格式问题不重复。

| 发现 | 处置 |
| --- | --- |
| 新 `teaching-agent` 模块缺少 README；`model-connections` 与 `learning-entry` 文档仍写“学习未接入”“只接受探针” | 已修复：新增 [teaching-agent README](../../packages/learning-space/src/teaching-agent/README.md)，更新两处 owner 文档的表与学习用途说明 |
| 交付缺少修改前/后截图 | 已修复：交付记录给出基线构建与修改后 Chrome 实际界面 |
| `product.css` 把主按钮底色 `--primary` 当角色文字色 | 已修复：改用文字令牌 `--ink` |
| 契约内联重复声明帮助策略 schema | 已修复：活动绑定复用 `teachingHelpPolicySchema` |
| 容量 `contextWindow * 4` 在两处重复计算 | 已修复：`ContextBuilder` 只记录事实，最终 payload 检查集中到 `execute`，并计入输出预留 |
| 死代码：未使用的 `toRequest`、`TeachingRequestView` 导入、未写入的 `waiting` 状态 | 已修复：删除 `toRequest` 与 `waiting`，Run 状态只剩实际写入值 |
| 首页硬编码首问 localStorage key，且 effect 每次渲染重开讨论栏 | 已修复：导出 `firstQuestionKey` 并在活动页复用；按活动只执行一次 |
| 测试凑数断言（`release()`、`browserVersion`） | 已修复：删除，保留真实业务断言 |
| `canonical`/`digest` 在多个 owner 内重复 | 接受：各 owner 的规范化哈希是各自持久事实的一部分，跨包抽取会把存储实现耦合到共享工具；本轮不为此扩大接口 |
| `learning?: boolean` 与 `purpose` 枚举并存 | 接受（判断项）：Gateway 的段/尝试创建已统一用 `purpose`，布尔仅存在于内部快照辅助签名，无第二个调用方 |
| 服务端与 UI 各自映射原因码 | 接受：服务端记录稳定原因码，UI 文案属于展示层；共享中文文案会让契约层承担界面措辞 |
| 测试 harness 重复搭建 runtime/上游 | 接受：每个文件覆盖不同恢复路径，抽取共享 harness 会隐藏各场景的独立启动/清理边界 |

结论：文档、设计令牌、死代码、容量重复和首问 key 等可执行项已修复；其余为有理由的判断项。

## Spec

对照 Issue #197 修订版 PLAN 的“所有权与公开接口、模型配置与上下文装配、持久推进与正式 UI、验证与交付”。

| 发现 | 处置 |
| --- | --- |
| 增量正文只在 native attempt 结束后一次公开 | **未完成**：Gateway 目前只在最终发布前做敏感输出校验；新增未经校验的分片进度 API 会扩大泄漏面，本轮不冒险实现。`assistant` 事件仍在结果可重读后写入，`streaming` 位置保留为空契约值 |
| 首页、完整 Agent 页面与活动讨论共用控制器 | 部分完成：正式产品 runtime 的首页首问使用可靠草稿与固定请求身份，活动页使用同一对话控制器；`apps/web/src/main.tsx` 的旧个人聊天入口不属于本轮产品 runtime，未迁移 |
| “步骤”和“持久待发项”没有独立表 | 判断为已覆盖：步骤以 `teaching_events` 的稳定 `seq` 记录，接收前的待发工作由 WP02 `ActionReceiver` 的持久 intent 与回执承担；再建第二套队列表会复制推进权威 |
| 未逐项校验作品 `contentId` 与发布材料依赖 | 部分覆盖：接收校验主体、活动、固定输入摘要与课程发布绑定；作品正文作为固定输入保存。跨 owner 的材料依赖校验沿用 WP02 草稿/课程授权，未新增第二套校验 |
| 测试缺少取消竞争、提交失败/丢确认、结果关联前崩溃、断流的逐条用例 | 部分覆盖：已有停止、重启、双推进者、未知结果暂停、备份/还原/接管和三协议结果关联；取消竞争与提交失败/丢确认尚无专项测试 |
| 共享探针段 schema 被放宽 | 已修复：`chat-work.create` 对非 learning 段保留 8,192 字符前缀、8 工具、8 可移植条目的探针边界 |
| 学习输出缺失时用 4,096 兜底 | 已修复：未填写 `maxOutputTokens` 时暂停为 `max-output-missing` 并提供设置入口，不再发明上限 |
| 容量用字节数冒充 token、按粗估缩小窗口 | 部分修复：字符数仅用于“确定超出”的必要条件，记录 `counter:"unavailable"`，不修改保存的窗口；输出预留计入判断。没有匹配 tokenizer，不做精确预检 |
| 作品在 200,000 字符处静默截断 | 已修复：完整作品进入上下文；超过学习传输边界（前缀 400,000 / 用户文本 1,000,000 字符）时保留完整输入并暂停 |
| 课程帮助策略可省略并静默默认 | 已修复：导入、存储发布、活动绑定、读取均要求显式策略；样例、探针和脚本同步更新；禁用策略接收前取消且不调用模型 |
| 真实三协议供应商与 Windows 11 未验证 | 如实记录：仅有合成上游 + 真实 SDK transport；Windows 未执行，不能声称通过 |

结论：持久推进、原始 attempt 接管、快照、停止/继续、课程策略、容量保留和正式 UI 主路径已实现；增量正文、部分竞态专项和跨平台/真实供应商验证仍为未完成项。
