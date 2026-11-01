# 混合部署与业务恢复接管

对应 [#154](https://github.com/paher-din/XunJie/issues/154)，方案与测试边界见[实施方案](specs/wp02-hybrid-deployment.md)。同机多进程与旧 WP01 证据不代替本票实际跨机验收。

当前固定工程验收基点为 `29398b3`，产品修复基点为 `37122b4`，连接夹具清理修复为 `5c5a4ac`。本机原生业务、完整包 CLI 与桌面 Chrome 定向检查通过，固定基点的 Linux 完整 CI 通过；Windows 全量仍有 4 项失败。按负责人最新要求，真实跨机部署、断网恢复与 SSH fencing/接管统一纳入 [#155](https://github.com/paher-din/XunJie/issues/155) 的 Mac 工作，由 Apple Silicon Mac 客户端连接独立学校 Linux 主机执行并回填 #154；Windows 本轮不再单独等待跨机入口。2026-11-01 已在 Apple Silicon Mac 上执行该组跨机与 Mac 项，结果见文末[Apple Silicon Mac 跨机验收](#apple-silicon-mac-跨机验收)；Windows 分机项仍待执行。

## 部署绑定

个人本机和学校共享沿用正式产品页及现有 owner。混合组合使用学校的身份、成员和课程，本机安装客户端持有学习数据。本机主动经 WP01 认证连接访问学校，学校连接凭据逐次核验本人及课程资格；学校不需要访问学生私网端口。SSH 仅用于部署维护，不转发学生产品流量。

1. 用完整产品包安装、启动客户端。`xunjie status --root <客户端root>` 的 environment 中找到 `unit=learning-data`，记录其 environmentId/serviceId，组成 `{environmentId,serviceId,version:1}`。
2. 在学校执行 `xunjie school-member --root <学校root> --file <私密成员JSON>`。输入为 requestId/loginName/password，加上述 `target`；省略 target 保持学校共享默认行为。绑定只允许首次登记或同值幂等核对，不支持改 URL 为既有作品另选所有者；已有共享成员须通过正式迁移改变部署。
3. 学校执行 `xunjie authorize --file <源身份JSON> --out <新私密授权文件>`，源 environmentId/serviceId 必须是客户端实际 learning-data owner，capabilities 为 `["learning.authority"]`。学校须在线且已装配真实模块，传输授权不替代学校成员或课程授权。
4. 客户端执行 `xunjie connect --file <私密连接JSON>`。target 使用学校实际运行入口 `services[0]` 描述，requiredCapabilities 必须包括 learning.authority，不能降为 optional。文件包含 token，只留私有目录，不能进入公开描述或日志。
5. 客户端正常连接学校入口，学校页面登录批准后完成连接。维护者执行 `xunjie learning-binding --root <客户端root> --file <绑定JSON>`，输入 `{connectionId,runtimeConnectionId,target}` 分别对应学校成员连接、WP01 连接及第一步的目标。这是管理员入口，不是学生选择数据库/节点的设置。

课程读取仍沿原学校服务，课程活动 prepare/confirm/authorize 保留原主体、请求、发布版本及资源依据；活动和作品进入本机唯一 owner。每次操作核对实际成员绑定、运行连接环境/服务/版本；工作区还核对预期主体与客户端恢复命名空间。失联、维护、撤销和身份/版本不符在原范围报错，保留浏览器内容，不另建共享或个人副本。

整合 #152 后，学校课程引用通过 `verifyReference` 在课程 owner 核验当前资格、固定来源、选区及选中文字摘要，仅返回确认结果。较大材料的短引用不再要求整份原文穿过 capability 响应；复制文本仍随本机草稿保存，伪造副本、拆分代理对或 CRLF 的范围明确拒绝。作品来源继续逐字符串核对选区原文。

## 维护与备份

每个完整安装的 runtime、space-course、learning-data 均是必要参与者。关闭新业务接收与派发，排空 HTTP 和已接收领域 capability，验证全部 owner 后导出数据库与已发布资源清单。参与者缺失、资源缺项或关闸失败使完整备份失败，不能忽略业务后继续。

单安装备份只覆盖它持有的权威数据。混合环境应先让学校保持 held 关闭边界，再让本机保持 held 边界，分别取得完整备份；登记两者 backupId、boundaryAt、owner/schema/资源摘要及共同关闭区间，不把两份在线快照称为分布式原子备份。备份目录独立于运行数据和资源根，密钥另行私有保管，公开 manifest 不含密码或连接 token。

产品备份**不包含浏览器未同步内容**。旧浏览器库和队列保留在旧 namespace，不自动迁移/重放。需要取回时保留旧页面，导出原文及原请求身份，先核实主体、目标与原请求回执，再显式处理竞争或续接原操作；不能换新请求掩盖未知结果。本票没有自动导入旧浏览器队列的入口。

## 独立恢复与远端接管

用原 restore/upgrade 私密输入从实际备份恢复到独立空 root。目标默认 isolated，保留原业务身份及活动/对象/内容/请求，生成新 installation、凭据与 client namespace。先验证原课程、材料、作品与回执，再按 WP01 机制退休源并 fence 全部 receiver；缺证明或接收方失败时保持隔离。失败保留源、原备份和现场，不能只换旧 binary 当回滚。

同机 receiver 保持 `{id,root}`；远端学校使用正式 takeover 的 SSH 适配：

```json
{
  "sourceRoot": "<本机仍在线的源root>",
  "receivers": [{
    "id": "<学校environmentId>/<学校运行serviceId>",
    "ssh": {
      "configFile": "<本机已有部署SSH配置的绝对路径>",
      "host": "approved-school-alias",
      "nodePath": "/opt/xunjie/resources/node/bin/node",
      "cliPath": "/opt/xunjie/app/cli.js",
      "root": "/srv/xunjie/school"
    }
  }]
}
```

适配器使用既有 SSH 配置与严格主机核验、禁止 agent 转发，不接受新主机身份或索取/打印密钥。远端完整包的 fence-source CLI 通过 stdin 接收无秘密源 service 清单，先核对 receiver 身份，再调用同一 WP01 私有控制 API；非零退出、超时、错身份或不完整结果不能确认接管。首个远端学校支持目标仍是 WP01 的 Ubuntu 24.04 x64 组合；Windows/Mac 是客户端。旧包没有此 CLI 时须先明确更新部署包，不能忽略失败。

接管后，接收方重新 authorize，目标用 set-credential 写回保留连接的原 credentialRef；不能重复 connect 同一 connectionId。学校页面重新批准新成员连接，再执行 learning-binding。学校数据库恢复后旧 cookie/连接凭据也失效，须重新登录授权。恢复活动可读不表示旧浏览器队列已导入。

#154 本身没有新增 schema 迁移；当前整合版已包含 #152 的学习数据 v4，问题、固定引用副本、草稿当前/历史修订及原请求回执均纳入恢复验证。正式 CLI 没有另行登记的 schema 升级适配时仍应到达 no-schema-upgrade-registered 校验，不能据此宣称不存在 v4。#153 尚未交付的状态不创建占位成功。

## 验证记录

首轮验收：2026-10-31 Windows 11 x64（build 26200）、Node 24.21.0、PG 18.6、桌面 Chrome 156.0.8078.76，有头执行。产品实现提交 `f1eb009504a400bad3184f900e6cea3a8a8487db`；截至 `4565019` 只补充并发测试和证据，未改产品代码。后续产品修复另见下文。见[工程/包/恢复记录](evidence/wp02-hybrid-windows-engineering.json)、[三条 Chrome 路径](evidence/wp02-hybrid-windows-chrome.json)、[个人截图](evidence/wp02-hybrid-windows-personal.png)、[学校共享截图](evidence/wp02-hybrid-windows-school-shared.png)、[混合截图](evidence/wp02-hybrid-windows-hybrid-local-owner.png)。实际截图已目视检查。

- 全仓 typecheck、build、8 个公共契约浏览器导出检查通过。本次相关文档链接检查通过。
- 混合原生与完整包 CLI 两项 **2/2 通过，0 跳过**。CLI 又补验连续作品写入与新课程资源发布并发于 held 备份；两侧生产者均先有真实提交，关闭后明确拒绝继续写入，独立恢复读取边界内最新作品、新材料及原回执，补验 **1/1 通过**，不重复计算为新增独立流程。
- 新 Chrome 三条部署路径 **3/3 通过**；原编辑器/目录恢复等回归 **15/15 通过**，见[逐项记录](evidence/wp02-hybrid-windows-editor-regression.json)。它们都是同机原生产品进程，不能作为实际跨机证明。
- SSH 外部进程边界两项通过，明确 mock SSH 进程，仅验证适配和错身份拒绝。真实远端 CLI/SSH 尚未执行。
- 全量 npm test **整体未通过，5 项失败**：product-runtime 117 通过/2 失败/5 跳过；storage 12/1/1；server 640/2/19；Web 58 文件/688 项通过；checks 27 通过/1 跳过。失败为独立进程 fencing 超时、三项 Windows 符号链接 EPERM 和旧 LOCAL_SOCKET_CONFLICT。末尾 tools 组未到达。聚焦 IO/连接另测为 47 通过/2 失败/2 跳过，其中一项为断连夹具清理 ENOTEMPTY，一项为冷进程 fencing 超时；不把这些检查记为绿色。
- Standards / Spec 两轴最终代码复审无剩余发现。真实跨机和 Mac 仍未执行，#154 暂不能标为完整验收通过。

后续补验：提交 `4565019` 的 [GitHub CI](https://github.com/paher-din/XunJie/actions/runs/41186025564) 已完成。实际日志确认 Ubuntu 上 typecheck、build、公共契约浏览器检查、文档检查和全量 test 五阶段均通过，另有一项 HDL 节点账本检查通过；不代替 Windows、原生 PG、Chrome 或真实跨机结论。Windows 单独复现了独立进程 fencing 用例的 3 秒预算耗尽，随后仅把该持久化用例的 Windows 预算调为 30 秒，产品期限和专门的超时拒绝测试不变；两项复验 2/2 通过，0 跳过，Standards / Spec 复审无新增发现。原全量测试的 5 项失败仍保留为当轮结果，不将局部补验记成全量转绿。

PR #157 已补齐标题、实现及验收说明，保持 OPEN、未合并；[#155](https://github.com/paher-din/XunJie/issues/155) 已登记本票 24 项未勾选的 Mac 工作，并保留此前 67 项完成记录。成员登记在线刷新后仍只有 file:publish、file:read、page 权限。[当前团队交接](../references/2026-10-24-team-development-handoff.md#负责人备份与恢复)指向负责人 Mac 私有目录中的管理配置；[运行验收](runtime-acceptance.md)及[维护验收](maintenance-acceptance.md)明确此前临时学校部署、凭据和 TCP38195/38196 放行已清理。文档提供了主机线索，但没有本机可复用的部署授权，不能据旧验收结果推定当前 WP02 跨机环境可用。

### 整合 #152 后的复验

见[工程补验记录](evidence/wp02-hybrid-windows-engineering.json)的 `followUpAcceptance` 和[整合 Chrome 记录](evidence/wp02-hybrid-windows-integrated-chrome.json)，各轮来源与重复用例分别标注。

- 大材料短引用先通过真实混合 HTTP 复现 503，再修复为课程 owner 内的有界选区核验。课程/草稿、学校代理、混合归属及恢复共 **11/11、0 跳过**；校验超过 1 MiB 文本的短选区、伪造副本和拆分 emoji/CRLF 的拒绝，以及恢复后的当前/历史草稿、原草稿回执和旧 namespace 拒绝。
- 全仓类型检查、构建与 **9** 个浏览器安全契约导出通过。同伴最后的草稿就绪修正另做 Web 类型检查。最终完整 Windows 包 SHA-256 为 `5b6b07bc31c11a3df00dd88c83d9996c88a832c379c76f72235541175fd1c728`，正式 CLI 恢复再次 **1/1** 通过，不累计成另一独立场景。
- 桌面 Chrome **26/26**（部署 3、草稿 8、作品 15）；草稿 8 项含 2 项公开接口补充回归。同伴就绪修正后，最终 `37122b4` 的部署/草稿 **11/11** 补验通过，不另算 11 个新场景。已目视检查[个人](evidence/wp02-hybrid-windows-integrated-personal.png)、[学校共享](evidence/wp02-hybrid-windows-integrated-school-shared.png)、[本机 owner](evidence/wp02-hybrid-windows-integrated-hybrid-local-owner.png)三张最终截图。
- `37122b4` 的 Windows 全量 npm test 仍失败 **4** 项：product-runtime **118/1/5**、storage **12/1/1**、server **640/2/19**（通过/失败/跳过），Web **688** 项通过，checks **27** 通过/1 跳过。独立进程 fencing 已通过；剩余三项为 Windows symlink EPERM，一项为旧 account-control 的 LOCAL_SOCKET_CONFLICT。末尾 tools 未到达。
- 同提交的 CI 类型、构建、契约和文档阶段通过，测试阶段唯一失败为断连夹具删目录的 ENOTEMPTY。已核对原始日志附件摘要；`5c5a4ac` 令夹具先关闭 HTTP、等待已接收请求结束再删目录，未弱化断连或超时断言。本机连接协议整组 **31/31、0 跳过**，两轴复审无新增发现。
- `5c5a4ac` 的后续 Linux CI 中，产品运行组 **122/0/2**、存储 **14/0/0**、后端 **658/0/12**、Web **688**、checks **28** 通过；工具组 **294/10/1**，10 项均来自同一 before hook 的公共契约导出加载失败，Python 阶段未到达。源码与现有产物均有该导出，而多份真实 CLI 测试会重建同一 checkout 的 contracts/dist，证据支持读写竞争，但未直接捕获中间字节。`29398b3` 将工具组按文件串行、其他组仍并行 4，文件内并发断言不变。
- 固定 `29398b3` 的 [Linux 完整 CI #26](https://github.com/paher-din/XunJie/actions/runs/41215137258) 已通过：Ubuntu 24.04、Node 24.21.0，类型、构建、9 个浏览器公共契约与文档检查通过；checks **28/0/0**、product-runtime **122/0/2**、storage **14/0/0**、server **658/0/12**、tools Node **304/0/1**（通过/失败/跳过），Web **688**、Python **34** 通过，另有 HDL ledger 检查通过。15 项跳过仍为跳过，不作为 Windows 专属、真实模型/执行或跨机证明。原始日志附件 SHA-256 为 `63b8392a0faa7e9d80325b623ccc6bd3b1a93a728ec9ac5c43d87c0fff8ba21a`；工程 JSON 的调度修复待验状态保留其提交时点，实际后续结果以本轮固定 SHA 和 CI 链接核对。

另行补跑旧工具组时修复了本机缺失依赖和 OpenSSL 路径；最终 Node **265/25/15**（通过/失败/跳过），Python 未到达，失败涉及 Git tar 路径优先级、Windows 链接/socket 约束与部分 CLI 超时。该长运行期间分支有并行更新，仅作诊断，不作为固定提交的整体通过证据。Linux CI、Windows 全量、定向原生、Chrome、真实跨机和教学效果分别报告。

此前 WP01 学校主机为 101.201.141.133，现有受管配置可核对主机 pin，但本机凭据对部署用户 xunjie-admin 返回 Permission denied (publickey)。普通成员页面/文件权限不能替代部署权限，未修改现行共享服务。真实跨机所需的获准部署配置和测试目录由 #155 执行时核实；#155 的 24 项 #154 清单已经包含 Mac → 学校 Linux 的业务、故障和分机维护接管要求，本轮不增加重复清单、不将其勾选为通过。教学效果未评估。

### Apple Silicon Mac 跨机验收

2026-11-01 在 Apple Silicon Mac（macOS 27.2、Apple M5、arm64、Node 24.21.0、PG 18.6、本机安装的 Google Chrome 156.0.8078.79）连接独立学校 Ubuntu 24.04.5 x64 主机（`101.201.141.133:38195`，HTTPS）执行。工程与打包见[工程记录](evidence/wp02-hybrid-mac-engineering.json)，跨机业务见[跨机记录](evidence/wp02-hybrid-mac-crosshost.json)，备份恢复见[备份恢复记录](evidence/wp02-hybrid-mac-backup-restore.json)，接管见[接管记录](evidence/wp02-hybrid-mac-takeover.json)，重签与重绑见[重绑记录](evidence/wp02-hybrid-mac-rebind.json)，同机 Chrome 回归见[Chrome 记录](evidence/wp02-hybrid-mac-chrome.json)。

- 全仓 typecheck / build 通过，9 个浏览器安全契约导出通过，文档链接 1214 个目标 0 失败；`package:product` 同时产出 darwin-arm64 与 linux-x64 full 包，两者 `resourceCatalogSha256` 均为 `9d64fbd2…`。
- 原生混合与完整包 CLI 两项 **2/2 通过、0 跳过**（覆盖 1.1MB 大材料短选区、伪造副本/拆分代理对/CRLF 拒绝、课程固定版本、绑定降级 403）；`XUNJIE_PRODUCT_TEST_PACKAGE` 下正式 CLI 备份/隔离恢复 **1/1 通过**，其中草稿当前修订、历史修订与原回执随恢复返回。
- 真实跨机连接与三条业务路径：连接批准 `fa771234-…`；混合（本机 owner）`0b5fae23-…`、学校共享 `fcecf53a-…`、个人 `3cf88222-…` 各**全部通过**，均含私有材料 404 与关闭重开一致。撤销学校安全组放行造成真实断网后设备拒绝读取（503）并保留浏览器原文，恢复放行后原活动与正文完好、无第二份作品。课程资格撤销后 release/作品/活动均 403，恢复资格后原作品返回且 objectId、revision 不变。
- held 备份：学校 `db127ec3-…`（boundaryAt 06:03:42.524Z，3 个 owner、10 个工件）先关，本机 `36f28f9d-…`（06:03:46.685Z，11 个工件，receiver 记录学校 client）后关，共同关闭区间 06:03:46.685Z–06:07:12.042Z。两份分别取证，不称为分布式原子备份。
- 独立空目标恢复生成新 installation `1016c6d0-…` 与新 client namespace `….recovery.e2260755-…`，隔离阶段公开业务 503；逐项核对恢复后的成员/绑定、5 个资源文件字节一致、活动与作品（revision 2、同一 objectId）及回执与 held 边界完全相同。
- 失败场景：真实安装上移除 learning-data owner 的存储凭据后运行库拒绝启动（`Storage operation failed: forbidden`）、无法取得完整备份且数据保留，放回凭据后复验 200；把 held 备份的一名工件改坏后恢复以 `invalid-recovery` 拒绝、目标 0 条目，原备份 11 个工件摘要全部完好。
- 远端接管：缺 receiver 报 `missing-receiver`、接收方 SSH 不可达报 `receiver-unavailable`，两次均保持 isolated；源退休后 `maintenance-resume` 与 `start` 均报 `source-retired`，旧端口读取写入 503。正式接管返回 `phase=active`，学校经完整包 `fence-source` 对 `dd66e818…`、`fdf0a85f…`、`42431de5…` 全部 fence；fence 后旧 grant `c9b84a0e…` 在学校返回 403，旧 connectionId 在新安装返回 403。
- 接管后按 WP01 机制重签：学校重新 `authorize`（新 grant `8bf9ea1e-…`，`learning.authority`）、目标 `set-credential` 写回原 `credentialRef`（`saved:true`，未重复 connect 同一 connectionId）、学校页重新批准新成员连接 `00797b17-…`、管理员 `learning-binding` 成功；新安装在正式编辑器读回课程与材料并在「重新开始活动」后写入成功（revision 4）。旧浏览器队列未重放。
- 同机 Chrome 回归以 `XUNJIE_E2E_BROWSER_CHANNEL=chrome` 运行 `hybridDeployment` 与 `worksEditor`：**18/18 通过、0 失败**（部署 3 条 + 编辑器 15 项），浏览器为安装版 Chrome 156.0.8078.79、有头执行。
- macOS 中文输入与界面状态已按 OS 物理键盘级路径取证：自建注入器把按键投递到系统 HID tap，经 TIS 选中的系统中文输入法（豆包拼音，`TISSelectInputSource` status=0）组合上屏四段词（`kaishi`→开始、`nihao`→你好、`shijie`→世界、`jieshu`→结束）。判别依据是该组合期间每个字母键的 keydown 都是 `keyCode=229`（`VK_PROCESSKEY`）、`compositionupdate` 逐字母增长（`k`→`ka`→`kai`→`kai's`→`kai'shi`→开始），而 CDP 的 `Input.imeSetComposition` 一次提交整串、不会产生这种增量。真实 `Cmd+V` 粘贴保留换行（页面 `paste` 事件 `isTrusted=true`，内容取自系统剪贴板），`Cmd+←/→` 到行首/行尾后正文不变，最终正文精确为 `开始你好世界\n粘贴中文\n结束`。每次注入前复核窗口与编辑器焦点均在前台（`activeTag=TEXTAREA`）；`Finder` 前置未夺走 Chrome 焦点，故“失焦段”实际未发生，只验证了复位后的焦点状态。见[物理键盘级输入记录](evidence/wp02-hybrid-mac-physical-ime.json)及[浅色](evidence/wp02-hybrid-mac-physical-ime-light.png)、[深色](evidence/wp02-hybrid-mac-physical-ime-dark.png)截图；同日先跑的 CDP 组合协议一组（[wp02-hybrid-mac-ime.json](evidence/wp02-hybrid-mac-ime.json)）作为浏览器侧对照保留。
- 全量 `npm test` **通过（exit 0）**：checks **28/0/0**、product-runtime **122/0/2**、storage **14/0/0**、server **643/0/16**、Web **688**（58 文件）、tools Node **304/0/1**，另 Python **34** 通过（通过/失败/跳过）。19 项跳过仍为跳过：真模型/真 HDL/真 C1 SSH 外部提供方门禁、Windows 专属路径、node-local 合成检查，不作为真实模型或跨机证明。
- 验收结束已撤销安全组临时放行的 38195 两条规则（客户端真实出口 `101.94.133.245/32`、学校回环 `101.201.141.133/32`），核对 ingress 恢复原有 3 条（8443、22、ICMP），外部 HTTPS 38195 已不可达；学校 `/home/xunjie-admin/xj154`（385M，含产品包、root、备份、密钥、输入）已删除，学校守护进程与测试 PG 已停止，本机两侧运行库已停止。

### Windows 11 设备侧跨机验收（2026-11-01 补做）

2026-11-01 在 Windows 11 家庭版 26200（Intel Core Ultra 9 285H、AMD64、产品包内置 Node 24.21.0 与 PostgreSQL 18.6、已安装 Google Chrome 156.0.8078.79 有头执行）上，用完整 win32-x64 产品包（`pkg-win.tgz`，86,783,792 字节，`sha256 d425ee21…`，本机与 Windows 主机字节数一致）作为设备侧，通过公网 HTTPS 连接独立学校 Ubuntu 24.04.5 x64 主机（Node 24.21.0、PostgreSQL 18.6、`school` profile）。取证见[Windows 跨机记录](evidence/wp02-hybrid-win-crosshost.json)。

- 拓扑为真实跨机：设备侧自带 PostgreSQL 与文件资源、三个 owner 齐全；学校主机独立进程与数据库。未使用 SSH 隧道、端口转发、同进程 HTTP 或改地址冒充直连，学校也不访问设备私网端口。
- 学校主机原计划 38195，实测当前网络出站只放行 8443，其余端口约 5000ms 后被 RST；因此把学校产品改绑 8443（同一 `environmentId dd2d1e89…`、`serviceId d14ac21d…`，仅端口与 endpoint 变化）。这是环境约束，不是产品配置放宽。
- `connect` 首轮以 `invalid_value path ["target","unit"]` 被拒：`connection.target` 必须是完整 `runtimeServiceSchema`。按学校 `environment.json` 的 `services[0]`（`unit=client`）补全后 `registered:true`，`learning-binding` 返回 `configured:true`，混合空间键为 `school:36889f61-…`，绑定主体 `principalId 7606ad1f…`、`spaceId bd9b37ba…`。
- 三条业务路径全部通过：个人 `07972a52-…`、学校共享 `3e53266a-…`、学校主体 + 本机 owner `386fa6bd-…`。三者均读到固定发布版本（页面显示 `固定版本 23b6d05e` 与依据摘要 `f7847b8593e6`，与课程登记一致）、写入中文作品后自动保存为预期原文、关闭并重新加载后回到同一 `activity` 且仅一个文件。公开材料同一 API 路径 200，私有材料 404，页面中私有材料按钮计数为 0。
- 学校共享路径需要**未绑定设备 target** 的学校成员（learning data 留在学校主机）。把绑定到设备 target 的混合成员用于纯学校网页时，`activities` 与 `course-activity-results` 按设计返回 403；本轮另建成员 `win154-shared-d44de070` 并单独授予课程资格后 8 项全通过。这是身份与 owner 语义正确的表现，不是缺陷。
- 真实断连与恢复：用产品 `stop` 停掉学校守护进程（8443 关闭、TCP 拒绝）后，设备侧混合空间读取返回 503 明确拒绝、未静默转存个人空间、未新建第二份作品，页面仍停在该混合空间；恢复后原绑定与原请求继续，读回同一活动、单文件、原文一致，活动列表中该活动仅出现 1 次。
- 资格与连接撤销：撤销课程资格后混合空间读取与新建课程活动均 403 `forbidden`，个人自主活动仍 200；重新授予后回到同一活动与同一份作品。撤销客户端连接（学校 `manage/connection`）后混合空间读取 403、个人自主活动 200，设备页恢复「个人学习空间」与「连接学校提供的入口」，原学校连接入口不可用。
- 限制：本轮只补 Windows 设备侧的跨机业务与撤权/断连；双侧 held 备份、独立恢复与 SSH fencing 接管仍以 macOS 侧证据为准，未在 Windows 侧重做；未验证 Windows 物理键盘级中文输入法（页面输入为脚本文本输入）；不产生教学效果结论。
