# 教师基础组件覆盖

正式入口为 `@xunjie/ui/teacher`。下列实现及其图标、样式依赖均在 `@xunjie/ui` 内；教师页面通过参数提供展示数据和操作回调。

| 旧版视觉单元 | 正式组件 |
| --- | --- |
| 按钮、状态徽章、课程图标、空态 | `TeacherButton`、`TeacherBadge`、`CourseMark`、`TeacherEmpty` |
| 弹层框架、标题、说明和关闭按钮 | `TeacherDialog` |
| 项目卡的课程、状态、标题、版本、截止、统计和操作 | `ProjectCard` |

教师外壳、概览和项目见 [teacher-shell 覆盖清单](../teacher-shell/COVERAGE.md)；设计、检查、角色预览和 Agent 面板见 [teacher-design 覆盖清单](../teacher-design/COVERAGE.md)；审阅、材料和教师设置见 [teacher-review 覆盖清单](../teacher-review/COVERAGE.md)。这些清单分别记录具体视觉单元和剩余业务边界，不能仅凭旧路径中的兼容导出判断迁移完成。

旧页面目前仍承担会话、路由、请求、权限、教学数据转换和命令执行。新版接入时需要提供相应宿主能力，不能把旧页面容器或预览数据当作正式业务实现。
