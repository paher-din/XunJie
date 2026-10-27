# Agent 过程显示：产品事实与教学场景参考

日期：2026-10-27。范围：只研究学生可见的工具调用、思考摘要、行动说明、状态及待处理消息；不决定 steering、调度、持久化内核或最终 UI 设计。本文是研究材料与有限建议，不表示实现或教学效果已经验收。

## 结论

**学生前台可以简洁，但应保留 tools、summary、status 三类信息。** 本次两款产品提供的参考是：简短状态与可见操作并存，参数和输出按需查看；thinking 是否有可读内容受端点、模型和配置影响，不能靠一个开关凭空获得。等待回应、等待服务、失败和中断需要各自表达，不能都叫“思考中”。下文产品事实来自官方现行文档及固定源码；这不是学生场景的效果研究。

最值得借鉴的不是开发终端的完整日志，而是“现在在做什么、是否需要我回应、实际做过什么可以查”。对 XunJie 的建议是保留持续 IP 引导与操作详情入口；有合适的供应商摘要时提供折叠查看，没有时明确缺省，以真实行动说明维持可理解性，不能把行动说明冒充思考摘要。

## 证据范围与版本

| 对象 | 本次固定依据 | 证据强度及边界 |
| --- | --- | --- |
| OpenCode TUI 与 Web/app | 查询时最新发布版 [v1.19.4][O-release]，发布于 2026-10-22；tag `refs/tags/v1.19.4` 实际解析为 **`148842ef7cb1bc34192b3fff57d0f9721ab9c801`**。下载该 commit 源码，核对 `packages/tui/package.json` 为 `1.19.4` | **源码静态核查**。追到 app 当前 timeline 的投影、渲染与输入 dock，并与 TUI 区分；没有启动产品、调用模型或验证实际屏幕。release 的 `target_commitish` 为另一 commit，本文未把它误当 tag 源码 |
| Claude Code 终端 | 查询时最新发布版 [v2.1.311][C-release]，发布于 2026-10-26；公开仓库 tag 解析为 **`08c6a4f5121ae140d3c1b5c96e3e5ae53587b54b`**，固定其 [CHANGELOG][C-log]；同时在线核实官方 interactive mode、model config、settings reference、errors、permissions 和 output styles | **官方文档声明 + 固定发布记录**。本次未取得终端 UI 的实际实现源码，不能声称已源码验证 Claude Code UI；公开 changelog 的 commit 只固定发布证据，不能替代实现源码。未安装、登录或调用模型 |

官方文档在 2026-10-27 经 web 打开验证；settings reference HTML 超过 web 工具长度限制，改以公开官方 `.md` 页面用 HTTP 下载核对。在线文档可能滚动更新，并非全部内容都有发布版本绑定；文中明确写出的版本门槛来自原文，不推定所有旧版本一致。未采用镜像、第三方教程或泄露源码。只读获取公开发布资料，未创建或修改 GitHub 对象。

为便于以后识别材料漂移，记录下载原始字节的 SHA-256；临时副本不进入仓库，下面的摘要不是原件存档或长期可用性保证：

| 材料 | SHA-256 |
| --- | --- |
| OpenCode 上述 commit 的 codeload `.tar.gz` | `3c66b2a1bc69dd53e1fe6337d8967e452970cfa092cda5690ef68a625da8f1b2` |
| Claude Code `interactive-mode.md` | `c0bc0c713d2e67de9418ea4c6a62d071236bfa0c21f1c69fd5e3523e05b2f5d6` |
| Claude Code `settings-reference.md` | `11690fbd68f047e26f815ddecfca589e112c0618cc9d48db51f9e05d96d655fa` |
| Claude Code `errors.md` | `3d8cb37a61fdf6027084127e63389ce504b0148915666e02e7411a24ab58c70b` |
| Claude Platform `thinking.md` | `a9f3daf7130dc22c1761a94b8044db1128af26e8cfdddfb08bd35954826ccf9a` |

## 必须分开的内容

