# I0-UI：吉祥物提问进入独立对话

日期：2026-10-15。负责人：Robert。状态：本地实施与隔离验证完成。

## 依据与范围

- 基线 `956f527`，新分支 `codex/mascot-chat-transition`；开工时工作区干净。Robert 本轮明确要求修复首页吉祥物输入框发送卡顿、误报“消息发送未确认”、缺少平滑进入正式对话页，并跑通回车与发送键。
- 已读 PRD §1.1、§3.2、§5（C-05、PRD-09/10），MVP_SPEC §2、M-04/05/09、§4、AC-06/12，TECH_DESIGN §3.3、§5 HTTP 回执、§6.1/6.2、§7 恢复；README 当前入口，TEAM_WORK_PLAN 的 UI 分工，I0_UI_SPEC 的发送/ACK 原则、I0_UI_CLIENT_CONTRACT §2/3、I0_UI_MODEL_CONFIGURATION_REAL_CHAT §6～10，DESIGN.md 的首页气泡与页面入场，以及设计来源 `home-design.md` 已确认的“发送后平滑渐入独立 Agent 对话页”。
- 负责模块：`apps/student` 首页吉祥物输入气泡、全局外壳与独立 Agent 对话页的交接。可写：对应前端组件/样式、专项浏览器测试、本记录及真实使用说明有变化时的 `apps/student/README.md`。产品、规划、参考、规范文件只读；不改后台契约、数据库、密钥或 CI。
- 方案：用现有 Agent 页回合控制处理首页首条问题，首页提供即时换页反馈，保留原问题、幂等与未知结果恢复；沿用已有页面入场节奏和减少动效规则。具体实现以复现后诊断为准。
- 验收：回车和点击各只发送一次；发送后不用等模型终结即平滑进入 Agent 页并显示原问题/等待态；接纳后进入同一会话并展示回复；连接/接纳失败在 Agent 页保留原问题与核对路径，不用笼统首页 toast；键盘与减少动效可用。

## 根因与实现

- 原 `AppShell` 用 `sendMessage()` 等到整个模型回合终结才导航；长时间等待与模型/网络错误均留在首页，并统一显示“消息发送未确认，请打开原会话核对”。已有 Agent 页具备接纳后导航、流式状态和原请求恢复，但首页绕开了它。页面渐入 CSS 原已存在，延迟导航使其不能在发送时出现。
- `AppShell.tsx` 改为只交接首页原问题和登录代次、立即导航。`AgentPage.tsx` 用原 `useAgentTurn` 发起一次请求，接纳后补会话地址；首次挂载的 StrictMode 清理结束后才发起，避免清理误停新回合。配置仍在读取时先显示原问题，读取完成后发送。登录代次改变则不跨账号发送。
- `personalAgent.spec.ts` 增加吉祥物→回车、入口气泡→发送键、接纳/流式终结、页面渐入、断线核对原幂等请求、配置读取延迟等合成浏览器场景。原退出换账号场景的合成 Session 没有学生课程，导致页面健康提示盖住账号按钮；仅修正该测试 fixture 以保留原断言。`apps/student/README.md` 同步当前使用路径。

## 验证与交接

- 红例：`personalAgent.spec.ts -g '首页吉祥物Enter'` 在服务端已接纳但仍等待时，3 秒内仍停留首页；慢配置读取红例在配置返回后仍不进入会话。修复后两者转绿。
- 最终本机 Node 24.15、Google Chrome 合成 HTTP 协议：`CI=1 XUNJIE_E2E_BROWSER_CHANNEL=chrome XUNJIE_E2E_PREP_PORT=5741 XUNJIE_E2E_REAL_PORT=5742 XUNJIE_E2E_RESTART_PORT=5743 npm run test:e2e -- personalAgent.spec.ts --reporter=dot`，17/17 通过，含原完整独立聊天回归。未安装的 Playwright 自带 Chromium 初次启动失败，转用本机 Chrome；整组中途一条旧测试因无课程 fixture 被页面提示遮挡，修正 fixture 后 17/17。
- `apps/student`: `npm run typecheck` 通过；`npm test -- --reporter=dot` 为 54 文件/657 项通过；`npm run build` 通过，保留原大 chunk 提示。仓库根 `node tools/a0-review/check.mjs` 的 `errors=[]`；`git diff --check` 通过。
- 本轮测试只用隔离合成 HTTP/Chrome，没有对现有 HTTPS 宿主部署，也没有调用真实供应商或操作真人学习记录；真实服务器数据/模型回复仍按已有批准入口另行验收。产品基线及 MVP_SPEC §10 待授权维护者汇总。
