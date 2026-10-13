# I0-B-05：获准例子、只读查看与返回作品

**What to build:** 学生查看有来源的相邻例子或教学正文，再主动返回原文件实例和视图位置；原作品/草稿保持，例子不执行、不覆盖项目，返回后不自动继续辅导或运行。

**Blocked by:** [I0-B-01 消息与回执](I0-B-01_MESSAGES_RECEIPTS.md)。D-05最小例子/返回入口已在规划中定稿，由本票实现；不依赖02/03/04，可用获准合成材料独立验只读查看→返回，精确编辑器定位与03共享适配须协调。

**Status:** implemented / prepared-verified（获准公开资料读取、原实例/视图返回已交；合成相邻例子已验，真实教师例子批准与真人接棒仍分列）。

2026-10-14收尾：正常模式资料动作准确标“查看引用资料”，公开可读材料不被叫成教师批准例子；只有开发合成场景保留相邻例子标识。只读覆盖槽、原editor/model/草稿/undo/视图返回与拒绝改贴边界在2项浏览器和25项规则中通过，正式dist已排除合成材料标识；当前教师审批/真人接棒不从测试材料推断。最终构建/检查与限制见[批次§11](I0-B_UI_TUTOR_PLAN.md#11-授权后实施与验证记录)。

日期：2026-10-13（Asia/Shanghai）。主责：UI / Robert。父任务：[I0 #30](https://github.com/paher-din/XunJie/issues/30)。依据：[规格](I0-B_UI_TUTOR_SPEC.md)、[计划](I0-B_UI_TUTOR_PLAN.md)。覆盖UI-TUTOR-07，M-03/M-04/M-09，AC-04/05/06/12、NFR-05。

## Acceptance criteria

- [ ] 复用实际消息正文/概念/只读阅读容器；样例来自教师批准的相邻材料或合法教学正文，有可核来源。缺正式例子DTO时用只读正文，不从模型文字补交互卡、可执行HTML/波形。
- [ ] 例子与学生作品清楚区分，打开、折叠和关闭不产生作品变更、自动保存、快照、help或run；没有获准示例时说明不可用。
- [ ] 进入例子前保留模式/账号/Attempt/原文件实例、原对象版本及本机视图状态；业务返回引用与本机光标/滚动/折叠分别表达。
- [ ] 学生明确返回时恢复原实例的可核位置与现有撤销状态，草稿和未确认命令不被例子覆盖；不以同路径替代实例身份。
- [ ] 原实例回收、同名新建、版本已变、跨Attempt或代际变化时不定位新实例；保留原引用、显示缺项/过时并让学生选择获准当前对象。
- [ ] 刷新后的返回只依已有可信引用和本机确实保留的状态；精确位置未保存或无法回取如实说明，不猜旧行号/捏造跨设备恢复。
- [ ] 需要服务端恢复位置时使用现有position控制及原命令/权威revision；必须由学生明确动作发起，查看例子不隐式start/写位置。
- [ ] 明确“我先试试”/回应才记相应acknowledged；关闭阅读或普通点击不推断采纳/掌握。返回不会自动续答、改代码或运行。
- [ ] 从键盘打开只读例子、返回作品、继续学生编辑的浏览器链可回放，覆盖混合EOL/非BMP位置、重挂载/刷新/同名重建与零业务副作用。
- [ ] typecheck、相关Vitest/build/浏览器专项有实际结果，样例来源与不支持项记录；D-05未交清时精确返回不标完成。

## Testing Decisions

主接缝为01消息/获准材料→现有只读槽→实际编辑器返回。复用已有编辑器保护与只读比较/文件实例测试，检查打开例子前后草稿原文/hash、model视图与请求数。返回版本变更时断言缺项/明确选择，不测试内部hook调用次数。

## 交付与未完成

写集按计划05；不得增加新的学习阶段、例子API或自定义执行工具。05独立部分已实现，01消息接线和D-05中心槽/编辑器返回组合验收仍待主Agent完成。真实相邻样例来源、原作返回和真人接棒分开验，准备只读返回不算UI-TUTOR-09完成。

## 2026-10-13 独立切片范围与依据

Robert授权05执行Agent在既有`codex/i0-b-05-return`工作树完成独立纯逻辑、可复用只读槽、必要单测、待统一执行的浏览器专项和本票记录；仅本地提交本人文件。主Agent独占PrepWorkspacePage/TutoringPane/fixture/http/storage及中心overlay接线，03独占CodeEditorHost/CodeWorkspace/useProjectWorkspace，04独占RunPanel/RunHistoryPanel；05均只读。教学后台、受保护文档、DB schema、CI/env/package/依赖不改，无供应商或真人操作。此次实施授权覆盖独立切片，不将整票AC改为已通过。

已读正文：README与根AGENTS；PRD §3/4.2的学生控制、相邻例子和原任务返回；MVP M-03/M-04/M-05及AC-04/05/06的作品保留、一次支持后接棒、回执分层；TECH §4.1的实例/版本引用和UTF-16边界、§7.3的完整内容与确认边界；I0-B SPEC实施决定、PLAN §4～7、本文全部验收；I0_UI_SPEC实施决定、客户端约束§2～4及资料读取部分；IMPORT_SOURCE的固定导入/选择性同步和本仓库独立业务维护边界。主仓未提交TutoringPane只读核对`onExample(message: TutorMessage)`与公开ID列表`resourceRefs`。已有init逐条核活动学生视角、可读投影、资源ID及available状态；本切片使用同一初始化结果，不另建读取API。

本次实际五文件写集：[纯逻辑](../../apps/student/src/workspace/tutoringReturn.ts)、[必要单测](../../apps/student/src/workspace/tutoringReturn.test.ts)、[只读组件](../../apps/student/src/components/workspace/TutoringExample.tsx)、[浏览器专项](../../apps/student/e2e/tutoringReturn.spec.ts)、本文。未改其他共享文件，也不移入或提交主仓未完成源码。

## 接线接口与来源

`TutoringExampleProps`包含`resource: TutoringResourceResult`、`onReturn: () => void`、可选`returnNotice: string`。组件仅安全阅读，返回按钮仅调用主Agent提供的callback；不请求HTTP、不写控制/作品/回执、不自动求助/运行。它复用现有Markdown的React词法渲染，HTML按转义文本显示，危险协议不成链接。

纯函数接口如下，类型定义与实现以纯逻辑文件为准：

```typescript
resolveTutoringResource(resourceVersionId: string, activity: ActivityView,
  materials: readonly MaterialRead[], mode: WorkspaceMode): TutoringResourceResult
captureTutoringReturn<V>(context: WorkspaceContext, file: TutoringReturnFile,
  view: V | null): TutoringReturnAnchor<V>
validateTutoringReturn<V>(anchor: TutoringReturnAnchor<V>, context: WorkspaceContext,
  files: readonly TutoringReturnFile[]): TutoringReturnResult<V>
```

主调用方从消息的`resourceRefs`选明确ID，使用当前有效上下文的init.activity/materials；不从自由文字抽取交互卡。resolver要求ID在活动学生可读列表唯一出现、相应MaterialRead已加载、公开资源ID/status/text/contentHash与活动投影一致；裁剪、无权限/读取失败、缺项和错配明确不可用，不补正文。activity没有公开“教师批准的例子”标志，不能把所有learning_material叫例子。

负责人明确主Agent在同一prep/scenario追加`prep-resource-adjacent-example-01`，公开kind为learning_material、format为markdown，内容是温度阈值29/30/31的相邻小练习，非TextScope答案；该ID仅在preparation模式标“合成准备相邻例子·非教师真实批准材料”。实际材料/教学事件由主Agent交付，本工作树未修改fixture。其他准备资料标“合成准备课程资料”，真实可读资料标“当前活动公开课程资料”，两者均注明“未核验为类似例子”；没有真实教师批准事实就不作此断言。已有资料可只读查看，其性质保持准确。

`TutoringReturnFile`包含稳定本机`fileId`、可选`serverFileId`、`path`、`lifecycle`、`documentVersion: number | null`、`contentHash: string | null`、`draftText`原文。anchor分别克隆当前WorkspaceContext、原文件与可序列化本机`view`，不建立新的服务端ObjectRef/快照，也不重算版本。V可为既有编辑器光标/滚动/折叠视图；model/undo栈继续归现有编辑器，不进入anchor。

validate核mode/user/assignment/activity/attempt/preparationEpoch/loadEpoch/受信代际、稳定实例/映射/path/lifecycle/版本/hash和逐字草稿；仅成功时返回`{ kind: 'ready', fileId, view }`。失败返回`{ kind: 'unavailable', reason, notice }`且不带view；同名重建不匹配，版本或草稿变更不套旧位置。刷新后loadEpoch变化会拒绝旧精确位置，本切片不虚构跨刷新/设备恢复。view未保留时明示不能精确定位，主调用方可关闭阅读保留当前作品，不猜行号。

主接线须在进入资料前捕获原文件/视图，在同一中心容器叠加阅读槽且保持CodeWorkspace及model挂载；退出前再次校验，成功才交03只读定位接口。失败显示notice并由学生明确选择当前对象。普通关闭/返回不写controls/acknowledged，不自动保存/生成/运行；“我先试试”由01原显式回执动作负责。05函数不会替主调用方维持挂载或读取编辑器状态，不能据纯函数通过宣称草稿/undo浏览器链已验。

## 验证与待交付

2026-10-13较新主整合：独立`4eb02cf`已以`8d21154`合回原UI分支。主将只读资料覆盖在原工具区上方，保留CodeWorkspace/Monaco挂载和原草稿/undo；返回核当前context/实例/映射/版本/原文，不写position控制或自动求助。明确合成相邻资料由原activity/resource投影读取，kind不被猜成真实教师审批。

本票[浏览器检查](../../apps/student/e2e/tutoringReturn.spec.ts)2项通过：键盘查看/返回、同一编辑器实例/光标/草稿与undo保留且零保存/求助/运行/确认副作用；公开资料及同名重建/代际变化拒贴旧位置。25项独立规则和[全批build/typecheck/组合结果](I0-B_UI_TUTOR_PLAN.md#92-验证失败修复与证据分层)通过。真实教师例子许可、真实服务/真人/全AC仍未验；以下原独立工作树记录保留其时点。

2026-10-13，Node v24.15.0、RTK 0.48.0，在学生工程运行`rtk npm test -- tutoringReturn`：Vitest 3.2.7，1文件25例通过；`rtk npm run typecheck`：src与tsconfig.node两层tsc通过。反例覆盖不可读/缺项/失败/错配资源、非学生投影、准确合成/课程资料性质、HTML与危险链接不执行、原BOM/混合EOL/非BMP草稿和视图克隆、身份/代际/加载变化、回收/同名重建/版本与草稿变化、缺视图及本机未确认实例。

浏览器文件提供两项待主统一执行的检查：键盘打开相邻例子/返回，原Monaco DOM保留、位置/草稿/undo保留、无help/run/sync/snapshot/control或acknowledged副作用；以及同一authority公开活动/资源读取与返回拒绝反例。文件已加入类型检查范围，但没有启动浏览器或执行Playwright，没有将编写用例记为通过。主中心接线未在本工作树实现，fold精确恢复、刷新后实际显示和完整AC-05语义仍待组合/正式验收。

本切片不依赖主prep新增接缝运行单测或typecheck，未复制公共文件。build、完整浏览器、正常业务宿主/公开真实例子、供应商、教师语义抽查、真人学生接棒全部未执行。整票AC保留未勾选，01/D-05组合与真实资料批准事实未交；产品基线及MVP_SPEC§10仍为“待授权维护者汇总”。本地提交后交主Agent按五文件整合，不推送。

静态文档检查`node tools/a0-review/check.mjs`通过：72文档/1004内链、errors=[]；差异空白检查通过。此次仅五个授权文件，未留临时文件，独立分支提交保持与主共享状态分离。