| 内容 | 含义与证据 | 显示时不能推导什么 |
| --- | --- | --- |
| 供应商原生 reasoning/thinking summary | 服务明确返回的可读推理摘要。当前 Anthropic 官方说明，`thinking` 块中的可读文本是 summary，不是 raw chain of thought；`display`、模型默认值及可用性影响是否返回。[Thinking][P-thinking] | 不能因为字段名叫 `thinking` 就称为完整内部推理；也不能因其他服务兼容 Messages 格式就承诺相同语义 |
| raw reasoning / thinking | 某些端点可能返回其称作 reasoning 的较原始文本；本次没有对本项目端点实测。UI 接受一段 reasoning 文本，不足以证明它属于原生 summary 或完整内部思维。[OpenCode reasoning renderer][O-message] | 不保证本项目所有模型提供；不能改标题就将其变成可靠摘要或已验证教学解释 |
| 面向用户的行动进度说明 / commentary | 例如说明即将查看哪份作品、刚发现什么、下一步验证什么。OpenCode 将普通 `text` 与 `reasoning` 分开渲染；Claude Code output styles 可改变解释与叙述方式。[文本渲染][O-message]、[Output styles][C-style] | 这是面向用户的陈述，可以是计划或解释，不等于已执行的事实，不是模型内部思考的转录 |
| 确定性状态及工具事实 | 实际收到的 busy/retry、工具输入、结果、错误或中断记录；OpenCode 在显示代码中分别处理。[Timeline rows][O-rows]、[Tool renderer][O-message] | “正在生成参数”不等于调用已派发；“调用结束”不等于实验通过；状态动画不证明内容正确 |
| 本地标题提取 / 折叠预览 | OpenCode `reasoningSummary()` 对已有文本匹配开头的粗体标题，返回 title/body；不调用模型、不压缩或验证正文。[thinking.ts][O-thinking] | 函数名里的 summary 不等于供应商原生摘要；截断、抽标题和内容摘要是不同操作 |

**三协议边界：** 本项目使用 OpenAI Chat Completions、Responses 与 Anthropic Messages 风格的第三方端点，字段兼容不代表供应商功能兼容。本文没有以官方 OpenAI 服务的 summary、commentary 或 streaming 行为作为第三方端点保证。OpenCode 源码注释提到 Responses 的标题格式，只能证明其 UI 对该格式作了适配，不能证明本项目任一路线会返回它。某条路线是否实际返回 summary、原始 reasoning、空块或不透明内容，须在该路线后续实施验证；本次没有调用任何模型。

## 产品事实表：OpenCode v1.19.4

下表全部显示行为均为**固定版本源码证据，未实测 UI**。TUI `/details`、`/thinking` 的存在另经[当前官方文档][O-doc]交叉核对；不能用 TUI 设置推定 Web/app 的默认值。

