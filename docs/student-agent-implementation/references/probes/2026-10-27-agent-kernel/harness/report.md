# DeepSeek Harness：固定源码进程内最小接入探针

日期：2026-10-27。固定上游：`22ddee3792402c3e70ec5f86a63c3e3e895a2f60`，`0.2.1-rc.3`。本目录仅为总体架构研究证据，不是应用依赖或生产实现。

## 判断

**“公开 SDK 没有单轮取消”是真实的 SDK wire 限制，但不能据此排除 Harness 内核。** 本次实际从固定源码构建了文档公开的 Cordis 组合，通过 `ctx.agents.create/resume`、`agent.cancel({ kind: 'user' })`、`whenIdle()` 和 `AgentHandle.dispose()` 工作。取消 A 的模型流或Agent 工具等待，均未停止同进程 B；A 随后能执行新一轮。无需改 wire、关 runtime 或补一个私有取消接口。[H1][H2][H3] 运行证据见 [results.json](results.json) 的 `cancellation`。

**它还不能算现成 npm 最小组合安装通过。** `dsh-agent-loop@0.2.1-rc.3` 可查询；安装所需 `dsh-tool-executor-native@0.2.1-rc.3` 返回 registry 404。因此成功证据属于“从固定源码构建、使用公开组合 API”，不是“发布包开箱可用”，更不是完整产品集成通过。没有修改上游运行逻辑，也没有借用上游测试替身或访问私有 Agent 字段。发布缺口见 [environment.json](environment.json)。[H4]

**一个须补偿的终态缺口已复现：** 自定义 adapter 输出完整工具块后直接 EOF、不输出 `finish`，Harness 默认视作 `stop`，实际进入了工具体。已报告 `error` / `aborted` / `max-tokens` 时则没有工具执行。故“完整流结束后再执行”不等于“框架验证了原生协议完整终态”：直接 SDK 薄 adapter / ModelGateway 必须把终态缺失显式转为错误，不能让裸 EOF 到达循环。探针的 `missing-guarded` 仅证明显式错误可以阻止执行，**没有实现或验证三家真实协议的终态识别器**。[H5][H6]

## 前轮依据及本轮范围

