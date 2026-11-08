# #217 Skills 维护与隔离恢复

验证采用生产 HTTP 入口、真实独立 owner schema、原生 PostgreSQL 18.6、正式 recovery backup/restore；仅模型供应商上游由既有 fixture 控制。没有复制模型 transport 或 Agent 运行循环，没有构建。

运行入口：

```sh
XUNJIE_PRODUCT_POSTGRES_BIN=<native PostgreSQL 18.6 bin> \
XUNJIE_SKILLS_EVIDENCE_DIR=docs/student-agent-implementation/evidence/wp08-217 \
node --test --test-reporter=tap apps/server/tests/teaching-agent.skills-recovery.runtime.test.mjs
```

实际结果见 [测试原始日志](maintenance-runtime.log) 与 [还原报告](maintenance-runtime.json)。

- 从真实 `skill_read` Command 读取 V1 附件，核对原工具结果、实际 step `ContextManifest` 的 `fixed-skill-content` 和摘要。附件读取保持原 native segment；不要求附件进入 `ResolvedAgent.skills.loaded`。
- 导入 V2，停用当前包，再备份：还原 inventory 包含 1 个 Skill、2 个版本、1 条范围选择和 1 条 load，boundary evidence 为 v2。
- 生产 restore validator 成功，并用公开 boundary inventory 的版本、表计数和摘要锚定保留数据；原包完整 bytes 的摘要校验由生产 `validateTeachingSkillVersion` 完成。通过原 snapshot catalog 的附件摘要、step manifest 和原工具结果验证实际读取字节，不直接查询业务 SQL 表或新增私有测试 API。
- 隔离还原与再重启后，公开 conversation、events、settings 和原 snapshots 不变。新增模型请求 0、新增工具记录 0；隔离状态新导入返回 HTTP 503。
- 真实空 Skills owner 的 v2 inventory 投影成已发布的 v1 清单可以通过原 validator；一旦导入 Skill，旧清单被以 `corrupt` 拒绝，不能隐去新事实。

测试结束删除自身临时 runtime、还原目录及加密备份。测试 key 仅在临时凭据存储和内存中，不进入证据。

本项是工程/维护验证；未运行浏览器，也未评估教学效果。跨机器结果另见 cross 开头的报告，不以本项同机恢复代替跨机验收。
