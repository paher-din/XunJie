# B：UI30 / HDL 正式教师语义审阅单

日期：2026-10-15（Asia/Shanghai）。关联任务：[B-UI30-HDL](B_UI30_HDL_HANDOFF_20261015.md)。状态：**工程来源已核；正式语义审阅材料不完整，待恢复两个固定 Message 的完整正文并由实际审阅者填写。**

## 1. 审阅边界

本单只审阅 [Issue #30 指定评论](https://github.com/paher-din/XunJie/issues/30#issuecomment-6175261812)交给 B 的两条合成 HDL 教学消息。审阅必须使用持久记录中的完整学生问题、完整模型可见正文和确切获准上下文；截图、正文 hash、工程摘要或模型自评不能替代完整正文。

实际审阅者须为教师或负责人指定的项目推进者。Agent 可核引用、指出技术疑点和整理填写栏，不能代签正式教学结论。合成浏览器的 `acknowledged` 不是真人学习、理解、采纳、能力或教学效果证据。

共同判据：

1. 事实只来自同一获准快照、Build/Session/Operation 与有限 Trace，不把缺口补成结论；
2. HDL 技术解释正确，尤其不能把位宽、X/Z、有限帧、复位或工具状态作无证据因果归因；
3. 每轮一个主要教学目的，不给整份答案，不替学生编辑、构建、装载、操作板卡或作正式评价；
4. 下一步由学生执行，问题语言与回复语言相符；
5. `received`、`displayed`、`acknowledged`、`stale` 分层使用，未展示正文不写成学生看到。

## 2. SR-UI30-01：失败 Build 的实际展示链

### 固定工程事实

- Job：`70d697fc-0389-4cb5-a19b-9d68515db10d`；模型 Message：`92e9f7a9-dc89-4ee9-9f76-77242b10f013`；Action：`5b918f49-a908-4b4a-864f-7b6d50f021c3`。
- 内容 hash：`e0aded304a3a979c45ed00fc1dd0b5e6b0d2d5523e58a94d2d644958174bc0fd`；结果 hash：`c6decce93a586aa917215e2d79dd2cab6c1fdc03d5d0e92998e52c766d54c06f`。
- basis：`top.sv` file `1ff729fe-3365-4cb0-8e07-2bc4a558783c` v2，snapshot `992df0be-69e1-47ea-a28b-436b55bbc22b`，失败 Build `2a28b361-05fa-4b35-bb92-4a57a7db208c`；活动/政策/模型/prompt/schema 版本均由原 Action 固定。
- 历史回执：received 46、displayed 48、开发合成回应 acknowledged 50。随后作品修订令 Action `learner_state_revised → stale`，历史回执没有被抹除。
- transport：第二次 HTTP 200；actual usage 输入 2704、输出 466 tokens。该 transport 无 Job 外键，关联仍以持久 Job/Message/Action 和时点证据为准。
- 后续工程事实：学生侧显式修订、新快照/成功 Build；相同 SW0 输入的实际 LED 结果改变，并确认停止。该行为由开发合成账号执行。

### 待恢复的原文

- 完整学生问题：`材料缺失，不能从 hash 或截图反推`。
- 完整模型可见正文：`材料缺失；公开截图只显示片段，不能据此正式审阅`。
- 已核公开截图：[正文片段](evidence/ui30-hdl-20261015/browser-hdl-agent-body.png)、[回执](evidence/ui30-hdl-20261015/browser-hdl-agent-receipts.png)。

### 实际审阅者填写

- 审阅者角色与姓名/标识：`待填写`
- 审阅日期：`待填写`
- 事实忠实性：`待填写`
- HDL 技术正确性：`待填写`
- 提示强度与学生控制权：`待填写`
- 下一步是否聚焦、可执行：`待填写`
- 结论：`通过 / 有条件通过 / 不通过 / 材料不足`
- 理由、严重问题和必须修改项：`待填写`
- 是否需要 B 修复及新的真实模型复验：`待填写；新调用须另获授权`

## 3. SR-UI30-02：板卡 Operation 求助 received 后过时

### 固定工程事实

- Job：`765530ca-367c-4ca1-b496-d5365584cdff`；模型 Message：`f118e4d9-4920-475d-829c-50ffe804b1dc`；Action：`1e32c2ec-60f2-4fa3-93fb-547e607e12ac`。
- 内容 hash：`eff856ab1bd45c3d905c2427ac401f8bd5376957d9cd38d1da9b8f4fce6d0117`；结果 hash：`c12569db3d27e7a76ff9aed0e72b3e645cee2e3899b407426e78f77cba51d2fa`。
- basis：snapshot `6d0ed106-5b29-4603-98d5-1fef95ac3914`、成功 Build `d8174bc9-ac86-4a9f-928f-e5692aa567e3`、Session `c69decae-f4c2-4cc3-9fa3-0138d30ca22c` revision 3、confirmedSequence 2、simulationTimePs 20000、Operation `16235ed5-73b7-42e0-b8eb-d4535abaebe0`、resultHash `229a353b8933e6ef0abc2d964d69d53da27f90addb298a5f753bdc281e49e583`。
- 回执只有 received 234/237/240；最终 `learner_state_revised → stale`，没有 displayed 或 acknowledged，不能写成学生看到或接棒。
- completion transport 窗口共有四次 HTTP 200，其中包含首批两次、独立 C 侧一次和本次板卡一次；日志无 Job 外键，不能把全部四次归本消息。

### 待恢复的原文

- 完整学生问题：`材料缺失，不能从 hash 或截图反推`。
- 完整模型可见正文：`材料缺失；该正文未展示，公开包未导出正文`。
- 已核公开截图：[求助选择](evidence/ui30-hdl-20261015/browser-board-help-selection.png)、[过时返回界面](evidence/ui30-hdl-20261015/browser-board-help-stale.png)。

### 实际审阅者填写

- 审阅者角色与姓名/标识：`待填写`
- 审阅日期：`待填写`
- 事实忠实性：`待填写`
- HDL 技术正确性：`待填写`
- 提示强度与学生控制权：`待填写`
- 下一步是否聚焦、可执行：`待填写`
- 结论：`通过 / 有条件通过 / 不通过 / 材料不足`
- 理由、严重问题和必须修改项：`待填写`
- 是否需要 B 修复及新的真实模型复验：`待填写；新调用须另获授权`

## 4. 材料恢复与当前结论

公开证据有意排除完整模型上下文。2026-10-15 实际核查时，交接所称原 `Ubuntu` WSL 发行版已不存在；当前只有新的 `Ubuntu-24.04`，其中没有 `/opt/xunjie-ui-local/application-config.json` 或 `/opt/xunjie-runner/node/bin/node`。交接指定的 `D:\XunJie_Project\i0-ui55-connection\hdl-ui\local-environment` 也不存在。因此没有在本机找到可按原批准边界只读恢复两个正文的材料。

恢复时只接受以下之一：

1. 原合成数据库或原受控导出中两个固定 Message 的完整正文，并重新核 contentHash/resultHash；
2. 当时保存的完整、连续且可核 hash 的模型结果证据；
3. 由原证据保管者提供的固定提交/受控材料入口。

不得重跑模型来“补回”历史正文，不得用新输出冒充原 Message，不得从截图片段、摘要或 hash 逆向补写。当前可正式记录的结论是：**工程来源、当前性和回执分层已通过 B 接纳；两条消息的正式教师语义结论为“材料不足 / 未完成”。**
