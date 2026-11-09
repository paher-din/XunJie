循阶（XunJie）是面向高校课后教学的 AI 项目学习空间，教师与 Agent 共同设计项目，学生在动手实践、就地求助与反馈修订中学习。

## 常用命令
- 已有本机产品环境时，改正式界面优先 `npm run dev:product`
- 旧版 UI 预览 `npm run dev:prep -w @xunjie/web`（组件实屏为 `/ui-catalog.html`）；
- 统一检查 `npm run typecheck`、`npm test`、`npm run build`
- 完整门禁 `npm run verify`（`-- --list` 查阶段，`-- --group <prepare|unit|server|tools|tests>` 跑单组）
- 浏览器验收入口 `npm run test:e2e -w @xunjie/web
- 后端  `npm run build`  `npm start -w @xunjie/server

## 执行与协作
- 开始前检查 Git 状态、相关差异和目录规范
- 保留无关改动，不覆盖、回退、暂存或提交他人的工作
- 涉及开发环境启动、本地/云端切换、成员接入、数据基线或复现交接时，先读 [xunjie-development](skills/xunjie-development/SKILL.md)，据当前工具状态选择操作
  
## UI
- **UI 设计必须遵循根目录 [DESIGN.md](DESIGN.md)。** 修改页面、组件、布局、配色、字体、间距或动效前，读取其中相关规范并复用现有设计 token。
- **正式 UI 组件库：** 做界面或迁移旧版 UI 时，先查 [组件库入口与覆盖清单](packages/ui/README.md)，从 `@xunjie/ui` 的功能子路径使用或补充组件，并按目录中的实屏示例核对状态。组件库的实现、样式和资源须能脱离旧页面使用；业务数据与操作由调用方接入。
- **外部 UI 资源库：** [Astryx](https://astryx.atmeta.com/docs/working-with-ai) 和 [shadcn/ui](.agents/skills/shadcn/SKILL.md) 供 Agent 在 UI 设计与组件开发时按需搜索、比较和选用组件及设计参考，采用的可复用组件按 `DESIGN.md` 适配后纳入 `@xunjie/ui`，由业务页面通过其功能子路径使用。
- 沿用已确认的产品 UI、导航和可复用组件，在对应位置增补新能力、改造接口并删除已被替代的旧实现；不得因底座重构或新能力接入另造一套简化或并行的产品 UI。

## 验证与交付
- 普通 UI 迭代使用开发预览，仅在安装、产品包或跨平台验收及交付需要时打包；每次任务结束及时清理无用包，保留运行中和待验收的产物
- 浏览器验收只要求桌面 Chrome，覆盖本次改动涉及的目标平台与连接路径
- 从相关工程的 `package.json`、配置和测试文件选取与改动相称的检查。可逆、低影响或只复述实现的改动不另写测试；检查通过后仅因新改动、失败或未解疑点扩大验证
- 产出前明确实际消费者及用途；没有消费者的日志、报告、截图或文档不生成。仅保留明确会被后续使用的最小结果，历史引用或“可能有用”不构成保留理由
- 任务收尾停止临时进程，清理无用日志、诊断、旧验收产物和临时环境；可运行 `npm run clean:verification` 清空 `.verification/`，确需保留的路径用 `-- --keep <相对路径>` 指定。Agent 也应随用随清，不等到目录堆积后再处理
- 交付说明改了什么、验证结果、失败或未执行项及剩余工作。分别报告工程测试、浏览器验收；跳过不算通过

## 其他
- `docs/archive/` 仅保存历史材料，已停止使用和维护。默认阅读、搜索、规划、实现和审查均排除该目录；只有用户明确要求追溯历史时才读取
- 密钥、token、密码不进入代码、提交或日志
