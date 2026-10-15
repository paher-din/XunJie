# I0-UI：DeepSeek Harness 供应商与模型配置源码核查

日期：2026-10-15（Asia/Shanghai）。范围：Robert 指定的 DeepSeek Harness（`dsh`），不是 OpenCode。只读研究；本子任务仅新增本文，不安装依赖、不运行 Harness、不读取用户 profiles/config/凭据/会话、不发模型请求、不改 3444。

## 1. 来源、许可和任务边界

- 官方仓库：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)。本次固定提交 `571902028a75c64c1d767f4ae5fd099485f0ddf0`，不能把移动 master 当实现证据。
- [`dsh-llm-deepseek` package.json L1–47](https://github.com/deepseek-ai/deepseek-harness/blob/571902028a75c64c1d767f4ae5fd099485f0ddf0/packages/llm/llm-deepseek/package.json#L1-L47) 与 [`dsh-llm-pi-ai` package.json L1–46](https://github.com/deepseek-ai/deepseek-harness/blob/571902028a75c64c1d767f4ae5fd099485f0ddf0/packages/llm/llm-pi-ai/package.json#L1-L46) 均为 `0.2.1-alpha.3`、MIT。
- [根许可证 L1–21](https://github.com/deepseek-ai/deepseek-harness/blob/571902028a75c64c1d767f4ae5fd099485f0ddf0/LICENSE#L1-L21)：Copyright (c) 2026 DeepSeek，允许复制、修改和分发；复制实质代码时必须保留版权与许可声明。本文仅记录行为与来源，尚未复制第三方代码。依赖另核许可证，不能把 MIT 视为整个依赖树的许可。
- 本机安装公开资源 `D:/DeepSeek Harness/resources/runtime/primary-runtime/runtime.json` 声明 desktopVersion `0.2.0-rc.2`、Node `24.21.0`。它不同于上面远程 alpha.3；本文实现结论来自固定远程源码，不推断本机桌面已经具备其全部行为。未解包私有运行内容。
- 已读本仓库 README、[当前实施任务](I0_UI_MODEL_CONFIGURATION_REAL_CHAT.md) §1–10，PRD §5/8/9、MVP_SPEC M-04/M-05、TECH_DESIGN §6.1/6.2 正文。适用 PRD-04/09/10、M-04/05、D-02：模型真实错误不冒充成功，保留权限/政策/版本及生成和显示的证据区别。Robert 已批准两处完整消费配置及新限额；产品基线保持只读，汇总由主任务承接。

## 2. 最有用的结论

1. dsh 的五分钟默认值是“等待供应商下一次活动”的空闲超时，不是“思考最多五分钟”。有正常流量可持续生成超过五分钟，SSE 心跳也延长等待。
2. 模型输出能力、用户显式请求上限、上下文容量是三个不同概念。把目录的能力数值强制当每次请求上限，或无条件保留 4096 的应用硬帽，都不符合这套设计。
3. low/high/max 是模型拥有的能力，需要模型声明及实际 wire 映射。不能给所有 OpenAI 兼容 URL 都发同一个字段并声称生效；不支持的显式选择应报错，不能悄悄降档。
4. 适合移植的是小型超时工具、目录解析、能力校验、一次请求配置快照模式。整个 Cordis 插件和 pi-ai 适配包有大量宿主 peer，不能当一个独立 HTTP 客户端直接搬入。

## 3. 供应商及配置 API

### 3.1 官方 DeepSeek 与通用兼容通道分开

当前专用 `llm-deepseek` 默认走 `https://api.deepseek.com/anthropic` 的 Messages 协议，专用 API Key 插件使用 `x-api-key`；其序列化不是 OpenAI Chat Completions。依据：[config.ts L114–118](https://github.com/deepseek-ai/deepseek-harness/blob/571902028a75c64c1d767f4ae5fd099485f0ddf0/packages/llm/llm-deepseek/src/config.ts#L114-L118)、[adapter.ts L138–150](https://github.com/deepseek-ai/deepseek-harness/blob/571902028a75c64c1d767f4ae5fd099485f0ddf0/packages/llm/llm-deepseek/src/adapter.ts#L138-L150)、[API Key 插件 L17–49](https://github.com/deepseek-ai/deepseek-harness/blob/571902028a75c64c1d767f4ae5fd099485f0ddf0/packages/llm/llm-deepseek-api-key/src/index.ts#L17-L49)。不能把这里的 `output_config.effort` 原样塞入 XunJie 当前 `/chat/completions`。

通用 `llm-pi-ai` 把 providers 定义为以 route 为 key 的字典，每个 route 可声明协议、baseURL、凭据引用、模型表、逐模型覆盖、compat 方言。已知目录可以继承，未知网关须自足声明；只校验变化的 provider，不让另一个损坏旧 provider 阻止修复。依据：[config.ts L91–182、L364–368](https://github.com/deepseek-ai/deepseek-harness/blob/571902028a75c64c1d767f4ae5fd099485f0ddf0/packages/llm/llm-pi-ai/src/config.ts#L91-L182)。

前端不是直接写本地状态后显示保存：调用 `credentials.set/unset`；`settings.mutate(ns,ops,expectedRevision)` 区分 written/conflict/refused；模型发现走独立 `llm.discoverModels`。依据：[operations.ts L33–98](https://github.com/deepseek-ai/deepseek-harness/blob/571902028a75c64c1d767f4ae5fd099485f0ddf0/packages/client/ui-settings-models/src/client/operations.ts#L33-L98)。页面 store 汇合 provider directory、后端设置和脱敏 credential describe，旧异步响应用 generation 丢弃：[store.ts L1–7、L169–215](https://github.com/deepseek-ai/deepseek-harness/blob/571902028a75c64c1d767f4ae5fd099485f0ddf0/packages/client/ui-settings-models/src/client/store.ts#L169-L215)。XunJie 已有本人设置 CAS/后台 ACK/脱敏 Key，不需要重建同等 Cordis Remote 层。

### 3.2 模型发现不等于能力探测

通用 discovery 支持 `data:[]` 和 `models:{}` 两种列表；capacity 识别多种供应商拼写，缺项保持未知。上下文包括 contextWindow/context_window/context_length/max_input_tokens/limit.context；输出包括 maxOutputTokens/max_output_tokens/maxTokens/max_tokens/limit.output/top_provider.max_completion_tokens。依据：[discovery.ts L181–229](https://github.com/deepseek-ai/deepseek-harness/blob/571902028a75c64c1d767f4ae5fd099485f0ddf0/packages/llm/llm-pi-ai/src/discovery.ts#L181-L229)。

它没有用一次 `/models` 成功去证明所有模型支持任意思考等级或附件；专用 DeepSeek API Key 通道甚至返回配置的 advisory catalog，不是远程逐模型实测。手填 capability 和发现结果应保留来源差别。列表读取有大小界限、取消，不自动跟随重定向；模型发现只列举，不应顺带计费生成。依据：[discovery.ts L117–159、L269–362](https://github.com/deepseek-ai/deepseek-harness/blob/571902028a75c64c1d767f4ae5fd099485f0ddf0/packages/llm/llm-pi-ai/src/discovery.ts#L269-L362)。

## 4. low/high/max 和上限如何生效

专用 DeepSeek Messages：`off` 发 thinking disabled；low/high/max 发 thinking enabled，加 `output_config.effort`。调用值优先，然后 provider 默认，未指定默认 high；禁用部署只允许 off。依据：[serialize.ts L147–159](https://github.com/deepseek-ai/deepseek-harness/blob/571902028a75c64c1d767f4ae5fd099485f0ddf0/packages/llm/llm-deepseek/src/serialize.ts#L147-L159)。

通用适配器支持模型自己的 reasoningEfforts 映射，区分未声明（继承）、false（关闭）、显式字典（支持等级到供应商值）。max/xhigh 只有显式映射才出现；显式不支持会抛 UNSUPPORTED_REASONING_EFFORT，绕过 SDK 的隐式 clamp。依据：[catalog.ts L224–231、L630–636、L719–772](https://github.com/deepseek-ai/deepseek-harness/blob/571902028a75c64c1d767f4ae5fd099485f0ddf0/packages/llm/llm-pi-ai/src/catalog.ts#L719-L772)、[models.ts L60–67](https://github.com/deepseek-ai/deepseek-harness/blob/571902028a75c64c1d767f4ae5fd099485f0ddf0/packages/llm/llm-pi-ai/src/models.ts#L60-L67)、[adapter.ts L169–180](https://github.com/deepseek-ai/deepseek-harness/blob/571902028a75c64c1d767f4ae5fd099485f0ddf0/packages/llm/llm-pi-ai/src/adapter.ts#L169-L180)。

compat 还声明 supportsReasoningEffort、thinkingFormat、maxTokensField、requiresReasoningContentOnAssistantMessages 等，表明“OpenAI-compatible”不是完全相同的请求体。依据：[config.ts L258–284](https://github.com/deepseek-ai/deepseek-harness/blob/571902028a75c64c1d767f4ae5fd099485f0ddf0/packages/llm/llm-pi-ai/src/config.ts#L258-L284)。

专用 DeepSeek fallback context 为 1,000,000，max output 为 256,000，逐模型、显式调用可覆盖；这是该实现的默认值，不是本文对真实账号模型能力的独立认证。通用 pi-ai fallback 分别为 262,144/32,768，且 defaultMaxTokens 只是缺能力信息时的 fallback，不会自动成为每请求 cap。显式模型 maxTokens 才记录到 configuredMaxTokens，最终 call 自己的 maxTokens 优先。依据：[defaults.ts L3–8](https://github.com/deepseek-ai/deepseek-harness/blob/571902028a75c64c1d767f4ae5fd099485f0ddf0/packages/llm/llm-deepseek/src/defaults.ts#L3-L8)、[config.ts L64–68、L129–139](https://github.com/deepseek-ai/deepseek-harness/blob/571902028a75c64c1d767f4ae5fd099485f0ddf0/packages/llm/llm-pi-ai/src/config.ts#L129-L139)、[adapter.ts L328–339、L416–421](https://github.com/deepseek-ai/deepseek-harness/blob/571902028a75c64c1d767f4ae5fd099485f0ddf0/packages/llm/llm-pi-ai/src/adapter.ts#L328-L339)。

## 5. 流、保活、停止与凭据热更新

- 超时：两远程适配器默认 streamIdleTimeoutMs=300000。零外部 import 的 [timeout 工具 L135–194](https://github.com/deepseek-ai/deepseek-harness/blob/571902028a75c64c1d767f4ae5fd099485f0ddf0/packages/util/timeout/src/index.ts#L135-L194) 只在一次 iterator.next 未决时挂计时器；pulse 重置；消费侧处理时间不算供应商停顿。不要称其“思考上限”。
- 保活：[sse.ts L13–26](https://github.com/deepseek-ai/deepseek-harness/blob/571902028a75c64c1d767f4ae5fd099485f0ddf0/packages/llm/llm-deepseek/src/sse.ts#L13-L26) 通过 eventsource-parser 处理完整帧，comment 心跳和 JSON event 都 pulse；无完整终止事件报流中断，不能把截断内容当成功。
- 思考/正文分开：[translate.ts L45–87、L143–165](https://github.com/deepseek-ai/deepseek-harness/blob/571902028a75c64c1d767f4ae5fd099485f0ddf0/packages/llm/llm-deepseek/src/translate.ts#L45-L87) 将 thinking/text 映射成不同块和 delta；仅思考没有正文不等于模型从未活动。XunJie 可仅消费“正在思考”的活动信号，沿本任务不保存内部思维链，不必照搬全文持久化。
- 取消：[adapter.ts L65–88](https://github.com/deepseek-ai/deepseek-harness/blob/571902028a75c64c1d767f4ae5fd099485f0ddf0/packages/llm/llm-deepseek/src/adapter.ts#L65-L88) 和 [pi-ai adapter.ts L426–455](https://github.com/deepseek-ai/deepseek-harness/blob/571902028a75c64c1d767f4ae5fd099485f0ddf0/packages/llm/llm-pi-ai/src/adapter.ts#L426-L455) 把 caller abort 与 idle timeout 分型，取消 controller 释放 socket；不 await 可能永远不 settle 的旧 iterator drain，避免“超时以后仍挂死”。
- 请求快照：[pi-ai adapter.ts L344–391](https://github.com/deepseek-ai/deepseek-harness/blob/571902028a75c64c1d767f4ae5fd099485f0ddf0/packages/llm/llm-pi-ai/src/adapter.ts#L344-L391) 在凭据 await 之前固定 model/profile/SDK 集合；配置改变在下一请求生效，不把新 endpoint 与旧 Key 拼接。Key 每请求通过 credentials seam 解引用，不靠重启环境变量。
- 显式凭据缺失直接失败，不能落到另一个 ambient Key；[pi-ai index.ts L188–215](https://github.com/deepseek-ai/deepseek-harness/blob/571902028a75c64c1d767f4ae5fd099485f0ddf0/packages/llm/llm-pi-ai/src/index.ts#L188-L215)。这一点与 XunJie 每账号隔离一致，应继续保留。
- SDK 重试 `maxRetries:0`，另有 provider-owned recovery 策略；[adapter.ts L127–143](https://github.com/deepseek-ai/deepseek-harness/blob/571902028a75c64c1d767f4ae5fd099485f0ddf0/packages/llm/llm-pi-ai/src/adapter.ts#L127-L143)。dsh 更上层默认五次重试不自动适用于 XunJie 已批准调用预算；本文不建议顺带放开。

## 6. 可采用清单及当前 XunJie 差距

本节对照研究时当前工作树，含主会话未提交改动，不是对 main 发布版本的验收。

| XunJie 接缝 | 当前事实 | 采用点与完成判据 |
| --- | --- | --- |
| [inactivity.ts](../../apps/teaching/server/personal-agent/inactivity.ts) 与 [openai-compatible.ts](../../apps/teaching/server/tutoring/openai-compatible.ts) | 已改 600秒 idle、bytes 重置；仍有 remainingMs 可组合总截止 | 保留 socket/idle 故障恢复，个人通道不再叠加45秒/300秒总时长；有 heartbeat/思考活动可跨旧截止，停止立即结束；老课程策略只按负责人当前明确授权改变 |
| SSE 手写按行 JSON | 不支持完整 SSE 多行 data、末尾半帧仍可能解析；目前收到字节即保活 | 可采用 dsh sse.ts 的完整帧原则；已有依赖若无 eventsource-parser，不为十几行适配引入整个 Harness；分别验证拆字节UTF8、多行data、comment、缺终止、中途错误 |
| 模型目录 | 目前只认 data[]、context_window/max_output_tokens/effort.supported_levels | 可直接移植 discovery 的小型 capacity/label/readListing 逻辑并保留来源；稀疏目录保持未知，手工值优先，不用目录成功伪证全部能力 |
| 思考等级 | model.reasoningLevels + user efforts，当前发 reasoning_effort；DeepSeek host 另加 thinking enabled | 模型/协议明确 wire 方言；所有保存等级经 exact model 验证，不支持报错且不降档；low/high/max 检查实际出站字段，再分别记录真实响应/终止状态 |
| contextWindow/maxOutput | 已接到 selection，但空白 fallback仍16K/4096，token校验固定不超过1,048,576；输入按UTF8字节保守上界 | 采用“能力/显式cap/未知”区分；空白不能默默小帽替代供应商默认；字节上界不是实际token计数，不能以token精确值展示；不无声截断政策 |
| 附件能力 | inputTypes 保存并带到 selection，但 complete 当前仍只有文本 messages | 不是实际支持 image/video/pdf。dsh adapter.ts L394–415 先核模态再用持久附件服务投影；XunJie 应显式展示当前未接能力，或完成真实上传/读取/序列化，不能只勾选后声称可用 |
| 配置热更新与凭据 | 本人 CAS、加密、脱敏读取、在途选择已存在 | 延续 prepareCall固定完整快照，下一发送消费新配置；不必迁移到Cordis；测试在凭据解析await期间改 endpoint/model/Key 不混用 |
| UI 保存/测试 | 已有后台 ACK，配置测试与生成分开 | 保持这条接线；目录/探测成功文案只说明确实验证的事实，不宣称 paid generation 或推理等级已实测 |

推荐先采用零依赖 idleWatchdog 原则、目录字段解析、exact-model等级校验与cap语义；按原UI契约补齐可观察的“等待/思考/正文/停止/失败”。整体包暂不安装：两个适配器都依赖 Cordis、settings、credentials、LLM seam 等宿主，通用包还依赖 pi-ai；为当前单一 Node HTTPS 通道引入它们并不节省接线成本。

## 7. 验证与交接

已通过 GitHub commit/tree API 锁定源码、逐文件读正文和行号、核 package及根许可证；只读本机公开 runtime版本。未读取 `~/.dsh`，未调用真实 API，未运行dsh，未更改应用或依赖。研究结论不等于3444已经实现/部署/真实模型验收。实际采用代码、版权通知、工程和真实调用结果由主任务分别记录；受保护产品基线待授权维护者汇总。
