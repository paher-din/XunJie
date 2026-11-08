# 正式组件库开发验收目录

这是 `@xunjie/ui` 的独立开发入口，不是产品页面，也不是生产构建入口。它只登记已经写有真实示例的组件；目录以外的正式包组件仍需补充示例和实屏验收，不能根据本目录推断整个组件库已覆盖。

## 启动与定位

在仓库的 Web Vite 开发服务器运行时打开 `/ui-catalog.html`。例如，在 `apps/web` 目录运行 `npx vite --host 127.0.0.1 --port 5180` 后访问：

- 目录：`http://127.0.0.1:5180/ui-catalog.html`
- 某个组件状态：`http://127.0.0.1:5180/ui-catalog.html#/foundation/conversation-row/renaming`
- 独立预览：`http://127.0.0.1:5180/ui-catalog.html?view=preview&theme=dark#/foundation/conversation-row/menu`

端口以本地开发服务器实际输出为准。路由格式是 `#/分组ID/组件ID/状态ID`，三个 ID 都是小写字母、数字或连字符；不存在的 ID 会明确报出未找到。主目录和独立预览均支持直接打开、刷新和浏览器前进后退。目录预览使用 iframe 隔离组件的固定定位与 Portal；切换主题或状态会重新挂载预览。`Composer` 的收起态受原媒体查询限制，示例使用 1200px 视口，预览区域可横向滚动。

## Agent 如何查找与扩展

从 [`registry.ts`](./registry.ts) 查看分组，再进入对应的 `examples/` 文件查看组件的稳定 ID、状态 ID、正式 `importPath`、`source`、`exampleSource`、主要 `props`、依赖和实际渲染函数。页面中的搜索也覆盖组件名、路径、属性及状态；图标名称和用途可在目录及图标预览中搜索。每个详情页显示相同的入口和源码路径。`types.ts` 定义登记格式，启动时会校验分组、组件和状态 ID 的格式与唯一性。

增加组件时：

1. 从 `@xunjie/ui/<分组>` 引入真实组件，在适当的 `examples` 文件中编写独立渲染函数。由本地 React 状态提供示例数据和事件，不连接产品 store、真实会话或业务 API。
2. 追加 `CatalogEntry`，列出实际支持的状态、组件源码、示例源码、主要属性与必要依赖。只登记已实现的状态；已有 ID 一旦用于链接就保持稳定。
3. 新增分组时在 `registry.ts` 追加，不需要修改路由。用组件状态深链打开目录与独立预览，核对样式、交互、资源和控制台；根据组件需要继续添加验收。

基础样式统一来自 `@xunjie/ui/styles.css`，其他依赖由正式组件或示例显式声明。示例中的账户、会话和学习内容均为本地演示数据；按钮只改变示例状态，目录不请求业务 API 或访问旧版 store。开发服务器仍会加载本地模块、字体和品牌资源。

## 覆盖与验收

目录包含基础、图标、品牌、首页、对话、看板、设置、工作区以及教师相关分组。组件清单由 `npm run list:components -w @xunjie/ui` 从正式入口生成；运行 `npm run check:catalog -w @xunjie/ui` 检查每个公开可视组件是否有示例。旧版来源和仍需业务宿主接线的部分以[正式包覆盖清单](../../../../packages/ui/README.md#找组件)为准。

在仓库根目录运行 `XUNJIE_E2E_BROWSER_CHANNEL=chrome npm run test:e2e -w @xunjie/web -- e2e/uiCatalog.spec.ts --project=chromium`，测试会在桌面 Chrome 中逐个打开登记状态、核对组件入口和源码，并分别截取浅色与深色画面；截图及清单位于 Web 的 `test-results` 目录。目录数据仅用于呈现组件；这些截图和本地交互不代表真实服务或教学效果已验收。主题菜单示例会主动切换页面主题，截图清单同时记录实际主题。

## 已核对的修正

`Button` 的独立禁用态沿用旧版对话框已有的 `0.38` 透明度与禁用光标；已在桌面 Chrome 复核主、次按钮。
