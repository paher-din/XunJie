# 循阶正式 UI 组件库

`@xunjie/ui` 是循阶前端的组件、设计样式和视觉资源的正式来源。设计依据为根目录 [DESIGN.md](../../DESIGN.md) 和已确认的旧版界面；业务数据、持久化、路由及网络操作由使用组件的应用提供。

## 找组件

按用途导入子路径，避免把整个工作区或教师端加载进简单页面：

| 子路径 | 范围 |
| --- | --- |
| `@xunjie/ui/foundation` | 按钮、通用选择菜单、进度、账户、外壳、会话历史和通用交互 |
| `@xunjie/ui/feedback` | Sonner 通知入口、通知宿主和操作反馈 |
| `@xunjie/ui/icons` / `@xunjie/ui/brand` | 图标、Logo、角色及其资源 |
| `@xunjie/ui/home` / `@xunjie/ui/dashboard` | 课程任务与学习看板 |
| `@xunjie/ui/chat` | 对话消息、卡片、Markdown、附件及相关状态 |
| `@xunjie/ui/settings` | 设置布局、字段和设置视图 |
| `@xunjie/ui/workspace` | 工作区工具、操作与展示 |
| `@xunjie/ui/teacher`、`teacher-shell`、`teacher-design`、`teacher-review` | 教师端基础控件及具体教学界面 |

完整导出以 [package.json](package.json) 和各组 `index.ts` 为准。迁移完成度和旧版来源见 [首页／对话／看板](src/home/COVERAGE.md)、[设置](src/settings/COVERAGE.md)、[工作区](src/workspace/COVERAGE.md)、[教师基础](src/teacher/COVERAGE.md)、[教师外壳](src/teacher-shell/COVERAGE.md)、[教师设计](src/teacher-design/COVERAGE.md) 和 [教师审阅／材料](src/teacher-review/COVERAGE.md)；未完成项不能因旧路径存在兼容导出而视为已迁入。

`npm run list:components -w @xunjie/ui` 输出正式组件名、导入路径和源码位置；`npm run --silent list:components -w @xunjie/ui -- --json` 可供工具读取。
`npm run check:catalog -w @xunjie/ui` 检查正式导出是否均有登记示例；组件目录的每个详情页还给出属性、依赖、源码和可直接打开的状态链接。

## 样式与资源

在应用入口加载一次：

```ts
import '@xunjie/ui/styles.css'
import { Button } from '@xunjie/ui/foundation'
```

样式入口按顺序加载 token、字体、现役共享样式和图标样式。它包含全局元素与布局规则，宿主应检查和其他全局样式的加载顺序。浅色／深色由根元素的 `data-theme` 和 [tokens.css](src/styles/tokens.css) 控制。教师页面的专用样式从 `@xunjie/ui/styles/teacher/` 下按场景引入；具体组件另有独立 CSS 时由其模块引入。

图标 SVG、角色图片、Logo 原稿和霞鹜文楷字体随本包提供；字体许可见 [OFL.txt](src/assets/fonts/OFL.txt)，图标来源见 [ATTRIBUTION.md](src/icons/ATTRIBUTION.md)。本包不依赖旧版 Web 的 `public` 目录。

`SettingsEmptyState` 采用 shadcn/ui Empty 的图标、标题、说明和操作分层，已适配循阶 token，无 Tailwind 运行依赖；来源与许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。实屏目录提供空态示例。

`SkillListItem` 用 40px 中性拼图图标、15px／500 名称和 13px 单行简介组织技能条目，相邻行用虚线分隔；窄窗口将图标收至 32px。右侧依次为三点菜单与 `Toggle`，菜单提供文件图标的“打开”和垃圾桶图标的红色“删除”；Base UI portal 负责菜单避让与键盘操作。`SkillDocumentDialog` 复用受控 Markdown 渲染器阅读文档，开头元信息以 YAML 代码块完整显示，文件内容不变；代码和表格各自滚动。阅读界面保留文档与更新入口。本地技能的导入和更新统一选择技能文件夹，来源和版本由调用方维护。本地导入在选定文件夹后立即开始，处理中由原按钮反馈，成功后刷新列表。启停成功使用固定位置通知，启用为绿色勾选、停用为中性圆圈减号图标；保存与刷新不向列表追加状态块，失败后才显示重试。关闭阅读或取消删除返回原触发器，成功删除返回搜索入口；目录包含交互和阅读状态示例。

技能页面的调用方在打包前排除 `.git`，自动识别目录中的独立技能，逐个打包导入；已有 `SKILL.md` 的文件夹拥有整个子树，嵌套技能文档作为附件保留。单个技能的格式错误不阻断其他技能，部分完成时由 `SkillImportFeedback` 提供未完成项与重试入口；网络结果不明时暂停，优先沿原输入与请求 ID 确认该项，再继续其余项。服务端按来源、文件相对路径和字节内容合并重复导入，保留已有启停状态；显式更新仍发布新版本。

阅读窗口中的“更新技能”按来源直接操作：本地技能打开目录选择器，选定后立即替换；GitHub 技能读取原仓库默认分支的最新提交，并保留原技能目录。窗口保留当前正文，更新后刷新文档；取消选择或失败不关闭窗口，错误就近显示，结果不明时沿原请求重试。成功使用绿色勾选的“已更新”通知，更新保留原启停状态。

