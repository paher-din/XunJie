# XunJie 产品运行库

学校身份/课程与客户端学习数据的组合、窄领域能力 `learning.authority`、`createSshRecoveryReceiver` 和正式接管配置见 [#154 操作说明](../../docs/student-agent-implementation/wp02-hybrid-deployment.md)。远端 SSH 仅承接维护，不是学生业务隧道。

`@xunjie/product-runtime` 提供本机/学校可信宿主共用的运行生命周期、连接授权、维护、完整备份、隔离恢复及接管编排。CLI 见 [apps/local-runtime](../../apps/local-runtime/README.md)，既有运行交接见 [#143](../../docs/student-agent-implementation/runtime-acceptance.md)，#145 的命令、失败处理和实际验收见 [维护与恢复](../../docs/student-agent-implementation/maintenance-acceptance.md)，组合结论见 [WP01 父票验收](../../docs/student-agent-implementation/wp01-acceptance.md)。

## 公开入口

```js
import {
  openProductRuntime, createProductRuntimeHost,
  createMaintenanceCoordinator, createRecoveryManager,
  restoreRecoverySet, restoreProductRecovery, upgradeProductRecovery,
  createStorageRecoveryOwner, createStorageRecoveryTarget, openRecoveredStorage,
  storage,
} from '@xunjie/product-runtime';
```

`@xunjie/product-runtime/connections` 导出连接 authority/outbound API，`@xunjie/product-runtime/maintenance` 导出维护 coordinator。候选包同时提供自包含 `app/product-runtime.js`，含同一恢复 API 和 `storage` namespace，供可信宿主装配；这是 Node 入口，数据库连接、管理员权限和秘密不进入浏览器 wire 契约。

| 入口 | 行为 |
| --- | --- |
| `openProductRuntime({ root, resources? })` | 安装、启动、状态、停止、保留数据卸载、显式删除、凭据与连接管理；resources 来自固定产品资源 |
| `runtime.recovery` | `configure`、`catalog`、`backup`、`resume`、`retire`、`fenceSource`、`takeover`；调用该 root 的私有控制接口，要求宿主在线 |
| `createProductRuntimeHost` | 通过 `recoveryOwners` 或数据库可用后执行的 `createRecoveryOwners` 装配业务 owner；`participants` 可登记其他维护参与者 |
| `createRecoveryManager` | 绑定 environment、maintenance、owners、requiredServiceIds、receiverIds，编排同一关闭边界备份与目标接管 |
| `restoreRecoverySet` | 认证完整备份，精确匹配全部 targets，空的独立目标恢复并验证，返回 `{ manifest, owners }`，保持 isolated |
| `restoreProductRecovery` | 默认按认证后的备份装配 runtime、空间身份和学习数据 target；自定义宿主可用 `targets` 显式提供完整业务目标集合；可提供目标 `database`、`databaseCredential` 与 `installation` |
| `upgradeProductRecovery` | `schema` / `pg-minor` / `pg-major`：从 callback 取得 held 备份，以目标 resources、database、databaseCredential、installation 在独立 root 恢复，完成后仍隔离 |
| `createStorageRecoveryOwner/Target` | 对接 [storage](../storage/README.md) 的真实快照、schema、原资源、pin、迁移与 owner 服务验证 |
| `openRecoveredStorage({ root, serviceId, migrations, backend })` | 重启时读取目标私有 binding，以恢复时生成的新凭据重新打开所属 storage；不恢复源登录凭据或自动开闸 |

## owner 与维护装配

默认 daemon 在有数据库的产品组合中注册 runtime、空间/课程、学习数据、模型连接和教学 Agent owner，提供[真实学习入口](../learning-space/src/learning-entry/README.md)；没有数据库的客户端组合可连接学校。`model` 组合持有身份/课程和模型服务，`agent` 组合仅持有 runtime 与独立教学 Agent。生产依赖不得导入验收 owner 或测试宿主。

独立 Agent 通过 `agent.dependencyConnectionId` 固定依赖连接，向学习数据服务调用 `teaching.dependencies`；学习数据服务通过 `teaching.agent` 调用实际 Agent。每个 serviceId 只发布自身实际装配的能力。维护者使用 `authorize(input,targetServiceId)` 签发对应授权，并配置成员 Agent 与独立模型设备绑定，学生继续使用原活动界面。连接、路由、任务及分片资源随各自所属 owner 参加维护、备份和隔离恢复。

`createProductLearningApplication` 装配生产业务和 HTTP，`createLearningRecoveryTargets` 按备份实际描述提供空间/课程、学习数据、模型连接及教学 Agent owner 的独立恢复目标，使用与验收限制见 [#149 交接](../../docs/student-agent-implementation/wp02-identity-activity.md) 与[模型连接](../learning-space/src/model-connections/README.md)。完整默认组合共五个 owner（含 runtime），独立 Agent 组合共两个。

教学 Agent 的正常与独立装配均登记领域清单；目标通过所属 owner 的 `validateTeachingBoundary` 重读记录和资源原字节核对，运行层不枚举或修改 Agent 业务表。返回的还原 owner 保留同一领域清单接口，供隔离校验及后续备份使用。维护与接管沿用本模块的关闸、源退休、接收端撤权及命名空间流程；见 [#204 交付](../../docs/student-agent-implementation/wp07-204-conversation-recovery.md)。

恢复 WP06 之前的三 owner 备份时，隔离目标保留原 owner 集合，通过原有精确版本校验完成接管；接管后正常停止并启动一次，才初始化空的模型 owner。新模型配置不会从 legacy 或其他空间自动导入。新的四 owner 备份已包含模型配置、加密凭据和原生检查资源，按正常流程完整恢复。

每个 owner 提供 `MaintenanceParticipant` 与 `RecoveryOwner.export/release`，宿主以 requiredServiceIds 列明必需服务。全部参与者关闭新写/派发、排空并确认同一边界后才导出任何 owner。只注册 participant 而缺少 recovery owner、遗漏必需参与者或验证失败均不得生成可用完整备份。`resourceRoots` 须列出真实资源位置，备份目录不得与环境/文件资源根重叠。

storage owner 通过 `snapshot` 在快照事务存活期间完成逻辑导出与资源复制，保留业务引用、回执和既有备份 pin；target 校验迁移历史、独立数据库/资源位置和原字节，应用已登记迁移后通过 `validateService` 检查约束、回执及未决效果身份。备份退役后才释放 pin；未知外部效果不自动重放。

`export` 的 Promise 完成后不得继续创建该备份的 pin 或文件；`release(backupId)` 必须幂等，也接受没有 pin 的身份。失败或中断的备份在 `recovery-operations/` 留下私密清理记录，先退役目录再逐 owner 释放 pin；清理失败可由可信宿主调用 `manager.cleanup()`，后续 backup/resume 也会重试。超时不等于导出已结束：忽略 abort 的 owner 结束或其进程退出之前，保留记录并拒绝清理；正常超时仍按期返回。已经验证的完整备份在 resume 或后续保留策略失败时继续保留 pin。旧候选版本没有清理记录的失败备份不自动推断或迁移。

`RecoveryTarget.restore({ backupId, targetRoot, directory, recovery, signal })` 接收持久目标环境根 `targetRoot`；`directory` 是本 owner 的解密暂存目录，不能用作重启配置的持久位置。storage target 默认将包含新角色凭据的 binding 私密保存到 `targetRoot/credentials/storage-<serviceId>`，不依赖当前进程的 `onRestored` 回调保留凭据。

目标宿主重启后，用公开 `openRecoveredStorage({ root, serviceId, migrations, backend })` 读取该目标 binding、校验 environment/service 身份并取得新的 `OwnedStorage` 句柄，再装配业务服务及维护/恢复参与者。`root` 指恢复后的目标，migrations 与 backend 由所属 module/可信宿主提供；秘密不写日志。此接口沿用持久维护闸和存储代际，不自动 resume、接管或复活源凭据，也通过候选包 `app/product-runtime.js` 导出。

直接 manager 的 `backup({ directory, key, leaveClosed? })` 接收原始 key，`configure` 接收 `BackupPolicy.recoveryKeyRef`，`catalog(directory, key)` 返回认证后的备份。控制代理 `runtime.recovery.backup` 使用私有 `recoveryKeyRef`，`runtime.recovery.catalog` 使用策略/最近备份保存的 key 引用，二者不要混用。

`restoreProductRecovery` / `upgradeProductRecovery` 的 `databaseCredential` 是 string，仅供可信 API 在内存中传入目标数据库密码；external 目标要求提供，库将其保存为目标 `database.credentialRef` 对应的私有 credential。`installation` 类型为 `Omit<InstallOptions, 'database' | 'requiredServiceIds'>`，支持 profile、host、port、publicEndpoint、tls，供学校部署选择目标 HTTPS/TLS 入口；数据库通过独立 `database` 参数指定，requiredServiceIds 从备份恢复。源 TLS 私钥不自动复用。

CLI 的 restore/upgrade JSON 对应支持 `database`、`databaseCredentialFile` 和 `installation`；密码从单行私密文件读取，读后纳入错误输出 redaction，不将明文写进 JSON、argv 或日志。默认产品的空间身份与学习数据 owner 自动恢复；其他业务 owner targets 仍须由可信宿主提供。external 数据库维护使用带匹配 PostgreSQL 备份/还原工具的**完整管理分发包**；不含 PG 工具的 remote-client 包不能作为外部数据库维护入口。

## 恢复与唯一写方

目标 root、cluster/schema、文件根/S3 bucket 必须独立、未占用。恢复保留 environment/service 与原业务身份，创建新 installation、client namespace、本地凭据；不复活源 grant、control token 或旧连接秘密。storage 维护 generation 推进，旧句柄失效。恢复/升级默认隔离，需用 restored owners、目标 environment 与 maintenance 创建目标 host/manager，验证后由**目标**执行 takeover。

takeover 要求最新且仍 held 的源备份、源 `retire` 绑定证明及全部 receiver。receiver id 为 `environmentId/serviceId`；默认 root 适配器核对实际 receiver 身份，再对源 environment 及全部传入 serviceIds 调用真实 authority 的 `fenceSource`。旧 grant 视为 generation 0；fence 持久推进代际，拒绝旧 token（含重启和旧文件复活），等待已接受 handler 全部结束才返回无秘密 proof。新 token 只能由 authorize 取得当前代际。

源不可达/拒绝、receiver 缺失/身份错误、断线/超时或验证失败均不得启用目标；确认源退休、receiver fencing 及校验后才恢复写入/派发，失败重新封闸。退休源即使在线也不能 resume。active 后仍需接收方重新授权；已移除的出站连接用 `connect` 登记，仍保留的固定连接用 `reconnect` 和新的私有 `credentialRef` 保存新授权。`reconnect` 先核对真实握手，禁止变更固定 owner、能力或传输描述；重试读取相同原凭据引用，不覆盖私有原件。能力就绪与权威交接分别判断。维护 resume 不能跳过目标隔离或源退休。

接收端在关闸并排空轮询后撤销旧安装授权，逐服务记录绑定备份、旧安装和目标安装的继任事实；事实与退休记录一起进入运行时备份。固定活动路由原件保持不变，仅经该证明匹配继任安装，之后仍逐次校验新 grant。真实学习数据 owner 在新授权签发时附加执行授权交接记录，原 origin/命令/回执不改写；原活动关闭或已开始清理的命令不恢复。目标在启用前移除失效连接，重复接管不会删除重新建立的新授权连接。独立 Agent 本次要求保持稳定 `publicEndpoint`，由运维在主机切换时调整该地址的路由。

固定引擎为 17.10、17.11、18.6，升级走逻辑备份与独立目标恢复。失败保留原备份及现场，用兼容资源从原备份再还原到另一个独立目标；只换回旧 binary 不构成数据库回滚。学校 external 的独立目标 cluster、权限、工具及启停由管理员负责，产品不接管其服务生命周期。

## 组件与执行恢复（#176）

维护材料与恢复接线见 [#176 实施记录](../../docs/student-agent-implementation/wp03-176-recovery-implementation.md)。新增备份要求每个必要 owner 提供版本化 `material()`；逐命令证据在加密数据中，公开清单仅保留聚合计数。排队投影不能证明浏览器 Worker 未开始：服务已接收的浏览器命令没有确认终态时，维护拒绝安全排空，保留原身份等待原浏览器核实。

`restore` 后可用同一产品的 `start` 打开目标，状态为 `maintenance`，首页、活动与工作区只读。此模式不启动实验、自检、后台同步或旧队列；个人身份只读取既有绑定，学校隔离登录使用进程内只读会话。接管后重新登录，新的成员写入必须携带当前 `x-xj-namespace`；旧 namespace 和缺失握手均拒绝。普通维护不开放此读取例外。

接收端 fencing 必须通过其真实 owner 排空并返回执行边界，绑定完整源服务集合、源安装、`backupId` 与目标安装。接管持久保存证明；成功回包丢失时重试返回原结果，不再次封闭已开放的目标。安装退休同时约束普通 grant 和学校原生领取通道，并随接收端备份恢复保留；新安装授权不复活旧安装。重新授权仅适用于新的 installation，原文所述 scope 级代际轮换不代替安装永久退休。

实际产品包 Chrome 探针：`node scripts/probe-execution-recovery.mjs <产品包目录> <报告目录>`。它使用包内 Node/PostgreSQL/执行器创建独立测试环境，包含真实计算、检查点、隔离打开和接管；需桌面 Chrome 及测试环境初始化/清理授权。Mac 与独立学校机验收单独跟踪于 [跨平台与跨机验收](https://github.com/paher-din/XunJie/issues/188)。

## 验证命令

```sh
npm run typecheck -w @xunjie/product-runtime
npm run build -w @xunjie/product-runtime
npm test -w @xunjie/product-runtime
node scripts/probe-recovery.mjs --help
```

独立原生验收使用实际产品包与仓库外新 root，完整命令与证据见 [#145 维护验收](../../docs/student-agent-implementation/maintenance-acceptance.md#独立验收命令与证据)。普通回归、独立分发恢复、浏览器和教学结果分别记录，未执行不算通过。
