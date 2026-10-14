# DL-A / PR67：正式现场接线回交

日期：2026-10-14（Asia/Shanghai）；C。来源：[PR56评论](https://github.com/paher-din/XunJie/pull/56#issuecomment-6168703238)，本人任务：[续作§9](DLA_CONTINUATION_20261014.md#9-接续-ui55--pr67-的评论处理)。

## 当前固定来源与实际验收

PR56从7100ea6正常merge包含PR67的main@b7e73c5，merge为 `f761dcddb2081fa7948fc7f6bd03cfe593d22b5f`；后续本人证据提交不改变应用/正式UI字节。无冲突、无cherry-pick/强推，tools/i0-ui55七份/作者历史/证据原样接纳，79f9037及patch未接入。应用/生产UI/原lock相对7100ea6零改动；student/src Git tree为 `bd0c312b9e33dd00227cb97a04943a0dcfacb5ce`，与main一致。

固定runtime从原始Git blob归档，PAHER新目录 `/opt/xunjie-runner/tests/dla-pr67-fixed-f761dcd-20261014` 的767文件逐bytes/mode/hash校核一致；原Node24.21.0及原lock隔离依赖复用。teaching类型/构建、student类型/构建通过；组合最终68/68、网关3/3、PS长脚本/密文边界两组和四文件解析通过。缺Robert本机保留入口的完整maintenance/local-entry测试未执行；网关测试fixture原样留存，唯一清理步骤在本轮临时harness改为留存，原实现和断言未变。

失败保留：首次组合67/68，因student/dist构建前置尚未完成，构建后68/68；本人网关harness第一次用了Windows file URL，WSL import失败，改正确URL后3/3；首次“所有143个dist都HTTP200”校核有6项被已有static MIME契约拒绝，修正本人的错误期待后137个可服务文件逐HTTP byte/hash一致，6项JSON/许可证保持400/INVALID_REQUEST。JSON在Vite编译时已打进JS，不修改服务白名单。全merge空白检查有PR67三个原CRLF JSON共1471处既有失败，baseline/current位置逐字一致，本人写集差异空白通过；不格式化他人原证据、不称全仓空白通过。

公开证据：[核验清单](evidence/dla-pr67-integration-20261014/verification.json)、[固定接收](evidence/dla-pr67-integration-20261014/source-reception.json)、[最终HTTP](evidence/dla-pr67-integration-20261014/http-both-fixed-final.json)、[原对象校核](evidence/dla-pr67-integration-20261014/site-fixed-after.json)、[当前C/HDL节点](evidence/dla-pr67-integration-20261014/runtime-fixed-final.json)、[静态真实字节](evidence/dla-pr67-integration-20261014/served-ui-contract-byte-final.json)、[90秒原Session](evidence/dla-pr67-integration-20261014/existing-session-fixed-final.json)。旧失败和旧24表浏览器结果各保留原时点/来源，以上不是Robert Chrome验收。

## PAHER 当前入口

| 对象 | 实际状态与边界 |
| --- | --- |
| 3443 C-only入口 | `https://127.0.0.1:3443`；24表原持久库/对象不变，正式源码/UI固定f761dcd；unit `xunjie-i0-entry-pr56-f761dcd-20261014.service` |
| 已批准学生深链 | `https://127.0.0.1:3443/#/task/a2533386-4923-4dee-83bd-2d7a99fb06e9`；学生synthetic-i0-student-a，Activity/Attempt/确认snapshot/run引用与原对象一致 |
| 3444 HDL入口 | `https://127.0.0.1:3444`；原35表库/对象不变，应用/UI也对齐相同固定副本；unit `xunjie-dla-ui-f761dcd-20261014.service`。不把35表搬到3443或改旧Assignment/Attempt ID |
| HTTP健康/静态 | 两端各live/ready/root严格TLS200；与换版前旧9fa宿主ready503分别记账 |
| C1 / HDL readiness | 两者ready=true；原146内核/profile/images/sourceHash/validation/代际前后完全一致，没有节点升级、重新写validation、变更generation或H3部署 |
| 会话/时间 | 固定源3443正常登录后90秒87次GET Session全200，原bootstrap/Attempt可读，墙钟倒退0；Windows W32Time Running/Manual，LastSyncError2仍保留，没有本轮校时或冻结环境维护 |
| 模型/身份 | 预算关闭，真实模型请求0；只用原批准指定学生，口令/Cookie/CSRF不写公共材料。未发学生保存/运行/提交，没有Agent代做真人学习 |

原3443旧9fa源码/配置/静态目录与原35表旧宿主副本都保留。当前两个单位使用原配置/TLS/签名/SSH/代际/库引用，仅正常进程的staticDirectory指向已验证正式dist；没有修改秘密/受控配置文件、系统信任、schema或CI。

停止：

```powershell
wsl -d Ubuntu -u root -- systemctl stop xunjie-i0-entry-pr56-f761dcd-20261014.service
wsl -d Ubuntu -u root -- systemctl stop xunjie-dla-ui-f761dcd-20261014.service
```

回退时只停本人的当前unit，按原保留argv启动前一版应用；24/35表/原记录保持，不自动重新运行Job/模型。前一版3443准备宿主serve-i0 argv、原9fa恢复argv与3444上一版argv均在本人记录/原证据；原9fa若回退其ready503事实不能改贴通过。没有自动开机或长期在线保证。

## Robert/UI 领取正式产物与开始项

既有路线仍是Robert本机127.0.0.1:14443 SSH转发→PAHER127.0.0.1:3443，本机HTTPS gateway的origin固定3443，主机公钥/公共叶子pin/CurrentUser信任沿PR67已有准确批准，不改它们。PAHER SSH当前Running/192.168.3.15；本轮不能从PAHER代验Robert的本机gateway静态选择或Chrome。Robert应将本机gateway切到下列正式ZIP，而不是旧40db96c加79f9037候选；这属于其已有本机工具staticDirectory切换范围。

固定student ZIP在PAHER Windows可通过既有维护SFTP领取：

```powershell
pwsh -NoProfile -File tools/i0-ui55/maintenance.ps1 sftp-get -RemotePath '/C:/Users/p3148/XunJie_DLA_PR67_Handoff_20261014/student-f761dcd-dist.zip' -LocalPath 'student-f761dcd-dist.zip'
pwsh -NoProfile -File tools/i0-ui55/maintenance.ps1 sftp-get -RemotePath '/C:/Users/p3148/XunJie_DLA_PR67_Handoff_20261014/student-dist-manifest.json' -LocalPath 'student-f761dcd-dist-manifest.json'
```

ZIP共143文件；SHA256 `42e84956eccda63bc2ebc69eb8bf27af572b235749591e90ebd2a15255d507d0`；[逐文件清单](evidence/dla-pr67-integration-20261014/student-dist-manifest.json)。本机工具拒绝覆盖，若同名已存在应选新的合法本机文件名；不要覆盖旧候选包或绕过ACL/产物校核。C zip逐文件与PAHER正在服务的正式dist同源，包含旧API之外的最新main正式登录/保存/运行UI，没有秘密、数据库或临时候选。

合成身份仍只领取 `synthetic-i0-student-a`，用PR67已批准的 `seal-student-credential.ps1` + 原 `Get-XunJieStudentCredential` / 原PAHER root-only reader，RSA-OAEP-SHA256临时接收通道仅在进程内存解密；不要公开密码、不传私钥、不自动登录或重置。其他账号/库授权本批不扩大。

浏览器可以开始正式界面登录/刷新/退出、原作品/快照/保存、Run/Stop/历史及已有公开产物的复验。具体学生点击和展示回执由Robert/UI发起；本轮服务端没有新增学生文件/运行/提交。正向产物下载要使用课程实际已具备的公开结果，不把missing/redacted/incomplete补成存在。3444 HDL的同浏览器界面接线与H3目标节点验收仍按原分工后置，不能因工具接纳勾UI-REAL全12项/G0～G4或教学效果。

产品/MVP§10待授权维护者汇总。C本批交接为源码接纳、服务端组合及正式运行材料就绪；Robert本机ZIP/staticDirectory同步与实际Chrome结果仍待其本人回交。

## 最新 HDL 接线顺序

2026-10-14负责人已明确把真实HDL UI接线改为当前立即推进项，先审查/合并PR56，随后沿UI本人 [PR68操作表](https://github.com/paher-din/XunJie/blob/805c76a6f230cb7f6a64bc94abf8adfa2616e955/docs/tasks/I0-UI30_HDL_OPERATION_MAP.md)的UDL-01～08实施。上文“3444 HDL同浏览器界面接线后置”仅为此前交接状态，不再作为等待H3的依据；H3教师绑定/course_check/新节点和完整测试继续后置。最新准确任务与回执见 [审查合并记录](DLA_PR56_REVIEW_MERGE_UI_20261014.md)，具体请求/当前性/浏览器链见 [H4包§5](DLA_H4_UI_HANDOFF_20261014.md#5-最新负责人顺序与-ui-立即接线批次)。

UI PR68已回交3443正式C浏览器增量，保留原24表/独立通过数，不能迁移算HDL通过。原3444环境/学生B分配、同源SSH与账号通道的准确差异及新现场模型轮次由UI/C/B按上述包协调；主线合并不消耗新模型请求，不改变原账号/密钥/库/节点。

合并后更新：#56 merge b03b1b4，含A5/后续UI69的固定main87edd51已组合补验；3444切至 `xunjie-dla-ui-main-87edd51-20261014.service` 与其新143文件dist，原35表/对象/节点保留。3443仍此包f761dcd/24表，旧ZIP不可冒充87edd51。最新运行、正式ZIP `student-87edd51-dist.zip`、SFTP/摘要、停止/回退及原UI交接回执统一见 [执行记录§6](DLA_PR56_REVIEW_MERGE_UI_20261014.md#6-合并与ui回交)。上述历史获准A通道与新HDL/B通道的差异仍保留，不因换版自动领取别的账号。

再后续A/C实际接纳已把3443原24表也更新到87edd51正常宿主/正式143文件，unit `xunjie-i0-entry-main-87edd51-20261014.service`；10Run/v8/库/秘密/代际/节点保持。上段“3443仍f761dcd”保留其旧时点，准确来源/公开验证和停止责任见 [最新状态§6.4](DLA_PR56_REVIEW_MERGE_UI_20261014.md#64-后续当前状态与文档主线收口)。H-05独立PR73尚未部署，本轮只收未合入main的文档/证据，不改两个宿主。