| 显示对象 | 何时出现、显示什么 | 折叠、程度与限制 | 一手依据 |
| --- | --- | --- | --- |
| Web/app 忙碌状态 | 当前活跃 turn 为 `busy`、无当前错误时可生成 `Thinking` 行；默认隐藏 reasoning 正文时，状态行仍可带从 reasoning 抽取的标题。打开 reasoning 正文后，只在没有可显示 assistant part 时补该行 | 该 `Thinking` 是忙碌显示策略，不是“已有可读思考摘要”的证明；retry 是独立行 | [rows.ts 的 `constructMessageRows`][O-rows]、[timeline renderer][O-timeline] |
| Web/app 工具卡及参数 | 按工具注册 renderer 呈现。read 显示文件名、offset/limit；shell 显示命令；其他工具分别显示路径、pattern、query 等。pending/running 标题有活动反馈 | `BasicTool` 默认收起；普通卡 pending 时默认不允许切换，shell 明确允许运行时展开。默认设置中 shell/edit 都不自动展开；不把这些例外归纳为所有工具相同 | [BasicTool][O-basic]、[tool renderers][O-message]、[partDefaultOpen][O-open]、[默认设置][O-settings] |
| Web/app 工具实际结果 | shell 内容由实际 command、`output` 或 `metadata.output` 组成，支持滚动和复制；list/glob/grep 等有各自输出 renderer | **并非每张卡都有完整结果**：read renderer 主要是文件/读取参数与 loaded 文件；fallback `GenericTool` 只显示名称、主要标签和最多三个额外标量参数，没有通用完整 output body。由此不能声称“OpenCode 所有工具结果均可展开” | [shell/read/list 等 renderer][O-message]、[GenericTool][O-basic] |
| Web/app reasoning | `showReasoningSummaries` 默认 `false`；启用后，有可读 `reasoning.text` 的 part 才进入普通内容流，以 Markdown 渲染 | 设置名不鉴别文本来源；此 renderer 并非统一的逐块折叠摘要卡。默认的状态标题和启用后的 reasoning 正文也不是同一种显示程度 | [默认设置][O-settings]、[renderable / ReasoningPartDisplay][O-message]、[timeline][O-timeline] |
| TUI thinking | 首次无旧设置时 mode 为 `hide`；有内容时收成一行。尚未结束显示 `Thinking`，有标题可带标题；part 的 `time.end` 出现后改为 `Thought` 与时长 | `hide` 模式下点击可展开正文；`show` 模式直接显示。去除 `[REDACTED]` 后无正文但有 metadata 时，走 opaque 显示，不能展开出并不存在的文字。标题只从现有文本提取 | [thinking mode / title helper][O-thinking]、[ReasoningPart / ReasoningHeader][O-tui] |
| TUI 工具、详情开关 | 工具可呈现准备参数的文案，如 Reading file / Writing command；有参数后显示名称或命令。`showDetails` 首次默认 `true`；关闭时仅隐藏 `completed` 工具 | 错误、未完成工具不会因该开关一起消失。shell 超过 10 行的预览可点击展开；generic output 分支预览最多 3 行，并且取决于 `showGenericToolOutput`。不是 Web/app 的同一折叠逻辑 | [ToolPart / GenericTool / Shell][O-tui] |
| 行动说明 / commentary | 普通 `text` part 独立进入消息流，支持 Markdown 和流式正文；与 tool/reasoning 分开 | 没有从这些 renderer 找到“每次调用前必定有 commentary”的保证；能显示不等于模型必定生成，解释也不自动成为工具回执 | [TUI TextPart][O-tui]、[app TextPartDisplay][O-message] |
| 待处理消息 | Web/app 在选择 `queue`、会话 busy、未被问答/权限阻塞且不是子会话时允许排队。dock 有条数、消息预览、逐条 Send now / Edit；可折叠。TUI 对尚未轮到的用户消息显示 `QUEUED` | app 默认 followup 为 **`steer`，不是 queue**；不能把“有排队 UI”说成所有新消息默认排队。本研究只记录可见性，不展开其调度实现 | [queueEnabled / followupDock][O-session]、[followup dock][O-followup]、[默认设置][O-settings]、[TUI UserMessage][O-tui] |
| 等待用户 / blocked | app composer 以实际 permission request 或 question request 判为 blocked，出现单独 dock；permission 有对象模式及允许一次/始终/拒绝，question 有题目与可选/自填回答 | 这是请求回应的 UI 条件，不是所有“长时间无输出”的通用 blocked 状态；pending question 在普通工具流里隐藏，交互由 dock 承担 | [composer state][O-composer]、[permission dock][O-permission]、[question dock][O-question]、[ToolPartDisplay][O-message] |
| 等待服务 / retry | 活跃会话 status 为 `retry` 时显示独立卡：错误原因、重试次数及距 `next` 的倒计时；长原因可由 tooltip 查看。TUI 也在输入区域显示重试信息及中断入口 | 这证明 retry 显示，不证明所有无数据等待都有相同提示或已经失败；源码的 session status 基础枚举是 idle/retry/busy | [SessionRetry][O-retry]、[TUI prompt][O-prompt]、[status schema][O-status] |
| 错误 | tool state 为 `error` 时用 `ToolErrorCard`，错误详情可折叠/复制；问答被 dismiss 有特殊文案。当前 turn 最近 assistant 的非 abort 错误成为 Error 行 | 工具失败与会话失败是不同显示位置；不凭红卡推定实际实验有没有运行。ToolErrorCard 自身默认收起，可被调用方控制 | [ToolPartDisplay][O-message]、[ToolErrorCard][O-error]、[rows.ts][O-rows] |
| 取消 / 中断 | 活动时空输入框显示 stop；点击请求 interrupt。消息出现 `MessageAbortedError` 时，timeline 插入 interrupted 分隔，不当成普通 Error 行 | **按钮请求停止**和**已观察到中断**是两个时点；这些 UI 源码不足以证明外部工具都已终止或效果已撤销 | [prompt input][O-input]、[submit abort][O-submit]、[rows.ts][O-rows] |

## 产品事实表：Claude Code

下表为**当前官方文档声明，未实测终端 UI，也未核查终端实现源码**；固定 v2.1.311 changelog 用来限定发布记录，不把历史条目当作最新 UI 的逐像素说明。

