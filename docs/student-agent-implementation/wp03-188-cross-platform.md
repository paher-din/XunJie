# WP03 #188 组件与执行恢复的 Mac 及学校跨机验收

对应 [跨平台与跨机验收 #188](https://github.com/paher-din/XunJie/issues/188)，父票 [#176](https://github.com/paher-din/XunJie/issues/176)。日期：2026-11-05。

基线为 `wp03` 分支 [`b997fc867f1abee8cda8b848fd9e3fcc20b196fe`](https://github.com/paher-din/XunJie/commit/b997fc867f1abee8cda8b848fd9e3fcc20b196fe)，本票未新增数据库 schema/迁移，未改动生产代码；只新增八个验收脚本（[冻结组件字节](../../scripts/freeze-component-definitions.mjs)、[冻结公开迁移](../../scripts/freeze-execution-migrations.mjs)、[准备课程](../../scripts/prepare-execution-recovery-school.mjs)、[学校节点播种](../../scripts/seed-execution-recovery-school.mjs)、[客户端跨机恢复探针](../../scripts/probe-execution-recovery-school.mjs)、[客户端恢复负例探针](../../scripts/probe-execution-recovery-negative.mjs)、[执行 disposition 负例探针](../../scripts/probe-execution-disposition-negative.mjs)、[学校节点生命周期负例探针](../../scripts/probe-school-lifecycle-negative.mjs)）并修正跨机探针在真实桌面会话中的 Chrome 启动与点击时序。**#188 只验证跨平台/跨机，不把 #176 的 Windows 本机证据重复计为本票通过。**

本页按 #188 交付要求，把可复跑命令、结构化报告、实屏截图、工程检查、Chrome 使用、真实跨机结果、恢复负例、执行 disposition、共享节点生命周期和未执行项分开登记；#176 的原有结论见[实施记录](wp03-176-recovery-implementation.md)，设计边界见[设计与验收计划](specs/wp03-execution-recovery.md)。教学效果未测量，不记为通过。

## 实际拓扑与版本

| 角色 | 设备与系统 | 实际资源 |
| --- | --- | --- |
| 客户端 A | Apple Silicon Mac，macOS 27.2（26B123），arm64 | 真实产品包 `darwin-arm64`（`distribution.json` SHA-256 `10a6d4fd…637a8`），Node v24.21.0，PostgreSQL 18.6，桌面 Chrome 156.0.8078.80 |
| 客户端 B | Windows 11 x64，10.0.26200 | 真实产品包 `win32-x64`（`distribution.json` SHA-256 `13c8f3d0…93fd4`），Node v24.21.0，PostgreSQL 18.6，桌面 Chrome 156.0.8078.80，产品自带的 `windows-session.exe` AppContainer 执行器 |
| 独立学校节点 | 阿里云 ECS，Ubuntu 24.04.5 LTS x86_64（内核 6.8.0-139-generic） | 独立 Linux 产品包 `linux-x64`，Node v24.21.0，PostgreSQL 18.6；`https://101.201.141.133:8443` |

三份产品包均为 `unsigned-candidate`，由同一提交构建。学校节点 receiver 身份固定为 `72fa2198-a743-420f-8fb9-e0027e28a37b/c3be3834-c8bc-453a-a874-ec83e6ae66b4`。客户端浏览器以证书公钥固定（SPKI `TqaZHW4oYaaqfyX85BXffS+8kvcsXOqTvEQDFmDo5EE=`）访问严格 HTTPS，`ignoreHTTPSErrors` 始终为 `false`；Node 侧用 `NODE_EXTRA_CA_CERTS` 指向本票 CA 而不关闭校验。SSH 只用于部署、读取控制凭据、签发 grant、停/启学校守护进程及接管时 fencing 学校节点，学生流量从不走 SSH。证书私钥、账号口令、控制 token 只留在 `.verification/wp03-188/private/`（权限 600），不进入代码或文档。

Windows 客户端没有工作区源码与 esbuild，使用工作区一次冻结的公开组件字节（文件 SHA-256 `815e730abdb407124145c766c7da8fc3ac41afd54b09f46c366064a12f60ec2b`，记录在 Windows 报告中）与冻结的 16 条公开 learning 迁移（SHA-256 `3577a315061e3f6224855a4efd5f813e510e1c1c57e4c91c0d9fcbe0664eaa49`）；Mac 客户端直接由同一提交的组件源码打包。两者导入后组件身份/版本/摘要一致，分别为 `6237a554…/v4/0764a763…`、`1d92f3c5…/v2/5d9b2962…`、`4d0e1c8a…/v2/2c8cd8c1…`，两客户端报告一致。固定 CSV 产物摘要 `4f2cc99a…8971`、97 字节，在隔离目标重新下载并逐字节核对。

## 可复跑命令

所有命令使用产品包内 Node v24.21.0（`env -u NODE_OPTIONS`），私有路径按实际设备替换；输出目录须先不存在或不复用旧报告。

```sh
# 1. 工作区：构建两个客户端产品包，冻结公开组件字节与公开迁移
node scripts/package-product.mjs --platform darwin-arm64 --out .verification/wp03-188/product-darwin-arm64
node scripts/package-product.mjs --platform win32-x64  --out .verification/wp03-188/product-win32-x64
node scripts/freeze-component-definitions.mjs .verification/wp03-188/private/component-definitions.json
node scripts/freeze-execution-migrations.mjs .verification/wp03-188/private/learning-migrations.json

# 2. 工作区：生成学校课程材料；在学校节点用同一份公开字节导入并生成私有 actor 状态
node scripts/prepare-execution-recovery-school.mjs --out .verification/wp03-188/private/school-payload.json
scp .verification/wp03-188/private/school-payload.json xunjie-cloud:~/wp03-188/private/
ssh xunjie-cloud 'NODE_EXTRA_CA_CERTS=~/wp03-188/private/ca.pem \
  ~/wp03-188/product-linux-x64/resources/node/bin/node wp03-188/seed-execution-recovery-school.mjs \
  --endpoint=https://101.201.141.133:8443 --root=~/wp03-188/school \
  --package=~/wp03-188/product-linux-x64 --payload=~/wp03-188/private/school-payload.json \
  --out=~/wp03-188/private/school-state.json'

# 3. 客户端：真实桌面 Chrome 使用学校入口、真实 TCP 断链、撤权与恢复（无本机产品）
SPKI=$(openssl x509 -in .verification/wp03-188/private/server.crt -pubkey -noout \
  | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64)
<产品包>/resources/node/bin/node scripts/probe-execution-remote-school.mjs \
  --state=$PWD/.verification/wp03-188/private/mac-school-web-state.json \
  --control=$PWD/.verification/wp03-188/private/control-188 --spki="$SPKI" \
  --label=wp03-188-mac-arm64 --output=$PWD/.verification/wp03-188/school-web-mac

# 4. 客户端：本机实际产品包、原生 PostgreSQL、原生会话、备份/隔离还原/接管（Mac）
<产品包>/resources/node/bin/node scripts/probe-execution-recovery.mjs \
  .verification/wp03-188/product-darwin-arm64 .verification/wp03-188/mac-browser

# 5. 客户端：完整跨机恢复与接管（两客户端分别执行；Windows 用 run-recovery-win.cmd 在交互桌面计划任务中启动）
<产品包>/resources/node/bin/node scripts/probe-execution-recovery-school.mjs \
  <产品包> <输出目录> \
  --school-state=private/mac-school-state.json --spki="$SPKI" \
  --ssh-config=<本机 ssh 配置> --ssh-host=xunjie-cloud \
  --ssh-root=/home/xunjie-admin/wp03-188/school \
  --ssh-cli=/home/xunjie-admin/wp03-188/product-linux-x64/app/cli.js \
  --ssh-node=/home/xunjie-admin/wp03-188/product-linux-x64/resources/node/bin/node \
  --label=macos-arm64

# 6. 两客户端：真实产品包 + 原生 PostgreSQL 上的恢复负例（只动备份副本，不碰学校节点）
<产品包>/resources/node/bin/node scripts/probe-execution-recovery-negative.mjs \
  <产品包> <输出目录> --label=<平台标签>

# 7. 两客户端：执行 disposition 负例（产品自身 owner 边界分类与 fail-closed 维护拒绝）
<产品包>/resources/node/bin/node scripts/probe-execution-disposition-negative.mjs \
  <产品包> <输出目录> --migrations=<冻结的 learning-migrations.json> --label=<平台标签>

# 8. 客户端 → 独立学校节点：真实停服务、fence 后旧连接文件与可信晚回包
#    （仅 Mac 传 --node-lifecycle=1；Windows 传 0，避免重复停共享节点）
NODE_EXTRA_CA_CERTS=<本票 CA> <产品包>/resources/node/bin/node \
  scripts/probe-school-lifecycle-negative.mjs <产品包> <输出目录> \
  --school-state=private/mac-school-state.json --ca=<本票 CA> --spki="$SPKI" \
  --ssh-config=<本机 ssh 配置> --ssh-host=xunjie-cloud \
  --ssh-root=/home/xunjie-admin/wp03-188/school \
  --ssh-cli=/home/xunjie-admin/wp03-188/product-linux-x64/app/cli.js \
  --ssh-node=/home/xunjie-admin/wp03-188/product-linux-x64/resources/node/bin/node \
  --node-lifecycle=1 --label=macos-arm64

# 9. 工作区：全库回归，必须用完整 Node 24.21.0 发行版的 bin 置于 PATH 前置（见工程检查节）
env -u NODE_OPTIONS npm run verify
```

Windows 客户端额外传 `--component-definitions=<冻结文件>`（无工作区源码时必需，报告会记录文件摘要）和 `--label=windows-x64`；其余参数指向同一学校节点与同一 Linux 产品 CLI。第 6、7 步在 Windows 上分别用 `run-negative-win.cmd`、`run-disposition-win.cmd` 包装（`set NODE_OPTIONS=`、产品包 `node.exe`），不需要浏览器或 AppContainer，可在普通 SSH 会话运行；第 8 步在 Windows 上必须用 `win-lifecycle-desktop.ps1` 注册交互桌面计划任务运行 `run-lifecycle-win.cmd`，因为非交互 SSH 会话中维护 SSH 子进程会超时挂起。

Windows 包在 Mac 上打包时，`packages/product-runtime/native/windows-session.c` 先在真实 Windows 设备上编译，再由 `.verification/wp03-188/bin/x86_64-w64-mingw32-gcc` 包装脚本按 `-o` 目的地复制该二进制；这一步只替换交叉编译器，不改动产品装配代码，包内 `distribution.json` 仍记录 helper 的 SHA-256。Windows 客户端必须优先使用交互桌面会话：SSH 会话中 AppContainer helper 无法创建子进程（见下文失败现场），因此完整跨机恢复用 `win-start-desktop.ps1`、生命周期探针用 `win-lifecycle-desktop.ps1` 注册并运行一次性计划任务。

## 工程检查（Mac 本机，与跨机结果分开）

[原始输出](evidence/wp03-188-engineering.txt)，全部在 Apple Silicon Mac 上执行：

- `npm run check:contracts:browser`：12 个公共导出通过。
- `npm run check:docs`：本次交付文档加入前为 192 份 Markdown、1593 个本地目标、0 失败；加入本页与 #176 交接段后为 193 份 Markdown、1647 个本地目标、0 失败；补入恢复负例节、全库回归与清理证据后为 193 份 Markdown、1663 个本地目标、0 失败；补入执行 disposition、共享节点生命周期与最终清理记录后最终复跑为 **193 份 Markdown、1690 个本地目标、0 失败**（见文末最终核对）。
- `node scripts/build.mjs all`：通过；保留上游 Zod 注释与 chunk 体积提示，没有绕过编译错误。
- `node scripts/test.mjs product-runtime`：16 个测试文件全部通过（`build:test` + `unit` 两阶段均 `passed`，`exit 0`）。日志中的 `14/16` 是运行中的进度计数，不是失败；`summary.json` 中 16/16 个任务状态均为 `passed`。
- **全库 `npm run verify`：159/159 通过，`exit 0`**（4 prepare + 1 build:test + 27 unit + 82 server + 45 tools；[原始输出](evidence/wp03-188-full-verify.txt)）。第一次用产品包内 Node 运行时 10 个任务失败，全部报 `npm CLI not found; run verification with the supported Node/npm distribution`：产品包只带 `node` 可执行文件，而 `scripts/test-discovery.mjs` 要求同版本完整发行版内的 `npm`；系统 Node 为 v22.22.2，被 `check-runtime.mjs`（只接受 v24.21.0）拒绝。下载官方完整 `node-v24.21.0-darwin-arm64` 发行版并把其 `bin` 放到 PATH 前置后重跑全绿，**未修改任何测试、探针或产品代码**。这一步也说明本票先前只跑受影响分组的原因：全库回归需要额外的完整运行时环境，而不是本票代码改动引入的失败。
- 未把 #176 Windows 上的文件符号链接 `EPERM` 用例改成本票通过项。

## 桌面 Chrome 验收（逐路径）

### 1. Mac 本机恢复（无学校接收端）

[结构化报告](evidence/wp03-188-mac-local-recovery.json)：3/3 通过。正式产品创建标注、语义引用、问题草稿、真实 Worker 结果与原生检查点；新 Chrome 隔离只读重开原组件、固定结果字节、引用、草稿和检查点且零写入；接管后新 namespace 编辑、从检查点创建不同实例，单步输入 2 得到观察 1，旧 namespace 被拒。含检查点控制回包与接管回包两次真实丢包后按原身份查询。

### 2. 两客户端的学校 Web 路径

[Mac 报告](evidence/wp03-188-mac-school-web.json) · [Windows 报告](evidence/wp03-188-windows-school-web.json)：各 10/10 通过。客户端没有本机产品与数据库，桌面 Chrome 经证书固定的严格 HTTPS 打开学校入口，学校成员登录、组件视图、浏览器真实 Worker/WASM 计算、原学校节点在自身学习数据 owner 下回答查询、停止保持终态与同一 `executionRef`；切断本地 TCP 转发持有的真实 socket 后运行不前进、状态不被改写，重连按原身份重查；撤回课程资格后原节点拒绝结果读取（403），恢复资格返回原运行而非新执行。实屏见 [Mac 断链前](evidence/wp03-188-mac-school-web-before.png)/[后](evidence/wp03-188-mac-school-web-after.png) 与 [Windows 断链前](evidence/wp03-188-windows-school-web-before.png)/[后](evidence/wp03-188-windows-school-web-after.png)。

### 3. Mac 客户端 → 独立学校节点：完整恢复与接管

[结构化报告](evidence/wp03-188-mac-school-recovery.json)：9/9 通过。备份 `e368127e-a91e-4c35-9d0b-8e4cd06959c8` 声明学校 receiver，边界含运行库/存储/学习数据三个 owner（未结、阻塞均为 0，学习数据已结算 2）；学校审批与 installation 绑定的 `learning.authority` grant 使独立节点成为声明 receiver；真实 TCP 断链后重连仍是同一学校身份；隔离 Chrome 重开原组件、97 字节 CSV、引用、草稿和检查点，期间页面 POST 数为零，源浏览器独有未同步草稿仍留在旧 namespace；接管回包丢失保持隔离、重试幂等，真实 SSH 执行边界证明后阶段为 `active`，源 `resume` 返回 `source-retired`；旧学校 grant 返回 503、旧 runtime grant 为 `unavailable/http_401`、旧 namespace 写入返回 403；接管后从检查点创建新实例，单步输入 2 得到观察 1。实屏：[隔离只读](evidence/wp03-188-mac-isolated.png) · [接管后恢复实例](evidence/wp03-188-mac-recovered.png)。

### 4. Windows 客户端 → 独立学校节点：完整恢复与接管

[结构化报告](evidence/wp03-188-windows-school-recovery.json) · [桌面任务原始输出](evidence/wp03-188-windows-desktop.txt)：9/9 通过，与上节同一组用例在真实 Windows 产品包、Windows 原生 AppContainer 执行器与桌面 Chrome 上重跑。备份 `37c7d5ec-b3ff-4b39-8ae6-30995e9db95b`，边界三 owner 未结/阻塞为 0、学习数据已结算 2；`nodeId` 为 `local-win32`，恢复实例沿用原检查点关系但换用新 `executionRef`/执行器实例，下一步观察 1；旧 grant 503、fenced grant `unavailable/http_401`、旧 namespace 403。实屏：[源工作区](evidence/wp03-188-windows-source.png) · [隔离只读](evidence/wp03-188-windows-isolated.png) · [深色](evidence/wp03-188-windows-isolated-dark.png) · [窄桌面](evidence/wp03-188-windows-isolated-narrow.png) · [接管后恢复实例](evidence/wp03-188-windows-recovered.png)。隔离状态、浅深色与窄桌面都复用现有产品界面，没有新增恢复专用页面。

### 5. 接管后、停机与 fence 后的学校节点复验

Windows 接管完成后，学校 receiver 被真实 fence，重新从学校节点取回状态并以 Mac 客户端重跑第 2 节探针（标签 `wp03-188-mac-arm64-final`）：10/10 通过，见[报告](evidence/wp03-188-mac-school-web.json) 与[复验截图](evidence/wp03-188-mac-school-web-after.png)。本轮又真实终止并重启学校守护进程、执行两次 installation fence 后，再次以 Mac 客户端重跑同一路径（标签 `wp03-188-mac-arm64-post188`）：[报告](evidence/wp03-188-mac-school-web-post188.json) 与[断链前](evidence/wp03-188-mac-school-web-post188-before.png)/[断链后](evidence/wp03-188-mac-school-web-post188-after.png) 均为 10/10 通过。说明按 installation 的永久退休和真实停机重启都没有把独立学校节点整体关停，新客户端仍可正常使用。

## 恢复负例（两客户端真实产品包，不涉及学校接收端）

[Mac 报告](evidence/wp03-188-mac-recovery-negative.json) · [Windows 报告](evidence/wp03-188-windows-recovery-negative.json) · [Windows 原始输出](evidence/wp03-188-windows-negative.txt)：各 **7/7 通过**。使用[同一探针](../../scripts/probe-execution-recovery-negative.mjs)，分别在 `darwin-arm64` 与 `win32-x64` 实际产品包、各自原生 PostgreSQL 18.6、Node v24.21.0 上创建一次真实持有备份；之后只在该备份的**副本**或隔离还原目标上制造负例，源安装、原备份与独立学校节点均不触碰。每个拒绝都由产品自身恢复 API 返回，探针不替产品判定结果：

1. 删掉一个加密资源文件 → `invalid-recovery`，目标未发布 `active` 状态。
2. 翻转一个密文字节 → `invalid-recovery`。
3. 保持 JSON 合法但改写 `manifest.json` 身份 → `invalid-recovery`（认证 MAC 失败）。
4. 用另一把恢复密钥打开**原备份** → `invalid-recovery`。
5. 把还原目标写成历史格式（去掉 `boundary`、置 `legacy: true`）→ 接管返回 `boundary-material-required`，目标保持 `isolated`。
6. 把边界中一个 owner 标为阻塞/不可核实 → 同样返回 `boundary-material-required`，不生成完整维护成功，目标保持 `isolated`。
7. 全部负例后，原备份 7 个文件逐字节指纹不变、源安装未退休（`sourceRetired: false`），失败没有静默降级为成功。

两个报告的 `temporaryRootRemoved` 均为 `true`。此节验证备份资源、恢复格式与边界语义在两平台的真实产品运行时上同样 fail-closed；拒绝都发生在开放目标之前，因此不需要学校接收端参与。

## 执行 disposition 负例（两客户端真实产品包 + 原生 PostgreSQL）

[Mac 报告](evidence/wp03-188-mac-execution-disposition.json) · [Windows 报告](evidence/wp03-188-windows-execution-disposition.json) · [Mac 原始输出](evidence/wp03-188-mac-disposition.txt) · [Windows 原始输出](evidence/wp03-188-windows-disposition.txt)：各 **6/6 通过**。使用[同一探针](../../scripts/probe-execution-disposition-negative.mjs)，把冻结的公开 learning 迁移交给产品包内的 `@xunjie/storage`，由产品自己的 `createProductLearningApplication` owner 分类真实执行器表里的命令；探针只负责写入「已接受但未结算」的状态事实（与 #176 工程用例同一方式），不替产品判定任何分类或拒绝：

1. 干净库先发布一份完整的、带边界证据的真实持有备份（3 个 owner、`unresolved`/`blocking` 均为 0，7 个文件），作为正面对照。备份会递增存储 generation，因此探针通过产品 API 重新打开 owner 后再写入，不绕过闸门。
2. 写入三条未结命令后，产品自己的 `material()` 分别给出 `accepted-not-started`（queued）、`stop-pending`（paused + 停止请求）、`unknown`（running + 状态未知），阻塞项为 `unconfirmed-browser-boundary`、`unresolved-stop-pending`、`unresolved-unknown`，并保留原 `requestId`/`inputDigest`/`executionRef`/`activityId`。
3. 结算未知命令后，同一 owner 重新推导为 `settled=1`、仍有两个阻塞项。
4. 全部结算后重新推导为 `unresolved=0`、`blocking=[]`、`settled=3`，证明分类随真实事实变化。
5. 再写入一条 `accepted-not-started` 与一条 `stop-pending` 后发起备份：产品在**维护排空阶段**就发现仍有未确认终态的已接收命令，主动抛 `unavailable`（`executions.shutdown()` 的 fail-closed 检查），根本不发布边界材料；持久操作为 `phase: failed`、`error: unavailable`，`maintenance.json` 的 `safeToStop: false`，目录中没有新 manifest。
6. 已发布的持有备份逐字节指纹不变、源未退休、临时根清理（`temporaryRootRemoved: true`）。

这里按产品真实行为记录拒绝码为 `unavailable` 而不是 `unconfirmed-execution-boundary`：后者是边界材料已产出但含阻塞项时的拒绝，本例产品在更早的排空阶段已拒绝，属于更严格的 fail-closed，探针未放宽任何断言。#176 工程用例仍覆盖 `unconfirmed-execution-boundary` 分支。

## 共享学校节点生命周期与 fence 后拒绝（Mac 真实停机 + 两客户端 fence）

[Mac 报告](evidence/wp03-188-mac-school-lifecycle.json) · [Windows 报告](evidence/wp03-188-windows-school-lifecycle.json) · [Mac 原始输出](evidence/wp03-188-mac-school-lifecycle.txt) · [Windows 原始输出](evidence/wp03-188-windows-school-lifecycle.txt)：Mac **7/7**、Windows **5/5** 通过。使用[同一探针](../../scripts/probe-school-lifecycle-negative.mjs)；学生流量始终是直连严格 HTTPS，SSH 仅用于签发 installation 绑定 grant、读取守护进程记录、停/启服务与 fence。共享节点的停机重启只在 Mac 链路执行一次（`--node-lifecycle=1`），Windows 传 `0` 跳过重复停机，但独立跑完整 fence 链路。

1. 两客户端各以真实产品包、原生 PostgreSQL 与安装级 `learning.authority` grant 完成严格 HTTPS 握手 `ready`，连接写入 `installation.json.connections`。
2. **Mac 真实终止进程**：读取学校节点 `launch.json` 得到真实 pid `300084`/进程身份，SSH `kill` 后 8443 监听数从 1 变 0；同一 `grantId`/`connectionId`/`sourceInstallationId`/`receiverId` 下 `check()` 变 `unavailable`（`connection_unavailable`），能力调用被拒；原 `requestId`/`inputDigest` 未变、没有换节点重跑。
3. **由产品 `cli.js start` 重启**（新 pid `304549`），8443 监听恢复为 1，同一身份握手回到 `ready`；停机 08:58:12Z、重启 08:58:20Z 均在报告中。
4. **可信晚回包**：在 fence 前发出一个真实 `POST /runtime/capabilities/learning.authority`，用 chunked 请求体只发前半段并保持连接；随后通过 SSH 对**该 installation** 执行 `fence-source`，得到 `fenced: true` 与三个服务 `unresolved=0`、`blocking=0` 的真实执行边界证明；再补完请求体，学校节点在派发前重新校验 generation，返回 **401 `{"error":"unauthorized"}`**。晚回包只按原 `requestId`/`inputDigest`/`grantId`/`sourceInstallationId` 归档，不恢复派发权；随后 `check()` 与能力调用均为 `unavailable/http_401`。
5. **恢复旧连接文件**：把 fence 前保存的 7 个凭据文件与 `installation.json` 原样写回客户端，再次握手仍 `unavailable/http_401`，能力调用仍被拒，证明旧连接文件、旧处理者都不能重新获权。
6. **新安装授权**：为另一全新 installation 签发 grant 并连接，握手 `ready`；同时已退休 installation 仍 `unavailable/http_401`，即新授权不会让旧安装复活。
7. 学校节点在停机重启与两次 fence 后仍以严格 HTTPS 返回 `/runtime/environment` 200、8443 监听 1；随后 Mac 学校网页路径 10/10 复验通过（上节第 5 条）。两个报告的 `schoolUpAtFinish`、`temporaryRootRemoved` 均为 `true`，签发的 grant 文件已删除。

## #188 验收标准逐条对照

| #188 标准 | 本票结论 |
| --- | --- |
| Apple Silicon Mac 实际包、原生 PostgreSQL/资源、桌面 Chrome 完成未结执行备份、隔离还原、正式接管并记录版本 | 通过：第 1、3 节与版本表；`lostCheckpointReply`/`lostTakeoverReply` 均为 true |
| Windows 与 Mac 客户端各连至少一台独立学校机，覆盖学校原生/获准本机/混合路径；严格 HTTPS，SSH 仅维护 | 通过：第 2、3、4 节与生命周期节，同一台独立 Ubuntu 学校节点；学校节点自身 owner 回答查询、客户端本机执行器跑原生会话、安装级 grant 读取学校课程构成混合路径 |
| 正式首页/活动/工作区重开标注、固定结果与下载、问题草稿、语义引用、会话历史；接管后新 namespace 编辑 | 通过：两客户端完整恢复探针逐项断言，CSV 按摘要与字节数重读 |
| 检查点来自真实执行器、可靠保存后恢复，新关联实例下一步与基准一致；缺失/损坏/不兼容保留历史与明确原因 | 通过：真实检查点、新实例与下一步 1（第 1、3、4 节）；备份资源缺失、单字节损坏、manifest 篡改、错密钥、legacy 与不可核实边界在两客户端真实产品包上 7/7 被拒，原备份逐字节保留（恢复负例节） |
| 覆盖已接受未开始、执行中/暂停、停止待确认、未知/丢回包；无法核实不生成完整维护成功 | 通过：暂停后检查点、停止终态、检查点控制与接管回包丢失、真实断链（第 3、4 节）；「已接受未开始」「停止待确认」「未知」三种 disposition 在两客户端真实执行器表上由产品自身分类，存在未结命令时产品在维护排空阶段返回 `unavailable`、不发布完整维护成功，持有备份字节不变（执行 disposition 节） |
| 隔离目标只读核对组件版本、作品、回执、结果、事件、检查点；新增实验/Worker/原生进程/远端命令为零 | 通过：隔离上下文 `readOnly`、组件版本与逐字节产物核对、页面 POST 数为零、恢复按钮禁用、旧草稿留在源 namespace；服务侧写入/实验/领取/连接拒绝由 #176 `isolated-learning` 真实库用例覆盖 |
| 接受/控制/停止生效后丢回包、真实断网、进程/节点退出、接管中断按原 requestId/inputDigest/节点核实 | 通过：丢回包、真实 TCP 断链、接管阶段中断与幂等重试通过；另在独立学校节点上真实 `kill` 守护进程 pid `300084`（8443 监听归零）再以产品 `start` 重启，全程保持同一 `grantId`/`connectionId`/`sourceInstallationId`/`receiverId` 与原 `requestId`/`inputDigest`，不换身份或节点重跑（生命周期节） |
| 源永久退休、全部接收端执行边界证明后开放；源不可达/缺接收端/部分失败保持隔离 | 通过：SSH 逐接收端执行边界证明、丢回包后保持隔离并幂等重试、`source-retired`；生命周期探针另取得三个服务 `unresolved=0`/`blocking=0` 的独立 fence 证明；缺接收端/源不可达负例沿用 #176 工程用例 |
| 旧安装、旧 grant/连接、旧挂载、旧 namespace/队列、旧处理者被拒；新授权后旧安装仍不能获权；可信晚结果只按原身份归档 | 通过：旧学校 grant 503、旧 runtime grant `unavailable/http_401`、旧 namespace 403、旧浏览器草稿原样保留且不被新 namespace 读取、源 `resume` 被拒；另在 fence 后真实恢复 7 个旧凭据/连接文件仍被 401 拒绝、fence 前发出的晚回包在 fence 后返回 401 且不恢复派发权、新 installation 授权 `ready` 时旧 installation 仍 `http_401`（生命周期节） |
| 恢复格式/历史兼容、资源缺失/损坏与故障中断负例；保留源与原备份，失败不静默降级 | 通过：故障中断（接管丢回包保持隔离）通过；legacy 禁止接管、资源缺失/损坏/篡改与错密钥拒绝恢复已在两客户端真实产品包 + 原生 PostgreSQL 上 7/7 重跑，原备份字节不变、源未退休 |
| 实际产品包含全部必要 owner/维护参与者；保留失败尝试、版本、连接路径、阶段证据、实屏截图，按授权清理临时环境 | 通过：两客户端报告记录 3 个 owner 边界、安装/连接/授权/备份/阶段身份与版本；失败截图与报告保留（见下节）。成功运行的临时根均已自动删除；两轮 Windows 临时现场均按负责人授权移入回收站并核验，一次性计划任务已删除，阶段证据先脱敏归档（[归档](evidence/wp03-188-windows-failure-sites.txt)） |

浏览器验收只使用桌面 Chrome，符合 [AGENTS.md](../../AGENTS.md) 的范围要求。恢复负例节不涉及学校接收端，因为拒绝发生在开放目标之前；执行 disposition 节也只在本地产品包上注入状态，不改动学校节点。

## 失败现场与修正

1. **Mac 学校恢复首次尝试**（[失败截图](evidence/wp03-188-mac-failure.png)）：检查点控制回包丢失后界面停在「操作尚未确认或当前状态不允许，已核对原会话，不会自动重做」，未出现可恢复检查点。产品如实拒绝伪造确认；探针修正步骤后完整重跑 9/9 通过。另有一次学校审批按钮因页面未先持有成员会话而保持禁用，已按真实登录顺序修正。
2. **Windows 经 SSH 直接运行**：原生会话显示「本机会话未能启动」「本机会话进程意外结束」。用 `win-helper-launch.mjs` 在 SSH 会话与交互桌面会话分别诊断同一 `windows-session.exe`：SSH 会话 `HELPER_EXIT 1`（连普通 `node.exe` 子进程都无法在受限会话中启动），交互桌面 `HELPER_EXIT 0 / SESSION_CHILD_OK`。这是 Windows 会话环境限制，不是产品执行器改动；因此 Windows 全程验收改在真实交互桌面会话中运行。
3. **Windows 交互桌面首次运行**：表格聚合的「运行计算」点击后 `#status` 仍停在「可以选择分组列与数值列后运行。」，30 秒内没有计算记录；无页面异常、无请求失败。定位为被遮挡/后台化的 Chrome 延迟了组件 iframe 的输入与确认轮询。修正仅在验收探针：Chrome 加 `--disable-background-timer-throttling`、`--disable-renderer-backgrounding`、`--disable-backgrounding-occluded-windows`、`--disable-features=CalculateNativeWinOcclusion`；先等 iframe 状态就绪，仅当「无提交请求且状态未变化」时补一次点击（绝不对已发起的执行重复提交）；并新增 HTTP ≥400 诊断。修正后同一次完整运行 9/9 通过，Worker/WASM 结果为真实 `已完成`，原生会话与检查点均来自真实执行器。[失败截图](evidence/wp03-188-windows-failure.png) 保留；未修改 UI 或生产代码，未放宽任何断言。
4. **全库 `verify` 第一次运行**：10 个任务失败，均为 `npm CLI not found`（产品包内 Node 不是完整发行版）。补齐完整 Node 24.21.0 发行版后 159/159 通过；[原始输出](evidence/wp03-188-full-verify.txt) 中只保留成功一次的完整日志，失败原因在本页登记。恢复负例探针开发中还出现一次 `ENOENT …/target-legacy/instance.json`：还原目标必须先 `start()` 运行产品运行时才能评估接管；按主探针相同时序修正后 7/7 通过。
5. **执行 disposition 探针三次迭代**：第一次把备份目录放进运行时数据根，产品正确返回 `invalid-recovery-path`，改为兄弟目录；第二次在存在未结命令时预期 `unconfirmed-execution-boundary`，实际是产品 `executions.shutdown()` 在排空阶段先返回 `unavailable`（更严格的 fail-closed），据实改断言；第三次想让 synthetic 命令结算后再发布备份，被产品 `validateExecutions` 的 `inputDigest`/动作体校验判为 `operation-failed`，于是把正面对照移到注入任何 synthetic 行之前，并在备份后通过产品 API 重新打开 owner 以刷新存储 generation（否则 `stale-generation`）。三次都没有修改产品或放宽断言，Windows 上另因短时文件句柄残留导致探针自清理失败，已按授权在收尾步骤移入回收站并核验。
6. **Windows 生命周期探针经普通 SSH 会话运行**：维护 SSH 子进程超时被杀（`school maintenance command failed (null)`），并且卡在收尾的监听检查；这与第 2 条同属非交互会话限制。终止卡住的进程后改用 `win-lifecycle-desktop.ps1` 交互桌面计划任务运行，5/5 通过。学校节点服务未受影响，收尾仍由探针保证并核验。

## 证据与清理边界

结构化报告： [Mac 本机](evidence/wp03-188-mac-local-recovery.json) · [Mac 学校](evidence/wp03-188-mac-school-recovery.json) · [Windows 学校](evidence/wp03-188-windows-school-recovery.json) · [Mac 学校 Web](evidence/wp03-188-mac-school-web.json) · [Windows 学校 Web](evidence/wp03-188-windows-school-web.json) · [停机与 fence 后学校 Web 复验](evidence/wp03-188-mac-school-web-post188.json) · [Mac 恢复负例](evidence/wp03-188-mac-recovery-negative.json) · [Windows 恢复负例](evidence/wp03-188-windows-recovery-negative.json) · [Mac 执行 disposition](evidence/wp03-188-mac-execution-disposition.json) · [Windows 执行 disposition](evidence/wp03-188-windows-execution-disposition.json) · [Mac 学校节点生命周期](evidence/wp03-188-mac-school-lifecycle.json) · [Windows 学校节点生命周期](evidence/wp03-188-windows-school-lifecycle.json) · [全库 verify](evidence/wp03-188-full-verify.txt) · [Mac 工程检查](evidence/wp03-188-engineering.txt) · [Windows 桌面控制台](evidence/wp03-188-windows-desktop.txt) · [Windows 恢复负例输出](evidence/wp03-188-windows-negative.txt) · [Mac/Windows disposition 输出](evidence/wp03-188-mac-disposition.txt) · [Mac/Windows 生命周期输出](evidence/wp03-188-mac-school-lifecycle.txt) · [失败现场阶段证据](evidence/wp03-188-windows-failure-sites.txt)。实屏截图索引见上文各节，浅深色与窄桌面图在 `evidence/wp03-188-windows-isolated-*`，停机与 fence 后复验截图为 `evidence/wp03-188-mac-school-web-post188-*.png`。

所有成功运行的临时数据库、进程与凭据根均已由探针删除（报告 `temporaryRootRemoved: true`、`cleanup: ["fulfilled","fulfilled"]`）。Windows 第一次四个失败现场目录（`C55sDq`、`CEFEEx`、`KQibp3`、`p8ceIY`）按负责人授权移入回收站，两个一次性计划任务已删除；清理前逐目录归档了 `status.json`、`maintenance.json`、`installation.json`、`environment.json`、`database.json`、`postgres.log` 并核对不含 token/口令/私钥。本轮补充负例又产生的 Windows 临时根与一次性计划任务同样按授权清理并核验为 0 残留。学校节点上只保留本票临时 installation 的 fence/退休记录作为验收事实，签发的 grant 文件已删除；没有删除原业务环境、原备份或云端学校数据。

工程测试、全库回归、桌面 Chrome、真实跨机恢复、恢复负例、执行 disposition 与共享节点生命周期分别登记；**教学效果未评估**，这是本页唯一明确不执行的项目，不能据此把 #176 或本票写成教学有效性已验证。

最终核对（提交前）：文档链接 193 份 Markdown / 1690 个本地目标 / 0 失败；八个新增验收脚本在产品包 Node v24.21.0 下语法检查全部通过；Windows 临时根、一次性计划任务、运行日志与 Mac 临时根均核验为 0 残留；学校守护进程（pid `304549`）与 8443 严格 HTTPS 仍在服务，签发的临时 grant 已删除。
