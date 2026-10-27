# 新消息 steering / queue：DeepSeek Harness 与 Pi 调度源码研究

研究日期：2026-10-27。产品输入：**新消息默认 steering，立即接收并补充当前工作；用户可选择 queue，等当前工作结束。** 本文只研究接收与生效边界，不改变该产品决定。

标记：**F** = 固定版本源码/正式文档事实；**P** = XunJie 接入建议；**U** = 未验证或上游没有充分保证。探针是无真实模型、无产品依赖的局部源码验证，不能代替产品验收。

## 结论

- **F：两者当前普通 steer 都是“接收后，在模型回复及其完整工具批次结束后注入下一次模型请求”**，不是取消当前 LLM，也不是在两个串行工具之间抢占。已返回但未派发的工具仍会执行；并行模式也会继续派发尚未启动的调用。不能把 UI 的 interrupt 理解成取消。见 [H-loop]、[H-stream]、[H-batch]、[P-loop]、[P-tools]；Pi 正式 README 也明确先完成所有工具，再注入 steering：[P-doc]。
- **F：queue 不是等一次 model step 完成。** Harness 在当前持久 turn 结束后开启后续 turn；Pi agent-core 的 follow-up 在“无工具续跑、无 steering”的自然停点消费，但仍属于同一次 `prompt()` run，可能没有中间 `agent_end`；Pi durable 的 follow-up 在 `final` 边界启动后继 run。[H-turn]、[P-loop]、[PD-final]
- **F：持久等待不能笼统套用普通工具结论。** Harness `job_output(wait=true)` 单独监听用户 next-step 输入，释放等待、返回 running 状态，后台 job 不被取消；并非所有 wait 都支持。Pi durable 的持久 waiting/sleeping 不会仅因普通 steer 入队而自动结算依赖或到期。[H-wait]、[H-wait-test]、[PD-submit]、[PD-scheduler]
- **F + 探针：收尾需要宿主兜底。** Pi core 在 `agent_end` 收到 steer 只留队，不自动启动；coding-agent 有额外续跑逻辑。Harness 的正常 `agent/turn-stopping` 复查有效，但 `turn/end` 通知所安排的 microtask 可复现 idle + pending；这是保留真实 driver 控制流、替换模型与宿主的局部探针结果，尚非整套产品复现。[P-agent]、[P-session-end]、[H-wake]、[H-turn]
- **P：优先接 Harness 内核/Host 的 `steer`、`followup` 与 durable inbox；不能只接当前 SDK `prompt()`。** SDK server 的 `prompt()` 固定调用 `followup()`。若选 Pi，应明确采用 agent-core 还是 durable；CLI 的队列行为与持久性不能投射到 core。[H-sdk]、[H-host]、[PD-submit]

## 版本、来源与分层

2026-10-27 13:04 UTC 前后，先用 web 打开两个官方仓库及固定 commit 页，再以 `git ls-remote --symref <repo> HEAD` 核对远端；下载固定 SHA 的官方 codeload tarball进行行号审阅。GitHub API URL 经 web 工具访问失败，未把失败当成 HEAD 证据。实际 HEAD 来自实时 Git 远端应答；以下链接全部固定 SHA。这里的“最新”是**检查时默认分支 HEAD**，不代表 npm/stable release。

