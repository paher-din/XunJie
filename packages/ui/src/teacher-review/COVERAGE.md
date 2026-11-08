# 教师审阅、课程材料与设置组件覆盖

## 从哪里取用

正式入口：`@xunjie/ui/teacher-review`，类型和组件均由本目录的 `index.ts` 导出。按功能查找：`PreviewReview.tsx`（隔离预览审阅）、`LiveReview.tsx`（真实审阅展示）、`Materials.tsx`（材料）、`Settings.tsx`（教师设置）。这里的实现不导入 `apps/web`、教师 context、路由或请求客户端。

使用前加载正式包的学生基础样式以及教师样式，保留以下顺序：

```tsx
import '@xunjie/ui/styles.css'
import '@xunjie/ui/styles/teacher/teacher.css'
import '@xunjie/ui/styles/teacher/review-materials.css'
import '@xunjie/ui/styles/teacher/live-review.css'
import '@xunjie/ui/styles/teacher/teacher-settings.css'

import { MaterialCard, LiveAbilityPanel, TeacherGeneralSettings } from '@xunjie/ui/teacher-review'
```

`MaterialViewData`、`PreviewLearnerView`、`LiveReviewDisplayContext` 等是公开的展示数据类型，应用负责把自身数据投影为这些字段；不要把预览数据当作真实教学事实。各组件只调用传入的事件，不自行读取业务数据或提交操作。真实审阅的 `canWrite`、`selectedLatest` 和 `busy` 由宿主根据当前权限、提交版本及请求状态决定；`LiveEvidenceChoices` 的受控值使用 `liveEvidenceKey(ref)`，宿主用相同的键找到原始引用。

需要跳转的组件通过 `LinkComponent` 接受宿主路由链接（支持 `to`、`className` 和 `children`；设置导航还需要 `end` 与按 `isActive` 计算类名）。原生材料和预览审阅弹窗接收宿主持有的 `ref`，由宿主执行 `showModal()`、关闭及卸载时的数据清理；不要只改变 JSX 可见性来替代原生 modal 生命周期。真实审阅弹窗沿用 `@xunjie/ui/teacher` 的 Radix `TeacherDialog`。

## 可见单元映射

| 来源及可见单元 | 正式组件 / 状态 |
| --- | --- |
| 预览审阅页标题、学生详情标题与返回 | `PreviewReviewHeading`、`PreviewLearnerHeading` |
| 预览学生统计、搜索及状态筛选、列表、空态与说明 | `PreviewReviewSummary`、`PreviewReviewToolbar`、`PreviewLearnerTable`、`PreviewReviewEmpty`、`PreviewReviewFootnote` |
| 预览固定提交提示、三条能力线、判断与引用 | `PreviewReviewSnapshot`、`PreviewAbilityPanel`、`EvidenceButton` |
| 预览作品记录、实际帮助、学生自述、反证及未知 | `PreviewWorkPanel`、`PreviewObservationPanels`、`PreviewUnknownPanel` |
| 预览反馈、后续行动与修订入口、复核历史 | `PreviewFeedbackPanel`、`PreviewNextActionPanel`、`PreviewReviewHistory` |
| 预览原始引用与教师决定弹窗 | `PreviewRawEvidenceDialog`、`PreviewDecisionDialog`；确认、纠正、暂缓、允许修订及引用选择由输入和回调驱动 |
| 真实审阅列表标题、课程学生表、搜索状态筛选、尝试列表与空态 | `LiveReviewListHeading`、`LiveReviewRoster`、`LiveReviewToolbar`、`LiveAttemptTable` |
| 真实审阅读取失败、当前尝试不可用、详情读取中 | `LiveReviewError`、`LiveSelectionUnavailable`、`LiveReviewLoading` |
| 真实学生标题、固定提交选择、历史提交提示 | `LiveLearnerHeading`、`LiveReviewSnapshot`、`LiveHistoricalSubmissionNotice` |
| 真实固定作品、运行、能力判断与引用状态 | `LiveWorkPanel`、`LiveAbilityPanel`；保留反证、未知和原依据不可用的展示 |
| 真实帮助、采集空窗、教师决定、反馈历史与异议 | `LiveHelpPanel`、`LiveReviewHistory` |
| 真实原始依据选择、反馈表单、修订许可 | `LiveEvidenceChoices`、`LiveFeedbackPanel`、`LiveRevisionPanel`；历史提交和不可写状态由宿主参数控制 |
| 真实原始证据、能力复核与纠正弹窗 | `LiveRawEvidenceDialog`、`LiveDecisionDialog` |
| 课程材料标题、说明、分类、搜索与可见范围筛选 | `MaterialsHeading`、`MaterialsIntro`、`MaterialsCategories`、`MaterialsToolbar`、`MaterialsFootnote` |
| 材料卡片、无结果 / 无材料空态、原文 | `MaterialCard`、`MaterialsEmpty`、`MaterialDocumentDialog` |
| 材料导入、文件 / 粘贴切换、分类和可见范围、读取 / 保存状态 | `MaterialImportDialog`；私有答案和验证资产在 UI 中禁止勾选学生与辅导可见，保存校验仍由宿主和服务负责 |
| 教师设置标题、导航、预览模型提示与读取状态 | `TeacherSettingsHeading`、`TeacherSettingsNavigation`、`TeacherSettingsModelNotice`、`TeacherSettingsModelLoading` |
| 外观、预览 / 真实入口说明、导出与教学证据说明 | `TeacherGeneralSettings`；主题写入和导出由回调承接 |

四个旧页面已改用上述正式组件；旧页面内继续保留布局组合以及请求、表单状态、异步读取防串、路由、账号、权限、错误和保存逻辑。真实教师模型设置继续使用应用内 `LegacyModelTab`，其表单拆分属于 `@xunjie/ui/settings` 的迁移范围，不能因本目录已覆盖预览提示就认为该模型页已迁完。页面控制器也尚未迁入新版，因此现在仍不能删除旧教师页面。

## 验证与合成预览

审阅、材料及设置的合成示例统一在[正式组件目录](../../../../apps/web/src/ui-catalog/README.md)中查看；保存、重读与跳转仅作用于本地示例状态，不能作为真实业务验收。

本次已在桌面 Chrome 对照旧教师预览查看审阅列表 / 详情 / 决定弹窗、材料列表 / 正文 / 导入及私有材料状态、通用与模型设置提示；真实审阅的各展示面板与原始依据、纠正弹窗使用合成样例实屏查看。已有浏览器用例覆盖预览的审阅决定与反馈 / 修订、材料权限与异步读取取消、真实课程学生名单；`LiveReview.test.tsx` 检查证据键与可写状态、历史提交禁用，以及多实例标题关联。

从仓库根目录运行本目录的组件测试：

```sh
rtk bypass npx vitest run --config apps/web/vite.config.ts --root . packages/ui/src/teacher-review/LiveReview.test.tsx
```

组件目录覆盖已登记的浅色、深色及主要状态；真实服务接线、所有权限组合和教学效果仍需在相应业务验收中确认。
