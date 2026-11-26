# 教师 Agent 第二轮 UI 对接说明

开发分支为 `codex/teacher-agent-core-chat`。本轮交付课程内普通对话、教师模型选择及五个工具的后端实现。前端继续使用团队已定的教师工作台入口。本轮联调对象是已发布任务与公开材料。

## 模型设置

学校登录态下使用 `GET /api/learning/models/teacher-selection`。返回结构沿用学生端的 `version`、`selected`、`options` 和可选 `unavailableReason`。学校配置了模型时，`options` 含 `kind: "school"` 的选项。教师自配模型沿用 `/api/learning/models/connections`，使用当前学校身份的本人连接。

用 `POST /api/learning/models/teacher-selection` 保存选择，传 `requestId`、当前的 `expectedVersion` 和 `source`。学校连接用 `{ kind: "school", connectionId }`，本人连接用 `{ kind: "personal", owner: "self", connectionId }`。教师选择单独保存。同一身份的学生模型继续通过原 `models/selection` 接口管理。

首次使用采用可用的教师配置连接，其次采用可用的学校默认连接。没有可用连接或选中连接失效时，设置接口返回 `selected: null` 及原因。对话失败状态为 `teacher-model-unavailable`，页面可引导重新选择。既有历史仍可读回。保存并发冲突时重新读取版本。

## 会话与工具

普通消息可继续传空 `context`。在已发布任务页发问时，可附 `teacherTarget: { kind: "release", taskId, releaseId }`。本条消息明确选用 Skill 时，再附 `teacherSkill: { skillId, version }`。联调前通过既有 Skill 库导入所需包，使用 `GET /api/learning/agent-sessions/:sessionId/skills` 返回的目录引用。正文由 Agent 按指定版本和字节范围读取。没有显式选用的下一条消息照常对话。

| 工具 | 输入 | 返回及界面用途 |
| --- | --- | --- |
| `read_course_task` | 固定 `taskId + releaseId`、页面对象引用或任务名称 `query`。用 `offset`、`objectiveOffset` 和 `helpNoteOffset` 分别续读要求、目标和帮助说明。 | 固定版本、目标、要求及帮助规则。正文片段返回各自的续读位置。多条匹配时返回 `ambiguous` 和版本候选，可请教师确认。 |
| `list_design_materials` | 固定 `taskId + releaseId` 或页面对象引用，支持 `offset`、`limit`。 | 公开材料标题、类型、ID、摘要及发布来源。沿 `nextOffset` 继续。 |
| `read_design_material` | 固定任务版本或页面对象引用，以及 `materialId`、`offset`、`length`。 | 公开 UTF-8 文本片段、固定来源和下一位置。偏移按 Unicode 字符计。其他格式或超过 2 MiB 的材料返回 `unsupported-format`。 |
| `skill_load` | 已选 Skill 的 `skillId + version`，可附 `offset`、`length`。 | 固定版本的 `SKILL.md`、包摘要和读取范围。 |
| `skill_read` | 同一 Skill 的固定引用、包内 `path`，可附 `offset`、`length`。 | 包内文件片段及范围，支持按范围续读。 |

这些工具由 Agent 在对话中调用。界面沿用 `conversation?after=<游标>` 中的工具状态和出处。课程资料不在授权范围时返回 `missing` 或 `forbidden`，任务与发布版本不匹配时返回 `invalid`。Skill 无法读取时在普通对话中说明，教师仍可继续提问。

## 联调检查

先分别选学校连接和本人连接发消息，核对教师选中项、学生选中项和失败提示。再打开 ALU 发布任务，请助手读取任务及公开讲义并说明出处。最后显式选择一份固定版本的「项目式备课」Skill，核对主文件与参考文件的工具状态，并用下一条普通消息确认无需继续加载。测试数据、登录和课程授权沿用本地一体化联调环境。 [环境配置](../packages/product-runtime/README.md#教师普通对话)
