# Issue tracker：GitHub

本项目的设计议题、实施规范和工作项使用 [paher-din/XunJie](https://github.com/paher-din/XunJie/issues) 的 GitHub Issues。当前入口见 [docs/README.md](../README.md)。优先使用可用的 GitHub 连接工具；原生关系等未覆盖操作通过 `gh` CLI 完成。用 CLI 提交多行正文时先写入临时 UTF-8 文件，再使用 `--body-file`，发布核对完成后删除不再需要的临时文件。

## 实施规范与实施票

- 已明确需求通过 `to-spec` 发布规范，使用仓库现有 `ready-for-agent` 标签；这与尚待研究/讨论的 Wayfinder 决策票不同，不给未决设计票批量添加该标签。
- `to-tickets` 将规范拆成可独立验收的实施子议题，按实际依赖发布，并使用原生 sub-issue 和 dependency 关系。母票承载规范，实施选择所有阻塞项均已完成的子票，不并行把母票当作另一份重复实现任务。
- 正文写用户行为与验收标准；建立原生阻塞关系后，不再维护一份依赖状态清单。相关议题通过链接提供背景，只有真正阻止开始的工作才设置为 blocker。
- 具体票的执行遵循当前用户授权与相应实施 Skill；不因规范/建票就自动开始开发、认领、合并或发布服务。拆票不关闭或改写已有设计票/母票正文。
- 本地发布稿用于审阅，GitHub 发布并核对后删除，保留实际议题链接；仓库设计文档记录设计与源码说明，不复制实时 issue 状态。

## Wayfinding operations

- 地图是标记 `wayfinder:map` 的单个 issue。正文只保存 Destination、Notes、Decisions so far、Not yet specified、Out of scope；开放议题通过原生子议题查询，不复制一份清单到正文。
- 决策票通过 GitHub 原生 sub-issue 关系挂到地图，只使用 `wayfinder:research`、`wayfinder:prototype`、`wayfinder:grilling` 或 `wayfinder:task` 类型标签。不要给设计议题添加实现就绪标签。
- `research` 由 Agent 调查事实；`prototype` 与 `grilling` 需要负责人参与。按当前地图的 Notes 决定何时启动研究，不在建图时擅自替负责人回答或关闭议题。
- 每场开始先读取地图，再按子议题顺序查询开放、未认领、无开放阻塞项的前沿。开始处理前，用 `gh issue edit <number> --repo paher-din/XunJie --add-assignee @me` 认领。
- 依赖使用原生 issue dependencies。解决时先发表评论记录结论和证据，再关闭该议题，最后在地图 Decisions so far 添加“标题链接 + 一句结论”。最终评论保留原始确认来源；按当前项目需要，将完整结论和研究材料收录到本地并注明来源与后续确认。学生端本轮入口为 [student-agent-implementation](../student-agent-implementation/README.md)，本地文档不复制动态认领和完成状态。
- 新问题先创建议题，再连接依赖；尚不能准确表述的问题留在 Not yet specified，超出地图目的的内容放 Out of scope。
- 面向用户始终以议题标题及链接称呼，不以编号代替名称。HTTP 参数仍使用对应数字身份。

## 常用操作

```sh
# 创建地图或决策票；正文在调用前准备好。
gh issue create --repo paher-din/XunJie --title '<title>' --label 'wayfinder:<type>' --body-file '<body-file>'

# 获取数字数据库 id；与 issue number、GraphQL node_id 不同。
gh api repos/paher-din/XunJie/issues/<number> --jq '.id'

# 将议题加入地图；旧版 gh 也可使用这些 REST 操作。
gh api --method POST repos/paher-din/XunJie/issues/<map-number>/sub_issues -F sub_issue_id=<child-database-id>

# 声明当前议题被另一议题阻塞。
gh api --method POST repos/paher-din/XunJie/issues/<number>/dependencies/blocked_by -F issue_id=<blocker-database-id>

# 按地图次序读取子议题，过滤开放、无人认领且无开放阻塞的项。
gh api --paginate repos/paher-din/XunJie/issues/<map-number>/sub_issues --jq '.[] | select(.state == "open" and (.assignees | length) == 0 and .issue_dependencies_summary.blocked_by == 0) | {title, html_url, number}'

# 查看某个议题的原生阻塞关系。
gh api --paginate repos/paher-din/XunJie/issues/<number>/dependencies/blocked_by --jq '.[] | {title, html_url, state}'
```

分页查询要读完所有页。若列表响应缺少依赖摘要，逐个读取议题及其 `dependencies/blocked_by`，以阻塞项是否关闭为准；缺字段不能当作没有阻塞。当前仓库已确认提供原生关系，后续不改用正文中的非原生依赖清单。

建图时议题初始保持开放、未认领；这不是当前所有议题的状态声明。GitHub 上的地图、实施规范及其原生关系是状态依据，后续按对应前沿推进，本地不维护另一份 issue 状态。

参考：[GitHub sub-issues API](https://docs.github.com/en/rest/issues/sub-issues)、[GitHub issue dependencies API](https://docs.github.com/en/rest/issues/issue-dependencies)。
