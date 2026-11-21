# DL-A H3/H4：A会审补充与精确回交清单（2026-10-14）

接收人：C（paher-din）、B（scy404）、UI（wubq511 / Robert）及项目负责人。本稿完成A当前可独立准备的契约复核，沿[推进清单](I0_DLA_NEXT_STEPS.md) D-3/D-4；本地准备不表示已公开回交、共享契约已确认或功能已实现。

## 1. 已收到的材料及本次增量

已收到[C的ALU首批方案](https://github.com/paher-din/XunJie/issues/38#issuecomment-6147371151)、[B的HDL上下文首批回交](https://github.com/paher-din/XunJie/issues/38#issuecomment-6148072076)，A的原方案见[DL-A任务§18.2～18.3](https://github.com/paher-din/XunJie/blob/87a3b795b0e457445edbcd40ecf985e3a0dac012/docs/tasks/DL-A_COURSE_BUSINESS_INTEGRATION.md)。不要求重交上述材料；本次只补源代码约束、待冻结决定和精确输入。固定main为`0e683251031f28b3d2458e9f9093c8d92aa859b3`，B为`b6984801fcf63cf9cd6e72aab2cf3f94b6c1bd8b`，A为上述#56 head。实际复审/组合测试见[A记录](A_CURRENT_NEXT_STEPS_20261014.md)。

B诊断前缀/实际provider输入与LED/reset离线修复已由A复验；真实模型未重跑。HR-DL-02继续“有条件通过”；原模型正文被改写、PR正文仍称无条件通过，详见A两轴报告，交B追加勘误并恢复原证据。内部DTO、离线通过和旧C板信号验收均不能替代H3/H4共享确认与真实接线。

## 2. H3：A提出的业务边界与仍需C提供的内容

### 2.1 已可确定的A建议（待共享确认，未实施）

1. 学生显式选择已确认快照/成功Build及ALU实例，教师确认实际A/B/Cin/M/S/F/Cout引用和无重叠SW布局，形成不可变bindingVersionId/bindingHash。引用宽度分别4/4/1/1/2/4/1；名称/方向/范围由可信解析核查，不接受任意脚本。确认绑定不证明行为正确，不从LED/stdout或学生声明代算F/Cout。
2. 固定活动冻结binding、规则、采样profile、vectorSetHash与完整配置；旧活动仍结构检查/unverified，不自动升级。原授权Session/课程成员、本人Assignment/Attempt、活动、快照/Build/hash、decisionEpoch与代际在接纳事务、派发、提交结果时分别复核；同键同摘要复用原Job，异摘要拒绝。
3. 检查不能推进、替换或借用学生正在使用的板会话。暂停/撤权/提交/重开与迟到结果沿原Job/停止机制处理；过期结果只保留历史，不成为当前passed。
4. 已定义域2800向量：逻辑2048、加法512评F/Cout、A>B减法240仅评F；排除1296向量及非加法Cout。原[域自检](https://github.com/paher-din/XunJie/blob/87a3b795b0e457445edbcd40ecf985e3a0dac012/apps/teaching/tests/evidence/dl-a-closeout/h3-domain-selfcheck.json)只证明枚举，不是HDL通过。本次不重复运行同一数学枚举或累计通过数。
5. 只有绑定与版本一致、2800完整可信比较、无定义域不符且终止确认才passed。被评分信号X/Z是失败；缺稳定样本、覆盖不足、超时/丢帧或终止未知不能passed。私有输入集、比较器资产、全量答案/失败样本只在教师获准视图；学生/B只得去敏状态、版本和coverage。

### 2.2 源代码已查明的会话占用问题

固定[hdl-schema.ts](https://github.com/paher-din/XunJie/blob/b6984801fcf63cf9cd6e72aab2cf3f94b6c1bd8b/apps/teaching/server/workspace/hdl-schema.ts)有：

```sql
CREATE UNIQUE INDEX hdl_occupied_attempt ON hdl_sessions(attempt_id) WHERE termination_confirmed=0;
```

这使同Attempt不能同时保存两条未确认终止的Session。原提案“复用现有表，独立检查Session不影响板Session”尚不能直接落地：独立Session若也写现有hdl_sessions，会碰唯一约束。不能通过停掉板Session、伪造termination_confirmed、换Attempt或绕过守卫实现。

C需交**准确会话用途/占用设计和完整写集**，说明是否修改索引/现有JSON/Job kind、怎样并存、资源上限与取消/崩溃对账。A在收到方案后复核并交负责人确认；“无新表”不免除DDL或约束变更确认。本批未改变该索引、运行参数或引擎。

### 2.3 C的下一份回交只需补这五项

| 交付给A的具体输入 | 完成判据 | 下游 |
| --- | --- | --- |
| ALU层级引用语法及解析/宽度/方向/范围白名单 | 对合法不同模块/层级可解析；伪造、越界和额外文件/脚本不可用；说明关联哪一成功Build/快照 | A形成绑定/教师确认提案，UI接声明与确认差异 |
| 稳定采样profile及输入施加→实际观察链 | 说明100MHz低相位与稳定条件、simTime、输入一致性、X/Z、缺样本及超时如何区分 | A冻结规则/公开结果，B只接允许的去敏内容 |
| 独立检查占用与资源设计 | 明确上面唯一索引的解决办法，实际写集/约束/取消与对账；保持板Session不受推进/替换 | A/C会审后向负责人提交精确schema/引擎范围 |
| command/result及原Job映射 | 列字段、哈希、规则/绑定/指纹/代际、coverage与status/terminationConfirmed；不擅改公共状态集合 | A接纳/权限/结果投影；C执行/比较 |
| 原限额内2800向量覆盖与运行计划 | 分批/累计限额、私有资产位置、维护窗口与指纹影响明确；未实测写未执行，不延长原限额迁就 | 精确批准后C实施/目标验证，A核反例与生命周期 |

## 3. H4：A的接线提案与C真实读取缺口

### 3.1 已有读能力，直接复用

固定[hdl.ts](https://github.com/paher-din/XunJie/blob/b6984801fcf63cf9cd6e72aab2cf3f94b6c1bd8b/apps/teaching/server/workspace/hdl.ts)已导出readHdlBuild、readHdlSession；workspace公开对象也有readBuild/readSession/readTrace。

| 现有能力 | 已有保障 | 还不能冒充什么 |
| --- | --- | --- |
| readHdlBuild(tx,actor,buildId) | 正常actor/Attempt读取授权；request/result、快照归属/hash、board/mapping/runtime及原result_hash校验；返回request/result/status/jobId | 无结果Build不能构造可信成功诊断/产物；运行Job身份不是Build身份 |
| readHdlSession(tx,actor,sessionId) | 持久行/JSON关键字段一致性及正常actor授权；有revision/sequence/pending/stop/termination信息 | 有Session不等于正在使用的帧可当当前帮助；待交互/替换/停止仍须核当前性 |
| readTrace(tx,actor,sessionId,afterSequence) | 读首条sequence大于游标的Operation；结果存在时核hash/session/sequence，只有存在结果才推进游标 | 是分页，不是按operationId精确读，也不等于原选定Operation与最后可信帧的完整校验 |

C不需要重新交“有没有Build/Session接口”。请补：**按operationId的公共只读接缝提案/实现边界**、同事务current投影和带来源的实际Build/Session/Operation样例（成功/无结果、pending、stopping、termination unknown、替换/新sequence）。样例明确snapshot/hash/Build/artifact/session/revision/operation/sequence/finalFrame/resultHash及状态缺项；已有样例可给固定链接，不重新制造同一份日志。

### 3.2 A完整的最小业务接线建议（待共享确认）

- 原ObjectRef保持code/run/resource/project；建议原studentHelp输入增加可选`hdlSelection={snapshotId,buildId,sessionId?,operationId?}`，operationId必须带sessionId。仅学生显式选择，服务端读scope/hash/状态；不把runId换成buildId、不静默选最新Session。原student_question及accepted_input_hash冻结选择；重放/冲突仍走原语义。
- 同一授权事务读Session/成员/本人Assignment/Attempt/活动政策/限定检查、原问题/Job及固定HDL链，校验同快照、Build/配置/板映射/运行版本/代际。建议同步事务钩子readAuthorizedHdlContext/readHdlCurrent，返回最小投影；模型/网络在事务外。缺装配维持[现有help门禁](https://github.com/paher-din/XunJie/blob/87a3b795b0e457445edbcd40ecf985e3a0dac012/apps/teaching/server/app/digital-logic.ts)DEPENDENCY_UNAVAILABLE。
- C负责可信只读Build/Session/Operation与pending/stop/termination/sequence投影；A负责真实授权和组合，B适配已确认投影及最小模型输入。不能把B内部AuthorizedHdlHelpContext/HdlHelpCurrentState直接宣布为三方正式契约。
- provider调用前、返回后、C3 completeTeaching候选提交，以及Delivery/Receipt消费前都核权限、原Job、decisionEpoch/learnerStateRevision/代际和冻结HDL链。暂停/撤权/停止、新快照/替换/新sequence/pending不能使旧候选成为当前帮助；拒绝原因保留历史。
- 最多8条去敏诊断各1024字符、已应用输入/finalFrame和最近最多32帧Trace（accepted上限4096），保留X/Z、simTime、sampleCount/dropped/coverage/截断。私有资料、stdout/stderr、节点路径/命令、镜像细节和ALU资产不送模；范围以原政策为准。

### 3.3 回交与实施顺序

1. B在#54恢复原模型证据，追加准确勘误并更新PR结论；A/原审查者复核。已通过的诊断/位值/reset/main合并不重做，未授权调用真实模型。
2. C交上面的精确Operation/current读取与真实样例；UI交HDL“操作→请求→结果/状态→缺项”及学生显式选择怎么沿现有界面表达，不自行新增页面/API。
3. A汇总选择字段、哈希、事务读取、pending/停止/current投影、C3提交/投递/回执守卫的准确写集与验收矩阵→负责人确认。收到输入前不请求笼统批准；H3/H4方案准备与I0浏览器准备可并行。
4. 确认后A/B/C各改本域并联合验证：正常登录HTTP→原问题/Job→公共worker→候选/投递/回执；跨归属/错误hash/私有资料、旧版本/代际、pending/替换、重复/冲突、停止/迟到。真实模型及浏览器按对应范围另验，本稿矩阵均未执行。

## 4. 本次交付状态

A的业务边界、代码约束、共享确认提案与具体负责人/回交清单已本地完成；B文档修复、C五项H3输入及H4精确读取/样例、UI操作/选择表仍待。实施ALU和真实HDL求助依赖这些交付与准确确认，不依赖整个#39/#40关闭。共用I0交接见[逐H包](I0_A_UI_REVIEWED_HANDOFF_20261014.md)，沿#30一次交付；本增量沿#38引用，不复制I0原20项。

本稿没有新业务实现/契约冻结/schema/模型/物理节点/浏览器操作或远端发布；#30/#38/#22继续Open，保护基线由授权维护者汇总。
