# #212 Mac 与真实跨机的学习对话恢复验收（已有环境）

本票在既有 `wp07` 分支实施，不新开或合并 PR。验收基线为 `087e7f9c7df5fdd593cd8f581537094ac0724858`，另含本票发现的接收端兼容修复。来源为 [#212](https://github.com/paher-din/XunJie/issues/212)，父票为 [#204](https://github.com/paher-din/XunJie/issues/204)。

使用执行者已有的 Apple Silicon Mac（Darwin 27.2.0、Node 24.21.0、原生 PostgreSQL 18.6、桌面 Chrome 156.0.8078.80）和已有获准的另一台 Windows 主机（Windows 11 build 26200、Node 24.21.0）。未准备或搭建新的 Mac 环境，未并入 #155、#209、#210。密钥、密码和 token 只存在于被忽略的 `.verification/` 目录，未进入 Git、提交、命令行参数或证据文件。

## 必要修复

真实跨机验收发现接收端 SSH 适配在 Windows OpenSSH 下不可用：Windows OpenSSH 不向管道 stdin 发送 EOF，且在校验输出后不关闭通道，导致 `createSshRecoveryReceiver` 的 fence 一直等到 90 秒超时并报告 `receiver-unavailable`。修复位于 `packages/product-runtime/src/ssh-recovery.ts`：

- 身份载荷改为 base64 编码后作为远端命令的一部分，由远端本地 `base64 --decode` 管道喂给 `fence-source`；不再依赖 stdin EOF。
- 只要 stdout 出现完整的合法 fence 证明就立即确认；`close` 仍按原协议处理错误码和身份校验。证明结构、来源身份、服务列表和 installation 校验保持不变。
- `stdio` stdin 改为 `ignore`，测试同步改为从远端命令解码载荷。

该修复由接收端单测 `ssh-recovery.test.mjs`（2/2）、全工程类型检查和真实 Windows→Mac fence 接管共同验证。没有修改其他产品行为。

## 环境与拓扑

| 端点 | 主机 | 角色 | 产品包 |
| --- | --- | --- | --- |
| 学校 | Mac `192.168.3.39` | 学校权威与 SSH fence 接收方 | `darwin-arm64` full，`2026-11-07T09:31:27.108Z`，`distribution.json` SHA-256 `81a060bc…01183` |
| 学生客户端 / 混合设备 / 独立 Agent | Windows `192.168.3.8` | 原操作、备份源与接管目标 | `win32-x64` full，`2026-11-07T09:31:36.691Z`，`distribution.json` SHA-256 `a52fd73b…f753e1` |

两个完整包均为 `unsigned-candidate`，内置 Node 24.21.0 与 PostgreSQL 18.6。学生和依赖流量走真实 LAN HTTPS（验收 CA）；SSH（Mac 用户级 sshd，端口 2222）只用于正式接管的部署 fence，不承载学生流量。同机多安装的工程证据保留在 `packages/product-runtime/test`，不计入本票跨机结论。

## 工程

以下原生入口在真实 PostgreSQL 18.6 上显式执行，TAP 原文见 [`evidence/wp07-212`](evidence/wp07-212)。默认清单不包含 `.runtime.test.*`，本次逐文件显式运行。

| 检查 | 结果 |
| --- | --- |
| `apps/server/tests/teaching-agent.recovery.runtime.test.mjs` | 5/5 通过（约 73 秒）：学生 Wait 与修订队列、真实物理调用未知的暂停 Run、原生完整结果封存、坏清单/必需格式拒绝、WP03 未领取命令与未确认浏览器阻止备份。 |
| `apps/server/tests/teaching-agent.independent-recovery.runtime.test.mjs` | 2/2 通过：学生 Wait 与真实工具 Wait。 |
| `apps/server/tests/agent-deployment-cleanup.runtime.test.mjs` | 12/12 通过：正式恢复五场景与真实执行清理七场景。 |
| `packages/product-runtime/test/recovery-connections.test.mjs` | 6/6 通过：撤权、旧安装切断、继任保留、失败手动 fence 关闸、可信重试、接收方备份后的永久退休。 |
| `packages/product-runtime/test/ssh-recovery.test.mjs`（修复验证） | 2/2 通过：合法证明确认、错误 receiver 身份不确认。 |
| 事件协议扩展 | 1/1 通过：可忽略扩展 payload 原样保留；未知必需事件拒绝。 |
| 全工程类型检查 | `node scripts/build.mjs typecheck` 通过（日志 `typecheck-final.log`）。 |
| darwin-arm64 full 包 | `scripts/package-product.mjs --platform darwin-arm64 --profile full` 新建成功，未复用旧 Web 输出。 |

一次早期运行误用系统 Node 26，5 个原生恢复用例均以 `Bundled Node.js version mismatch.` 失败；改用 24.21.0 后 5/5 通过。该失败保留在复跑记录中，不计为产品失败。

## 恢复与部署

darwin full 包通过包内 CLI 完成安装、启动、停止；维护/学生恢复入口用桌面 Chrome 检查，五个阶段全部通过：

| 阶段 | 结果 |
| --- | --- |
| `bundled-or-source-cli-start` | 包内 CLI 启动为 `ready`。 |
| `isolated-history` | 隔离副本保留原 Run/输入/模型调用事实。 |
| `chrome-readonly` | 桌面 Chrome 打开只读入口，未提交学生回应。 |
| `takeover-and-old-client-rejection` | 正式接管后旧客户端被拒绝。 |
| `chrome-active-original-response-and-fifo` | 桌面 Chrome 提交原问题回应，修订队列显示为已采用，原 Run 与后继 Run 均完成。 |

普通 Web 输出和全新完整包各跑一遍（`chrome-web`、`chrome-package`），均 3 次合成模型调用、清理完成。截图见 `chrome-package/restore-readonly-darwin.png`、`restore-active-darwin.png`。独立 Agent 的桌面 Chrome 场景另有 `chrome-independent/active-darwin.png`，记录原 Run、凭据轮换、重连后重复接管、休眠接收方问题保留与源退休。Chrome 版本 156.0.8078.80。

## 真实跨机结果

三种连接均经真实 LAN HTTPS；接管使用远端 Mac 的 SSH fence。两端事实分别保存在各自报告，汇总见 [`cross-machine/summary.json`](evidence/wp07-212/cross-machine/summary.json)。

### 学校连接（Mac 源码学校 → Mac 目标学校，Windows 学生客户端）

- 原操作：Windows 客户端在 Mac 学校发起学生问题、排队输入与修订；备份时已有 1 个 Wait、2 个输入。
- 隔离副本：重新登录后逐项比对 `messages/inputs/questions/tools` 与原事实一致；学生回应被拒（503）。
- 备份 `a75040e2-56c7-47ea-9acc-8f331a1605cb`，目标安装 `02ac2127-b11e-47fe-ba29-a1d19c61e164` 接管为 `active`，源状态 `maintenance`。
- 接管后：旧客户端命名空间被拒（403）；原 Run 与后继 Run 均 `completed`，修订输入 `ec0ad3f3…` 被采用。

### 独立 Agent（Windows 源码/目标 + Mac 学校）

- 原操作：Mac 学校为 Agent 活动发起学生问题、排队与修订；Agent 经 `teaching.dependencies` 连回 Mac 学校学习数据。
- 备份 `0595d214-8367-48c8-9bb0-22f24042e81f`，目标安装 `fbd7b7a7-07a6-4a93-835f-dcb37b08fcfb` 接管为 `active`；源启动被拒（`Recovery: source-retired`）。
- 接管后学校用轮换凭据 `reconnect` 并重新签发 `teaching.dependencies`；原问题得到明确回应，修订输入 `ecd878b5…` 被采用，原 Run 与后继 Run 均完成。

### 混合连接（Windows 本机学习数据 + Mac 学校权威）

- WP01 配对握手 `75af40d3-9639-49ce-bd85-fcab4d33cbb1`，设备绑定学校客户端服务 `586b0482-d5d9-42e8-9af0-69c0c6f43b6a`；首轮授权 `7b544687…`。
- 原操作：设备本地建立作品、问题草稿与待发动作意图 `90883684-0c20-4469-8a83-88c9ae542ab6`（`prepared`），记录源命名空间。
- 备份 `fbd7a3cc-3d20-4acf-85a2-d835acd32071` 的 `receiverIds` 精确指向 Mac 学校客户端服务；目标安装 `e838063a-8eb5-4bc2-9d6b-e799c73e9aff` 接管为 `active`，源停止并被拒（`Recovery: source-retired`）。
- 接管后重新配对 `2d4867fb-7e47-4c09-83ba-58c0d1b3d043`，学校为继任安装重新签发授权 `04f611cd…`；旧设备命名空间被拒（403）；原动作、作品与草稿逐项一致；新动作 `acb5f2ee…` 在恢复后的设备上 `prepared`。

混合连接的产品路径是“设备本机学习事实 + 待发动作意图”，即时模型对话不是该配对模式的既有能力；因此混合的教学效果证据是原问题/作品/草稿事实在接管后保留并由恢复设备继续接收新动作，不声称模型已即时作答。

## 分项结论

| 项目 | 结论 |
| --- | --- |
| 工程 | 28/28 原生用例通过（5+2+12+6+2+1），类型检查和完整包构建通过；一次 Node 26 误跑失败已如实保留。 |
| 恢复/部署 | 三种连接均完成备份、隔离只读、正式接管、源退休、旧连接拒绝与重新授权；darwin 包由包内 CLI 安装/启动/停止。 |
| Chrome | 桌面 Chrome 五个阶段全部通过，只读与接管后状态有实际截图；独立 Agent 场景通过。 |
| 教学效果 | 使用合成上游 transport，验证的是恢复语义而非真实教学效果。学校/独立 Agent 的原问题回应与修订队列在接管后继续并完成；混合模式保留原问题、作品与草稿并接受新动作。 |

## 失败与复跑

保留的失败或临时问题：

1. 系统 Node 26 运行原生恢复用例报 `Bundled Node.js version mismatch.`；使用仓库内 24.21.0 后 5/5 通过。
2. Windows daemon 随 SSH 会话关闭而退出；跨机复跑需用持有会话启动（`run-hybrid-hold.ps1` 或等价 `Start-Sleep` 会话）。
3. 设备 profile 只接受 loopback 监听与 loopback endpoint；设备源/目标的公开端点必须为 `127.0.0.1`，证书需含 loopback SAN。
4. `manage/local-binding` 若携带 `x-xj-space: school:…` 会被转发给学校并返回 403；本地绑定必须清空该校验头。
5. 重跑 `client/complete`（已交换）或 `connect`（已登记）会分别报 403/`Connection already registered`；复跑脚本按本地凭据与安装登记幂等跳过。
6. 混合设备的动作能力表为空是既有产品行为（`school-client` 的本地 learning-data 没有注入 action receiver），因此混合证据只准备动作、不派发；不作为缺陷修改。

复跑入口（配置、密钥和完整包在验收时生成，验收后已按本票清理；复跑时重新生成同形配置即可）：

```sh
# 原生恢复（真实 PG，仓库内 Node 24.21.0）
XUNJIE_PRODUCT_POSTGRES_BIN=/opt/homebrew/opt/postgresql@18/bin \
  .verification/node24-bin/node --test --test-reporter=tap apps/server/tests/teaching-agent.recovery.runtime.test.mjs

# 学校/混合（Mac 侧）
.verification/node24-bin/node scripts/cross-machine-recovery-school.mjs --phase=<setup|backup-restore|takeover|hybrid-member|hybrid-approve> \
  --product=<darwin-arm64 full 包> --root=<school-target> \
  --config=<hybrid-school-config.json> --out=<report.json> --work=<inputs>

# Windows 侧（经已获准 SSH 主机；runner 只是固定引号的 PowerShell 包装）
powershell -File <ticket-local>\run-hybrid.ps1 -Phase <phase> -Out <report.json>
```

`scripts/cross-machine-recovery-{fixture,school,client,agent,hybrid,forwarder}.mjs` 为可复跑的验收驱动；只控制外部模型 transport，学生/依赖流量使用真实 HTTPS。

## 清理

本票一次性环境已停止并移除：Mac 学校目标 daemon、Windows 混合设备源/目标 daemon、独立 Agent 源/目标 daemon、合成模型 fixture、Windows 转发会话、所有持有 SSH 会话，以及本票启动的 Mac 用户级 sshd（端口 2222）。Mac 与 Windows 两侧的 `.verification/wp07-212/` 一次性产品包、源/目标根目录、备份、配置与生成的 CA/设备密钥均已删除。未删除或修改执行者原有的 Mac 环境、PostgreSQL、桌面 Chrome、Windows 主机既有 SSH 私钥或任何原有资料；验收所需证据已保存在本仓库。
