# DL-A H4：UI 的真实数据接线包

日期：2026-10-14（Asia/Shanghai）；交付：C。统一来源为 PR #56 的本轮续作，历史 PR 不另行接入。任务、授权和验证入口见 [C 续作](DLA_CONTINUATION_20261014.md)。本包不修改 UI 页面/布局/框架。

## 1. 已有真实结果与边界

[真实模型与 HDL 完整工程记录](evidence/dla-continuation-20261014/real-hdl-model.json)包含严格 TLS 的真实错误构建、确切源码/诊断、B 模型生成、C3 投递及 `received` 传输回执、合成脚本修正、新快照/构建/持续装载、两次输入/Trace/输出、确认停止。DeepSeek/deepseek-flash 实际1次 HTTP 200，input2615/output388 tokens；只使用合成数据，不再复用该轮预算。

模型实际提示定位 `top.sv` 第5行，要求检查赋值等号右侧表达式，没有代改或给出完整答案。此为工程内容核对，不替代教师语义审阅、真实学生操作或教学效果。`received` 不表示浏览器 displayed/acknowledged。旧源码的建议保持旧快照身份，修正后的工作区不能把它当当前引导。

两次实际 LED 四态串为 `0000000000001000`、`0000000000000110`；模拟时间为40000/80000ps，来自同一 Session 的 sequence1/2、revision2/3。段选、位选与每批有限四态 Trace 在原JSON中；本轮未声称全扫描/NFR/全部 ALU 域通过，ALU behavior 仍为 unverified。

## 2. 接线契约

沿原同源登录/CSRF/Idempotency-Key、当前 generation 与版本守卫。真实账号凭据经已有受控通道获取，不在本包分发；浏览器信任沿 UI 的精确批准路径，不关闭 TLS 验证。

| 操作 | 请求与消费 |
| --- | --- |
| 确认保存 | 原 sync/snapshots；取服务端 ACK 的 fileId/documentVersion/contentHash、snapshotId/hash，不拿本地未同步正文当获准来源 |
| 构建 | POST `/api/attempts/:id/hdl/builds`：recoveryGeneration、expectedAttemptRevision、snapshotId；原 envelope 的 `data.result.buildId/jobId`。GET `/api/hdl/builds/:id` 的 `data.result` 可为null，不把 queued/unknown 当成功 |
| 装载 | POST `/api/attempts/:id/hdl/programs`：recoveryGeneration、expectedAttemptRevision、buildId。显式替换另带 replaceSessionId/expectedSessionRevision；停止确认前不得隐式重发新Session |
| 输入 | POST `/api/attempts/:id/hdl/interactions`：recoveryGeneration、expectedAttemptRevision、sessionId、expectedSessionRevision、expectedSequence、inputs={switches16位,buttons5位,resetN1位}、advanceCycles。数据必须真实返回，不能本地代算ALU/段码 |
| 结果 | GET `/api/hdl/sessions/:id` 取得 revision/sequence/simTime/pending/stop；GET `/api/hdl/sessions/:id/trace?afterSequence=N` 的 `data.operation.result` 是有限下一批。pending时nextSequence不前进，按有界轮询/原Job事件等待，不循环补造结果 |
| 求助 | 原 POST `/api/attempts/:id/help` 加可选 `hdlSelection={snapshotId,buildId,sessionId?,operationId?}`；operationId必须配sessionId。code ObjectRef 必须指向同快照；不将runId当buildId，不自动选择最新对象。只问构建诊断时省略session/operation |
| 生成/投递 | 原Job自动消费者、C3 events；正文只从已获准 `teaching.delivered` 消费，保留 scope/jobId/messageId/generation、targetVersions、basis.objectRef 和新增可选 basis.hdl。hdl包含冻结workspaceRevision、Build可见投影hash及选中Session/Operation当前性，不在UI重建这些字段 |
| 回执 | POST `/api/actions/:id/receipts`：原deliveryId/clientId/contentHash、receiptKind、clientReceiptId/generation。响应是 `data`，没有嵌套result；真实浏览器确实渲染后才报告displayed，真人确认后才acknowledged。迟到回执保留raceReason，不洗成当前成功 |
| 停止 | POST `/api/attempts/:id/hdl/controls`：recoveryGeneration、expectedAttemptRevision、action=stop、reason；读取同一Session直到terminationConfirmed，不把stopRequested当已退出 |

代表性请求/响应、原对象ID及完整帧见真实记录的 `http` 数组。B 接口提供有限去敏诊断、选中源码与最多32帧，不发送私有答案/ALU检查资产、stdout/stderr、节点路径、镜像或SQL。

## 3. 当前性、错误与模型降级

新源码编辑、pending交互、sequence/revision变化、停止/替换、暂停/撤权/提交、代际变化，使原被冻结候选不能继续作为当前帮助。服务端在接纳、模型前后、候选事务、Delivery和Receipt事务复核；旧记录保留归属与拒绝原因。旧缺冻结basis的HDL历史消息仅作历史，不凭当前值补造其授权。

INVALID_REFERENCE=422、STATE_CONFLICT/VERSION_CONFLICT=409、FORBIDDEN=403、UNAUTHENTICATED=401、依赖/持久化不可用=503。unknown、X/Z、incomplete及截断/丢帧如实显示。当前保留宿主默认模型预算关闭；该状态下源码保存和HDL运行仍可继续，不能显示模拟AI正文替代失败。

## 4. 同机入口与 UI 本批验收

