# I0-UI：团队共用后端与显示资料绑定

日期：2026-10-15（Asia/Shanghai）。主责：UI / Robert。依据分支 `i0/ui-frontend` / `a1b1235`；主checkout已有教师UI并行未提交内容，本任务使用附属隔离worktree，不改其文件。

## 本轮要求与状态

负责人已明确批准复用 PAHER 现有服务和数据库，并新增下列三个显示字段及原读取接口接线。2026-10-15 进一步要求合并两个学生演示账号，只保留一个用于演示与开发调试。推送、建 PR、合并 main 已获本会话授权，不重复请求。

已读 README、根AGENTS、PRD §3.2/4.1–4.3、MVP_SPEC M-10/§4、TECH_DESIGN §3.3/§4/§5.1、I0_UI_SPEC与客户端约束§2、IMPORT_SOURCE、本地DESIGN、I0-UI55/本机C-HDL说明及当前显示名记录。适用：会话可信身份、课程成员与分配授权、固定活动正文、同源请求及原执行宿主；不改产品/规划/参考/工作规范。

本任务可写：三个可空显示列的显式迁移及初始化、原 Session/课程/分配读取投影、学生端显示消费和对应验证；共享入口工具、README 和本任务记录；PAHER 现有合成库的显示资料、统一演示账号课程/任务接入及必要部署。保留所有原 ID、密码与旧作品，不重写历史归属；不改受保护文档、不操作另一会话的本机3444与共享浏览器。不复制账号密码、私钥、数据库或旧运行记录到 Git。

## 改动前核查

| 对象 | 当前来源 | 缺口 |
| --- | --- | --- |
| 登录与权限 | `apps/teaching/server/access/app.ts` 的真实Session、成员关系；`server/app/digital-logic.ts`的本人assignment过滤 | 可以直接共用一个现有服务/库，不需要各机初始化 |
| 账号姓名 | `server/db/transaction.ts` 的users只有id/login_name及认证字段；Session只返回userId/courses/csrfToken | 无display_name，不是已有姓名被前端漏读 |
| 课程名称 | courses只有id，课程列表仅courseId/role | 无课程名存储 |
| 项目标题 | `activity_versions.activity_json`中的固定projectTitle，经学生投影公开；`apps/student/src/workspace/home.ts`已读取 | 本机旧合成活动的标题本身含工程验证文字，不能用前端替换冒充真实档案 |
| 临时别名 | `apps/student/src/lib/displayNames.ts`把特定ID/旧标题换为Robert/小林、中文课程名、文本分析工具 | 仅显示补丁，不创建账号/课程/分配，不应作为正式资料源 |

真实页面按Session所属课程读取本人分配：同一后端同一账号应看到同一份服务端任务；不同账号仍按分配不同。当前Robert种子为A/B都建两门课程成员关系，但C只分A、HDL只分B。浏览器本机未确认草稿继续按设备保护，不会仅因共用后端变成跨设备草稿同步。

## 共用服务的最短路径

1. 选一个现有35表宿主及数据库作为团队唯一业务来源，复用原认证、C/HDL执行和静态页面；不新搭第二套业务服务、不复制库到每个成员电脑。
2. 优先核PAHER已有两课程宿主；成员通过获准SSH本机回环转发访问同一HTTPS源和原页面。只需客户端访问通路及受信公共证书，不分发服务TLS私钥，不放宽Origin/CSRF/TLS。
3. 既有 `tools/i0-ui55/local-ui-gateway.mjs` 固定3443/14443并接PAHER旧C-only入口，不能宣称它已支持35表3444。PAHER维护SSH与应用转发SSH身份/权限分开，3444转发是否已允许须实核；当前Robert3444由另一会话使用，本轮不抢占或部署。
4. PAHER原库与Robert本机新库不同。必须明确团队复用PAHER现有活动/分配，还是保留Robert当前那一批对象；指向PAHER不会自动带上synthetic-robert账号/作品。未经确认不迁库、不重播学习记录。

2026-10-15 12:42（Asia/Shanghai）原维护SSH实连成功，原公钥/host pin通过。PAHER回环3444正在监听，严格TLS下 `/health/live`、`/health/ready`、`/` 均200，入口 `/assets/index-BjElIjC5.js`；3443无监听。当前PID2880、cwd `/mnt/d/XunJie`，确切Git提交未确认（目录Git读取退出128，未修改信任）；历史87edd51的两个应用unit不再存在，不能当当前运行源。

进一步从PID唯一已打开SQLite定位，使用mode=ro只查sqlite_master/PRAGMA：实际35张业务表（另有sqlite_sequence），包含C/HDL配置、构建、会话、运行和提交结构；uses/courses/assignments确实没有显示名字段。本轮没有SELECT业务记录，不声称具体账号/课程/分配数量已核定。没有读取凭据/配置/环境变量或改变远端文件；未启动隧道/服务/浏览器，尚未验证成员SSH3444转发许可及浏览器信任。r

