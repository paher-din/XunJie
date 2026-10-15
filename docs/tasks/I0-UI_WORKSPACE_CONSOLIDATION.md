# I0-UI：工作区操作整合

日期：2026-10-15（Asia/Shanghai）。负责人：Robert；实施：当前 UI Agent。

## 1. 授权、依据与范围

Robert 当前明确要求全面整合所示工作区的 UI，减少按钮杂乱，使页面与操作更舒适。本轮可调整现有工作区的操作分组、层级、布局与视觉；不改变保存、快照、执行、求助、提交的业务语义。

基线：`origin/main@485ae9e`，独立工作树分支 `codex/workspace-ui-consolidation`。主目录 `i0/ui-frontend@1021d44` 及未跟踪 `.zcodeignore` 保留。用户指定的 `https://localhost:3445` 是云端共享服务的 SSH 转发，存在已交付的执行电脑选择器；因此以最新主线实施，不在旧本机版本上遗漏该能力。

已读正文：README；AGENTS；PRD §3～6（PRD-03/04/05/09）；MVP_SPEC §1.4、M-03～10、§4～6（AC-03/04/06/12、NFR-05、DL-AC-01～09）；TECH_DESIGN §3.3、§7.4、§8.5；TEAM_WORK_PLAN §1～3（含 P3～P5）；DL-0 §1 及当前 HDL 页面任务 §1～3；I0_UI_SPEC User Stories / Implementation Decisions / Testing Decisions；I0_UI_CLIENT_CONTRACT §1～7；IMPORT_SOURCE 来源、选择性同步与主仓库维护边界；DESIGN.md 的 Layout、Components、Colors、Typography、深色模式与 Do/Don't。

可写：学生端 `PrepWorkspacePage`、现有确认/HDL/执行电脑展示组件、新的操作浮层与局部样式、相应现有验证入口及本任务。只读：产品/规划/参考/规范、Design 仓库、后端/存储/网络契约、其他任务记录。无新增依赖、schema、密钥、CI 或产品基线变更。

## 2. 实施方案与验收

实施方案由 Agent 在本轮 UI 授权内选择：

- 顶栏只承担返回、工具切换、求助、提交与会话入口；移除编辑区重复的求助按钮行。
- 独立操作栏按“作品 → 执行”组织。确认保存、冻结和构建/装载保留明确动作；版本比较/重读、执行电脑/快照选择按需展开。
- 求助统一入口，展开后保留项目、当前文件、选区、板卡及精确快照选择。停止与异常核对在需要时直接可见。
- 状态与操作分层、同一套 32px 控件/13px 字号/语义图标；浮层支持键盘、Escape、点击外部关闭及视口约束；窄窗口自动换行，不横向裁切主要操作。
- 原回调、权限、禁用条件、确认头与草稿差异、固定快照及未知状态保留。仅在隔离合成环境验证操作，不代真实学生保存/执行/提交。

验证：typecheck、构建、受影响的既有组件/协议测试；实际浏览器检查浅色/深色、常用桌面及窄窗口、浮层键盘、C/HDL 入口与异常/禁用状态。相称检查通过后不扩大无关测试。

共享开发环境已更新本次前端静态包，见下方交付边界。产品基线及 MVP_SPEC §10：待授权维护者汇总（本次没有产品契约变更）。

## 3. 实施与验证记录

代码位置：`apps/student/src/pages/PrepWorkspacePage.tsx` 组织两层操作区；`ConfirmationCluster.tsx`、`ExecutionNodeSelect.tsx`、`HdlToolArea.tsx` 复用原业务回调；新增 `WorkspacePopover.tsx` 和 `WorkspaceToolbar.css` 负责浮层、焦点返回与响应式样式。未改变业务请求与数据模型。

既有 E2E 入口通过 `e2e/workspaceControls.ts` 跟随可见菜单路径；新增 HDL 布局用例检查 1440/1280/900/600px、浮层边界、Escape/Tab 返回、深色求助入口和零新增业务写入。原键盘用例同时保留保存、版本、冲突、运行等断言；文件排序按文件名比较内容，消除随机文件标识造成的顺序假设。

| 验证 | 实际结果 |
| --- | --- |
| `npm run typecheck` / `npm run build` | 最终版本通过；保留原 Vite 大于 500KB chunk 提示。 |
| `npm test` | 54 个文件、657 项通过。 |
| Chrome 定向浏览器回归 | 首轮 30 项中 26 通过、2 失败、2 未运行；失败为旧键盘顺序断言及长虚拟时钟超时。修正顺序断言并给长用例 120 秒上限后，pending/迟到分配/HDL 键盘 3 项通过；补充诊断、求助、布局等 11 项中 10 通过，剩余旧键盘方向断言修复。最终键盘完整流程、混合 EOL 只读比较、操作整合 3/3 通过。未声称完整 E2E 全量通过。 |
| 浏览器环境 | 默认 Playwright Chromium 未安装，首次启动失败；改用本机已安装 Chrome，未安装新浏览器。设置 `XUNJIE_E2E_BROWSER_CHANNEL=chrome`、PREP/REAL 端口 5673/5674。 |
| 最终定向命令 | `npm run test:e2e -- keyboardWorkflow.spec.ts hdlRealWorkflow.spec.ts fileHistory.spec.ts --grep "操作整合\|真实 Tab\|只读比较" --workers=2 --timeout=120000`，3/3 通过。 |
| 人工视觉核对 | 隔离合成工作区的浅色、深色、宽窄窗口已检查。截图保存在仓库外交付目录。 |
| `git diff --check` | 通过。 |

## 4. 开发环境交付与未完成项

2026-10-15 更新用户当前 SSH 转发开发入口的静态资源：新入口 `index-5B4I6QaN.js`、样式 `index-OMlhEbhs.css`。入口 HTML SHA-256 为 `0af7eaad4506ee70c47728f3e4c78fe00cf8d3e0cc05dd0d56ef6e50f93ed234`。上传包摘要核对后，先检查同名资源无内容冲突，再保留全部旧资源并原子替换入口；旧入口另存备份。后端、数据库、运行配置及服务进程未变更。

当前指定任务链接在刷新后返回“分配没有读取成功”。已临时恢复原入口（`index-ZIGqioz5.js`）并在同一会话复核，旧版也出现相同失败；随后恢复新入口并核对摘要。更新前页面已有“权威 Attempt 尚待核对”。该任务当前不能计为完整在线工作区验收；具体数据/权限原因尚未定位，不通过改业务或代学生开始 Attempt 消除。新 UI 完整交互证据来自隔离合成环境，不计真实学习、真实模型或教学效果。

交付为独立分支本地提交及私有共享开发静态更新；未推送、未建 PR、未合并 main、未公开发布。维护连接资料、截图和可回退包保留在仓库外，不进入任务提交。回退只需恢复旧入口 HTML（旧散列资源已保留），无需重启服务。

下一步：负责人如需修复当前任务读取失败，应单独核对任务分配/权限；本次不修改该业务范围。无产品基线变更请求。
