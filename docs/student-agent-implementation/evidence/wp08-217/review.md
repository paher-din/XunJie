# #217 Standards / Spec 双轴审查

比较基线为 `cb104e33604cbfcb8c5c4f294dd5c745e723834c`，审查包含本票工作区新增文件。Standards 与 Spec 使用两个独立子 agent，并分别复核修复；不使用 Codex Security。

## Standards

依据当前 AGENTS.md、DESIGN.md、包与模块边界说明及 code-review smell baseline。初次未发现硬性规范违例；两项 P3 判断建议已处理：复用目录 schema、统一包引用匹配。三个既有测试 fixture 的 YAML external 与 dirty manifest/lock 对齐调整经过追加只读审查，原负向断言仍保留。

最终增量复核包含有限反馈裁剪、首步骤段恢复、同 scope 目录刷新、公共回归和冻结后的 Chrome probe：未解决 hard 0、heuristic 0。最终完整 verify 的文档链接检查通过；收尾新增证据再运行链接检查。

## Spec

依据 #217 与 #214 当前正文，排除 docs/archive。发现并修复的独立问题：

- ALU 的 Skill 工具参数可能携带完整 HDL：复用原公开参数帮助范围检查，禁止借工具展开绕过课程边界。
- 已接受 Wait 后切换模型可能重新注入旧 Skill 状态：在续接边界重新解析资格。
- 活动设置可能改写新默认 owner：设置请求固定使用原活动 owner。
- 首次段创建成功但回执丢失、尚无步骤时，停用后恢复可能重新注入旧正文：首步恢复也重新解析当前资格，保留原 segment/Run 和可审的旧装配。
- 同窗口返回设置后仍使用旧目录，勾选另一包可能把旧默认版本固定到新问题：同范围变更通知与读取代次保护，刷新默认目录，保留已有明确选择。
- 来源/正文 JSON 转义放大可能使反馈裁剪无限循环：同时有限缩短来源和正文预览，设置固定兜底，原固定字节保留在结果和 manifest。

首步恢复公开 seam 回归先对旧构建失败，断言实际首 payload 不得含已停用正文；六倍转义使用 `U+0001×2000` 来源和引号×6000附件，在旧构建复现 owner 同步阻塞（约 58 秒后仅终止本 fixture daemon，测试以 ECONNRESET 退出 1）。原问题及失败均未记为通过。

最终独立 Spec 复核确认六项均已修复，未解决 finding 0（P1 0、P2 0）。首步恢复与六倍转义公开运行回归 red→green 2/2；UI 定向 19 项通过，完整 verify 再次覆盖，Mac / Windows 最终正式 Chrome 均通过 8/8。审查结论与运行验证分别记录，静态审查不冒充测试执行。
