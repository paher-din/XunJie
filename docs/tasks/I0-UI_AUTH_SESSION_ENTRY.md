# I0-UI：真实登录与会话入口

日期：2026-10-14（Asia/Shanghai）。主责：UI / Robert；实施：当前 Agent。对应 [真实接入清单](I0_REMAINING_WORK_CHECKLIST.md) UI-REAL-01、02、08。

## 1. 依据与授权

Robert 于2026-10-14明确授权：下一批实施正式登录、登录后进入获准任务、会话过期重新登录、首页账号菜单退出、账号切换草稿及迟到响应隔离；复用现有 HTTPS 宿主与合成账号，继续原分支。

起始分支 `main`，HEAD `eea9623`；无关未跟踪 `.zcodeignore` 保留，不暂存。本批实施期间误在原 `main` 上开发并本地提交，已于同日本用户明确授权后纠正归属到原前端分支 `i0/ui-frontend`，详见 §4。

已读正文：PRD §1、§3～5、§8（PRD-03/09/10）；MVP_SPEC §2、M-03/M-10、§4～6（AC-02/03/06/12、NFR-04/05）；TECH_DESIGN §4.3/4.4、§5/5.1、§7.4、§9；TEAM_WORK_PLAN §2/2.1、§9 I1/I2/I3；I0_UI_SPEC Implementation/Testing Decisions；I0_UI_CLIENT_CONTRACT §2/3/5/7/8；学生 README、IMPORT_SOURCE、I0-B_HOST_COMPOSITION 现有隔离 HTTPS 验证边界。

复用 A1 已有 POST `/api/sessions`（loginName/password）、GET `/api/session`、POST `/api/logout`、Cookie/CSRF 与错误信封；UI-REAL-02 本批仅获准 Assignment 深链/bootstrap、固定活动与可见材料。不增加分配列表或跨设备 Attempt 发现。

## 2. 写集与实施

可写：`apps/student/src` 的会话客户端/路由入口/登录表单/账号菜单与相关样式、相应测试、根/学生 README 导航与真实运行说明、当前任务记录。实际 HTTPS 验证沿已有 `i0-browser-fixture.ts`，不改服务端契约、库 schema、配置、凭据或依赖。

只读：`docs/product/**`、`docs/planning/**`、`docs/reference/**`、规范、其他成员任务；清单仅作编号来源。产品基线及 MVP_SPEC §10：待授权维护者汇总。

方案：正式路由读取有效 Session；未认证显示键盘可达的登录表单并保留当前深链，密码仅在提交时传输，不持久化。401 失效与明确退出同步失效旧上下文/请求代次及内存展示；重新认证换代次，同账号恢复原 scope，异账号不读取旧草稿。跨标签页通知仅携带会话改变事实，不传身份凭据；恢复前台时核对真实 Session。退出失败如实呈现并保留重试入口。

验收：真实 UI 登录/错误口令/失败状态/深链与权限；刷新恢复；过期重新登录；首页和工作区退出；同/异账号草稿隔离与旧成功/401响应反向到达；实际 HTTPS/SQLite 两个合成账号，登录由表单发起。准备模式和原演示保留原身份标记。

## 3. 实现、验证与交付

实现位置：

- `src/components/SessionEntry.tsx`、`main.tsx`：沿原 hash 深链显示正式表单，认证后挂载原 AppShell；账号/密码 label、Enter 提交、焦点、既有浅/深主题。准备构建与原 Design 演示保持原标识。
- `workspace/session.ts`：身份/CSRF 取服务端 Session；登录、刷新、明确退出、退出失败重试、跨标签改变通知与恢复前台读取。会话入口15秒有界等待；不自动重试或将 429/协议/网络错误伪装成成功。已认证会话读取遇断网保留本机编辑，只有真实 401 才失效。
- `workspace/http.ts`、`context.ts`、`init.ts`：当前会话请求代次与同步 ContextGuard 失效；旧成功/旧 401 均拒收，同账号新 Session/CSRF 也换代次。重认证清 React Query 内存；沿既有 mode/user/Assignment/Attempt IndexedDB scope，不迁移、清空或改 schema。
- `AppShell.tsx`、`AccountMenu.tsx`、`AccountAvatar.tsx`、`HomePage.tsx`：真实退出与服务端账号标识，登录后首页标明原看板/任务仍为设计演示；真实项目沿课程提供的授权深链。
- `e2e/sessionEntry.spec.ts`：真实浏览器上的前端协议反例，键盘/主题、限流、非法信封、断网、等待超时；无真实后台通过含义。
- `e2e/sessionService.spec.ts`、`sessionHost.ts`：原隔离 HTTPS/Fastify/SQLite 宿主、正常 dist、两个合成账号，初始登录与换账号均从实际表单发起。故障注入只延迟/拒绝传输；ACK 先由实际宿主生成，迟到401作为前端传输反例。原草稿隔离及同账号刷新恢复实际使用 IndexedDB。合成账号密码随机生成，私有 stdin 交给原宿主，关闭 trace，不入仓库或日志。

