# I0：当前前端收尾清单

更新：2026-10-15（Asia/Shanghai）。主责：UI / Robert（wubq511）；继续在 `i0/ui-frontend` 推进。

目标：完成 I0 当前核心链的浏览器联调、两课程接线整合，以及负责人本轮批准的首页真实任务入口与原看板接回。按[负责人已确认的核心范围](P4_DEADLINE_CORE_VERIFICATION.md#2-2026-10-14-负责人决定)推进，复用已有登录、保存、运行、停止和下载证据。

负责人于本轮明确委托 Agent 完成提示核对与页面接棒；下表记录该开发合成工程结果，操作主体不记作 Robert 本人或人工课程审阅。

## 必做事项

| 顺序 | 工作 | 完成结果 |
| --- | --- | --- |
| 1 | **已完成：C 课程真实辅导闭环**（UI-TUTOR-09 的本次核心工程范围 / B4-CORE-01 场景） | 真实 v2 编译诊断→原版本求助→收到/展示/受委托明确回应→补分号、确认保存、冻结 v3→真实重跑成功。引用资料可读，返回作品不变；旧诊断与辅导来源保留。 |
| 2 | **已完成：两课程前端整合与交付** | 已接收 H-05 与 HDL 原交付；两课程使用同一正常入口与既有环境。引用接缝修复已定向测试、正常构建与浏览器复验，固定包、启动入口和结果随 PR #80 交付。 |
| 3 | **已完成：真实任务入口、原看板与演示统计展示** | 原本人分配与[看板接回](I0-UI_HOME_DASHBOARD_RECONNECT.md)已完成。本轮核查后端无完成率/时长汇总，按负责人授权仅看板使用原演示数据并标注“演示统计”，真实分配数量独立显示，内嵌入口仍为“当前获准任务”。类型/构建、组件5/5、浏览器专项5/5与本机HTTPS显示复验通过，见[记录与截图](I0-UI_DASHBOARD_DISPLAY_DATA.md)。后续[姓名/课程/项目显示名](I0-UI_HOME_DISPLAY_NAMES.md)已修正并定向验证，原账号与任务接线保持；最新项目名随统一构建部署，本批不单独覆盖3444。 |
| 4 | **已完成：团队共用数据与一个演示账号** | PAHER 原35表库已显式迁移；显示资料由后端返回，前端别名已撤；统一 B 账号拥有1个C/4个HDL任务，旧A/辅助学生停用且历史保留。两个独立Chrome会话严格TLS验证相同课程、分配及bootstrap；当时的共享入口已退役，历史证据见[原记录](I0-UI_SHARED_DATA_ENTRY.md)，当前按云端私下手册连接。 |
| 5 | **已完成：云端共享入口与成员本机执行接线** | [本轮云端接线](I0-UI_CLOUD_SHARED_ENTRY.md)已接收原41表最新数据；原页面/API/数据库共享，C/HDL节点绑定与代际分离。旧连接工具删除，仓库只含通用模板，真实连接操作手册及材料在仓库外私下发放。 |
| 6 | **已完成：双角色登录与共享演示数据整合** | [账号与数据整合](I0-UI_SHARED_DEMO_ACCOUNTS.md)：仅一教师/一学生可登录、六虚拟学生；教师保留两教学班/四课程实例，统一学生仅属原班 C/HDL 两门课程、7 个任务，真实浏览器刷新已核。教师发布分配、学生保存及本机执行、统一角色入口沿原交付；旧作品和归属保留。 |

## 当前批次

当前六项已按各自工程范围完成；云端与双角色整合见上述本轮记录，连接资料仅私下发放。此前[统一共享数据和演示账号](I0-UI_SHARED_DATA_ENTRY.md)由[PR #89](https://github.com/paher-din/XunJie/pull/89)交付。此前[看板演示统计](I0-UI_DASHBOARD_DISPLAY_DATA.md)由[PR #86](https://github.com/paher-din/XunJie/pull/86)交付；[原看板](I0-UI_HOME_DASHBOARD_RECONNECT.md)与[真实任务入口](I0-UI_REAL_HOME_ENTRY.md)分别由[PR #85](https://github.com/paher-din/XunJie/pull/85)、[PR #82](https://github.com/paher-din/XunJie/pull/82)交付。原 C 对象、回执与固定包见[C 辅导与两课程整合](I0-UI_CORE_REAL_TUTOR_DELIVERY.md)。

[PR #79](https://github.com/paher-din/XunJie/pull/79) 与[补证 PR #81](https://github.com/paher-din/XunJie/pull/81) 已合 main；[HDL 正式交付](evidence/ui30-hdl-20261015/handoff.md)直接复用，本批补齐 C 场景及共享资料引用接缝，没有重复 HDL 实现。

## 依据与已有交付

- 核心判据：[P4 / B4-CORE-01](P4_DEADLINE_CORE_VERIFICATION.md#3-截止日前的执行与证据清单)。本次完成一个代表性场景，按该范围记录结果。
- 已有前端与辅导接线：[I0-B 六票交付](I0-B_UI_TUTOR_PLAN.md#13-2026-10-14-六票逐项收尾审查)；真实 C1 浏览器链：[PR #75 记录](I0-UI_PR69_REAL_BROWSER_RECHECK.md#42-真正浏览器操作与公共结果)；准备项收尾：[PR #76](https://github.com/paher-din/XunJie/pull/76)。
- 既有 H-05 修复：[PR #73](https://github.com/paher-din/XunJie/pull/73) 已于 2026-10-15 合 main，本前端分支已接收；本机运行副本换版及 C 闭环见[执行记录](I0-UI_CORE_REAL_TUTOR_DELIVERY.md)。
