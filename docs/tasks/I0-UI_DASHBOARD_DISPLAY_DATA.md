# I0-UI：学习看板真实数据核查与演示展示

日期：2026-10-15（Asia/Shanghai）。主责：UI / Robert；分支：`i0/ui-frontend`。起点为 PR #85 合并提交 `f6e8d08`。

## 依据与范围

负责人本轮要求：检查现有后端完成率/学习时长数据，有的直接接；没有则允许虚构数据供看板展示。这明确调整上一批“缺统计保持未知”的展示要求，仅用于前端看板演示，不建立或伪造学生学习记录。保留原 Design 组件及真实课程/分配/入口；沿用本会话推送、PR、合并授权。

已读 README、根规范、PRD §3.1/3.2/4.2（真实行为与判断区分）、MVP_SPEC M-05/06/07、TECH_DESIGN §3.3/4/5.1、I0_UI_SPEC 与客户端约束§2、本地 DESIGN 原组件/来源规则、IMPORT_SOURCE、上一批看板接回记录。DESIGN 中“不得用演示数据填补”的旧默认在本次明确授权的看板展示范围内由当前指令覆盖；不改产品基线与规范。

可写：原首页/看板及对应验证、README/学生README/IMPORT_SOURCE、本任务和当前清单。后端、schema、依赖、AGENTS、产品/规划/参考文档只读；保留无关 `.zcodeignore`。不修改源 Design 仓库。

## 当前后端核查

- 当前35表宿主 `apps/teaching/server/app/digital-logic.ts:49` 经 tutoring/records 组合 workspace，未挂载 review；§68–76 的课程/本人分配仅含标识、active、executionKind。`apps/student/src/workspace/home.ts` 已读取这些真实字段及固定活动标题/目标。没有看板、完成汇总或活跃时长 API。
- `workspace/commands.ts:239` 返回已知 Attempt 的状态/运行/检查/固定提交，无完成率、时长；Attempt 的 submitted/reviewed、运行成功均不等于任务已完成。首页分配/bootstrap也没有全量Attempt发现引用。
- `workspace/application.ts:317` 与 `records/teaching.ts:627` 的 coverage 是采集开关覆盖区间；Job时间、模型耗时也不代表学习活跃时间。`records/application.ts:151–194` 的 events GET 会协调教学投递，不用于统计采集。

结论：保持已有真实分配读取，没有可以额外直接接入的完成率/时长字段。演示统计仅在浏览器原看板绘制，不调用统计写入、采集、模型或执行接口。

## 实施与验收

方案：复用 Design 原 `demoDashboard` / `demoTasks` 展示完整原看板，标题标“演示统计”；真实分配数另列，不把演示完成数与真实分母拼接。内嵌入口仍打开本人真实获准任务，不用演示任务替换列表或创建学习记录。原每日/每周、编辑与托盘均保留。

已完成（Node24.15.0 / Chrome155）：

- `rtk npm test -- src/components/dashboard/widgets.test.ts`：5/5，含演示3/8=37.5%与真实1个分配独立显示，原未知/真实0分支保留。
- `rtk npm run build`：类型检查及正常构建通过；保留既有大块体积提示。
- 独立端口5701/5702/5703、`XUNJIE_E2E_BROWSER_CHANNEL=chrome`、`CI=1`，`node node_modules/@playwright/test/cli.js test homeEntry.spec.ts prep.spec.ts --grep '真实首页|没有学生课程|列表故障|列表401|首页准备入口' --workers=1`：5/5，含演示标识、每日热力/每周曲线、XP原托盘、真实课程搜索/进入、空与故障不补演示任务、登录过期及换账号布局隔离。前4例为公开HTTP响应替换的前端协议验证，准备首页1例用原fixture；不计真实宿主验收。既有品牌public JSON开发提示未改。
- 窄审查未发现需修复项：未混用完成数/分母，未改变真实列表或权限，未新增统计请求/业务写入。

## 本机正常HTTPS复验与交付

源码固定 `cf6eaa6`，入口 `/assets/index-C9P8IzGF.js`，SHA256 `f11c2c44a8c7469eb47cb18b1eaa6994b1282b43dec3ae1bb03c284d9e1ed904`。只将正常构建复制到原WSL静态目录，旧index备份 `/opt/xunjie-ui-local/index-before-dashboard-demo-statistics.html`，旧hash资源保留；恢复旧index即可回滚。未重启或修改后端、数据库、VM、配置、凭据。

原 `https://127.0.0.1:3444`、原已登录合成账号 `synthetic-robert-student-a` 刷新：显示“演示统计”、独立的“真实分配1个任务”、演示完成3/8=37.5%、每日热力20列及每周时长曲线。真实C/HDL课程仍分别1/0个本人分配；内嵌入口仍显示真实C标题/目标，没有演示任务入口混入课程列表。最终留在每日首页，未发起学习输入/保存/运行/求助。本次观察证明显示与数据来源区分，不证明真实学习完成率或时长。

证据：[每日首页](evidence/ui-dashboard-display-20261015/home.png)、[每周曲线](evidence/ui-dashboard-display-20261015/weekly.png)、[浏览器事实](evidence/ui-dashboard-display-20261015/browser-facts.json)。

本轮未出现实现/验证失败，没有本批未完成项；模型/执行器回归未执行，复用原交付。`node tools/a0-review/check.mjs`：125篇、1938条内部链接、`errors=[]`；`git diff --check`通过。交付为[PR #86](https://github.com/paher-din/XunJie/pull/86)，沿负责人授权推送并合并main，保留前端分支。

产品基线及 MVP_SPEC §10：待授权维护者汇总。
