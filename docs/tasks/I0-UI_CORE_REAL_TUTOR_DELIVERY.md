# I0-UI：C 真实辅导闭环与两课程整合交付

日期：2026-10-15（Asia/Shanghai）。主责：UI / Robert（wubq511）；分支：`i0/ui-frontend`。目标：[当前清单](I0_REMAINING_WORK_CHECKLIST.md)的两项必做工作。

## 依据与范围

已读 README、PRD §3.2/4.2～4.4、MVP_SPEC §1.3/M-03/M-04/§8、TECH_DESIGN §7.4/8/9/11、TEAM_WORK_PLAN 的 I0/I1/I2 分工、P4 §2～4、I0_UI_SPEC、客户端约束、IMPORT_SOURCE 及当前 C/HDL 交付记录。按 B4-CORE-01 完成一个代表性 C 场景，复用原登录、编辑/保存/运行和 HDL 证据。

Robert 当前要求完成清单中能够做的全部必做项；沿用普通 Git 推送/PR/合并及既有本机合成验证授权。接收原模块既有修复，复用已批准 `/opt/xunjie-ui-local` 35 表宿主、专用执行 VM 和本人环境 key 的 `student_help` 通道，原用途/政策/次数守卫保持。开发合成验证不计真人学习证据；提示的人工核对与学生本人接棒分别记录。

固定 C 对象：`synthetic-robert-student-a` / `synthetic-robert-course-c`，Assignment `fb0983e4-81bc-487b-8b50-7ffe984c38bb`，Attempt `1e657276-83dd-4129-a1c5-fb8c66f1c21c`。先读当前权威版本，再从现有界面完成真实诊断求助、展示/回应、修改保存与新 Run。

写集：本文、当前清单、必要的 UI C 接缝修复及其对应验证/去敏结果；启动入口如有变化同步 README。产品/规划/参考/规范、数据库/schema、秘密文件及他人工作树只读。HDL 会话正在整合其共享修复，完成回交前不修改它的宿主或浏览器。

## 接收与当前进展

2026-10-15 已核 PR #73 原批准、审核与 110 通过/5 受控跳过证据；三个源码文件与当前 main 原基线一致，修复尚未接纳。已按原授权普通合并 [PR #73](https://github.com/paher-din/XunJie/pull/73)，merge `a49863f894a4485dd5f4b7b08a27fc3a25414276`，本分支快进接收。该 Git 接收不表示当前本机运行副本已换版。

HDL 会话的实际节点、真实模型、显示/回应、修订/新构建/同输入输出变化与停止已形成记录，当前正在完成主线接收与最终回交。C 原实际浏览器仅有运行成功，未有真实辅导闭环；下一步接收其共享修复及稳定本机入口后补这一场景。

本轮只读 `xunjie-local.ps1 status`：既有 VM 活跃，C/HDL 原受限 SSH 就绪、同代际/指纹核对通过，正常 HTTPS live/ready 均 200，模型默认关闭。独立 Chrome C 标签已从现有 Session 进入，读到原 main.c v1 与快照 v1，没有新增业务操作或模型请求。HDL 活跃线程仍在复验其固定共享修复，等待其结束后再切换同一宿主。

接收 HDL 源码前的任务文档检查：115 份文档 / 1751 条内部链接，`errors=[]`；差异空白检查通过。本轮没有新增生产代码，PR73 的原回归适用；当前两项必做尚未全部完成。

随后接收 HDL 已固定源码 `41563d9101355a08cb8f65633bab0319e344cacb`，与本分支 H-05/任务记录普通合并为 `cd17bef3caa9ac090915005d08adb1a56503d4f5`，无冲突。HDL 功能由原会话交付，本轮没有重复实现。当前组合的前端 typecheck 与正常 build 退出 0，入口 `index-DFycY8By.js`；原大 chunk 提示保持，没有为通过而调整阈值。使用原打包工具冻结到 `ui-core-cd17bef`，没有切换活动宿主。

本机两处 H-05 源码与本批 Git 正文经 EOL 归一后仍不同，须在现场交接后接收 fixed main；现有同库、配置、VM 和代际保留。

组合包：143 文件逐字节验证通过，35 项正常边界扫描零命中，`sourceDirty=false`；ZIP 5,653,436 bytes / SHA256 `8fbce43c9ca53338e999f7477ce3507606eff5782d641c43901467e47bdc12d1`。接收后的文档检查 116 份 / 1754 条内部链接，`errors=[]`。当前 C 权威记录仍只有一次运行、没有辅导 Action，不能把 HDL 模型闭环算成 C 闭环。