因此PAHER3444是当前实证可复用候选，不能继续使用已停止的3443。两人各自打开127.0.0.1，只在均转发到同一宿主时才共享后端；拉Git不自动切换运行包或数据库。

## 已批准的显示资料接线

建议在选定的同一库内补三处可空显示资料，保留现有所有ID、登录名、密码、成员和作品：

- `users.display_name`：账号显示姓名。
- `courses.name`：课程名称。
- `assignments.display_title`：分配项目的显示标题；与原assignment绑定，仅作展示，固定Activity正文和旧提交/证据标题不被改写。未提供时仍用原Activity的projectTitle。

通过现有读取接口返回：Session加本人displayName和课程name；`GET /api/courses`带name；分配详情/列表带displayTitle。前端只读这些受授权字段，撤掉按测试ID或固定旧文本硬编码的别名。此处不新建档案后台、不扩展权限、不用课程标题推断身份；显示资料仅由维护者一次性录入。

旧库执行可空列增量前备份选定库；显示资料沿负责人已要求的正常人名、课程名、项目名写入后端，不改登录名或密码。迁移必须显式调用，不在启动时自动升级未知数据库。

计划验收：同一服务两浏览器同账号读到相同姓名/课程/任务；换账号按原分配隔离；另一个真实ID及其不同名称亦从后端读取，不再命中特定synthetic字符串；旧数据/原ID/作品版本不变；前端协议验证与实际SSH/HTTPS两端验证分别记录。

## 统一演示账号与团队入口

2026-10-15 只读盘点：PAHER 的 student-a 无分配/Attempt；student-b 在 course-b 有四个 HDL 分配及四个 active Attempt。保留 B 作为统一学生演示账号，可保留全部旧 HDL 历史；为其增加 course-a 学生成员关系并沿原业务能力补 C 演示任务。A 退出演示入口并撤销会话、停用登录；必要教师身份保留。原分配/Attempt/作品不转移、不删除，不把本机 synthetic-robert 库迁入 PAHER。

所有成员使用同一 PAHER HTTPS 页面、API 和数据库。仓库提供固定目的地的回环 SSH 转发入口，3444 已占用则拒绝，禁止静默复用本机服务；不运行各机初始化。成员各用自己的获准 SSH 身份；密码及私钥经现有私下渠道领取，不写 Git。现有受限转发只允许3443，须将相同目的地的3444加入许可后才能接当前服务，保持仅本机回环，不开公网业务端口。

共享同一学生账号意味着已确认作品和任务属于同一个演示身份；本机未保存草稿仍按设备保存。开发者同时修改同一作品时沿现有版本冲突提示处理，不承诺互不干扰。

## 实施和现场结果（2026-10-15）

- 后端：`apps/teaching/server/db/transaction.ts` 的 `migrateDisplayMetadata` 显式、事务性补三列；原35表不变。Session、课程、分配列表/详情/bootstrap 返回可选显示字段，空值省略；原初始化格式兼容可选姓名/课程名。
- 前端：`apps/student/src/lib/displayNames.ts` 撤掉特定测试ID/旧文字映射，原账号组件和首页消费后端资料；搜索使用显示名，URL、请求、缓存和草稿归属仍用原ID。固定 Activity 正文与已确认作品没有改写。
- 共享入口：`tools/i0-shared/start.ps1` 固定转发 PAHER 回环3444，端口已占用则拒绝，不接管本机3444。随包仅提供 SSH 主机公钥与原公共 TLS 证书，无任何私钥或密码。sshd 原 `xunjie-tunnel` 的 PermitOpen 加入同一目的地3444，未扩大监听、用户或防火墙来源。
- PAHER：先在原源码副本上应用本批补丁，保留原消费、执行、模型和关闭语义，再显式迁移原库。原库备份为 `/opt/xunjie-runner/tests/i0-entry-20261013-01/shared-demo-before-20261015.sqlite`，只在服务端保存。差异应用最初因原副本 CRLF 失败；仅在新副本统一换行后检查并应用成功，没有覆盖原源。
- 统一学生：`synthetic-i0-student-b` 显示 Robert，属于“C 程序设计”和“数字逻辑与系统设计”；保留原四个 HDL 分配/Attempt，并新增一个“文本分析工具”C分配 `220b2dae-5070-42ff-a165-daaf681a0644`。旧 A 和辅助 peer 停用并撤销会话，原密码/记录保留；两个教师身份继续承担原业务授权，不作为学生演示账号。
- C 任务通过原教师资源→手工蓝图→检查→确认发布→分配接口创建，沿当前受信 C profile，无模型调用、程序运行或学生学习记录补造。现有 HDL 项目显示“四位算术逻辑单元”，显示列不修改其固定活动正文。

