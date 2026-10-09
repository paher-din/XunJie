# 模型与数据预算调研（D-02 提案）

整理日期：2026-10-08（Asia/Shanghai）。本文件是 B 角色在 B0 阶段提交的 D-02 评审起点，属于**提案**：以下「推荐」不等于已批准的架构或预算，真实数据与付费调用前需产品/技术负责人确认。价格为供应商公开价目（截至 2026-10），非本项目实测；延迟为厂商/第三方口径，需在 B4 阶段实测。

## 结论摘要

> 本表为**海内外并列候选**，不预设地域倾向；最终主模型、降本模型与地域由产品/技术负责人在 D-02 冻结时决定。

| 决策项 | 建议 | 状态 |
| --- | --- | --- |
| 主模型（教师生成 + 学生辅导，质量优先） | 海外：OpenAI GPT-5.6 Terra / Anthropic Claude Sonnet 5；内地：DeepSeek-V4-Pro / 通义千问 Qwen3-Max / 智谱 GLM-5.3 / Kimi K3 / 豆包 Seed-2.1-Pro | 并列候选，待批准 |
| 降本模型（候选分析/状态提取，量大低延迟） | 海外：OpenAI GPT-5.6 Luna / Gemini Flash；内地：DeepSeek-V4.1-Flash / Qwen3-Flash / GLM-Flash / 豆包 Seed-2.1-Turbo | 并列候选，待批准 |
| 结构化输出 | 各家均支持原生结构化输出/工具调用：海外 OpenAI/Gemini JSON Schema strict、Claude tool use；内地 DeepSeek Json Output、Qwen Structured Outputs、GLM/Kimi/豆包结构化输出；由 AI SDK 层统一 | 推荐 |
| 引用能力 | 配合获准检索（file search / citations / grounding / 各家联网检索），自行绑定 `ObjectRef`，非原生输出对象引用 | 推荐 |
| 区域与数据不出境 | 海外付费 API 默认「不用于训练」但数据出境；内地模型可用境内节点/私有化实现数据不出境 | 待决策（结合 D-03） |
| 计价 | 海外按美元、内地按人民币；MVP_SPEC 明确「美元/人民币预算由 D-02 冻结」 | 待冻结 |
| 数据条款 | 各付费 API 默认「不用于训练」；禁用免费层（可能用于改进产品） | 待核实政策 |
| 总预算/配额 | 每账号/课程调用配额 + 单轮 ≤3 次 + 单轮 ≤45 秒 + 试点总量上限兜底 | 待批准 |

## 候选对比（2026-10，海外 USD、内地人民币 / 每 100 万 token）

### 海外模型（数据出境）

| 供应商/模型 | 输入 | 输出 | 上下文 | 结构化输出 | 引用/检索 | 区域/数据条款 |
| --- | --- | --- | --- | --- | --- | --- |
| OpenAI GPT-5.6 Terra | \$2.00 | \$12.00 | 1.05M | 原生 JSON Schema strict | file search / web search 工具 | 数据出境；默认不用于训练；区域驻留 +10% |
| OpenAI GPT-5.6 Luna | \$0.20 | \$1.20 | 1.05M | 原生 JSON Schema strict | file search / web search 工具 | 同上 |
| OpenAI GPT-5.5 | \$5.00 | \$30.00 | 1.05M | 原生 strict | 同上 | 同上 |
| Anthropic Claude Sonnet 5 | \$2.00 | \$10.00 | 1M | 无原生 `response_format`，用 tool use + `input_schema` | 原生 Citations API | 数据出境；默认不用于训练 |
| Anthropic Claude Opus 5 | \$5.00 | \$25.00 | 1M | 同上 | 同上 | 同上 |
| Google Gemini 3.1 Pro | \$2.00 | \$12.00 | 1M | 原生结构化输出（JSON Schema） | grounding（Search grounding） | 数据出境；付费层「不用于改进产品」 |
| Google Gemini 3.8 Flash | \$0.75 | \$3.75 | 1M | 原生结构化输出 | grounding | 同上 |

### 内地模型（可境内节点/私有化）

| 供应商/模型 | 输入 | 输出 | 上下文 | 结构化输出 | 引用/检索 | 区域/数据条款 |
| --- | --- | --- | --- | --- | --- | --- |
| DeepSeek-V4.1-Flash | ¥1（闲时缓存未命中）/ ¥2（峰时） | ¥4（闲时）/ ¥8（峰时） | 1M | 原生 Json Output + Tool Calls | 检索需自建 | 境内直连；官方声明 API 数据不用于训练 |
| DeepSeek-V4-Pro | ¥4.5（闲时）/ ¥9（峰时） | ¥13.5（闲时）/ ¥27（峰时） | 1M | 原生 Json Output + Tool Calls | 检索需自建 | 同上 |
| 通义千问 Qwen3-Max | 国际 \$2.0–2.5；北京节点 \$1.65 | 国际 \$6.0–7.5；北京节点 \$4.95 | 1M | 原生 Structured Outputs | Web Search | 阿里云百炼含境内节点；数据不出境待核实 |
| 智谱 GLM-5.3（5.2 同价） | ¥8 | ¥28 | 1M | 结构化输出 | 联网检索 | 国内直连、人民币计费；开源可私有化 |
| Kimi K3（旗舰） | ¥20 | ¥100 | 1M | JSON 模式/结构化输出 | Web Search 工具 | 国内平台（月之暗面） |
| Kimi K2.7 Code（编码） | ¥6.5 | ¥27 | 256K | 结构化输出 | Web Search 工具 | 同上 |
| 豆包 Seed-2.1-Pro | ¥6 | ¥30 | 256K | 结构化输出 | 联网检索 | 火山方舟国内节点、人民币计费 |
| 豆包 Seed-2.1-Turbo | ¥3 | ¥15 | 256K | 结构化输出 | 联网检索 | 同上 |
| 豆包 Seed-Evolving（Coding/Agent） | ¥6 | ¥30 | 1M | 结构化输出 | 联网检索 | 同上 |