- [10 月 18 日内核工程判断](../../../2026-10-18-architecture-checks.md#内核取舍的工程判断)承认当时没有接入原型或性能比较，恢复、队列、调度变复杂后应重比；不能用旧自研建议作为本次胜负结论。
- [ADR 0002](../../../../adr/0002-own-teaching-state-and-effect-control.md)明确教学事实与执行控制自主不推出完整内核必须自研；其更新也明确完整内核仍在评估。文中旧 AI SDK Core 选择已被后续直接协议 SDK 决议替代。
- [10 月 23 日模型调用层依据](../../../2026-10-23-model-endpoint-assessment.md#从目标推导模型调用层)已经选择直接协议 SDK 加薄 adapter；原生历史、前缀与签名必须保留，工具参数完整且成功终态到齐后才可执行。本次不重做真实端点请求，不以内建 pi-ai adapter 替代该决定。
- [10 月 27 日调查](../../../2026-10-27-agent-kernel-reuse-research.md)、[共同 README](../README.md)及未修改的 [fixtures.mjs](../fixtures.mjs)提供输入与比较项。旧调查的 SDK 限制仍成立；其“进程内拼装不等于正式应用 profile”仍是启动/打包边界，但须补上本轮已验证的**公开编程组合与单会话取消**，不再将 SDK 缺口泛化为内核缺口。

所有运行只使用共同 fixture、确定性假模型、一个 `course_observe` 假Agent 工具；没有模型 SDK、真实模型连接、密钥、付费请求、coding persona、shell/read/write/image 等默认工具。npm/源码下载属于研究依赖获取，非模型调用。未另派 agent。

## 最小组合与构建性质

显式挂载 `LlmRuntime`、`SessionStore`、`SessionProjectionRegistry`、`SystemPrompt`、`ToolRuntime`、`AgentRegistry`、`AgentLoop`、JSONL persistence 与 checkpoint policy；使用公开导出的 `NativeToolExecutor`，仅注册 `course_observe`。这些是上游文档和包根 exports 对应的组合接口。[H1][H2][H4][H7][H8]

`FixtureAdapter extends LlmAdapter` 将工具参数分片投影为 Harness chunks，并把共同 fixture 的**完整原生响应对象**放到终态 `replayState.response`，不按可见文本重建。下轮请求验证 replay state 与工具结果调用身份；JSONL 落盘后以及新进程恢复后再次深比较。Harness 提供 opaque replay 槽，原件的装配与协议重放仍属 adapter；本探针没有声称 Harness 自动保留任意 SDK 原始字段。[H9]

构建器按固定源码的 `tsconfig.base.json` 公共入口别名解析 `@deepseek-ai/*`，使用 esbuild 将真实源码组合为一个 ESM bundle；这绕开的是未发布包和全仓构建体量，并未替换循环/存储/取消实现。JSONL 的 path-loaded worker 另外构建为 ESM，`worker.cjs` 仅动态导入它，以保留源码依赖的 `import.meta.url`。所有输入哈希保存在 [build-inputs.json](build-inputs.json)；[build.log](build.log)记录实际入口与外部依赖。不是上游全仓官方 build/test、类型检查、发布包一致性或打包发布验收。

外部原生锁使用官方 npm `@deepseek-ai/node-addon-system@0.1.2` 及 Darwin arm64 同版预构建，实际参与 JSONL 锁，未用锁替身。TS 运行逻辑来自固定提交；预构建二进制按版本及 npm integrity 固定，未证明其编译产物逐字节对应该 Git commit。JSONL 选择 `compression: 'none'`，未测 zstd/Windows 路径。[H7][H10]

## 运行结果：17 个情形

完整原始事件、断点前日志、恢复日志、终态和计数见 [results.json](results.json)，执行次序见 [run.log](run.log)。断言全部按预期完成，其中 `missing` 是确认缺口，不能计为产品契约通过。

| 情形 | 实际结果 | 谁提供/边界 |
| --- | --- | --- |
| Chat / Responses / Messages 各一次工具往返，3 项 | 每项 2 次假模型调用、1 次工具体；工具块和参数已完整但 finish 未放行时，工具体=0、assistant/message=0；工具体进入时，从真实 JSONL read handle 读到 assistant/message 与 tool/call | 上游循环等待流结束；checkpoint policy 提供工具体前 flush。假 adapter 显式携带完整原件 |
| error / aborted / max-tokens，3 项 | 均 1 次模型调用、0 次工具体 | 上游提供。adapter 的 aborted finish 在没有 Agent.cancel 时被记录为 turn/error；不要等同于用户取消 |
| 裸 EOF 缺 finish，1 项 | **1 次工具体、2 次模型调用、turn/completed** | 上游默认 finish=stop；不满足循阶“缺终态不执行”要求 |
| adapter 将缺 finish 映射为 error，1 项 | 1 次模型调用、0 次工具体 | 探针补的错误归一化；真正三协议完整性识别仍待实现 |
| 取消 A 模型流，同时 B 等工具，1 项 | A 的半轮未派发工具；B signal 未 abort、仍在原 turn，放行后完成；A 下一 turn 完成 | 真实公开 `agent.cancel` / signal / whenIdle；工具与模型须协作取消 |
| 取消 A 工具等待，同时 B 等工具，1 项 | A 工具 signal abort 并结算；B 未 abort、完成；A 下一 turn 完成 | 同上；不表示能硬杀不协作的进程内代码或撤销效果 |
| 未注册工具名称，1 项 | 0 次Agent 工具体，`UNKNOWN_TOOL` / ToolNotFoundError 成对工具结果 | 上游工具管线；不与副作用 unknown 混为一谈 |
| 完整响应已 flush、尚无 tool/call，SIGKILL 后恢复，三协议 3 项 | 原件恢复深比较相等；resume 自身模型调用=0、工具体=0，生成 `TOOL_NOT_STARTED`；显式新用户输入后只新调用一次模型，携带原件 | 断点通过公开 executor wrapper 在 native batch 前手动 flush，属探针故障注入；**不证明默认 policy 在此位置自动 flush**。上游修复历史，未自动继续执行旧工具意图 |
| 工具体收到命令、未返回结果，SIGKILL 后恢复，三协议 3 项 | 原件相等；resume 模型调用=0、工具体=0，生成 `TOOL_OUTCOME_UNKNOWN`；没有盲重放 | 工具体前 flush 是上游 checkpoint policy。按稳定 commandId 查询假执行器 receipt 是探针自有逻辑，不是 Harness 自动完成 |

“完整响应恢复”在这里是恢复已提交原件、配对修复历史，不重复向模型索取旧意图。它**不是** durable task scheduler 自动从模型输出进入未执行工具：无 started record 的调用在恢复时被配成 `TOOL_NOT_STARTED`，是否执行还需宿主另行决定。[H11] 若目标是“完整响应一旦保存就自主续跑原步骤”，仍需持久 continuation/command 状态，不能将上述恢复结果误算成这个要求已通过。

unknown 试验的假执行器只向临时文件追加一条 `{ commandId, accepted: true }` 后挂起。新进程按同一身份读到唯一 receipt，证明可在外层接稳定身份查询；未写第二次 receipt，也未重新进入工具体。该文件是探针辅助证据，不是生产命令账本、授权实现或断电 durability 证明。

## 可解释的收益与额外责任

**事实 F：有实测收益。** 可复用同进程多 Agent 的 loop/inbox/生命周期、协作取消、工具 schema/dispatch/result 配对、真实 SessionEvent 日志、JSONL 持久写入与恢复、语义 flush policy、`TOOL_NOT_STARTED` / `TOOL_OUTCOME_UNKNOWN` 修复。JSONL 实际加载原生锁，但未测试写所有权争用。调用者能精确 dispose 一个 Agent，无需终止整个服务。上述收益来自真实运行，不从“插件存在”推定。[H1][H2][H7][H8][H11]

**推断 I：取消不再是排除 Harness 的架构性理由。** 对可托管可信 Node 进程的本机或学校服务，公开组合接口是合理接入面；SDK wire 只是一种更外层包装。如果只允许远端 SDK runtime、不允许同进程组合，原取消缺口仍成立。这里没有验证共享服务身份/租户隔离。

| 仍由循阶负责 | 为什么不能算上游已经替代 |
| --- | --- |
| 直接协议 ModelGateway → LlmAdapter、原生输入装配、完成态/usage/error/abort 映射 | fixture 保存的是完整响应对象，不是三家 SDK 真正的请求重建器；裸 EOF 的屏障尤其必须补 |
| 原生历史前缀、签名与 route 规则 | Harness replayState 能保留 fixture；更换 system/tools、route A→B→A、压缩、前缀连续性未测。框架只向拥有历史 route 的 adapter 暴露 replayState，不自动满足协议前缀契约。[H9][H13] |
| 业务 run/step/attempt、固定课程版本、不可变 inputRef、授权与预算 | 不能把 sessionId/toolCallId 当完整业务命令身份；本次只有假 course input，未实现真实执行点复核或持久预算 |
| 稳定 commandId、receipt、unknown 查询与取消后晚结果 | 上游只把未知事实记入历史；本轮查询是自有假逻辑，且查询结果没有形成完整生产恢复状态机 |
| 未执行意图的自动续跑、长工具持久 waiting 与唤醒 | 本轮 resume 修复并停在 idle；没有证明释放 live Agent 后能凭业务回执自动唤醒且只唤醒一次 |
| 构建/发布/升级与生命周期治理 | 当前 native executor 发布 404，需要固定源码构建闭包或等待发布修复；全仓官方 build、发布包等价、声明生成与兼容升级尚未验证。上游自称 developer preview。[H12] |

**同等替代成本 I：** 继续用 Harness 时，本次可行路径是锁定源码与依赖、维护一个最小组合及 worker 打包入口，并接 ModelGateway/Agent 工具/业务账本；无需新增取消 wire，但有 Cordis/SessionEvent 接入和升级负担。若不用其现成内核，则自有 driver 仍须提供本轮已实测的 loop、单会话取消隔离、日志写所有权、持久前置屏障、结果配对及 crash-tail unknown 修复，不能只将“少一个框架”计作收益。两条路径都要实现协议终态验证、预算、权限和业务结果核实。代码行数和包数不能据此证明哪条生产维护成本更低。

**未测 U：** 真实 SDK/端点与计费、三协议请求前缀与字节级重放、路线切换/压缩、不同权限和课程版本恢复、预算与重试策略、持久异步等待/唤醒和取消晚回执、非协作工具停止、性能/资源上限/并发租户隔离、Node 24.21.0、Windows/Linux、zstd、上游完整测试与浏览器/教学效果验收。均不计通过。没有为本机 v24.18.0 另下载 toolchain。

## 环境、精确命令与复现

实际环境：macOS `27.0.1`、Darwin arm64；`/opt/homebrew/opt/node@24/bin/node` = `v24.18.0`，该 PATH 下 npm `11.16.0`；系统 Node `v26.0.0` / npm `11.12.1` 只用于初始环境识别，未用于探针。工程目标为 `24.21.0`，本次不是目标 runtime 验收。固定源码 archive SHA-256：`aac1a309de68ada068d9658ac173caabcfb3ed21e638bdf192f0abe37bb14d0b`。

实际目录为 `/tmp/xunjie-harness-probe.oIcWQf`，consumer 为其子目录；下面保留当次依赖与运行命令。`PROBE` 指向本报告目录，不修改应用工程：

```sh
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
PROBE='/Users/robertwu/Documents/Projects/AI+教育创新技能大赛/XunJie/docs/student-agent-implementation/references/probes/2026-10-27-agent-kernel/harness'
TASK_SOURCE=/tmp/xunjie-harness-probe.oIcWQf
mkdir -p "$TASK_SOURCE"
cd "$TASK_SOURCE"
curl -fL --retry 2 https://codeload.github.com/deepseek-ai/deepseek-harness/tar.gz/22ddee3792402c3e70ec5f86a63c3e3e895a2f60 -o source.tar.gz
shasum -a 256 source.tar.gz
tar -xzf source.tar.gz --strip-components=1
mkdir consumer
cd consumer
npm init -y
# 当次失败的安装：返回 dsh-tool-executor-native registry 404。
npm install --ignore-scripts --no-audit --no-fund --save-exact @deepseek-ai/cordis@4.0.5 @deepseek-ai/dsh-agent-loop@0.2.1-rc.3 @deepseek-ai/dsh-session-checkpoint-policy@0.2.1-rc.3 @deepseek-ai/dsh-session-persistence-jsonl@0.2.1-rc.3 @deepseek-ai/dsh-tool-executor-native@0.2.1-rc.3
# 随后从固定源码构建的实际依赖安装：三条均禁安装脚本。
npm install --ignore-scripts --no-audit --no-fund --save-exact esbuild@0.25.12
npm install --ignore-scripts --no-audit --no-fund --save-exact @deepseek-ai/node-addon-system@0.1.2 zod@4.4.3 p-limit@7.3.3
npm install --ignore-scripts --no-audit --no-fund --save-exact @js-temporal/polyfill@0.5.1
node "$PROBE/build.mjs" "$TASK_SOURCE" "$TASK_SOURCE/consumer" > build.log
node probe.mjs > results.json 2> run.log
```

复现可跳过失败安装及分次安装，将 [consumer-package.json](consumer-package.json)、[consumer-package-lock.json](consumer-package-lock.json) 复制为 consumer 内的 `package.json`、`package-lock.json`，执行 `npm ci --ignore-scripts --no-audit --no-fund` 后运行上述 build/probe。consumer 保持为源码根目录的子目录，供上游 version attribution 按原相对路径读取根 package.json。所有模型/工具仍为假实现。

已删除本次临时源码、下载包、node_modules、构建产物和假 JSONL/receipt 数据目录；保留本目录代码、锁文件、输入哈希、结果与运行记录。源码业务逻辑未修改；无 GitHub、Git 历史或共享 fixtures/README 修改。

## 一手来源

以下全部固定同一 commit。项目既有文档只用于负责人已定输入；运行结论直接来自本目录探针及真实上游实现。

[H1]: https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/agent-loop/README.md
[H2]: https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/agent/src/index.ts
[H3]: https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/sdk/client/README.md#known-limitations-and-deferred-work
[H4]: https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/tool-executor-native/package.json
[H5]: https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/llm/llm/src/assembler.ts#L186-L188
[H6]: https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/agent-loop/src/agent.ts#L534-L585
[H7]: https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/session/session-persistence-jsonl/src/index.ts
[H8]: https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/session/session-checkpoint-policy/src/index.ts
[H9]: https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/llm/llm/src/message.ts
[H10]: https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/native/system/packages/entry/src/flock.ts
[H11]: https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/session/src/repair.ts
[H12]: https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/README.md
[H13]: https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/llm/llm/src/index.ts#L1022-L1036
