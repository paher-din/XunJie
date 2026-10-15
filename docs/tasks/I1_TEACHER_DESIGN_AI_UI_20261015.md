# I1 教师设计 AI 接口接入（2026-10-15）

## 依据与授权

负责人要求审视三层AI现状与接入方案，“确认无误后开始修改”。本地基线d7c1fc659aecb126caf20b0b38410f91d318b083，开工无已跟踪差异；已有未跟踪报告/证据保留，不混入本任务。

已读README、PRD §4.1/4.3/5/8 → MVP_SPEC §2、M-01/02/07/08/10 → TECH_DESIGN §4.2–4.4/5/7.2.1/9；教师工作台任务§1–3/6–7、当前design契约及路由/存储、DESIGN颜色/字阶/布局/组件要求。适用PRD-01/02、M-01/02/10、AC-01/02/13与版本、引用、幂等、角色权限边界。

本轮批准范围：沿现有教师项目设计页增加真实API控件、状态与候选展示，及隔离合成验证。可写`apps/student/src/teacher/LiveDesignPage.tsx`、新教师设计AI组件/客户端/类型/scoped CSS、教师专项测试、README实际使用说明及本任务。共享HTTP/Session、服务端契约、宿主/云配置、密钥、数据库、产品/规划/参考/AGENTS只读。真实供应商来源、独立预算额度与共享部署尚需具体范围，已向负责人询问；只暂停依赖这些决定的运行配置/付费调用。

## 审视结论与修正

1. 模型候选来源标签证明UI支持展示该种记录，不单独证明本轮实际调用模型。设计检查疑点来自教师记录与确定性检查，不能全部归为AI生成。个人模型设置不等于教师设计provider/预算已启用。
2. `/design-proposals/:id/adopt`只接受blueprintId=null的根候选/完整方案，创建新草稿；已有蓝图的提案采纳走`PATCH /blueprints/:id`，携带proposalId、expectedRevision与允许字段。量规试评只展示评论/歧义；修订仍由教师显式编辑、保存，不能直接自动采纳字符串为正式量规。
3. 根生成先`POST /courses/:id/blueprints`（mode=agent、generationMode=candidates或blueprint）。已有草稿可发blueprint/patch提案，试评需选获准样例段落；三类均经Job读取后获得proposalId，再GET原提案。API预算拒绝、依赖缺失、未知结果、过时/冲突都不能伪造成功。
4. 共享宿主同时硬编码budgetAvailable=false及占位provider，真实演示缺的是provider接线和独立预算方案，不只是改配置开关。教师设计只读取显式teacherDesignAllowed材料，不误用学生/辅导可见性作为教师设计权限。

## 实施与验收方案

- 复用原教师命令冻结字节/幂等键/CSRF与“核对原教师操作”。新项目可从少量要求发根候选或完整建议；已保存草稿在无未保存编辑/版本变化时允许局部建议或试评。材料按教师设计用途显式选择段落与hash；试评至少选一个样例。
- 展示Job状态、取消/重读、模型候选原文、未决项、依据、受影响项和前后差异。显式采纳才写；人工编辑后仍保留提案但禁止覆盖，服务端再做版本/适用性核验。刷新可通过原Job或proposal ID恢复读取，不自动再次发模型请求。
- 验证涵盖预算关闭、根候选采纳新草稿、局部PATCH白名单与CAS、试评引用、过时/人工修改拒绝、失败/结果未知与恢复、账号课程隔离、窄屏和键盘基本可达。合成HTTP/离线通过与真实供应商、部署、真人教学分别记账。

## 交付记录

已实现`DesignAgentPanel.tsx`、`designAgent.ts`、scoped CSS及真实`LiveDesignPage`接点；复用原teacherCommand，不修改后端或共享HTTP/Session。原开发预览的静态示例不改写成真实生成。根采纳只补入教师原已选的标题/基础/时间与政策/运行配置，不用原手工问题覆盖候选；量规/目标文字建议不伪造正式结构关联。由原服务端继续执行最终校验。

| 验证 | 结果与边界 |
| --- | --- |
| Node24.21.0类型检查 | `npm --prefix apps/student run typecheck`通过，[日志](evidence/teacher-design-ai-20261015/typecheck.txt) |
| 最终全量单元 | `npm --prefix apps/student test`，55文件、667/667通过；新增10项覆盖范围/hash、CAS白名单、过时/人工编辑、根采纳与课程配置、试评非自动采纳。[日志](evidence/teacher-design-ai-20261015/unit.txt) |
| 正式构建 | `npm --prefix apps/student run build`通过，保留原大chunk提示。[日志](evidence/teacher-design-ai-20261015/build.txt) |
| Chrome组合回归 | teacher-design-ai、teacher-ui、teacher-model-settings、sessionEntry共27/27通过，1.4分钟。[日志](evidence/teacher-design-ai-20261015/browser-regression.txt)。随后只补根采纳课程配置保留（新增单元保护），再对最终AI专项复验 |
| 最终AI专项 | `teacher-design-ai.spec.ts --workers=1`，7/7通过，34.4秒：预算拒绝、刷新只读恢复、候选显式采纳、人工编辑/冲突不覆盖、局部新revision、试评样例、未知ACK同字节同key核对与取消。[日志](evidence/teacher-design-ai-20261015/browser-final.txt) |
| 视觉复核 | 首次locator全高截图被主滚动容器裁剪，改为在实际候选区域滚动后截图；仅根候选用例复验1/1、11.7秒。[桌面候选](evidence/teacher-design-ai-20261015/design-ai-desktop.png)、[390宽度候选](evidence/teacher-design-ai-20261015/design-ai-mobile.png)、[请求控件](evidence/teacher-design-ai-20261015/design-ai-controls.png)、[日志](evidence/teacher-design-ai-20261015/visual.txt)。已目视检查，390文档无横向溢出 |
| 初轮失败 | 6项中4通过2失败，原因是测试用“真实问题”定位到了新字段白名单复选框；改用原编辑器“驱动问题”textbox精确定位，未改业务判据。[原失败](evidence/teacher-design-ai-20261015/browser-first-failure.txt) |

