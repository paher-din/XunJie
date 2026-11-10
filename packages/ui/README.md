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

学生端通知统一使用 `@xunjie/ui/feedback`：应用根挂载一次 `Toaster`，操作回调使用 `toast.success()`、`toast.error()`、`toast.info()` 或 `toast.warning()`；已有异步状态可用 `useToastFeedback(message, kind)` 接入，避免轮询和重绘重复通知。通知采用 shadcn/ui Sonner，沿用顶部居中、`inverse` 底色与主题 token，支持关闭、堆叠、键盘和减少动效。任务进度、作品冲突及续办操作仍在各自内容区域呈现。

`ShellFrame` 提供 `onCollapsedChange` 时启用调宽：采用 Astryx 短竖条与指针捕获交互，使用循阶 token 和现有 60px 图标轨道。默认宽 248px，展开最小 152px，最大为 360px 与容器宽度 40% 中较小者（不低于 152px）。拖到 96px 时即用 240ms 平滑收至 60px 图标轨道，反向拖到 112px 时直接接续展开，无须松手。两个阈值之间维持当前吸附状态；动画中可反向打断，过渡区同步交接导航透明度。双击或 Enter 切换收起，方向键调宽，Home 收起，End 调至上限；展开宽度只在本次外壳挂载期间保留。来源与许可同见第三方说明。

拖动时即应用展开宽度约束，松手不再改写已经显示的位置。失去指针捕获、系统取消或离开拖动模式都保留最后选择，仅 `Escape` 主动撤销；发生位移的拖动及其后紧接的一次点击不触发双击折叠，真正的双击仍可切换侧栏。

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
