# 06：一次固定快照 Core 运行与基础结果

**What to build:** 学生明确选择固定快照与 TextScope Core 参数，发起一次 C 运行，看到与该快照绑定的公开状态/诊断，再主动修订。

**Blocked by:** [03 确认保存与不可变快照](I0_UI_03_CONFIRM_SNAPSHOT.md)。

**Document status:** `document-revised`，未实施。

**Status:** `blocked`：03 未交付，P-01 与 P-04/U-06 未落实。真实运行另须对应 H 条件，准备实现不等 H 全包。

## 依据与范围

[接入规格](I0_UI_SPEC.md)、[客户端约束](I0_UI_CLIENT_CONTRACT.md) §3/6～8；M-02/09/10、AC-04/10/12/15、NFR-03/04 前端责任。

负责一次 Core run 命令、已有 Job/Run 读取与基础结果；可写对应前端/同一 fixture/测试、本文。不实现编译器/worker/SSE/沙箱或调度，不改单作业/槽位/课程/共享字段。取消与未知核对归 06A，历史/产物归 06B。

## Acceptance criteria

- [ ] 学生选确认 snapshot、入口 C 文件与 stats/find/top 参数，fileIds 引用该快照实例；不接受 shell/宿主路径，不从当前 draft 拼旧快照。
- [ ] POST runs 使用权威 expectedAttemptRevision、snapshotId、runtimeProfileVersion、entryFileId/input/mode、代际和键；POST 前保留冻结原命令。成功回执只取得 runId/jobId，再 GET。
- [ ] 同请求未知不能换键重跑；新参数只能是学生新操作。未核原请求/服务执行资格时阻止再次发起；具体核对/取消路径由 06A 交付。
- [ ] 已有 GET Job/Run 有界轮询，隐藏/断线管理频率；每次 await 核上下文、代际、run/job/读取轮次，旧 running 不覆盖新终态。
- [ ] 状态、网络未知与执行失败区分；stdout/stderr 仅取 diagnostics available，unavailable 不当空成功。编译位置缺失只读原信息，不发明未公开 phase/行列。
- [ ] 当前编辑不改变旧 run 的 snapshot/hash。入口/参数仅来自已关联 runId 的本机冻结请求并标来源；GET 不补这些字段，换浏览器/缓存丢失时标“历史参数不可回取”。
- [ ] 固定 Core 结果安全只读，不推为课程通过或能力评价；无正常宿主/readiness 不启动本机 C，准备结果明确合成。
- [ ] 浏览器验证一次 Core 成功、编译/执行失败、输入/限额拒绝、运行中改稿、历史参数缺缓存及旧 poll；断言实际命令/公开 wire。工程检查记录准确结果。

## 交接与状态

01→02→03→06 即最小准备路径；不等 04/04A/05/06A/06B/07 才交这条能力。真实运行按客户端约束 §8 所需身份/保存/readiness/原 jobs/相应样例交接；不用完整历史输入投影作为前置。

当前编码、浏览器与真实节点检查均**未执行**，未声称 I0-A 整链通过。