未执行/范围外：真人账号/教师与学生试用、正式部署及浏览器系统 TLS 信任、执行节点/真实供应商调用、完整 AC/NFR 及教学效果；UI-REAL-02 的分配列表与跨设备 Attempt 发现仍不在该批准批次。临时自签证书仅隔离 context 忽略验证，原工厂合成数据库按既有审计边界保留。

### 中间失败与处理

2026-10-14，第一轮21项组合18通过/3失败，不算全量通过：旧 real 协议替身将未实现的教学读取返回401，导致真实全局失效守卫按约定退出；已改为有效会话下403拒绝、匿名仍401。新增过期用例最初误用不存在的“重新读取工作区”按钮，改为恢复前台时真实 GET Session 收到401。首个 HTTPS 用例全部业务断言完成后关闭宿主超时；明确先关闭测试 context/连接再停止宿主，并继续核进程退出，不关闭关闭检查或伪称已停止。

第二轮11项10通过/1失败：首次合成登录返回429（UI正确显示限流）；没有自动重试、提升限额或更改服务端。随后的新宿主专项4/4通过。限流根因本批未确定，保留该失败事实，不能反称首轮实际登录全部稳定通过。

后续新增“核 Session 断网继续本机编辑”反例，以及表单/主题/超时验证。完整回归与最终结果随后记录。

175项全量首次出现两项失败（173通过）：旧编辑器存储故障用例输入后第一行未出现预期 `x`，该文件4项单独复验均通过，未修改旧断言或编辑器。审查发现演示路由虽跳过登录渲染，仍会读 Session、清 Query 缓存，可能干扰其加载；已使演示路由同时跳过会话读取/缓存清理，并在原数字逻辑用例断言零 Session 请求。另一项为合成换账号后迟到响应轮次中重新收到401；新增旧会话 HTTP 主动取消以减少迟到 Cookie 影响，保留独立代次与上下文正确性守卫。

最后定向组合15/15通过，包含新的“故意禁用 AbortController 取消，旧 Session 成功/旧401仍不能覆盖账号B”反例、实际HTTPS专项4项，以及原正常辅导HTTPS/SQLite/worker专项1项；后者继续核原帮助/控制/历史与账号切换，没有实际供应商请求。宿主退出改为同时核退出码0；未取消关闭验证。

随后固定实现的176项全量175通过/1失败（7.9分钟），旧编辑器用例通过；仅换账号用例在账号B明确退出时，成功提示被“请登录后继续”覆盖。根因收口：`PrepWorkspacePage.onSignOut` 在全局会话入口已接管后仍执行旧 `init.reload()`，会创建当前代次的多余匿名 GET；它不能靠“旧请求代次”判据过滤，可能打断下一次快速登录。正常模式现直接交给全局退出，不在旧页面 await 之后重启初始化；准备模式保留原流程。迟到 Cookie 影响为此前排障考虑，不能把它写成已确认的这次根因。后续仅复验该分支影响的会话/深链/辅导及准备/编辑器组合，不无理由重跑其余通过项。

### 验证命令与边界

Windows 学生工程 Node v24.15.0、Chrome 155.0.8059.40；教学宿主沿现有 Ubuntu WSL 与精确 Node v24.21.0/native 依赖。没有新增安装、依赖升级或配置/schema 变更。服务专项通过原 HTTPS/SQLite 的真实401驱动失效路径：正常 API 退出令 Cookie 失效后核 UI 重新登录，没有实际等待30分钟/8小时或更改服务端时限。

学生目录执行：

```powershell
rtk npm run typecheck
rtk npm test
rtk npm run build
$env:XUNJIE_E2E_BROWSER_CHANNEL = 'chrome'
$env:XUNJIE_E2E_PREP_PORT = '5671'
$env:XUNJIE_E2E_REAL_PORT = '5672'
$env:XUNJIE_E2E_RESTART_PORT = '5673'
$env:CI = '1'
# XUNJIE_E2E_SERVICE_NODE 引用已有教学环境的 Node 24.21.0，不写个人安装路径。
rtk npm run test:e2e
rtk npm run test:e2e -- sessionEntry.spec.ts sessionService.spec.ts real-mode.spec.ts tutoringService.spec.ts prep.spec.ts editor.spec.ts --workers=1
```