所有浏览器请求都在隔离本机HTTP合成替身内，不访问共享库、供应商或真实Key；以上不计真实模型起草/真人验收。浏览器测试使用5661/5662独立进程、原Chrome、复用服务器模式，测试正常退出；不重现上一任务runner收尾卡住。原始日志保留`.tmp`，公开证据只规范行尾空白。

已自审应用写集：课程/账号切换丢弃迟到UI结果，提案scope/resultHash核对，采纳前复读applicable且再查当前编辑，自动只读轮询60秒封顶，未知请求沿原冻结字节/key核对；未关闭任何原检查。README同步源码入口与启用边界。`node tools/a0-review/check.mjs`检查162份文档、2183条内部链接、errors为空；`git diff --check`通过。

交付位于独立本地分支`codex/teacher-design-ai-ui`，只提交本轮教师AI源码/测试、两份README、本记录及合成证据。5661/5662本轮测试进程及子进程已结束，用户5601预览与SSH隧道保留。不推送、不部署；若回退，仅撤回本轮教师UI提交，不涉及服务配置、数据库或已有合成作品。

未执行：后端个人模型钩子/独立预算的契约变更、运行配置启用、共享部署、真实供应商调用、共享业务写入、teacher_sample执行及完整M-01/AC/真人教学验收。当前打开的共享页面不会自动获得本地改动。保护产品/规划/参考/AGENTS未改；产品基线及MVP_SPEC §10：待授权维护者汇总。

## 个人模型与独立教师预算接线提案（待负责人确认）

负责人选定“同时设计个人模型接线并补充预算”，未提供调用/金额/token数值。此处是可审查的后端方案，尚未当成共享契约批准或修改运行配置，也没有发真实请求。

1. 仅从持久teacher_design请求的可信actorId取得当前教师个人模型selection，复用现有`personalModels`服务及`compatibleTutoringProvider`；不从浏览器/模型正文接收用户身份或Key，不借学生账号。把selection.version写入原StoredTeacherRequest.versions.modelConfig，在派发及结果接纳时复核版本；更换模型/停用配置时旧结果stale，不重贴新配置。
2. 拟扩展`TeacherAgentOptions`的按教师解析provider/versions/current检查钩子；保持现有静态provider兼容。拟改文件为`apps/teaching/server/design/teacher-agent.ts`、`server/app/personal-models.ts`及原组合调用方`server/main.ts`、`tools/i0-cloud/cloud-host.mjs`；具体接口需A/B/C确认，不能解析untrustedInput来选账号。现有ModelProvider请求无可信actor字段，因此只改宿主开关无法安全复用个人模型。
3. 单独受控`teacherDesign`配置默认关闭。明确callsAuthorized、获准教师/课程范围、每任务最大调用数（不能超过现有3次上限）、本轮总调用上限、单次输出token上限，缺任一批准值时拒绝调用。个人callsEnabled、个人enabled/有效selection和教师预算三个条件同时满足才派发；教师设计预算不会打开学生辅导或改变个人设置。
4. 限额预留和用量读取沿原teacher_design_requests usage_json/Job记录，在同一短事务核对并记unknown预留，防止并发穿透；已发未确认不返还额度。查询可按原请求actor/course/acceptedAt限定本轮账目，不新增表；若现有数据库读取接缝不足，先回交具体事务接口差异，不绕开它建内存计数器。真实价格/费用不能从token数自行假定，金额上限须由负责人给出计价依据或改为可执行的调用/token上限。
5. 实现先用两个隔离合成教师的离线provider测试账号/版本隔离、未配置/停用/超额零调用、超时/取消、并发预留和unknown计费；真实演示在负责人指定供应商/模型、预算数字、目标宿主及部署范围后，只执行明确批准的最小请求并留脱敏回执。

待补决策：每任务/本轮允许调用次数与最大输出token（或明确金额与计价依据）、获准教师/课程和目标宿主配置范围。共享云部署与真实调用仍未执行；不把前端已接线写成真实模型可演示。

最小演示额度建议（待确认，不是已获授权）：每任务最多1次供应商请求、本轮最多3次，单次输入上限16000 token、输出上限4096 token，遇错不自动重新发供应商请求；仅在指定的合成课程及当前教师个人模型下验证根候选、局部提案、量规试评各一次。未知用量占用原额度，不用重新生成绕过。模型/价格尚未确定，因此不声明这些token等于某个金额上限。后端接线与该额度需负责人确认后实施；部署目标和配置范围也须明确。