| 显示对象 | 何时出现、显示什么 | 适用边界与证据 |
| --- | --- | --- |
| 工具名称、参数与输出 | 默认 transcript 将调用缩成短摘要，例如命令和输出行数；`Ctrl+O` 切换到详细 transcript。`verbose: true` 可在调用发生时内联显示完整输入和输出 | 默认不是完整 JSON/输出墙；来自 [settings reference 的 verbose][C-settings]，显示方式还可能被 viewMode / focus 覆盖。这里只比较终端，不把它称作 Web tool card |
| 折叠的成组操作 | `Ctrl+O` 也能展开默认归并成一行的 MCP 调用，以及其他会话消息的单行预览 | [Interactive mode][C-interactive]。归并摘要属于操作呈现，不是原生思考摘要 |
| Thinking / summary | 当前官方文档说 thinking 默认折叠；`Ctrl+O` 可查看已有的可读内容。交互会话直连 Anthropic API 默认进行 thinking redaction，`showThinkingSummaries` 默认 `false`；设为 `true` 才取得展开所需的完整摘要 | [Model config][C-model]、[settings reference 的 showThinkingSummaries][C-settings]；“展开 UI”和“供应商是否返回摘要”是两个控制点。不能据此承诺其他 provider 或本项目端点相同 |
| busy 与结束反馈 | turn 进行中显示 spinner；其轮换动词和功能 tips 可配置；结束后 `showTurnDuration` 默认显示时长与完成时刻 | [settings reference 的 spinnerVerbs / spinnerTipsEnabled / showTurnDuration][C-settings]。可配置轮换词不构成实际当前操作的证据，不能直接照搬为课堂事实状态 |
| user-facing commentary / 教学说明 | Output styles 改变面向用户的叙述。Explanatory 在相关代码前后加 `Insight` 解释；Learning 还会把一部分代码留给用户实践 | [Output styles][C-style]。这是提示指令与可见解释，不是 raw thinking、工具回执或确定性保证；不能把它当作 XunJie 课程帮助边界已经落实 |
| pending messages | 工作中按 Enter 后条目列在会话里；已发送但未开始回应与仍排队的消息都可呈灰色。工具调用中的追加消息在该批工具结束后可送入；其余可能留到 turn 末。可取回编辑或显式立即发送 | [Interactive mode 的 queue / take back][C-interactive]。同为灰色不能独立证明已被模型采纳；`Ctrl+Enter` 立即发送有最低版本与终端按键限制，且可能后台化当前工作或中断回复，不在本文展开内核 |
| waiting：模型服务尚未响应 | 官方 errors 文档描述无流数据时的 waiting banner，以及带错误原因、倒计时、attempt 的 retry 显示；它们分别对应“尚未失败的等待”和“已进入重试” | [Errors 的 retries/waits][C-errors]。页面给出的当前阈值有直连、gateway、advisor 区分；本文不将具体秒数作为 XunJie 默认值，也不把 waiting banner 等同失败 |
| blocked：等待用户回应 | 需批准的操作出现 permission prompt，展示将做什么和相应选项；拒绝或 Esc 有明确交互语义 | [Permissions][C-permissions]、[Interactive mode][C-interactive]。取决于权限模式及实际操作；不建议给课程正常只读查看新增照搬式批准流程 |
| error / cancel | 官方 errors 按实际失败原因显示诊断；停止当前响应或工具可用 Esc / Ctrl+C，保留已做工作。限额等待具有单独的取消反馈 | [Errors][C-errors]、[Interactive mode][C-interactive]。停止生成不代表已有文件修改回滚，也不保证所有后台工作被停止 |

补充区别：工具 checklist 的 pending/in-progress/complete 是计划项状态，不是工具执行回执或学生掌握度。官方文档还注明 task-tracking 工具可用性受模型和配置影响；没有 checklist 时，`Ctrl+T` 不必产生可见变化。[Task list][C-interactive]

## 对 XunJie 的有限建议

依据为当前 [DESIGN.md](../../DESIGN.md) 的安静背景、小面积语义色、真实作品与结果关联、工程信息按需展开原则，以及 [guidance-presentation](../specs/guidance-presentation.md) 的持续 IP、短文案、可交互卡片、忙碌/等待/安静状态、焦点与减少动效要求。[能力设计](2026-10-27-agent-capabilities-design.md)另要求保留真实结果与原件引用、区分未执行和效果未知，并遵守课程帮助范围。这些是本项目依据，不是竞品已经证明的教学优势。

