# I1 教师端连通性测试：本轮执行记录（2026-10-15）

## 1. 任务、依据与写集

负责人请求按[教师端连通性方案](I1_TEACHER_CONNECTIVITY_TEST_PLAN_20261015.md)执行测试。方案基线为 `4ea3c73`，本轮实际源码为 `main@9664ca5646b969cde0ccff4f4b8d5c7ea2da547d`。参照方案列明的 PRD/MVP/TECH/TEAM 章节、[教师工作台](I1-TEACHER_UI_WORKBENCH.md)、[原验证工具](../../tools/teacher-workflow/README.md)及本轮只读环境准入实测。

首次执行仅维护本记录、证据目录与隔离运行产物，未改应用源码、凭据、数据库、产品/规划/参考/规范，未调用真实模型、部署、提交或推送。修复轮由负责人另行要求“修复”，写集和复验见[修复记录](I1_TEACHER_CONNECTIVITY_FIX_20261015.md)。

环境为 Windows x64、Node24.21.0、现有 Chrome；教学锁文件 SHA256=`7D93AFC2441ECEFF0CCD26A9CAE981557A9F789021B40F079A70D4EA356D548E`，学生锁文件 SHA256=`B371F9085F1EE3A5494C9EDDC4360D394ADAE137A31869FEF028EE1319A047D6`。

## 2. 第0批：真实环境准入（BLOCKED）

| 条件 | 首次检查结果 |
| --- | --- |
| 本轮环境所有者、可写库/课程、维护者收据 | 未取得 |
| 3444正常复核宿主、精确41表与review组合 | 本机没有3444监听，不能核验 |
| 已部署前后端版本、严格TLS live/ready、Session/workbench | 无宿主可检查；本机Git版本不代表已部署 |
| 教师/学生独立会话、受控合成账号、并行操作协调 | 缺宿主和账号，未执行 |
| 备份/恢复负责人及范围 | 未取得 |
| 模型关闭及无fixture回退 | 真实宿主无法核；本轮没有真实生成请求，协议替身结果单列 |

首次报告记录的只读现场：WSL Ubuntu 中 `/opt/xunjie-ui-local`、`/opt/xunjie-runner` 均不存在；无 `XUNJIE_*` 环境变量；只有原5601开发预览。`verify-browser.mjs --course c`仅输出绑定Robert原环境的计划，没有运行真实链。

结论：TC主链的C、HDL各18项共36个课程执行项，本轮真实浏览器执行0项，均BLOCKED。TX需要真实宿主、账号、重启或恢复授权的环节另列阻塞，不能把它们与TC合计成“总共36项”。不搭建替代宿主、不用预览充当真实连通性验收。

## 3. 第1批首次执行结果

日志均在[证据目录](evidence/teacher-connectivity-20261015/)；[证据清单](evidence/teacher-connectivity-20261015/evidence.json)含首次文件摘要及控制台捕获规范化说明。

| 命令/测试组 | 首次结果 | 对应日志文件 |
| --- | --- | --- |
| 教学类型检查 | exit0；原记录实际为直接调用tsc，无输出日志 | evidence.json transcriptNotes |
| 教学构建 | exit0 | batch1-teaching-build.txt |
| 后端四文件专项 | 73项：72通过、1失败 | batch1-teaching-4files.txt |
| 学生类型检查 | exit0 | batch1-student-typecheck.txt |
| 学生三个文件专项 | 16/16通过 | batch1-student-targeted.txt |
| 学生全量单元 | 53文件、647/647通过 | batch1-student-full-unit.txt |
| 学生构建 | exit0 | batch1-student-build.txt |
| teacher-ui、sessionEntry、real-mode浏览器回归 | 18通过、1失败 | batch1-student-e2e-3specs.txt |
| 新教师模型设置专项 | 2/2通过，协议替身 | batch1-student-e2e-teacher-model-settings.txt |
| 额外教学全量npm test（非方案指定命令） | 未完成；停止输出、进程存活且CPU长期无增长后终止，仅保留部分日志 | batch1-teaching-full-suite-partial.txt |

浏览器使用已有Chrome和独立端口5621/5622/5623，未关闭原5601。服务测试使用隔离真实数据库和app.inject；浏览器组使用协议替身，两者均不是本机正常宿主端到端结果。

命令级统计：方案/新增入口共9组首次检查，7组成功、2组含失败；额外全量检查1组未完成。不能写“8条命令通过、2项失败”。各组测试用例相互重叠，禁止把647、16、73等加成独立业务覆盖数。

