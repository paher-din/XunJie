# 学习空间与学习数据 owner

`@xunjie/learning-space` 是 #149 交付的空间/身份与学习数据两个业务 owner、#150 交付的课程发布 owner 及其生产 HTTP 接线。产品运行时组合（`@xunjie/product-runtime`）与验收测试消费本包；浏览器的 wire 契约在 `@xunjie/contracts/spaces`、`@xunjie/contracts/courses` 与 `@xunjie/contracts/learning-data`，本包不导出浏览器实现。

| 入口 | 职责 |
| --- | --- |
| [spaces](src/spaces/README.md) | 个人主体、学校账号、成员资格、会话、客户端授权和成员级学习数据绑定 |
| [courses](src/courses/README.md) | 课程、任务、不可变发布版本、学生开放材料投影、课程资格和跨 owner 活动关联准备 |
| [learning-data](src/learning-data/README.md) | 无课程活动与课程绑定活动、请求身份、跨 owner 恢复和关闭/重开；不写空间或课程表 |
| [learning-entry](src/learning-entry/README.md) | `/api/learning/` HTTP 边界；从真实会话或本机设备取得身份，不接受身份头注入 |

两个 owner 各自登记迁移、维护参与者和恢复目标；宿主负责装配，不在两者之间拼接事务。使用与验证边界见 [学习空间身份与活动](../../docs/student-agent-implementation/wp02-identity-activity.md) 与 [课程任务与固定发布版本](../../docs/student-agent-implementation/specs/wp02-course-task-releases.md)。

```sh
npm run build -w @xunjie/learning-space
node apps/server/tests/learning-entry.runtime.test.mjs   # 需要 XUNJIE_PRODUCT_POSTGRES_BIN
```
