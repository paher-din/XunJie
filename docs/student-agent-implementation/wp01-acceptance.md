# WP01 父票验收

日期：2026-10-30（Asia/Shanghai）。对应 [#142](https://github.com/paher-din/XunJie/issues/142)，实现为 #146 结构准备及已关闭的 #143、#144、#145；验收依据为[父票规范](specs/wp01-product-runtime-and-data.md)和各子票经负责人确认的本轮范围。

## 预期与实际效果

WP01 要交付独立于开发工具的产品运行与数据底座：个人设备准备自身运行资源，学校部署复用同一实现，服务能确认保存记录和资源，并在停止、失败、备份、升级和搬迁后保持数据归属及唯一写入权。后续业务通过公开接口接入。

当前实现提供 Windows 11 x64、Apple Silicon Mac 的原生 Node/PostgreSQL 运行包，学校首个支持组合为 Ubuntu 24.04 x64；具备环境隔离、启停和状态网页、认证部署连接、所属服务 PostgreSQL 事务及文件/S3 资源、一致备份、隔离还原、schema/PG 升级和接管。默认宿主登记 runtime owner，实际存储/恢复通过独立服务消费者装配同一产品模块。

课程登录、学习工作区、Agent、模型和 RunDriver 的新业务尚由后续 WP 接入。安装后显示底座状态页；WP01 的成功不表示完整教学产品或教学效果已完成。

父票验收进行中。最终结论、修复后检查及各平台结果将在交付时更新，不能以子票已关闭替代组合验收。

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

父票复核发现以下组合问题，修复和验证结果随最终证据更新：

- 环境删除遗漏退休、隔离、备份策略和恢复日志，旧状态会约束同 root 的新安装；另补备份导出超时后的删除保护，清理未完成时保留原身份和 journal。
- 备份导出或加密失败后，持久资源 pin 没有退役路径；保留策略中途失败也可能遗留 pin。
- 退休证明和授权代际使用的 JSON 原子替换缺少落盘屏障；补写入及发布后的同步，并按 Windows 短暂读占用增加有界重试。增加屏障不等于实际执行过断电实验。
- 恢复保留连接描述，重复 `connect` 会被拒绝。手册改为接收方重新授权后，用 `set-credential` 写入原 `credentialRef`；新连接才登记新描述。
- #144 的原生证据先于 #145 对存储的修改，须补当前实现的实际竞争和故障验收。

## 验证与证据

验收结果将在最终提交更新。原始子票记录见 [运行](runtime-acceptance.md)、[存储](storage-acceptance.md)、[维护恢复](maintenance-acceptance.md)。

基线 `d11f5bf` 的 `npm run verify` 五阶段通过，Node 24.21.0，日志为 `.verification/2026-10-30T04-54-46-225Z-cvyxyv/`。同一基线在仓库外完成 Mac 包 13 阶段、恢复 21 阶段、CLI PG17.11→18.6 及接管；这些是修复前的对照，最终修复另行验证。

## 已确认范围与交付边界

- [#143 已确认](https://github.com/paher-din/XunJie/issues/143)：签名、公证及 Gatekeeper 专项暂不执行；干净 OS 虚拟机取消，以隔离 PATH、完整依赖审计和实际宿主安装为本轮范围。首次 Windows VC++ 依赖准备可能需要网络、许可确认和安装权限。
- 桌面浏览器只要求 Chrome，Edge 不再必验。Windows 基础页面有 #143 的负责人人工确认；#145 没有 Windows Chrome 恢复页面操作，不能将该项记成已跑过。
- 学校 external 验收使用隔离的一次性管理员 provider，产品不接管数据库进程；通用 CLI 的接管映射本机私有 root，真实跨机验收通过可信宿主适配器调用相同公开 API，尚未交付任意远程管理 CLI。
- 不保证全部 S3 供应商、硬件故障、零停机、教学容量或教学效果。固定 S3 组合为 SeaweedFS 4.50；断电未实测，Windows 电源证据范围为 S4。
- 最终交付为面向 `main` 的 PR；保持未合并，父票等待 PR 审查与合并，不提前将分支交付表述为已进入 `main`。