| 上游 | 实时默认分支 / HEAD | 与题给旧基线比较 |
| --- | --- | --- |
| [DeepSeek Harness 官方仓库](https://github.com/deepseek-ai/deepseek-harness) | `master` / `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`（[commit](https://github.com/deepseek-ai/deepseek-harness/commit/22ddee3792402c3e70ec5f86a63c3e3e895a2f60)） | HEAD 未变 |
| [Pi 官方仓库](https://github.com/earendil-works/pi) | `main` / `db14038bd847c5bad57de217e0ac0c5ad1ae60ba`（[commit](https://github.com/earendil-works/pi/commit/db14038bd847c5bad57de217e0ac0c5ad1ae60ba)） | 已前进；与旧 `6c384aa30f619d7b28963f2bab24d8dacbe73cb6` 逐字节比较，`agent.ts`、`agent-loop.ts`、coding-agent `agent-session.ts`、durable `generation.ts` / `inbox.ts` 这五个关键文件相同。只对这些文件作一致性结论 |

**F：层次不能混用。** Harness 的 composer 负责选 `steer/queue`，session-controller 把它们映射到内核 `steer/followup`；SDK server 是另一入口。Pi 的 agent-core 是进程内 loop + 两个数组队列；coding-agent `AgentSession` 加入输入处理、session 管理和收尾续跑；durable 另以持久 task / submission / inbox 实现调度。它不是 core 内存队列自动变持久。[H-policy]、[H-host]、[H-sdk]、[P-agent]、[P-session-end]、[PD-inbox]

## 阶段对照：何时影响下一次 model / tool

下表讨论普通 steering，排除显式 abort/cancel、自定义策略与失败路径。`model → tools → boundary → model` 中，每个工具执行的模型参数已在前一次回复中固定；接收新消息不等于工具会读到它。

| 消息到达阶段 | Harness agent-loop + 内置 executor（F） | Pi agent-core（F） | Pi durable（F） |
| --- | --- | --- | --- |
| LLM 正在 stream | `steer` 只写 `next-step` 并尝试 wake；不 abort。stream 完成后仍派发完整 tool batch；批次后 `preStep` claim 才带入下一请求。[H-loop]、[H-stream]、[H-turn] | 只 enqueue；stream 的 signal 不变。工具批次完成、`finishTurn` / `turn_end` 后 poll steering，下一请求可见。[P-loop]、[P-agent] | busy submit 写 `pi.inbox`；不取消 generation。工具回复先进入 tool round，steer 到 `postTools`；无工具最终回答则到 `final`，此时进入后继 run。[PD-submit]、[PD-round]、[PD-final] |
| 已返回 tool_calls，尚未派发 | assistant 落日志后直接 `tools.execute(calls)`，此处没有 inbox poll；不因 steer 跳过。[H-stream] | `message_end` listener 中入队也不会阻止随后 `executeToolCalls()`；无批次前 steering poll。[P-loop] | `startToolRound()` 提交 assistant 与工具 task；此处不消费 steer。串行建第一个 task，并行建全批 task。[PD-round] |
| 串行工具 A 执行中，B 尚未执行 | A 结束后继续 B；即使 `maxParallelToolCalls=1` 也不是每工具 steering 边界。[H-batch] | sequential loop 不读 steeringQueue；A、B 都完成后注入。[P-tools] | sequential pending 列表逐个启动，未在 A/B 间 apply inbox；整轮结束后 `postTools`。[PD-sequential] |
| 并行工具进行中，还有未启动项 | 有界 rolling pool，exclusive barrier；steer 不改 abort signal，pool 会继续填充。等整批结果与 context settle 后才进入下一模型。[H-batch] | 先串行 preflight，再 `Promise.all` 执行；完成事件可以乱序，结果消息按模型调用顺序。steer 不停派发、不取消进行中的调用。[P-tools] | generation 等工具任务 `allSettled`；完成后 apply `postTools`，再建 successor generation。[PD-round] |
| 长时间 / 持久等待 | 普通工具仍等返回；**仅 `job_output(wait=true)` 有用户 next-step 输入释放机制**，返回当前真实状态，不 kill producer，queue 不释放；同批其他普通工具仍须结束。`wait_agent` 等未获同等保证。[H-wait]、[H-wait-test] | 没有 core 持久 waiting 状态；工具 Promise 不 resolve 就停在工具批次。普通 steer 不解除它。[P-tools] | task waiting 依赖未 terminal、sleep 未到期时保持等待；submit 可让 scheduler 工作，但不会把这些条件变成满足。普通 steer 本身不是唤醒/取消 wait 协议。[PD-submit]、[PD-scheduler] |
| 自然结束 / 结束竞态 | `agent/turn-stopping` 后再次查 `nextStep`，可继续同 turn；`turn/end` 的同步 observer 入队可由后续 hasPending 开新 turn。但异步 microtask 可能落在“已判空、尚未转 idle”的缝隙，局部探针留下 pending。idle 后直接 steer 会正常 wake。[H-turn]、[H-wake] | 最后 follow-up poll 之后不再 poll；`agent_end` listener 入队会留下 pending，需宿主 `continue()`。`AgentSession` 在 core run 后重新查队列，并在 settled 期间延后 `prompt()`。[P-agent]、[P-session-end] | busy/admit 与 final/endRun/startRun 都经过 session commit：先入队则 final 看见；先结束则 submit 按 idle 路径开 run。该事实来自事务控制流；未做并发存储压力验证。[PD-submit]、[PD-final] |

**F：请求准备也不是无限开放的接收窗。** Harness 在 `preStep()` 开头 claim，之后 assemble / prepareRequest 到来的 steering 等下个 step。Pi `prepareNextTurn` 后会补 poll 一次，但 `prepareRequest` / transformContext / stream 期间不再 poll；所以“请求发出前已收到”也不保证进入这一请求。[H-prestep]、[P-prepare]

**F：失败与强制收尾是例外。** Pi core 的模型 `error/aborted` 路径、`finishTurn: {action:"end"}` 会提前 `agent_end`，不按正常流程继续排空队列。Harness pre-step reject / error / cancel 也不等价于正常完成后续 turn。Pi durable 的失败后续队列受 `afterFailedRun` 策略控制。不能承诺所有结束原因都会自动消费队列。[P-loop]、[H-turn]、[PD-types]

## 顺序、编辑、设置与重启的证据强度

| 议题 | Harness（F，除明确 U） | Pi 分层结果（F，除明确 U） |
| --- | --- | --- |
| 多消息 | 同一 list append FIFO；claim 时先取**全部 next-step**，若是新 turn，再取**一条 next-turn**。因此两种 mode 混合不保证全局时间 FIFO，例如较晚 steer 可越过较早 queue。[H-inbox] | core 两个 FIFO，默认各 `one-at-a-time`，可改 `all`；工具续跑时先 steering，follow-up 到自然停点才取。durable `postTools` 只选 steer；`final` 对两类各按 mode 选取，再按提交 ID 排序，因而同一 final 可以是较早 follow-up 在较晚 steer 前。探针验证 `Q,S → postTools:[S]` / `final:[Q,S]`。[P-queue]、[PD-inbox] |
| queue edit / cancel | 内核 `replace/remove(id)`，Host 暴露 edit/remove/steer；只操作仍 pending 的项，已 claim 则 not-found；queue→steer 需 running + next-turn。edit 保持消息身份；转 steer 是 remove + 重新 steer。已接收不保证仍可编辑。[H-inbox]、[H-edit] | core 有 clearSteeringQueue / clearFollowUpQueue / clearAllQueues，没有公开按 ID 单项编辑 API；coding-agent 的 edit 路径是清空全部待处理文本并放回 editor，重新提交，不是事务单项替换。durable 按 ID 取回 submission 后调用 `submission.abort(context)` 对 queued 删除并结算 aborted，placed 返回 `already_placed`；本轮公开接口未找到同等直接 edit（U：不能据此否定宿主自定义事务）。[P-agent]、[P-editor]、[PD-abort] |
| 默认 steering / queue 设置 | 当前 Harness composer `busyEnter` 默认是 **queue**，与本项目决定不同；`setBusyEnter` 只改变后续 gesture 解析，不迁移已有 inbox 项。显式 queue→steer 是另一动作。[H-setting]、[H-policy]、[H-edit] | CLI 流中普通提交用 steer，Alt+Enter 用 followUp；core 不负责输入偏好。durable 的 `whenBusy` 缺省是 followUp，所以 XunJie 必须显式传 steer。[P-cli]、[P-cli-followup]、[PD-submit] |
| 设置改变是否改已有队列 | 上述 composer delivery 偏好不改旧项的 target；`maxParallelToolCalls` 改的是下一批执行策略，也不是消息重分类。[H-policy]、[H-config] | **不能混淆 delivery mode 与 drain mode**：core `steeringMode/followUpMode` 的 one/all 在 drain 时读取，会改变已有积压的合批；coding-agent 同时保存此设置。durable 在 boundary commit 读取 one/all，已有官方测试；旧项的 steer/followUp 分类不随之改变。[P-queue]、[P-setting]、[PD-inbox]、[PD-mode-test] |
| 重启持久性 | inbox splice 是 session event，挂载 persistence 时可回放未 claim 项；不挂载仅内存。resume 修补中断 turn 和悬空调用。**claim 已删除但尚未提交 user/message 的窗口不能算“未消费消息必恢复”**；claim/admission 是分开的，本文未验证该 crash window 自动重投。恢复 inbox 也不等于恢复外部进程或原工具栈。[H-inbox]、[H-resume]、[H-sdk-doc] | core 队列是内存数组；coding-agent 待处理文本也是内存，历史 session 持久化不能证明 pending 队列持久化。durable 有持久 `pi.inbox`、submission、checkpoint，SQLite/JSONL 重开后 resume，requestId 去重；这仅属于 durable 层。本文未跑断电恢复实测。[P-queue]、[P-session-queue]、[PD-inbox]、[PD-persist] |

## tool_result 与副作用

**F：普通 steering 没有“跳过工具后如何配对”的路径，因为两者都执行完整批次。** Harness 以 callId 写 tool/result 并关联 tool/call seq；Pi 以 toolCallId 形成 toolResult，批次结果先进入 context，steering 后进入。已执行文件写入/外部请求不会被 steering 回滚；后续模型获得完成事实再调整计划。[H-results]、[P-loop]、[P-tools]、[P-results]

**F：显式取消是另一条路径，不能冒充 steer。** Harness cancel 才 abort activity，默认清空 inbox；executor 先 drain 已启动调用，再给尚未派发项写 synthetic error（`TOOL_ABORTED_BEFORE_DISPATCH`）；失败/重启 repair 对每个悬空 call 补结果，并区分“未记录开始”与“已开始、结果未知”。这保持消息配对，不能撤销已经产生的副作用。[H-loop]、[H-batch]、[H-results]、[H-repair]

**F / U：Pi core** `beforeToolCall` 的 block 可给该调用 error result，这是定制派发控制，不是内置 steering。core abort 的提前退出不能泛化成 Harness 式每个未派发调用的 durable synthetic result 保证；本轮未验证所有 provider 在 abort 后的配对修复。**Pi durable** 对恢复中的已记录执行意图，仅存储策略与当前工具策略都为 `safe` 才重跑，否则结算“可能已部分运行”的 interrupted 结果；不能把持久性叫作 exactly-once 外部副作用。[P-tools]、[PD-replay]

## XunJie 推荐接入点（P，非上游已有保证）

1. **消息入口先持久接收，再按显式 mode 调度。** 普通发送默认 `steer`；可选择 `queue`。用 messageId、接收顺序、mode、pending/claimed/admitted/canceled 状态返回收据；偏好变更仅作用未来提交。切换已排队项必须是显式动作。用户文案可区分“已收到，补充到当前工作”和“等待本轮结束”。
2. **明确本轮是完整 agent work/run，不是一次 model response。** 若沿用上游批次边界，写清 steering 会在当前模型及工具批次结束后纳入；无需因收到消息丢弃已完成工作。不要只等 SDK run Promise 或第一个 `turn_end`：Harness SDK 收集到 whole-agent idle，Pi `turn_end` 仍可能有工具续跑/steer；工具结果正常结算后才纳入追加消息。
3. **Harness 路径：** 在 in-process Agent 或 session-controller 使用 `agent.steer()` / `agent.followup()`，复用 durable inbox 与 pending edit。现有 SDK `prompt()` 固定 followup，不能原样满足默认 steer；需扩协议或使用 Host 接口。针对 wait 单独提供“让等待返回当前状态”的信号，保留后台 executionId 与回执；不要自动 kill 已执行工作。
4. **Pi 路径：** 若要求重启不丢已接收消息，选择 durable `Conversation.submit({whenBusy:"steer"|"followUp",requestId})` 并接真实 storage，或由本项目实现 inbox；仅 agent-core 不足。持久工具/任务等待需要宿主自己的“停止等待并继续对话”协议；不能指望 steer 自动解开依赖。保留 coding-agent 的收尾思想，但不要为其 UI 行为引入整个 CLI。
5. **如果“立即补充”还要求阻止下一件旧计划工具启动，必须额外实现派发关口。** 上游普通 steer 不满足这个更强语义。可在 model 返回后、每个尚未启动工具前检查新消息；暂缓未启动项，为已宣告调用生成明确未执行结果，再由新 model step 重规划。已启动并行项继续 settle 并记录真实结果。Pi 的 `beforeToolCall` 是可用关口；Harness 可在工具 pipeline/executor 层加策略，单靠 `agent/pre-step` 太晚。该增强需明确验收，不能在本研究中称为已实现。
6. **用一次事务/同一调度串行线完成 idle 收敛与 pending 复查。** 覆盖 stream 中、tool batch 中、turn-end microtask、agent-end listener、到 idle 后提交这些到达点；接收成功且 pending 的消息必须最终被唤醒或明确保留原因。对 claim→admit 的 crash window 作重投/放弃的显式结算，避免“已收到”悄然变成没有后续工作。

## 本轮验证与可复现证据

**实际执行：** Node `v26.0.0`，11 个无模型 probe 场景断言通过；没有安装产品依赖，没有调用付费/真实模型，没有操作 GitHub 议题。未运行上游全套测试、真实 provider/浏览器/分布式压力或断电恢复测试；教学效果未验证。

探针直接加载固定 tarball 源码，以 Node `stripTypeScriptTypes` 去类型后执行；移除 import，注入最小 pi-ai 工具声明/参数验证替身，provider 为脚本化 async iterator。Harness 移除未使用的 constructor，通过 prototype 保留真实 `send/wakeDriver/kick/turn`，替换 `preStep/step`、session、dispatch 和 ToolCallRecovery；因此只证明 driver 收尾控制流，不证明 Cordis、persistence 或完整 executor 的端到端行为。durable 只调用真实 `applyBoundary`，transaction 是内存替身，不代表存储并发验证。

| 探针 | 实测结果 |
| --- | --- |
| Pi stream / 已回复未派发 / sequential A 内收到 S | 三者都执行 A、B；第二次请求按 `assistant, result:a, result:b, S` 收到追加内容；signal 未 abort |
| Pi parallel A、B 在途 | B 可先结束；S 不取消 A；两者结果按 a,b 顺序进入下一请求 |
| Pi follow-up | 首次无工具答复之后才进入下一请求；同一次 loop 最后才发 agent_end |
| Pi agent_end 中入队 | modelCalls=1，pendingSteers=1；未自行再调模型 |
| Harness turn-stopping 中 steer | turns=1，steps=2，pending=0 |
| Harness turn/end observer 的 microtask 中 steer | turns=1，steps=1，status=idle，pending=1；需宿主收敛兜底，尚未做完整产品复现 |
| Pi 将已有队列 one→all | 已有 1、2 两条在下一 drain 一次取出 |
| Pi durable `[Q(followUp),S(steer)]` | postTools 仅取 S、保留 Q；final 按 ID 取 Q,S |

复现时，在仓库外执行以下命令下载固定源码，将下方 JavaScript 保存为临时目录内的 `probe.mjs`，运行后删除该目录。`probe.mjs` 本身不联网：

```sh
STEER_PROBE_DIR=$(mktemp -d /tmp/xj-steering.XXXXXX)
mkdir "$STEER_PROBE_DIR/harness" "$STEER_PROBE_DIR/pi"
curl -fLsS https://codeload.github.com/deepseek-ai/deepseek-harness/tar.gz/22ddee3792402c3e70ec5f86a63c3e3e895a2f60 | tar -xz --strip-components=1 -C "$STEER_PROBE_DIR/harness"
curl -fLsS https://codeload.github.com/earendil-works/pi/tar.gz/db14038bd847c5bad57de217e0ac0c5ad1ae60ba | tar -xz --strip-components=1 -C "$STEER_PROBE_DIR/pi"
# 将下方代码保存为 "$STEER_PROBE_DIR/probe.mjs"
node --disable-warning=ExperimentalWarning "$STEER_PROBE_DIR/probe.mjs"
rm -rf "$STEER_PROBE_DIR"
```

<details>
<summary>完整无依赖探针（11 场景；运行原始 loop/driver，替身范围见上）</summary>

```javascript
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import assert from 'node:assert/strict';
const root = import.meta.dirname;
function load(path, names, env = {}) {
 let source=readFileSync(`${root}/${path}`,'utf8');
 if(path.startsWith('harness/'))source=source.replace(/  constructor\([\s\S]*?\n  get status/, '  get status');
 let js=stripTypeScriptTypes(source);
 js=js.replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm,'').replace(/^export\s+(?=(async\s+)?(function|class|const)\b)/gm,'');
 return Function(...Object.keys(env),`${js}\nreturn {${names}}`)(...Object.values(env));
}
const ai={getCurrentTools:()=>[],getToolStateChanges:()=>({toolsAdded:[],toolsRemoved:[]}),normalizeContext:x=>x,mergeClientIdentity:()=>({}),PI_ATTRIBUTION:{},toToolDeclaration:x=>x,validateToolArguments:(_t,c)=>c.arguments};
const {runAgentLoop}=load('pi/packages/agent/src/agent-loop.ts','runAgentLoop',ai);
const user=text=>({role:'user',content:text,timestamp:0});
const msg=calls=>({role:'assistant',content:calls.map(id=>({type:'toolCall',id,name:id,arguments:{}})),stopReason:calls.length?'toolUse':'stop',timestamp:0,usage:{},provider:'stub',model:'stub'});
for(const phase of ['stream','pre-dispatch','sequential','parallel','followup','agent-end']) {
 let steering=[],followup=[],trace=[],requests=[],n=0;
 const inject=()=>{steering.push(user('S'));trace.push('accept:S')};
 const tools=['a','b'].map(name=>({name,parameters:{},execute:async(_id,_args,signal)=>{trace.push(`start:${name}`);if(phase==='sequential'&&name==='a')inject();if(phase==='parallel'&&name==='a'){await Promise.resolve();inject()}assert.equal(signal.aborted,false);trace.push(`end:${name}`);return {content:[{type:'text',text:name}]}}}));
 const stream=async(_model,ctx,{signal})=>{
  requests.push(ctx.messages.map(m=>m.role==='user'?m.content:m.role==='toolResult'?`result:${m.toolCallId}`:m.role));trace.push(`model:${++n}`);
  const result=msg(n===1&& !['followup','agent-end'].includes(phase)?['a','b']:[]);
  return {async *[Symbol.asyncIterator](){if(n===1&&phase==='stream'){inject();assert.equal(signal.aborted,false)}yield {type:'done'}},result:async()=>result};
 };
 const config={model:{provider:'stub'},convertToLlm:x=>x,toolExecution:phase==='parallel'?'parallel':'sequential',getSteeringMessages:async()=>steering.splice(0),getFollowUpMessages:async()=>followup.splice(0)};
 if(phase==='followup')followup.push(user('Q'));
 await runAgentLoop([user('start')],{messages:[],tools},config,async e=>{if(e.type==='message_end'&&e.message.role==='assistant'&&n===1&&phase==='pre-dispatch')inject();if(e.type==='agent_end'&&phase==='agent-end')inject()},new AbortController().signal,stream);
 if(!['followup','agent-end'].includes(phase)){assert.equal(n,2);assert.deepEqual(trace.filter(x=>x.startsWith('start:')),['start:a','start:b']);assert(requests[1].includes('S'));assert(requests[1].includes('result:a'));assert(requests[1].includes('result:b'))}
 if(phase==='followup'){assert.equal(n,2);assert(requests[1].includes('Q'))}
 if(phase==='agent-end'){assert.equal(n,1);assert.equal(steering.length,1)}
 console.log(JSON.stringify({engine:'pi-loop',phase,trace,requests,pendingSteers:steering.length}));
}
const {ReactLoopAgent}=load('harness/packages/core/agent-loop/src/agent.ts','ReactLoopAgent',{ToolCallRecovery:class{observe(){}results(){return []}}});
for(const phase of ['turn-stopping','turn-end-microtask']) {
 const a=Object.create(ReactLoopAgent.prototype); let pending=[],turns=0,steps=0,once=false;
 Object.assign(a,{phase:{kind:'running',abort:new AbortController(),turn:0,step:0,wakeRequested:false},inbox:{get nextStep(){return pending},get hasPending(){return pending.length>0},splice(_target,_start,_delete,msgs){pending.push(...msgs)}},dispatch:{emit(){},async serial(){if(phase==='turn-stopping'&&!once){once=true;a.steer(user('S'))}}},ctx:{on(){return ()=>{}}},session:{append(type){if(type==='turn/start')turns++;if(type==='turn/end'&&phase==='turn-end-microtask'&&!once){once=true;queueMicrotask(()=>a.steer(user('S')))}return {seq:0}}},preStep:async()=>{pending=[];return {kind:'enter',messages:[user('input')],toolSet:{dispose(){}}}},step:async()=>{steps++;return {kind:'completed'}}});
 await a.kick();
 if(phase==='turn-stopping'){assert.equal(steps,2);assert.equal(pending.length,0)}else{assert.equal(steps,1);assert.equal(pending.length,1);assert.equal(a.status,'idle')}
 console.log(JSON.stringify({engine:'harness-driver',phase,turns,steps,status:a.status,pending:pending.length}));
}
const {PendingMessageQueue}=load('pi/packages/agent/src/agent.ts','PendingMessageQueue');
const q=new PendingMessageQueue('one-at-a-time');q.enqueue(user('1'));q.enqueue(user('2'));q.mode='all';assert.deepEqual(q.drain().map(x=>x.content),['1','2']);
console.log(JSON.stringify({engine:'pi-queue',phase:'mode-change-existing',drained:['1','2']}));
const {applyBoundary}=load('pi/packages/durable/src/harness/inbox.ts','applyBoundary',{defineDoc:x=>x,UserEntry:{kind:'pi.user'}});
for(const at of ['postTools','final']){
 const placed=[];const items=[{id:1,mode:'followUp',content:'Q'},{id:2,mode:'steer',content:'S'}];
 const tx={appendEntry:async(_kind,_id,draft)=>{placed.push(draft.model[0].content);return {id:placed.length}},placeSubmission(){}};
 await applyBoundary(tx,{conversationId:1,inbox:{items},steeringMode:'one-at-a-time',followUpMode:'one-at-a-time'},at,0);
 assert.deepEqual(placed,at==='final'?['Q','S']:['S']);
 console.log(JSON.stringify({engine:'pi-durable-inbox',phase:at,placed,pending:items.map(x=>x.content)}));
}
```

</details>

校验下载内容可用 `shasum -a 256`；本次 Pi `packages/agent/src/agent-loop.ts` 为 `9d7589b5071ea3b8b3e3c624f9cfc09a976ebf7436024a58213837de4645167d`，durable `generation.ts` 为 `70399cbe8473207faf1c921e207d03e9c8e02d2d34edec0ae88021d400931986`。源码/脚本和原始输出仅短期存于系统临时目录；本文件保留完整脚本、结果摘要与固定来源，结束时清理临时副本。

## 固定 SHA 一手来源索引

正文 F 结论均回链到实现或同仓正式文档；上游测试作为设计意图的补充证据，**没有标作本轮运行通过**。

[H-loop]: https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/agent-loop/src/agent.ts#L163-L189
[H-turn]: https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/agent-loop/src/agent.ts#L319-L425
[H-wake]: https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/agent-loop/src/agent.ts#L215-L273
[H-prestep]: https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/agent-loop/src/agent.ts#L276-L305
[H-batch]: https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/tools/src/batch.ts#L50-L233
[H-results]: https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/tools/src/batch.ts#L243-L279
[H-inbox]: https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/agent-loop/src/inbox.ts#L90-L174
[H-wait]: https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/jobs/tool-jobs/src/index.ts#L458-L520
[H-wait-test]: https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/jobs/tool-jobs/tests/steer-wait.spec.ts#L88-L240
[H-host]: https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/api/session-controller/src/commands.ts#L320-L341
[H-edit]: https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/api/session-controller/src/commands.ts#L408-L480
[H-sdk]: https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/sdk/server/src/server.ts#L248-L269
[H-sdk-doc]: https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/sdk/client/README.md#L30-L60
[H-policy]: https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/client/ui-conversation/src/client/input/submission-policy.ts#L18-L86
[H-setting]: https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/client/ui-conversation/src/submission-settings.ts#L8-L32
[H-config]: https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/agent-loop/README.md#L50-L75
[H-resume]: https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/agent-loop/src/index.ts#L790-L810
[H-repair]: https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/session/src/repair.ts#L100-L196
[P-loop]: https://github.com/earendil-works/pi/blob/db14038bd847c5bad57de217e0ac0c5ad1ae60ba/packages/agent/src/agent-loop.ts#L184-L329
[P-prepare]: https://github.com/earendil-works/pi/blob/db14038bd847c5bad57de217e0ac0c5ad1ae60ba/packages/agent/src/agent-loop.ts#L184-L251
[P-tools]: https://github.com/earendil-works/pi/blob/db14038bd847c5bad57de217e0ac0c5ad1ae60ba/packages/agent/src/agent-loop.ts#L518-L787
[P-agent]: https://github.com/earendil-works/pi/blob/db14038bd847c5bad57de217e0ac0c5ad1ae60ba/packages/agent/src/agent.ts#L289-L419
[P-queue]: https://github.com/earendil-works/pi/blob/db14038bd847c5bad57de217e0ac0c5ad1ae60ba/packages/agent/src/agent.ts#L149-L179
[P-doc]: https://github.com/earendil-works/pi/blob/db14038bd847c5bad57de217e0ac0c5ad1ae60ba/packages/agent/README.md#L390-L427
[P-session-end]: https://github.com/earendil-works/pi/blob/db14038bd847c5bad57de217e0ac0c5ad1ae60ba/packages/coding-agent/src/core/agent-session.ts#L1873-L2038
[P-session-queue]: https://github.com/earendil-works/pi/blob/db14038bd847c5bad57de217e0ac0c5ad1ae60ba/packages/coding-agent/src/core/agent-session.ts#L2237-L2327
[P-setting]: https://github.com/earendil-works/pi/blob/db14038bd847c5bad57de217e0ac0c5ad1ae60ba/packages/coding-agent/src/core/agent-session.ts#L2760-L2776
[P-editor]: https://github.com/earendil-works/pi/blob/db14038bd847c5bad57de217e0ac0c5ad1ae60ba/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L4701-L4757
[P-cli]: https://github.com/earendil-works/pi/blob/db14038bd847c5bad57de217e0ac0c5ad1ae60ba/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L3338-L3346
[PD-inbox]: https://github.com/earendil-works/pi/blob/db14038bd847c5bad57de217e0ac0c5ad1ae60ba/packages/durable/src/harness/inbox.ts#L7-L109
[PD-submit]: https://github.com/earendil-works/pi/blob/db14038bd847c5bad57de217e0ac0c5ad1ae60ba/packages/durable/src/harness/submissions.ts#L185-L275
[PD-abort]: https://github.com/earendil-works/pi/blob/db14038bd847c5bad57de217e0ac0c5ad1ae60ba/packages/durable/src/harness/submissions.ts#L121-L168
[PD-round]: https://github.com/earendil-works/pi/blob/db14038bd847c5bad57de217e0ac0c5ad1ae60ba/packages/durable/src/harness/generation.ts#L645-L759
[PD-final]: https://github.com/earendil-works/pi/blob/db14038bd847c5bad57de217e0ac0c5ad1ae60ba/packages/durable/src/harness/generation.ts#L613-L642
[PD-sequential]: https://github.com/earendil-works/pi/blob/db14038bd847c5bad57de217e0ac0c5ad1ae60ba/packages/durable/src/harness/generation.ts#L267-L284
[PD-scheduler]: https://github.com/earendil-works/pi/blob/db14038bd847c5bad57de217e0ac0c5ad1ae60ba/packages/durable/src/harness/scheduler.ts#L490-L515
[PD-mode-test]: https://github.com/earendil-works/pi/blob/db14038bd847c5bad57de217e0ac0c5ad1ae60ba/packages/durable/test/harness-inbox.test.ts#L182-L214
[PD-persist]: https://github.com/earendil-works/pi/blob/db14038bd847c5bad57de217e0ac0c5ad1ae60ba/packages/durable/README.md#L115-L142
[PD-replay]: https://github.com/earendil-works/pi/blob/db14038bd847c5bad57de217e0ac0c5ad1ae60ba/packages/durable/src/harness/tool.ts#L181-L211
[PD-types]: https://github.com/earendil-works/pi/blob/db14038bd847c5bad57de217e0ac0c5ad1ae60ba/packages/durable/src/harness/types.ts#L578-L594
[H-stream]: https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/agent-loop/src/agent.ts#L428-L598
[P-cli-followup]: https://github.com/earendil-works/pi/blob/db14038bd847c5bad57de217e0ac0c5ad1ae60ba/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L4488-L4498
[P-results]: https://github.com/earendil-works/pi/blob/db14038bd847c5bad57de217e0ac0c5ad1ae60ba/packages/agent/src/agent-loop.ts#L940-L953