新35表库与原24表库分别保留；原3443服务未修改。本轮测试用同机3444与既有证书，UI应在统一3444宿主内接两课程，避免两个端口的同名Host cookie互相覆盖。提供的保留宿主只复用已建35表和当前继承的UI dist，默认不读取模型密钥、不触发付费调用。

```sh
# PAHER/WSL root；SOURCE 为本轮已构建固定源码目录
# EVIDENCE 为本轮获准完整工程JSON；启动不创建/迁移数据库
/opt/xunjie-runner/node/bin/node docs/tasks/evidence/dla-continuation-20261014/serve-hdl.mjs "$SOURCE" "$EVIDENCE"
```

当前 UI 的数字逻辑中心仍有静态代码/模拟板卡/模拟构建路径，尚未接入上述真实链路；源码定位见 `apps/student/src/components/workspace/CenterToolArea.tsx`。沿成员现有工程接入，不另建替代界面。UI验收记录：真实确认版本→失败诊断→显式选中对象求助→真实B/C3正文展示及回执→学生自行修正→新构建/显式装载→相同输入的真实输出改变；另验X/Z、pending/停止、旧版本提示和模型不可用仍可操作。浏览器验收当前未执行，UI回交自己的实际证据即可；不重跑本包已消费的模型批次。

2026-10-14后续接纳main@5c8c60e的正式登录/保存恢复/C运行UI批次；UI构建与464项单元测试通过，原作者浏览器证据保持其批次归属，本轮未重复浏览器验收。现场只读smoke发现3443的live/静态200、ready503；3444的live/ready/静态均200且严格TLS通过。原3443由其他批次维护，本轮不替它更换运行源或把历史ready200当当前。3444联调按本轮保留库/获准合成账号/现有信任通道使用；页面真正渲染HDL仍需上述UI接线。

当前3444宿主unit是 `xunjie-dla-ui-integrated-20261014.service`，使用保留新源码/最新UI产物及原35表，不读密钥/不触发模型。停止：`wsl -d Ubuntu -u root -- systemctl stop xunjie-dla-ui-integrated-20261014.service`。新宿主[严格TLS最终smoke](evidence/dla-continuation-20261014/ui-host-integrated-smoke.json)三项200；此为静态/健康检查，页面登录/HDL操作/帮助展示仍由UI实际浏览器验收。新H3 runner源码已提交，但节点未升级，本批UI继续消费原HDL构建/板卡/Trace协议，不等待H3。

## 5. 最新负责人顺序与 UI 立即接线批次

2026-10-14负责人明确要求“先审查、合并 #56 → 立即交 UI 真实 HDL 浏览器接线”；教师绑定、course_check、H3节点部署和完整测试后置。上节旧unit/旧3443 ready503只保留历史，当前准确运行源、两个active unit及严格TLS200见 [PR67现场包](DLA_PR67_RUNTIME_HANDOFF_20261014.md)。本轮审查/合并/公开回执见 [执行记录](DLA_PR56_REVIEW_MERGE_UI_20261014.md)。

UI 已交 [PR68固定805c76a的操作表](https://github.com/paher-din/XunJie/blob/805c76a6f230cb7f6a64bc94abf8adfa2616e955/docs/tasks/I0-UI30_HDL_OPERATION_MAP.md)，直接按 UDL-01～08 实现，不重制后端或操作表。UI 在本人任务列写集后，复用 TaskRoute/PrepWorkspacePage、原文编辑/确认、CenterToolArea 板卡/波形位置和原 Tutoring 客户端；只补真实课程分流、HDL命令/读取、四态显示、selection/basis及来源/回执守卫，不新建替代界面或换框架。Session真实字段是 `sessionRevision/confirmedSequence/simTimePs`，操作 `expectedSequence=confirmedSequence+1`；没有公开独立 Operation/current HTTP端点，通过 Session/Trace 取得状态。

可核查的原35表 HDL 分配为 `f4caed76-39b5-461a-bc5f-2325d8495d69`，学生 `synthetic-i0-student-b`，对应 Attempt `54bb4cfc-5d64-42a2-a1c9-58ea58458705`，深链 `https://127.0.0.1:3444/#/task/f4caed76-39b5-461a-bc5f-2325d8495d69`。这些是合成开发对象；读/写前从正常 Session/bootstrap/head 核授权、版本和代际，不硬编码对象或复用3443学生A的cookie。原演示已修复/停止，现有记录用于历史核对，不能当新浏览器当前运行。

同一浏览器交付顺序：人工编辑/保存错误HDL → 确认快照 → 真实失败Build与定位 → 显式选中该快照/Build求助 → 真B/C3正文渲染与displayed → 人工自行修订/保存 → 新成功Build → 显式装载 → 相同输入观察真实LED/段位/有限Trace改变 → 确认停止。再核新草稿/旧快照、pending、X/Z、unknown/刷新、旧引导失效和模型不可用仍可操作。真人明确确认时才记acknowledged，回交截图/公开HTTP对象/源码及引擎版本、失败和未执行项；合成浏览器不计真实学生学习或教学收益。

UI 开工不等H3。现场依赖分开处理：Robert已批准入口/密文reader是3443/学生A，HDL需要3444同源通路和学生B获准领取，不能把原工具误当已覆盖；沿现有SSH/严格TLS/原RSA内存通道提出准确窄适配，不新增账号/重置密码/改密钥/放宽Origin。当前模型预算关闭，旧真实单轮已耗用；历史真实提示可标旧快照展示，新的现场求助须另获一轮有界预算，不能用旧输出/fixture冒充新调用。UI先完成实现、隔离验证和降级路径，再单列确需的秘密/信任/付费动作，不因这些条件停掉可独立接线。
