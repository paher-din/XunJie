# #204 学习对话的备份、还原与接管

本次在同一 `wp07` 实施，不创建 PR。来源为 [#204](https://github.com/paher-din/XunJie/issues/204)，方案见[实施选择](specs/wp07-conversation-recovery.md)。Mac 与真实跨机验收由使用已有环境的执行者在新票 [#212](https://github.com/paher-din/XunJie/issues/212) 接手；本机多安装不计为跨机。

## 实现

Agent owner 新增自己的版本化维护清单，覆盖会话、请求、不可变快照、Run/步骤、命令、Wait、学生问题/回应、输入修订/采用、控制、模型切换、预算与分片。每张表记录数量与内容摘要；资源同时核对引用身份及原字节。运行层只装配 owner 接口，不读取或修改领域表。

正常组合和独立 Agent 使用同一清单。独立还原通过真实 owner 重新读取记录和资源核对，损坏清单拒绝，未知必需版本报告不兼容。保留受支持旧通用维护材料及已发布迁移；日志 v1 新增显式可忽略扩展外壳，原 payload 保留，必需未知事件仍拒绝推进。

沿用正式 CLI 和现有恢复状态机：先关准入/派发、分别排空各 owner，再导出；物理调用与真实执行边界由各自 owner 确认。隔离副本不推进，目标正式接管才退休源安装、撤销旧资格并启用新命名空间。未结身份、Wait、修订和预算沿原规则继续，不用重放补历史。

## 界面变化

仅修正既有只读工作区和对话提示：原先在还原副本仍提示“可以继续编辑作品”，现在明确学习对话只读、不会启动 Agent/实验，并指向维护者完成接管。沿用原布局和设计 token，避免学生把历史副本当作已启用的工作区。

修改前后均由真实运行页面、桌面 Chrome 截取：

| 修改前 | 修改后 |
| --- | --- |
| ![原只读提示](evidence/wp07-204/restore-before-win32.png) | ![说明接管下一步](evidence/wp07-204/restore-readonly-win32.png) |

## 验证记录

本节随最终工程与产品包验收更新；进行中的检查不计通过。

- 工程：Agent 原清单缺口、必需版本错误分类及可忽略扩展分别有失败记录；当前针对性恢复与 wire 测试 3/3 通过。完整工程检查待完成。
- 恢复/部署：真实 PostgreSQL 18.6 的学生 Wait、修订队列独立还原、只读无生成、接管确认丢失/重复接管、旧命名空间拒绝、原 Run 与 FIFO 继续已通过。真实 WP03 工具和完整产品包正在验收。
- Chrome：普通 Web 五阶段通过，Chrome 157.0.8103.38，Node 24.21.0；原问题/依据、只读禁用、接管后的回应及修订队列均核对。完整 Windows 包待完成。
- 教学效果：仅验证恢复后保留原学习依据、明确回应及操作顺序；合成上游没有证明真实学生理解、引导质量或学习效果。未执行教学研究。
- 未执行：本任务的 Apple Silicon Mac 与真实跨机组合，移交 #212。既有 #210 结果不充当 #204 验收。

## 复跑入口

使用 Node 24.21.0、原生 PostgreSQL 18.6、已有桌面 Chrome，在独立临时目录执行。`XUNJIE_PRODUCT_POSTGRES_BIN` 指定实际 PG bin；`TEMP`/`TMP` 指向已允许的专用临时目录。仅控制合成外部模型 transport，使用真实产品、owner、PG、资源和 WP03 发布算法，无付费模型要求。

```powershell
node scripts/build.mjs product-runtime:test
node --test packages/contracts/test/teaching-event.test.ts apps/server/tests/teaching-agent.recovery.runtime.test.mjs
node scripts/probe-conversation-recovery.mjs
node scripts/package-product.mjs --platform win32-x64 --profile full --cache <资源缓存> --out <新的候选目录>
node scripts/probe-conversation-recovery.mjs --package <新的候选目录>
```

Probe 用正式 CLI 安装、备份、独立只读还原、接管两次及停止，在 Chrome 提交对原问题的明确回应；报告位于 `XUNJIE_RECOVERY_EVIDENCE_DIR/report.json`，截图在同目录。备份密钥、数据库与测试账号仅在私有一次性目录，停机后清除；浏览器未同步草稿、临时流、编译缓存和活进程内存不被计入服务备份。
