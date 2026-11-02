# #171 Apple Silicon Mac 交接与验收

日期：2026-11-03。对应[组件依赖准备、自检与失败恢复](https://github.com/paher-din/XunJie/issues/171)及[实施方案](specs/wp03-component-preparation.md)。当前 Windows 修复结果不能代替 Mac 验收；本页给出接手者可直接执行的路径，不声明 Mac 已通过。

## 固定源码与设备

使用真实 Apple Silicon Mac、原生 ARM64 Node.js 24.21.0、PostgreSQL 18.6 和已安装的桌面 Google Chrome；不用 Rosetta、平台模拟、headless 或 Linux 结果替代。记录 `sw_vers`、`uname -m`、`node --version` 和 Chrome 的实际版本。

在合适的现有 checkout 中取得 `origin/wp03` 本轮修复提交。先检查工作区；有无关改动时保留，不强制切换、清理或重置。两台设备以实际提交 SHA 和组件/依赖版本比对，不只比较分支名；远端后续有更新时，固定本轮交付的修复提交再运行，不悄悄换到另一候选。

```sh
git status --short --branch
git fetch origin wp03
git switch wp03
git merge --ff-only origin/wp03
git rev-parse HEAD
uname -m
sw_vers
node --version
```

预期架构为 `arm64`。依赖尚未安装时按仓库当前 lockfile 准备；不要修改 lockfile、`.env`、密钥、CI 或共享业务数据。本轮不需要共享学校的管理凭据；探针自行在独立临时产品 root 中建立测试身份，凭据不输出。

## 工程检查与正式候选资源

先完成受影响工程检查。使用仓库根的 Node 24.21.0/npm，不使用全局旧版 Node 跑原生探针；产品会校验版本，版本不符应修正调用环境，不修改校验。

```sh
npm run typecheck
npm run build
npm run check:contracts:browser
npm exec -w @xunjie/web -- vitest run src/component-preparation/preparation.test.ts src/component-preparation/bridge.test.ts
node scripts/check-doc-links.mjs docs/student-agent-implementation/specs/wp03-component-preparation.md docs/student-agent-implementation/wp03-171-mac-handoff.md
```

制作本机 ARM64 未签名候选，使用仓库产品资源目录锁定的官方资源及摘要。输出必须是新目录；已有输出保留，不删除。产品打包需要系统 tar/unzip 与网络取得尚未缓存的资源；遇到权限、网络或资源校验失败，保留失败原因，不绕过检查。

```sh
xj_candidate="$PWD/dist/wp03-171-mac-$(date +%Y%m%d-%H%M%S)"
node scripts/package-product.mjs --platform darwin-arm64 --profile full --out "$xj_candidate"
export XUNJIE_PRODUCT_POSTGRES_BIN="$xj_candidate/resources/postgres/bin"
export XUNJIE_PRODUCT_WEB_ROOT="$xj_candidate/web"
export XUNJIE_PREPARATION_REPORT_DIR="$PWD/.verification/wp03-171-mac"
export XUNJIE_COMPONENT_REPORT_DIR="$PWD/.verification/wp03-169-mac"
xj_node="$xj_candidate/$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).nodePath' "$xj_candidate/resources.json")"
"$xj_node" --version
"$XUNJIE_PRODUCT_POSTGRES_BIN/postgres" --version
file "$xj_node" "$XUNJIE_PRODUCT_POSTGRES_BIN/postgres"
```

预期 Node 24.21.0、PostgreSQL 18.6、实际执行文件均为 ARM64。保留候选包的 `resources.json`、产品清单及其摘要，和探针报告中的整个 Web 文件树摘要；不要用仅 `index.html` 的摘要证明产物一致。

## 原生与真实 Chrome 自动验收

在仓库根执行，探针使用正式候选内的 Web 与原生 PostgreSQL，业务模块和源码为同一固定提交：

```sh
"$xj_node" --test apps/server/tests/component-host.runtime.test.mjs
"$xj_node" scripts/probe-component-preparation.mjs
"$xj_node" scripts/probe-component-host.mjs
XUNJIE_E2E_BROWSER_CHANNEL=chrome npm exec -w @xunjie/web -- playwright test productUi.spec.ts worksEditor.spec.ts --headed
```

若 Playwright 自己启动的准备/真实开发服务与本机已有服务冲突，核对所属后处理，不杀不相关进程或更改断言。新准备探针输出到 `.verification/wp03-171-mac/`，旧宿主探针输出 `.verification/wp03-169-mac/`；交接时分别保留两套报告和截图，不混写为同一验收。

新探针至少应完整覆盖：真实库冷准备、热缓存、中文多处匹配/解除高亮、零学生作品的独立自检、缓存丢失及损坏修复、冷启动双标签单一身份、自检视图加载超时和原身份继续、生产加载错误的就近降级、激活事务失败不挂载、下载中断、依赖失败保留基础标注、存储失败保护、v1 原入口、主题/窄桌面及资格撤销。按脚本实际用例清单报告数量，不手工填“通过”。

`preparation-report.json` 必须记录实际 `platform=darwin`、`arch=arm64`、Chrome 版本、`headless=false`、源码 SHA、相关源码脏状态和摘要、Web 摘要、冷准备实际毫秒数和依赖字节数，且 `status=passed`、`mac=passed`、`cleanup=owned product stopped`。正式交接应为相同固定提交且相关源码 `sourceDirty=false`；若为了修复改了源码，保留脏状态与源码摘要，提交后明确交接版本。缺失或失败均不得写成 Mac 通过。精确浏览器进程内存未测；报告字节数只表示准备资源量，不声称组件内存或课程容量。

## 必须人工补验的 Mac 行为

自动脚本的字符串填充不等于系统输入法操作。用同一候选另建独立本机产品实例，通过正式 CLI 导入标注样例和固定课程；沿[已有导入契约](wp03-component-host.md#可重复开发入口)操作，版本 2 使用生成的 `component-v2.json`。不要修改共享课程或把自检账号/密码提交到仓库。

接手者需要在真实 Mac Chrome 中完成并记录：

- 使用系统中文输入法候选窗完成选词和连续输入；准备、重试、高亮及工具切换不吞字符、不抢焦点。
- 键盘进入标注、编辑、移除、高亮和取消高亮；Tab 焦点可见，输入及切换后已有标注保留。
- 同浏览器刷新/返回重开，原笔记与固定内容恢复；浅色、深色、窄桌面内部滚动和就近失败说明可读。

准备探针自动创建的临时 root 只用于该次验收，结束停止服务，保留失败现场。人工验收可用独立临时 root；不要复用仍有个人数据的产品根或删除既有数据来获得“冷启动”。

## 学校连接与交付回填

本机组合通过不等于学校网页/已安装客户端的跨机路径通过。若此次交付涉及真实学校连接，应在获准的独立学校服务上分别补验学校 Chrome 页面及 Mac 已安装客户端：固定依赖读取、报告登记/重读、连接撤销、课程资格撤销及旧页面无法新装配。不改连接位置重跑未知动作；学校测试资料写入与账号授权按现有接入范围执行，缺少适用环境时记录明确待验项。

实际远端执行仍由 #175 交付；本票这里只验证新增资源/报告路由经过获准产品连接，不声称交付远端计算。Windows 上已有通路证据也不代替 Mac。

回填[实施方案的修复验收记录](specs/wp03-component-preparation.md)：固定提交、OS/架构/Chrome/Node/PostgreSQL、正式候选资源摘要、工程和每条探针结果、输入法/焦点记录、截图、耗时/资源统计口径、学校连接组合和失败重跑经过。工程、Chrome、真实连接和教学效果分别报告。Mac 尚未执行、学校连接尚未执行或教学效果未评估，均保持明确状态；不因推送开发分支关闭未完成的验收票。