运行源为 `/opt/xunjie-runner/tests/shared-ui-20261015`；原35表库仍在 `i0-entry-20261013-01/retained-tmp-20261014/xunjie-a12-completion-dZlbr9/synthetic.sqlite`。本批未触及 Robert 本机3444、个人模型配置工作区或主checkout教师UI的未提交文件。

### 持久入口和已纠正的问题

初次后台进程在维护 SSH 结束后退出，WSL 内瞬态 VM/应用单元随之丢失；该临时启动不计部署通过。已用 PAHER Windows 任务 `XunJie Shared Demo` 独立持有 WSL，调用原 `runner/vm.sh start` 恢复原 VM（没有重建镜像），再由 `xunjie-shared-demo.service` 运行应用。模型继续取原 PAHER 用户环境中的 key，仅在进程内传递，没有新建密钥文件或输出值。

任务入口为 `D:\tmp\xunjie-shared-20261015-input\start-shared.ps1`，配套 `keep-shared.sh`、原保留启动包装器及新公开 launch receipt；Windows 任务在维护用户登录时触发。已检查语法、实际重启任务并在维护SSH退出后的独立连接中核 `/health/live`、`/health/ready`、`/` 全200、原VM active、应用 active且无重启。未做整机重启验收。

维护者在 PAHER PowerShell 可用 `Start-ScheduledTask -TaskName 'XunJie Shared Demo'` 启动；停止时先在 WSL `systemctl stop xunjie-shared-demo.service`，再 `Stop-ScheduledTask -TaskName 'XunJie Shared Demo'`。不要用旧3443配置直接启动35表宿主。需要回退时保留新记录，换回保留的原源码/包装器；可空显示列可继续保留，不通过删库或重写旧作品回退。

### 验证

| 层次 | 实际结果 |
| --- | --- |
| 后端定向 | Windows Node24.15：显示元数据/原DL-A/会话/bootstrap共46/46；WSL Node24.21.0复验新增4/4、两类initializer兼容2/2，均无跳过。覆盖重复迁移、缺表事务回滚、旧记录保留及学生越权读取。 |
| 后端类型/构建 | Node24.21.0 `tsc --noEmit`、`npm run build -- --preserveSymlinks` 通过；参数仅处理本机跨盘依赖junction，未安装依赖或改源码迁就环境。 |
| 前端 | typecheck/build通过；真实Chrome `homeEntry.spec.ts` 5/5，涵盖任意ID的后端名称、缺字段回退、原ID路由与跨账号迟到响应隔离。 |
| 工具 | PS7 AST、无网络Help、已有3444占用拒绝及主机公钥一致性通过；没有停止占用的本机服务。 |
| PAHER 数据 | 35业务表；仅一个可用学生演示身份、两个原教师身份。旧 A/peer 用原密码登录均401。迁移与新C发布后，原Attempt、文件、快照、运行/提交及旧活动逐行与备份相同。 |
| PAHER 真浏览器 | 两个独立Chrome context通过同一受限SSH连接登录B；严格TLS验证，同样读到Robert、两门课程、1个C/4个HDL分配及两类bootstrap。C课程卡片显示“文本分析工具”。为避开另一会话的本机3444，验收使用独立15944 SOCKS转发；地址与Origin仍为HTTPS3444，没有代理改写业务请求。 |

公开结果：[现场数据与健康](evidence/shared-demo-20261015/final-public.json)、[两个浏览器的相同投影](evidence/shared-demo-20261015/browser-public.json)、[C课程页面](evidence/shared-demo-20261015/course-c.png)。这些是开发合成验证，不计真实学习、课程审阅、模型效果或新的C/HDL执行验收。

### 成员接入边界

所有成员按[共享入口](../../tools/i0-shared/README.md)连接同一个服务即可共享账号、课程和任务；拉取代码本身不包含数据库。当前已实测的SSH来源仍是Robert的 `192.168.3.8`，其他成员需将各自公钥/IP交给PAHER维护者登记，未宣称未知成员已连通。无需A/C再初始化应用账号、课程或本机数据库。共享同一账号的已确认作品遵循原版本冲突处理，本机未保存草稿不跨设备同步。

产品基线及MVP_SPEC §10：待授权维护者汇总。

文档检查：`node tools/a0-review/check.mjs` 为127篇、1949条内部链接、`errors=[]`；本任务暂存写集空白检查通过。依赖/lock、保护基线及主checkout并行改动未入本批提交。

交付入口：[PR #89](https://github.com/paher-din/XunJie/pull/89)，基于 `a1b1235` 沿原 `i0/ui-frontend` 推送，实施提交 `92a128e`；main 合入状态由该 PR 提供可核查记录。成员接入请直接使用随 PR 的共享入口，不沿旧本机课程种子重建数据。
