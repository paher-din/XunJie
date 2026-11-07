# WP08 #215：学习对话的版本化能力装配

本票对应[现有学习对话接入版本化能力装配](https://github.com/paher-din/XunJie/issues/215)，规范及已确认的主测试边界见母票 [Agent 能力、上下文与扩展](https://github.com/paher-din/XunJie/issues/214)。基线为包含 WP04/WP07 最终修复的 `c484c492`，继续原 `wp08` 分支。

学生沿原无课程活动与 ALU 入口提问。新请求保存完整 AgentDefinition、实际解析的 Prompt/工具/executor、上下文清单和原生请求；配置更新、换模型与重启均不改写旧快照。未新增学生需要操作的装配或换段入口。

## 实现

- 普通步骤与模型切换共用 `assembleTeachingAgent`，能力引用筛选当前平台/课程贡献；同名来源使用固定别名，准备与执行重新检查实际来源资格。课程绑定仍是活动原发布。
- 平台规则、输出契约、课程帮助规则独立于学生意图与事实材料；活动目标不再获得 system 优先级。当前问题、固定依据、已采用补充、原效果及未结 Command/Wait 完整保留，未消费 queue 不进入请求。
- 快照 v2 保留 `resolvedAgent` 与 `contextManifest`，并继续读取 v1。实际 transport payload、Prompt、完整工具 schema、executor、来源版本及顺序均可重读；token 计数没有可靠来源时明确 unknown，原预算保留上界，不将未知 usage 计零。必需内容超过已固定范围时保留输入并说明需要缩小的对象。
- `createTeachingSegments` 统一首段、装配变化及学生模型切换的持久接收与完成；固定 close/create 身份、正文及原段/新段。回执丢失先查询原段；父推进权限接管时围栏旧代际。配对未闭合拒绝换段，accepted 长操作保留原 Wait；不借换段重置预算或携带提供商原生身份。
- 迁移 9/10 增加换段、定义、解析装配和步骤清单。原 owner 的维护清单、资源保留和恢复校验覆盖新事实；隔离读取不触发模型、工具或重新渲染。
- 步骤计划与其采用的输入、效果、Wait 和活动事实一起保存。快照资源写入已成功但回执丢失时，较早作业的新结果不改写原快照；恢复原 attempt 后，后续步骤再采用新结果。

## 验证边界

新增集成测试沿原 Agent/可靠动作、真实 PostgreSQL、生产 RunDriver/ModelGateway 与真实工具验证，受控上游只用于精确故障时点：

| 文件 | 核对行为 |
| --- | --- |
| `teaching-agent.assembly.runtime.test.mjs` | 三协议实际 payload、定义、executor、来源、效果清单及重启纯读 |
| `teaching-agent.assembly-config.runtime.test.mjs` | 步骤边界版本变化、必需缺项、撤销、同名来源与超限输入保留 |
| `teaching-agent.segments.runtime.test.mjs` | close/create 回执丢失、配置再次变化、父代际接管、双推进者、原 Wait/预算与首次装配/模型切换竞争 |
| `teaching-agent.context-portable.runtime.test.mjs` | 真实已接受长作业经过 steering 后的装配变化/模型切换，保留 Command/Wait、课程事实及规则优先级 |
| `teaching-agent.snapshot-recovery.runtime.test.mjs` | 快照上传丢回执后原作业完成，原上传字节及 attempt 保持，较晚结果只供后续步骤采用 |
| 既有 Agent / 工具 / 输入 / 恢复测试 | 原停止、续接、队列、模型切换、备份和独立 owner 语义 |

真实协议请求由 `scripts/probe-teaching-tools.mjs` 另行验证：每条获准 DeepSeek 路线最多 2 次、2048 输出 token/次、30 秒/次、0 自动重试，对照实际发送字节摘要与快照。Command Code 沿用 WP06 豁免。正式 Chrome 与 ALU 真实 Icarus Worker/WASM 的产品结果分别登记，固定模型案例不证明教学效果。

工程、真实协议、桌面 Chrome 与跨机结果分别见[验收证据](evidence/wp08-215/README.md)。首次完整工程验证使用了不含 npm 的分发 Node，开发工具组失败；改用完整 Node 24.21.0 并修复安装竞争后重新核验。教学效果未评估。
