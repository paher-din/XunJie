# 学习空间与学习数据 owner

`@xunjie/learning-space` 提供空间/课程、学习数据和模型连接三个业务 owner，以及生产 HTTP 接线。产品运行时组合（`@xunjie/product-runtime`）与验收测试消费本包；浏览器 wire 从 `@xunjie/contracts/spaces`、`@xunjie/contracts/courses`、`@xunjie/contracts/learning-data` 与 `@xunjie/contracts/model-connections` 消费，本包不导出浏览器实现。

| 入口 | 职责 |
| --- | --- |
| [spaces](src/spaces/README.md) | 个人主体、学校账号、成员资格、会话、客户端授权和成员级学习数据绑定 |
| [courses](src/courses/README.md) | 课程、任务、不可变发布版本、学生开放材料投影、课程资格和跨 owner 活动关联准备 |
| [learning-data](src/learning-data/README.md) | 自主及课程活动、跨 owner 恢复、作品、不可变内容资源、同步回执和关闭/重开；不写空间或课程表 |
| [model-connections](src/model-connections/README.md) | 本人连接、凭据引用、有限 Chat 检查、原生请求/结果、取消与不盲目重放的中断恢复 |
| [learning-entry](src/learning-entry/README.md) | `/api/learning/` HTTP 边界；从真实会话或本机设备取得身份，不接受身份头注入 |

三个 owner 各自登记迁移、维护参与者和恢复目标；宿主负责装配，不跨 owner 拼接事务。使用与验证边界见 [学习空间身份与活动](../../docs/student-agent-implementation/wp02-identity-activity.md)、[课程任务与固定发布版本](../../docs/student-agent-implementation/specs/wp02-course-task-releases.md) 与 [#164 实施方案](../../docs/student-agent-implementation/specs/wp06-personal-model-checks.md)。

```sh
npm run build -w @xunjie/learning-space
node apps/server/tests/learning-entry.runtime.test.mjs   # 需要 XUNJIE_PRODUCT_POSTGRES_BIN
```
