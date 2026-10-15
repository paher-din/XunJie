# I0 个人模型配置：Kimi Code 一手实现核对

访问日期：2026-10-15。研究角色：只读研究子 Agent。范围：供应商、模型、思考、上下文/输出预算、流式取消、超时、配置生效与许可。只写本记录，不修改实现、受保护基线、运行环境或用户凭据，不进行真实模型调用。本记录为实现建议，不是产品决定。

## 1. 固定来源与本机边界

- 官方 [MoonshotAI/kimi-code 固定提交](https://github.com/MoonshotAI/kimi-code/tree/b2603264ec4687cee766cf5d5e6d4976e432961c)：`b2603264ec4687cee766cf5d5e6d4976e432961c`，GitHub API 所示提交时间为 2026-10-15。以下源码链接均固定此提交，避免滚动 main 漂移。
- 本机 `D:\Kimi Code\Kimi Code.exe` 的 ProductVersion 为 `1.0.4.0`。这里只用它确认已安装产品身份；没有证据证明安装包对应上述提交，不把二者等同。
- `D:\kimi-code-windows\kimi-code-windows` 是个人设置迁移包，其入口 README 说明含用户配置；不是官方源码 checkout。本研究未读取其 `.kimi-code`、任何配置/凭据、会话或日志。也未读取用户主目录的 Kimi 配置。
- [根 LICENSE](https://github.com/MoonshotAI/kimi-code/blob/b2603264ec4687cee766cf5d5e6d4976e432961c/LICENSE#L1-L21) 是 MIT，版权为 Moonshot AI 2026；研究过的 `agent-core-v2` [package.json](https://github.com/MoonshotAI/kimi-code/blob/b2603264ec4687cee766cf5d5e6d4976e432961c/packages/agent-core-v2/package.json#L1-L12) 也声明 MIT。若直接复制代码或实质片段，需要随副本保留版权与许可文本；本记录未复制实现代码。未据此推断所有第三方依赖同为 MIT。

## 2. 事实与当前差距

### 2.1 Provider 与 Model 分开，并把用户覆盖与发现值分开

Kimi 的 Provider 负责协议类型、地址、凭据、请求头；Model 负责 provider 引用、API model ID、上下文/输入/输出大小、思考与媒体能力。`ModelOverrideSchema` 明确剔除身份、凭据和路由字段，让用户能力/预算覆盖保留在独立 overrides 内。[配置 schema L47–62、156–200](https://github.com/MoonshotAI/kimi-code/blob/b2603264ec4687cee766cf5d5e6d4976e432961c/packages/agent-core-v2/src/app/kosongConfig/configSection.ts#L47-L62)、[Model schema](https://github.com/MoonshotAI/kimi-code/blob/b2603264ec4687cee766cf5d5e6d4976e432961c/packages/agent-core-v2/src/app/kosongConfig/configSection.ts#L156-L200)。官方说明 catalog 刷新后运行时优先读取 override。[配置文档的 Model overrides](https://github.com/MoonshotAI/kimi-code/blob/b2603264ec4687cee766cf5d5e6d4976e432961c/docs/en/configuration/config-files.md#model-overrides)。

**映射建议：** XunJie 已有 provider 下挂 models，不需搬整套 DI。给传输增加协议方言和模型能力解析 seam；模型列表发现值与用户保存值不可静默互相覆盖。个人库加密、每账号隔离与 CAS 继续沿现实现，不能照搬 CLI 明文 TOML 凭据存储。

### 2.2 思考开关、默认与具体强度不是一回事

Kimi 的语义模型包含 `supportEfforts`、`defaultEffort`、`offEffort`、`alwaysThinking`。`on` 不强塞具体档位；`off` 可映射模型专用关闭值，始终思考模型不可假装关闭。显式强度是否支持可在发请求前校验。[thinking.ts L13–19、74–144](https://github.com/MoonshotAI/kimi-code/blob/b2603264ec4687cee766cf5d5e6d4976e432961c/packages/agent-core-v2/src/human/llm/thinking.ts#L74-L144)。默认选择与请求级覆盖单独解析，未指定时选已声明默认或支持列表中间值。[默认解析 L174–231](https://github.com/MoonshotAI/kimi-code/blob/b2603264ec4687cee766cf5d5e6d4976e432961c/packages/agent-core-v2/src/human/llm/thinking.ts#L174-L231)。

真正发线时由 trait 决定字段：Kimi 协议发送 `thinking.type` 为 enabled/disabled，并把具体强度放 `thinking.effort`；通用 OpenAI 的 fallback 才是 `reasoning_effort`。这两个位置不可混为所有供应商共同协议。[Kimi trait L82–109](https://github.com/MoonshotAI/kimi-code/blob/b2603264ec4687cee766cf5d5e6d4976e432961c/packages/agent-core-v2/src/human/llm-kimi/trait.ts#L82-L109)、[applyThinking](https://github.com/MoonshotAI/kimi-code/blob/b2603264ec4687cee766cf5d5e6d4976e432961c/packages/agent-core-v2/src/human/llm/protocol/thinking.ts#L25-L37)。

**映射建议：** 当前 `personal-agent/service.ts` 把 low/high/max 解析成可选 `reasoningEffort`，`openai-compatible.ts` 无值时只省略字段；这不能通用保证“关闭”。抽取一个小型纯函数，把保存语义解析成协议参数；两处聊天共用它。用户选择 low/high/max 要在模型允许列表内原样传出；不要把 unsupported 静默当 default。具体 DeepSeek 编码由 DeepSeek 官方接口再核对，不能用 Kimi 方言代替。

### 2.3 上下文与输出预算真正在请求构造时消费

`resolveMaxCompletionCap` 用已用上下文与总窗口夹取输出预算；请求构造器再通过 trait 选择 wire 字段。Kimi 使用 `max_completion_tokens`，未配置时依据窗口减已用上下文计算可用值。[format.ts L13–27](https://github.com/MoonshotAI/kimi-code/blob/b2603264ec4687cee766cf5d5e6d4976e432961c/packages/agent-core-v2/src/human/llm/protocol/format.ts#L13-L27)、[requester.ts L107–117](https://github.com/MoonshotAI/kimi-code/blob/b2603264ec4687cee766cf5d5e6d4976e432961c/packages/agent-core-v2/src/human/llm/requester/bases/openai/requester.ts#L107-L117)、[Kimi 预算 L69–76、105–109](https://github.com/MoonshotAI/kimi-code/blob/b2603264ec4687cee766cf5d5e6d4976e432961c/packages/agent-core-v2/src/human/llm-kimi/trait.ts#L69-L109)。通用 OpenAI encoder 对 o 系列/GPT-5 使用 `max_completion_tokens`，其他模型使用 `max_tokens`，并有 128 Ki token ceiling。[encoder L69–83](https://github.com/MoonshotAI/kimi-code/blob/b2603264ec4687cee766cf5d5e6d4976e432961c/packages/agent-core-v2/src/human/llm/requester/bases/openai/format.ts#L69-L83)。

**映射建议：** 当前 XunJie 把 JSON UTF-8 bytes 当 token 上界，稳妥但过度保守，不能向用户表述为精确 token 使用率；真实 usage 保持实际/未知。统一生成预算、输入预算和协议字段，避免课程通道另落回4096。不要照搬该 128 Ki ceiling 给所有兼容服务，它是该适配器策略，不是统一供应商限制。

### 2.4 无正文需要区分仍在思考与已经结束却无正文

Kimi Stream Parser 把 reasoning 与 text 分开，识别 `reasoning_content`、`reasoning`、`reasoning_details`；正文只消费 `delta.content`。它保留 raw finish reason 和 usage，不把 reasoning 当正文。[推理字段识别](https://github.com/MoonshotAI/kimi-code/blob/b2603264ec4687cee766cf5d5e6d4976e432961c/packages/agent-core-v2/src/human/llm/requester/bases/openai/reasoning-key.ts#L3-L54)、[流式消费 L280–324](https://github.com/MoonshotAI/kimi-code/blob/b2603264ec4687cee766cf5d5e6d4976e432961c/packages/agent-core-v2/src/human/llm/requester/bases/openai/format.ts#L280-L324)。完成后若仅有 thinking 没正文/工具调用，它单列 empty_response，提示可能是中断或推理耗尽输出预算，而不是正常成功。[empty-response.ts L17–48](https://github.com/MoonshotAI/kimi-code/blob/b2603264ec4687cee766cf5d5e6d4976e432961c/packages/agent-core-v2/src/human/llm/empty-response.ts#L17-L48)。

**映射建议：** 当前 `openai-compatible.ts` 已识别 reasoning_content 并有 onThinking，但其余推理字段及 finish!=stop 都归 protocol，信息不足。复用小型字段分类/finish分类思想，至少区分 waiting/thinking/streaming、length截断、filtered、空正文。持续收到推理或保活说明仍有活动；单凭无正文不能判定成功或失败。无需复制或展示供应商原始思维链，只传“正在思考”的状态和事实计数即可。

### 2.5 Timeout 与取消：不能声称 Kimi 完全没有限制

Kimi OpenAI client 显式 `maxRetries:0`，外部 AbortSignal 传入 `.create(...,{signal})`；没有在该构造处设置应用级45秒思考总限时。[client L56–66](https://github.com/MoonshotAI/kimi-code/blob/b2603264ec4687cee766cf5d5e6d4976e432961c/packages/agent-core-v2/src/human/llm/requester/bases/openai/requester.ts#L56-L66)、[请求与流 L160–195](https://github.com/MoonshotAI/kimi-code/blob/b2603264ec4687cee766cf5d5e6d4976e432961c/packages/agent-core-v2/src/human/llm/requester/bases/openai/requester.ts#L160-L195)。可选 `KIMI_CODE_LLM_HEADERS_TIMEOUT_MS` 只控制首部等待，正整数并有范围校验，接入 Undici dispatcher。[timeout.ts L3–19、74–122](https://github.com/MoonshotAI/kimi-code/blob/b2603264ec4687cee766cf5d5e6d4976e432961c/packages/agent-core-v2/src/human/llm/requester/timeout.ts#L3-L19)。未显式 timeout 不等于无限等待，SDK/HTTP默认仍可能终止；这份源码不足以证明所有 Kimi 通道都无限等待。

**映射建议：** 当前获准的“无思考总上限、活动续期、连续失联600秒终止、可主动取消、不自动重试”不必因对照项目改回固定总时限。所有终止/关页/显式stop应真正 abort socket，保活和推理续失联窗口，课程Job lease随受信活动续期。保留重启未知不重发。不要从 Kimi 复制自动恢复/Agent工具循环扩大本轮调用次数。

### 2.6 媒体能力必须与实际消息转换一起实现

能力标签不是附件协议。OpenAI lower 明确把 image/audio/video part 转成各自 wire 内容，并对部分 tool-message媒体产生明确省略占位。[lower.ts L11–41、44–60](https://github.com/MoonshotAI/kimi-code/blob/b2603264ec4687cee766cf5d5e6d4976e432961c/packages/agent-core-v2/src/human/llm/requester/bases/openai/lower.ts#L11-L60)。能力推断是独立层，例如 OpenAI capability 按模型系列提供默认。[capability.ts](https://github.com/MoonshotAI/kimi-code/blob/b2603264ec4687cee766cf5d5e6d4976e432961c/packages/agent-core-v2/src/human/llm/requester/bases/openai/capability.ts#L1-L46)。

**映射建议：** XunJie 当前 transport 的 content 为文本；用户勾选 image/video/pdf 不代表已实现附件上传、授权、存储和供应商转换。设置可以如实保存能力，但聊天必须明确禁用尚未接通的入口/拒绝未支持输入，不能只发送附件名称就宣称供应商读取了文件。PDF 不应直接套用 image_url。

### 2.7 配置更新与持久化是一个有回执的链

Kimi 在初始化时载入 providers/models，监听配置 section change 重新 loadAll；模型/默认模型变化通过带 waitUntil 的事件串行持久化，防止UI改了但磁盘未落地。[KosongConfigService L45–113、115–146](https://github.com/MoonshotAI/kimi-code/blob/b2603264ec4687cee766cf5d5e6d4976e432961c/packages/agent-core-v2/src/app/kosongConfig/kosongConfigService.ts#L45-L146)。`ModelService.set` 会等 ready、跳过相同值、发布异步变化事件。[ModelService L61–94](https://github.com/MoonshotAI/kimi-code/blob/b2603264ec4687cee766cf5d5e6d4976e432961c/packages/agent-core-v2/src/llm-adapter/model/model-service.ts#L61-L94)。

**映射建议：** 现有 XunJie 后台ACK/CAS、下一回合固定配置快照、账号代次隔离已经适合Web多人服务；无需照搬配置服务体系。应补核验保存的每一项是否进入两处实际请求体，前端重读与数据库有效配置一致；连接测试仅证明/models，不代表生成参数被供应商接受。

## 3. 可采用与不可直接采用

| 结论 | 采用方式 | 验收切面 |
| --- | --- | --- |
| 思考语义与协议编码分开 | 小纯函数，统一两通道，具体方言可测 | low/high/max、default/off、始终思考、不支持值；断言真正请求体 |
| completion budget解析与wire字段选择 | 小纯函数，依所选模型/协议映射 | 保存输出值进入实际请求，剩余窗口不足明确失败 |
| reasoning/text/finish分类 | 小型解析辅助；只公开活动状态 | 思考无正文仍running，length/空结束如实失败或截断 |
| 保存/热生效/在途快照 | 保留当前ACK/CAS并补闭环 | 保存后新回合使用新值，在途保持原配置 |
| 全套Kimi DI、工具循环、自动重试、OAuth、TOML凭据 | 本轮不引入 | 无新增框架/依赖/隐式凭据来源/额外供应商调用 |
| Kimi型号推断表、128Ki ceiling、CLI本地网络策略 | 不当作通用规则复制 | 以具体供应商协议及已批准公网HTTPS边界为准 |

本记录仅完成源码研究与现实现差距映射，不把静态对照记为真实模型通过。后续需由主 Agent 合并三项目结论，实施后以保存的本人配置分别验证独立聊天和课程辅导真实回复。
