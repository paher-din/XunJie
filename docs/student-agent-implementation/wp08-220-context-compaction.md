# WP08 #220：长对话压缩与模型延续

对应 [#220](https://github.com/paher-din/XunJie/issues/220)，基于 #215 的固定装配与持久换段。仅改变模型使用的长历史；学生完整交流、作品、固定引用和工具结果继续从原 owner 读取。

## 行为与边界

`compaction.ts` 在历史达到 64,000 字符，或估算输入加输出预留达到模型窗口 70% 时选择闭合区间。估算按 UTF-8 字节与固定策略计算，明确不是 tokenizer 计数。所选历史正文上限 240,000 字节（结构化必保留清单另计，仍受模型窗口与输入上限约束），摘要输出最多 2,048 token／16,000 字符，每个 Run 最多两次压缩；明确容量拒绝只允许一次预算内的压缩续接。必需内容仍超限时保存原件，返回具体问题、作品与引用范围。

摘要是同一 Run 的持久 step/attempt，使用已获准模型路线，计入原模型步骤与 usage，不启用工具。摘要结构分开事实、候选推断、矛盾、未知和未完成事项；每项绑定真实源事件。规则、当前问题、固定引用、已接受效果及 Command/Wait 身份由结构化清单独立保留。无效格式、遗漏身份、无效引用或已变化来源均拒绝采用。

生成段与采用段复用 `teaching_segment_transitions`，分别记录 `compaction-generation` 与 `compaction` 原因。停止和失去推进资格阻止新采用；丢 close/create 回执、未知尝试与重启先核对原身份。来源修订时先撤销待采用选择，继续入口不会被旧换段锁住。摘要结果不作为学生答复发布，后续用户轮携带原问题和已发生操作状态。

`compaction-validation.ts` 将 source、step、generation event、resultRef、adoption event 与真实 transition 相互绑定，允许生成结果已保存、预算尚未结算的合法窗口。维护清单包含 `teaching_compactions`；隔离还原只读，正式接管继承原记录并撤销旧安装权限。

UI 沿用原对话、模型选择、继续与停止入口，只增加相关暂停原因文案，没有新增压缩页面、手动阶段按钮或常态内部标签。

## 验证与证据

工程、真实供应商、桌面 Chrome、维护与教学效果分别记录在 [验收证据](evidence/wp08-220/README.md)。真实三协议使用 `scripts/probe-teaching-tools.mjs --compaction --parameter-mode plain`，经生产 RunDriver/ModelGateway 触发读取、摘要与续接，保存实际请求摘要、装配身份与三步预算。凭据只从仓库外文件在进程内读取，不进入证据。`scripts/probe-compaction-effects.mjs` 另外以真实 Chrome Worker 运算、延迟原结果交付、真实 Chat 摘要和 Responses 续接验证 accepted 作业的跨路线恢复。

受控 transport 回归覆盖：闭合区间、固定输入、来源修订、停止、双推进者、steering/queue、容量拒绝、预算耗尽、无效摘要、未知尝试、摘要与采用 close/create 回执丢失，以及原 accepted 长作业在结果迟到和跨路线切换后的 Command/Wait 归属。

真实模型的格式遵循仍会失败。thinking 路线曾耗尽摘要输出额度，Messages 曾返回未通过校验的摘要；这些请求没有被采用，成本与原结果保留。通过的实际样本不承诺所有模型输出均有效，也不证明学生掌握或教学收益。重复恢复不会重派旧 Command；模型新提出的工具调用仍由原执行授权与预算控制，不能把 Prompt 指令称为任意新调用的语义去重保证。