仓库根执行 `node tools/a0-review/check.mjs` 与 `rtk git diff --check`。正式 dist 扫描 `__i0prep`、固定准备账号/任务/资料 ID 与 `syntheticAccount` 未命中。浅/深主题截图已查看；未用截图替代业务断言。最新单测34文件/464项通过，最新 typecheck/build 退出0；既有构建大 chunk、开发品牌 public 导入与 NO_COLOR 提示保留，未改配置或隐藏检查。最终浏览器组合结果与提交状态随后记录。

### 最终结果与交付

状态：`implemented / synthetic-https-verified / local-delivery`。最后根因修复后的定向组合29/29通过（2.2分钟）：编辑器4、准备10、real入口7、会话协议反例3、实际会话HTTPS/SQLite 4、原正常辅导HTTPS/SQLite/worker 1。该结果不写成一次全量176/176；完整回归最后一次为175/176，其唯一失败分支已修复并纳入29项复验，其余通过项未重复跑。

UI-REAL-01/08 本批合成正常宿主验证完成；UI-REAL-02 获准深链/固定活动/公开资料沿既有入口接入。本机原账号较新草稿在登录恢复及刷新后保留，账号B不展示账号A草稿，迟到响应不改新账号；并核实际 Cookie 所属 Session 为账号B。没有自动创建/保存/冻结/求助/运行。合成操作不计真实学习行为。

交付写集19文件，包含当前任务记录与根/学生 README，随代码在原 `main` 作本地提交（`ba89fe0`；该归属后经用户纠正移至 `i0/ui-frontend`，见 §4）；不推送、不合并PR、不发布。无关 `.zcodeignore` 不暂存。没有新增临时探针/配置；测试进程与临时证书由原 harness 回收，最新服务专项核退出码0；构建产物与浏览器截图作为可复验交付证据保留，合成库遵循原审计保留边界。撤回本批只需按该本地提交恢复所列前端/测试/入口文档，不清除任何账号草稿或改后端数据库。

产品基线及 MVP_SPEC §10：待授权维护者汇总。未完成的分配列表/跨设备发现与真人/节点/模型/完整AC/NFR边界见上，不据此关闭整项I0或宣布完整应用/教学效果通过。

## 4. 分支归属纠正（2026-10-14，用户授权）

用户当日在会话中指出本批应在既定前端分支开发，而非 `main`。核对确认原前端分支为 `i0/ui-frontend`：它随 [PR #57](https://github.com/paher-din/XunJie/pull/57) 合入后已按原任务清理，本地与远端均不存在，checkout 因此回到 `main`，本批才误在其上开工并提交。核对该误判、确认应以 `i0/ui-frontend` 承接本批，是本批责任范围内的疏漏，不是新方案。

用户随后明确授权本次纠正。执行结果：

- 新建并检出 `i0/ui-frontend`，指向本批提交 `ba89fe0`；其唯一父提交为 `eea9623`，完整祖先历史由该分支保留，`ba89fe0` 始终可达。
- 本地 `main` 经绑定旧值的 Git 引用更新恢复到原基线 `eea9623`（与本地 `origin/main` 一致），不再包含本批提交。未使用 `reset`、`stash`、历史删除或文件删除，未改动工作树源码。
- 未推送、未创建 PR、未改动任何远程引用；远程 `main` 仍为 `eea9623`，`i0/ui-frontend` 现仅存在于本地。
- 无关未跟踪 `.zcodeignore` 保留且未暂存。

纠正证据：`ba89fe0` 的树为 `676cd14fdd3d2feafd8359c18e2458ccca096276`；`i0/ui-frontend` 初建时即指向该提交，其提交树与 `ba89fe0` 完全一致。补记本任务记录后，前端分支相对 `ba89fe0` 的唯一文件差异为该记录本身，其余文件仍与 `ba89fe0` 相同；除该记录外，`git ls-files -s`（排除本记录）纠正前后哈希均为 `C5641B0AFB3510D6D764F755D73922AFD74B4051CFC6B00C8F31DED957B0CD03`，即应用源码/测试/README 保持原版本。本记录作为 `i0/ui-frontend` 上的独立本地提交，未推送。
