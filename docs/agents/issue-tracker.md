# Issue tracker：GitHub

本项目的设计议题和工作地图使用 [paher-din/XunJie](https://github.com/paher-din/XunJie/issues) 的 GitHub Issues。当前地图入口见 [docs/README.md](../README.md)。通过 `gh` CLI 操作；多行正文先写入临时 UTF-8 文件，再使用 `--body-file`，完成后删除临时文件。

## Wayfinding operations

- 地图是标记 `wayfinder:map` 的单个 issue。正文只保存 Destination、Notes、Decisions so far、Not yet specified、Out of scope；开放议题通过原生子议题查询，不复制一份清单到正文。
- 决策票通过 GitHub 原生 sub-issue 关系挂到地图，只使用 `wayfinder:research`、`wayfinder:prototype`、`wayfinder:grilling` 或 `wayfinder:task` 类型标签。不要给设计议题添加实现就绪标签。
- `research` 由 Agent 调查事实；`prototype` 与 `grilling` 需要负责人参与。按当前地图的 Notes 决定何时启动研究，不在建图时擅自替负责人回答或关闭议题。
- 每场开始先读取地图，再按子议题顺序查询开放、未认领、无开放阻塞项的前沿。开始处理前，用 `gh issue edit <number> --repo paher-din/XunJie --add-assignee @me` 认领。
- 依赖使用原生 issue dependencies。解决时先发表评论记录结论和证据，再关闭该议题，最后在地图 Decisions so far 添加“标题链接 + 一句结论”。详细决策只保存在议题中；架构文档需要同步时注明来源。
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

本轮只建图并发布，所有议题保持开放、未认领，后续按前沿逐项研究与讨论。GitHub 上的地图及原生关系是状态依据，本地不维护另一份 issue 状态。

参考：[GitHub sub-issues API](https://docs.github.com/en/rest/issues/sub-issues)、[GitHub issue dependencies API](https://docs.github.com/en/rest/issues/issue-dependencies)。
