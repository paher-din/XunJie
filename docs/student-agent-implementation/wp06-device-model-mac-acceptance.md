# WP06 #168 · Apple Silicon Mac 验收交接

状态为待执行。负责人已同意延期真实跨机验收。以下步骤使用同一台 Mac 上的两个正式产品进程，记录为同机双进程。Windows、Mac、真实上游和跨机结果分别登记。关联 [#168](https://github.com/paher-din/XunJie/issues/168) 与 [Mac 汇总 #178](https://github.com/paher-din/XunJie/issues/178)。

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
