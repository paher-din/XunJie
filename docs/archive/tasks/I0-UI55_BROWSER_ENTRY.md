# I0-UI55：登录接线与本机浏览器交接

旧 PAHER 连接与维护入口已退役。当前地址、身份、证书及连接步骤由负责人私下发放；仓库仅提供[通用基础设施模板](../../tools/i0-cloud/README.md)。以下保留原历史授权、失败和验证事实，不作为当前连接、维护或领取凭据的说明。

日期：2026-10-14（Asia/Shanghai）。负责角色：Robert / UI，由本会话 Agent 实施。父任务：[I0 #30](https://github.com/paher-din/XunJie/issues/30)。请求来源：[PR55 的 UI 交接 comment](https://github.com/paher-din/XunJie/pull/55#issuecomment-6152088547)。

当前共享交付从最新 main `5c8c60ec93e00bc1782a534a88b696ae98c76c37` 建立 `codex/i0-ui55-tools-evidence`；仅工具、证据、本人任务与入口说明有差异。旧宿主现场所用 `40db96c` 加 H-04 候选及窄回归已保存为本地 `79f90370114abba05ba3e3ea428f273734e04ede`，不公开叠到刚合入 PR66 的正式 UI；早期内容槽登录原型亦不包含。以下各节按发生时间保留历史，“未执行”不自动代表当前状态。

| 当前能力 | 2026-10-14 本机现场结果 |
| --- | --- |
| 原 A/C review 修复 | 已追加原 PR53/55；本任务未重复 review |
| SSH 转发与维护 | 严格固定身份/主机公钥，exec/SFTP 实测可用 |
| 本轮候选 UI / 同源严格 TLS | 固定 40db96c 加本地 H-04 接线，正常构建 143 文件逐项匹配；最新 PR66 未在 PAHER 复验 |
| 指定合成学生登录/作品读取 | 90 秒 91 次 Session GET 全 200；Chrome 刷新、退出、重新登录恢复原 v7 |
| C1 原冻结环境 | 一次恢复后独立 `readiness` 退出 0；146 / 原指纹 / 原代际一致 |
| HTTP `/health/ready` | 原宿主固定 503，保留失败，不由 C1 ready 覆盖 |
| 原实服务 Run/Stop/历史 | 真实 C1 v7 输出 `new snapshot`；v4 timeout 与另一原作业 cancelled；历史绑定 ID/profile/hash |
| Windows 时间后续状态 | 已批准换源同步成功；两轮实际 WSL 同步无倒退，最终 Windows LastSyncError=2 单独保留 |
| UI-REAL 全项 / 全产品 / 教学 | 没有全部验收；正向产物下载、跨账号、暂停/撤权及恢复故障仍分列 |

## 依据与范围

已读 README、根 AGENTS；PRD §3.2、4.1～4.2；MVP_SPEC §2、M-10、§4～5；TECH_DESIGN §3.3、§5 登录接口、§9；[UI SPEC](I0_UI_SPEC.md)、[客户端约束](I0_UI_CLIENT_CONTRACT.md) §7～8、[01](I0_UI_01_IMPORT_C_ENTRY.md)、[07](I0_UI_07_BROWSER_HANDOFF.md)、[真实深链](I0-B_REAL_ENTRY.md)及 [UI 来源](../../apps/student/IMPORT_SOURCE.md)。适用 M-10、NFR-04/05、U-07、H-01/02；沿用同源 API、服务端 Session / CSRF 与原任务深链，不新增分配列表契约。

用户明确要求完成 comment 中 Robert/UI 的接线及浏览器验收，并选择“用我的电脑就行”。可实施范围：在已交付 C 工作区的不可用内容区补齐正常登录操作、验证既有深链的读取/退出/恢复，以及维护本记录和学生工程使用说明。现有工作区容器、设计样式、数字逻辑演示和学习操作保持原来源。正常登录不新增页面或导航，不用本机昵称充当身份。

隔离基线：UI 已提交 `1d0856d`；独立 managed worktree `i0-ui-real-browser` / 分支 `codex/i0-ui-browser-handoff`。主工作区并行修改不复制、不写入。A/C 修复已分别追加原 PR53/55；本任务不再重复其审查。

可写：`apps/student/src/workspace/session.ts`、正常工作区登录组件及其接入位置、相关单元与 Chrome 协议验证、`apps/student/README.md`、本任务记录。只读：产品/规划/参考/规范、A/C 模块、真实数据库和秘密材料。既有学生依赖仅在隔离目录复用，不安装新依赖。

## 实施方案与验收

1. 只有正常模式 GET Session 返回合法 `401 / UNAUTHENTICATED` 时，现有中心不可用区显示账号/密码输入；网络或协议故障保留重读，避免把服务缺失提示成口令错误。
2. 学生明确提交才 POST `/api/sessions`，只发送 `loginName/password`。口令不写本机存储、诊断或任务记录；不设前端角色。验证登录响应后重读 Session → bootstrap → 固定活动，用户/课程/CSRF 来自实际响应。登录不会创建 Attempt、保存或运行。
3. 未完成/失败不宣称成功，不自动重发登录；重复点击只发送一次。任务切换或卸载后迟到结果不刷新新工作区；口令提交后清空。退出后旧工作区不可见，再次登录仍由学生发起。
4. 使用本机已安装 Chrome 检验登录错误、正常进入、只读初始化、显式创建、退出和迟到响应隔离。协议替身、真实 HTTPS 服务、执行节点和教学效果分别记账。

## 本机服务与精确信任方案（待决策）

浏览器主机为 获准本机 / Windows 获准用户 / Chrome 155.0.8059.40。C 的原服务主机为 PAHER，当前电脑 `历史回环入口` 未监听；PAHER 的回环入口不能直接作为本机地址。

本任务准备时原 24 表合成库的 `/tmp` 文件已丢失，恢复尚待批准；随后回读 [PR55 当前提交](https://github.com/paher-din/XunJie/commit/0d7c5f93b95f4d4ff4204db5c49accaa15c6f10b) 的 C 记录 §15.5～15.9，确认 C 已获负责人批准新建持久 24 表合成库、复用原秘密材料并恢复真实 HTTPS 服务。新库原 20 项独立 20/20；本任务没有重复其服务端验证。旧 Assignment/Activity/Attempt 仅为历史证据，不能用于当前浏览器。已有叶子证书 SHA-256 `历史指纹私下保留` 属 PAHER 公共 TLS 材料，不能直接把旧信任提案写成本机已实施。

当前真实 C 入口（C 回交，非本任务现场验收）：PAHER `历史回环入口/#/task/a2533386-4923-4dee-83bd-2d7a99fb06e9`，Activity `f0942cb7-75ef-4625-aa92-d649268d61cb`，Attempt `c9166463-5f46-4dc6-82c3-96456f394258`。C 的公开 TCP 证据明确 host=PAHER；本机重新探测 历史回环入口 仍不可达。原业务运行源固定 `9fa76ad`，不会自动带上本次学生前端构建；实际入口还须交接本次 UI 产物。

真实 C 链需要先落实服务路线：通过既有获准私有地址/SSH/VPN 访问 PAHER，或另行明确本机部署范围。用户已选本机浏览器，但本会话没有新增通道、复制 PAHER 凭据、修改信任或另建本机数据库。已向用户请求可达的私有地址/现有通道信息，不要求在聊天发送口令/密钥。若后续确需新增跨机通道/本机环境，须形成精确对象/端口/凭据渠道方案再批准实施；C 已完成的原服务恢复不重复申请。

另保留 C 回交的实际 `/health/ready` 503 / `DEPENDENCY_UNAVAILABLE` 缺口，由 A 的宿主就绪装配承担；页面/live=200、C 节点 ready=true 和服务端 20/20 不将该项改贴通过。本机单独的隔离教学服务测试可以验证正常宿主和登录，但其合成 provider / 无 C1 执行节点不能计作 PAHER C1 浏览器验收。

精确信任方案需绑定最终 origin、公开证书指纹、Windows 用户/浏览器 profile 与有效期；优先适用现有受信 HTTPS。若需要本机导入 CA，必须明确 CurrentUser 范围及证书对象并获得负责人确认。禁止关闭 TLS 校验或点击绕过证书警告。凭据仅按批准的数据和目的地通道领取，不从 PAHER 复制未知秘密目录。

## 验证与交付记录

实现：`SessionLogin.tsx` 复用原工作区内容槽、既有输入/按钮样式；只在正常模式合法 401 / UNAUTHENTICATED 下展示。`session.ts` 严格验证登录投影，登录返回 token 不直接安装；初始化仍由原 ContextGuard 读取服务端身份/课程/CSRF。提交口令立即从受控表单清空，字段/提交在途禁用；卸载后迟到结果不调用重读。服务端可能已建立会话的事实不由前端卸载推断撤销。限流/口令错误/未确认仅给准确下一步，不记录原错误正文或凭据。

本机现有 `node_modules` 复制到独立工作树的忽略目录；没有 junction 指向主工作区，Vite 缓存和 dist 均写隔离目录，没有安装依赖或改 lockfile。测试仅使用明确命名的协议合成凭据，不领取真实账号。

| 命令/范围 | 结果 |
| --- | --- |
| `npm test -- src/workspace/session.test.ts src/workspace/init.test.ts` | 2 文件 22/22，0 失败/跳过；本次登录负例 6 项 + 原初始化 16 项 |
| `npm run typecheck` | 浏览器及 Node harness 两份 TypeScript 检查通过 |
| `npm run build` | 正常 dist 构建通过，1208 modules；现有大 chunk 警告保留，不为本任务改变拆包 |
| `XUNJIE_E2E_BROWSER_CHANNEL=chrome XUNJIE_E2E_PREP_PORT=5713 XUNJIE_E2E_REAL_PORT=5714 XUNJIE_E2E_RESTART_PORT=5715 CI=1 npm run test:e2e -- e2e/real-mode.spec.ts` | 本机安装 Chrome，12/12，0 失败/跳过，18.9 秒；含原真实模式/深链 7 项及本次登录 5 项 |

Chrome 五项新增回放分别核错误口令→正确登录→只读→显式创建→退出→原作品恢复、429 限流、非法登录投影、在途重复与换任务迟到响应、Session 网络故障。成功后写命令只使用 Session 重读的 CSRF；登录不写 Attempt、保存、快照或 Run，Web Storage 无口令/CSRF。测试在正常 Vite 上替换 HTTP 协议响应，**不代表实际 HTTPS/TLS/Secure Cookie、PAHER/C1/真人验收**。原数字逻辑演示仍由同一套原测试通过，不新增模拟产品入口。

失败记录：首次 Node harness 类型检查因新测试误用 ES2023 `findLast` 失败，改为既有 ES2022 `filter().at()`，最终检查通过；首次 Chrome 执行在发现阶段拒绝 describe 内 worker 级 trace 配置，移除该新增配置后 12 项完整通过。未调整产品编译目标、关闭断言或缩减原七项。Vite 对原 public 下四个 JSON 的导入警告与 NO_COLOR/FORCE_COLOR 警告在最终回放保留；未顺带改他人视觉资产。

尚未执行：本机实际受信 HTTPS 浏览器登录、真实 cookie/CSRF/跨身份隔离、C1 运行/停止/未知、历史与公开产物、数据库重启/恢复和 UI-REAL 全 12 项。真实私有访问地址、精确信任、受控凭据通道与新 dist 接入未就绪，只暂停依赖这些条件的现场验证。A 的 HTTP ready 缺口保留。前端改动拟作为 UI 独立交付，不追加到 C 证据 PR，也不混入 A 手册两文件修复。

产品基线及 MVP_SPEC §10：待授权维护者汇总。

## SSH 路线与本机实测（2026-10-14）

负责人先询问本机部署，随后明确决定“用 ssh 连它的电脑，用他的环境”，撤回本机部署路线；未创建本机服务库、签名/TLS 私钥、C1 VM 或安装组件。PAHER Agent 回交专用普通账号 当时受限转发身份、仅公钥认证/仅本地转发到 PAHER loopback 3443，以及待安装本机公钥。该回交是环境资料；实际状态以下述本机检查及后续认证为准。

本机只读核查确认双方当前在同一 /24；当时独立取得的 Ed25519 公钥逐字匹配回交，真实主机指纹由私下材料保留。当时本机客户端 OpenSSH 10.0p2；对端 banner 实际报告 OpenSSH_for_Windows_9.5，未把回交的安装版本当当前服务版本或据此诊断签名缺陷。

原本机 Ed25519 公钥/私钥文件已存在，无需新建凭据；公钥指纹仅在私下材料保留。只读取公钥和文件是否存在，未读私钥正文，ssh-agent 当前无加载身份。主机公钥固定在仓库外本次专用 known_hosts，不改用户全局 SSH 配置或其他 host 记录。

使用已有 identity、BatchMode、StrictHostKeyChecking=yes、精确 Ed25519 host key、ExitOnForwardFailure=yes，显式绑定本机 历史回环入口 的首次 受限转发请求 实测返回 `Permission denied (publickey)`，进程退出 1，隧道未建立。对应远端 authorized_keys 尚空的交接，当前须由 PAHER Agent 安装本机公共钥后重测，不能计认证、转发或 TLS 验收通过。只向负责人提供公钥，不代发送消息给 PAHER。

另保留回交中的节点重启事实：PAHER 现场恢复了 transient VM/应用 unit，当前 readiness、原冻结指纹和恢复代际需再次实核。C 回交的“前端没有 hash 路由”是部署物描述，不能替代当前代码核查；本分支继承的正常 TaskRoute 已存在，本次新增登录也已完成 Chrome 协议验证。远端旧静态目录仍需接收本次新产物；SSH 专用账号禁止 shell/SFTP，不能据此假定已取得部署或秘密领取通道。

最终静态文档检查：79 份、1170 内链、errors=[]；本任务差异空白检查通过。当前交付为独立 UI 分支的本地提交；未推送、未新建 PR、未改原 PR53/55 内容或部署服务。后续按实际认证/信任/产物/凭据渠道分别推进现场验收。

## SSH 连通、用户证书授权与真实页面检查（2026-10-14）

PAHER 安装同一客户端公钥后，本机原命令实际认证并建立 SSH 隧道，监听只在本机 历史回环入口。使用已有私钥由 SSH 客户端完成签名，Agent 未读取/输出其正文；不改服务端身份或放宽转发。未复现远端报告的 host-bound 签名失败，不将其历史诊断写成本机结论。当前路线为同一局域网的 TCP 22 直连，未建立 VPN 或公网映射；跨网络继续使用仍需可达的获准私有入口。

通过固定主机身份的隧道，仅采集公开 TLS 证书、核对 DER SHA256，采集阶段不发 HTTP/凭据、也不记 TLS 信任通过。实际证书为 CA:false 自签叶子，SAN=127.0.0.1/localhost/::1，SHA256 与原交接逐字一致；UTC 有效期 2026-10-13 17:01:01～2026-11-12 17:01:01，即北京时间 2026-10-14 01:01:01～2026-11-13 01:01:01。

之后用该确切公共证书作为本次 Node 请求的 CA、保留严格链/主机名校验，六次公开 GET 通过严格 TLS：首页/live/ready 均 200；Session 与新 Assignment bootstrap 匿名读取均 401 / UNAUTHENTICATED；静态 JS 200。此时未修改 Windows trust，也未登录。原历史 HTTP ready=503 保留，当前本机观察为 200，不从该变化推导运行节点指纹/代际已重新验收。

导入前只读核查确认 CurrentUser Root/TrustedPeople 与 LocalMachine Root 均无同指纹证书。负责人针对精确证书/用户范围确认：“允许，验收后可以不移除，这样后续可以继续使用”。据此只导入 获准 Windows 用户 的 CurrentUser\\Root；Thumbprint=历史指纹私下保留；导入后 CurrentUser Root 存在、LocalMachine Root 仍不存在，按新指令保留不移除。不生成 CA/服务器私钥，不关闭证书校验。[Chrome 官方说明](https://chromium.googlesource.com/chromium/src/+/main/net/data/ssl/chrome_root_store/faq.md#how-does-the-chrome-certificate-verifier-integrate-with-platform-trust-stores-for-local-trust-decisions)说明 TCP TLS 使用 Windows CurrentUser Root 的本机显式信任；该操作影响该用户应用，不限单标签或独立 profile。

随后用已连接的本机 Chrome 实际打开新 Assignment 的浏览器 hash 路由：页面正常加载“循阶”，未出现 TLS interstitial；当前内容却显示“没有找到这个任务”。结合远端实际 bundle 不含本次登录组件，确认服务仍部署旧学生静态产物。此处只通过浏览器 HTTPS 页面读取，不计登录/分配接线、Secure Cookie、学生作品/真实 C1 或完整验收通过。

本次 UI 源码本地提交为 eaadb17199226aea3feaf9b6393118cf70bd57e0，正常构建的独立 ZIP 为 ui55-eaadb17-dist.zip，143 个静态文件、5628012 字节、SHA256=bee3be5c02638acb8e6e04a5abc2a2807f761088ff09617abddb3d0efd8a2278；新 bundle 含已验证的原工作区登录组件。包仅是本次学生 dist，不含数据库/凭据/后端。公开源码补丁与部署包保留在本机交接目录，未公开推送或通过隧道上传。

实际部署仍须 PAHER 的维护 Agent 将该包解压到独立新静态目录，基于当前受控配置新建仅 staticDirectory 不同的配置，正常切换本人应用并保留旧目录/配置用于回退；本机 tunnel-only 身份无 shell/SFTP，不能代执行部署或读取 initializer。秘密领取渠道仍未落实；当前不在聊天获取/输出密码，也不将 root-only 内存引用冒充跨机浏览器授权。

本轮原始非秘密记录：[严格公开 GET](evidence/i0-ui55-browser/strict-public-probe-20261014.json)、[精确用户证书信任](evidence/i0-ui55-browser/certificate-trust-20261014.json)、[UI 产物摘要](evidence/i0-ui55-browser/ui-dist-manifest-eaadb17.json)。保留 SSH 隧道供本轮继续联调，无新增开机启动/计划任务。前端 ZIP 与准确部署提示词已准备交负责人转交，尚未通过 SSH 上传或在 PAHER 部署。

本轮文档检查 79 份/1173 内链，errors=[]。首次暂存空白检查发现两份本次 PowerShell JSON 的 CRLF 被标为 trailing whitespace，公开副本仅转 LF 并核解析前后值相等；本机原始字节保留，未改摘要字段或 zip。最终本次空白检查通过，代码/协议未变化，不重复单位/浏览器全套测试。

## 无需远端静态部署的本机接线提案（2026-10-14）

负责人要求直接完成、减少手动转交，并澄清 PAHER Agent 是另一台电脑上的 DeepSeek Harness，不是本机 Codex chat。当前 SSH 身份仍只获准转发，不能借其他账号、shell/SFTP 或接口漏洞绕过限制。本机另一个“实现登录与会话进入流程”聊天正在实施完整 UI，当前仅只读了解其交付状态，不复制其未提交文件、不发送未授权消息。

为浏览器接线验收而先部署 PAHER 静态目录并非必需。方案改为本机 Node HTTPS gateway：在原浏览器 origin `历史回环入口` 只读提供已验证的正常学生 dist；`/api` 与 `/health` 经本机另一个 SSH 转发端口 14443 接 PAHER 原 历史回环入口。backend TLS 固定原证书、严格链/名称/指纹校验。Origin、CSRF、Cookie、方法、正文、状态与流保持原值；只剔除逐跳 HTTP header，不改角色、契约或拒绝结果。该方案没有 fixture、模型替身、执行器替身、数据库或新的远端通道，PAHER 原网站仍保持原部署状态。

适用依据补读 TECH_DESIGN §9 的同源 HTTPS/受信代理要求及实际 access/app.ts 的 Origin/CSRF 正文。可写新增 `tools/i0-ui55/local-ui-gateway.mjs` 与其必要边界/转发测试、本人任务记录和学生使用说明；所有现有后台、产品/规划/参考、规范及并行 UI 文件只读。程序准备与离线验证属于本次明确的直接接线任务，**启动代理、新建本机 TLS 私钥及导入其证书仍是待批准对象**，不以代码完成代替批准。

精确待批准本机对象：仓库外 `<仓库外私下路径>`；只为本机 历史回环入口 新建一对 RSA2048 TLS 叶子证书/私钥（CA:false，SAN 127.0.0.1/localhost/::1、serverAuth、30 天），私钥限获准用户/SYSTEM/Administrators；只将本次确切新公共证书导入获准用户的 CurrentUser Root，不动 LocalMachine、不复制 PAHER 私钥、不修改 .env/CI。原 PAHER 公开证书继续作为 backend 唯一 CA/pin。既有 SSH 改本机监听端口 14443 时保持原服务端 destination、身份和 host pin，确认新转发后才结束本任务原客户端。无新增依赖或 VM。

凭据仍是独立必要条件：目前只知道 root-only initializer 引用，没有获得跨机浏览器领取授权或实际密码。若负责人已有批准渠道领取的学生账号，由其直接在可信浏览器输入，Agent 不在聊天/日志获取口令；若没有，则只暂停真实登录以后的验证，不假造会话或把 gateway 当凭据渠道。代理验证与 PAHER 真正部署、完整身份/运行验收分别记录。

## 本机长期工具包与已批准 TLS 实现（2026-10-14）

负责人要求相关工具留在本机、留下入口与使用方法，并已批准精确的本机 TLS 对象范围。据此把上节提案做成可长期保留、可再次使用的工具包，并实施该已批准范围。工作目录为仓库外 `<仓库外私下路径>`；本阶段不改产品/规划/参考/规范，不推送、不提交、不改原 PR53/55，主工作区 `<仓库外私下路径>` 的并行改动未触碰。

入口与内容：统一入口 `xunjie-ui55.ps1`（`help`/`setup`/`start`/`status`/`check`/`stop`，`start -LocalOnly` 为无隧道离线自检），中文说明 `README.zh-CN.md`，可执行源码快照 `tools\i0-ui55\`（`local-ui-gateway.mjs`、`local-ui-gateway.test.mjs`、`source-manifest.json`），机器配置/私钥/状态/日志只在 `local-relay\`，学生产物解压到 `dist\eaadb17\`。源码快照来源为本分支 `d39d7c2` 下未提交的 `tools/i0-ui55` 两文件，摘要记入 `source-manifest.json`，`check` 逐文件核对。既有 ZIP、补丁、host pin、PAHER 公开证书、部署提示词与旧证据原样保留，未新增依赖：仅引用已存在的 `<仓库外私下路径>`、`<仓库外私下路径>` 与 WSL Ubuntu openssl（本机实测 3.0.13；不可用时回退已核对的 msys64 openssl）。

已实施的精确批准对象：`local-relay\` 目录先建再设 ACL（仅 `获准本机用户`/`SYSTEM`/`Administrators`，去继承），随后用 openssl 生成 RSA2048/SHA256/30 天、`CA:FALSE`、SAN `localhost`+`127.0.0.1`+`::1`、`serverAuth` 的自签叶子，私钥文件 ACL 同样限定三主体；只把这一个确切公共证书导入获准用户 的 `CurrentUser\Root`。实测公开事实：叶子 `SHA256=历史指纹私下保留`、Thumbprint `历史指纹私下保留`、有效期 UTC 2026-10-14T08:56:31Z～2026-11-13T08:56:31Z；导入后 `CurrentUser\Root` 存在、`LocalMachine\Root` 不存在；未生成 CA、未读/输出私钥正文、未复制 PAHER 私钥、未改 `.env`/CI。`setup` 对已存在证书只核对不替换，文档明确到期后须对新证书对象另行授权。

验证结果（本机，Node 24.15.0）：网关离线单元/路径/转发边界测试仓库副本与持久快照各 3/3 通过；`check` 在 `-LocalOnly` 下 13 项通过、0 失败（含叶子参数、私钥与目录 ACL、`CurrentUser\Root` 唯一信任、SSH 主机/客户端公钥指纹、上游证书指纹、3443 归属本工具、经 Windows 信任链的 TLS 与 `GET /` 200）；无隧道时 `/api/session` 与 `/health/live` 均 502，不做 fixture 回退。生命周期安全实测：3443 被占用时 `start` 停止本次启动、占用者存活、退出码 1；`stop` 对 PID 复用（启动 Ticks 不符）与命令行不符两种情况均拒绝终止、保留记录并退出 1，进程退出后再 `stop` 清空记录并退出 0；正常 `start -LocalOnly` → `status` 归属通过 → `stop` 终止并释放 3443/14443。真实 `start`（含 SSH）在本阶段未建立隧道，失败后无残留监听、无残留进程、状态为空。

验证中发现并修复的工具缺陷（均属本阶段新增脚本）：SAN 前缀只匹配 .NET 写法而漏掉 openssl 的 `DNS:`/`IP Address:` 写法；分发处用赋值接收动词输出导致 `setup`/`status` 输出被吞；局部变量 `$home` 与只读自动变量冲突；`ConvertFrom-Json` 把 ISO 时间字符串转成 `[datetime]` 致 PID 复用判定误报（改为比较启动 Ticks）；`stop` 拒绝分支未真正保留记录。网关 `local-ui-gateway.mjs` 复审未发现需要相称修补的明显遗漏，未改动其源码。

**未执行**：PAHER 跨机真实链路（HTTPS 登录、Secure Cookie/CSRF、C1 运行与取消恢复、历史与公开产物、UI-REAL 全项）与浏览器登录验收。原因是本机当前到 `历史内网地址` 的路由被 当时 VPN 隧道接管：WLAN 邻居表 Incomplete、ping 超时、TCP 22 只得到 `kex_exchange_identification: Connection closed by remote host`，即请求并未真正到达 PAHER。本机 `-LocalOnly` 的 200 只证明本机静态/TLS 与信任，不表示登录、C1 或完整产品验收通过；无隧道时的 502 也不作为真实验收。本阶段没有观察到上游 `401`，因为请求未能到达 PAHER。

本阶段改动文件：`tools/i0-ui55/local-ui-gateway.mjs`、`tools/i0-ui55/local-ui-gateway.test.mjs`（均为上一轮新增、本阶段复审未改）、`docs/tasks/I0-UI55_BROWSER_ENTRY.md`、`apps/student/README.md`，以及仓库外 `<仓库外私下路径>` 下的 `xunjie-ui55.ps1`、`README.zh-CN.md`、`tools\i0-ui55\source-manifest.json`、`local-relay\*`、`dist\eaadb17\*`。最终检查：`node tools/a0-review/check.mjs` 为 79 份文档、1173 内链、`errors:[]`；`git diff --check` 空白检查通过；本分支仍是未推送的本地改动，未新增提交。

## 工具复核与收口范围（2026-10-14）

本节接续长期工具包交付，不扩大远端权限。复核发现：健康探测把任何 HTTP 状态都记为通过，进程命令行不可读时仍准许终止，ACL 检查只排除少数英文主体，以及替换 dist 后状态仍引用固定旧产物。修正限定在本机工具、必要边界验证与本人文档；使用实际配置和产物摘要核对当前静态目录，公开探测只读取响应头，健康失败/未执行分别报告，进程与 ACL 归属不明时拒绝通过。机器文件仍仅留在批准的本机目录，不修改现有证书/私钥、远端服务或并行 UI。

网络判断纠正：目前实测 SSH 在密钥交换前被关闭，选中路由位于 iKuuuVPN，WLAN 邻居为 Incomplete；这些现象只能支持网络路径存在疑点，不能证明请求一定未到达 PAHER，也不能单独排除 PAHER 离线或防火墙拒绝。没有修改 VPN、路由或防火墙。负责人已允许开发合成账号密码通过私人聊天；当前缺口是尚未获得密码及远端命令能力，不再把聊天渠道本身列为禁止条件。

收口实现：持久入口的 `check` 对健康只接受 200，存在未执行项返回 2、失败返回 1；公开 GET 使用 `ResponseHeadersRead`，不缓存正文或自动附 Cookie/跟随重定向；ACL 逐 SID 验证仅当前用户/SYSTEM/Administrators、禁继承；归属验证要求可读且匹配的命令行和启动时间。`active-dist.json` 引用当前产物清单，与 `gateway.config.json` 的实际静态目录逐文件比较 ZIP 摘要，替换新构建后不再引用固定旧版本。入口与三份保留工具也纳入源摘要；现有证书/私钥未更换，叶子已有元数据不再被重复 setup 覆写。新增源码负例保存在 `tools/i0-ui55/local-entry.test.ps1`，持久副本位于本机工具根；团队使用说明改为仓库相对链接，不以个人目录作为共享开工前置。

实际验证：入口语法通过；旧入口的隔离负例验证 退出 0，进程归属（不可读命令/不符/PID复用）、ACL（额外SID/缺项）、新配置静态目录及相同文件数但字节变化、HTTP 503 响应头而正文永不结束四组通过。最终 `LocalOnly` 的 `check` 为 13 通过/0 失败/3 未执行，明确原生退出码 2；Windows 信任链及当前静态根 GET 200 通过，真实 Session/live/ready 未运行。本机 Chrome 实际显示原工作区“不可用/会话没有读取成功”，无 TLS interstitial、无登录提交，不算 PAHER 验收。测试后 `stop` 退出 0，只终止本人网关并释放 3443/14443，保留全部工具、包、证书和信任。

负责人补充 PAHER 曾重启，并随后要求重测恢复情况；再次普通严格 host pin SSH 在握手前被关闭，指定本机 WLAN 源地址 历史内网地址 时 TCP 22 超时。未建立 SSH 会话，未读取 initializer 或执行远端命令。已请求实际重启后的 IPv4 与 sshd 状态，负责人正在核对；不将其推测“应该恢复”记为已验证。

负责人进一步要求直接 SSH 维护，并要求提供一次性设置提示词和完整回交字段。已保留本机 `PAHER_SSH_MAINTENANCE_PROMPT.txt`：在保留原 tunnel 身份限制的同时，为现有 WSL 拥有者账号提议指定公钥、单一来源、exec/SFTP、专属授权文件、有效配置核对与回退；一并核对原开发环境、公开 TLS、当前任务引用，并提供仅指定合成学生的现有凭据读取命令。提示词仍待 PAHER 侧实施与本机严格认证验收，不冒充已建立维护通道；未向远端 Agent 自动发消息、未改远端 SSH 配置或账户。

## 已接通维护通道与正式 UI 消费（2026-10-14）

PAHER 的正式回交由用户提供，包含网络、两个账号的有效配置与指定学生的凭据读取命令；用户允许适当使用子 Agent 加快独立工作。本人本机实测：普通 SSH 与指定 WLAN 源地址两条路径均以原公钥完成认证、原 Ed25519 主机指纹匹配；当时受限转发身份 仍固定 echo，维护身份实际核对通过，SFTP 取回非秘密交接 JSON 退出 0，WSL 中原应用与 C1 VM 单元均 active。本机严格 TLS gateway 的 root/live 为 200、匿名 Session 为 401、HTTP ready 为 503，后者不改贴通过。原私钥/证书/数据库/代际没有更换。

正式登录交付已在另一任务提交，故本次不再扩展本人原内容区登录原型，改为消费其已提交实际 UI：Auth `ba89fe0f09432457e793ac92b276547700aa82ab`，冻结树 `40db96cc8fb5f377f9c4b38e841a3b559b849c7a`。新 managed worktree `i0-ui55-auth-acceptance` 从该树构建，主目录正在进行的保存/恢复未提交内容只读、不导入。依赖 lock/package 相同，普通复制隔离依赖，无 junction；Node24.15 typecheck/build 退出0，正式143文件 ZIP逐项摘要与静态目录相符，准备/凭据/数据库/私钥边界扫描通过。producer 的全量175/176与修复分支29/29仍按原事实，不改成176/176。本机新包和旧包均保留。

本轮可维护本人工具、真实接线证据和本记录；可以切换已批准本机 gateway 的 staticDirectory/当前清单并启停本工具自身进程。登录只使用已获准 `synthetic-i0-student-a` 的既有密码，由 root-only 现有读取器经维护 SSH 在内存取得；不写代码、文件、诊断或公开证据。实际浏览器仍绑定原 origin、Secure Session/CSRF 与获准深链。读到缺口保持未知，不单方修 A 的固定 health 装配、变更 C1/数据库/冻结代际；远端 dirty checkout 保留只读。

## 当前真实浏览器反馈与 C1 恢复提案（2026-10-14）

本机已切换到 `40db96c` 的正式学生 UI，ZIP SHA256 `a1b63e0362041a0db8f713a3f45ca37373014c7eec683b0e3ad777919c2fc09b`，143 文件、5630300 字节，逐文件对应实际静态目录。现有同源 gateway、既有 SSH 身份/主机 pin 和两端严格 TLS 保持原批准范围；没有给远端旧静态目录写文件。

真实 Chrome 两次完成指定合成学生的登录，Session 重读后显示实际账号与“真实分配”，首次明确点击“开始 Attempt”后读回原确认作品 v7、快照 v7、两个文件与既有本机草稿；后一次登录自动恢复同一既有工作区。随后页面均退回“登录已失效，请重新登录”，因此目前只记录成功读取的瞬时观察，**会话持续有效、刷新/退出/重进验收尚未通过**。本轮截图实际捕获失效后的登录页，不能作为稳定工作区通过证据。没有执行编辑、确认保存、新建文件、Run、Stop、模型求助或历史结果写入。

凭据从获准远端读取器进入本机维护工具内存，再用浏览器操作进程临时 RSA 公钥封装，只有该进程内存私钥解封后填入原登录表单；输出只包含账号与密文，明文不落盘、不进命令/记录。此临时加密通道不新增任何服务身份或证书信任。会话问题的排查仅新增本机最小反馈环与公开结果：允许正常登录创建 Session，以及读取获准 Assignment/Attempt；不修改 UI Auth 模块、服务 TTL、数据库、认证规则或 C1。已委派独立只读诊断，根因待反馈环证据确认。

C1 经实际归档 RunnerTransport 的 `op=readiness` 读取：`ready=false`，`readRuntime` 原样拒绝 `RUNTIME_NOT_READY`；应用与节点 recoveryGeneration 一致。与历史正式验证相比，唯一指纹差异为内核 `6.8.0-146-generic` → `6.8.0-147-generic`，Node/Engine/cgroup/seccomp/profile/sourceHash 相同，历史验证本身仍保留。只读核查确认原 146 内核及 initrd 安装且为普通文件，GRUB 具有对应正常菜单项；VM 启动使用 `-no-reboot`，不能把 guest reboot 当作自动恢复完成。

当前只准备一次选择原已验证内核的维护提案；其 GRUB 写入/guest 停机或重启/原 VM 单元恢复须有覆盖这些对象的明确确认后才能执行。没有改永久默认内核、validation、代际、数据库或服务配置，没有以修改指纹或补写验证记录绕过门禁，也没有运行会改变 generation 的完整 acceptance 套件。原宿主 `GET /health/ready` 的固定 503 与节点真实 readiness 是两项独立缺口，继续分开记录。

负责人随后明确批准上述精确恢复与限定回退：只读合成库/节点全局工作状态前置；备份并仅写一次原 146 菜单的 next_entry；正常关闭并启动同一 VM；核验原 readiness、指纹、代际和验证记录。若 146 已启动但仍不匹配，允许同样一次启动现有 147 后停止验收。授权不包括永久内核默认值、应用配置/代码、schema、认证、validation/代际、强杀 QEMU 或删除 socket。实施期间本浏览器不发运行/保存，Session 排查只做正常登录与获准只读请求。

Session 最小 HTTP 反馈环已真实执行一次：同一严格 HTTPS gateway，登录 200，初始 Session/bootstrap/Activity/Attempt 均 200，后续约几十秒内连续 `401 / UNAUTHENTICATED`，31 秒、15 轮，原生退出 1。它确认问题不只是浏览器显示，具体失效原因仍待最小 Session-only 环与公开到期/时钟证据确认；所有 Cookie/口令/CSRF 只留进程内存，不写捕获文件。

本轮可共享原始证据：[恢复前 C1 公开投影](evidence/i0-ui55-browser/c1-readiness-before-restore-20261014.json)、[浏览器会话失效截图](evidence/i0-ui55-browser/browser-session-expired-20261014.jpg)。截图仅作为真实失败反馈，不标记 UI-REAL 通过。

## 现场恢复结果与会话诊断收口（2026-10-14）

已批准 C1 维护的全局前置：合成库 pending Job=0；节点完整 ledger 中 reserved/pending/nonterminal=0、原活动 job/hdl 单元=0、运行容器=0。新 root-only grubenv 备份后，仅写一次原 146 正常菜单 next_entry，三次确认 idle 后正常 poweroff 原 guest。原 QEMU 已退出、2222 关闭且 transient unit 被回收。本人启动调用被新增的 group-write 检查阻止，未执行 start；随后观察到同一原 VM 被另一恢复机制启动，启动来源尚未确认，因此没有重复启动或改已有权限。恢复效果以实际观测为准，不把未执行的 start 记成本人成功动作。

主 Agent 在 `2026-10-14T10:50:29.894Z` 独立执行持久 `Read-C1Readiness.ps1`，原生退出 0：kernel=`6.8.0-146-generic`，ready=true，currentFingerprintHash 与原 validationFingerprintHash 均为 `b07cddf90498f8d537a24e7ad827d68109544437f30e0147eae715a39982d29a`，differences=[]；原 recoveryGeneration、profile/images/sourceHash、validatedAt=`2026-10-13T09:29:47.600Z` 不变，原 readRuntime 成功。没有重新写验证记录或运行完整 acceptance。永久 GRUB 默认仍为 0，此一次恢复不保证下次重启仍选 146。

会话最小反馈环两轮真实 RED：仅正常 POST login → GET Session 即可在约 8.2 秒/十余秒复现 200→401；另一轮 21.7 秒 GREEN 未做修复，说明有时序性，不能宣称问题已解决。[公开诊断证据](evidence/i0-ui55-browser/session-clock-diagnosis-20261014.json)保留成功/失败及未知。独立 WSL 采样捕获 CLOCK_REALTIME 倒退 2902.95974ms，单调时间仍前进。Session 未被撤销、用户未禁用、8 小时/30 分钟有效期尚有余量，应用 PID/启动时间未变。实际 Auth 使用 `Date.now`，保留 created/last_active 不得在未来的判据；401 瞬间 SQL 谓词未同步捕获，不把方向性证据写成完整瞬间证明。

只读环境事实：PAHER Windows W32Time 为 Stopped/Manual、现有源 time.windows.com；相对本机时间快约 17.6～18.8 秒。WSL timesyncd active、NTP synchronized、32 秒轮询，观察到约 -2.396 秒 offset。已准备并请求精确 Windows 校时确认：启动现有 W32Time 并保留原 Manual/时间源，一次 resync，观察两轮现有 WSL 同步后核验 90 秒时钟和 Session。**本节写入时确认仍待回复，校时未执行**；不改 TTL、未来时间拒绝判据、应用/数据库/签名、WSL 重启或 C1 配置。

相关工具均保留本机入口：`xunjie-ui55.ps1`、`xunjie-paher.ps1`、`seal-student-credential.ps1`、C1 只读脚本、`diagnose-session-liveness.ps1` 与 `diagnose-paher-clock.ps1`。共享工具七份源码和说明、两个持久入口及说明/C1 只读入口均纳入 SHA256 检查。工具实际 check 为 15 通过、1 失败、0 未执行，退出 1；唯一失败是宿主 ready 503。凭据加密入口新增五组 private/mixed/weak 等负例通过，不联网/读真实凭据；维护/加密/本机入口 PS 解析通过。Session 诊断入口后续修正为任何非 200 或无有效 data 的读取都不会报 GREEN；协议/依赖未知退出 2，真实 UNAUTHENTICATED 退出 1，语法通过，当前 SHA256=`632f1698b0b01820ae9218da1d313cf0b46b31129a14a65c2af5b0414787fc34`。旧诊断证据中原脚本摘要按历史保留。

新交付工作树已核定 40db96c 正式 UI 代码无差异；本人早期 eaadb17/d39d7c2 分支及旧包保留用于追溯，不混入本次工具交付。尚未公开推送/新建 PR/合并，实际浏览器 Run/Stop/历史及全产品/教学验收均未通过。产品基线和 MVP_SPEC §10 仍待授权维护者汇总。

工具交付树阶段检查：`node tools/a0-review/check.mjs` 为 80 份文档/1178 内链，errors=[]；工作区及暂存 `git diff --check` 退出 0。仅工具/任务记录/公开证据及学生 README 本次 7 行有差异，不重跑未变化的完整 UI 测试。Windows 校时确认仍待回复时，只暂停该写动作与依赖的现场浏览器验收。

## 已批准 Windows 时间维护的实际失败（2026-10-14）

负责人明确批准精确 Windows 时间服务/一次校时范围后，已通过维护 SSH 启动既有 W32Time，并保留 Running / 原 Manual、原 time.windows.com 配置；只执行一次 resync。实际未同步：公开输出报告没有可用时间数据，后续严格读取的 Leap Indicator=3、上次同步错误=1，Windows 相对本机仍快约 15.6 秒。原生调用退出 0 不能覆盖这些失败证据，初版操作结果仅按 exitcode 给出的 success=true 已在独立 assessment 明确纠正并保留历史。没有依赖错误通过状态执行新的 90 秒 Session 登录回归。

该已批准步骤没有改 NTP 源/注册表、WSL 同步服务/clocksource、应用或 Session TTL/未来时间判据/签名，也没有重启 C1/Windows/WSL。下一步只读核对原时间源与 WSL 已在用时间源的可达性，并准备具体配置差异；更换 Windows 同步源不在上次“原时间源不改”的批准范围内，不能据此自动实施。原浏览器仍处失效表单，Run/Stop/历史现场验收继续暂停，保留工具与全部原状态。

可共享当前正式构建与恢复结果：[40db96c 构建摘要](evidence/i0-ui55-browser/ui-dist-manifest-40db96c.json)、[C1 实际恢复记录](evidence/i0-ui55-browser/c1-frozen-boot-restore-result-20261014.json)。C1 ready 通过与 Windows 校时失败继续分别记账。

后续只读可达检查：原时间源 `time.windows.com` 在 Windows 3/3 超时；WSL 已用的 `ntp.ubuntu.com` 同机 3/3 收到 NTP 响应，且地址同为 185.125.190.57。依据 [Microsoft W32Time 官方说明](https://learn.microsoft.com/en-us/windows-server/networking/windows-time-service/windows-time-service-tools-and-settings)，stripchart 使用临时 UDP 源端口，不能替代服务本身同步成功。实际 [失败 assessment](evidence/i0-ui55-browser/paher-time-correction-assessment-20261014.json)及[单字段替代源提案](evidence/i0-ui55-browser/paher-time-source-fallback-proposal-20261014.json)保留。

负责人已明确批准替代源与限定回退：仅 NtpServer 改为 `ntp.ubuntu.com,0x9`，通知原运行服务更新并再同步一次；其他 provider/Type/Manual 设置不改，失败只回退原字段。执行成功后要求 90 秒 Session/时钟验证，以及实际 WSL 两轮同步观察。此时 WSL 轮询已变为 128 秒，90 秒不能表述为两轮 NTP；执行与验证结果待现场记录。

## H-04 客户端窄接线方案与实施范围（2026-10-14）

替代源实际同步成功，Leap=0/同步错误=0，原 Manual/Type/provider 不变；90 秒实际时钟无倒退，正常登录后 91 次 Session GET 均 200。真实 Chrome 持续读回固定活动/身份/材料及 v7 工作区，公开材料可见，私有材料按 redacted 裁剪。Core 提交前被客户端旧 H-04 门禁挡住：`useRunWorkspace.ts` 只验证 preparation，real 永远 false；`RunWorkspace.run` 在 freeze/outbox/POST 前发布“运行环境尚未就绪”，不是本次 backend/C1 就绪失败。

为完成用户已要求的 Robert/UI 真实接线，现进入同一任务的窄运行适配；不新增共享 wire/端点或页面，不单方修改后台门禁。补读客户端约束 §8、I0-B_REAL_ENTRY 的原 bootstrap 代际来源及现有 Run 客户端正文。服务端依据已核实际 9fa76ad：workspace/application.ts:169～188 对新 Run 每次 queryRuntime 并与固定活动完整 profile 匹配；commands.ts:154～155 在构造 Job/Run 前拒绝 ready/profile/代际不符；design/readiness.ts:9～23 核原 readRuntime/指纹/sourceHash/验证日期，main.ts:31～36 核节点代际，main.ts:47 原 consumer 持续消费。当前原宿主 queryRuntime 实测成功；consumerInterval=250，应用原 PID 保持 active。

可写范围只增加 `apps/student/src/workspace/useRunWorkspace.ts`、`runWorkspace.ts` 及必要调用方/窄回归测试和本记录。方案将本机运行资格来源区分为 preparation 的原 verified 与真实服务的 server-on-command；真实客户端只使用 Session/bootstrap 已核身份/代际及固定活动 profile，并把每次节点就绪判定交原 POST Run 服务端。不能把 mode=real 或活动版本写成“当前 C1 已验证”，不能硬编码 ready/代际、创建新 API、跳过服务端/原命令回执/CSRF/authority 守卫。准备模式原反例及代际不符仍拒绝。验证为原假设复现→窄单位/协议反例→typecheck/build→严格实服务 Chrome Core，失败/未执行分别记账。A/C/产品/规划/规范、当前主目录保存任务和正式 Auth 模块继续只读。

## 本批最终工程与真实浏览器结果（2026-10-14）

Windows 替代源维护实际 config/resync 各一次，成功时 Leap=0/LastSyncError=0；两个更早的工具传输失败发生在任何原生操作之前，未重复校时。W32Time 保持 Running/Manual、`ntp.ubuntu.com,0x9`，其他 provider 不变，未使用回退。90 秒采样 1794 次无倒退；一次正常登录及 91 次 Session GET 全 200，登录至最后 GET 93.017 秒。随后按实际 WSL packet count 206→207→208 完成两轮同步观察（869.08 秒），第二次同步周围 240 秒/4783 次时钟采样无倒退。最终 Windows 全局 LastSyncError=2（仅陈旧时间数据），peer error=0；不把早先成功写成当前 Windows 无错误，不追加未批准配置。Windows 相对本机的 18 秒偏差不能单独证明绝对 UTC 错误。[完整去敏结果](evidence/i0-ui55-browser/paher-time-source-completion-20261014.json)保留这些边界，时间工具和独立 22 文件清单留在本机。

H-04 改动只在两个生产文件（16 行新增、5 行替换）及 `runWorkspace.test.ts`、`e2e/real-mode.spec.ts`。实际 hook 调用链先 RED（预期一次 POST、实际零次，旧本机 readiness 提示），同例修复后 GREEN。相关单位 13/13，Chrome 协议/准备态窄回归 4/4，browser/Node typecheck 与正常 build 退出 0。包括 server `422/RUNTIME_NOT_READY`、请求先落盘、丢 ACK 保留原命令且不自动重发、准备态拒绝和错配代际/profile；没有新 wire/依赖、Auth/消费者/后台改动。协议替身不计实际 TLS/C1。原 build 大 chunk 警告保留，两个测试类型/工作目录错误已修正并记录。[诊断与验证](evidence/i0-ui55-browser/core-run-readiness-diagnosis-20261014.json)。

实际切换只停止本工具自身网关/SSH，更新本机 staticDirectory/active manifest，再正常启动；不写远端静态目录或重启 PAHER 应用。新包 `ui55-h04-20261014-dist.zip` 为 143 文件、5630401 字节、SHA256=`ae32744ec6f1e7d0f21094698df81e91f7c5b4bdd9d0cbfe2efedfa552f19a08`；入口 `/assets/index-BqhBrous.js`，SHA256=`b52b0e8d1b48cf29375c2dfb5d6eca917b1620b39d6db5ee717704e50aa10383`。构建时两个生产文件尚未提交，清单明确 sourceDirty；最终提交关联须按两份原文 SHA 核对后补记，不用新 commit 冒充重新构建。打包脚本曾复用 entry 变量将清单入口写成最后 ZIP entry 对象，已核 index/JS 原摘要并改正字段，ZIP/dist 不变；前置参数校验失败和该纠正均保留本机说明。

真实 Chrome 使用原 Secure Session、原同源 CSRF、固定 Assignment/Activity/Attempt 与 C1，未拦截请求或回退 fixture：

| 现场操作 | 实际结果与证据 |
| --- | --- |
| 登录、获准深链与资料 | 实际指定学生/课程、Assignment revision=3/active、公开材料与 private redacted；[资料截图](evidence/i0-ui55-browser/browser-task-read-20261014.jpg) |
| 原作品、刷新、退出、重新登录 | 原 v7/快照 v7、main.c 文件 v5 与本机草稿恢复；退出后受保护编辑器消失并显示“已退出登录”，重新登录读回原 v7，不自动保存/冻结/运行；[退出截图](evidence/i0-ui55-browser/browser-logout-20261014.jpg) |
| Core v7 | Run `0af5cb6e-61d6-4ab3-b4d5-54880795a4f2` / Job `c8378481-c796-4070-ba57-593ad88c3f8e` / snapshot `f714ae74-f53f-4838-ba54-5245c67eeb6b`；succeeded、stdout=`new snapshot`、stderr 空；[真实输出](evidence/i0-ui55-browser/browser-core-c1-success-20261014.jpg) |
| Core v4 超时 | Run `7675eb71-328f-4b66-b1a3-9ee96d5a78d6` / Job `32939ee2-cf55-4b47-ad0e-97be64bf90ee`；Job succeeded 但程序 failureKind=timeout，UI明确“运行完成·程序超时”，不计 C 程序正常完成；首次 Stop 点击前已终态，未发送取消；[超时截图](evidence/i0-ui55-browser/browser-core-timeout-20261014.jpg) |
| 另一原 v4 作业 Stop | Run `20c84ee2-ffaa-4b50-982b-e12542bcdf78` / Job `39ed2d94-039a-4e57-8bb6-8b33d47b9bf2`；控件可见后显式一次取消，原回执及进度确认 cancelled；[停止截图](evidence/i0-ui55-browser/browser-core-stop-20261014.jpg) |
| 历史比较及产物缺口 | 刷新/重新登录后原 Run/Job/snapshot/hash/profile/image 与本机参数仍对应；旧产物 unavailable，新 v7 未生成 report.txt 因而 missing，无正文/下载；[历史截图](evidence/i0-ui55-browser/browser-history-c1-20261014.jpg)。当前活动未交 Report 能力，不能用旧 Report 参数补发或新增界面 |

v4 切换快照后入口与输入按原 UI 重置，一次 disabled 点击未提交；选回原 main.c/input.txt 才发 Run。超时前短暂“结果未知”如实等待原进度，没有把 Stop 点击失败写成已停，也没有以未知重发；用于 Stop 的下一次新 Run 在前一终态之后明确发起。

独立只读 SQL 投影核原 4→7 项、全部 Job/Run/snapshot/G/profile/创建回执关联一致，当前 queued/running/cancelling/outcome_unknown=0。Stop 原回执 `3826d44e-ecb6-4933-8976-7c604d0a354b` seq107 后原进度 seq112 确认 cancelled；[服务端去敏投影](evidence/i0-ui55-browser/browser-run-server-projection-20261014.json)。重新登录后历史中的原 v7 stdout 仍读回 `new snapshot`。新静态包逐文件清单见 [H-04 产物](evidence/i0-ui55-browser/ui-dist-manifest-h04-20261014.json)。最终持久 `check` 为 15 通过/1 失败/0 未执行，退出 1，唯一失败仍为原 HTTP ready=503；不关闭检查或改状态。

原任务是 comment 的精确信任/接线与浏览器验收，本批完成上述获准现有链，不宣称 [UI-REAL 全 12 项](https://github.com/paher-din/XunJie/blob/33a68baba5005c9a6433ed2bf9c99f01d89345b6/docs/tasks/I0_REMAINING_WORK_CHECKLIST.md#3-ui-real按ac交接分批接入的12项)。首次新 Attempt、缺代际零写、确认保存/新增冻结、暂停/终态/撤权、第二合成账号/迟到响应、正向公开产物下载、真实丢 ACK/旧代际/恢复故障仍未在该 PAHER 浏览器批次全部执行；前端原协议检查与 C 旧服务端20项不替这些现场项。HTTP ready 503、Windows后续 LastSyncError=2、一次内核选择与未知 VM 自动启动来源保持独立未完成记录。没有真人输入、模型调用、全产品/G0～G4/教学效果通过或 Issue 关闭。

旧长期连接和维护入口已退役；当时的工具、专项说明与原验证记录按历史保留，当前连接步骤由负责人私下交接。现场候选 `codex/i0-ui55-local-tools` 仅留本地；共享交付来源仍见下节。产品基线与 MVP_SPEC §10 待授权维护者汇总。

## 并行正式运行交付接纳与共享写集收口（2026-10-14）

收口时实时读回 [PR66](https://github.com/paher-din/XunJie/pull/66) 已于 20:13 合入，main=`5c8c60ec93e00bc1782a534a88b696ae98c76c37`。该任务提供正式客户端同源 `/health/ready` 前置及 A 原宿主装配，另含实际 HTTPS/SQLite 的隔离 transport 证据；本任务不重审或重复这些已交付工作。原 PAHER 运行源仍为 `9fa76ad`，HTTP ready 固定503，不能拿当前候选 Run 通过宣称已部署/验收新 PR66，也不能在 gateway 伪造健康或把节点 ready 等同于该 HTTP 条件。

本批候选客户端与上述正式健康前置是两种实现，保留候选本地 commit/源码包/ZIP/逐文件清单作为历史 C1 现场证据；**生产文件与窄测试不进入本次共享 PR**。没有覆盖/回退另一任务文件、修改正式门禁、部署新后台或新增运行接口。新 managed worktree 从上述固定 main 取正式源码，只移入本人工具、证据、任务记录和 README 导航；无需为未改正式源码重跑全量测试。当前长期入口仍指向明确标记的旧宿主现场候选；后续同步最新正式 UI/宿主与固定 C1 的验证另列，不把历史包写成最新应用交付。

可写最终集合：`tools/i0-ui55/**` 七份源/说明、`docs/tasks/I0-UI55_BROWSER_ENTRY.md`、该任务公开证据、根 README 导航一行、学生 README 接线说明。正式 UI/后台/产品/规划/参考/规范继续零本批差异；本人旧候选 commit 未公开推送。

最终共享树静态检查 86 份文档/1281 内链、errors=[]，差异空白检查通过；七份共享工具与本机快照 SHA256 全部一致，公开 JSON 的密码/签名/私钥/Session 值字段扫描零命中。本地候选两份生产源码的 SHA256 与已提交原 blob 字节分别核对一致，产物清单补映射到 `79f9037` 并保留构建时 dirty 事实；`ui55-h04-local-candidate.patch` 留本机，反向 apply-check 通过。当前候选及工具/证据分别提交，不把本地快照记录成公开推送、合并或最新应用部署。

## 公开交付回执（2026-10-14）

共享实现/证据提交 `eec412ad9b8620d9febb1071b1d03499a30b1e07` 已普通推送 `codex/i0-ui55-tools-evidence`，并创建 [草稿 PR67](https://github.com/paher-din/XunJie/pull/67)，base=main/`5c8c60e`。实时 API 回读 head 一致、Open/Draft、30 文件、mergeable=true，已附当前任务；这些只证明交付，不表示评审/CI/合并或部署。最初 GitHub 集成创建请求403（该集成写权限不可用），随后使用已有 gh 身份经严格 TLS 的 GitHub API 创建成功；仅为该请求用 HTTPS DNS 实读地址，未改全局 DNS/VPN/proxy/hosts 或 TLS 校验。PR文本、一次性幂等创建/只读入口保留本机，认证 token 仅内存/stdin，不入 argv/文件/输出。

原 A/C 修复已分别普通推送原 PR53/55，当前两 PR 实时状态均 Closed/unmerged，本任务没有关闭、重开或自动合并；其后续接纳/集成由原负责人批次承载。PR66 为另一任务已合入交付，本批不代该作者签新现场结论。团队后续评审本 PR 的工具和证据，维护者按批准范围同步正式宿主/UI并补当前 PAHER 验收；ready503与Windows后续同步状态、全12项未执行部分继续如实交接。产品基线/MVP_SPEC§10待授权维护者汇总。
