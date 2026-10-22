# 并行实施规范

这两项是负责人于 2026-10-23 明确授权实施的范围，与模型接入和总体架构研究并行。规范依据已确认的产品要求，限定在可复用前端能力；它们不代表相关研究议题已经解决。

| 实施范围 | 规范 | GitHub 实施票 |
| --- | --- | --- |
| 普通文本与代码选区、工具条、引用区 | [选区引用](workspace-selection-references.md) | [工作区选区工具条与上下文引用](https://github.com/paher-din/XunJie/issues/122) |
| IP、文字与卡片的受控展示及旧脚本适配 | [引导展示层](guidance-presentation.md) | [IP 教学引导展示层](https://github.com/paher-din/XunJie/issues/123) |

交付包括实际复用的组件、来源或课程适配和开发验收页；后端同步、教学状态机和模型接入不包含在这两项实现中。各项分别记录工程检查、浏览器验收和未验证范围。

## 组件接入与本地验收

在 `apps/student` 运行 `npm run dev`，使用终端显示的地址打开以下 hash 路由。两个验收入口及其样例仅在开发模式存在。

| 能力 | 代码入口 | 开发验收路由 |
| --- | --- | --- |
| 选区工具条、文本与代码来源、问题草稿和引用 | [references/index.ts](../../apps/student/src/components/workspace/references/index.ts) | `/#/dev/workspace-references` |
| IP、文字与卡片的受控展示 | [GuidancePresentation.tsx](../../apps/student/src/components/workspace/guidance/GuidancePresentation.tsx) | `/#/dev/guidance` |
| 已有课程脚本适配 | [GuideLayer.tsx](../../apps/student/src/components/workspace/GuideLayer.tsx) | 引导验收页的“旧脚本适配”，以及原有课程入口 |

引用由 `WorkspaceReferencesProvider` 按 `workspaceKey` 隔离；来源身份应标识实际对象，不能只用可能被复用的显示名称。`onSubmit` 只收到明确发送的问题、选中片段与来源范围，完整原文仅用于本地定位校验。接收回调成功后清理未被继续编辑的草稿，失败则保留。

引导组件放在具有定位上下文的展示区域内，由调用方提供 `item`、`state` 和 `onAction`。替换为新的逻辑展示项时必须使用新的 `item.id`；旧课程脚本已通过 `GuideLayer` 使用同一组件。
