# 06B：历史运行比较与公开产物

**What to build:** 学生只读比较已有运行的快照、来源明确的参数、状态与输出，并查看可公开的检查/结果文件。

**Blocked by:** [06 一次固定快照 Core 运行与基础结果](I0_UI_06_RUN_RESULTS.md)。

**Document status:** `document-revised`，未实施。

**Status:** `blocked`：06 未交付，P-01 与 P-04/U-06 历史/产物控件未落实。

## 依据与范围

[接入规格](I0_UI_SPEC.md)、[客户端约束](I0_UI_CLIENT_CONTRACT.md) §6/7/8；M-02/09、AC-04/12/15。可写已有结果容器的比较/产物、窄 files 客户端及测试、本文；不改 Run 投影、课程检查或私有资料规则。

## Acceptance criteria

- [ ] 两次既有 run 分别保留 run/job、snapshot/hash、profile/mode、状态和输出；失败/未知也可比较。
- [ ] 参数仅在本机原请求经回执关联后展示并标来源；另浏览器/缓存丢失或未关联时明确不可回取，比较仍显示已有公开事实。禁止 fixture 为 GET Run 加 input/entryFileId/inputHash。
- [ ] 课程检查只显示公开 verdict/failureKind，HTTP course_check 与节点 check 分层；不得补私有测试输入/答案/stdout，也不将 Job succeeded 当检查通过。
- [ ] files 的 redacted/unavailable/missing/incomplete 单独显示；available 文件核 run/snapshot/id/hash/bytes/状态，有完整文本才允许查看/下载。检查产物 redacted 不补正文。
- [ ] 固定活动确有 Report 能力才使用其允许参数/产物名，公开可回取时才显示产物；无此能力保持不可用，不扩课程或造报告内容。
- [ ] 比较/下载只读、安全展示，不能写回 ProjectFile、改当前草稿/旧快照或覆盖失败结果。
- [ ] 浏览器验证参数有/无本机来源、跨上下文历史读取、check 裁剪、产物缺失/不完整/hash 不符与合法下载，断言无隐式写请求；工程检查记录事实。

## 交接与状态

不等 06A 取消；真实历史按公开投影即可接，产物按对应 H-06 样例接，不能因缺完整参数而私改后台。当前实现/检查**未执行**。