复核补记：额外全量部分日志第326行已经出现 `review: real RunControl preparation failure ends check without fabricating a RunRecord` 失败；原报告漏记，不能只表述为挂起。修复轮只跑该用例，exit1、0通过/1失败，明确为 `Linux and trusted control context required`（`runner/control.ts:48`），与仓库既有Windows基线失败相同。新诊断日志为fix-windows-runcontrol-diagnostic.txt。该平台失败不等于整个全量挂起原因已确定，不修改平台守卫、不跳过后宣称全绿。

## 4. 发现一：登录旧响应竞态用例超时

`apps/student/e2e/sessionEntry.spec.ts`中“取消请求失效时仍靠会话代次拒收旧 Session 成功与旧401”在9664ca5超时60秒。单独运行也超时；原记录的旧基线对照为d77c9cc上2.9秒通过。

[请求轨迹](evidence/teacher-connectivity-20261015/finding-sessionentry-request-trace.json)显示：登录成功、Session成功后，新启动请求`GET /api/model-settings`与`GET /api/agent/conversations`被测试兜底401拒绝。客户端依现有规则使会话失效，目标bootstrap没有发出。原正向对照仅补两项合法响应，保持竞态业务断言，3.0秒通过，见finding-sessionentry-positive-control.txt。

根因是该用例的协议替身未跟上AppShell新增读取。此证据不证明生产认证策略错误，不据此放宽401失效规则。修复轮为已登录身份补空且禁用的个人配置、空聊天列表，维持未授权路径401，保留旧成功/旧401迟到后仍为新账号的原断言。

## 5. 发现二：A4断言随机误报

`tests/review.test.ts`的B2准备状态用例在整个references序列化字符串搜索`900`。随机UUID或SHA中出现该数字串也会误报；有效状态字段已经是1，不能据子串判定注入版本被接纳。

首次四文件72/73，保存的复跑日志为73/73；review单独日志为51/51；25轮单用例记录为24通过、1失败。原报告另自述有多次复跑；已入库的具体文件仅按实际清单核对，不增加不存在的独立证据。

修复轮改为逐条学习状态引用检查`learnerStateRevision===1`，继续核真实claim引用及assistanceStatus；不限制随机ID/摘要或原始正文包含数字串。

## 6. 用例覆盖与未执行项

下表为首次执行的覆盖分类，整项真实页面状态与隔离证据分开；不把局部隔离断言当整项PASS。

### 6.1 TC主链

| 项目 | 本轮隔离层证据 | 真实页面状态 |
| --- | --- | --- |
| TC-01 登录/退出/深链 | 会话协议用例有覆盖，但旧响应用例首次失败 | BLOCKED |
| TC-02 工作台/只读发现 | teacher-workflow真实隔离DB覆盖 | BLOCKED |
| TC-03 材料导入 | 未执行三种输入的完整真实链 | BLOCKED |
| TC-04 私有材料边界 | teacher-ui协议裁剪和A5读取权限有覆盖 | BLOCKED |
| TC-05/06 草稿创建/保存 | 预览有交互覆盖，不能证明真实PATCH版本链 | BLOCKED |
| TC-07 检查阻断 | 不能以服务端或预览局部覆盖填整项通过 | BLOCKED |
| TC-08 三角色预览 | 本轮teacher-ui协议场景覆盖；design-projection既有证据非本轮重跑 | BLOCKED |
| TC-09/10 固定发布/分配 | 预览与服务测试局部覆盖，真实双方列表未测 | BLOCKED |
| TC-11～16 提交/固定作品/反馈修订/许可/再提交 | 四文件专项覆盖服务事务、反馈版本、旧作品及主动重开，浏览器协议部分覆盖 | BLOCKED |
| TC-17/18 后续复制与有效历史 | a5-followup专项覆盖独立尝试及上下文过滤；不等于模型语义通过 | BLOCKED |

C、HDL均有正常宿主组合的隔离提交/反馈/重开用例；构建、板卡、仿真本轮未执行。

### 6.2 TX异常场景

