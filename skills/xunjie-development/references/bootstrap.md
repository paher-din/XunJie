# 获取项目源码

只在未找到可用 XunJie checkout 时读取；已具备工具的仓库直接进入当前任务。只读咨询仅核实并回答缺口，不 clone。首次调用或要求准备环境时，由 Agent 完成下面的定位与获取，成员无需补长提示、查询分支或填写 SSH 参数。

## 先找已有 checkout

从当前路径和 Skill 真实路径检查实际 Git 根、`git remote -v`、Git 状态及必要工具文件。以指向 `paher-din/XunJie` 的 GitHub remote 核对项目身份，兼容其 HTTPS/SSH URL 写法；不能只凭目录名或全局安装 Skill 的位置认定仓库。当前属于其他项目时保留原项目，不把它当作 XunJie 源码根。

若已找到该仓库但当前 checkout 缺少工具，先用 `git worktree list --porcelain` 和上下文中已知项目路径找现有正确 checkout；不遍历整机。已有可用路径就显式使用它，即使其分支不是下述交付线索也不擅自切换。保留 dirty/untracked 文件，不自动 pull、reset、清理或替换现有工作。

## 缺失时获取交付分支

当前已知交付仓库为 `https://github.com/paher-din/XunJie`，分支为 `codex/development-collaboration-integration`。**当前 main 尚未包含开发工具**，不能把“已 clone main”当作本轮工具就绪；分支名称也不证明远端已包含本机尚未推送的交付。

Agent 先选定并说明绝对目标路径：优先用户已指定位置或已知项目父目录下的新目录，避开其他项目内部。检查目标不存在或完全为空（含隐藏项），已有内容则保留并选新目录，不覆盖或盲切现有 checkout。由 Agent 调用：

```sh
git ls-remote --exit-code --heads https://github.com/paher-din/XunJie.git refs/heads/codex/development-collaboration-integration
git clone --single-branch --branch codex/development-collaboration-integration https://github.com/paher-din/XunJie.git "<选定的绝对空目录或新目录>"
```

执行前以实际选定路径替换占位符；成员不用复制命令。分支不存在、访问失败或缺 Git 时，报告具体命令阶段与缺口，不静默改取 main、不索取 SSH 配置/口令，也不把失败留下的目录当作可用仓库。

## 在源码目录继续

核对取得的真实根、remote、分支与 Git 状态，确认 `AGENTS.md`、`skills/xunjie-development/SKILL.md`、`skills/xunjie-development/scripts/intro-state.mjs`、`tools/xj-dev/xj-dev.mjs` 及其按需文档存在。工具接口再以实际 `--help` 和源码检查；若当前远端尚缺 stdin 邀请、团队基线或本次需要的接口，逐项报告缺口，不把 clone 成功算作接入成功，也不从安装副本向仓库静默补文件。

此后在明确的源码根读取 `AGENTS.md` 和仓库内 Skill，再按首次/续做分支进入所需 reference；所有仓库文档链接与工具命令以该源码根为准，使用显式工作目录或 `--worktree`，不沿用户级 Skill 安装路径解算仓库文件。宿主发现入口只在需要时按仓库的安装说明核对，不假定复制完整 Skill 后自动具备项目源码。

交付真正合入 main 后，维护者需同步更新或移除本参考中的分支线索及“main 尚缺工具”说明，并核对远端实际文件；未合入前继续保留当前线索。
