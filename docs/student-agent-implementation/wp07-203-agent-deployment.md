# WP07 #203：Agent 独立部署与跨机验收

[需求 #203](https://github.com/paher-din/XunJie/issues/203)的实现、工程验证和本票部署验收已完成。最终交付为 `final-r4` 两平台完整产品包；六个真实模型主循环及 Windows 独立 Agent 生命周期检查全部通过，一次性环境已清理。

[双轴审查与需求对应](wp07-203-code-review.md) · [工程证据](evidence/wp07-203/engineering-verification.json) · [部署与耗时汇总](evidence/wp07-203/deployment-verification.json) · [最终清理](evidence/wp07-203/final-task-cleanup-r4.json)

## 运行组合与设备

维护者通过 WP01 安装、发现和授权实际服务；学生继续使用既有学校页面、活动和模型设置。独立 Agent 仅持有教学 Agent owner，依赖数据、模型与执行通过原实际所有者提供。Root 保存当前模型选择引用；配置与凭据保留原持有方，已接收请求、段、attempt、命令和 Wait 固定原归属。

| 设备 | 实际版本与用途 |
| --- | --- |
| Apple Silicon Mac，`Robert-Wu-MacBook-Air.local` | arm64，macOS 27.2；学校、独立 Agent，以及前三种模式的模型 owner；Chrome 156.0.8078.80。 |
| Windows，`LAPTOP-S7A4IQFU` | Windows 11 x64，系统版本 10.0.26200；跨机模型 owner、桌面 Chrome 156.0.8078.80，以及独立 Agent 生命周期检查。 |
| 包内运行资源 | 两平台均为 Node 24.21.0、PostgreSQL 18.6。Windows 默认 PATH 的 Node 24.15 未用于产品运行。 |

三组跨机用例中，Agent 与学校位于 Mac，模型实际 SDK 外发来自 Windows。Windows Chrome 通过 Interactive/Limited 的 Session 1 运行，执行课程 WASM。产品流量直连 LAN HTTPS；SSH 仅传送维护控制与任务私有数据。证书 SAN、公开 CA 与 LAN TLS 检查见 [TLS 准备](evidence/wp07-203/tls-preparation.json)、[LAN 验证](evidence/wp07-203/tls-lan-preflight.json)，本轮没有修改全局证书信任。

独立 Agent 的 `teaching.agent` 与依赖 owner 的 `teaching.dependencies` 分别授权，服务、安装与 grant 身份记录在各报告。跨机选择先经设备主动 `modelChoices` 发布，学校正式 `models/selection` 可直接发现选项；发现不改变 pointer，随后以版本 CAS 显式选用。没有 Agent capabilities 预热或设备本地 pointer 代写，最终 Run 必须使用 Windows 的已选连接，Mac 模型 relay 外发为零。

## 最终产品包

两平台 application SHA256 均为 `3b7ec1095c04c2e891f87968c8e71d269cb798158246fc4e1d26f5b820bfb73c`。完整分发摘要、实际目录及 Windows 同步校验见 [包记录](evidence/wp07-203/final-candidates-r4.json)、[Windows 校验](evidence/wp07-203/final-windows-package-r4.json)。保留位置：

- Mac：`dist/product-darwin-arm64-wp07-203-final-r4`。
- Windows 分发：`dist/product-win32-x64-wp07-203-final-r4`；实际 Windows 副本为 `D:/XunJie-acceptance/wp07-203/product-final-r4`。

[源码记录](evidence/wp07-203/final-r4-source.json)包含 588 个源码、19 个关键文件和 23 个组件文件的摘要及探针摘要；打包后与主线逐一核对一致。包由独立构建快照生成。记录中的 Git commit 是捕获时的基点，实际候选源码由这些工作区摘要确定；文档收尾不改变产品代码。

## 真实端点与浏览器结果

[正式探针](../../scripts/probe-agent-deployment.mjs)使用生产 HTTP/capability、真实 DeepSeek `deepseek-flash`、课程表格聚合组件与实际浏览器 broker/WASM，不替换模型、执行结果或 Wait。固定初始样例通过正式 workspace API 保存并加入问题的固定作品版本；实际结果为 12 行、3 组、总平均分 `83.33333333333333`。

| 模式 | 浏览器 | 结果与真实请求 | 证据 |
| --- | --- | --- | --- |
| 全本机 Chat | Mac Chrome | 通过，2 次 | [记录](evidence/wp07-203/accepted-local-chat-r4.json) · [实屏](evidence/wp07-203/accepted-local-chat-r4-chrome.png) |
| 学校统一服务 Chat | Mac Chrome | 通过，2 次 | [记录](evidence/wp07-203/accepted-school-chat-r4.json) · [实屏](evidence/wp07-203/accepted-school-chat-r4-chrome.png) |
| 独立 Agent Chat | Mac Chrome | 通过，2 次 | [记录](evidence/wp07-203/accepted-agent-chat-r4.json) · [实屏](evidence/wp07-203/accepted-agent-chat-r4-chrome.png) |
| 跨机 Chat | Windows Chrome / Session 1 | 通过，2 次 | [记录](evidence/wp07-203/accepted-cross-chat-r4.json) · [实屏](evidence/wp07-203/accepted-cross-chat-r4-windows-chrome.png) |
| 跨机 Responses | Windows Chrome / Session 1 | 通过，2 次 | [记录](evidence/wp07-203/accepted-cross-responses-r4.json) · [实屏](evidence/wp07-203/accepted-cross-responses-r4-windows-chrome.png) |
| 跨机 Messages | Windows Chrome / Session 1 | 通过，2 次 | [记录](evidence/wp07-203/accepted-cross-messages-r4.json) · [实屏](evidence/wp07-203/accepted-cross-messages-r4-windows-chrome.png) |

每个主循环均完成正式提问、模型工具意图、持久 Wait、浏览器实际执行、原 Wait 消费和模型解释。刷新与原宿主/Agent 重启后，仍查询同一个 request/Run，实际请求数保持 2。每种协议使用独立临时成员和活动，原生工具 ID 不跨协议拼接。同机独立 Agent 只作为独立装配证据，跨机证明来自 Windows 模型 owner 与 Windows Chrome。

[Windows Agent 零生成检查](evidence/wp07-203/accepted-windows-agent-profile-r4.json)通过真实 install/start/status、维护备份、stop/delete：仅 `client` 与 `teaching-agent`，独立 managed PostgreSQL ready；未配置依赖时为 degraded。通过公开 `runtime.recovery.backup` 的 owner manifest 核对 `storage/1;owner/4`，没有直接读取业务表。此项不启动 provider relay，真实生成 0 次，备份与环境根均已清理。

## 实测耗时

以下单位为秒。首块从实际供应商外发至首个响应 data，两个数依次对应工具请求与解释请求；工具/正文 delta 单独记录。工具耗时包含刻意等待浏览器启动和网络时间；提问至结果包含完整双模型步骤及浏览器协调，不代表纯计算耗时。刷新/重启计时至原请求核对完成。原始字段见各报告的 witness 与 `stages[].fact`，汇总见 [metricsMs](evidence/wp07-203/deployment-verification.json)。

| 模式 | 供应商首块（两次） | 首个工具 delta | 首个解释 delta | 工具含等待 | 提问至结果 | 刷新/重启 |
| --- | --- | --- | --- | --- | --- | --- |
| 全本机 Chat | 0.127 / 0.088 | 1.082 | 1.892 | 3.022 | 10.384 | 1.875 |
| 学校统一服务 Chat | 0.103 / 0.121 | 1.093 | 1.753 | 3.057 | 8.806 | 1.877 |
| 独立 Agent Chat | 0.107 / 0.589 | 0.977 | 3.019 | 10.286 | 36.449 | 2.593 |
| 跨机 Chat | 0.163 / 0.117 | 2.723 | 1.868 | 12.050 | 70.827 | 2.683 |
| 跨机 Responses | 0.450 / 0.634 | 1.829 | 2.018 | 9.441 | 70.493 | 2.709 |
| 跨机 Messages | 0.144 / 0.478 | 1.453 | 2.554 | 8.464 | 66.787 | 2.786 |

local 的第二次回复已 HTTP 200、解释完整且 Run 持久完成；relay 观察到连接关闭，但没有观察到 HTTP `end`，原始 `streamEndObserved:false` 保留，不推定原因。其余 r4 请求的 stream end 均已观察。HTTP 状态、应用终态、流结束观测是分别记录的事实。

## 工程验证

最后修复后完整 `npm run verify -- --jobs 3` 通过，含类型检查、构建、公共 wire、文档链接，以及 unit 28、server 88、tools 45 个验证任务。受影响原生核心复验 24/24、工具恢复整文件 17/17 通过。广泛原生批次的 196 项中首次 191 通过、5 项启动失败，以及后续连接池竞争的确定性复现与修复，均在[工程记录](evidence/wp07-203/engineering-verification.json)与[审查说明](wp07-203-code-review.md)保留，首次失败没有改写为通过。

Mac 桌面 Chrome 的设置/中文输入/焦点/对话/工具初轮 15 项通过；最后停止修复影响的对话与工具 6 项再次通过。旧 UI 基线截图用例跳过，单列记录。Windows 三种跨机协议在实际 Session 1 Chrome 完成生产链路，版本、截图和原请求身份均在上表。

## 失败、更正与调用计数

本轮累计真实生成请求为 **28 次**：历史诊断 16 次，最终 r4 六个用例 12 次；Windows Agent 检查及清理均为 0。28 次均观察到 HTTP 200，无未结预留。计数、旧更正与内部上限 40 见 [共享账本](evidence/wp07-203/generation-budget.json)；每次测试配置最多 2048 输出 token、60 秒、SDK retries=0。完成范围后已停止外发。

| 原失败 | 更正与保留证据 |
| --- | --- |
| 首次 local 没有固定组件状态，真实课程工具未完成，已外发 2 次 | 通过正式 workspace 固定原样例后完成。原 [失败](evidence/wp07-203/local-chat.json)保留。 |
| school 准备时误用个人入口、policy 超过现行上限 | 均在外发前拒绝，生成 0；改用学校管理入口与合法 policy。原 [403](evidence/wp07-203/school-diagnostic-r2.json)、[400](evidence/wp07-203/school-diagnostic-r2b.json)保留。 |
| r2 跨机业务完成后 Windows 清理 EBUSY | 原 [失败记录](evidence/wp07-203/final-cross-chat-r2.json)、[现场核对](evidence/wp07-203/cross-r2-cleanup-audit.json)、[清理重试](evidence/wp07-203/cross-r2-cleanup-retry.json)保留。清理与付费 witness 分开结清，Windows sharing error 有界重试；旧账面保守扣留已按实际 2 次更正。 |
| r3 Windows Agent 备份证明用了 host key 参数 | [原记录](evidence/wp07-203/accepted-windows-agent-profile-r3.json)保留；改用 `setCredential` 与公开 `recoveryKeyRef`，r4 完整检查通过，生成 0。 |
| r4 私有打包快照缺少组件文件 | 补齐组件并固定 Node 24.21 PATH 后两平台打包通过，生成 0；[尝试记录](evidence/wp07-203/r4-packaging-attempts.json)保留。 |

r1/r2/r3 主循环是被替代候选的诊断证据，最终结果只以上表 r4 为准；旧包已删除，原报告及摘要继续保留。

## 清理与验收边界

[最终清理审计](evidence/wp07-203/final-task-cleanup-r4.json)通过：两平台任务 runtime root、任务进程、Chrome job/计划任务、测试 CA/私钥、私有构建快照和旧候选均已清理。仅保留最终两平台包、Windows 最终部署副本及脱敏证据；没有修改共享部署。主线 Chrome 产生的临时 PG 环境也已停止并删除。

工程、实际部署、浏览器与教学效果分别记录。local 用例为全本机 profile 内的学校课程成员活动；没有把它等同于个人自由活动的全部行为。Windows native 隔离课程执行与 Linux 产品部署本票没有补跑；教学效果未评估。完整崩溃、撤权和并发故障由相关工程回归证明，简单重启探针不替代这些反例。

## 复验入口

使用 Node 24.21.0 与仓库依赖，先完成构建，再执行原生回归；运行原生产品夹具期间保持共享 `dist` 稳定。打包使用新的输出目录；正式 CLI 和独立 Agent 配置见 [local-runtime](../../apps/local-runtime/README.md)。

```sh
npm run verify -- --jobs 3
npm run package:product -- --platform darwin-arm64 --profile full --out dist/product-darwin-arm64-wp07-replay
npm run package:product -- --platform win32-x64 --profile full --out dist/product-win32-x64-wp07-replay
```

真实端点探针使用 `--mode local|school|agent|cross|windows-agent`，协议使用 `--protocol chat-completions|responses|messages`。例如：

```sh
wp07_product="$PWD/dist/product-darwin-arm64-wp07-203-final-r4"
wp07_node="$wp07_product/resources/node/bin/node"
wp07_evidence=docs/student-agent-implementation/evidence/wp07-203
"$wp07_node" scripts/probe-agent-deployment.mjs --mode local --product "$wp07_product" \
  --max-generations 40 --out "$wp07_evidence/replay-local-chat.json"
```

跨机复验前重新同步探针与公开 CA，按当前 LAN 地址准备新证书和私钥；本轮测试密钥已删除。`cross` 通过 `--ssh win --remote-product ... --remote-script ... --remote-ca ... --lan-host ... --certificate ... --key ...` 指定维护连接和 HTTPS 资源，`windows-agent` 沿同一 SSH 控制入口且强制零生成。凭据从既有私有配置或 `--credentials-file` 读取，保持同一输出目录的实际调用账本，不把新报告当作计数重置。