### 显示什么、到什么程度

| 信息 | 默认给学生看 | 学生主动展开时 | 不应由显示层声称 |
| --- | --- | --- | --- |
| status | IP 附近一条简短文字：正在查看作品、运行中、等你选择、等待服务、已中断等；影响继续学习的错误直接可见 | 等待对象、实际已用时、失败原因与可采取的动作 | 用 spinner 证明模型有进展；无依据估计完成百分比、剩余时长或“快完成” |
| tools | 保留紧凑的操作记录/当前操作：读了什么、运行了什么，标明进行中/完成/未执行/失败。与当前作品及实际结果关联 | 可读关键参数、作品版本、来源、真实结果和完整获准原件入口；参数 JSON、内部 ID 再放技术详情 | 把“准备调用”写成“已运行”；把命令完成写成用例通过；模型自述替代工具事实 |
| summary | 保留思考摘要能力；有可读、可展示的供应商 summary 时给出折叠入口并标明来源。若路线无该内容，省略空正文或明确“未提供思考摘要”，状态与操作记录继续可见 | 课程规则允许范围内的摘要；不透明内容只说明没有可读文本 | 所有模型都有 summary；展开就能看到完整内部推理；把截断 raw reasoning 改名为原生 summary |
| 行动说明 | 只在重要变化时用一句话解释目标、依据或下一步，如“我先看这次编译结果，再定位报错位置” | 根据学生请求解释为何查该证据、有哪些不确定性 | 每个底层事件都转成 IP 气泡；将计划口吻当成完成回执 |
| pending messages | 提交后就显示“已接收，尚未处理”；真的纳入当前处理后更新，文案与实际事实一致 | 查看待处理内容与其引用的作品/选区，按最终交互方案提供可用动作 | 把“输入已收下”写成“已经理解并执行”；自行决定 steering 的步骤边界 |

以上为呈现层建议，不另立事件 schema、派发机制或新授权流程。具体状态来源、新消息何时被处理和工具如何停止，交由负责内核的 Agent；前台只能展示已经得到的事实。

### 教学情境中的取舍

| 情境 | 建议的默认显示与交互 | 帮助程度与边界 |
| --- | --- | --- |
| 学生问概念或正在自己尝试 | IP 给简短回应，后台查阅材料时有小型状态与操作记录；按需看材料来源或思考摘要 | 不为显得活跃持续播报推理，也不自动替学生写答案；安静状态仍可重新打开引导 |
| 编译失败、单测未过或波形不符 | 当前卡片显示真实结果及对应作品；保留“查看编译输出/波形”和相关调用详情；行动说明指出下一项要核对的证据 | 把诊断事实与 Agent 推断分开。是否给完整改法由课程帮助规则及学生请求决定；可用预测/选择卡引导学生先判断 |
| 等学生做一个选择或观察实验 | 明确“等你选择/观察”，用课程提供的交互卡承载回应，IP 不再持续显示忙碌 | 等待是学习活动的一部分，不是技术故障；卡片可见、动画结束或关闭不自动记成理解/掌握 |
| 实验仍运行或外部环境未就绪 | 说明等待的实际对象；已有结果可查看。已接受但未完成、未派发、结果未知用不同文案 | 不因模型请求结束就报实验完成；不因超时宣称未执行或提供无依据的重跑承诺 |
| 学生追加“先别改，解释这一行” | 显示追加内容已接收；在实际处理状态变化后表明当前关注对象；旧操作结果保留可查 | 显示不能冒充内核已转向。旧内容不应挤占新问题，何时纳入由本轮 steering 设计确定 |
| 课程限制完整解答 | 默认显示允许的行动与证据，摘要入口也受相同帮助边界约束；正文可解释下一步验证方法 | **折叠不是课程边界。** 若摘要或 raw reasoning 含完整解法，默认折叠仍可泄露；需先按课程决定该内容可否给学生，不能承诺“详细模式无条件全开” |

有限建议的重点是支持学生继续学习：工具详情用于查证，简短 explanation 用于理解方法，交互卡用于学生实际回应。raw reasoning 不作为默认教学材料；要教解题方法，应另给课程允许的、面向学生写作的解释，并明确它不是供应商思考转录。这些取舍尚无课堂学习效果证据。

