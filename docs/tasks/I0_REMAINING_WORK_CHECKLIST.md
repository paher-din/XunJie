# I0：当前前端收尾清单

更新：2026-10-15（Asia/Shanghai）。主责：UI / Robert（wubq511）；继续在 `i0/ui-frontend` 推进。

目标：完成 I0 当前核心链的浏览器联调、两课程接线整合，以及负责人本轮批准的首页真实任务入口。按[负责人已确认的核心范围](P4_DEADLINE_CORE_VERIFICATION.md#2-2026-10-14-负责人决定)推进，复用已有登录、保存、运行、停止和下载证据。

负责人于本轮明确委托 Agent 完成提示核对与页面接棒；下表记录该开发合成工程结果，操作主体不记作 Robert 本人或人工课程审阅。

## 必做事项

| 顺序 | 工作 | 完成结果 |
| --- | --- | --- |
| 1 | **已完成：C 课程真实辅导闭环**（UI-TUTOR-09 的本次核心工程范围 / B4-CORE-01 场景） | 真实 v2 编译诊断→原版本求助→收到/展示/受委托明确回应→补分号、确认保存、冻结 v3→真实重跑成功。引用资料可读，返回作品不变；旧诊断与辅导来源保留。 |
| 2 | **已完成：两课程前端整合与交付** | 已接收 H-05 与 HDL 原交付；两课程使用同一正常入口与既有环境。引用接缝修复已定向测试、正常构建与浏览器复验，固定包、启动入口和结果随 PR #80 交付。 |
| 3 | **已完成：首页真实任务入口** | 登录后按真实 Session 展示本人学生课程及分配，任务标题来自固定活动；沿原 C/HDL 工作区进入、返回与刷新。正常首页去掉演示看板及无来源的进度/截止时间。协议专项4/4、既有入口回归与真实 HTTPS 两合成账号复验通过，见[本批记录](I0-UI_REAL_HOME_ENTRY.md)。 |

## 当前批次

当前三项均已完成。新增首页接线与本机复验见[首页真实任务入口](I0-UI_REAL_HOME_ENTRY.md)；原 C 对象、回执顺序、新旧版本与固定包见[C 辅导与两课程整合](I0-UI_CORE_REAL_TUTOR_DELIVERY.md)，原批次交付为 [PR #80](https://github.com/paher-din/XunJie/pull/80)。

[PR #79](https://github.com/paher-din/XunJie/pull/79) 与[补证 PR #81](https://github.com/paher-din/XunJie/pull/81) 已合 main；[HDL 正式交付](evidence/ui30-hdl-20261015/handoff.md)直接复用，本批补齐 C 场景及共享资料引用接缝，没有重复 HDL 实现。

## 依据与已有交付

- 核心判据：[P4 / B4-CORE-01](P4_DEADLINE_CORE_VERIFICATION.md#3-截止日前的执行与证据清单)。本次完成一个代表性场景，按该范围记录结果。
- 已有前端与辅导接线：[I0-B 六票交付](I0-B_UI_TUTOR_PLAN.md#13-2026-10-14-六票逐项收尾审查)；真实 C1 浏览器链：[PR #75 记录](I0-UI_PR69_REAL_BROWSER_RECHECK.md#42-真正浏览器操作与公共结果)；准备项收尾：[PR #76](https://github.com/paher-din/XunJie/pull/76)。
- 既有 H-05 修复：[PR #73](https://github.com/paher-din/XunJie/pull/73) 已于 2026-10-15 合 main，本前端分支已接收；本机运行副本换版及 C 闭环见[执行记录](I0-UI_CORE_REAL_TUTOR_DELIVERY.md)。
