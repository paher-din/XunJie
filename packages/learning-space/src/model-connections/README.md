# 个人模型连接与有限检查

本模块是 #164 的 `ModelGateway` 实现，由产品组合注入 WP02 的 `authorize` 和真实所属 storage。配置、加密凭据、不可变检查输入、准入及原生结果属于独立 `model-connection` owner。浏览器只消费 [公开 wire](../../../contracts/src/model-connections.ts)，不引用 OpenAI SDK、数据库或旧 Session/store。

## 公开接口与生命周期

| 接口 | 行为 |
| --- | --- |
| `list/save(identity, input)` | 本人连接投影；CAS 版本保存；空白凭据保留、显式替换或清除；认证目标变化拒绝隐式带上旧凭据 |
| `checks.receive(identity, input)` | 稳定 attemptId 固定主体、用途、配置、限制及原生请求；同内容返回原记录，不同内容冲突；临时凭据与接收同事务 |
| `checks.dispatch(identity, id)` | 有效授权与代际下最多一次外发；重复派发只查原记录；没有课程、活动或 Run 前置 |
| `checks.read/list(identity, id?)` | 只读原事实，并核验结果资源；结果含部分文本、usage 及 resultRef，不返回原生 reasoning 或错误正文 |
| `checks.cancel(identity, id)` | 未外发确认未开始；外发后 abort 本机 SDK；保留终态竞争的实际事实，上游计算/费用仍未知 |

HTTP 装配见 [learning-entry](../learning-entry/README.md)。每个检查只发送固定合成短文本；最多 128 个输出 token、30 秒等待、每主体每小时 6 次准入，全组件最多 2 个、同主体最多 1 个未结束物理请求。取消、失败、缺 usage、重复请求或重启均不返还准入计数。授权 60 秒有效，查询时将未派发的过期检查终结并释放临时凭据。临时凭据随检查终态在同一所属事务删除，避免完成回执后崩溃留下密钥。

## SDK、结果及错误

`openai@7.42.0` 直接 Chat adapter `xunjie-chat-text-v1`，`maxRetries: 0`、拒绝重定向。base URL 与固定 `/chat/completions` 组成实际地址。DeepSeek 方言显式设置 thinking；默认文本参数不保证其他上游关闭其默认推理。尚未接入的协议/参数模式可保存但不能执行检查；不能静默退回另一协议或忽略显式思考配置。

原生请求不含认证；完整原生响应由 owner 保存，公开文本再次脱敏。只有结果资源与结果引用可靠提交后才发布完成。HTTP、流内错误、畸形数据、截断、缺终态、超时、取消和未知状态分别记录。累计 usage 以最后实际值替换，未知不补零，真实零值保留。

维护先关闭新准入/派发，等待已接收检查结果落盘，再封存储写。真实进程崩溃后不重新生成；仅在主机/PID/进程出生身份能确认旧本机处理者已结束时回收其本机物理槽，未知 usage 不变。无法确认远端处理者死亡时继续保守占用；跨机接管由后续子票补齐。

## 恢复与验证

配置版本、加密凭据引用、vault key、请求及结果资源随所属迁移和 WP01 加密备份恢复。默认产品新增后共四个 owner（含 runtime）。恢复旧三 owner 备份时，隔离阶段保持原 owner 集合；按原流程接管后正常停止/启动一次，才初始化空的模型 owner。不要跳过通用恢复的精确版本校验，也不回退到 legacy 模型配置。

主测试 [model-gateway.runtime.test.mjs](../../../../apps/server/tests/model-gateway.runtime.test.mjs) 经生产 API、真实身份/PostgreSQL/资源和 SDK→合成 HTTP/SSE；需要 `XUNJIE_PRODUCT_POSTGRES_BIN`。桌面 Chrome 用例见 [personalModelSettings.spec.ts](../../../../apps/web/e2e/personalModelSettings.spec.ts)，可指定 `XUNJIE_PRODUCT_WEB_ROOT` 验普通 Web，或 `XUNJIE_PRODUCT_TEST_PACKAGE` 启动完整独立包。实施范围见 [#164 方案](../../../../docs/student-agent-implementation/specs/wp06-personal-model-checks.md)。