| 项目 | 已有隔离覆盖与缺口 |
| --- | --- |
| TX-01/02 越权 | A4/A5权限与协议场景覆盖；真实浏览器BLOCKED |
| TX-03 认证/Origin/CSRF | 本轮协议部分覆盖；不以客户端替身证明服务端Origin/CSRF完整验收 |
| TX-04 材料边界 | 本轮NOT_RUN，原design-material测试可另补 |
| TX-05 两标签草稿冲突 | 本轮未直接执行；候选先提交导致旧教师判断冲突的测试不能替代草稿PATCH冲突 |
| TX-06 教师旧判断/候选冲突 | A4状态CAS有隔离覆盖；不自动宣称两个教师浏览器表单实测 |
| TX-07 纠正及迟到结果失效 | A4同事务回滚、原运行与已展示事实保留有隔离覆盖 |
| TX-08 反馈范围/线程版本 | A5两线程范围CAS有隔离覆盖 |
| TX-09 旧提交/最新提交 | A5固定旧作品及formative行为有隔离覆盖；浏览器并发反馈未测 |
| TX-10 幂等 | A4/A5原键回执重放有覆盖；全部命令/页面重复点击未逐项测 |
| TX-11～13 断响应/不完整回执/账号切换 | backend等单元有局部覆盖；真实页面新增分支未执行，保持BLOCKED/NOT_RUN |
| TX-14 许可失效及暂停恢复 | 有原服务语义证据；本轮未直接逐步验证全部步骤，控制UI缺口保留 |
| TX-15 模型关闭仍可用 | teacher-workflow隔离组合、无模型调用有覆盖 |
| TX-16/17 重启/恢复代际 | BLOCKED，缺专用环境与明确恢复范围 |
| TX-18 历史依据/异议 | A5历史异议专项覆盖；UI读写能力另核 |

### 6.3 TE扩展

| 项目 | 状态 |
| --- | --- |
| TE-01 教师AI设计 | BLOCKED；个人模型配置入口不等于AI根草案/局部提案已连通 |
| TE-02 试评量规/样例运行 | GAP-UI待具体确认，服务端本轮NOT_RUN |
| TE-03 课程导出/活动控制 | GAP-UI；预览JSON不是课程导出 |
| TE-04 后续支持语义 | NOT_RUN，无真实模型输出 |
| TE-05 真人教师闭环 | BLOCKED，未以自动化代替本人教学判断 |
| TE-06 键盘/布局 | 部分协议覆盖；教师UI720/390、模型设置三档按对应日志分别记账；真实宿主布局BLOCKED |
| TE-07 NFR | NOT_RUN，单用户检查不证明p95或10会话目标 |

## 7. 修复与复验

负责人核查上述结果后要求“修复”。修复前有327个Unicode替换字符的报告已逐字节备份为[原报告](evidence/teacher-connectivity-20261015/execution-before-fix.txt)，SHA256=`7b49f66754bc4e15ec920e3edc246c135574a83e5a9d8acf9019de739c3530e2`。当前中文按可核查源日志、证据清单及原章节恢复；失去的字符不伪称机器可逆还原。纠正命令分母和过度覆盖映射，首次失败记录完整保留。

修复后专项结果见[修复记录](I1_TEACHER_CONNECTIVITY_FIX_20261015.md)与新fix-*日志；原证据清单及首次日志不覆盖。当前不能因复跑通过改写首次失败或真实宿主阻塞。

已确认修复轮前端单元53文件、647/647通过；真实Chrome四文件协议回归21/21通过，包含原登录竞态、教师UI、真实模式守卫和教师模型配置；后端四文件73/73通过，0失败/取消/跳过，169.94秒。两端类型检查exit0。它们仍是隔离回归，不是正常复核宿主的真实业务写入。第一轮fix-*进程中断、没有终态汇总的日志保留，不计通过；复验以对应fix-*-final.txt及完成回执为准。

负责人指出有WSL后，补用Ubuntu Linux x64、指定Node24.21.0及原锁Linux依赖，在独立临时目录运行：原Windows失败的RunControl用例1/1通过；整个`server/workspace/review.test.ts`文件5/5通过、exit0、无跳过，13.62秒。单项属于5项之一。源文件与锁摘要均和当前Windows工作区一致，平台守卫未改。首次跨会话临时目录不可读的准备失败保留；最终在同一会话内完成。详见[修复记录WSL补验](I1_TEACHER_CONNECTIVITY_FIX_20261015.md#wsl-补验2026-10-15)及证据目录wsl-*文件。此结果解决该项Linux验证缺口，不代表后端全仓挂起或正常教师宿主已经验收。

## 8. 未完成与边界

- 本机真实教师—学生主链、真实模型、真人师生及完整NFR均未验收。
- 原后端全量挂起只有部分日志，不能据末行认定具体挂起用例；需有界诊断后再归因。
- 本轮未自动部署、迁移、生成账号、填写Key或连接执行节点。
- 产品基线与MVP_SPEC §10仍为待授权维护者汇总，不改保护文件。

## 9. 下一步

先完成修复专项及原浏览器组合复验，再处理有界后端全量诊断。真实主链需维护者提供同一套正常复核宿主、账号/课程范围、版本收据和备份责任；原Robert绑定工具不能直接用于本机缺失环境。任何环境准备、恢复或模型调用按具体对象与授权单列实施。
