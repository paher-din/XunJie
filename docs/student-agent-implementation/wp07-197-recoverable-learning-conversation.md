# WP07 #197 可恢复的基础学习对话

2026-11-05（Asia/Shanghai），分支 `wp07`，双轴审查基线 `6b4c3ee`。实现见 [teaching-agent README](../../packages/learning-space/src/teaching-agent/README.md)，审查记录见 [双轴审查](wp07-197-code-review.md)。

## 本轮范围决定

按修订版 [Issue #197](https://github.com/paher-din/XunJie/issues/197) 的范围决定执行：

- 不建设 token、成本、调用次数、Run 步骤数、累计生成时长或硬期限额度；保留实际 `usage` 事实与 unknown 状态。学校模型的预算以后按需设计。
- 不自动摘要、不任意截断历史或作品；容量不足保留完整输入与原生资源并暂停。
- 生成期间允许继续编辑，新问题作为可靠草稿等待当前 Run 结束；steering / queue 留给 #200。
- 工具、完整上下文选择与压缩、独立部署、跨安装接管分别留给后续实施票。
- 不建设旧数据兼容层；课程发布、活动绑定和导入都要求显式版本化帮助策略，开发样例、探针与脚本同步更新。

## 实现结果

### 所有权、接收与 session log

- 新增独立 PostgreSQL owner，迁移保存 `teaching_requests`、`teaching_runs`、`teaching_sessions`、`teaching_events`、`teaching_snapshots` 及所属资源。
- 复用 WP02 `ActionReceiver`：同身份同内容返回原回执，换内容冲突；接收前取消写入持久取消记录，迟到派发不能复活请求；接收、Run、输入和日志同事务提交。
- 活动级 `teaching_events` 使用数据库分配的稳定 `seq`，对话游标取最后返回事件的 `seq`，重复读取不增加模型调用。
- `RunDriver` 使用 `clock_timestamp()` 领取代际和 lease，条件提交保证单一推进权。lease 只用于推进权核验，不作为生成期限；过期接管先按原 attempt 身份查询/续接，已接受未派发的 attempt 由新推进者继续派发，不重复付费生成。
- 停止先持久关闭新尝试准入，再取消原调用；已发生正文和终态分别保存。失败或终止后 `continue` 建立关联后继 Run，原终态不复活。

### 上下文与快照

- `ContextBuilder` 分开平台指令、运行职责、课程规则、本次引用/作品/问题和跨 Run 历史；真实 `student/assistant` 角色进入原生段可移植前缀。
- 模型连接、固定前缀或配置变化时封存旧段并建立新段；同一配置下跨 Run 连续推进，不因 Run 结束自动换段。
- 每次外发前保存不可变快照：装配正文、来源、模型参数、`payloadSha256`、稳定关联的 segment / attempt / 原生请求资源。重建只读取已保存事实。
- 容量使用最终原生 payload 字符数、输出预留和保存的 `contextWindow` 记录 `counter:"unavailable"` 的必要条件检查；不把字符数伪装成 token 数，也不缩小配置窗口。前缀超过 400,000 字符或用户文本超过 1,000,000 字符时保留完整输入并暂停，不截断作品或历史。

### 模型与课程策略

- WP06 `ModelGateway` 增加正式学习用途：同一选择、授权、segment/check 状态机、三协议 SDK 和原生结果资源；学习调用不受探针次数、段序号、输出或时间上限约束，使用保存的 `contextWindow` / `maxOutputTokens`，不再被 2,048 输出上限静默改写。
- `models/calls` 仍只接受探针；学习 attempt 只由受认证的 `RunDriver` 在自己的 owner 内接收。
- 课程导入、持久化发布、活动绑定和读取都要求版本化 `helpPolicy`；`questions:"disabled"` 时接收前直接取消，不产生模型调用。

### 正式 UI 与恢复

- 首页提供“建立学习活动”和“建立并开始对话”：后者先把首问写入可靠草稿和固定请求身份，再建立无课程活动并通过同一活动模型发送。
- 活动页新增“学习对话”：显示学生/Agent/系统消息、Run 状态、停止、继续和缺模型设置入口；助手正文复用现有 `Markdown` 排版。
- 生成期间新问题保留为可靠草稿，发送按钮显示“等待当前回答”；活动切换隔离旧请求的迟到回复。
- 模型设置增加“上下文窗口”和“最大输出 token”，保存/读取/选择/学习请求使用同一配置版本。
- owner 接入迁移、资源保留、维护关闸、排空、验证、备份/还原/接管和恢复 namespace；普通重启后从原 attempt 继续。

## 验证

本机 macOS 27.2 / arm64，Node 24.21.0，PostgreSQL 18.6（Homebrew），安装版桌面 Chrome 156.0.8078.80，headed、单 worker。模型上游为本轮自行启动的合成 SSE fixture，不读取或调用真实付费供应商。

| 检查 | 结果 |
| --- | --- |
| 类型检查（contracts/storage/learning-space/server/product-runtime/local-runtime/web） | 通过 |
| 新增学习对话 runtime（真实 PostgreSQL、三协议 SDK transport、长上下文、课程策略、重启/停止/继续、快照重建、备份/还原/接管） | 9/9 通过 |
| 双推进者 lease/generation 竞争（两个独立 `driverId`） | 通过；只产生一次派发、一次取消、一条 `attempt-dispatched`、`assistant` 和 `run-completed` |
| 受影响既有 server runtime（课程、绑定、执行、草稿、恢复、checkpoint） | 29/29 通过 |
| 产品 CLI / school client 恢复与转发 | 3/3 通过 |
| 桌面 Chrome 正式产品页（首问、刷新、追加、生成期间草稿阻塞、停止、缺模型设置入口） | 2/2 通过 |
| 完整 `rtk bypass npm run verify` | unit 通过（26/27，跳过 1）；server 通过（86/87，跳过 1）；tools 仅 `xj-dev/tests/env-removal.test.mjs` 未通过，详见下文 |

### 工程结论

除下述未执行/既有问题外，本轮改动的类型检查、真实 PostgreSQL/SDK transport、三协议、跨 Run 续接、配置变化隔离、快照重建、备份还原和桌面 Chrome 路径均通过。日志摘要：`.verification/2026-11-05T15-06-10-249Z-zyd06B/summary.json`。

### 真实模型结论

未执行。本轮没有可用的付费模型授权，全部模型调用使用合成上游；因此不能把三协议 transport 通过等同于真实供应商质量、限流或费用结论。实际用量字段已在测试中记录为 `final`/`unknown`。

### 浏览器／产品包结论

Apple Silicon 上以安装版 Chrome 跑了正式产品 runtime 与真实 PostgreSQL：首问、课程外活动、刷新后恢复、追加问题、生成期间继续输入并保留草稿、停止、缺模型设置入口均通过。Windows 11 桌面 Chrome 与完整 Windows 产品包未执行（本机无 Windows 环境），不能据此声称 Windows 通过。

### 教学效果结论

未评估。本轮只验证对话持久性、恢复性和界面路径，没有课堂或学生样本。

## 界面前后对照

修改前（基线 `6b4c3ee` 构建）首页只有“建立学习活动”；活动讨论只有草稿，没有持久对话：

![修改前首页](evidence/wp07-197/baseline-home-darwin.png)

![修改前活动讨论](evidence/wp07-197/baseline-activity-darwin.png)

修改后首页提供两种创建语义并说明差异；活动讨论显示持久消息、Run 状态与停止/继续：

![修改后首页](evidence/wp07-197/teaching-home-darwin.png)

![修改后学习对话](evidence/wp07-197/teaching-conversation-darwin.png)

缺模型时保留活动、首问和草稿，并提供真实设置入口；设置弹窗新增上下文窗口与最大输出：

![缺模型状态](evidence/wp07-197/teaching-missing-model-darwin.png)

![模型设置新增字段](evidence/wp07-197/teaching-model-settings-darwin.png)

![停止后保留已发生内容](evidence/wp07-197/teaching-stopped-darwin.png)

## 未完成项与边界

- **增量正文公开**：当前在 native attempt 结束后一次公开完整答复；计划中的“增量正文经 Gateway 校验并持久化后公开”尚未实现。`teachingMessage.state` 保留 `streaming` 位置，但本轮服务端不产出增量事件。实现它需要 Gateway 新增经过敏感输出校验的进度 API，未在缺少该边界的情况下用未校验分片代替。
- **Windows 11 / 完整 Windows 产品包**：未执行。
- **真实模型问答**：未执行，见上。
- **`tools/xj-dev/tests/env-removal.test.mjs`**：在未改动的 `tools/xj-dev` 上单独复现失败（`barrier CLI exited: 1`、mutex inode 断言），与本轮学习对话改动无关；完整 verify 因此退出 1。
- **`packages/product-runtime/test/hybrid-learning.runtime.test.mjs`**：恢复阶段已越过此前的共享内存耗尽问题；随后在还原 runtime 的 `client/start` 上遇到既有 namespace 护栏 403。该路径未在本轮改动中发生变化，未作为学习对话验收结论。
- **`apps/server/tests/native-session.runtime.test.mjs`**：`nativeFixture` 只接受 `postgres --version` 以版本号结尾的输出；本机 Homebrew 18.6 带 `(Homebrew)` 后缀，测试环境检查失败，与本轮改动无关。

复跑入口（先按仓库固定 Node 24.21.0 构建）：

```sh
PATH=/tmp/node24/bin:$PATH node scripts/build.mjs typecheck
XUNJIE_PRODUCT_POSTGRES_BIN=/opt/homebrew/opt/postgresql@18/bin \
  node --test --test-concurrency=1 apps/server/tests/teaching-agent.runtime.test.mjs \
  apps/server/tests/teaching-agent.driver.runtime.test.mjs
cd apps/web && XUNJIE_PRODUCT_POSTGRES_BIN=/opt/homebrew/opt/postgresql@18/bin \
  XUNJIE_E2E_BROWSER_CHANNEL=chrome XUNJIE_XJ_DEV_URL=http://127.0.0.1:5999 \
  npx playwright test e2e/teachingConversation.spec.ts
```