> 内地模型价格以各官方定价页为准，人民币与美元并存（阿里云百炼国际站以 USD 展示，国内站以人民币计费）。DeepSeek 峰谷分时：北京时间工作日 09:00–12:00、14:00–18:00 为高峰，其余为空闲，空闲为高峰半价。
> Claude Sonnet 5 价格在两处第三方来源存在 \$2/\$10 与 \$3/\$15 差异（介绍价结束时间口径不同），以 Anthropic 官方定价页为准；下单前须在 [anthropic.com/pricing](https://www.anthropic.com/pricing) 复核。
> Gemini 3.8 Flash 的 \$0.75/\$3.75 为促销价，2026-12-31 后按官方页变更为 \$1.50/\$7.50；预算须按变更后口径保守估算。

## 结构化输出与引用能力

- **OpenAI**：`response_format: { type: "json_schema", json_schema: { strict: true } }` 提供语法级 schema 约束，Pydantic/Zod 可直接生成 schema；适合本项目的 `TeachingAction`、`LearnerStateCandidate`、`TeacherProposal` 契约。
- **Anthropic Claude**：无 `response_format` 字段，通过定义 tool 的 `input_schema` + 强制 `tool_choice` 实现同等的语法级约束，与项目「有限读取工具 + 结构化动作」天然吻合，但需在 AI SDK 适配层统一（AI SDK 已支持多供应商）。
- **Google Gemini**：原生结构化输出（`response_mime_type` + JSON Schema），支持 Zod/Pydantic；函数调用与结构化输出分开。
- **内地模型**：
  - **DeepSeek**：原生 Json Output（`response_format: { type: "json_object" }`）+ Tool Calls，兼容 OpenAI 与 Anthropic 两种协议；最大输出 384K，适合结构化候选。
  - **通义千问 Qwen**：原生 Structured Outputs（JSON Schema）+ Function Calling + Web Search，支持 OpenAI 兼容与 DashScope 双协议。
  - **智谱 GLM**：结构化输出 + Function Calling + 思考模式，OpenAI 兼容协议。
  - **Kimi**：JSON 模式/结构化输出 + 工具调用（含 Web Search），OpenAI 兼容。
  - **豆包 Doubao-Seed**：结构化输出 + 工具调用，火山方舟 OpenAI 兼容协议（需先在控制台创建接入点 Endpoint）。
  - 以上均兼容 OpenAI SDK，AI SDK 可通过供应商适配包接入，接入成本相近。
- **引用**：所有供应商均无「把教学输出自动绑定到业务 `ObjectRef`」的原生能力。项目必须自建引用校验（模型输出携带 `evidenceIds` → 服务端按 `ObjectRef` 的 snapshotId/内容 hash 核验），引用能力由各家检索工具（OpenAI file search、Claude Citations、Gemini grounding、Qwen/GLM/Kimi/豆包联网检索）+ 自建绑定共同提供，不作为选型的决定性差异。

## 数据条款与区域

**海外（数据出境）**：

- **OpenAI**：标准 API 默认「内容不用于训练」；数据驻留（data residency）端点对部分模型 +10%。
- **Anthropic**：API/Team/Enterprise 默认「不基于内容训练」；Fable 5 需要 30 天数据保留。
- **Google Gemini**：付费层「不用于改进产品」；**免费层会用于改进产品，禁用**。

**内地（可境内节点/私有化，数据不出境）**：

- **DeepSeek**：官方声明 API 数据不用于训练；开源权重可私有化部署。
- **通义千问 Qwen**：阿里云百炼含境内节点；具体数据不出境承诺需以阿里云合同条款核实。
- **智谱 GLM**：国内直连、人民币计费；开源可私有化。
- **Kimi（月之暗面）**：国内平台。
- **豆包（火山方舟）**：国内节点（cn-beijing）、人民币计费。

面向中国高校试点，数据不出境可能是合规与采购上的显性优势，但「供应商名称、区域与具体数据条款」是**待确认部署条件**，本文件不代替政策核实；是否要求数据不出境、是否接受出境，需产品/技术负责人结合 D-03（账号、网络、访问人员、保留期限）在真实试点前冻结。

## 决策维度（D-02 冻结时需在地域/供应商间权衡）

本提案不预设地域，以下三个维度交由产品/技术负责人决策：

1. **数据不出境 / 区域驻留**：内地模型可用境内节点或私有化部署实现数据不出境；海外付费 API 默认不训练但数据出境。是否要求数据不出境取决于高校/试点合规口径（关联 D-03）。
2. **中文教学效果**：面向中国高校 CS 课程的中文辅导，内地模型在本土语境上通常更贴近；但本项目尚未实测任何模型的教学语义质量，需 B4 用固定样例 + 人工审阅验证，不能以厂商宣传或榜单代替。
3. **人民币计价与预算口径**：内地模型按人民币计费（MVP_SPEC 已写「美元/人民币预算由 D-02 冻结」），海外按美元；预算估算与配额上限需统一到同一币种口径。

首版仍遵循 PRD「单一供应商/主模型起步」，不同时铺开多模型编排；本小节用于让负责人基于同一张表做地域决策，不代表推荐多供应商。

## 预算与配额估算框架

首版为 1 位教师 + 少量真实学生、低频节点调用。以「每请求 ≈ 2K 输入 + 500 输出（含 reasoning）」粗估（非实测，仅作量级参考）：

- GPT-5.6 Terra：每请求 ≈ (2000×2 + 500×12) / 1e6 ≈ \$0.010。
- GPT-5.6 Luna：每请求 ≈ (2000×0.20 + 500×1.20) / 1e6 ≈ \$0.001。
- DeepSeek-V4.1-Flash（闲时）：每请求 ≈ (2000×1 + 500×4) / 1e6 ≈ ¥0.004。
- 通义千问 Qwen3-Max（北京节点，USD 口径）：每请求 ≈ (2000×1.65 + 500×4.95) / 1e6 ≈ \$0.006。
- 智谱 GLM-5.3：每请求 ≈ (2000×8 + 500×28) / 1e6 ≈ ¥0.030。
- 豆包 Seed-2.1-Turbo：每请求 ≈ (2000×3 + 500×15) / 1e6 ≈ ¥0.014。

> 币种与汇率：内地模型官方以人民币计费，海外以美元；上列换算仅作量级参考（阿里云百炼北京节点按 USD 展示），正式预算由 D-02 按统一币种冻结，不在此做汇率折算。

建议试点期按「账号/课程配额 + 单轮次数/时间上限 + 总量上限」三层兜底：总量预算上限触发后暂停新的模型调用（保存、已有反馈与教师人工审阅不受影响）。**具体配额数字与总预算由产品/技术负责人批准，本提案不自行冻结。**

## 降级方式

首版**不引入自动跨模型降级**（避免帮助行为与数据处理范围静默改变）。主模型不可用/超预算时：确定性降级为 `handoff_teacher` 或保留人工求助入口，不静默切换到不同供应商或不同地域；若需更换模型或地域，显式记录新 `modelConfigVersion` 并重跑 B4 回归（跨地域切换还需重新核对数据处理范围与数据条款）。

## 证据边界

- 价格、上下文窗口、结构化输出、数据条款来自各供应商公开文档与第三方汇总，日期见来源；海内外模型均**未实测**延迟、实际 token 计费、中文教学效果与结构化输出失败率。
- 内地模型价格为官方/官方衍生页 2026-10 口径，人民币与美元并存；豆包结构化输出等能力细节以火山方舟官方文档为准，未逐项实测。
- 结构化输出只能保证「语法上符合 schema」，不能保证教学语义正确；语义边界仍需 6.6 的引用/帮助条件/未知校验与 B4 人工审阅。
- 本文件不决定模型选型，仅作为 B0 的 D-02 评审起点，待产品/技术负责人确认后再进入真实数据与付费调用。

## 一手来源

- OpenAI 定价：https://platform.openai.com/docs/pricing
- OpenAI 模型与能力（GPT-5.5）：https://platform.openai.com/docs/models
- Anthropic 定价：https://platform.claude.com/docs/zh-TW/about-claude/pricing 与 https://www.anthropic.com/pricing
- Google Gemini 定价：https://ai.google.dev/gemini-api/docs/pricing
- Google Gemini 结构化输出：https://ai.google.dev/gemini-api/docs/structured-output
- DeepSeek 模型与价格：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
- 通义千问 Qwen 定价（阿里云百炼）：https://www.alibabacloud.com/help/en/model-studio/model-pricing
- 智谱 AI 定价：https://docs.bigmodel.cn/cn/guide/start/pricing
- Kimi 开放平台：https://platform.kimi.com/
- 火山方舟模型价格（豆包）：https://docs.volcengine.com/docs/ark/model-pricing
- 结构化输出跨供应商对比（第三方）：https://logic.inc/resources/structured-outputs-guide
- 第三方价格汇总（仅供量级参考）：https://stob.ai/blog/claude-model-pricing-comparison-2026 、https://markaicode.com/pricing/openai-api-pricing/ 、https://developer.puter.com/tutorials/gemini-api-pricing/