视觉上沿用已有 IP、token 和文字层级，不增加新的品牌色或整屏运行日志；状态用可读文字，颜色辅助，小号正文不使用装饰级 `faint`。新信息不自动抢焦点、切面板或滚动学生作品；展开操作可键盘到达，减少动效时仍能分辨状态。[DESIGN.md](../../DESIGN.md)、[展示规范](../specs/guidance-presentation.md)

## 已验证与未验证

- 已完成：两个产品官方现行资料的 web 核实；两个 release tag 的实际 commit 解析；OpenCode 固定版本显示源码静态阅读；本项目指定三份材料及相关设计原则阅读；只写本文件。
- 没有做：产品登录、真实/付费账号访问、模型调用、产品本地启动、截图实屏验收、生产代码修改、GitHub 写入；未研究 DeepSeek Harness 或重复 steering 内核。
- 工程测试：文档研究不新增或运行产品测试。静态源码只能证明显示分支存在，不能证明实际端点会产生相应数据，也不能证明交互无回归。
- 浏览器/终端验收：未执行，不能标通过；官方页面截图的存在也不替代状态切换实测。
- 教学效果：未验证。后续若实施，宜检查学生能否分清“等我回应 / 等服务 / 已失败”、能否找到实际工具结果，以及摘要是否越过课程帮助范围；它们是后续评估问题，不是本次结论。

## 一手来源索引

下列 OpenCode 源码链接均固定到 `148842ef7cb1bc34192b3fff57d0f9721ab9c801`；链接中的行号用于定位关键入口，阅读时仍需结合附近分支。Claude Code 文档为本次查询时的在线版本，changelog 单独固定 commit。

- OpenCode：[发布版][O-release]、[官方 TUI 文档][O-doc]、[app timeline][O-rows]、[工具渲染][O-message]、[TUI thinking][O-thinking]。
- Claude Code：[发布版][C-release]、[固定 changelog][C-log]、[交互文档][C-interactive]、[设置参考][C-settings]、[错误与等待][C-errors]；摘要语义另见 [Anthropic Thinking][P-thinking]。

[O-release]: https://github.com/anomalyco/opencode/releases/tag/v1.19.4
[O-doc]: https://opencode.ai/docs/tui/
[O-thinking]: https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/tui/src/context/thinking.ts#L8
[O-tui]: https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/tui/src/routes/session/index.tsx#L1516
[O-prompt]: https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/tui/src/component/prompt/index.tsx#L1515
[O-settings]: https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/app/src/context/settings.tsx#L183
[O-rows]: https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/app/src/pages/session/timeline/rows.ts#L101
[O-timeline]: https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/app/src/pages/session/timeline/message-timeline.tsx#L1182
[O-message]: https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/session-ui/src/components/message-part.tsx#L1534
[O-basic]: https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/session-ui/src/components/basic-tool.tsx#L86
[O-open]: https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/session-ui/src/components/part-default-open.ts#L19
[O-session]: https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/app/src/pages/session.tsx#L1705
[O-followup]: https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/app/src/pages/session/composer/session-followup-dock.tsx#L9
[O-composer]: https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/app/src/pages/session/composer/session-composer-state.ts#L47
[O-permission]: https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/app/src/pages/session/composer/session-permission-dock.tsx#L8
[O-question]: https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/app/src/pages/session/composer/session-question-dock.tsx#L64
[O-retry]: https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/session-ui/src/components/session-retry.tsx#L8
[O-status]: https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/schema/src/session-status-event.ts#L9
[O-error]: https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/session-ui/src/components/tool-error-card.tsx#L22
[O-input]: https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/app/src/components/prompt-input.tsx#L286
[O-submit]: https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/app/src/components/prompt-input/submit.ts#L259
[C-release]: https://github.com/anthropics/claude-code/releases/tag/v2.1.311
[C-log]: https://github.com/anthropics/claude-code/blob/08c6a4f5121ae140d3c1b5c96e3e5ae53587b54b/CHANGELOG.md#L3
[C-interactive]: https://code.claude.com/docs/en/interactive-mode
[C-model]: https://code.claude.com/docs/en/model-config#extended-thinking
[C-settings]: https://code.claude.com/docs/en/settings-reference
[C-errors]: https://code.claude.com/docs/en/errors#what-you-see-while-claude-code-retries-or-waits
[C-permissions]: https://code.claude.com/docs/en/permissions#permission-system
[C-style]: https://code.claude.com/docs/en/output-styles
[P-thinking]: https://platform.claude.com/docs/en/build-with-claude/thinking#how-thinking-works
