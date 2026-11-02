# WP06 #164：个人模型设置与可靠连接检查实施方案

依据 [#164](https://github.com/paher-din/XunJie/issues/164)、[WP06 母契约](wp06-model-connections.md)；代码基线 `wp06 @ f0979d5794c977f077a30d6abc8716af7f3a925d`。负责人已批准母票的测试边界。此文记录实施安排，验收结果另行记录，不把方案记作通过。

## 范围与所有权

- 在现有后端组合 package 的内部 `model-connections` module 实现 ModelGateway；浏览器契约由 `@xunjie/contracts/model-connections` 公开，不依赖 SDK 类型。避免为尚无独立部署消费者的内部模块预拆 package。
- 模型使用独立 `model-connection` owner、schema、迁移、所属资源和维护参与者。配置、凭据引用、不可变检查输入、用途授权/限额、尝试、完整原生请求/结果属于该 owner。
- WP02 认证实际空间/主体；不要求活动、课程或 Run。#164 只提供本人连接和有限 Chat 文本检查；学校默认/跨空间授权及另外两协议、图像/工具续接按后继子票推进。
- 凭据以独立 owner 密钥做 AES-GCM 保护，密钥资源随所属加密备份恢复；浏览器只读状态。临时检查凭据终结后释放，认证目标变化不能隐式沿用已存凭据。

## 实施顺序

1. 配置公开接口：稳定连接/模型身份、显式协议/base URL/最终路径/方言/参数、CAS 版本、启停、凭据保留/替换/清除、基本恢复校验。
2. 检查公开接口：以用途、主体、配置快照及预算来源接收稳定 ID；显式派发、只查询不生成、同身份冲突、结果资源可靠保存后发布回执。
3. 直接 `openai@7.42.0` Chat adapter，SDK retries=0；有限合成输入/输出/时限及持久准入限额，流错误/截断/未知 usage/取消/崩溃窗口保留真实事实。
4. 抽取共享展示与表单入口，使正式产品消费新 owner；旧聊天/教师设置保留隔离的 legacy 控制器。正式外壳沿用设计 token、导航、焦点和主题；保留实际运行前后截图。
5. 正式构建、受影响旧消费者回归、真实 SDK→合成 HTTP/SSE、真实 PG/资源/进程故障、Windows 桌面 Chrome 和两条目标真实端点验证；双轴审查后修复，提交 PR 不合并。

## 验收边界

主测试只经生产宿主 ModelGateway 配置、接收、查询、取消及结果接口；使用真实身份、PostgreSQL、所属资源、直接 SDK 和受控上游。主例逐条红绿推进，存储或崩溃故障只在真实边界注入。Chrome 验证正式产品包/普通 Web 共同入口，旧预览和路由 mock 不算正式接线。

DeepSeek 官方 `deepseek-flash` 与 Command Code `deepseek/deepseek-v4.1-flash` 各自验证有限文本、usage、终态及客户端取消；使用本机获准私有凭据，密钥不入日志。Mac 验收按负责人最新分工独立登记在 [#178](https://github.com/paher-din/XunJie/issues/178)；完整跨机部署/独立恢复接管属于后继 [#168](https://github.com/paher-din/XunJie/issues/168)，不以此延后本票的首次持久化。每项如实区分通过、失败、跳过、未执行；不产生真实 Agent、教学效果或上游退款结论。
