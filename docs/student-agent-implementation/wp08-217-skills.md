# WP08 #217：课程与个人 Skills

对应 [#217](https://github.com/paher-din/XunJie/issues/217)，范围和主测试边界见母票 [#214](https://github.com/paher-din/XunJie/issues/214)。基线为 #215 最终提交 `cb104e33604cbfcb8c5c4f294dd5c745e723834c`，本票只交付独立说明包，不包含 MCP、Plugin 或依赖 MCP 的 Apps。

## 学生入口

原侧栏设置统一为「个人设置」，保留交互和模型设置，并加入个人 Skills 的目录/文件导入、版本更新、范围选择、停用和启用。设置显示当前空间；从活动打开时固定使用该活动的 Agent owner，成员后续换绑定不会把旧活动的设置写到另一 owner。

原问题草稿内可明确选择版本，也可使用范围设置。未配置个人包仍可正常学习。课程固定包无需学生安装；个人范围按主体、空间和全部活动/自主学习/课程/指定活动保存。草稿中的明确选择（包括空选择）覆盖个人范围默认值，不撤销课程发布固定的指导。正文、引用、选择继续由同一可靠草稿和 ActionInput 保存。

设置切换保留原工作区；组合输入结束并保护最终文字后才离开。composer 按工作区保存开合、焦点和选区，目录的迟到结果不能抢焦点。原对话中的加载说明和工具记录可展开当时的固定正文/附件；来源不会跳到更新后的同名文件。

## 固定包与权限

采用 [Agent Skills 格式](https://agentskills.io/specification)：`SKILL.md` 的 YAML frontmatter、Markdown 正文以及相对包内文件。导入固定来源、包版本、元数据、全文、附件、编码、字节数和摘要。更新追加版本，原来源与已发布包版本不可覆盖；仓库开发 skills 不会自动进入产品。YAML 解析依赖为产品实际打包的 `yaml@2.8.2`。

格式支持名称、描述、license、compatibility、metadata、allowed-tools，以及本产品的 dependencies/conflicts。兼容要求不在已支持的 XunJie 条件内时明确返回 `compatibility-unsupported`，不自行安装环境。路径限定为固定包内规范相对路径，拒绝绝对/越界/编码逃逸、重复或平台别名；引用文本不能读取其他主体的材料。

入口只向模型提供名称、描述和适用条件。课程指定或本次问题明确选择才直接读取正文；其他已选包由 Agent 用 `skill_load` 按任务加载，附件再用 `skill_read` 按实际字节范围读取。单次工具读取最多 6000 字节；结果保留原摘要、范围、完整性和编码，大文件可继续读取。二进制作为固定编码内容提供，不声称已经理解其中图像。

Skill 始终低于平台、课程帮助边界和本次学生意图。allowed-tools 是需求声明，不能新增权限；ALU 的模型生成参数也经过原帮助范围检查。读取 scripts 不执行脚本、不安装程序，不增加通用 shell。可选失败只影响依赖该包的操作；必需课程包缺失、冲突或缺依赖在模型请求前说明具体来源并保留原问题。

## 运行与维护

复用 `assembleTeachingAgent`、`createTeachingSegments`、RunDriver、ModelGateway 和原工具 prepare/dispatch/reconcile/stop 边界。范围、版本、启停变化在合法步骤边界装配；普通包内容读取保留原生工具配对，不因读一个附件就创建新段。显式/课程正文固定在装配中；渐进读取的内容保存在原工具结果和步骤 `ContextManifest`。真实配置换段时保留当前问题、steering 的原顺序、Command/Wait、未知状态和累计预算。

迁移 11 追加 `teaching_skills`、`teaching_skill_versions`、`teaching_skill_selections`、`teaching_skill_loads`；未修改已发布迁移。包内容和原读取按 Agent owner 保存在 PostgreSQL，参加同一备份、校验、隔离还原和接管协议。维护清单升级到 v2；旧 v1 清单只有在新增事实为空时才能兼容，不能借旧清单遗漏实际 Skills。

停用后新步骤和实际读取重新检查资格；旧快照、原工具结果与原来源仍可纯读。换模型和恢复不会把旧 Skill 状态重新当成当前指导，也不会重放工具。

## 验证

公开边界集成测试位于 `apps/server/tests/teaching-agent.skills.runtime.test.mjs`，维护恢复复用 `teaching-agent.skills-recovery.runtime.test.mjs`。覆盖正式配置/可靠动作、真实 PostgreSQL、生产 Driver/Gateway、渐进正文和附件、原版本重读、课程/个人范围、越界/缺依赖/冲突/工具不扩权、ALU 帮助规则以及等待中的撤销和换模型。首段创建回执丢失后的停用复核由独立的 `teaching-agent.skills-transition.runtime.test.mjs` 覆盖；同窗口目录刷新回归核对更新默认与既有明确版本各自保留。

实际工程、三协议、Mac/Windows 桌面 Chrome、跨机和维护结果分别见[验收证据](evidence/wp08-217/README.md)。固定模型案例不证明学生掌握或教学收益，本票不作教学效果通过声明。
