# I0-B-03：固定代码与精确选区求助

**What to build:** 学生核对已确认文件/快照和精确选区后提问；发送后继续编辑时，回答仍保留原对象版本，旧提示不定位到新正文或同名新实例。

**Blocked by:** [I0-B-02 求助与停止](I0-B-02_HELP_STOP_REPLACE.md)；完整回答归属/展示依赖D-01获准关联来源。D-05最小选择/定位方案已定稿，由本票实现，不再待Robert确认；不依赖04或真实运行节点，不受缺口影响的引用构造可先准备。

**Status:** implemented / engineering-verified（D-01原关联投影、页面消费和实际HTTPS代码求助已验；原快照/选区及改稿后提示结果见批次§11）。

2026-10-14较新收尾：[D-01](I0-B-01A_EVENT_PROJECTION.md)已交首次获准正文的原Action关联，客户端严格核scope/代际/Job/Message/固定版本/basis；代码与选区显示原快照、文件版本和UTF-16行列，本机后续改稿明确标仍依据原快照，同名新实例不承接旧来源。实际HTTPS保存/冻结→显式代码求助→原文件/快照来源与历史通过，不自动保存、重跑或定位新草稿。78项来源校验及对应浏览器结果包含在[批次§11](I0-B_UI_TUTOR_PLAN.md#11-授权后实施与验证记录)，后文D-01未交是历史状态，完整真人/语义验收未执行。

日期：2026-10-13（Asia/Shanghai）。主责：UI / Robert。父任务：[I0 #30](https://github.com/paher-din/XunJie/issues/30)。依据：[规格](I0-B_UI_TUTOR_SPEC.md)、[计划/D-01/D-05](I0-B_UI_TUTOR_PLAN.md)。覆盖 UI-TUTOR-02，M-03/M-04，AC-02/04/06/15、NFR-04/05。

## Acceptance criteria

- [ ] 复用现有文件/编辑器和求助输入槽，只读取得所选文件实例与范围；学生发送前可核对或更正，不靠路径/taskId/editor version构造正式身份。
- [ ] 使用已确认且回取核验的原快照清单/正文/hash，ObjectRef带确切attempt/snapshot/file/path/documentVersion/contentHash；选区绑定该版本。
- [ ] 草稿不同于快照时明确差异，不自动保存/冻结，不把当前草稿贴到旧快照；学生先自主确认再重选，或明确询问可核对的旧版本。
- [ ] 原显示选区经既有原文本映射转为一基 UTF-16 行列，起含终不含。BOM/CRLF/裸 CR/非 BMP/行尾覆盖；不可表达边界保持不可用，不修改原文来凑坐标。
- [ ] 代码求助复用02原命令/幂等/状态与01消息回执，不把完整本机记录或额外教学 versions 放进 help 正文。
- [ ] Action↔原 Job/ObjectRef/版本来自 D-01 已交获准公共来源；缺关联时不猜、不在编辑器锚定、不宣称已验证对应回答。fixture 不补真实payload没有的字段。
- [ ] 发送后编辑、切文件、同名重建、回收、切账号/Attempt、新epoch/代际后到达的结果，不定位到新对象；可保留已显示的原历史并表达过时，当前定位以原版本核验为前提。
- [ ] 快照/对象不可见、缺项、hash/版本不匹配时禁止该对象引用并显示原因；私有资料或另一尝试不混入前端payload，真实拒绝仅在服务端联调后记通过。
- [ ] 从正常文件/选区操作到发送、回答来源、继续编辑及过时定位的浏览器链可回放；代码/文件/运行无Agent代操作。
- [ ] 本票typecheck、相关Vitest/build/真实浏览器专项通过；D-01未落实时保留完整链未通过，不以纯坐标单测或合成请求替代。

## Testing Decisions

主接缝为真实Monaco选区→原快照引用→原help/事件→实际消息来源与定位。复用原文本保真及保存/快照测试能力，增加混合EOL/非BMP选择和发送后修改的最少反例，不重新造编辑器。

只有D-01交清的真实公开形状才能用于成功投递样例。此前可以验证引用构造、发送和缺关联拒绝，但不得勾完整接入成功。

## 交付与未完成

写集按计划03；服务端ObjectRef/范围契约和原文本权威保持不变。完整回答关联仍受D-01及02阻塞；真实浏览器服务端联调按I0-A身份/确认作品交接进入，不需要先新增真实模型调用来验坐标和回执。

## 2026-10-13 独立切片授权与依据

Robert明确指定在既有03工作树、`codex/i0-b-03-code`分支实现独立对象构造与当前编辑器只读选区/定位适配，并仅提交本人写集。开工工作区干净。可写：`apps/student/src/workspace/tutoringObject.ts`及必要同名单测、`CodeEditorHost.tsx`、`CodeWorkspace.tsx`、`useProjectWorkspace.ts`与本文。浏览器发送入口尚未接入时先交接缝，不写不能运行的成功链。主Agent独占页面、HTTP、存储、辅导UI及fixture；后台、产品/规划/参考基线、AGENTS、package/lock/DB/CI均只读，不安装依赖。

已读README/AGENTS；PRD §3、§4.2、§5/8（PRD-03/04/05/09/10）；MVP M-03/M-04、§6 AC-02/04/06/15；TECH §4.1/7.3；I0-B SPEC、PLAN、03全票；I0-A SPEC及客户端约束§1～9；IMPORT_SOURCE的固定来源、许可与选择性同步规则；TEAM §1/2/2.1。源码核对既有originalText、SnapshotFile/verifySnapshot、ProjectFile服务实例映射及服务端rangeOffsets正文。

实施方案：复用快照正文与清单校验，固定核验后的文件引用；纯构造器只接受学生明确指定的文件或选区，逐字比较当前草稿、确认基线和固定快照。显示UTF-16 offset先映回原文，再按公共范围语义正反核验；不能无损往返时拒绝。编辑器只增读取/定位handle与可选回调，不改model身份、原文、撤销栈或保存路径。D-01缺失时禁止推断教学Action对应对象；独立引用能力不等于完整AC-04通过。

## 独立切片交付与主页面接缝

2026-10-13，实现文件：[tutoringObject](../../apps/student/src/workspace/tutoringObject.ts)、[同名单测](../../apps/student/src/workspace/tutoringObject.test.ts)、[CodeEditorHost](../../apps/student/src/components/workspace/CodeEditorHost.tsx)、[CodeWorkspace](../../apps/student/src/components/workspace/CodeWorkspace.tsx)、[useProjectWorkspace](../../apps/student/src/components/workspace/useProjectWorkspace.ts)及本文，共六文件。没有修改页面、HTTP、存储、辅导UI、fixture、服务端或受保护基线；没有安装依赖或变更DB/配置。来源沿原IMPORT_SOURCE路线，在主仓库适配，不回写Design仓库。

| API | 输入与结果 | 调用边界 |
| --- | --- | --- |
| `verifyCodeTarget(snapshot, context, serverFileId)` | context为workspaceKey/attemptId/activityVersionId；复制输入后复用verifySnapshot核完整清单、原文/hash、归属；返回冻结VerifiedCodeTarget或抛明确错误 | snapshot只能来自获准GET/已核验确认状态；此函数不请求网络、不保存、不冻结服务器快照。await后主页面仍须核loadEpoch/身份/代际/读取轮次 |
| `createCodeObjectRef({workspaceKey,target,draft,intent,selection})` | 纯函数；intent明确为file或selection；成功返回冻结objectRef，失败返回reason | target必须由核验函数产生。draft来自只读读取；selection意图要求非空精确选区，不无声改成整文件。wire仅发送objectRef，不能序列化整个本机读取结果 |
| `project.readCodeDraft(localFileId)` | 复制当前实例的workspaceKey、稳定本机fileId、serverFileId映射、path、生命周期、原text、confirmed原文/版本；未载入/旧工作区返回null | 不保护/上传草稿。核验目标用serverFileId；编辑器操作用稳定本机fileId，不能按path找同名替身 |
| `CodeWorkspace.editorHandleRef` | 可选React Ref，保留原focus/saveViewState，新增captureSelection及revealOriginalRange | 既有调用不必改变；主页面持有ref用于明确操作，不能自动发送 |
| `CodeWorkspace.onSelectionChange` | 可选回调，收到`{ok:true,selection}`或`{ok:false,reason}`；selection含workspaceKey、本机fileId、originalText及显示modelStart/modelEnd | 只是选择事实，不写学习记录。多选区、不可表达边界、不可用/离开文件明确拒绝；发送前重新捕获并核草稿 |
| `handle.revealOriginalRange({workspaceKey,fileId,originalText,range})` | 成功ok:true；当前model/工作区/实例/原文不符或范围无损回映失败时返回reason | 只定位当前已打开同实例，保留model/原文/撤销栈。它不验证公共Action归属、documentVersion或教学版本；主页面必须先核这些来源及当前draft/target，D-01未交付时不调用它定位回答 |

显示选区不直接采用Monaco行列；复用originalText投影，服务端LF分行、行尾CR裁列、一基UTF-16起含终不含，正反核验相同原文offset。BOM/混合EOL/裸CR/非BMP及空/末尾空行均有测试；代理项内部、越界、CRLF内部、隐藏BOM边界等拒绝定位。服务端rangeOffsets还裁掉末行尾CR，而既有serverPosition对该末尾处理不同；独立适配检测往返失败并拒绝，不修改原函数、服务端或正文迁就坐标。

主Agent在现有页面接线的最小步骤：

1. 页面保存`useRef<CodeEditorHandle>(null)`，传给现有CodeWorkspace的editorHandleRef；必要时通过onSelectionChange呈现当前选择状态。
2. 学生明确选择某快照和整个文件/当前选区。读取`project.readCodeDraft(localFileId)`；未确认实例、无映射、回收、脏草稿及不符版本分别呈现reason。不得自动save/snapshot；当前切片不支持把dirty当前选区贴到历史快照。
3. 对已明确选择的快照调用verifyCodeTarget，传当前workspaceKey、Attempt、activity及draft.serverFileId。await后重新核原上下文、loadEpoch、recoveryGeneration、读取轮次，并重新读取draft/捕获选区；不能使用await前旧React render中的project闭包作为当前状态。
4. 调用纯构造器；只把成功objectRef交给02已有help冻结/幂等命令路径，让学生在明确发送前核对path、确认版本与range；本机fileId/全文/显示offset/编辑器版本不混入wire。失败保持问题草稿，不产生求助/生成/运行。
5. 明确返回原位置时核原身份、公共对象版本与当前draft。只有来自D-01获准来源的Action/ObjectRef才能驱动回答定位；缺失时只保留来源不可核对说明，不用最近问题或arrival顺序补关联。

可参考以下页面组合片段；这是主Agent接线建议，不是已接入代码。变量`explicitSnapshot`和`intent`必须来自学生明确选择；`currentProject`必须是await之后当前读取的实例，`stillCurrent`包含原上下文/代际守卫。

```tsx
const editorHandleRef = useRef<CodeEditorHandle>(null)
// 在原CodeWorkspace位置增加可选ref，不改布局：
<CodeWorkspace ws={project} workspaceKey={scopeKey(draftScope)} editorHandleRef={editorHandleRef} />

const target = await verifyCodeTarget(explicitSnapshot, {
  workspaceKey, attemptId, activityVersionId,
}, explicitlySelectedServerFileId)
if (!stillCurrent()) return
const draft = currentProject.readCodeDraft(explicitlySelectedLocalFileId)
const captured = intent === 'selection' ? editorHandleRef.current?.captureSelection() : null
if (intent === 'selection' && !captured?.ok) {
  showReason(captured && !captured.ok ? captured.reason : '请重新选择代码。')
  return
}
const result = createCodeObjectRef({ workspaceKey, target, draft, intent,
  selection: captured?.ok ? captured.selection : null })
if (!result.ok) { showReason(result.reason); return }
// 交给02已有显式发送与冻结原命令路径，只传result.objectRef。
```

## 2026-10-13 验证、未完成与交接

在原批准依赖的junction环境，Node v24.15.0、Vitest v3.2.7、TypeScript v5.9.3；未安装/改lock，Node版本只记实际结果，不替代教学服务精确运行门禁。在apps/student执行：

```powershell
rtk npm test -- src/workspace/tutoringObject.test.ts src/lib/originalText.test.ts src/workspace/confirmation.test.ts
rtk npm run typecheck
```

实际结果：3个文件/62项单测通过（对象29、原文28、快照5），typecheck包含src及Node侧配置/e2e类型检查，退出码均0。完成只读读取旧工作区窗口守卫后重跑上述相关检查，仍通过。对象核验包含错误正文hash、跨Attempt/活动、缺文件、同名新实例、未确认/回收、dirty/确认版本不符及失效选区；通过只说明独立工程规则，不证明服务端授权或教学效果。

主Agent按授权统一跑Playwright和组合build；本工作树未运行build/浏览器、真实HTTP/模型/真人验证。尚未新增`e2e/tutoringCode.spec.ts`：当前既有页面未持有新handle，也没有03发送入口，写“发送→回答定位”成功测试会依赖未交付UI及D-01。主Agent接线后应新增可运行spec，核真实Monaco选择→公开help请求、dirty零写入、发送后编辑/同名重建不误定位、多光标不可用、当前范围定位不改变原text/hash/dirty/undo，以及切文件/工具卸载重挂后model/view保持；保持fixture真实公共形状，不添加Action/ObjectRef关联假字段。D-01未交付只验证缺关联不定位，不勾完整AC-04。

票内所有完整Acceptance criteria仍未勾：对象/范围纯函数部分已验证，实际确认UI、02命令链、01回执、D-01对象关联、真实权限及浏览器全链未验证。产品基线及MVP_SPEC§10“待授权维护者汇总”。本次仅六文件本地提交；提交SHA由Git交付结果报告，未推送、合并或发布。独立切片可通过其提交集撤回；不得用reset/delete覆盖其他并行改动。

收尾静态检查：仓库根`node tools/a0-review/check.mjs`检查72份文档/1005条内链，errors=[]、退出码0；`git diff --check`通过。写集复核为上述六文件。主共享prep接缝后续交付不影响当前纯对象/编辑器接口，未临时复制或提交共享源码；无本次临时文件。

## 2026-10-13 主页面组合结果

独立提交`67507a2`已以`76547ee`整合回`i0/ui-frontend`。主页面在原正文辅导槽接明确快照选择、整份文件/精确选区、对象核对与02发送；发送前核当前原文，dirty/无快照/失效选区不自动保存。编辑器和纯构造器仍沿上述接口，无回答驱动的自动定位。

新增[代码浏览器检查](../../apps/student/e2e/tutoringCode.spec.ts)2项通过，核Monaco实际选择→原help ObjectRef/range/body、选择零写入、草稿变更后不发旧对象、无快照不偷偷保存/冻结及开放项目问题。原编辑4项与确认20项回归通过，包含BOM/混合EOL/非BMP字节、undo/redo、刷新/晚ACK/代际。正式build/typecheck及组合统计见[批次结果](I0-B_UI_TUTOR_PLAN.md#92-验证失败修复与证据分层)。D-01回答关联、真实对象权限/服务仍未交；完整AC-04和整票不勾通过，基线待授权维护者汇总。

## 2026-10-14 AC7 独立浏览器补验范围

Robert明确授权在独立工作树的`codex/i0-b-closeout-code`（开工基线`cc7289180e6ff407c2ae4c97913768a0a534603d`，工作区干净）补验并本地提交；后续由主Agent整合回原`i0/ui-frontend`。本次负责03 AC7的代码来源/实例与迟到回答隔离，只可写[代码浏览器检查](../../apps/student/e2e/tutoringCode.spec.ts)及本文。页面、消息状态机/Pane、helpStop/controls归主Agent；messages、run/return归其他worker；这些源码、共享helper、后台、fixture、保护文档、schema、依赖与配置均只读。发现实现错误回交主Agent具体最小修复建议，不修改实现或弱化断言。

已读正文：README/AGENTS；PRD §3.2/4.2/8（学生控制、原对象与数据边界）；MVP M-03/04/05、§4/5/6（AC-03/04/06/12、NFR-04/05）；TECH §4.1、§7.1～7.5（ObjectRef、一基UTF-16、同名新实例、已显示历史与投递/代际）；I0-B PLAN §1/2/5/6/7/9/11/12、SPEC全文、03全票；I0-A SPEC实施/测试/范围、客户端约束§1～9（尤其§2～4）、IMPORT_SOURCE固定来源/许可/选择性同步边界、TEAM §1/2/2.1及I1～I3。较新D-01已交事实以PLAN §11为准，保留上方历史记录。

实施方案与验收：沿同一authority和真实Chrome操作确认作品→代码/选区求助→实际显示→回收原实例并确认→同路径新建并确认，核原回答file/snapshot来源及原实例不可用提示持续可见，新实例不承接旧回答，正文/位置不被回答修改。另保留authority实际返回的原教学事件，待当前Attempt或受信代际切换并重读后才释放，核旧正文/来源/回执不能混入当前会话。原消息/历史已验的暂停、账号授权失败等反例只引用既有证据，不重复全部组合；不伪造成功payload或新协议。

验证仅运行`tutoringCode.spec.ts`和必要typecheck，使用`CI=1`、Chrome与独立端口5681/5682；复用已有Node/依赖junction，不安装。执行结果、失败与剩余项在本节后续追加；本次不推送、模型调用、真实数据或执行节点。产品基线及MVP_SPEC §10仍为“待授权维护者汇总”。

### 实际验证与交接

2026-10-14，在既有Node v24.15.0、依赖junction环境执行以下命令（前两项在`apps/student`，后两项在仓库根）：

```powershell
$env:CI='1'
$env:XUNJIE_E2E_BROWSER_CHANNEL='chrome'
$env:XUNJIE_E2E_PREP_PORT='5681'
$env:XUNJIE_E2E_REAL_PORT='5682'
rtk npm run test:e2e -- tutoringCode.spec.ts --workers=1
rtk npm run typecheck
node tools/a0-review/check.mjs
rtk git diff --check
```

Chrome专项首轮5/5通过、零失败/跳过、50.8秒；收尾在两项迟到反例补DOM插入观察（防止漏检短暂闪现），原专项复跑仍5/5、零失败/跳过、49.3秒，typecheck再次退出0。不同用例仍只计5项：保留原2项，新补3项。新增证据如下：

| AC7反例 | 实际浏览器/来源核验 |
| --- | --- |
| 已显示回答→回收→同名重建 | 真实文件菜单回收/确认、同路径新建/确认后，两实例fileId不同；旧实例仍recycled且原正文/hash保留。原回答Action和完整ObjectRef不变；可见来源仍显示原path/documentVersion/snapshot，并明确“原文件当前不可用；同名文件不承接这份回答”。打开/收起回答不改新正文、草稿、光标和服务作品，不产生保存/冻结/新求助/运行/控制命令 |
| 原正文跨Attempt迟到 | 扣住同一authority已产生的真实代码事件，不改响应；另一独立场景提供实际新Attempt。原页面仅切开发场景参数并走“重新读取”，保留旧HTTP promise；新Attempt/历史读取就绪后释放旧页，随后新显式代码求助正常显示。DOM插入观察只出现新Action，旧Action/快照/正文未混入新会话或ledger，也无旧Action回执 |
| 原正文跨代际迟到 | 复用既有`recoverRunContext`故障脚本换受信代际并用原UI重读，再释放旧完整代码事件；DOM插入观察只出现新Action，旧Action不展示、不入ledger、不补回执。新代际显式求助正常显示同一确认快照，payload代际为新值，作品未改 |

复用证据：[messages专项](../../apps/student/e2e/tutoringMessages.spec.ts)的“已重读的新暂停优先于迟到旧教学页”覆盖当前控制/epoch，[history专项](../../apps/student/e2e/tutoringHistory.spec.ts)的“刷新缓存待重新授权…真实401清空历史”及跨client/失效shown原历史覆盖账号授权失效和合法历史边界；本次未重跑这两个他人独占文件，也未新增账号切换的全组合检查。各既有实际通过范围见[PLAN §11](I0-B_UI_TUTOR_PLAN.md#11-授权后实施与验证记录)。

失败记录：首次typecheck退出1，新测试直接导入`TutorLedger`令Node侧检查递归引入浏览器`mode.ts`，产生4条`ImportMeta.env`类型错误；已在本spec改为只读核验所需的字段类型，未改应用/tsconfig/依赖。随后原`npm run typecheck`完整退出0。浏览器运行无失败；既有public品牌资源导入提示和NO_COLOR/FORCE_COLOR提示保留，未改配置掩盖。文档检查77份文档、errors=[]；差异空白检查退出0。

本次未发现需回交主Agent的实现错误，未修改或弱化原2项断言。只交本文与`tutoringCode.spec.ts`的本地提交；主Agent后续cherry-pick到原`i0/ui-frontend`并记录组合结果。本次没有重新运行Vitest/build、实际HTTPS服务、节点/模型或真人验收；上述5项仅为实际Chrome上的隔离合成工程证据，不新增整项AC/NFR/教学效果结论。尚余主分支集成和原真实验收门禁，产品基线及MVP_SPEC §10“待授权维护者汇总”。
