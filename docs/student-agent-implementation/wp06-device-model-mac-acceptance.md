# WP06 #168 · Apple Silicon Mac 验收交接

2026-11-03 已在 Apple Silicon Mac 上执行（提交 `b35fad3`），结果见文末「Mac 验收记录」。负责人已同意延期真实跨机验收。以下步骤使用同一台 Mac 上的两个正式产品进程，记录为同机双进程。Windows、Mac、真实上游和跨机结果分别登记。关联 [#168](https://github.com/paher-din/XunJie/issues/168) 与 [Mac 汇总 #178](https://github.com/paher-din/XunJie/issues/178)。

## 环境和正式构建

在 `wp06` 检出实际待验提交。使用 Apple Silicon 原生终端、Node 24.21.0、PostgreSQL 18.6、安装版桌面 Chrome。记录 `git rev-parse HEAD`、`sw_vers`、`uname -m`、Node、PostgreSQL 和 Chrome 版本。以下命令中的缓存和输出路径可替换为独立测试卷路径，输出包目录须尚不存在。

```bash
npm run typecheck
npm run check:docs
npm run build
npm run package:product -- --platform darwin-arm64 --profile full \
  --cache "$XJ_TEST_CACHE" --out "$XJ_TEST_PACKAGE"

export XUNJIE_PRODUCT_POSTGRES_BIN="$XJ_TEST_PACKAGE/resources/postgres/bin"
node --test --test-concurrency=1 \
  packages/product-runtime/test/hybrid-learning.runtime.test.mjs \
  apps/server/tests/model-client.runtime.test.mjs \
  apps/server/tests/model-gateway.runtime.test.mjs \
  apps/server/tests/model-chat.runtime.test.mjs
```

核对包中 `xunjie` 和 `循阶.command` 的启动与停止、服务身份、运行版本、模型 owner schema 10。另用 `xunjie install --profile model --root <独立环境>` 装配，在同一产品设置入口 `?settings=models` 配置并检查模型。用 `status` 核对 `model-connection` 服务身份，确认未装配 `learning-data`。记录包产物 SHA-256、工程用例计数和每个失败的实际阶段。测试前预留独立测试环境和备份空间。

## Chrome 与正式模型设置

在已安装 Chrome 中有头运行，每轮单 worker。第一轮 `XUNJIE_PRODUCT_WEB_ROOT` 指向普通构建的 `apps/web/dist`，第二轮清除此变量并设置 `XUNJIE_PRODUCT_TEST_PACKAGE="$XJ_TEST_PACKAGE"`。保留两轮各自的报告。

```bash
XUNJIE_E2E_BROWSER_CHANNEL=chrome npm run test:e2e -w @xunjie/web -- \
  --headed --workers=1 personalModelSettings.spec.ts modelSelection.spec.ts messagesModelSettings.spec.ts
```

在正式设置手工验证学校默认、配对设备个人连接、断开和重新认证。切换空间或在旧请求返回前继续输入，核对草稿和当前主体不会被旧回执覆盖。恢复后核对接管提示、历史结果和新调用资格。另在未配置凭据的连接上检查状态提示及调用禁用。若最终版本有显著 UI 调整，保存同入口实际运行的前后截图。

## 模型 owner 与恢复

- 在设备建立个人 Chat 连接和显式使用授权。检查学校控制端只见脱敏投影，设备通过 WP01 通道主动拉取任务，WP02 成员和学习 owner 绑定一致。重复提交同一 `taskId` 返回同一任务，换设备安装身份无法读取回执，学校重启后可按原 ID 查询。
- 通过设备上的正式模型入口准备固定图片与原生段，用配对通道分别提交接收、派发、查询和取消任务。记录同一 `attemptId`、结果引用、固定图片哈希、工具调用 ID 和结清状态。设备断开或丢失回执后查询原尝试，核对外发次数、终态、usage 和 `upstreamStopped`。
- 在旧 owner 9 的独立测试环境创建配置和已完成结果，按 WP01 正式升级流程生成 owner 10 候选备份。在独立目标隔离还原、校验资源和配置并完成接管，复核原结果与续接段、任务回执、凭据状态和旧授权失效。记录源与目标安装 ID、备份 ID、schema 版本及实际命令结果。恢复旧授权后能继续派发属于失败。
- 模拟进程中断，先进入维护再查询。可确认旧处理者结束时，原调用保留未知结果和用量且不重发。物理调用或持久提交未收束时，维护不得报告可安全停机。

需要真实 Chat 上游时使用获准的私有凭据与既定目标路线，单次请求限额、总请求次数和取消结果均应记录。可另测设备本机 Chat 地址。证据只保留脱敏状态、哈希、引用、版本和有限用量，避免记录密钥、认证头或原生推理正文。

## 回填

逐项填写通过、失败、跳过或未执行。分开登记工程、正式包、普通 Web Chrome、产品包 Chrome、真实上游、同机双进程、独立装配、升级与接管。真实跨机标为延期，教学效果标为未评估。

## Mac 验收记录

2026-11-03 于 macOS 27.2（构建 26B123）、MacBook Air（Mac17,3）、Apple M5 / arm64、16 GiB 上执行，提交 `b35fad3`，分支 `wp06`。Node 24.21.0、npm 11.19.0、PostgreSQL 18.6（发行版 18.6.1）、安装版桌面 Google Chrome 156.0.8078.80。完整包为 unsigned candidate，`distribution.json` SHA-256 为 `cb892f4bc5bdbcf255a4393aba25dc064b16637a5b0dbbc5c0869b81bdd69a89`，4088 个文件 / 399 MB。汇总见 [Mac 验证 JSON](evidence/wp06-device-model-mac-verification.json)。

| 项目 | 结果 |
| --- | --- |
| 工程与正式包 | `npm run typecheck`、`npm run check:docs`（180 份文档、1455 个本地目标、0 失败）、`npm run build` 通过。四个 PostgreSQL 运行时测试文件 21/21 通过、0 跳过、0 失败，322 秒。`darwin-arm64` 完整包构建成功，包内 Node 24.21.0 与 PostgreSQL 18.6 可执行。 |
| 独立 `model` 装配 | `xunjie install --profile model`、`start`、`status`、`stop` 通过；`循阶.command` 的 `start`、`status`、`stop` 同样通过。服务为 `client`、`space-course`、`model-connection`，无 `learning-data`；PostgreSQL 18.6 为 ready；`model-connection` schema 为 `storage/1;owner/10`；停止后维护记录 `safeToStop=true`。 |
| 普通 Web Chrome | 普通构建 `apps/web/dist` 上 11/11 通过、0 跳过；`channel=chrome`、有头、单 worker。覆盖选用与撤权、断连后重新读取、迟到回执不覆盖新输入、未配置渠道禁用调用，以及“此环境已完成接管”提示。[报告](evidence/wp06-device-model-e2e-normal-web-mac.json) |
| 产品包 Chrome | 完整产品包上 11/11 通过、0 跳过；同样使用安装版 Chrome、有头、单 worker，由包内 Node/PostgreSQL 在仓库外临时 root 启动。[报告](evidence/wp06-device-model-e2e-package-mac.json) |
| 同机双进程 | 同一台 Mac 上两个独立产品运行时（各自 PostgreSQL 与服务进程）完成学校排队、设备主动拉取、重复 `taskId` 返回同一任务、缺失/异安装回执拒绝、Chat 文本、固定 PNG、工具往返、在途取消（`client-abort`、`upstreamStopped=unknown`）及取消后重复派发。外发共 3 次，重复派发未增加；全程无 `learning-data`。用例通过，132.9 秒。 |
| 独立模型接管 | `model` 装配备份→隔离还原→接管通过：授权、固定图片、原生工具、原结果引用与待结清工具保留，无 `learning-data`，接管后按原引用继续并完成新调用。 |
| 维护与中断 | 生产派发进程被杀后保留 unknown usage 且不重放，并回收已死本机槽位；维护等待已接收结果落盘后才关闭并恢复可用槽位；原生结果未可靠发布时不报完成、不释放仍在运行的物理请求。对应运行时用例通过。 |
| 旧 schema 升级 | 用 `cf076b5` 构建 owner 9 完整包创建连接、已完成与已取消检查；当前包正常启动被精确兼容闸拒绝（`Storage operation failed: incompatible`）。经正式 `upgrade`、隔离 `maintenance`、`takeover` 到 `owner/10`，目标 `ready`。连接、凭据、原结果引用、用量和取消事实保留；历史尝试重复派发未外发；新调用完成（共 3 次上游请求）；旧源启动被拒绝（`Recovery: source-retired`）。[脱敏证据](evidence/wp06-schema9-to-10-mac.json) |
| 真实 DeepSeek Chat | 核心用例通过（最终轮）；前 4 轮受上游 503 影响，尝试次数、能力限制与用量见下节。[最终报告](evidence/wp06-device-model-deepseek-mac.json) [尝试记录](evidence/wp06-device-model-deepseek-mac-attempts.json) |
| 真实跨机 | 延期（负责人已同意）。同机双进程与独立模型接管已单独登记，不充抵真实跨机。 |
| 教学效果 | 未评估。 |

### 真实 DeepSeek Chat

使用获准私有凭据与既定路线 `https://api.deepseek.com/v1/chat/completions` / `deepseek-flash`（thinking），SDK `openai@7.42.0`、adapter `xunjie-chat-native-v2`、`maxRetries=0`，每次最多 2048 输出 token、30 秒。5 轮显式探针共 18 次实际生成尝试，明细见 [脱敏尝试记录](evidence/wp06-device-model-deepseek-mac-attempts.json)。

前 4 轮（16 次）受已确认的 DeepSeek V4.1 Flash 上游事件影响：图片/工具与 JSON 用例收到 HTTP 503；native strict schema 与 thinking 下强制具名工具按已测限制返回 HTTP 400；首轮 JSON mode 应用校验成功。事件开始于 2026-11-03T08:58:16Z，状态页当时报告 “DeepSeek V4.1 Flash API and Chat Service are partially unavailable”。恢复后的最终核心轮次（2 次）通过：固定图片与双工具往返完成（usage 输入 600 / 输出 76 / 总计 676），重启后原生续接保留（native 保真、工具返图与 nonce 核对通过，usage 输入 934 / 输出 57 / 总计 991，缓存 640、推理 21），见 [最终报告](evidence/wp06-device-model-deepseek-mac.json)。失败保留 `physicalRequestEnded=true`、usage unknown，SDK 未重试。Command Code 复验已豁免。
