# I0：当前前端收尾清单

更新：2026-10-15（Asia/Shanghai）。主责：UI / Robert（wubq511）；继续在 `i0/ui-frontend` 推进。

目标：完成 I0 当前核心链的浏览器联调与两课程接线整合。按[负责人已确认的核心范围](P4_DEADLINE_CORE_VERIFICATION.md#2-2026-10-14-负责人决定)推进，复用已有登录、保存、运行、停止和下载证据。

## 必做事项

| 顺序 | 工作 | 完成结果 |
| --- | --- | --- |
| 1 | **C 课程真实辅导闭环**（UI-TUTOR-09 的本次核心范围 / B4-CORE-01） | 在正常浏览器中进入获准 C 任务，针对真实代码或运行诊断完成一次代表性求助；人工核对提示与引用，学生接着修改、确认保存并重跑，结果对应正确作品版本。 |
| 2 | **两课程前端整合与交付** | 接收既有 H-05 修复和 HDL 会话共享修复；C 与数字逻辑从同一应用入口完成各自核心操作。只核 C 接缝与变动处的接线、修复实际阻断问题，交付固定版本、可用启动入口和简短结果记录。 |

## 当前批次

第 1 项已完成真实 C 编译诊断求助、收到与可见展示；正在等待人工核对提示、明确回应，再修改、保存、冻结新版本并重跑。进展与固定对象见[本批记录](I0-UI_CORE_REAL_TUTOR_DELIVERY.md)。

第 2 项已接收 H-05 与 HDL 共享修复，[PR #79](https://github.com/paher-din/XunJie/pull/79) 已合 main。两课程使用同一正常入口与既有本机环境；[HDL 正式交付](evidence/ui30-hdl-20261015/handoff.md)直接复用，我们只补 C 场景，完成后整体交付。

## 依据与已有交付

- 核心判据：[P4 / B4-CORE-01](P4_DEADLINE_CORE_VERIFICATION.md#3-截止日前的执行与证据清单)。本次完成一个代表性场景，按该范围记录结果。
- 已有前端与辅导接线：[I0-B 六票交付](I0-B_UI_TUTOR_PLAN.md#13-2026-10-14-六票逐项收尾审查)；真实 C1 浏览器链：[PR #75 记录](I0-UI_PR69_REAL_BROWSER_RECHECK.md#42-真正浏览器操作与公共结果)；准备项收尾：[PR #76](https://github.com/paher-din/XunJie/pull/76)。
- 既有 H-05 修复：[PR #73](https://github.com/paher-din/XunJie/pull/73) 已于 2026-10-15 合 main，本前端分支已接收；本机运行副本换版及 C 闭环见[执行记录](I0-UI_CORE_REAL_TUTOR_DELIVERY.md)。
