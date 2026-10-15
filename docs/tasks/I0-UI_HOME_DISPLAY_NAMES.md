# I0-UI：首页显示姓名与课程名

日期：2026-10-15（Asia/Shanghai）。主责：UI / Robert；分支：`i0/ui-frontend`，起点 `c43e010`（PR #86）。

负责人要求：首页招呼语及课程卡使用正常人名/课程名，隐藏本机 `synthetic-robert` 测试ID，真实账号与任务接线保持原样。沿用本会话推送、PR、合并授权。

已读 README、根规范、PRD §3.2/4.2、MVP_SPEC §2、TECH_DESIGN §3.3/5、I0_UI_SPEC/客户端约束§2、DESIGN组件及来源规则、IMPORT_SOURCE与前批记录。范围仅显示文案，不改共享身份契约或产品基线。

可写：首页、侧栏/菜单/头像的账号显示、共享显示名映射、现有首页浏览器验证、本任务与清单、IMPORT_SOURCE。其余源码/后端、schema、依赖及产品/规划/参考/规范只读；保留无关 `.zcodeignore`。

实施：本机student-a显示Robert，student-b显示小林；C显示“程序设计基础”，HDL显示“数字逻辑与部件设计”。同一映射用于招呼、侧栏账号、课程卡、课程面包屑与看板任务标签，支持按显示课程名搜索。显示别名不冒充后端档案字段；其他账号/课程保留原有显示。Session、API路径、URL参数、路由、React key和本机隔离键继续使用原ID；不改密码、权限、库或任务数据。

已完成验证（Node24.15.0 / Chrome155）：`rtk npm run build`类型/正常构建通过。独立5701/5702/5703端口，`XUNJIE_E2E_BROWSER_CHANNEL=chrome`、`CI=1`，运行 `node node_modules/@playwright/test/cli.js test homeEntry.spec.ts prep.spec.ts --grep '真实首页|没有学生课程|列表故障|列表401|首页准备入口|姓名与课程别名' --workers=1`，首轮5/6通过；新增别名用例在路由变更后立刻核bootstrap请求，早于异步读取，补等既有工作区响应后只重跑该例1/1通过。六项已验证，未扩大其他测试。

别名用例核招呼/头像/菜单、课程中文名与中文课程搜索，并核Session仍是原synthetic账号、URL仍带原courseId、bootstrap仍使用原assignmentId。其余例覆盖故障/空列表、会话过期及账号切换、原准备入口。前端协议/fixture检查与下述本机真实宿主复验分开。本次显示文案不另建纯函数单测，不重跑执行或模型；保留既有构建体积/public品牌JSON开发提示。

## 本机复验与交付

源码 `ed1d408`；正常入口 `/assets/index-DcpLvnIQ.js`，SHA256 `2b43259aab1ec03117ce0af2a82038e8bd17aa6d807b65bdc52d56675476aa39`。只替换原WSL静态构建，旧index备份 `/opt/xunjie-ui-local/index-before-home-display-names.html`，旧资源保留，恢复index可回滚；后端、配置、账号和数据库均未改。

原HTTPS浏览器及已登录账号刷新：招呼“下午好，Robert”、侧栏Robert/头像R、看板标签“程序设计基础”、两课程卡“程序设计基础/数字逻辑与部件设计”。点击C课程后面包屑显示中文名，URL仍为原 `?course=synthetic-robert-course-c`，任务标题/目标仍来自原分配。返回留在首页。正文中不再出现synthetic-robert，不改任务作品或发起运行/模型。

证据：[首页截图](evidence/ui-home-names-20261015/home.png)、[浏览器事实](evidence/ui-home-names-20261015/browser-facts.json)。本批显示核对完成；协议验证和真实宿主页面观察分别记录，无剩余功能项。

`node tools/a0-review/check.mjs`：126篇、1941条内部链接、`errors=[]`；`git diff --check`通过。交付：[PR #87](https://github.com/paher-din/XunJie/pull/87)，沿负责人授权推送并合并main，保留前端分支。

产品基线及 MVP_SPEC §10：待授权维护者汇总。

## 同日补充：项目显示名与成员电脑差异核查

负责人本轮要求仅将看板/任务卡中的“TextScope Core 本机合成工程验证”改为正常项目名称，原真实任务/接口不变。沿上述显示层范围，把该固定旧标题显示为“文本分析工具”，保留其他项目原名和原响应；同步匹配显示标题的搜索。可写仍为 `displayNames.ts`、`HomePage.tsx`、原首页用例、本记录/来源/清单；不改后端、活动正文、分配或作品。

本轮只构建与独立端口验证，不替换3444静态目录、不刷新共享应用内标签：个人模型配置会话正在统一集成并验证该宿主，保持既有协作边界。

成员电脑差异目前可核实的机制：真实首页按Session本人课程及分配读取；本机种子让A/B都有两门成员课程，但C分配给A、HDL分配给B（另有B的全输入补验）；准备/Design模式是三课程八演示任务。Git代码、实际静态构建及各机数据库分别存在，拉代码不自动同步数据；两台机器各自的127.0.0.1指向各自本机。显示别名不改变课程或任务数量。负责人尚在询问成员的URL/账号，具体差异原因保持待核实。

验证：`rtk npm run build`类型及正常构建通过；独立5701/5702/5703端口、Chrome通道和CI=1，`node node_modules/@playwright/test/cli.js test homeEntry.spec.ts --grep '姓名与课程别名' --workers=1` 定向1/1通过，核两个标题、中文项目名搜索，以及原账号、courseId、assignmentId/bootstrap路径不变。无本轮验证失败，未重跑其余无关检查，也未做3444浏览器验收或部署；成员差异仍等对方信息，不能算已定位。
