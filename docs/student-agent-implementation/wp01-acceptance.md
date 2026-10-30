# WP01 父票验收

日期：2026-10-30（Asia/Shanghai）。对应 [#142](https://github.com/paher-din/XunJie/issues/142)，实现为 #146 结构准备及已关闭的 #143、#144、#145；验收依据为[父票规范](specs/wp01-product-runtime-and-data.md)和各子票经负责人确认的本轮范围。

## 预期与实际效果

WP01 要交付独立于开发工具的产品运行与数据底座：个人设备准备自身运行资源，学校部署复用同一实现，服务能确认保存记录和资源，并在停止、失败、备份、升级和搬迁后保持数据归属及唯一写入权。后续业务通过公开接口接入。

当前实现提供 Windows 11 x64、Apple Silicon Mac 的原生 Node/PostgreSQL 运行包，学校首个支持组合为 Ubuntu 24.04 x64；具备环境隔离、启停和状态网页、认证部署连接、所属服务 PostgreSQL 事务及文件/S3 资源、一致备份、隔离还原、schema/PG 升级和接管。默认宿主登记 runtime owner，实际存储/恢复通过独立服务消费者装配同一产品模块。

课程登录、学习工作区、Agent、模型和 RunDriver 的新业务尚由后续 WP 接入。安装后显示底座状态页；WP01 的成功不表示完整教学产品或教学效果已完成。

**结论：本轮确认范围内通过，预期与实际实现 match。** 验收包含子票证据核对、最终版本补验和组合问题修复。完整结果、包与证据摘要见[父票汇总](evidence/wp01-parent-summary.json)。它不表示初始规范中后来被明确排除的项目也已通过。

## 需求覆盖

下表覆盖父票全部 28 条 User Stories。原始证据的实际平台、版本和输入保持不变；父票新增检查与历史证据分别列出。

| 预期 | User Stories | 已有实现与证据 | 父票核对重点 |
| --- | --- | --- | --- |
| 安装后直接准备原生资源，学校网页不用本机数据库 | 1–4 | [实际安装](runtime-acceptance.md)、[固定来源与资源](runtime-resources.md) | 最终分发包、隔离 PATH、中文/空格路径、普通用户、状态网页 |
| 本机、学校和真实跨机混合组合 | 5、19–20 | [公网 HTTPS](evidence/wp01-network-macos-linux.json)、[恢复后的跨机接管](evidence/wp01-maintenance-hybrid.json) | 原目标不被静默替换，撤销与重新授权有可执行入口 |
| 明确启停、重复启动复用、数据保留及双环境隔离 | 6–11 | [运行交接](runtime-acceptance.md)、[Windows S4](evidence/wp01-windows-sleep.json) | 删除已退休/隔离环境后，同 root 重装获得新身份且可用；B 和外部备份保留 |
| 同一 PostgreSQL 事务、所有权、原子回执与旧代际拒绝 | 12–15 | [存储接口及故障边界](storage-acceptance.md)、[最小所属服务](../../apps/server/server/storage-sample/index.ts) | #145 改过存储实现，补当前版本三平台原生竞争/提交未知测试 |
| 确认资源可重读，文件与固定 S3，引用及 GC 协调 | 16–18 | [文件/S3 与 GC](storage-acceptance.md) | 失败备份释放 pin、已完成备份继续保留 pin，失败清理可重试 |
| 数据库与资源的一致备份及独立目标验证 | 21–22、28 | [完整维护矩阵](maintenance-acceptance.md)、[Mac→Windows](evidence/wp01-maintenance-macos-to-windows.json) | 保留原请求/资源身份；跨机副本支持离开源机器恢复，同机目录本身不作为介质损毁证据 |
| schema、PG minor/major 升级，失败后从原备份恢复 | 23–24 | [维护与升级](maintenance-acceptance.md)、[实际磁盘不足](evidence/wp01-maintenance-disk-space.json) | 新目标隔离、版本实际变化、源和 B 保全；不能只换回旧 binary |
| 唯一权威交接、持久 owner 接入及未知结果保留 | 25–27 | [公开维护/恢复接口](../../packages/product-runtime/README.md)、[跨机 fencing](evidence/wp01-maintenance-hybrid.json) | 退休与授权状态确认落盘，旧 token/旧实例拒绝，重新授权沿原 credentialRef |

## 本轮发现与处理

父票复核发现并修复以下组合问题：

- 环境删除遗漏退休、隔离、备份策略和恢复日志，旧状态会约束同 root 的新安装；另补备份导出超时后的删除保护，清理未完成时保留原身份和 journal。
- 备份导出或加密失败后，持久资源 pin 没有退役路径；保留策略中途失败也可能遗留 pin。
- 退休证明和授权代际使用的 JSON 原子替换缺少落盘屏障；补写入及发布后的同步，并按 Windows 短暂读占用增加有界重试。增加屏障不等于实际执行过断电实验。
- 恢复保留连接描述，重复 `connect` 会被拒绝。手册改为接收方重新授权后，用 `set-credential` 写入原 `credentialRef`；新连接才登记新描述。
- #144 的原生证据先于 #145 对存储的修改，须补当前实现的实际竞争和故障验收。
- Windows 完整包检查发现，已占用目录被误报为缺少根标记；现明确报告目录占用，保留原文件，既有回归改为精确检查原因。

### Standards

初次审查发现删除遗漏恢复状态、失败备份遗留 pin 两项 P2；复核新补丁又发现 timeout 后删除会抢先清掉 journal。均已修复，并经过真实 owner/进程边界及 Windows 普通用户回归。生产依赖图未发现反向引用 apps、tools 或验收宿主。当前范围内无剩余阻塞发现。

### Spec

初次审查发现权威状态落盘屏障、重新授权手册、删除隔离、存储证据版本四项问题。前三项有对应修复，当前存储输入在三平台补验；Windows 新建祖先目录链及系统断电持久性仍不作保证或已验证声明。当前确认的进程故障、维护和接管范围无剩余阻塞发现；硬件故障不被扩大为已通过。

## 验证与证据

原始子票记录见 [运行](runtime-acceptance.md)、[存储](storage-acceptance.md)、[维护恢复](maintenance-acceptance.md)。父票新增结果如下，跳过项单列，不计入通过。

| 范围 | 本轮实际结果与证据 |
| --- | --- |
| 工程门禁 | Node 24.21.0，`npm run verify` 的类型检查、构建、浏览器契约、文档链接和全量测试五阶段通过；[门禁记录](evidence/wp01-parent-verification.json)。随后目录诊断小修复另经聚焦回归与最终包检查，GitHub CI 以 PR checks 为准。 |
| CI 时区回归 | [首轮 CI](https://github.com/paher-din/XunJie/actions/runs/41012899398) 中，旧前端截止时间测试将 `+08:00` 输入与宿主本地时间混用，UTC 环境得到 15:59。保持按用户本地时间显示的实现，测试改用本地日期构造 ISO 输入；UTC、Asia/Shanghai、America/Los_Angeles 的同一测试文件均 **10/10**；[第二轮 CI](https://github.com/paher-din/XunJie/actions/runs/41018998949) 的前端 **688/688**。 |
| CI 外部环境边界 | 完整日志显示，前两轮 CI 都有旧 HDL 节点案例创建 `/run/xunjie-dlc` 的 `EACCES`。将该案例原断言移到 `alu-node.runtime.test.ts`，沿用 external 分组；默认门禁仍运行 6 个纯 ALU 案例。CI 单独准备节点用户可写的空运行目录，再以普通 runner 用户执行该文件。Mac 不具备该 Linux 运行环境，节点及 Icarus 案例明确跳过，不算通过。修复后的全量 CI 及节点案例见 [PR #147 checks](https://github.com/paher-din/XunJie/pull/147/checks)。 |
| 当前存储实现 | Mac、Windows、学校 Ubuntu 均 **28/28，0 失败、0 跳过**；[Mac](evidence/wp01-parent-storage-macos.json)、[Windows](evidence/wp01-parent-storage-windows.json)、[Linux](evidence/wp01-parent-storage-linux.json)。包括并发事务、提交回包丢失、资源发布/GC、快照和恢复约束。 |
| 存储证据版本 | Mac/Linux 输入为 `097baad2…`；Windows 为 `d63c9ab5…`，差异来自探针使用的原生路径分隔符。按当前文件重算两种路径算法均吻合；[摘要](evidence/wp01-parent-storage-input-digests.json)。仓库外实际包消费者的 9 个生产 storage JavaScript 文件与当前构建逐一相同。 |
| 实际分发包 | 最终实现 `5fe90e3`，Mac **13/13**、Windows 非提升用户 **19/19**；[Mac](evidence/wp01-parent-package-macos.json)、[Windows](evidence/wp01-parent-package-windows.json)、[令牌](evidence/wp01-parent-windows-token.json)。包括中文/空格路径、重复启停、卸载保留、双环境、冲突、CLI 中断、进程残留、强杀事务及 dump/restore。 |
| 恢复与升级 | 最终包 Mac **21/21**，覆盖文件/S3、隔离恢复、schema 迁移、PG17.10→17.11→18.6、真实还原中断及从原备份重建；[恢复](evidence/wp01-parent-recovery-macos.json)。产品 CLI 另完成自动备份、保留、major 升级和在线源接管；[CLI](evidence/wp01-parent-cli-major.json)。 |
| 修复的原生边界 | Mac 原生运行 **7/7**；Windows IO 与真实存储恢复 **18 通过、0 失败、2 个 POSIX 专用故障注入跳过**；[Windows 原生日志](evidence/wp01-parent-windows-recovery-native.log)。 |
| 删除隔离与竞争 | Windows 退休/隔离删除两项通过；迟到 export 的 pending/retiring 拒删、清理后删除及重装通过。首次外层 10 秒用例上限取消了后一项；按 Windows 原生进程身份检查耗时调整外层上限后，实际 22.6 秒完成，40 ms 导出故障期限不变。[首次](evidence/wp01-parent-windows-deletion-first.log)、[复验](evidence/wp01-parent-windows-deletion-retry.log)。 |
| Chrome | Mac Chrome 156.0.8078.79 观察恢复后的 PG18.6、新 installation 和 recovery namespace；[截图](evidence/wp01-parent-chrome-macos.png)。此前同前端版本已检查维护/就绪切换及停止后清除旧 ready。Robert 在 Windows Chrome 156.0.8078.48 确认 ready、PG18.6、重新检查、环境身份、关闭网页再进入均通过；[人工确认](evidence/wp01-parent-browser-windows.json)。最终包前端摘要相同。 |
| 跨机与跨平台 | 复核 #145 汇总引用的 9 份证据，文件与摘要全部吻合；[核对](evidence/wp01-parent-prior-evidence-audit.json)。保留 Mac→Linux 公网 HTTPS、external PG、接管 fencing、实际磁盘不足和 Mac→Windows 原备份逻辑还原的原始平台/版本范围；没有冒充本轮所有新补丁的全组合重跑。 |

Mac 最后一次并行验收在 PG major 目标初始化时失败，失败目标、源和原备份均保留。观测到本机 SysV shared-memory 段上限 32、此前验收保留 13 段；停止本轮旧环境释放 10 段后，同包在独立目录完成 21/21。现象与段数耗尽一致，但原始 initdb stderr 未留存，**不将具体原因写成已确证**。[失败记录](evidence/wp01-parent-recovery-initialization-failure.json)、[隔离复验说明](evidence/wp01-parent-recovery-resource-retry.json)。未调整系统限制。

Windows 探针的 Temp 布局、原生依赖夹具路径和依赖 starting 状态轮询的故障注入先后修正。最终启动中断以该次 CLI 的 daemon launch 记录作为注入触发，明确在 CLI 未完成时终止它，再以公开 CLI/API 核对同一 daemon、数据及 B 环境；不再靠轮询碰到短暂 starting 才算执行。最终 19 阶段的原始记录保留实际边界。

基线 `d11f5bf` 的 `npm run verify` 五阶段通过，Node 24.21.0，日志为 `.verification/2026-10-30T04-54-46-225Z-cvyxyv/`。同一基线在仓库外完成 Mac 包 13 阶段、恢复 21 阶段、CLI PG17.11→18.6 及接管；这些是修复前的对照，最终修复另行验证。

## 已确认范围与交付边界

- [#143 已确认](https://github.com/paher-din/XunJie/issues/143)：签名、公证及 Gatekeeper 专项暂不执行；干净 OS 虚拟机取消，以隔离 PATH、完整依赖审计和实际宿主安装为本轮范围。首次 Windows VC++ 依赖准备可能需要网络、许可确认和安装权限。
- 桌面浏览器只要求 Chrome，Edge 不再必验。Windows 本轮基础运行页面由负责人再次人工确认；#145 没有 Windows Chrome 恢复页面操作，不能将该项记成已跑过。
- 学校 external 验收使用隔离的一次性管理员 provider，产品不接管数据库进程；通用 CLI 的接管映射本机私有 root，真实跨机验收通过可信宿主适配器调用相同公开 API，尚未交付任意远程管理 CLI。
- 不保证全部 S3 供应商、硬件故障、零停机、教学容量或教学效果。固定 S3 组合为 SeaweedFS 4.50；断电未实测，Windows 电源证据范围为 S4。
- 最终交付为面向 `main` 的 PR；保持未合并，父票等待 PR 审查与合并，不提前将分支交付表述为已进入 `main`。
