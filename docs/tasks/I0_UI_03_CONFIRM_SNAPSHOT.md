# 03：确认保存与不可变快照

**What to build:** 学生主动创建/恢复 Attempt、确认作品并冻结可回取快照；ACK 迟到或本机事务中断后仍能保留草稿和原请求。

**Blocked by:** [02 专业多文件编辑与本机草稿](I0_UI_02_EDITOR_DRAFTS.md)。

**Document status:** `document-revised`，未实施。

**Status:** `blocked`：02 未交付，P-01 与 P-04/U-03 未落实；P-02 的已批准存储范围必须涵盖原命令/映射/确认事务。

## 依据与范围

[接入规格](I0_UI_SPEC.md)、[客户端约束](I0_UI_CLIENT_CONTRACT.md) §2～5/8、[准备记录](I0_UI_PREPARATION.md) §5.1；M-02/09、AC-03/12，TECH §5.1/7.4/7.5 与 C2 §10.4/11。

负责已有 Attempt 创建/读取客户端、保存/快照、原 outbox 与 ACK 接纳；可写学生前端对应模块、同一开发 fixture、测试与本文。后台路由/共享字段、宿主/恢复登记及受保护文件只读。

## Acceptance criteria

- [ ] GET/页面载入不创建 Attempt；学生明确发起时调用已有 POST attempts，用受信代际与原业务键，解包回执后读 Attempt。已有 Attempt 则按获准引用读取；没有首次代际时禁写且说明 H-03。
- [ ] sync 由学生发起，冻结完整业务输入/原文、键、clientId/seq、代际、预期版本及归属，先持久化再发 POST。有效 Session/CSRF 在发送时取得，不将凭据或 CSRF 存 outbox。
- [ ] clientId 不复用、seq 事务单调预留不回退；重放用原值，新操作用新键/seq。两标签不同命令不占同一去重槽，预留中断只跳号。
- [ ] 解包 requestId/data/回执/result；仅冻结发送正文形成确认基线，ACK 元数据不当正文或整 Attempt。
- [ ] 实例映射、确认头、最新草稿关联与 outbox 确认在同一事务提交，事务内保留较新 draftRevision 和冲突候选；commit 后才显示已确认。同 ACK 重复接纳不产生第二次创建。
- [ ] 在每个 ACK 本机写入阶段后注入 abort，全部回滚；刷新核原命令恢复同 fileId，后续编辑保留。失败不部分成功，存储失败不换键补做。
- [ ] 每次 await 核 mode/身份/Attempt/loadEpoch/受信代际及读取轮次。必测 g2 回退 head 已读取后 g1 ACK 到达、同对象两次读取逆序、同身份退出再进入；旧响应只能留原隔离事实。
- [ ] 同代际较新 head 已接受后，迟到旧 ACK 只记历史且映射按当前清单核对，不回退确认头；同 revision/hash 冲突重读，跨代际不取最大版本。浏览器覆盖另一标签推进 head 后旧 ACK 到达。
- [ ] 对确认 workspaceRevision 发 snapshot 命令，回执取 ID/hash，再 GET 核完整文件清单/原文/摘要/归属。当前草稿可继续改，旧快照不变；原文混合 EOL/BOM/非 BMP 摘要一致。
- [ ] 保存/快照后 GET 重读权威 Attempt，供 run/control 使用；不算 revision 或拿 workspaceRevision 替代，保留 TECH §4.3 差异汇总。
- [ ] dev:prep 中学生实际保存后刷新 GET 能读同一确认头/快照，测试也走此路径。fixture 重启换上下文并提示重新比较，不能复用旧确认缓存。
- [ ] 浏览器覆盖正常创建/保存/快照、保存中继续编辑、原子拒绝、重复 ACK、事务中断、旧加载/代际及摘要不符；工程检查记录真实结果。

## 交接与状态

后续共用同一组边界：带上下文的 bootstrap/head、原文/draftRevision/实例映射、冻结 outbox/原回执核对、确认头、snapshot GET 和权威 Attempt 重读。04/04A/05/06 不各建另一份确认状态。

真实只读与保存按客户端约束 §8 各自交接，不等待运行 worker 或历史增强。当前全部编码和检查**未执行**；基线汇总待授权维护者。