学生端通知统一使用 `@xunjie/ui/feedback`：应用根挂载一次 `Toaster`，操作回调使用 `toast.success()`、`toast.error()`、`toast.info()` 或 `toast.warning()`；已有异步状态可用 `useToastFeedback(message, kind)` 接入，避免轮询和重绘重复通知。通知采用 shadcn/ui Sonner，顶部居中，采用 `raised` 底色、`ink` 文字和 `line` 描边，跟随浅色／深色主题，支持关闭、堆叠、键盘和减少动效。任务进度、作品冲突及续办操作仍在各自内容区域呈现。

`ModelTestButton` 复用次级 Button，以链路和运行图标分别标识连接测试、模型测试；测试中原控件转为停止操作，保留尺寸与焦点。列表可用 `iconOnly` 显示 32px 单图标按钮，带悬停提示与无障碍名称；弹窗继续使用文字按钮。`ModelTestFeedback` 将测试结论、处理建议及可复制诊断留在操作附近，失败和部分完成使用已适配的 Astryx Banner；通知由调用方在终态发送一次。供应商拉取结果与预设型号共用 `ModelChoiceCard`，默认不勾选且折叠，勾选不移动或展开卡片，点击标题展开配置。编辑供应商时，已有型号均默认收起；勾选只决定是否保留型号，与设置页的启用开关独立。已有型号可取消勾选并在保存时移除，重新勾选恢复当前草稿；空供应商继续保留身份与密钥。搜索、拉取状态、去重与 64 个模型的选择限制由调用方接入。新建自定义供应商不生成占位模型，输入 ID 添加后才出现配置卡。`ConnectionModelFields` 可接入文本固定、图片可选的能力字段。组件目录提供各状态的合成示例。

列表与配置弹窗使用同一 `ModelTestFeedback` 排版：失败保留原因、处理建议、重试和折叠诊断；成功仅展示结论，不追加已通过的配置校验、文本／图片阶段或思考资料状态。测试接收前因本机频次或并发被拒绝时，只发送一次通知，不生成重复结果卡片；已有真实测试结果仍就近保留。

正式模型设置的排序由调用方维护：编辑弹窗首次显示已选型号的加入倒序，其后为按型号 ID 自然排序的未选候选；本次编辑中保留卡片位置，手动新增才立即置顶展开。设置页每次进入时将启用供应商放在前面，按加入先后排列；停用供应商按关闭先后排列。供应商内启用模型在前，停用模型在后，各组按型号 ID 自然排序；当前页面的启停与轮询不移动已有行，下次进入才重排。设置页的显示排序不会改写弹窗保存的型号加入顺序。

`ModelProviderCard` 的 `compact` 模式将供应商图标、名称和操作居中对齐，`logo` 与 `footer` 由调用方提供。模型列表单独使用圆角实线外框，仅相邻模型之间使用虚线；供应商标题与底部添加操作位于列表框外。`ModelProviderModelRow` 将模型名称、非默认思考强度、测试图标及独立开关组织为紧凑行；测试图标悬停使用底色高光、不加描边，长名称省略并保留完整提示，窄容器允许操作换行，反馈在对应模型下方展开。正式模型设置保留供应商和模型两级启停，底部以文字操作添加模型。目录覆盖多模型、六模型长名称、停用、测试中与失败诊断；业务请求和状态仍由调用方维护。

`ShellFrame` 提供 `onCollapsedChange` 时启用调宽：采用 Astryx 短竖条与指针捕获交互，使用循阶 token 和现有 60px 图标轨道。默认宽 248px，展开最小 152px，最大为 360px 与容器宽度 40% 中较小者（不低于 152px）。拖到 96px 时即用 240ms 平滑收至 60px 图标轨道，反向拖到 112px 时直接接续展开，无须松手。两个阈值之间维持当前吸附状态；动画中可反向打断，过渡区同步交接导航透明度。双击或 Enter 切换收起，方向键调宽，Home 收起，End 调至上限；展开宽度只在本次外壳挂载期间保留。来源与许可同见第三方说明。

拖动时即应用展开宽度约束，松手不再改写已经显示的位置。失去指针捕获、系统取消或离开拖动模式都保留最后选择，仅 `Escape` 主动撤销；发生位移的拖动及其后紧接的一次点击不触发双击折叠，真正的双击仍可切换侧栏。

测试按钮使用 Base UI Tooltip 展示范围说明，采用 `inverse` 深底、白字、8px 圆角，支持鼠标悬停、键盘聚焦和 Escape 收起。成功反馈隐藏诊断及重复分项行；失败和部分完成保留可复制诊断与分项结果。

## 实屏目录与检查

从仓库根目录启动 `npm run dev:prep -w @xunjie/web`，访问 `http://127.0.0.1:5601/ui-catalog.html`。目录使用正式包的真实组件和隔离示例数据；每个示例的稳定入口与覆盖情况以目录注册表为准。目录用于开发验收，不是学生或教师的产品入口。

在仓库根目录运行：

```sh
npm run typecheck -w @xunjie/ui
npm run check:boundary -w @xunjie/ui
npm run check:catalog -w @xunjie/ui
npm run test:browser -w @xunjie/ui
```

边界检查验证组件包的静态导入及资源引用留在包内或已声明的依赖内；Web 构建缓存也包含本包源码和资源。`test:browser` 需要本机安装桌面 Chrome，专门检查编辑器和比较视图的挂载、卸载与正文保留。实际界面还须在桌面 Chrome 检查组件状态、交互和样式。
