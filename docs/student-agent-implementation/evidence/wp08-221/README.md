# [WP08 #221 跨机使用、备份和接管](../../wp08-221.md) 验收证据

实现说明见 [#221 交付](../../wp08-221.md)。本页按工程、真实协议/工具/PDF、桌面 Chrome、维护/跨机、教学效果分别记录；缺环境、跳过或拒绝不算通过。

## 结论摘要

| 类别 | 证据 | 结果 |
| --- | --- | --- |
| 公共 wire 与跨服务接线 | `apps/server/tests/wp08-221-cross-service.test.mjs` | 4/4 通过 |
| 恢复来源闭包与 Skill 装载校验 | `apps/server/tests/wp08-221-source-closure.test.mjs` | 8/8 通过 |
| 跨安装恢复集合 | `packages/product-runtime/test/recovery-set.test.mjs` | 3/3 通过 |
| 凭据门禁（源秘密不进入继任安装） | `packages/product-runtime/test/isolated-learning.runtime.test.mjs` | 1/1 通过 |
| WP08 组合运行时（三条链 / 压缩 / 重启） | `apps/server/tests/teaching-agent.wp08-integration.runtime.test.mjs` | 4/4 通过 |
| 恢复、接管、旧版迁移与晚结果回归 | [运行日志](runtime-regression.log)、[工程记录](engineering.json) | 49 项中 48 通过；1 项基线遗留断言失败已修复并单独复验 2/2 通过 |
| 完整工程 | [完整验证摘要](verify-summary.json)、[日志](full-verify.log) | 通过：prepare 4/4、build:test 1/1、unit 36/36、server 95/95、tools 45/45，共 181/181 调度项；20 项平台/环境条件用例跳过，未计作通过；0 失败 |
| 真实协议（最终 Mac 产品包） | [三协议报告](real-protocols-package.json) | 通过：DeepSeek Chat Completions / Responses / Messages 各 2 次，6 次 HTTP 200，固定 PNG 实际入模，重启后固定读取 |
| 真实跨路线续接 | [续接报告](real-continuation.json) | 通过：8 次真实 HTTPS，四场景全通过，含 `Chat → Responses` 携带图像/资料与 accepted 长作业，保留原 Command、Wait、预算及固定图片 |
| Windows 完整包 PDF 解析/渲染 | [包内冒烟报告](windows-pdf-smoke.json) | 通过：Windows 11 x64 以包内 Node 24.21.0、PDF.js 6.5.438 与 `@napi-rs/canvas` 完成 7 项（含真实课程 PDF、旋转 CropBox 区域、扫描页、损坏/限额负例） |
| 续接失败与修复 | [失败报告](real-continuation-red.json) | 三次 `upstream-stream` 失败后定位为整合后的发现过滤隐藏受控长作业；修正验收探针的能力声明后通过 |
| Mac 正式产品 Chrome（PDF/可靠草稿） | [报告](chrome/darwin-durable.json) · [固定页](chrome/darwin-durable.png) · [深色窄桌面](chrome/darwin-narrow-dark.png) | 6/6 通过，Chrome 156.0.8078.80 |
| Mac 正式产品 Chrome（Skill 设置/草稿/前后退） | [报告](chrome-skills/chrome-skills.json) · [设置](chrome-skills/darwin-settings-after.png) · [草稿](chrome-skills/darwin-draft-after.png) · [来源](chrome-skills/darwin-skill-source.png) · [深色窄桌面](chrome-skills/darwin-dark-narrow.png) | 8/8 通过 |
| 教学效果 | 未评估 | 不作为通过声明 |

## 最终候选

- Mac 完整产品包：`dist/wp08-221-macos`，`darwin-arm64` / `full`，`distribution.json` SHA-256 `e6b66a3fd8fcdd5fe3071d22a7a08b9256691d72894f6a63140ecf386efbc1da`，`app/product-runtime.js` SHA-256 `79e0a57434d08827e7976cfff56e8ac5e1aed982fa469862ef3441a1e54e498b`。
- Windows 完整产品包：`dist/wp08-221-win32`，`win32-x64` / `full`（本机交叉构建，未在本票做 Windows 交互桌面验收）。
- 源码候选提交见交付记录；包内 Node 24.21.0、PostgreSQL 18.6、PDF.js 与平台 canvas 均随包。

## 工程检查

正式入口：`rtk bypass npm run verify -- --jobs 2`（固定 Node 24.21.0、`XUNJIE_PRODUCT_POSTGRES_BIN` 指向候选包内 PostgreSQL 18.6）。完整批次 `2026-11-08T10:08:30Z` 开始，`10:14:04Z` 结束，退出码 0。

单文件与定向回归单独执行：三个新单元测试文件共 15/15 通过；九份真实 PostgreSQL 运行时文件共 49 项（先 48 通过 / 1 失败，见[原始日志](runtime-regression.log)）。失败项 `teaching-agent.skills-recovery.runtime.test.mjs` 是基线 `84bfefd0`（#219）把维护清单升到 v4 后未同步删除新增 `teaching_student_facts` 表的遗留断言，本票修正后[整文件 2/2 通过](skills-recovery-rerun.log)；工程完整批次因默认发现清单不含 `.runtime.test.*` 未覆盖它，故单独登记。

类型检查、构建、文档链接检查（282 份 Markdown / 2797 个本地目标 / 0 失败）、浏览器安全契约出口均通过。已发布迁移 SQL 保持原字节；旧 v1/v2/v3 维护清单与两份 v11 迁移的备份还原/接管回归均通过。

## 真实协议、工具与 PDF

- 最终 Mac 产品包经真实 DeepSeek HTTPS：三协议各 2 次请求（无自动重试），6 次 200；固定 PDF 第 2 页 PNG 摘要 `bfe33d85…` 逐次出现在第二次请求；重启后纯读已保存页图，无新增模型调用。
- `Chat → Responses → Messages` 续接：三协议装配变化各 2 次，跨路线切换后复用原 PNG、保留当前意图、隔离旧 native ID、累计原预算；受控 `accepted` 长作业保留原 Wait 与 Command。长作业仅控制 accepted/reconcile 时点，不声称真实运行长作业。
- 真实 PDF 解析/渲染由包内 PDF.js 与 canvas 在独立子进程执行；两平台的包内产物与许可随包保留。Windows 侧另以包内 Node 在 Windows 11 x64 实际运行[冒烟报告](windows-pdf-smoke.json)，覆盖原生文字、旋转页/区域、扫描页、损坏与限额负例及真实课程 PDF。

## 桌面 Chrome

Mac 桌面 Chrome 156.0.8078.80，物理桌面未锁定，通过共享桌面锁串行执行。PDF 链覆盖丢上传回执、刷新后原身份、相邻页与真实区域裁切、中文 composition/Enter 不误发、宿主重启后固定读取、浏览器前后退保留草稿与引用。Skill 链覆盖正式设置导入、显式选择保留焦点与选区、前后退、中文组合输入、真实模型与工具回环、设置更新/停用后进程重启、同窗口刷新固定新默认版本、深色窄桌面。

本票未改变正式 UI 布局，仅新增能力接线与验证探针修正；前后截图见上表。Chrome composition 检查不代表系统输入法候选窗实测。

## 维护与跨机

- 备份/隔离还原/接管：正式 CLI 与真实 PostgreSQL 的运行时回归通过，含旧版迁移链、丢回执、旧处理者竞争、晚结果、未知物理效果阻止备份、隔离只读、接管重试与源退休。
- 凭据门禁：源安装的模型凭据保留在加密备份历史中，但继任安装的私有凭据目录不含该秘密；模型/执行派发须由维护者经原设置重新提供路线凭据并取得当前授权。
- 恢复来源闭包：两个业务 owner 在关闭边界输出只读来源清单（学习数据 36 类、教学 Agent 30 类），恢复后由所属 owner 重新派生并逐字节核对；Skill 装载内容必须回到原固定包的同一版本/路径/摘要/精确字节范围。
- 跨安装恢复集合：认证清单链接各原安装已密封备份的 `manifest.json` 摘要与构件清单，缺成员/缺原件/损坏/引用不匹配在还原任何成员之前整体拒绝；旧备份没有来源清单时仍按已发布格式验证。

## 未执行项（明确不计为通过）

- Windows 11 x64 交互桌面 Chrome 三条学习链、真实 Messages 路线在本票未重新执行；Windows 完整包已交叉构建并以包内 PDF 依赖完成冒烟，但未做本机交互桌面 Chrome 验收。
- 隔离学校 HTTPS 网页路径（DeepSeek Responses）的三条链及 Chrome 未在本票执行。
- Windows 独立 Agent → Mac 资料 owner 的真实跨机断线重连、关联备份、隔离还原与接管未在本票执行；#218 的 `cross-owner.json` 是更早候选的历史证据，不改称本次最终候选的重新验收。
- 真实长作业执行、教学效果研究未执行；固定行为案例、资料读取成功与真实模型回答不证明学生掌握或教学收益。

上述未执行项的环境与前置按母票边界保留，不因本票关闭而视为通过。
