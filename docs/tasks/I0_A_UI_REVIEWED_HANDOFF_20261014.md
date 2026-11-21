# I0：A已复核能力与UI接收包（2026-10-14）

接收对象：UI（wubq511 / Robert）；现场协作：C（paher-din）；业务与集成复核：A（czr112）。本包在本地准备，不表示已发布、UI已收到或浏览器验收通过。职责和待办沿[#30现有分派](https://github.com/paher-din/XunJie/issues/30#issuecomment-6155068633)，不再发一份重复任务。

## 1. 固定入口和证据

- 已由C执行的运行源：`9fa76adbfb37a60cc087f8bf2fbdd1e05cd18e77`；公开交接[#53](https://github.com/paher-din/XunJie/pull/53)，固定文档head `fe6d301896603be258e5f6b942037c194429db93`。正常I0是24表临时合成库，不能替换为DL-A35表库。
- C证据固定[#55](https://github.com/paher-din/XunJie/pull/55) head `d86e51e8b09f283e9249d0e85e70cc4df873aff9`：[manifest](https://github.com/paher-din/XunJie/blob/d86e51e8b09f283e9249d0e85e70cc4df873aff9/docs/tasks/evidence/c-entry-https/manifest.json)、[20项结果](https://github.com/paher-din/XunJie/blob/d86e51e8b09f283e9249d0e85e70cc4df873aff9/docs/tasks/evidence/c-entry-https/verification-final.json)、[HTTP投影](https://github.com/paher-din/XunJie/blob/d86e51e8b09f283e9249d0e85e70cc4df873aff9/docs/tasks/evidence/c-entry-https/http-final.json)、[现场UI交接](https://github.com/paher-din/XunJie/blob/d86e51e8b09f283e9249d0e85e70cc4df873aff9/docs/tasks/evidence/c-entry-https/ui-handoff.json)。A已核9个公开文件、5段日志及158份保留正文的哈希一致，未读取现场库/秘密文件或独立重跑C20项。
- C记录的Origin：`https://127.0.0.1:3443`，仅PAHER同机。最后UI交接在2026-10-14 01:54:05记录已停止、退出0；当前在线状态未探测。实际启动/停止与受控配置来源沿上述原交接，A不复制现场凭据，不预设MSI或跨机可访问。
- 合法Assignment：`9906a7af-a43e-44da-a395-db8491c4cbbf`；Activity：`ef2137d8-641d-480f-b1c1-9c60d3c5975a`；Attempt：`e284d4ab-29b3-49fb-ac3e-5d2b35e2fb17`。最后交接Assignment revision=3/active=true；此前暂停revision=2/active=false原证据保留。实际接线每次读取服务端当前版本，不将这些验收ID写进正式源码。

## 2. 按能力接收，按浏览器另验

| 顺序 / H | 现有接口与权威输入 | A已复核材料与边界 | UI接线/验收内容 |
| --- | --- | --- | --- |
| 1 / H-01 | POST `/api/sessions`：`loginName/password`；GET `/api/session`读userId/courses/csrfToken。写请求同源Origin、`x-csrf-token`及原Cookie | C五角色正常登录、匿名401、Origin/CSRF403。权限来自服务端Session与成员，不来自页面按钮/body role/studentId | 先落实C/UI访问、profile、信任、账号领取和运行窗口方案→A；再正常登录/切账号。秘密不放源码、本包或普通评论；Node TLS通过不替浏览器信任 |
| 2 / H-02 | GET `/api/assignments/:id`；GET `/api/activities/:id?audience=student`；GET `/api/resources/:id` | 本人分配、未分配/跨课程403；公开共享资源200、私有资源403。GET不创建Attempt | 基于本人合法引用进入既有页面，核未分配/暂停空态和实际路由。没有新增列表API或已经验证的hash深链；teacher-validator视图不得由学生请求 |
| 3 / H-03 | GET `/api/assignments/:id/bootstrap`→`data.assignment`及`data.recoveryGeneration`；已有Attempt GET recovery | 首次受信代际来自已授权bootstrap；旧G写入409、GET恢复无新Job/Attempt副作用 | 刷新/恢复读当前投影；不从session、文档占位G或本地缓存猜代际。现场备份/重启恢复仍未验 |
| 4 / H-05 | 学生显式创建Attempt；sync回执→GET权威head/文件→显式Snapshot | ACK与attempt/workspace/document/decision版本分开；同键原正文重放同回执，异正文/旧revision409；新草稿不改变旧快照 | 编辑/确认保存/未同步提示、刷新与断网重连、账号草稿隔离、多标签冲突和键盘路径。只重试原键/原正文，不伪造ACK或依据编辑器猜版本 |
| 5 / H-04 | 学生显式创建Run；GET原Job/Run；POST原Job cancel并轮询 | C原消费者真实执行；unknown/cancelling不是终止确认。旧Job取消确认后才新建明确合成Run；原身份、回执与快照不能更换 | 展示queued/running/unknown/停止未确认与真实终态，禁止把取消受理显示为已停止；UI不代学生发起运行/修改 |
| 6 / H-06 | GET原Run及`/files`；原Snapshot/Result引用 | 私有检查产物redacted；检查Job succeeded但verdict=failed；学生report available且原run/snapshot/bytes/hash一致。暂停允许既有更新/快照，拒绝新运行/创建/回收/恢复文件 | 正确渲染正文/缺项/裁剪/过时/失败；不将stdout或Job成功当课程通过，不补造未知产物。真实断线注入、模型、HDL/ALU、真人/教学与完整AC/NFR未执行 |

## 3. 原手册visibility勘误（本地已改，公开固定稿尚未更新）

原 `I0_A_C_HANDOFF.md` §17.5已在既有A工作区仅补一处资源示例。以下是正常教师资源创建正文模板，不是实际凭据或可直接执行命令；`<G>`替换为当前受控/授权读取确认的代际。

```json
{"recoveryGeneration":"<G>","teacherDesignAllowed":true,"material":{"format":"txt","title":"Synthetic reading","content":"ASCII words","visibility":{"student":true,"tutor":true}}}
```

```json
{"recoveryGeneration":"<G>","teacherDesignAllowed":true,"material":{"format":"txt","title":"Synthetic reading","content":"ASCII words","kind":"private_answer","visibility":{"student":false,"tutor":false}}}
```

visibility必须位于material内；teacherDesignAllowed不等于学生/辅导可见。省略visibility仍为false/false，这是保护默认，不通过放宽后台修示例。C已在原教师接口显式分享后取得20/20结果，不为同一材料重新建库或重跑整批。

## 4. 下一回交和完成判断

UI/C先交实际浏览器/版本/profile/位置、同机访问、精确信任存储/操作/范围、账号安全领取、运行窗口/启动停止人和UI源码SHA→A。方案可并行准备，实际信任/领取操作核其覆盖许可。现场仍由C执行，A核业务组合，UI接现有工程。

每个H分别回交“材料已收到 / 已接线 / 实际通过 / 失败 / 未执行”，附固定源码、环境、原对象/版本/代际、实际操作和去敏证据。严重越权/丢失/隔离/无法保存回原模块修复。共用能力只回#30一次；HDL操作表和真实增量回#38引用，不重复复制同一20项日志。

此包不授予新的共享字段、ALU、模型、节点维护、浏览器信任、跨机传密或公开发布权限。不关闭#30/#38/#22，C服务端结果、A隔离回归、浏览器和真实教学分别记账。A本批组合与审查结果见[推进记录](A_CURRENT_NEXT_STEPS_20261014.md)；产品进度待授权维护者汇总。
