# W0：项目级 skills 目录安装与发现接入记录

日期：2026-10-08（Asia/Shanghai）。主责：工作空间/工具链任务（W 编号为本任务自用，非 A/B/C 产品任务）。关联：无 Issue；依据项目负责人 2026-10-08 的直接指令“在本项目建立 skills 文件夹，安装 mattpocock/skills 这一套 skills”，随后对落位的更正“不是安装在 `.dsh` 上，而是项目里的 `skills`”，以及“Agent 在会话里用不到这批技能，解决一下”。

状态：技能实体已安装在 `D:\XunJie\skills`；通过目录联接（junction）接入 DSH 项目级技能发现，Agent 会话内已可用并实测加载成功。技能文件未提交 Git，待负责人决定。

## 1. 范围与依据

基线阅读：[AGENTS](../../AGENTS.md) → [README](../../README.md)。本任务不新增、修改或重解释任何产品行为、共享契约与验收条件，因此未触及 [PRD](../product/PRD.md)、[MVP_SPEC](../product/MVP_SPEC.md)、[TECH_DESIGN](../product/TECH_DESIGN.md) 的范围与契约章节；该结论经检索确认：三份产品文档中没有约束开发 Agent 技能安装的条款（MVP_SPEC 第 31 行的“公共插件市场”是产品不做的事，与本任务无关）。

