# W1：Codex 项目级 skills 发现配置

日期：2026-10-09（Asia/Shanghai）。主责：工作空间/工具链配置；W1 不属于 A/B/C 产品任务。授权依据：项目负责人要求将已经安装在 `skills/` 的技能配置到本项目。

状态：Codex 项目级发现配置已完成；本机 CLI 实际发现与文件/Git 检查通过。桌面选择器显示及各技能业务流程未执行验证。

## 1. 基线与范围

已阅读 [AGENTS](../../AGENTS.md) 的文档写入边界、文档优先和红线、[README](../../README.md)、[W0 安装记录](W0_AGENT_SKILLS_INSTALL.md)，以及 [PRD](../product/PRD.md) 第 1、6 节、[MVP_SPEC](../product/MVP_SPEC.md) 第 1 节、[TECH_DESIGN](../product/TECH_DESIGN.md) 第 1～3、11～12 节。

本任务仅接入开发 Codex 的本地技能发现，不修改教学 Agent、产品行为、A/B/C 共享契约或技术选型，不对应新的 M/AC/NFR 验收项，也不构成 G0～G4 产品通过记录。无产品基线汇总请求。

预计可写对象：本任务文档、README 的技能使用说明、`.gitignore` 的本机联接忽略规则，以及新建的 `.agents/skills` 目录联接。只读对象：`AGENTS.md`、`docs/product/**`、`docs/planning/**`、`docs/reference/**`、其他任务文档及已有 `skills/**`。保留开始前 README、`.gitignore`、C0/W0 和技能文件的未提交工作；不暂存或提交。

## 2. 配置依据与方法

现有 `skills/` 包含 27 个技能包；`.dsh/skills` 是既有工具的目录联接。Codex 的仓库级发现入口是 `.agents/skills`，支持链接目录；详见 [OpenAI 官方技能文档](https://learn.chatgpt.com/docs/build-skills)。W0 的 DSH 发现结果不能替代 Codex 的实际发现验证。

在 `.agents/skills` 创建指向本仓库 `skills/` 的 Windows junction，保留单一技能实体，不移动、删除或复制原文件。仅忽略 `/.agents/skills/`，防止 Git 沿联接重复纳入技能文件；其他 `.agents/` 内容仍可正常跟踪。README 给出其他工作副本的相对路径初始化命令。

此次配置不运行 `setup-matt-pocock-skills` 的议题、标签和领域文档初始化流程。该流程包含修改受保护的 `AGENTS.md` 等额外工作，需另行明确相应范围；本次技能发现接入无需这些改动。使用任何技能仍遵守本仓库规范，技能内容不能放宽既有权限与红线。

## 3. 验证方案

- 校验 27 个包的 frontmatter，并通过实体路径和联接路径逐文件比对 SHA-256。
- 使用本机 Codex CLI 的 app-server `skills/list`（仅发现，不发起模型任务），检查本项目技能的数量、来源和解析错误。
- 运行 `git check-ignore`、`git add --dry-run` 和 `git diff --check`，确认联接不产生重复入库，且无空白错误。
- 对比受保护文件、C0/W0 任务记录和原技能文件的哈希，确认保留既有内容。

## 4. 交付与限制

实际交付：

| 对象 | 改动 |
| --- | --- |
| `.agents/skills` | 新建 Windows junction，目标为本仓库 `skills/` 的解析路径；原 `.dsh/skills` 保留 |
| `.gitignore` | 新增 `/.agents/skills/`；保留开始前已有 `.dsh/` 忽略规则 |
| [README](../../README.md#开发-skills) | 增加技能入口、Windows/macOS/Linux 首次接入命令、调用方式与使用边界；保留原 C0 导航改动 |
| 本文 | 记录范围、方法、实际验证和未执行项 |

实际验证（2026-10-09，均在本机执行）：

| 检查 | 命令或方法 | 结果 |
| --- | --- | --- |
| 技能结构 | Node 标准库 assert 检查每包 frontmatter 的 `name`、`description` 和目录对应关系 | 27/27 通过 |
| 联接内容 | Node 标准库逐文件 SHA-256 比对，另用 `realpathSync` 检查入口与实体目录相同 | 80/80 一致，无复制文件 |
| Codex 实际发现 | `codex --version`；启动 `codex app-server --listen stdio://`，完成 `initialize` / `initialized` 后请求 `skills/list`，参数为当前仓库 `cwds` 与 `forceReload: true`；取得结果后结束检查进程 | CLI 0.135.0 返回 27 个项目技能，全部 `scope=repo`、`enabled=true`；项目解析错误 0。返回路径解析到 `skills/<name>/SKILL.md` |
| 忽略规则 | `git check-ignore -v .agents/skills .agents/skills/tdd/SKILL.md` | 均命中新增规则 |
| 入库干跑 | `git add --dry-run --all` | 输出只包含实体 `skills/`，无 `.agents/skills/`、`.dsh/skills/` 重复路径；未实际暂存 |
| 空白检查 | `git diff --check` | 通过；Git 提示现有 LF/CRLF 自动转换，不是检查失败 |
| 保留已有工作 | 配置前后使用 Node 标准库逐文件比较 SHA-256 | 90/90 未变化：8 份受保护文件、C0/W0 两份记录及原技能目录 80 个文件 |

限制及未执行项：

- 目录联接是本机对象，不随 Git 克隆分发；其他工作副本按 README 初始化。
- CLI 发现通过不代表桌面选择器已刷新；官方文档说明 Codex 自动发现变更，若没有出现可重启 Codex。桌面 UI 验证未执行。
- 各技能业务流程、议题/标签/领域文档初始化和产品验收未执行；未改全局配置，未发起模型任务，未提交 Git。
- 全局与项目可能存在同名技能，应按项目路径选择；不声称项目技能必然覆盖全局版本。
- 回退需要移除本机联接并撤销本任务对应的 README/忽略规则增量；删除联接属于项目红线，须先经项目负责人同意，并保留原实体技能和其他人的工作。
