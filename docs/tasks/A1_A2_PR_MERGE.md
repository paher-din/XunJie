# C1/C2/A1/A2 四项 PR 合并记录

日期：2026-10-10（Asia/Shanghai），主责：A。项目负责人明确要求“你来处理合并开启的4个pr”，授权对已交付 PR #16/#17/#18/#19 按依赖顺序处理合并。此任务不扩大任何实现/数据库/密钥/CI/UI/节点维护范围，不删除源分支或他人工作，不自动关闭未满足完整条件的 Issue。

## 已读依据与操作范围

已读 AGENTS、README、PRD/MVP_SPEC/TECH_DESIGN 既有任务章节、C1 §13～16/C2 §9、A1 §12～14、A2 §11～12、最新 PR 正文与全部审查线程。沿已批准 M-02/M-10、AC-02/06/08/15、NFR-03/04 和实际首批条件核定；产品/规划/参考规范保持只读。当前可写本人合并记录及 README；不覆盖 C 主责任务或主工作副本草稿。

固定来源：main=54ca54c；C1 #16=f8b6c6ff3e6302b59453f108dd16a57073fcf255；C2 #17=64eaa958ff565de245a965c5a29945eb2b08b2eb；A1 #18=5b9d83ed4c5700ec808b1127061b272c6228b192；A2 #19=bde7ccf4991e3bc7aa74a3a623554fd0937d6861。四项 Open、非 Draft、mergeable，均无 GitHub commit statuses/workflow 记录；空 CI 状态不表述为通过。

## 合并前验证与审查

C1/C2 原五项意见固定修复增量再次两轴只读复核：Standards 硬性违规/可操作异味 0/0、Spec 未解决 0，五项可关闭。C1 精确 C int 上限/溢出错例、从完整清单避缺失路径碰撞已修复；C2 私有 marker 的安全投影、所有未终态运行取消待确认、重复停止保终态已修复。进一步 resultHash/内部 Job 字段裁剪由 A1 已审最小补丁承接，最终合并链必须保留。

本次在各自固定 head 实际执行：C1 course/run-snapshot/report 指定回归 10/10、零失败/跳过；C2 records/workspace/runs 18 项中 17 通过、0 失败、1 真实 C1 入口跳过。均使用批准 Node24.21.0，本机不启动节点/容器/维护身份或创建实际业务库；测试后返回原 A2 分支。作者 C1 guest48/SSH10、C2真实18/18是其原证据，本次不冒充复跑。

A1 已审独立 typecheck/build、112/117 五跳过；A2 已审联合151/157六跳过，PAHER 对源码8421157真实指定1/1零跳过证据已入库且摘要/指纹关联一致。最新 A2 只增文档，业务源码相同，合并前不重复无变化的全部回归。真实课程/账号、浏览器/TLS、C2 整体/恢复/负载和完整 G1 仍分别验收。

## 执行方案与记录原则

确认原五线程修复后关闭，使用每个固定 head SHA 与普通 merge（不 squash/rebase）。先合 C1到main；之后逐项将 C2、A1、A2 base 调整到main，每步重新核实际 head/base/diff，合入后才推进下一项，保留源分支/历史。最后获取实际 main 并比较与已验 A2 完整树/业务源码，执行所需工程/文档验证，记录四项 merged 状态、合并SHA与最终main；不以PR关闭代替Issue/产品验收。实际结果见下方，计划不计作验证。

## 实际合并结果

四项均已 Closed / merged=true、base=main，按 C1 → C2 → A1 → A2 使用普通 merge 完成；自动删除源分支关闭，四个来源 head 保留不变。后三项在前项成功合入后才调整 base；重新读取 head、mergeable 与完整文件列表，实际范围分别 42/20/57/28 与固定增量完全一致。PR 描述同步最新依赖/授权事实，未关闭业务 Issue。

| PR | 增量文件数 | 固定 head | 合并提交 | 合并时间（UTC） |
| --- | --- | --- | --- | --- |
| [#16](https://github.com/paher-din/XunJie/pull/16) | 42 | `f8b6c6ff3e6302b59453f108dd16a57073fcf255` | `d25132179d19e898ead4930bb08b2b3f5021e2e1` | 2026-10-10T13:44:23Z |
| [#17](https://github.com/paher-din/XunJie/pull/17) | 20 | `64eaa958ff565de245a965c5a29945eb2b08b2eb` | `a743fb41007bab6887af46bbba240bbbbfcf895e` | 2026-10-10T13:44:49Z |
| [#18](https://github.com/paher-din/XunJie/pull/18) | 57 | `5b9d83ed4c5700ec808b1127061b272c6228b192` | `37d8c86ada6ae0021db4c11a214ad8d00978d0f1` | 2026-10-10T13:45:14Z |
| [#19](https://github.com/paher-din/XunJie/pull/19) | 28 | `bde7ccf4991e3bc7aa74a3a623554fd0937d6861` | `c9bfbb6f7ea2303f9cc0b642551777bbe022a243` | 2026-10-10T13:45:42Z |

原五线程已逐条确认 isResolved=true：C1 的 `PRRT_kwDOVA3Qmc6rA9nF` / `PRRT_kwDOVA3Qmc6rA9nH`；C2 的 `PRRT_kwDOVA3Qmc6rA9qK` / `PRRT_kwDOVA3Qmc6rA9qM` / `PRRT_kwDOVA3Qmc6rA9qO`。没有以解决线程替代源码修复/独立复核，也没有新增代签批准。

合并后 main=`c9bfbb6f7ea2303f9cc0b642551777bbe022a243`。实际执行 `git diff --exit-code bde7ccf4991e3bc7aa74a3a623554fd0937d6861 origin/main`：零差异；四个固定 head 的 `git merge-base --is-ancestor` 全部通过。合并没有改变已验源码或原始证据字节，保留 A1 对公开 resultHash/内部 Job 的最小裁剪。没有新增源码/依赖/schema/凭据/CI/UI 修改，不无依据重复合成全套或真实 C 节点验收。

## 合并后验证与交接

在最终合并版本使用 Node 24.21.0 实际执行：

| 命令/核查 | 实际结果 |
| --- | --- |
| apps/teaching 内 `npm run typecheck` | 通过，含 runner 严格检查 |
| apps/teaching 内 `npm run build` | 通过 |
| `node tools/a0-review/check.mjs` | 通过：30 文档、333 内部引用、27 已批准变更接口；业务测试标记 NOT_EXECUTED 仅指此静态脚本 |
| `node --test tools/a0-review/check.test.mjs` | 16/16、0 失败/跳过 |
| `git diff --check` | 通过；文档提交仅 README 与本记录 |
| GitHub 合并/源分支回读 | 四项 Closed / merged=true、base=main；四个来源分支仍存在且 SHA 不变 |
| Issue 状态回读 | #9/#10/#12/#13/#14 仍 Open；本次不执行关闭 |

README 已同步四项已合并状态、A1/A2 的当前事务/权限接缝和本记录导航。主工作副本未提交草稿与此工作副本的既有诊断日志均保留；不纳入合并文档提交。受保护 MVP_SPEC §10、TECH_DESIGN 和规划的最新实现/合并状态仍待授权维护者汇总，任务合并不自动完成产品或关闭 Issue。真实节点/全套业务测试/浏览器/TLS 在本次合并后未执行：完整代码树与已验候选一致，沿用上文准确来源和范围的先前事实，不补算通过。
