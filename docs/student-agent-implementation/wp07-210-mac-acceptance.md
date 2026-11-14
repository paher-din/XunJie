# #210：WP07 运行中引导、排队与暂停续接的 macOS 验收

本文保留旧版本的验收历史；旧 Agent 探针已退休，文中脚本名仅标识原证据来源。当前 session v2 工程入口为 [capabilities.runtime.test.mjs](../../packages/agent-runtime/test/capabilities.runtime.test.mjs)、[agent-student-ask.runtime.test.mjs](../../packages/product-runtime/test/agent-student-ask.runtime.test.mjs)。这些测试不继承本页的历史通过结论，真实供应商、桌面与跨机结果须另行验收。

对应 [#210](https://github.com/paher-din/XunJie/issues/210)，来源需求 [#200](https://github.com/paher-din/XunJie/issues/200)。本记录在已有 Apple Silicon / macOS 环境完成；不新建 PR、不合并既有 PR，继续同一 `wp07` 分支。

实际验收提交：`7381fe958597001aacfa08b6da9f3b7a35a6b673`（`origin/wp07` 最新提交，2026-11-07 02:35 +0800）。本页新增验收脚本、截图和记录，不改变产品源码。

## 结论

工程、浏览器/部署、物理中文输入法、跨机控制和真实模型边界分别通过；教学效果未正式评估。

| 范围 | 实际结果 |
| --- | --- |
| 原生输入控制 | 16/16 通过，0 失败，退出 0。 |
| 学生回应回归 | 12/12 通过，0 失败，退出 0。 |
| Agent 核心回归 | 6/6 通过，0 失败，退出 0。 |
| 普通 Web 有头 Chrome | `apps/web/dist`，同一 `inputControl.spec.ts` 5/5 通过。 |
| 完整产品包有头 Chrome | 新建 `darwin-arm64 --profile full` 包，包内 CLI 安装/启动后 5/5 通过；包内 CLI 停止/卸载退出 0。 |
| macOS 物理中文输入法 | 6/6 通过，真实豆包拼音候选窗、候选确认 Enter 不发送、后台结果不覆盖正文/焦点/阅读位置、明暗与窄桌面。 |
| 真实跨机 | Windows 主机 ↔ Mac school 直接 LAN HTTPS 6/6 通过；接收 steering/queue、丢控制回包原身份查询、重启后原身份查询、停止与选择继续。 |
| 真实 DeepSeek 三协议 | 12/12 HTTP 200，4 次生成/协议，2048 输出 token/次，30 秒/次，0 自动重试；真实 `read_work` 完成。 |

## 环境

| 项目 | 实际值 |
| --- | --- |
| 机器 | Apple M5（Mac17,3），arm64，16 GB |
| 系统 | macOS 27.2（26B123），Darwin 27.2.0 |
| 浏览器 | 安装版 Google Chrome `156.0.8078.80`，headed、单 worker |
| Node | `24.21.0`（固定解包运行时的实际 `node`） |
| PostgreSQL | `18.6`（Homebrew `postgresql@18`，原生 aarch64） |
| 输入法 | 豆包拼音 `com.bytedance.inputmethod.doubaoime.pinyin`（macOS TIS） |
| 验收时间 | 2026-11-07 02:46–03:06（Asia/Shanghai） |
| 完整包 | `.verification/wp07-210/product-darwin-arm64-full`，未签名候选；`distribution.json` SHA256 `a064611a74b9e027ba187ef668eb73801429d2b766bf22b0f7d4d53383f6e3bf` |

## 工程检查

所有原生命令使用固定 Node `24.21.0`，`XUNJIE_PRODUCT_POSTGRES_BIN=/opt/homebrew/opt/postgresql@18/bin`，`XUNJIE_PRODUCT_WEB_ROOT` 指向实际 `apps/web/dist-runtime`。生产 HTTP、正式 Agent owner、真实 PostgreSQL 与资源运行；只控制模型上游回包时点。

| 检查 | 结果 |
| --- | --- |
| `node --test apps/server/tests/teaching-agent.input-control.runtime.test.mjs` | 16/16，0 失败，退出 0；覆盖过期提问暂停、修订/备份/只读恢复/权威接管、双推进者与部分工具批次/提交确认丢失、失败后显式续接、长工具硬期限、偏好主体隔离、Wait 中 steering、停止竞争、停止回执、可恢复暂停同 Run（重启后 `budget-reserved` 仍为 1）、失败暂停且不自动复活未知命令、旧工具按原 call ID 未执行、queue 保留学生 Wait、不可变编辑/移除/转引导、生成中 steering、重启后 FIFO。 |
| `node --test apps/server/tests/teaching-agent.student-ask.runtime.test.mjs` | 12/12，0 失败，退出 0；含 4000 UTF-16 中文回应、备份/只读还原/接管、原身份回执。 |
| `node --test apps/server/tests/teaching-agent.runtime.test.mjs` | 6/6，0 失败，退出 0。 |
| `node scripts/build.mjs all` | 退出 0；生成 `apps/web/dist`、`apps/web/dist-runtime` 与全部 workspace 产物。 |
| `node scripts/build.mjs typecheck` | 退出 0；全部 workspace 通过。 |
| `npm run check:contracts:browser` | 退出 0；14 个公共导出全部 browser-safe。 |

首次原生运行与 `build all` 并行，构建替换 `dist-runtime` 造成 9 项 `Product web entry is missing` / 启动失败；该轮不是产品失败，不作为通过证据。构建完成后独占重跑得到上表 16/16 与 12/12 的干净结果；原始受污染日志保留在 `.verification/wp07-210/input-control.tap`。

## 浏览器与部署

普通 Web 使用 `XUNJIE_PRODUCT_WEB_ROOT=$PWD/apps/web/dist`；完整包由包内 CLI `install --profile local`、`start` 后以其回报的 `XUNJIE_INPUT_CONTROL_ENDPOINT` 运行同一文件。两组均为有头安装版 Chrome，单 worker，`--grep-invert baseline`。

```sh
XUNJIE_E2E_BROWSER_CHANNEL=chrome XUNJIE_XJ_DEV_URL=http://127.0.0.1 \
  XUNJIE_PRODUCT_POSTGRES_BIN=/opt/homebrew/opt/postgresql@18/bin \
  XUNJIE_PRODUCT_WEB_ROOT="$PWD/apps/web/dist" \
  node node_modules/@playwright/test/cli.js test --config apps/web/playwright.config.ts \
  --headed --workers=1 --grep-invert baseline inputControl.spec.ts
```

| 场景 | 普通 Web | 完整包 |
| --- | --- | --- |
| 默认引导、偏好按主体保存/刷新、忙碌时固定 queue 方式 | 通过 | 通过 |
| 运行中补充/排队、收到与采用、编辑跨刷新、丢控制回包后保留修改 | 通过 | 通过 |
| steering 暂缓旧提问、关闭入口、中文回应留存 | 通过 | 通过 |
| 停止、移除、选择继续、原回执身份 | 通过 | 通过 |
| 明确回应绕过 queue、消费竞争拒绝、改为引导 | 通过 | 通过 |

两组均 5/5 通过（退出 0），实际截图在本目录的 `input-control-*.png`；完整包同组截图在 `evidence/wp07-210/package/`。headed 由 Playwright 配置 `headless:false` 与实际启动参数核对：`DEBUG=pw:browser` 本次启动命令不含 `--headless`（1 次 launch，0 次 headless）。

完整包生命周期由包内 CLI 完成：`install`、`start`（endpoint `http://127.0.0.1:56180`，PostgreSQL `18.6` ready）、验收后 `stop`、`uninstall` 均退出 0；未替换包内应用服务或静态入口。包为未签名候选，签名、公证与 Gatekeeper 不在本票范围。

## macOS 物理中文输入法

`scripts/probe-input-control-ime.mjs` 在新建完整包上运行，文本只经 WindowServer/TIS 的豆包拼音进入 Chrome；`xjkeys` 发 HID 级事件，System Events 发物理键码，Playwright 只导航、点击非文本控件和读取状态。

| 实际用例 | 结果 |
| --- | --- |
| TIS 选中豆包拼音 | 通过；开始/结束均记录，最终恢复 ABC。 |
| 拼音组合 + 空格候选编辑输入区 | 通过；实际提交 `你好`、`吗`。 |
| 发送后忙碌草稿与真实结果到达 | 通过；草稿 `刘`、焦点仍在 textarea、未多发请求。该场景页面没有可滚动容器，`background-scroll` 记录为 window/0；没有自动滚动位移。 |
| 提问卡用系统输入法回应并提交 | 通过；实际回应 `我是`，进入原 Run，模型请求收到原文。 |
| 候选确认 Enter 不误发送（深色窄桌面） | 通过；`zhong'guo` → Enter 后 `zhongguo` 留在输入区，请求数不变、未新建 Run。 |
| 明暗与窄桌面 | 通过；640×900 深色无横向溢出，截图 `ime-candidate-dark-narrow.png`、`ime-dark-narrow.png`。 |

页面记录 trusted `compositionstart` 6、`compositionupdate` 29、`compositionend` 6、组合态 keydown 29、trusted keydown 30；中文 `insertCompositionText` 提交为 `你好`、`吗`、`刘`、`我`、`是`。候选窗截图：[`ime-candidate-nihao.png`](evidence/wp07-210/ime-candidate-nihao.png)、[`ime-candidate-dark-narrow.png`](evidence/wp07-210/ime-candidate-dark-narrow.png)；完整报告 [`input-control-ime.json`](evidence/wp07-210/input-control-ime.json)。

## 真实跨机

使用已有获准的 Windows 主机作为生产 HTTPS 客户端，Mac school/Agent 作为另一台主机；产品流量走直接 LAN HTTPS（Mac `192.168.3.39:9443` ↔ Windows `192.168.3.8`），不经 SSH 隧道或同机双安装。school 使用当前 `darwin-arm64` 包、真实 PostgreSQL 18.6、真实 Agent owner；模型只是受控外部 transport。

| 角色 | 实际事实 |
| --- | --- |
| 客户端 | `LAPTOP-S7A4IQFU`，Windows `10.0.26200`，win32 x64，Node `24.15.0` |
| school/Agent | `Robert-Wu-MacBook-Air.local`，Darwin `27.2.0`，arm64；环境 `b47082d9-6e9d-4dee-b4d5-67f8db950a24` |
| 连接 | `https://192.168.3.39:9443`，直接 LAN HTTPS，自签测试 CA 仅在私有验收目录与 Windows 临时目录使用 |

| 检查 | 实际结果 |
| --- | --- |
| Windows 登录 Mac school | 通过。 |
| 接收 steering 与 queue | 通过；两个输入均保存在原 Run，模式分别为 `steering`、`queue`。 |
| 丢控制回包后原身份查询 | 通过；stop 回包在客户端读取正文前销毁（`dropped:true`、`bodyRead:false`），随后按原 `requestId` 查询到 accepted stop 回执。 |
| 停止与暂停项 | 通过；原 Run `stopped`，未消费输入为 `paused`。 |
| 选择继续 | 通过；只选择 queue 输入，建立 `previousRunId` 关联后继并完成。 |
| school 重启 | `stop`/`start` 退出 0，状态 `ready`；重启后原控制回执、原 Run、后继 Run 和已采用输入仍按原身份可查。 |

逐项报告：[`cross-machine-input-control.json`](evidence/wp07-210/cross-machine-input-control.json)，原始各端报告在 `evidence/wp07-210/cross-machine/`。

直接公网 school 尝试（课程票提供的云主机 9443）未通过：云网络安全组在 TLS 前重置连接，仅既有 8443 可用；8443 正被另一工作包占用，本票未触碰。随后使用已有获准的 Windows 主机完成真实跨机，未准备新的 Mac 环境。跨机项使用生产 HTTPS API 客户端，没有把同机 Chrome 冒充为跨机浏览器证据。

## 真实模型边界

使用已授权私有配置运行 `scripts/probe-teaching-tools.mjs --input-control`，DeepSeek `deepseek-flash` 三协议各 4 次生成，共 12 次 HTTP 200；每次 2048 输出 token、30 秒、0 自动重试，未把密钥写入参数、Git 或日志。

| 协议 | 结果 | 工具事实 | 预算 |
| --- | --- | --- | --- |
| `chat-completions` | 通过，Run completed | 首个 `read_work` 未派发，修订后实际 `read_work` completed | 4 次 |
| `responses` | 通过，Run completed | 同上 | 4 次 |
| `messages` | 通过，end_turn | 同上 | 4 次 |

每条路线都在原生成期间接收 steering 与 queue，steering 进入原 Run，queue 在完整轮后建立关联后继并完成；重复查询没有新增生成。完整无密钥报告：[`real-model-input-control.json`](evidence/wp07-210/real-model-input-control.json)。

## 失败、未执行与边界

- 首次原生运行被并行构建替换 `dist-runtime` 污染，按工程时序失败；构建完成后独占重跑 16/16 与 12/12，通过结果不包含该污染轮。
- 云 school 9443 的直接公网路径受安全组阻断；使用获准 Windows 主机完成真实跨机，未修改共享安全组或另一工作包的 8443 实例。
- 跨机项使用生产 HTTPS API 客户端，未用桌面 Chrome；浏览器有头验收由普通 Web 和完整包分别完成。
- 完整包为未签名候选；签名、公证、Gatekeeper 与 clean-machine 不在本票范围。
- 教学效果未正式评估；工程、浏览器和真实模型通过不证明学生掌握或教学收益。
- 本票未发现需要修改产品代码的功能失败；新增的是验收脚本和证据。

## 证据与清理

脱敏汇总：[`verification.json`](evidence/wp07-210/verification.json)。工程原始 TAP/日志保留在 `.verification/wp07-210/`（不进入 Git）。实际截图：

- [`input-settings-after-darwin.png`](evidence/wp07-210/input-settings-after-darwin.png)
- [`input-control-queue-darwin.png`](evidence/wp07-210/input-control-queue-darwin.png)
- [`input-control-revised-darwin.png`](evidence/wp07-210/input-control-revised-darwin.png)
- [`input-control-deferred-dark-darwin.png`](evidence/wp07-210/input-control-deferred-dark-darwin.png)
- [`input-control-continue-darwin.png`](evidence/wp07-210/input-control-continue-darwin.png)
- 完整包同组图在 [`evidence/wp07-210/package/`](evidence/wp07-210/package)

本轮一次性 school 实例、模型 fixture、Windows 临时目录、云主机临时包、产品包实例与构建候选均已停止/卸载/删除；输入法恢复 ABC。仅保留本页、脱敏证据、实际截图和本机被忽略的原始日志，未提交密码、token、API Key 或私有路径。

## 当前工程回归入口

使用 Node 24.21.0 和支持的 `XUNJIE_PRODUCT_POSTGRES_BIN`；先由协调方统一准备 workspace 产物。已有产物时直接运行，不在共享构建期间重复 build：

```sh
node --test --test-concurrency=1 apps/server/tests/teaching-agent.input-control.runtime.test.mjs packages/product-runtime/test/agent-student-ask.runtime.test.mjs
```

这些是当前 session v2 工程入口，结果须按本次实际执行单独记录。历史产品包、真实供应商、桌面输入法与跨机验收不由上述测试替代。
