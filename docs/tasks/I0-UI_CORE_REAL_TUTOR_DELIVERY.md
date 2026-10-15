# I0-UI：C 真实辅导闭环与两课程整合交付

日期：2026-10-15（Asia/Shanghai）。主责：UI / Robert（wubq511）；分支：`i0/ui-frontend`。目标：[当前清单](I0_REMAINING_WORK_CHECKLIST.md)的两项必做工作。

## 依据与范围

已读 README、PRD §3.2/4.2～4.4、MVP_SPEC §1.3/M-03/M-04/§8、TECH_DESIGN §7.4/8/9/11、TEAM_WORK_PLAN 的 I0/I1/I2 分工、P4 §2～4、I0_UI_SPEC、客户端约束、IMPORT_SOURCE 及当前 C/HDL 记录。按 B4-CORE-01 完成一个代表性 C 场景，复用原登录、编辑/保存/运行和 HDL 证据。

Robert 要求完成清单中当前可做的全部必做项，已授权普通 Git 推送/PR/合并及本机合成验证。复用已批准 `/opt/xunjie-ui-local` 35 表宿主、专用执行 VM 和本人环境 key 的 `student_help` 通道；开发合成操作、人工提示核对与学生接棒分别记录，不计真人学习效果。

2026-10-15，负责人对“核对提示、点我先试试、补分号后保存、冻结并重跑”明确回复“你自己完成”。本次由 Agent 按该委托执行页面核对与开发合成接棒，完成后直接推进 PR #80 合并；操作主体记为 Agent，不记作 Robert 本人回应、真人学习或人工课程审阅。

写集：本文、清单、必要的 UI C 接缝及去敏证据，README 只同步入口。产品/规划/参考/规范、数据库/schema、秘密文件和他人工作树只读；HDL 复用原会话正式交付。

本次真实引用阅读复现“资料暂不可用”：页面只取首个 project 引用，资料 resolver 又只认识裸 resourceVersionId，未适配原服务端段落摘要引用。修复写集限 `PrepWorkspacePage.tsx`、`workspace/tutoringReturn.ts` 和对应测试；复用现有公开段落元数据、摘要工具及材料授权/内容核对，不改 API/schema/共享字段。按实际混合引用模式先跑红回归，再修复并用原 Action 复验。

## 固定交付与验证

