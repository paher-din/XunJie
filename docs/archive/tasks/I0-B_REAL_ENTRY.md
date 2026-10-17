# I0-B：最小真实分配入口实施补充

日期：2026-10-14（Asia/Shanghai）。主责：UI。父任务：[I0-B 六票计划](I0-B_UI_TUTOR_PLAN.md)，本文件是当前父票实施补充，不另开 ticket。工作树分支 `codex/i0-b-real-entry`，起点 `cbb5824270c7216714b7cd1f0ec7c4deb8e15c8f`；主 Agent 整合至原 `i0/ui-frontend`。

## 1. 依据与授权

已从 README/AGENTS 进入并读相关正文：PRD §3、§4.2、§5、§8；MVP_SPEC §2、M-03/04/05/10、§4/5/6（AC-02/03/04/06/11/15，NFR-04/05）；TECH_DESIGN §3.3、§4.1/4.3/4.4、§5/5.1、§7.1/7.3/7.4/7.5、§9/11；TEAM §1/2；I0_UI_SPEC 的 Implementation/Testing Decisions；I0_UI_CLIENT_CONTRACT §2/3/5/6/7/8；IMPORT_SOURCE §1。当前较新范围取主分支计划 §10.1/10.3/11，不以历史摘要或旧“待交接”停工。

