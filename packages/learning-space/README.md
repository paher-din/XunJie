# 空间、课程与学习数据 owner

`@xunjie/learning-space` 持有空间身份、课程与学习数据，依赖 contracts/storage；模型调用由 [model-gateway](../model-gateway/README.md) 持有，场景由 [agents](../agents/README.md) 装配，可信 HTTP 与安装生命周期位于 [product-runtime](../product-runtime/README.md)。浏览器消费 contracts，不导入本包 Node 实现。

| 入口 | 所有事实与职责 |
| --- | --- |
| [spaces](src/spaces/README.md) | 个人主体、学校账号、成员资格、登录会话、客户端授权及 owner 绑定 |
| [courses](src/courses/README.md) | 课程/任务、不可变发布、学生开放材料、课程资格与跨 owner 活动关联 |
| [learning-data](src/learning-data/README.md) | 真实 activity、作品、草稿、引用、执行原件、资料/PDF、生成内容、提交与原请求回执 |
| `learning-data/agent-sessions` | 普通/工作区会话目录、固定 Agent owner、标题、置顶、归档与删除元数据；不保存内核 Run |
| `learning-data/session-materials`、`project-materials` | session/workspace 明确 scope 的资料及跨 scope 采用；sessionId 不冒充 activityId |
| `learning-data/personal-projects`、`learning-query` | 普通助手使用的真实任务/资料查询、个人项目计划与工作区关联 |
| `learning-data/skills`、`skill-packages` | 全局个人库、会话选择、固定版本、正文/附件与来源；不把 scripts 当作可执行能力 |

根导出和功能子路径以 [package.json](package.json) 为准。`learning-data` 只写所属数据，不直接访问其他 owner 的表。session 的推进、许可、等待和恢复交给 agent-runtime；模型、凭据、SDK 调用和 HTTP 身份装配均不在本包。

## 会话与部署

普通首页首问创建 `student-assistant` session；workspace session 固定真实活动与 target，并校验固定作品、引用与课程帮助边界。个人项目由领域 port 创建真实 activity 与独立 workspace session，`GET /api/learning/activities/:activityId/project` 返回所属项目或 null。产品 HTTP 接线及 module ID 见[部署说明](../../docs/deployment.md)。

旧开发教学数据按[显式重置](../../docs/deployment.md#旧开发-agent-数据的显式重置)处理，不将旧 Run、activity 会话或 v1 回执解释成 session v2；空间/课程、学习作品、模型配置与资料仍按各自 owner 保留。

## 测试

仓库根执行 `node scripts/test.mjs learning-space --list` 查看本地查询/HTTP 数据边界测试；`--external --list` 查看真实 PG session、资料、项目和 Skills 测试。移除 `--list` 才运行，并准备所需 workspace 依赖；统一 verify 收集本地组，即使本包没有 npm test script。

PG 用例通过 [storage native fixture](../storage/test/native-fixture.mjs) 建立临时独立数据库，需 `XUNJIE_PRODUCT_POSTGRES_BIN` 指向支持的 PG 分发。本地通过不算 external 通过。共享 dist 构建由协作方统一安排；已准备产物时可直接 `node --test <文件>`，不通过会触发构建的入口争用 dist。