- H-05：[PR #73](https://github.com/paher-din/XunJie/pull/73) 已合 main，merge `a49863f894a4485dd5f4b7b08a27fc3a25414276`。原 110 通过/5 受控跳过按相同源码复用；本机 `files.ts` / `records-adapter.ts` 已接收，Git blob 分别为 `ee80fab376d4254ddefdfbc70163d7d787cb7bac` / `f2f85d1affc140610e7b52a86baa4a3d6d71412b`，与本分支一致。真实普通保存后 Attempt revision 仍为 2、decisionEpoch 仍为 0。
- HDL：[PR #79](https://github.com/paher-din/XunJie/pull/79) 固定 head `36f9304979a20ddeb2c00fbbe5dd0a28e2ac0a09` 已合 main，merge `2309cee31de16a0671636a2a60980443f7a16b23`；本分支接收为 `348d4eb5c101f5dea714e2896c9e2134955835fa`。共享工具、真实提示/修订/构建/同输入 LED 改变/确认停止见[原回交包](evidence/ui30-hdl-20261015/handoff.md)。不接收原会话未提交文件，也不重复 HDL 实现。
- 原 UI 包：[固定清单](evidence/ui-core-c-20261015/ui-manifest.json) source `bd8d3e06664bc51b5feb6b077e9f51c6a7564cd2`，入口 `index-Iq2DyhKA.js`；143 文件逐字节核对，ZIP 5,653,435 bytes / SHA256 `778883419f00e66178b6a75f3bb9ddb09b7f237da0068dfed6aeb67073062da9`，35 项边界扫描零命中。已接收 8d613a7 的编辑器纵向 flex 修复；本人实测 C 编辑器 646px、5 行正文完整可见。早期 cd17bef 候选未部署，已由此包替代。
- 当前组合：`apps/student` 的 `npm run typecheck` 与正常 `npm run build` 退出 0；接收高度修复后再次正常 build 退出 0。接收 PR79 当时只有共享工具/文档/证据，与 bd8d3e0 的生产源码无差异；本次引用修复另做定向验证和正常构建。原大 chunk 提示保持。文档链接检查 errors=[]，差异空白检查通过。
- 运行入口：[仓库工具说明](../../tools/i0-hdl/README.md)；本机既有 `D:\XunJie_Project\i0-ui55-connection\hdl-ui\local-environment\XunJie.ps1 start` 沿用同库、VM、原代际和指纹。正常 HTTPS `https://127.0.0.1:3444`，当前 live/ready 均 200；C/HDL 使用各自分配深链与 A/B 合成账号。

## 本轮 C 真实结果

固定对象：`synthetic-robert-student-a` / `synthetic-robert-course-c`，Assignment `fb0983e4-81bc-487b-8b50-7ffe984c38bb`，Attempt `1e657276-83dd-4129-a1c5-fb8c66f1c21c`。原始去敏读数见[操作前](evidence/ui-core-c-20261015/before-c.json)与[辅导展示后](evidence/ui-core-c-20261015/after-help-c.json)。

从真实编辑器显式移除 main.c 第 3 行末尾分号，确认保存/冻结 v2；原消费者在专用 VM 实际运行，Run `998797da-8259-4890-8032-2f6f34fbdb03` / Snapshot `1ac0f3a4-d347-415f-8170-6c8d8927fb74`，结果 `compile_error`，诊断 `expected ';' before 'return'`。Job succeeded 只表示作业执行结束，不代表编译或课程通过。

针对这次原运行明确求助，真实 DeepSeek Job `234e761a-e533-4bbc-b61f-faa9d8800900` 成功，Action `0b8386a1-7c5b-46ba-8e68-4b9d35072890` / Message `e604bf44-88b3-4efe-879a-3f31d0ecf89e`。正文只提示第 3 行缺少分号、保存重跑，没有代写整份程序；来源仍是上述 v2 Run/Snapshot 和原政策。一次实际 HTTP200，用量 input 1915 / output 353 tokens，见[本次原传输元数据](evidence/ui-core-c-20261015/c-model-transport.jsonl)。其他会话的 HDL 调用没有计入本次 C 次数。

真实正文滚入可见区域后，原 received seq220 / displayed seq227 均确认；[页面截图](evidence/ui-core-c-20261015/c-real-help.png)与原回执分别留存。当时“我先试试”已可用、尚未回应；后续 Agent 委托接棒结果见下。曾疑似正文展示未记账，实际正面积可见断言已通过，现有 observer 正常；没有新增源码修复或回归测试。

依负责人本次明确委托，Agent 在原页面点击“我先试试”（acknowledged seq244），只补 main.c 第 3 行分号，再确认保存 seq246、冻结 seq247、重跑 seq248。新文件与快照均为 v3；Snapshot `0717d3fc-7150-425d-8b38-b0e7d0f24078` / Run `fb685583-7896-4eb4-8cfd-6053da36b100` / Job `ccf4bc22-6fa1-47e8-b1c6-55e76d61cb11`，编译和执行 exit0，stdout 为 `Robert local C core`，stderr 为空、unitTerminated=true。见[原终态导出](evidence/ui-core-c-20261015/after-final-c.json)和[实际页面](evidence/ui-core-c-20261015/c-v3-run.png)。report.txt 仍为 missing、check_state=null；本轮核的是修订编译重跑，不称课程判分或 Report 通过。

只读深比较确认：原 v1/v2 Run、快照、辅导 Action/Message、Delivery、旧回执与命令收据逐对象不变；原辅导仍绑定 v2 Run `998797da…` / Snapshot `1ac0f3a4…`。v3 只补分号、文本与原 v1 精确一致；Attempt revision3/epoch1 未变，未结 C Job 为 0。明确回应只证明受委托的页面操作，不计 Robert 本人回应、人工课程审阅或学习效果。

## 失败与收尾

共享 Chrome 标签换账号曾由会话守卫中断 C 求助，未产生模型调用；改用内置浏览器独立登录，保留同一 C 对象。首次 C Help `6bf2173d-e6b1-4fe9-8fd6-ea89fbc5a1f6` 在模型默认关闭时 failed/budget_exhausted，调用次数 0；显式启用原模型入口并发起新问题后成功，失败记录保留。只读导出首次 Linux helper 路径错误、Chrome 读高超时分别改用现有 D 盘导出工具及新页面复核解决。

C 合成接棒与重跑已完成；引用阅读修复的真实混合引用回归先红（27/28 通过，目标用例失败），修复后28/28通过，typecheck退出0。正常 `rtk npm run build` 已退出0（原大 chunk 提示保留）；接下来用同一原 Action 复验资料阅读后，合入本批 PR #80。2026-10-15 03:26（Asia/Shanghai）通过原 HDL 页面停止回交后遗留的临时 Session，终态 failed / terminationConfirmed=true（不计正常停止通过），未结 Job / 未终止 Session 均为 0，见[实际终态收据](evidence/ui-core-c-20261015/cleanup-receipt.json)和[原页面](evidence/ui-core-c-20261015/hdl-cleanup.png)。随后用原工具核业务退出，再按默认 start 恢复 modelEnabled=false、同 VM/代际/指纹、live/ready200，见[启动收据](evidence/ui-core-c-20261015/model-disabled-start.json)。C 原 received/displayed 和待人工回应状态保持。
