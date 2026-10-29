# WP01 产品运行候选与接入交接

本页对应 [#143](https://github.com/paher-din/XunJie/issues/143)及[母规范](specs/wp01-product-runtime-and-data.md)，记录产品实现、可重复验证入口与仍需实际运行的项目。2026-10-29 负责人明确：Windows 11 实机验证待其回家后使用现有 `win` SSH 入口继续；签名、公证现在不做，移出本轮执行范围。未签名是包的实际状态，不阻塞本轮开发。

## 产品入口与事实边界

[apps/local-runtime](../../apps/local-runtime/README.md)提供 `install / launch / start / status / stop / uninstall / delete / connect / authorize / revoke`，通过 `@xunjie/product-runtime` 消费同一套实现。产品包内含 Node 24.21.0、完整 PostgreSQL 18.6 工具、生产 CLI/daemon 及来自 `apps/web` 的独立运行状态网页；网页没有课程、成员或 Agent 演示数据，不加载旧业务 store、SQLite、IndexedDB 或 outbox。网页关闭不会停止服务。

环境、安装与服务身份均持久保存，新环境获得独立客户端命名空间、凭据、目录和端口。数据库与应用使用用户私有目录，PG 只监听回环。实例操作用独立进程锁协调，存活判断不依赖超时，睡眠本身不会成为清理进程锁的依据。停止 PG 前通过 SQL 核对 cluster identity 和实际 PGDATA；不删除已有数据库锁文件，不杀占用端口的外来进程。卸载保留数据，删除必须提供当前环境身份。

`remote` 组合不准备 PG；`school` 可使用已有 PG，运行管理只检查连接与版本，不获得其进程启停权。学校对外监听需维护者提供 TLS 与公共入口，浏览器用户无需设置数据库和端口。六个逻辑部署单元的 wire 类型已经定义；当前运行宿主只声明真实存在的 `client / runtime.status`，其他业务 owner 随各自工作包接入。

## 供 #144、#145 消费的公开边界

| 边界 | 当前公开能力 |
| --- | --- |
| `@xunjie/contracts/product-runtime` | 环境、服务、六种逻辑部署单元、连接目标/能力/凭据引用、readiness 和维护参与者描述；不依赖 Node 或 implementation |
| `@xunjie/product-runtime` | `openProductRuntime({root, resources})` 的安装、运行、状态、环境隔离和数据库配置；`database()` 返回连接参数与 `credentialRef`，`resolveCredential(root, ref)` 仅在可信宿主中解析秘密 |
| `createProductRuntimeHost({root, participants})` | 本机和学校宿主复用同一生命周期；所属服务注入真实维护参与者。包不反向导入 app、开发工具或验收宿主 |
| `@xunjie/product-runtime/connections` | 持久范围授权/撤销、认证握手及已登记能力调用；连接核对目标环境、服务、协议和必要能力；主动出站连接，无回连学生私网端口的要求 |
| `@xunjie/product-runtime/maintenance` | 登记 owner 的 closeWrites、closeDispatch、drain、validate、resume；必需参与者缺失或动作失败保持封闭；记录回调交由可信宿主持久保存 |

PG 初始化条件固定为 engine **18.6**、UTF8、libc `C` collation、UTC；未额外要求扩展。资源下载来源、确切摘要、架构、许可和运行依赖见[资源清单](runtime-resources.md)。`database()` 的管理凭据用于底座装配；#144 负责按所属服务创建 schema/角色及正常业务凭据，不应让业务 owner 共用管理者权限。事务、资源发布与持久 outbox 仍由 #144 实现，完整备份升级与接管由 #145 实现。

调用方先按自身环境/服务登记授权，把 token 经私密文件传入本机，公开连接配置只保存 `credentialRef`。重连沿用原目标，不回退数据库、服务或模型。只有显式登记且实际实现的能力可授权；基础测试消费者不冒充课程、Agent 或业务接收回执。

## 可重复验证

仓库根使用指定 Node 版本：

```sh
npm ci
npm run verify
npm run test:product-runtime:native
npm run package:product -- --platform darwin-arm64
npm run package:product -- --platform win32-x64
```

原生集成测试需把 `XUNJIE_PRODUCT_POSTGRES_BIN` 指向清单固定的完整 PG 18.6 `bin`。缺少资源明确失败；常规 `npm test` 运行真实 HTTP、维护参与及无 PG 组合的进程测试，原生 PG 文件归入单独的 external 组。类型检查和构建先生成 contracts / product-runtime，再检查消费者；测试与产品分发各自发现输入，验收宿主不进入生产依赖图。

[PG 工具探针](../../scripts/probe-product-postgres.mjs)可用 `--help` 查看版本路径参数，实际证据见 [minor / major 迁移结果](evidence/wp01-postgres-upgrade.json)。它验证工具与选定路径可执行，不提供完整产品备份、更新器或恢复接管。实际分发包的独立路径验收由[包探针](../../scripts/probe-product-package.mjs)执行，输出记录自身平台和阶段结果。

## 验收边界与后续

2026-10-29 本轮实际结果：

| 范围 | 结果与证据 |
| --- | --- |
| 工程门禁 | `npm run verify` 五阶段全部通过；38 项产品运行本地行为回归、5 项原生 PG 回归分别完成。完整日志保留在 `.verification/`。 |
| Mac 最终包 | 在仓库外中文/空格路径、隔离 PATH 中完成 13 阶段；包括双环境、重复启动、正常退出、卸载保留数据、SIGKILL 事务恢复及实际 dump/restore。[包证据](evidence/wp01-package-macos.json) |
| 实际 ZIP | 最终 Mac ZIP 解包后首次安装、启动和卸载保留数据往返；[归档验证](evidence/wp01-archive-roundtrip.json)。三平台归档及摘要索引位于仓库根 `dist/`，未发布。 |
| PG 工具与迁移 | 17.10→17.11 同目录 minor、17.11→18.6 独立目录逻辑迁移，15 阶段通过；保留角色、约束、序列与数据的核对。[升级证据](evidence/wp01-postgres-upgrade.json) |
| 学校 Linux | Ubuntu 24.04.5 x64 / glibc 2.39，普通用户从独立包启停、重启、查询 PG；同机 HTTPS 身份/能力、断连重连与撤销通过。[网络证据](evidence/wp01-network-macos-linux.json) |
| Chrome 页面 | 实际包网页、手动刷新、环境身份、停止后清除旧 ready、恢复后原身份就绪、关闭页面不停止服务均已核对。[截图](evidence/wp01-runtime-chrome.png)。工具安全策略禁止内部版本页，具体 Chrome 版本未读取；Edge 未执行。 |

跨机公网直连仍未通过。对同一云机的抓包比较：8443 可收到客户端请求，临时 38195 端口无请求到达；主机 UFW 未启用、iptables INPUT 为 ACCEPT、nft ruleset 为空。过滤发生在 guest OS 之前，云安全组或出口端口限制仍待确认，未读取或修改云安全组规则。Mac 路由经过 `utun98`，单凭路由不能认定 VPN 就是阻断点；未更改 VPN 或主机网络。学校真实入口需配置可达的 HTTPS 服务入口，数据库仍保持回环监听；不使用 SSH 隧道冒充真实公网连接通过。

已经执行的工程和平台结果以证据 JSON 及本轮验证日志为准，不能从实现能力推导未执行的平台通过。Windows 11 普通用户安装、VC++ Runtime 准备、原生执行、Chrome/Edge 与故障矩阵待回家后继续；现有 Windows SSH 不可达是本轮已确认的条件，不反复要求重新配置。

仍需实际验收：干净目标设备首次安装、系统睡眠/唤醒、真实跨机混合组合、两平台 Chrome/Edge 浏览器矩阵与实际底座负载。现有同机真实双服务的网络测试证明协议与撤销，不等于真实跨机部署。Mac 包已记录启动耗时和仅属于测试实例的空闲 CPU/RSS 样本；它们不构成容量或教学结论。此票仍不作教学效果结论。
