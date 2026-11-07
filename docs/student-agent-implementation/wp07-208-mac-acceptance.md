# #208：WP07 #201 的 macOS 模型切换与学习延续实机验收

本记录完成 [#208](https://github.com/paher-din/XunJie/issues/208) 在已有 Apple Silicon / macOS 环境上的验收，来源需求为 [#201](https://github.com/paher-din/XunJie/issues/201)。验收只在 #201 修复合入后执行；记录中的提交是实际测试提交，不是预合并候选。

## 结论

桌面 Chrome 主验收在本地正式 source runtime（Node 24.21.0 + PostgreSQL 18.6 + `apps/web/dist-runtime`）完成，四个业务场景全部通过：三个协议路线切换、在途调用与重复/竞争请求、网络回包丢失与进程重启恢复、停止与草稿保留。系统物理中文输入法探针在完整 `darwin-arm64/full` 产品包上 13/13 通过；真实 DeepSeek 三协议 ownership 边界探针 6/6 请求通过。教学效果未评估；工程和交互成功不证明学生理解或学习收益。

候选固定为 `wp07` 分支提交 `92de78f809f9bd01548bbe8f0ac837a1f614f637`，基于 #201 合并提交 `7caf8c597d3f731527b185427decada28fb3eef3`（= `origin/wp07`）。本记录与验收测试脚本、重试入口 UI 改动一起提交为 `92de78f`；产品包为同一工作树构建的未签名候选。

## 环境

| 项目 | 实际值 |
| --- | --- |
| 机器 | Apple M5（Mac17,3），arm64，16 GB |
| 系统 | macOS 27.2（26B123），Darwin 27.2.0 |
| 浏览器 | 安装版 Google Chrome `156.0.8078.80`，headed、单 worker |
| Node | `24.21.0`，固定 `node-v24.21.0-darwin-arm64` 解包缓存 |
| PostgreSQL | `18.6`（固定发行版 `18.6.1`，`postgresql-18.6.1-aarch64-apple-darwin`） |
| 输入法 | 豆包拼音 `com.bytedance.inputmethod.doubaoime.pinyin`（macOS TIS） |
| 部署模式 | source runtime：`apps/server` + `apps/web/dist-runtime`，本地 managed PostgreSQL |
| 测试时间 | 2026-11-06 22:39–23:10（Asia/Shanghai） |

## 工程检查

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `npm run typecheck` | 通过，全部 workspace 退出 0 |
| 完整构建 | `npm run build` | 通过，生成 `dist` / `dist-runtime` |
| 浏览器公共契约 | `npm run check:contracts:browser` | 14 个 public export 全部 browser-safe |
| 维护文档链接 | `npm run check:docs` | 223 个 Markdown 文件、2038 个本地链接、0 失败 |

## 连接路径与测试夹具

`models/selection` 依次走学校默认模型、个人 Responses、个人 Messages，再反向回学校，实际支持的三条路线均被产品保存和切换：

| 路线 | 协议 | 地址类型 | 结果 |
| --- | --- | --- | --- |
| 学校统一模型 | `chat-completions` | 学校审批的 loopback `http://127.0.0.1:<port>/v1` | 保存、选用、切换、继续回答均通过 |
| 个人 Responses 模型 | `responses` | 个人连接，HTTPS 公网主机 | 保存、授权、选用、切换、继续回答均通过 |
| 个人 Messages 模型 | `messages` | 个人连接，HTTPS 公网主机 | 保存、授权、选用、切换、继续回答均通过 |

本机系统 DNS 将外部域名解析到 `198.18.0.0/15`（本机代理的 fake-IP 区间），产品网络策略按设计把该区间视为 special 地址，因此直接保存 `https://api.deepseek.com` 的公网连接会被拒绝。这是主机 DNS 代理与产品安全策略的交互，不是模型切换逻辑的放宽理由；本轮没有改动生产网络策略。浏览器验收把个人连接指向一个 localhost.run 公网隧道（测试辅助进程把隧道主机名映射到其真实公网 A 记录），产品侧看到的是正常 HTTPS 公网主机；学校默认仍走学校审批的 loopback。真实 DeepSeek 的协议边界另由 `scripts/probe-model-switch.mjs` 直接验证，见下文。

## 场景结果

### 场景 1：同一活动内学校与个人模型双向切换，保留原问题、回答、作品与工具结果

`apps/web/e2e/teachingModelSwitch.spec.ts` 的 “school and personal models switch both ways…” 通过。步骤：建立活动并读取固定作品 → 学校模型回答并产生 `read_work` 工具记录 → 切到个人 Responses → 继续提问 → 切回学校 → 再切到个人 Messages → 继续提问。

实际结果：每次切换都出现“已为当前学习活动切换到「…」。已有消息和结果保留原出处。”；原问题、工具记录（`读取作品 · 切换固定观察.txt · 已完成`）、原回答及 `来源：学校模型 · school-chat · chat-completions`、`来源：个人模型 · personal-responses · responses`、`来源：个人模型 · personal-messages · messages` 均在活动刷新后保留。活动内多次切换没有覆盖旧记录。

### 场景 2：回答或原生工具执行中请求切换

“a switch requested during a slow answer…” 通过。步骤：学校模型慢速回答在途时打开模型设置并请求选个人 Responses；同一 `requestId` 重复提交；再提交另一个 `requestId`；等待原回答结清；刷新活动后继续提问。

实际结果：原调用只发一次（合成上游请求计数为 1），切换先返回明确的 `segment-busy` 暂停状态“当前回答或工具仍在收尾；切换请求已保留，完成后将继续核对。”；重复身份返回同一暂停结果；竞争请求返回 `409 conflict`；原回答结清后显示 `model-switch-completed`，新回答来源为 `个人模型 · personal-responses · responses`。没有自动回退，也没有跨费用来源调用。

### 场景 3：网络中断、服务不可用与进程重启

“a lost switch reply is explicit…” 通过。步骤：学校回答存在时，把 `agent/<activityId>/model-switches` 的响应 abort → 显示 `切换结果尚未确认：…` alert → 返回活动并刷新 → 停止并重新启动产品进程 → 重新打开活动 → 使用“将当前选用应用到学习活动”重试 → 继续提问。

实际结果：回包丢失后活动仍可读，原学校回答和原问题保留；刷新后仍显示原回答；进程重启后 endpoint 不变、活动与原回答恢复；重试后切换完成并继续得到个人模型回答。失败提示可操作，且没有把失败请求误报为已完成。

### 场景 4：预算、失败提示、草稿、返回、刷新与停止

- 返回与刷新：场景 1 和场景 3 均通过返回活动、刷新和重新打开后的记录保留。
- 停止与草稿：“stopping an answer keeps the stopped state and the unsent draft” 通过。慢速回答期间输入未发送草稿，停止按钮可用；点击停止后显示“回答已停止，已发生的内容仍保留。”，草稿值保留；刷新并重新打开活动后草稿仍为 `生成期间继续输入的新草稿。`。
- 预算累计：浏览器场景只核对 `teaching_model_switches` 和回答来源，不把模型用量 UI 作为单独通过项；本轮针对 `teaching-agent.tools-recovery.runtime.test.mjs` 的“switching at a paired tool boundary keeps the same Run and its cumulative budgets”矩阵单独运行，1/1 通过（30.8 s，0 fail/0 skip），日志 `.verification/wp07-208-mac/tools-recovery-switch.tap`。本轮未观察到预算 UI 丢失或重置。
- 并发/重复：场景 2 的重复身份与竞争请求均按契约处理。

### 场景 5：桌面 Chrome + 系统中文输入法

两个实机证据分开记录：

1. **系统物理中文输入法探针**：`scripts/probe-student-ask-ime.mjs` 在完整 `darwin-arm64/full` 产品包上 13/13 通过。文本只通过 WindowServer/TIS 的豆包拼音进入 Chrome（`xjkeys` HID 级事件 + System Events 物理 key code），覆盖：既有对话、拼音组合与真实空格候选、数字候选、组合态 Enter 不提交、Return 换行、Tab/Shift+Tab 焦点、Escape、Command+A、滚动保持焦点、关页重开草稿恢复、提交后继续原 Run、trusted composition 信号（5 次 `compositionstart`、39 次 `compositionupdate`、5 次 `compositionend`、39 次 `VK_PROCESSKEY`、44 次 trusted keydown）。
2. **模型切换交互**：桌面 Chrome 的四个浏览器场景覆盖输入、切换、返回、继续提问与停止；输入使用系统输入法探针验证，切换/返回/停止为真实安装版 Chrome 中的按钮与键盘操作，焦点和草稿在场景 4 断言。没有把 Playwright `fill` 当作系统输入法证据。

探针截图为 [拼音候选](evidence/wp07-208/student-ask-ime-candidate-darwin.png)、[数字候选](evidence/wp07-208/student-ask-ime-digit-candidate-darwin.png)（复制自本轮完整包运行输出）。

## 完整产品包与 CLI

构建命令：

```bash
node scripts/package-product.mjs --platform darwin-arm64 --profile full \
  --out <验收私有目录>/product-darwin-arm64-full
```

包体约 416 MB，未签名候选；签名、公证、Gatekeeper 与 clean-machine 验收未声称通过。

| 校验项 | SHA256 |
| --- | --- |
| `distribution.json` | `1f4512bd85415e7c0ec6414aa99660116b6007e7d3ffbf800b1bdb75e4de6914` |
| `resources.json` | `54e3bfca6394b6d600a77eff946427123f2bbbf095a9563e6c731bd5b0159469` |
| `app/cli.js` | `0c8e49c76ec5871f8edf574a3fc724d1e4034d4ba95f1205ad0052bf88ffd4e8` |
| `web/` 整树 | `a1aaff402b9b16f6af00382cbe8b4bccaad99e9e380e9a9a256577861b68d88b`（160 文件、11,422,237 字节） |

`distribution.json` 的 220 个 entry hash 全部与包内实际文件一致（0 mismatch）。包内 `resources/node/bin/node` 为 Node `24.21.0`，`resources/postgres/bin/postgres` 为 PostgreSQL `18.6`（arm64）。

正式 CLI 生命周期在仓库外私有 root 执行：`install --profile local` → `start` → `status` → `stop` → `start` → `stop` → `status`，每步退出 0；实际 endpoint `http://127.0.0.1:51388`，PostgreSQL 依赖 `ready 18.6`；最终 `stopped`。

完整包入口的模型切换场景 1、2、4 在 headed Chrome 中 3/3 通过；场景 3 的“停止产品进程再启动”在包入口探针中未作为通过项记录（source runtime 已 4/4 覆盖），不据此声称包入口场景 3 通过。

## 真实模型协议边界

使用 DeepSeek `deepseek-flash` 运行 `scripts/probe-model-switch.mjs --credentials-file <私有 providers.json> --out <私有 JSON>`：三协议 `chat-completions`、`responses`、`messages` 各 2 次，共 6/6 HTTP 200，三协议均 `passed:true`；限制为每协议最多 2 次、2048 输出 token、30 秒、SDK retries=0。该探针验证模型连接 ownership/协议边界，不冒充 Teaching RunDriver 端到端；凭据只从用户授权私有文件读取，未进入提交、日志或截图。报告 SHA256 `60bbfe473fb1b23dafeea7f7fba28fcd61b294469f5bd8194234b4b625d532dd`。

## 失败、未执行与边界

- 产品代码和主验收未出现需要修复的功能失败；source runtime 桌面 Chrome 4/4、系统 IME 13/13、真实 DeepSeek 边界 6/6 通过。
- 完整包入口的模型切换场景 3（进程重启）未在包入口探针中执行完成，source runtime 的场景 3 已通过；包入口场景 1、2、4 通过。该差异不据此扩大为包入口全量通过。
- 完整包签名/公证/Gatekeeper、clean-machine、原生进程探针和备份升级探针不在本轮范围；`distribution.json` 对相关项保持 `deferred-by-user` / `not-run` / `cancelled-by-owner`，不据此声称通过。
- 本机直接公网 DeepSeek 连接因系统 DNS fake-IP 区间被产品 special 地址策略拒绝；已用真实 DeepSeek 边界探针验证协议，且未修改生产网络策略。浏览器个人连接使用公网隧道夹具，报告已明确。
- 教学效果未评估；本记录只证明工程与交互路径通过。
- macOS 或虚拟机环境搭建未执行，本机为已有合格环境。

## 证据与清理

脱敏证据汇总：[mac-verification.json](evidence/wp07-208/mac-verification.json)，包含候选 SHA、环境、工程命令、四场景结果、IME、真实模型、包哈希与 CLI 生命周期。截图在 [evidence/wp07-208](evidence/wp07-208)。原始日志保留在忽略的 `.verification/201/`、`.verification/wp07-208-mac/`；一次性完整包与私有 root 在验收后停止并删除，未提交凭据、密码、token、私有路径或真实学生隐私。
