# 日常操作路由

只进入本次目标对应的说明，参数先核对当前 CLI `--help`。以下链接以本文件真实位置 `skills/xunjie-development/references/` 解析。

| 本次目标 | 按需读取与完成判据 |
| --- | --- |
| 启动、状态、停止或删除 | [本地工具](../../../tools/xj-dev/README.md#用法)：doctor/up/status/down/delete；确认工作树、模式、归属进程和入口。只读查询不初始化，停止保留数据；显式 delete 只清理所选模式已登记载荷并保留永久锁，不能手工删除环境根 |
| 切换本地、云端 API、云端页面 | [模式切换](../../../docs/development-tooling.md#切换本地与云端)：调用 use，核对代码来源、版本、数据目标与能力；失败保留原模式。`not-exposed` 代表版本未验证 |
| 手动登录/查看测试账号 | 只读下节[手动登录与查看测试账号](#手动登录与查看测试账号)，按当前模式取得实际私有文件路径，供本人查看；无需重跑首引导或 GitHub 授权 |
| 更新数据起点、查询团队固定基线 | [数据基线](../../../docs/development-tooling.md#获取与更新数据基线)：明确固定版本后采用；首次未初始化的当前工作树可用 `--here` 只导入数据，已有环境保留并另建隔离副本，按返回路径继续。不自行挑选或发布团队基线 |
| 打包、检查或恢复业务状态问题 | [复现包](../../../tools/xj-dev/README.md#复现包与基线)：先确认触发前/事后现场及课程/成员/任务范围；将必要 dirty/untracked 文件显式选入 `code.paths`。capture/inspect/restore 后，审阅新工作树并显式 up 才执行 verify |
| 分享 Agent 调用/评估结果、接收调试包或比较修复前后 | [Agent 调试包交接](agent-debugging.md)：核对包类型支持，选定 Run/case、冻结报告与导出、按编号移交；阅读、平台导入与重新运行分别验证 |
| 分享编号、续传、按编号下载或清缓存 | [团队复现编号与直传](../../../tools/xj-dev/README.md#团队复现编号与直传)：先冻结 ZIP，再 share；失败保留原 ZIP 与 transfer ID 并 resume。fetch 只校验下载，verify 才记录实际复现；文件权限与 page/node 分开 |
| 已有身份失效、权限更新或补齐接入 | 只读[GitHub 接入与身份续用](onboarding.md#github-接入与身份续用)：已有本人登记优先 refresh；首次登记走 login，待批准只需告知维护者 GitHub 用户名。保留同一 home/key，只续缺项，不重讲首引导 |
| 维护者批准 GitHub、管理邀请、撤销或备份 | 仅明确的维护者任务读[维护者入口](../../../docs/development-access-operations.md#维护者入口)。GitHub 名单 owner 命令契约为 `access github-approve` / `access github-list` / `access github-deny`，参数和可用性以实时帮助与服务响应为准。服务现状与备份恢复读[当前交接入口](../../../docs/references/2026-10-24-team-development-handoff.md#负责人备份与恢复)，旧基线退役读[团队目录维护](../../../tools/xj-dev/README.md#团队复现编号与直传)。按本次管理授权操作；管理凭据只留在维护者设备 |
| 实现或替换开发工具 | [实施与旧入口清理](../../../docs/development-tooling.md#工作项与实施时机)：依据当前任务及实现更新 CLI 帮助与工具事实，不把规划写成已交付 |
| 决定学生编译/仿真位置 | [课程运行议题](https://github.com/paher-din/XunJie/issues/114)及当前产品契约；开发环境的云端位置不能决定学生产品架构 |

只停止工具拥有的进程；操作前确认数据目标。源码发布、写共享业务数据、发布基线是不同动作，沿用各自授权。数据库和凭据保持在仓库外，问题交接使用稳定编号与完整摘要。

恢复不执行包内脚本；自动 verify 仅发送声明式业务 HTTP 步骤，并严格校验该 home 的受管 CA。缺执行/模型条件、仅事后现场或外部响应不确定时，报告“复现未验证”。本地文件闭环不依赖团队文件服务。

报告实际完成阶段及未完成项；首次之后只在用户询问或当前决策需要时解释相关功能。

## 手动登录与查看测试账号

用户询问账号位置或要自己登录时，按需读 [README 账号说明](../../../tools/xj-dev/README.md#首次启动之后)，核对实际页面与数据目标。GitHub 接入取得开发权限，应用页面登录使用对应环境的测试账号。

- **本地页面与本地数据**：从当前工作树/instance 的 `status --json` 读取 `accounts.credentials.file`。
- **云端受管账号（cloud-api / cloud）**：从当前登记结果读取 `enrollment.accountFile`；当前工作树尚未绑定时先查询同一 home 的安全 registration。仅文件权限的成员可能没有应用账号，按获授能力说明，不借用他人身份。
- 确认实际私有文件存在后，给出其绝对路径的可点击文件链接，或在编辑器打开让本人查看。路径取实时响应，不猜默认目录；密码不复制到聊天、日志或 Git，不用 `cat` 等回显账号正文。文件缺失时保留原数据与设备身份，按对应阶段修复，不重置账号。
- 仅维护者按需查看原云端演示账号时，使用 **owner 电脑**的 `~/.config/xunjie-cloud/accounts.private.txt`，先解析为该电脑的实际路径。该文件不作为全员共享账号材料，也不替代成员自己的 `enrollment.accountFile`。
