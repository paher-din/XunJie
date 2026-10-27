---
name: xunjie-development
description: XunJie 成员首次上手与日常开发协作。用于准备开发环境、加入团队、切换本地与云端、使用固定数据基线、交接业务复现或 Agent 调试包、排查连接及查看测试账号。只读咨询只核实和回答；学生实验运行位置与产品部署设计另按产品契约处理。
---

# XunJie 开发协作

由编码 Agent 执行工具操作，成员说明目标即可。以当前 checkout 的帮助、源码和工具结果为准，按本次分支读取材料，不预先加载所有文档。

先解析 Skill 真实路径并确认项目根；宿主使用安装副本时先定位当前项目的源目录。仓库链接以 `skills/xunjie-development/` 为基准，不能从 `.agents/skills/` 别名、用户级安装目录或进程 cwd 猜路径。

仅找不到含当前开发工具的正确 XunJie checkout（未 clone，或只有缺少工具的 main）时，读取 [获取项目源码](references/bootstrap.md)；已有可用 checkout 时跳过该参考。

## 判断本次任务

- **只读咨询**：按问题核实状态并回答；不启动、登记、导入基线或写首引导标记。
- **首次调用且尚未介绍，或用户明确要求重听**：读 [首次上手](references/onboarding.md)，复用配置、依赖与本人身份，按 GitHub 接入流程补齐缺项并主动介绍一次；本人只需在 GitHub 网页确认。
- **已经介绍**：直接执行目标；单独调用 Skill 时检查状态并续缺失步骤，跳过功能介绍。环境停止、连接过期或换工作树只修复对应状态。

先核对真实 registration/env；再运行 `node skills/xunjie-development/scripts/intro-state.mjs status --worktree <项目根>` 判断跨会话是否已介绍。`introShown` 只证明说明已展示，就绪以实时工具结果为准。仅实际交付介绍后 `mark-shown`，失败只续缺项；时机与受限 home 边界见 [首引导状态](../../docs/development-tooling.md#首引导状态)。

## 按需操作

日常启动、切换、基线、复现、手动登录/查看测试账号或维护任务只读 [操作路由](references/operations.md) 对应一行，再进入该操作需要的说明。Skill 发现或换宿主问题只读 [安装与发现](../../docs/development-tooling.md#安装与发现)。

分享 Agent 调用、案例或评估结果，按编号接收调试包，或比较修复前后时，读 [Agent 调试包交接](references/agent-debugging.md)。先核对当前工具支持的包类型；业务复现与 Agent 评估分别选择流程。

普通成员使用本人受限身份；维护者、备份管理员凭据不进入成员接入流程。代码进入 Git，数据库、密码、邀请和用户引导状态保留在仓库外。已有授权直接复用，新增权限或发布另按本次任务授权处理。

完成后先报实际结果：页面入口、代码来源、数据归属与能力缺口；工程检查、浏览器验收、真实执行和教学效果分别报告。工具结果不支持的云端版本、基线选择或发布状态保持未验证。
