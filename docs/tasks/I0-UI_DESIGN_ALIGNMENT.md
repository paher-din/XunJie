# I0-UI：设计规范接收与首页卡片修正

日期：2026-10-15（Asia/Shanghai）。主责：UI / Robert；分支：`i0/ui-frontend`。

## 依据与范围

负责人指出：首页真实任务卡偏离原设计，C/HDL 课程图案反置；随后明确要求将父目录 Design 仓库的 DESIGN.md 带入主仓库，供后续 UI 修改遵循。沿用本会话已有推送、建 PR 与合并授权。

已读 README、根规范；PRD §5（PRD-02/03/10）、MVP_SPEC §2、TECH_DESIGN §3.3；I0_UI_CLIENT_CONTRACT §7/8、IMPORT_SOURCE 的来源/差异同步约束、原首页任务与 Design 现役设计规则。适用 NFR-05 与原首页入口验收；本轮不增加业务能力或数据字段。

可写：`docs/DESIGN.md`、根/学生 README、IMPORT_SOURCE 导航和来源记录；首页、其读取投影、既有状态徽标/样式与首页专项；本任务和当前清单。只读：源 Design 仓库、AGENTS、产品/规划/参考基线和后端。保留无关 `.zcodeignore`。

## 修正方案

- 原设计文档进入 `docs/DESIGN.md`，保留设计规则并适配本仓库路径；根与学生入口要求 UI 修改前阅读。源文件保留，历史测试/设计陈述不改称本仓库当前验收。
- 课程图案不再取列表位置。按本人实际任务的 executionKind 选择 C 代码图案与 HDL 板卡图案；无分配时，当前已交本机两课程按明确 courseId 装饰映射，其他未知/混合课程用通用图案，不猜业务类型。
- 撤去独立简化的 RealTaskCard，复用原 TaskCard 的状态徽标、标题、目标摘要与底部左右布局。目标取同一公开活动中的核心目标/首个目标，无目标则隐藏；无真实进度和截止时间仍不编造。准备模式保留原数据/进度行为。

## 验证与交付

`docs/DESIGN.md` 已接收，源 HEAD `16558426ce70524218eacbf7ce8fde35681c0503`，文件末改 `5a9486b`，与已发布 `a9bb1dd` 同 blob。规则/frontmatter与157处颜色序列一致；仅新增来源/适用范围并适配代码及原型证据链接。根/学生 README 与 IMPORT_SOURCE 已加入本地规范入口。源文件保留。

实现位置：首页共用 TaskCard、按 executionKind/已知本机课程装饰映射选图；home.ts 使用同次公开活动读取的目标摘要；StatusChip 复用原等待色与文字，未增加后台状态。原导入CSS任务卡为12px、来源规范写8px，本批仅将该组件对齐8px，并保留原20px内边距、共享hover和底部左右布局，不顺带重做其他组件。

已执行：`rtk npm run typecheck` 与正常 `rtk npm run build` 退出0；构建原大chunk提示保留。原首页专项4项+准备首页1项，初跑4/5：唯一失败是旧用例按“标题→暂停文本”匹配，恢复原状态徽标在前后不再适用；改为实际“暂停状态→标题→入口”顺序，仅复验该例1/1通过，其余4项不重复。专项同时核课程顺序倒置仍选对图、无分配课程已知/未知图案、真实目标、无虚构进度/截止、暂停与进入返回/账号隔离。命令使用原生 `node node_modules/@playwright/test/cli.js test`，明确设置 `XUNJIE_E2E_BROWSER_CHANNEL=chrome` 和独立5691/5692/5693端口；前序 RTK/cmd 正则参数传递、未续传 Chrome 环境的启动失败不计业务断言通过，未安装依赖。

文档静态检查123篇/1923内链、errors=[]，差异空白通过。不重跑执行/模型或整套浏览器矩阵。

## 实际页面与公开交付

固定源码 `d21b9c898cc61d43fc64540023d2140bb9977d24`；实际静态包入口 `index-DYbPdKAn.js`，SHA256 `dfb13ed085ddf0dc31d20dd2b668a97c81e0ec28f7023a6152b9484ed1accadf`。沿原本机35表 HTTPS 宿主仅接收静态文件、最后替换 HTML，旧入口及旧哈希资产保留供本机回滚；未修改后台、原库、配置或执行环境。

原 C 合成账号在本会话可见浏览器刷新后验证：任务卡状态“已分配”、标题、公开目标“解释文本统计规则”、右下入口均来自当前页面；圆角8px、内边距20px，无进度/截止元素。全部课程页实际 C 为 `code-square`、HDL为 `virtual-board`，包含当前账号无HDL分配时的明确装饰映射。见[实际 DOM 读数](evidence/ui-home-design-20261015/browser-card-facts.json)、[任务卡页面](evidence/ui-home-design-20261015/c-task-card.png)、[课程图案页面](evidence/ui-home-design-20261015/course-artwork.png)。两张截图已逐张查看；仅刷新/读取页面/课程导航，没有学习写操作。

实现与本机页面已完成，清单已同步。源码/规范 `d21b9c8` 与复验/清单 `5e786a5` 已普通推送，交付入口为 [PR #84](https://github.com/paher-din/XunJie/pull/84)，合并沿本会话已有授权执行，以 PR 实际状态为准。最终文档检查123篇/1928内链、errors=[]，差异空白通过；产品基线汇总仍按上述边界。

产品基线及 MVP_SPEC §10：待授权维护者汇总。
