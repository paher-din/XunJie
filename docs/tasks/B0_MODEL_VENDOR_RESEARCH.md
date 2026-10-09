# B0：模型、数据处理与预算提案复核

核验日期：2026-10-09（Asia/Shanghai）。主责：B。关联 [Issue #3](https://github.com/paher-din/XunJie/issues/3)、[B0 交接稿](B0_模型帮助分析契约.md)。状态：独立研究提案，D-02 未批准；不接入真实数据、不运行付费调用、不决定采购/部署。

本稿替代原 PR 研究入口，纠正精确型号、区域阶梯与结构化能力。旧 reference 文件移除前仍保留但不作为本修订的当前结论。官方链接存在不代表事实成立：表中分别注明正文可核验、条件/不足或读取限制；第三方价表不作关键主张依据。

## 1. 候选、API 标识与价格口径

建议首版用一个供应商/一个主模型覆盖教师生成、学生辅导和候选分析，以便预算和回归有明确对象；此建议尚未批准，不默认启用降本模型或自动跨供应商降级。保留海内外候选而不预设地域；型号可用不等于已证明教学效果、账号可调用或 NFR 达标。

下列均为每100万 token 的标准在线价格，输入指未命中缓存，输出包括供应商计费的推理部分；优惠/长上下文条件另列。USD 与人民币分别展示，不能混加或直接以数值排序。

| 原候选 / 精确调用标识 | 输入 / 输出及上下文 | 证据状态与限制 |
| --- | --- | --- |
| GPT-5.6 Terra / `gpt-5.6-terra` | USD 2 / 12；1,050,000 | 官方证实；缓存读0.20，写入按未命中输入1.25倍；>272K输入时整请求输入2倍/输出1.5倍，[型号页](https://developers.openai.com/api/docs/models/gpt-5.6-terra) |
| GPT-5.6 Luna / `gpt-5.6-luna` | USD 0.20 / 1.20；1,050,000 | 官方证实；缓存读0.02，缓存写入/长上下文条件同型号页；降本对照，不默认额外接入，[型号页](https://developers.openai.com/api/docs/models/gpt-5.6-luna) |
| GPT-5.5 / `gpt-5.5-2026-04-23`或批准别名 | USD 5 / 30；1,050,000 | 官方证实；缓存读0.50，长上下文和地域加价须计入；不静默替换为其他GPT型号，[型号页](https://developers.openai.com/api/docs/models/gpt-5.5) |
| Claude Sonnet 5 / `claude-sonnet-5` | USD 2 / 10；1M | 官方证实，已是标准价；仍可用但属legacy，不用第三方介绍价差异改价，[型号页](https://platform.claude.com/docs/en/models/sonnet-5/overview) |
| Claude Opus 5 / `claude-opus-5` | USD 5 / 25；1M | 官方定价/型号口径，实际平台和缓存价格按冻结配置复核，[定价](https://platform.claude.com/docs/en/about-claude/pricing) |
| Gemini 3.1 Pro / `gemini-3.1-pro-preview` | USD 2 / 12（输入≤200K）；>200K为4 / 18 | 官方证实的是Preview ID，不写成已确认GA；缓存及grounding另计，[定价](https://ai.google.dev/gemini-api/docs/pricing) |
| Gemini 3.8 Flash / `gemini-3.8-flash` | USD 0.75 / 3.75，至2026-12-31；2027-01-01起1.50 / 7.50 | 官方证实；跨期预算按后续价格；缓存读/存储和工具费用另列，不仅按促销价预算，[定价](https://ai.google.dev/gemini-api/docs/pricing) |
| DeepSeek-V4.1-Flash / `deepseek-flash` | 人民币1 / 4（闲时），2 / 8（峰时）；1M，最大输出384K | 官方证实；旧Flash别名可能改路由，记录实际版本；缓存读闲/峰0.02 / 0.04，[定价](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) |
| DeepSeek-V4-Pro / `deepseek-v4-pro`，公开页版本V4-Pro-0813 | 人民币4.5 / 13.5（闲时），9 / 27（峰时）；1M | 官方证实；缓存读闲/峰0.15 / 0.30；不得按闲价声称全天成本，[定价](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) |
| Qwen3-Max / `qwen3-max-2026-01-23` | 北京USD：≤32K为0.359 / 1.434；32～128K为0.574 / 2.294；128～256K为1.004 / 4.014 | 官方证实；262,144窗口，不是其他Max的1M。国际地域也有不同阶梯，不能套北京价或其他型号价，[价表](https://www.alibabacloud.com/help/en/model-studio/model-pricing)、[型号页](https://help.aliyun.com/zh/model-studio/model-qwen3-max) |
| GLM-5.3 / `glm-5.3` | 人民币8 / 28；1M，缓存读2 | 官方证实；5.2同价，缓存存储限时免费不等于永久免费；思考/输出上限应按具体接口核验，[定价](https://docs.bigmodel.cn/cn/guide/start/pricing)、[型号](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3.md) |
| Kimi K3 / `kimi-k3` | 人民币20 / 100；1M | 官方平台参数；调用需满足充值和账号等级，赠券可用性有限；始终思考、默认max，[平台](https://platform.kimi.com/)、[指南](https://platform.kimi.com/docs/guide/kimi-k3-quickstart) |
| Kimi K2.7 Code / `kimi-k2.7-code` | 人民币6.5 / 27；256K | 官方平台口径；不能把K3的strict保证推广给此型号，缓存写入/命中另核，[价格说明](https://platform.kimi.com/docs/pricing/chat) |
| Seed-2.1-Pro / Turbo / Evolving | 原稿价为人民币6 / 30、3 / 15、6 / 30；Pro原256K有新快照1M线索 | 暂不能稳定读取官方SPA完整正文，保留待核实而非沿用“官方已证实”。官方索引给出Pro-260915线索，非已冻结ID；补精确ID、推理方式、窗口和价表后才可选，[模型列表](https://docs.volcengine.com/docs/ark/model-list?lang=zh)、[价表](https://docs.volcengine.com/docs/ark/model-pricing) |

DeepSeek 峰时按公开页为北京时间周一至周五（中国法定节假日除外）09:00–12:00、14:00–18:00，其余为空闲。价格/别名仍可能调整，冻结配置时记录核验日期、价表版本和实际返回模型；不能将 API 可调用推定为本项目地区/账号已有访问。

原 `Gemini Flash/Qwen3-Flash/GLM-Flash` 泛称不作为可冻结 API ID。没有精确版本/区域/能力证据时列参数缺口，不擅自选一个新版本代替。私有化权重与按量API不是同一成本方案，本稿没有私有化算力报价。

## 2. 结构化输出、接口与实际适配

| 供应商 | 已核验的方式 | 应用侧边界与待确认 |
| --- | --- | --- |
| OpenAI | Chat Completions 的 response_format/json_schema/strict；Responses 使用 text.format，[结构化指南](https://developers.openai.com/api/docs/guides/structured-outputs) | 选定接口/模型快照/SDK版本后验证拒绝、截断、Schema子集与实际usage；不能混用参数路径 |
| Anthropic | 原生 output_config.format；strict工具需strict=true，单有input_schema+强制tool_choice不构成同等保证，[指南](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) | 原生JSON与Citations同请求不兼容，可返回400；本项目默认业务引用，不要求厂商Citations；不使用过时参数证明适配 |
| Gemini | 原生JSON Schema的支持子集；函数调用与输出格式分开，[指南](https://ai.google.dev/gemini-api/docs/structured-output) | thinking计费、功能组合和字段映射按实际版本验，不因SDK统一而假设全Schema约束被服务端执行 |
| DeepSeek | JSON Output、Tool Calls、OpenAI/Anthropic格式，官方还列Responses接口，[JSON指南](https://api-docs.deepseek.com/zh-cn/guides/json_mode)、[价表](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) | JSON Object不是指定Schema保证；仍要本地Schema/引用/政策校验；协议兼容不代表所有工具/参数同义 |
| Qwen3-Max | 非思考模式JSON Object；不在当前JSON Schema型号列表，[指南](https://help.aliyun.com/zh/model-studio/qwen-structured-output) | 写明模式，不能给该候选挂原生strict标签；不同地域工具能力需分别核实 |
| GLM-5.3 | 官方结构化指南以JSON Object和客户端校验为核心，[指南](https://docs.bigmodel.cn/cn/guide/capabilities/struct-output.md) | 原生strict保证证据不足，明确本地校验/修复限额，不填“与其他家完全等价” |
| Kimi K3 | json_schema+strict约束最终message.content，不能解析reasoning_content作教学输出，[指南](https://platform.kimi.com/docs/guide/kimi-k3-quickstart) | K2.7 Code单独验证；工具/联网实际接口及可用性未通过本项目实测 |
| 豆包 | 官方结构化beta与在线推理文档有支持线索，[beta](https://docs.volcengine.com/docs/ark/structured-output-beta?lang=zh)、[部署](https://docs.volcengine.com/docs/ark/deployment-overview?lang=zh) | 正文读取限制、beta/推理方式及精确ID待核验。移除“必须先建Endpoint”的结论，实际可直接Model ID的路径以官方确认后使用 |

AI SDK 的供应商适配可减少重复接入代码，但[Anthropic适配页](https://ai-sdk.dev/providers/ai-sdk-providers/anthropic)本身区分原生输出和jsonTool路径。项目尚无已锁定 SDK/依赖组合，不能写“接入成本相近/功能一致”作为实测结论。

成功的严格输出至多支持适用Schema子集的格式约束，不证明教学语义、权限、原始证据或引用真实。应用仍验证原始约束、存在/版本/范围、政策和时效；供应商拒绝/截断/异常返回不是结构化成功。教学审核依据是 [TECH §4.2/6.1/6.2/6.3](../product/TECH_DESIGN.md)，无“6.6”引用。

本项目默认只检索获准课程文本，业务引用由 A/C 解析后绑定 ObjectRef/原始证据。厂商 file-search/Citations/grounding/联网能力不是自动授权；不默认安装联网、代码执行、远程文件或浏览器工具。

## 3. 数据、地域和第三方处理

| 主张 | 2026-10-09核验结论 | D-02/D-03尚需落实 |
| --- | --- | --- |
| OpenAI API默认不训练 | 官方证实，主动分享另有条件，[数据控制](https://developers.openai.com/api/docs/guides/your-data) | 默认滥用日志/有状态资源、ZDR资格/例外、具体存储/处理地域不能由“不训练”推断 |
| Anthropic商业API不训练 | 有官方支持；保留安排按模型/功能不同，Covered Models及外部集成例外单列，[数据处理](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention) | 本项目候选及选定功能的留存、组织安排、第三方范围；不用消费端条款替代API |
| Gemini付费不改进产品 | 官方证实；仍有安全日志及跨区域条款，Search grounding额外保留相关上下文/输出30天，[条款](https://ai.google.dev/gemini-api/terms) | 是否付费层、所用地域、是否启用grounding；免费层禁用于真实试点是本提案的保守建议，非已冻结政策 |
| 百炼API不训练 | 官方FAQ支持且提依法存储，[FAQ](https://help.aliyun.com/zh/model-studio/faq-about-alibaba-cloud-model-studio) | 接入/存储地域与推理范围不同，按[地域说明](https://help.aliyun.com/zh/model-studio/regions)及合同核；不用“北京URL”自动证明全部数据不出境 |
| Kimi API不训练 | 专属安全说明支持，[API安全](https://www.kimi.com/help/kimi-api/api-data-security) | 具体账号/功能的留存、工具数据流和处理地区仍需确定 |
| 豆包不训练 | 适用协议有条件/主动授权等例外，[协议](https://docs.volcengine.com/docs/ark/specific-model-service-agreements?lang=zh) | SPA读取限制及实际产品条款需完整核；审核、排障/缓存等与训练是不同处理 |
| DeepSeek / GLM默认API不训练 | 本次API专属明确承诺证据不足；不写成肯定，也不认定必然训练，[DeepSeek协议](https://cdn.deepseek.com/policies/zh-CN/deepseek-open-platform-terms-of-service.html)、[GLM文档入口](https://docs.bigmodel.cn/) | 补供应商专属条款/合同；未落实前不向其发送真实学生资料 |
| 国内节点/开放权重保证不出境 | 不能仅凭品牌/节点标签证实；自部署权重不等于整套系统无外部流量 | 对实际供应商/端点、日志/运维/检索、许可证及处理人员逐项核；采购与数据决定归负责人 |

发送范围建议：仅当前获准课程/学生必要正文和引用，去掉凭据、其他学生及未授权私有答案；提示/输出/缓存/错误日志/工具请求分别画数据流。代码、资料、学生消息不是普通运维日志，供应商返回字段也不能成为事实身份认证。

留存期限、区域要求、访问人员、撤回/删除途径为未冻结部署条件。需要供应商工具时重新评审其数据处理与费用；不训练、ZDR、地域驻留三个概念分别记录，不能相互替代。现阶段只用合成工程样例。

## 4. 可批准的预算对象提案

### 主方案及适用条件（未批准）

B 建议以 OpenAI API `gpt-5.6-terra` 作为三类流程的主模型提案，接口优先建议 Responses 的 `text.format`/JSON Schema strict，不启用厂商托管工具。选择依据是[该型号页](https://developers.openai.com/api/docs/models/gpt-5.6-terra)明确支持结构化输出且价格可核，[输出指南](https://developers.openai.com/api/docs/guides/structured-outputs)提供协议约束，[API数据条款](https://developers.openai.com/api/docs/guides/your-data)明确默认不训练；这些使工程协议和预算有可核依据，不证明它比其他候选教学质量更好。

启用条件：调用组织/部署和访问资格符合[官方支持地域](https://developers.openai.com/api/docs/supported-countries)，账号具备该模型的付费访问与配额，负责人批准 USD 100 的课程上限及下列配额，并按 D-03 接受实际数据处理/留存安排。建议 `store=false`，但这不消除默认最多30天的滥用监控日志（法律或服务保护需要时可更长）；ZDR需另行获得资格，不能因“不训练”默认获准发送学生数据。当前未核实本项目满足这些条件，也未获调用授权。

条件不满足时由负责人重新审议地域适配的候选及其条款/预算，不绕过供应商地域限制或自动换供应商，也不把 DeepSeek 成本对照当备用模型。公开页未给出独立日期快照时只记录其实际 API ID、配置版本和响应模型，不编造快照；教学语义、30次延迟/失败采样和限额行为仍按 E1～E10 与 NFR-02/06 后续验证，未实测前不声称主方案达标。

### 配额与成本假设

以下都是建议假设，不是已确认课程周期/人员或保证调用量。时间窗定义为一次主项目及相关后续任务，具体天数待 D-01/D-04；先取5名学生、1名教师作保守数量示例。

| 配额建议 | 数字与范围 |
| --- | --- |
| 学生主动求助 | 每学生30轮，两任务合计，共150轮 |
| 教师生成/局部修改/反馈请求 | 教师总计20轮；均是建议，不自动发布活动/评价 |
| 候选分析 | 每学生20轮，共100轮；只在获准低频节点，采集暂停不排被动分析 |
| 课程总量 | 270轮，含最多3次调用/轮，共810次供应商请求上限；重试和一次修复也占配额 |
| 独立时间约束 | 含排队/修复45秒；不以多付费或更换模型绕过 |

平均示例采用单调用2,000输入、500计费输出（含推理），每轮保守按3次。压力示例12,000输入、4,000计费输出、同样3次；这些不是已实测均值或已冻结token上限。选型后据实际 usage/输出约束更新，关键政策不能为凑2K而静默截断。

```json
{
  "assumptionOnly": true,
  "students": 5,
  "helpRoundsPerStudent": 30,
  "teacherRounds": 20,
  "analysisRoundsPerStudent": 20,
  "maxCallsPerRound": 3,
  "meanTokens": {"input": 2000, "billedOutput": 500},
  "stressTokens": {"input": 12000, "billedOutput": 4000},
  "scenarios": [
    {"id": "terra_single_model", "currency": "USD", "inputRate": 2, "outputRate": 12, "meanCost": 8.1, "stressCost": 58.32, "suggestedCap": 100},
    {"id": "deepseek_pro_peak_single_model", "currency": "CNY", "inputRate": 9, "outputRate": 27, "meanCost": 25.515, "stressCost": 174.96, "suggestedCap": 250}
  ]
}
```

主方案建议课程总预算上限USD 100。DeepSeek Pro按峰价的人民币250元仅为同调用量的成本对照；其API数据承诺尚不足，不能直接启用或自动作为备用。两种预算不混加、不证明教学质量；负责人改选其他候选时按其真实区域阶梯重新计算。压力示例之外的上下文/输出、价格变化、缓存或工具费用可能提前耗尽预算，不能宣称金额保证完成全部学习任务。

先记录源币种，不跨币种加总/排名。实际比较须由负责人选统一币种、汇率来源与核验日后重算；未确定汇率不填零或编造兑换。上限和配额未经 D-02 批准不执行付费调用。

### 成本项目和降级

每次调用记录实际模型/配置、输入未命中/缓存读/写/存储、可见输出/推理、工具次数、修复/重试及未知用量。示例只计未命中文本，不计算未启用的工具；启用后必须另加。如OpenAI Web Search的按次和搜索内容费用、Gemini grounding的按查询和共享免费额度，分别按[OpenAI价表](https://developers.openai.com/api/docs/pricing)、[Gemini价表](https://ai.google.dev/gemini-api/docs/pricing)重算；缓存折扣不是无条件抵扣。

调度在新调用前按批准价格和token限额保留预算，usage未知保留未知和保守占用，不退成零。课程预算或账号配额用尽：停止新的供应商调用，保留作品、问题、已有反馈/教师人工复核；明确人工入口或系统降级状态，不补造模型回复。不自动切模型、供应商或地域。

## 5. 冻结清单和验证边界

D-02 至少确认：主供应商/精确模型及版本、接口/SDK组合/结构化模式、思考与输出计费限制、价格日期/阶梯/缓存及工具、真实数据范围/训练使用/留存/区域、币种/总金额/配额及降级。访问资格/账号RPM/TPM、冷Schema编译、超时/失败率与教学语义需实际条件具备后测；公开价格/型号表不证明本项目服务可用。

本次研究为官方正文复核、受限页面的透明标注和预算算术，未实测模型/SDK、延迟、计费、条款履行或中文教学效果。不同部署合同/账号条件未确定时不作一致承诺；第三方榜单/厂商质量宣传不代替真人课程审阅。研究修订不冻结架构，也不授权密钥、数据库、CI/CD、公开部署或数据删除。
