# I0-UI：首页真实任务入口

日期：2026-10-15（Asia/Shanghai）。主责：UI / Robert；分支：`i0/ui-frontend`。

## 1. 依据与批准范围

Robert 本轮明确要求：开始首页真实任务入口，只做必要接线，完成后更新清单、推送 PR 并合并。原登录批次只含授权深链；本批是新增首页发现入口，不把它追记为原批次漏交。

已读正文：README；PRD §3～5、§8（PRD-02/03/10）；MVP_SPEC §2、M-02/03/10、§4～6（AC-02、NFR-04/05、DL-AC-01）；TECH_DESIGN §4.3/4.4、§5/5.1、§9；TEAM_WORK_PLAN 的 P3 当前比赛安排；I0_UI_SPEC 的范围/实施与验证约束、I0_UI_CLIENT_CONTRACT §2/3/7/8；IMPORT_SOURCE、原会话入口任务与当前收尾清单。

可写：学生首页及窄读取客户端、与本批相称的浏览器检查、根/学生/本机工具 README 的实际使用说明、本任务和 I0_REMAINING_WORK_CHECKLIST。只读：后端、产品/规划/参考基线、规范与其他成员任务。保留无关 `.zcodeignore`。

## 2. 最小方案与验收

- 沿用现有首页课程/任务卡片和 `/task/:assignmentId` 路由。课程直接复用真实 Session 的 `courses`（与既有 `GET /api/courses` 同字段，省去重复读取）；分配与标题消费当前35表两课程宿主的 `GET /api/courses/:id/assignments` 与 student 活动投影。只列学生角色的课程，教师角色的全班分配不进入学生首页。
- 标题取固定活动公开 `projectTitle`；课程接口只有 `courseId`，按真实课程标识展示，不借演示课程名补齐。暂停分配标明暂停，查看仍交由原工作区授权/阶段规则处理。
- 正常首页不显示演示看板、演示任务、无来源的完成度和截止时间。准备模式保留原设计演示。列表加载、空结果和失败分别呈现，可明确重试；不回退 fixture。
- 复用现有会话 HTTP 代次、React Query 会话清理和按身份分键，验证换账号与迟到列表不会混入新账号。首页 GET 不创建 Attempt、不保存、不运行、不调用模型。
- 验证：类型检查/正常构建；浏览器覆盖两课程进入/返回、真实标题/暂停状态、空列表/失败重试、会话过期与账号切换隔离。已完成的 C/HDL 执行链不重跑。

当前35表宿主已挂载列表；旧 C-only 宿主未提供列表，本批不扩后端，实际失败保持可见，原授权深链可继续使用。未提供的新课程名/统计字段不作为本批后端前置。

## 3. 实现与验证记录

实现：`apps/student/src/workspace/home.ts` 读取本人分配与固定活动标题，核所属学生/课程/活动；`pages/HomePage.tsx` 在正常模式接真实课程/任务，保留准备首页与原卡片样式。查询按账号和 Session epoch 隔离，复用原 HTTP 迟到响应拒收。`e2e/sessionEntry.spec.ts` 的既有协议替身补合法空列表响应，避免把新读取误回为匿名401。

已执行（Windows Node v24.15.0 / 既有 Chrome）：

- `rtk npm run typecheck`、`rtk npm run build`：退出0；原大 chunk 提示保留。
- `rtk npm test`：43文件 / 573项通过。
- `rtk npm run test:e2e -- homeEntry.spec.ts --workers=1`：4/4通过，覆盖两课程/返回/暂停、教师角色排除、空态、503重试、401及换账号迟到列表。不含真实后端成功声明。
- `rtk npm run test:e2e -- sessionEntry.spec.ts real-mode.spec.ts prep.spec.ts --workers=1`：19/20；唯一失败在准备首页用例关闭 trace 时，共用输出目录被并行专项清理，出现 ENOENT，非业务断言失败。改用独立输出目录，仅复验该例 `-- prep.spec.ts -g '首页准备入口' --workers=1 --output=test-results-home-prep`：1/1通过。其他19项未重复运行。

浏览器测试均使用 `XUNJIE_E2E_BROWSER_CHANNEL=chrome`；新专项的默认 bundled Chromium 首次启动因本机未安装浏览器而失败，未执行断言，改用已有 Chrome，没有安装依赖。新专项中一处“重试次数”断言最初把导航后合法重新读取也计入，移到导航前后最终4/4；没有修改实现或取消读取来迁就断言。既有 public 品牌 JSON 导入与 NO_COLOR 提示保留。

真实宿主复验与 PR 回执在下节追加。产品基线及 MVP_SPEC §10：待授权维护者汇总。
