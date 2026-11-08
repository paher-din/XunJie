# 整合双轴审查

基线为 `32720f983b40a0c3d173df312f73d5c733032af3`。Standards 与 Spec 由独立只读审查者执行，未使用 Codex Security。

Standards 在四份合并及迁移整合后无硬规范违例。后续发现旧恢复探针的 `outboundRequests` 名称超出进程内诊断订阅范围，已改成 `probeOutboundRequests`；原报告保留旧键并在索引解释实际范围。双 Skill 校验与测试的增量复核为硬规范 0、判断性 smell 0。

Spec 发现并修复：

- 旧版非空问答备份因新增默认列改变行摘要而拒绝恢复：只对精确旧 profile 投影默认新列；真正旧版生成的同一备份由 red 转 green。
- Skill 旧命令平面范围与共同原件读取不兼容：新命令统一嵌套范围，仅对精确旧版 Skill 命令提供兼容解析。
- 双 Skill 保留共享工具时可续读已停用包：原件与派生祖先读取前后均按原 Skill 身份、版本、摘要及当前资格复核；公开入口 red 后权限/组合回归 11/11。
- 上述资格复核过程中已知拒绝可能被记成未知回执：只将 `TeachingSkillError` 转为 `forbidden`、`TeachingAssemblyError` 转为 `unavailable`，其余异常原样保留。

另外修复 PDF 有界反馈丢失语义继续入口，以及 Command/Wait 分次读取可能呈现矛盾清理事实；原生停止清理测试的业务与调用次数断言均保留，最后仅更新规范清单版本 2→3。

最终 Spec 精确增量静态审查未解决项为 0。包含最后错误分类 catch 的完整工程重建通过，单／双 Skill 两个用例均通过，见[证据索引](README.md)；静态审查与运行验证分别留证。