2026-10-13，Robert 对 §10.3 具体提案表示“你自己看吧。如果是真的需要做的你就做”；主 Agent 判断最小真实入口为必要并委派本工作树独立实施。固定 [PR #53 候选](https://github.com/paher-din/XunJie/tree/c071b4d0874c8cb1e8b83c95108fda2519a30cf0) 已有 `GET /api/assignments/:id/bootstrap`，返回 `{assignment,recoveryGeneration}`；其 `assignmentBootstrapSchema` 与路由授权正文已核对。候选不等于已合并或可用宿主，正常组合和实际 HTTP/Chrome 联调由主 Agent 负责。

## 2. 写集与方案

可写：`apps/student/src/pages/TaskRoute.tsx`、原 `PrepWorkspacePage.tsx`、`components/workspace/TextScopePanes.tsx`、`workspace/init.ts`、`useWorkspaceInit.ts`、`contracts.ts`，及对应初始化单测、`e2e/real-mode.spec.ts`；另维护本记录。

只读：所有 tutor/control/fixture/backend 模块、package/lock/config/schema、README、受保护产品/计划/参考文档及 AGENTS。与主及其他 workers 的写集分开。不安装依赖，不合并他人 Draft，不写凭据/CI，不变更任何数据库结构。

沿既有 `#/task/:taskId`，保留 Design 原演示任务，真实分配深链复用现有 C 页面，不新增页面/导航或分配列表。真实顺序为 Session → 深链 Assignment bootstrap → 固定 Activity → 可见 Resource；身份、课程学生角色、分配/活动 ID、受信代际逐项核对，任何 await 后核失效上下文。缺入口或失败不回准备 fixture，不构造代际。载入只读；首次 Attempt 由学生显式创建，使用 bootstrap 代际；原确认客户端按同身份/分配/代际本机引用重读已有 Attempt，不猜其他设备作品。真实模式不显示合成标识或静态正式 ID。

## 3. 验收与交付状态

计划验证：初始化的匿名/跨学生/非学生成员/错误引用/缺代际/迟到响应拒绝；读入无写操作；暂停分配不可创建；学生显式创建使用原请求/CSRF/代际；同本机可信 Attempt 恢复与账号隔离；真实读取失败不转 fixture；原数字逻辑路由保留；生产 bundle 无准备端点、合成身份与固定准备场景常量。

仅使用现有 lock 和已建 `node_modules` junction。先相关 unit/typecheck/build，再独立端口 5641/5642 的真实 Chrome 协议反例浏览器检查；模拟 API 的通过仅证明前端，不标真实宿主/TLS/节点/模型/真人或完整 AC/NFR 通过。实际命令、结果与未验随后追加；产品/契约基线汇总为“待授权维护者汇总”。

## 4. 2026-10-14 实施结果与交接

状态：`implemented / protocol-verified / pending-host-integration`。`TaskRoute` 保留 `demoTasks` 的原八个 Design 深链，其他 normal-mode 深链以 taskId 为 Assignment 引用进入原 C 页面；按 taskId 挂载独立页面实例，换任务清除旧内存。深链不表示授权，实际读取与命令仍由宿主 Session/成员/本人分配守卫决定。没有硬编码正式对象、另建路由/导航或假列表。

`loadWorkspaceInit` 正常模式从 Session 核 userId/courses/CSRF，再读固定 bootstrap、学生视角活动和按公开投影的可读材料；逐 await 保留原 ContextGuard 和读轮次，错分配/跨学生/非学生课程/错活动或控制版本/缺代际拒绝。准备登录和元信息读取用 PREP_BUILD 静态守卫。恢复只沿原确认模块同模式、本人、Assignment、代际本机引用 GET 验证，不承诺其他设备发现 Attempt；bootstrap 不新增 Attempt 字段。暂停分配首次开始禁用，已有 Attempt 仍沿原暂停保存语义。真实退出失效旧作品并只重读 Session，不自动登录。

顶栏、任务信息和中心内容按构建模式展示。真实页不显示合成标识、场景或账号；活动正文、课程和政策来自返回投影。原 CodeWorkspace/Confirmation/Run/Tutor 客户端复用，没有写其模块。没有自动创建、保存、快照、求助或运行；浏览器协议样例中创建是测试操作明确点击，不计真实学习行为。

已执行命令（学生目录；Node v24.15.0，原 lock 依赖）：

```powershell
rtk npm run typecheck
rtk npm test
rtk npm test -- src/workspace/init.test.ts
rtk npm run build
$env:XUNJIE_E2E_BROWSER_CHANNEL = 'chrome'
$env:XUNJIE_E2E_PREP_PORT = '5641'
$env:XUNJIE_E2E_REAL_PORT = '5642'
rtk npm run test:e2e -- real-mode.spec.ts prep.spec.ts --workers=1
```

全量单测首轮 30 文件/333 项通过；随后仅因新增活动/材料反例复跑初始化 16/16（首轮为 13 项，新增 3 项），其余 320 项未重复运行。最终 typecheck/build 退出 0。Chrome 155.0.8059.40 对应浏览器组合 17/17 通过：原准备 10 项、normal 边界/数字逻辑 3 项、real 入口协议替身 4 项；实际操作与本机 IndexedDB 覆盖首次创建、原请求摘要/CSRF/代际、同本机刷新恢复、退出清除、暂停创建拒绝、缺代际与跨学生拒绝。重跑的 7 项 real 检查不重复计数。未启动教学服务、未验正常 HTTPS/TLS/节点/模型/真人。执行学生工程的 Node 版本不当作教学服务精确 Node 验收。

中间失败保留：首轮 real 入口一项在任务信息浮层仍打开时点击顶栏退出，被遮罩阻挡而超时（其他 6 项通过）；检查按原 UI 的 Escape 关闭后点击，最终 7/7 及上述 17/17 通过，没有强制点击、取消可见性或关闭检查。构建大 chunk 与开发品牌 public 导入提示是既有提示，未更改配置/依赖来隐藏。

生产产物扫描：`rg -o '__i0prep|prep-student-01|prep-resource-[a-zA-Z0-9-]+|i0-prep-textscope-c|syntheticAccount|PREP_TASK_ID|prep-assignment-textscope-c-01' dist -g '*.js'`。没有准备端点、固定合成账号/准备任务或分配 ID；**发现两个原模块残留，不能报告所有准备常量全清理**：

- 原 `workspace/confirmationWorkspace.ts` initialize 的准备恢复回调仍带 `syntheticAccount` 属性名（无账号/密码字面值），按 context.mode=preparation 才可触发；正常初始化恒 real。建议主在此原分支增加 PREP_BUILD 静态守卫。
- 原 `workspace/tutoringReturn.ts` 的 `resolveTutoringResource` 保留 `prep-resource-adjacent-example-01` 判断与准备材料标签，正常 mode=real 不采用它。建议负责该模块的主为 synthetic 判定及准备 sourceLabel 分支加 PREP_BUILD 静态守卫并复核正式产物。

这两个模块不在本 worker 写集且有并行修改，已保持只读，交主整合消除残留；不能跨写覆盖。生产产物当前可用于主受控合成实际宿主联调，完整产物隔离收口仍待此窄补齐。真实数据/供应商/公开部署均未授权或执行。

仓库根 `node tools/a0-review/check.mjs` 首次为 73 文档/1053 内链、errors=[]；最终复查和提交随后记录在交付消息。`git diff --check` 通过。只暂存以上七个既有文件、初始化单测与本记录；工作树保留，未推送、未合并主分支或 PR。本批无需安装或迁移，未生成临时探针/配置，浏览器服务随 harness 退出。