本任务按 [文档优先规则](../../AGENTS.md#文档优先硬性要求) 中“配置调整”一项留下本文记录。`docs/product/**`、`AGENTS.md`、`docs/planning/**`、`docs/reference/**` 全文未改动。

安装对象：`https://github.com/mattpocock/skills`（MIT License, Copyright (c) 2026 Matt Pocock），读取提交 `b0618bc436ad893b3c5e84e55fba86586d34a404`（2026-10-08），`git clone --depth 1` 取得。

## 2. 落位与发现接入

**实体落位：`D:\XunJie\skills`**（仓库内 `skills/` 顶层目录，27 个技能包，单一物理副本）。

上游按 `skills/engineering`、`skills/productivity` 等类别分目录；安装时**扁平化**为 `<name>/SKILL.md`，类别目录不保留。理由：任何 Agent 的技能发现都要求顶层 `<name>/SKILL.md`、不递归嵌套，扁平化后该目录既可直接阅读，也可原样接入发现，不需要重新整理。

**发现接入：`D:\XunJie\.dsh\skills` 为指向 `D:\XunJie\skills` 的目录联接（junction，`LinkType=Junction`），不是副本。** 实体文件只存在于 `skills/`，`.dsh` 下只有一个 reparse point。

DSH 本机技能发现只扫描固定根目录（下面为 DSH 内置 skills 插件说明文本给出的约定，非本仓库资料）；`<repo>/skills` 不在其中，这是必须另接一层的原因：

| Rank | Source | Path |
| --- | --- | --- |
| 100 | `project-dsh` | `<projectRoot>/.dsh/skills` |
| 200 | `project-agents` | `<projectRoot>/.agents/skills` |
| 400 | `user-dsh` | `<dshHome>/skills` |
| 500 | `user-agents` | `<agentsHome>/skills` |

接入方式取舍：采用 **junction**（项目作用域、立即生效、无需重启、不改全局配置、不产生副本）；未采用在 DSH profile 的 `cordis.patch.yml` 里配 `customSkillDirs`——那属于全局 profile 配置，会把本仓库的技能泄漏到所有其他项目的技能目录，且改配置需要重载。

**`.gitignore` 增加 `.dsh/`**（附一行注释）。原因：Git 会把 junction 当目录递归，`git add` 会顺着联接把这 80 个文件当副本入库。已用 `git add -A --dry-run` 验证：输出只有 `skills/` 下的单一副本，无 `.dsh/` 路径。

过程记录（如实）：本次先按 DSH 约定安装到 `D:\XunJie\.dsh\skills` 并验证；负责人指出落位错误后，将全部内容复制到 `D:\XunJie\skills`，逐文件核对相对路径与 SHA-256 一致（80/80）后，删除会话新建的重复副本目录 `D:\XunJie\.dsh`（当时仅含本次复制的 80 个文件）。随后按“解决 Agent 用不到”的要求，在同一路径重建为 junction。

## 3. 安装清单（27 个）

engineering（20）：ask-matt、code-review、codebase-design、diagnosing-bugs、domain-modeling、grill-with-docs、implement、implement-spec、improve-codebase-architecture、pr、prototype、research、retro、setup-matt-pocock-skills、tdd、to-spec、to-tickets、triage、wayfinder、wizard。

productivity（7）：grill-me、grilling、handoff、teach、to-questionnaire、wait-what、writing-for-agents。

共 27 个技能包、80 个文件、约 217 KB。上游 LICENSE 以 `skills/LICENSE-mattpocock-skills.txt` 保留。

## 4. 未安装项及原因

| 上游类别 | 数量 | 处理 | 原因 |
| --- | --- | --- | --- |
| `misc` | 4 | 未装 | 上游标注“不放入插件、很少使用”；其中 4 个已存在于本机全局根 `~/.agents/skills` |
| `in-progress` | 7 | 未装 | 上游标注为 beta：不进入插件与文档，可能随时变更或消失；含依赖 Claude Code 专有能力的项 |
| `deprecated` | 0 | 不适用 | 上游该目录为空 |

需要时可单独补装，不需要重装其余技能。

## 5. 验证（均在本机实际执行）

| 项 | 方法 | 结果 |
| --- | --- | --- |
| 内容无损 | 搬迁前后逐文件比对相对路径 + SHA-256 | 80/80 一致 |
| 结构合法 | 逐包解析 frontmatter | 27/27 有 `name`、非空 `description`，且 `name` 与目录名一致；无未闭合 frontmatter；无嵌套 `SKILL.md`；顶层无多余 `.md` 文件 |
| 调用策略元数据 | 统计 `disable-model-invocation: true` | 16 个用户调用型、11 个模型可调用型，与上游 README 分类一致 |
| 联接有效性 | 读取 `D:\XunJie\.dsh\skills\tdd\SKILL.md`；`Get-Item` 查属性 | 内容可读；属性为 `Directory, ReparsePoint`，`LinkType=Junction`，`Target=D:\XunJie\skills`；经联接与经实体各计 80 个文件，无副本 |
| DSH 实际发现 | 观察会话技能目录 | 建联接后目录实时刷新，11 个模型可调用技能回到目录（code-review、codebase-design、diagnosing-bugs、domain-modeling、grilling、pr、prototype、research、tdd、wizard、writing-for-agents）；此前删除联接时同步消失，双向可复现 |
| 端到端加载 | 调用 `tdd` 技能（仅验证解析，不启动 TDD 流程） | 返回 `Base directory for this skill: D:\XunJie\.dsh\skills\tdd`，内容为**项目级新版本**（已用 `GLOSSARY.md` 并引用 `codebase-design`），即 rank 100 项目根生效并覆盖 `~/.agents/skills` 的全局旧版 |
| 入库安全 | `git check-ignore -v .dsh/skills`；`git add -A --dry-run` | 命中 `.gitignore:11:.dsh/`；干跑输出无 `.dsh/` 路径，不会重复入库 |
| 内部相对链接 | 扫描 41 个仓库内相对链接 | 0 个真实缺失；4 个命中为文档内示例占位（`domain-modeling` 的 `./src/*/GLOSSARY.md` 示例、`wayfinder` 的 `(link)` 占位） |

未执行：上游 `/setup-matt-pocock-skills` 初始化、任何技能流程的实际使用、跨机器/跨成员的可复现安装脚本。

## 6. 待决策与限制

1. **技能文件入库方式未定。** `skills/` 当前为未跟踪文件，未 `git add`、未提交；仓库中另有他人未提交改动（`README.md` 修改、`docs/tasks/` 新增），本次未触碰。`skills/` 建议入库（团队共享、可评审、可追溯来源），需负责人决定后再提交。
2. **junction 是本机文件系统对象，不随仓库分发。** 团队成员克隆仓库后只会得到 `skills/`，不会得到 `.dsh/skills`，需要各自执行一次桥接（Windows 用目录联接，macOS/Linux 用符号链接）：
   ```powershell
   New-Item -ItemType Junction -Path .dsh\skills -Target (Resolve-Path .\skills)
   ```
   ```bash
   mkdir -p .dsh && ln -s ../skills .dsh/skills   # macOS / Linux
   ```
   若要团队开箱可用，需另定办法（例如把桥接写进仓库的初始化脚本、或改 DSH profile 配置），这属于需要负责人决定的范围。
3. **README 导航未同步。** 为避免与并存未提交改动混入同一份差异，本次未在 [README](../../README.md) 增加该目录的说明条目。
4. **`setup-matt-pocock-skills` 未运行。** 该技能会写入议题跟踪器配置、`GLOSSARY.md` 与 ADR 目录等；其中部分目标与 [AGENTS](../../AGENTS.md) 的文档写入边界、现有 `docs/` 目录约定可能重叠。是否运行、写到哪个目录，需负责人明确后再执行。
5. **技能自带的文档约定与仓库规范可能冲突。** `domain-modeling`、`grill-with-docs`、`to-spec`、`to-tickets`、`triage` 等默认读写 `GLOSSARY.md`、ADR、议题跟踪器。执行 Agent 使用时仍以 AGENTS.md 的只读边界为准：不得借技能流程写入 `docs/product/**`、`AGENTS.md`、`docs/planning/**`、`docs/reference/**`。
6. **上游更新为手工。** 上游采用插件/安装器自更新；本次为手工复制快照，更新需重新取上游并覆盖同名目录，差异需人工核对。因 `.dsh/skills` 是联接，覆盖 `skills/` 即同时更新两侧，不需要重复操作。
7. **能力范围**：本次仅安装开发 Agent 使用的技能文件并接入本机发现，不改变 XunJie 产品范围、技术选型、架构或任何验收状态，不构成 G0 进展。

## 7. 后续操作（供复现、更新或回退）

```powershell
# 复现安装
$dst = Join-Path $env:TEMP 'mattpocock-skills'
git clone --depth 1 https://github.com/mattpocock/skills $dst
# 按上游 skills/engineering、skills/productivity 下每个含 SKILL.md 的目录，复制为 D:\XunJie\skills\<name>\

# 接入发现（本机一次性）
New-Item -ItemType Junction -Path D:\XunJie\.dsh\skills -Target D:\XunJie\skills

# 回退：只删联接，不动实体文件
Remove-Item D:\XunJie\.dsh\skills -Force   # 删 junction 本身；勿加 -Recurse
```

删除联接时**不要**加 `-Recurse`：那会顺着联接删除 `skills/` 里的实体文件。当前挂载方式经过验证，回退只需删除联接对象。

本次上游克隆仍保留在 `%TEMP%\mattpocock-skills`，便于补装 `misc`、`in-progress` 或后续更新比对。
