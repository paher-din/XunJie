# I0-UI：原首页学习看板与任务入口接回

日期：2026-10-15（Asia/Shanghai）。主责：UI / Robert；分支：`i0/ui-frontend`。

## 依据与范围

负责人要求再次对照父目录 Design 与主仓库 DESIGN.md，修正首页/任务卡偏离，接回顶部学习看板和问候，只用真实数据，不另写简化UI。沿用本会话推送、PR及合并授权。

已读 README、根规范；PRD §3.2/5（PRD-03/06/10）；MVP_SPEC §2、M-05/06；TECH_DESIGN §3.3/5.1；本地 DESIGN 的布局/组件/取值/来源规则，Design `home-design.md` 已确认首页、原 HomePage/DashboardSection/widgets；IMPORT_SOURCE 与前两轮首页/设计对齐记录。源 Design HEAD `16558426ce70524218eacbf7ce8fde35681c0503`，源只读。

可写：现有首页、原 dashboard 组件及必要样式、对应浏览器/组件验证、README/IMPORT_SOURCE 使用与同步记录、本任务与当前清单。后端、schema、依赖、AGENTS、产品/规划/参考基线只读；保留 `.zcodeignore`。

## 修正方案

- 恢复原“问候/日期→学习看板→课程/任务”的顺序、DashboardSection、默认任务完成/热力卡、编辑/移出/添加托盘，以及原内嵌任务入口；继续复用原任务卡、课程卡及筛选/搜索结构。
- 原组件支持缺失统计：分配总数从当前本人列表取得；完成数/率、活跃时长/热力、技能/XP等无现成汇总契约，保留为未知，不用0、空记录或运行成功代替。空态留在原widget中，不造第二套看板。
- 问候保留原时段与日期，用真实 Session userId（未提供 displayName）；内嵌入口使用真实分配标题/目标，不推断上次进度。真实筛选使用已分配/暂停事实，不把 active 当作学习完成状态。
- 不新增统计GET：当前分配与活动读取已足够提供已有事实；不遍历 Attempt/Job 猜进度，不使用有教学投递行为的 events GET 聚合时长。保留账号隔离和原编辑布局能力。

## 验收与交付

实现位置：`HomePage.tsx` 真实分支挂回原 `DashboardSection`，并抽出两数据来源共用的原 `TaskToolbar`；`DashboardSection.tsx` 与 `widgets.tsx` 只扩展可缺失统计和真实任务总数，默认两卡、编辑托盘和已有数据绘图分支保留。真实布局按账号保存，准备布局沿原键。

已完成工程验证（Node 24.15.0，Chrome 155）：

- `rtk npm run typecheck`：通过；`rtk npm run build`：通过（含再次类型检查）。构建保留既有大块体积提示，无构建错误。
- `rtk npm test -- src/components/dashboard/widgets.test.ts`：4/4。核对未知完成数与真实0/50%、缺时长与真实零时长日期、缺趋势/XP不生成演示数据。
- `XUNJIE_E2E_BROWSER_CHANNEL=chrome`，独立端口5701/5702/5703、`CI=1`，`node node_modules/@playwright/test/cli.js test homeEntry.spec.ts prep.spec.ts --grep '真实首页|没有学生课程|列表故障|列表401|首页准备入口' --workers=1`：5/5。覆盖原看板/每日每周/托盘添加移出、真实总数、搜索与清除焦点、暂停筛选、原卡路由、空与失败、过期/退出/迟到响应和账号布局隔离，以及原准备首页。正常首页4例替换公开HTTP响应，是前端协议验证，另1例为准备fixture，不计本机真实宿主验收。
- 对照 Design 原组件及本地 DESIGN 的窄审查：未发现需修复项。无额外依赖、后端接口或数据写入。开发服务仍报告既有 public 品牌JSON导入提示，本批未改该处。

随后在正常本机 HTTPS 页面复验原看板、编辑托盘、任务入口/搜索/返回并截图；不重跑执行或模型。

产品基线及 MVP_SPEC §10：待授权维护者汇总。
