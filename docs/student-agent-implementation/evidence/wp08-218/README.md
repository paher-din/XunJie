# [WP08：PDF 添加、按页阅读与固定引用](https://github.com/paher-din/XunJie/issues/218)验收证据

实现说明与界面对照见 [PDF 交付](../../wp08-218-pdf.md)。JSON 记录实际输入摘要、固定页图摘要、调用状态和检查结果；不保存模型凭据。日期采用运行记录中的 UTC 时间。

最终 [Standards / Spec 双轴审查](review.md) 均无未关闭项。

| 边界 | 证据及范围 |
| --- | --- |
| 工程检查 | [工程记录](engineering.json)：完整 `verify` 的类型/构建/浏览器契约/文档/单元/服务端通过，两个复现文件首轮因未提交依赖锁而失败；提交候选后重跑 16 通过、0 失败、1 个 Windows 专属分支在 Mac 跳过（[日志](repro-retest.log)）。最终 PDF 公开入口集成 32/32 通过，无跳过（[日志](pdf-runtime.log)） |
| 最终产品包 | [r3 分发摘要](product-r3-distributions.json)、[源码输入](product-r3-source-inputs.json)：[Mac 原生](mac-native-r3.json) 与 [Windows 原生](windows-native-r3.json) 均使用包内 Node、PDF.js 资源与目标平台 canvas 实际转换，产品文件摘要和许可可追溯；[离线依赖打包回归](packaging-offline-regression.json) |
| Standards 审查 | [独立审查记录](standards-final.json)：对基线 `cb104e3` 至候选 `7843225` 的正式差异，0 项待修复问题 |
| Spec 审查 | [独立审查记录](spec-final.json)：首轮发现的反馈上限、长文字续读、学校 `/find` 转发与课程 MIME 四项 P2 均已修复并回归，0 项未关闭问题 |
| 三协议真实模型 | [数字正文](real-protocols.json)、[纯扫描页](real-scan-protocols.json)：Chat Completions、Responses、Anthropic Messages 均实际发送固定 PNG；扫描页无原生文字、无 OCR |
| 三协议真实续接 | [换段证据](real-continuation.json)：三协议装配变化及跨协议切换后复用原 PNG、保留当前意图、隔离旧 native ID、累计原预算；`schemaRefresh` 覆盖最终四项 PDF 工具定义。长作业仅控制 accepted/reconcile 时点，不声称真实运行长作业 |
| 获准真实课程 PDF | [ALU 课程](real-course.json)：正式课程发布/学生资格、真实第 2 页框图、追问及重启后固定读取；该记录为 API 路径 |
| Mac Chrome 基础链 | [材料添加与真实模型](mac-chrome.json)：正式文件选择、页选择、草稿引用与模型回答；[修改前](mac-before.png)、[修改后](mac-after.png)、[回答](mac-answer.png) |
| Mac Chrome 课程完整链 | [产品包课程验收](mac-course-chrome.json)：课程材料入口、引用、实际模型消费、追问、来源点击与重启固定读取；[课程页](mac-course.png)、[回答](mac-course-answer.png)、[重启定位](mac-course-restored.png) |
| Chrome 可靠草稿 | [Mac](darwin-durable.json)、[Windows](windows-ui-r2-durable.json)：丢上传回执、原身份核对、相邻页、真实区域裁切、中文组合输入、同名版本、重启与浏览器前后退；Windows [交互 session](windows-ui-r2-session.json) / [系统](windows-ui-r2-system.json) |
| Windows Chrome 模型完整链 | [实际交互用户验收](windows-model-chrome.json)：Windows Chrome → LAN HTTPS → Mac 最终 r3 资料/模型宿主；正式上传、引用、实际 PNG 入模、追问、点击来源、宿主重启后原读取复现，重读无新增模型调用；凭据只留 Mac |
| 实际跨机 owner | [跨机证据](cross-owner.json)：Windows Agent 与 Mac 学校资料/模型 owner，直接 LAN HTTPS；实际页图入模、断线不重派、原身份恢复和纯重读 |
| 临时环境清理 | [Windows 清理核对](windows-cleanup.json)：SSH 恢复后正常停止本票旧 UI PostgreSQL，三个临时目录已删除，测试防火墙规则与残留进程均为 0；本地仅保留两端最终 r3 包和验收证据 |

## 可复现入口

使用项目固定 Node `24.21.0`。工程入口为 `rtk bypass npm run verify`；PDF 公开入口测试为：

```sh
XUNJIE_PRODUCT_POSTGRES_BIN=/path/to/product/resources/postgres/bin \
  rtk bypass node --test --test-concurrency=1 apps/server/tests/pdf-*.runtime.test.mjs
```

在仓库根目录使用候选包自带的 Node 运行原生解析与渲染；脚本只使用 Node 内建模块和候选包依赖：

```sh
PRODUCT/resources/node/bin/node scripts/smoke-product-pdf.mjs \
  --product PRODUCT --pdf course_matrial/data_logic/lab/实验03题目-ALU.pdf --out smoke.json
```

Mac 桌面 Chrome 验收必须持有当前聊天的桌面锁；产品由 `XUNJIE_PRODUCT_PACKAGE` 指定，报告位置由 `XJ_PDF_UI_OUT` 指定：

```sh
rtk bypass node scripts/with-native-desktop-lock.mjs --platform macos \
  --session CHAT_ID --purpose 'PDF Chrome acceptance' -- node scripts/probe-pdf-ui.mjs
```

真实模型 `scripts/probe-pdf-learning.mjs` 使用 `--product PRODUCT --credentials-file PRIVATE_FILE --out REPORT`；`--browser --course --followup --protocol chat-completions` 验证课程页面、实际模型和追问，`--scan` 验证无文字层页。调用次数、输出预算和超时写入报告。网络分类适配仅用于当前宿主代理 DNS；真实 TLS 请求与生产请求语义摘要仍逐次比对，未替换供应商回答。

Windows 浏览器通过已登录交互用户的 scheduled task 运行；SSH 仅控制，不能把 SSH session 的截图算桌面验收。跨机脚本的参数见 `scripts/probe-pdf-cross.mjs --help`，凭据只留在 Mac。

## 解释边界

Chrome 组合输入测试使用浏览器 CDP 驱动真实 composition/Enter 行为，不宣称系统输入法实测。扫描页视觉描述与 ALU 框图案例证明实际模型输入及来源链，不证明所有细节可辨，也不证明教学效果。工程、浏览器、真实供应商和跨机结果分别记录；未执行项不算通过。
