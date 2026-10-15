# I0-UI：首页显示姓名与课程名

日期：2026-10-15（Asia/Shanghai）。主责：UI / Robert；分支：`i0/ui-frontend`，起点 `c43e010`（PR #86）。

负责人要求：首页招呼语及课程卡使用正常人名/课程名，隐藏本机 `synthetic-robert` 测试ID，真实账号与任务接线保持原样。沿用本会话推送、PR、合并授权。

已读 README、根规范、PRD §3.2/4.2、MVP_SPEC §2、TECH_DESIGN §3.3/5、I0_UI_SPEC/客户端约束§2、DESIGN组件及来源规则、IMPORT_SOURCE与前批记录。范围仅显示文案，不改共享身份契约或产品基线。

可写：首页、侧栏/菜单/头像的账号显示、共享显示名映射、现有首页浏览器验证、本任务与清单、IMPORT_SOURCE。其余源码/后端、schema、依赖及产品/规划/参考/规范只读；保留无关 `.zcodeignore`。

实施：本机student-a显示Robert，student-b显示小林；C显示“程序设计基础”，HDL显示“数字逻辑与部件设计”。同一映射用于招呼、侧栏账号、课程卡、课程面包屑与看板任务标签，支持按显示课程名搜索。显示别名不冒充后端档案字段；其他账号/课程保留原有显示。Session、API路径、URL参数、路由、React key和本机隔离键继续使用原ID；不改密码、权限、库或任务数据。

已完成验证（Node24.15.0 / Chrome155）：`rtk npm run build`类型/正常构建通过。独立5701/5702/5703端口，`XUNJIE_E2E_BROWSER_CHANNEL=chrome`、`CI=1`，运行 `node node_modules/@playwright/test/cli.js test homeEntry.spec.ts prep.spec.ts --grep '真实首页|没有学生课程|列表故障|列表401|首页准备入口|姓名与课程别名' --workers=1`，首轮5/6通过；新增别名用例在路由变更后立刻核bootstrap请求，早于异步读取，补等既有工作区响应后只重跑该例1/1通过。六项已验证，未扩大其他测试。

别名用例核招呼/头像/菜单、课程中文名与中文课程搜索，并核Session仍是原synthetic账号、URL仍带原courseId、bootstrap仍使用原assignmentId。其余例覆盖故障/空列表、会话过期及账号切换、原准备入口。前端协议/fixture检查与下述本机真实宿主复验分开。本次显示文案不另建纯函数单测，不重跑执行或模型；保留既有构建体积/public品牌JSON开发提示。

随后更新本机静态页面并保存姓名/课程名显示证据。

产品基线及 MVP_SPEC §10：待授权维护者汇总。
