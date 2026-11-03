# WP03：组件依赖准备、自检与失败恢复实施方案

日期：2026-11-02（Asia/Shanghai）。实施票：[组件依赖准备、自检与失败恢复 #171](https://github.com/paher-din/XunJie/issues/171)，母票：[课程组件宿主与公共执行 #162](https://github.com/paher-din/XunJie/issues/162)。上位契约为 [WP03 规范](wp03-course-components-and-execution.md) §2、§3、§6、§12–13。

**状态：已实施并完成本轮复审修复；Windows 与 Mac 分别验收，尚不标记跨平台完整通过。** 本文前部保留原规划，实际实现与验证见文末；不替代 GitHub 的实时状态。沿本轮授权在 `wp03` 开发、验证并推送 `origin/wp03`，不创建 PR、不合并 `main`。

**2026-11-03 修订：负责人已确认工程方案并授权迁移 9，切片 1–4 已实现并在本机 Windows 11 x64 + 桌面 Chrome 上完成产品验收。** 下方原文保留为规划依据；实际落地与验证结果见文末「实施结果与验收证据」。未执行项（Apple Silicon Mac、教学效果）在该节单独列出，不视为通过。

## 目标、既定范围与建议

学生打开固定组件后，产品自动取得和校验依赖、检查设备能力、在独立实例自检，并在满足条件后开放对应能力。重新打开复用仍有效的准备记录；中断后沿原准备身份查询和继续。准备失败仍能读取已有作品，并保留无关编辑能力。全过程无需 Agent 或 #170 的公共执行器。

已确定：使用材料标注组件验证真实浏览器依赖；准备按能力报告可用性；固定版本、原作品保护、独立自检、原身份恢复、所属维护和两平台真实产品验收均不可省略。教师组件库、正式创作页面、执行位置选择、原生环境实际安装分别留给 WP10、#175、#173；这里只提供可消费的准备契约。

建议采用以下工程路线，待负责人确认后实施：

- 将 `mark.js@8.11.1` 的浏览器发行文件作为组件的独立不可变资源，实际用于标注原文高亮；不将其打入主前端，也不在学生页面运行 npm 或访问 CDN。
- 新清单格式显式声明依赖、逐能力需求、预算和自检配置；旧格式继续可读。材料标注发布新组件版本、新资源及新课程发布，保留原版内容，沿用 `stateVersion=1` 的既有标注结构。
- 先实现浏览器准备这一条真实路径，围绕准备、查询/继续、能力读取形成小的 Interface；资源取得、去重、缓存、阶段落盘、自检和原子启用收敛在同一个 Module 内。原生 Adapter 只规定同样的输入输出及未知结果处置，不预建通用插件注册框架。

高亮只表达当前开放材料中的文本匹配，**不赋予已有 quote 精确来源定位语义**。同文多处出现时不声称找到原选区；非文本固定引用及权威来源核验仍由 #172 完成。高亮不可用时，已有引用文字、笔记编辑和导出继续使用。

## 当前代码事实

核对基线：`wp03` / `3c90652887942c339c881fed7ce7c7a38db2ed51`。工作区原有 `tools/xj-dev/xj-dev.mjs` 改动与未跟踪的 `apps/student/`、`course_matrial/data_logic/.gitignore` 不属于本票，不暂存、不覆盖或提交。

| 现有入口 | 当前事实 | 本票接入 |
| --- | --- | --- |
| [组件 wire](../../../packages/contracts/src/components.ts) | 严格格式 1；单 HTML entry；有界状态；必需能力只含作品读写 | 版本联合、依赖资源、自检/设备条件、准备状态和逐能力结果；兼容旧摘要 |
| [课程组件 owner](../../../packages/learning-space/src/courses/components.ts) | 不可变登记、资源摘要校验、启停、所属引用与恢复验证；迁移 7/8 | 多资源原子登记及保留、准备报告接入与校验；迁移编号在实施时核对全部登记后分配 |
| [组件视图](../../../apps/web/src/component-host/ComponentView.tsx) | 验证固定 bundle/material；隔离 `/view`；每次 load 新连接 | 准备调度、依赖字节交付、准备问题展示；保持原挂载/权限保护 |
| [宿主 bridge](../../../apps/web/src/component-host/bridge.ts) | MessagePort、操作回执与条件写入；执行尚不可用 | 生产实例与准备实例分离；不给自检生产写入或执行能力 |
| [可靠工作区](../../../apps/web/src/reliable-workspace/README.md) | 唯一作品权威；IndexedDB v4、原操作持久回执、离开保护 | 作品仍走原通路；准备缓存不复制作品、不另建自动保存周期 |
| [正式 HTTP](../../../packages/learning-space/src/learning-entry/index.ts)与[学校客户端](../../../packages/product-runtime/src/school-client.ts) | 组件 bundle 与独立 view，逐次身份/资格核验；客户端有限路由转发 | 固定依赖读取和报告入口、响应校验及对应转发，拒绝任意 URL 代理 |
| [标注样例](../../../components/material-annotation/package.mjs) | 自包含 HTML；quote/note 自动保存；暂无外部依赖 | 新版本声明独立高亮依赖；打包只读取锁定发行文件，保留许可证和来源 |

前置关系于本次规划时通过 GitHub 原生 `dependencies/blocked_by` 核对：#171 的前置为 #169；不依赖 #170。此处仅记录规划依据，不维护第二份完成状态清单。

## 固定清单、准备身份与事实归属

### 清单演进

建议新增 `formatVersion=2` 联合分支，明确 `preparationProtocolVersion`；`hostApiVersion=1` 保留已有作品消息语义。新增准备消息/初始化字段须双方显式支持，并由独立 schema 校验；旧宿主遇到必需的新能力应明确拒绝，不能忽略后继续写入。清单、桥接、状态、浏览器库及 PostgreSQL 迁移版本分别处理。

新分支包含有界列表和严格字段：

- 依赖：稳定 dependencyId、精确包/版本、资源 ID、SHA-256、字节长度、媒体类型、角色、加载顺序及所支持准备类型。资源摘要绑定实际发行文件；npm 完整性值只作为获取来源校验，不能代替文件摘要。
- 环境：浏览器准备类型、所需特性探测清单、受支持准备协议、逐能力依赖图及自检版本。只支持已实现的声明类型，拒绝任意安装脚本、任意路径、动态 URL 和未知必需条件。
- 预算：资源总字节数、资源数量、消息大小、准备/自检时限、并行度和缓存配额策略。具体上限在首个实现切片根据现有包大小与资源限制确定并测试；不把未测数值写成产品容量承诺。
- 固定自检：公开材料、操作步骤的类型化声明、预期状态/结果、检查项依赖及版本。只支持标注样例所需的有限步骤，不建立任意脚本工作流引擎。

旧清单不填充默认字段后重新计算摘要；原格式的规范化结果及摘要必须保持不变。相同组件版本仍不可换定义或资源；新增资源验证完成并可重读后，才发布完整可读定义与登记回执。

### 准备身份与缓存

`preparationId` 为持久随机身份；其请求摘要固定组件定义、配置、依赖/自检版本和实际设备能力。相同身份换输入拒绝；同一范围及相同指纹并发请求复用原准备，不重复安装或自检。浏览器缓存范围包含产品恢复 namespace、环境/空间/主体，不用公共资源缓存绕过当前资格。

缓存分两层：按摘要保存不可变依赖字节；按检查项的实际输入摘要保存验证结果。组件代码或自检版本变化重新做受影响行为检查；配置只使引用该配置的检查失效；依赖变化只使依赖它的检查失效。整体准备指纹包含配置，但不得因此清空所有无关检查。

设备信息来自产品实际探测：浏览器/平台版本、所需特性及准备实现版本；不收集不相关硬件标识，也不以浏览器自报信息形成安全证明。页面重开重新做低成本能力探测，并重读/核对将使用的依赖字节。命中缓存不意味着文件永远不会被清理或损坏。

| 事实 | 所属与持久边界 |
| --- | --- |
| 定义、固定依赖资源、固定自检资料及保留引用 | 现有课程/组件 owner；通过 OwnedStorage 事务及资源接口，纳入原 owner 维护关闸与恢复校验 |
| 浏览器准备阶段、检查结果、缓存字节和活动环境指针 | 准备 Module 的本机 IndexedDB 元数据/缓存；隔离命名空间，不存学生作品；非破坏建库/升级 |
| 可供预览读取的准备诊断报告 | 建议由课程/组件 owner 保存经授权提交的版本化报告；标记真实来源、设备、条件和时间，不作为另一设备的 ready 凭证 |
| 标注、笔记及待同步作品 | 仍由原可靠工作区与学习数据 owner 拥有；准备代码不得直写其表或当前作品 |
| 后续作业/会话与环境占用 | 执行 owner 拥有；按固定 environmentId 保留，准备更新无权改绑 |

报告上传失败不阻塞已验证的本机能力。原准备记录保存同一报告请求身份，联网后继续登记/查询；这只是准备记录的一个阶段，不新增作品同步器或公共执行 outbox。服务端报告是客户端诊断，不赋予安装、执行或越权资格。

## 准备 Module 的 Interface

以下名称为拟定语义，实施时按真实调用收敛，不构成已交付导出。

| 操作 | 调用方需要知道的约定 |
| --- | --- |
| `prepare(fixedBinding, requestId)` | 先持久记录身份，确定性解析声明并推进可重做阶段；返回原 preparationId 及快照，不表示学生作业已执行 |
| `query(preparationId)` | 返回阶段、已验证步骤、诊断、每项能力、当前/候选环境；查不到与结果未知分开 |
| `resume(preparationId)` | 重新核对资格和固定输入，从未完成步骤继续；未知副作用先交回原 Adapter 查询，不盲目重放 |
| `capabilities(instanceBinding)` | 返回各能力的 available/limited/unavailable、原因、限制和绑定环境，未知执行能力保持不可用 |

宿主订阅同一快照呈现进度，不在 React effect 中另存准备事实。准备重入/双标签页使用浏览器持久事务与互斥保护；连接 ID 仅用于传输，不能替代 preparationId。页面关闭可中断计算，但已确认阶段可恢复。

原生 Adapter 后续接入时需给出确定性 inspect、prepare/原操作查询、自检和环境保留语义，包括权限请求、启动实例及未知结果的处置。未接入时明确返回 unsupported；本票不伪造安装成功、作业回执或暂停/单步能力。此 Interface 的真实消费者为浏览器宿主及预览；原生实现随 #173 出现后再提取真实共有机制。

## 生命周期、失败与启用

对外准备状态至少区分 `unprepared`、`preparing`、`permission-required`、`repairable`、`unsupported-device`、`self-test-failed`、`ready`；另以核实状态表达检查中断/结果未知。状态带阶段及原因码，不依靠一个 ready 布尔值推断全部能力。

执行步骤：解析固定声明 → 持久身份 → 实际能力探测 → 取得缺少资源 → 校验并持久缓存 → 独立实例加载真实依赖 → 固定自检 → 落盘检查结果 → 条件更新可用环境指针。

- 每步完成后先落盘再推进。中断只丢失未确认阶段；浏览器资源取得、校验及独立自检可安全重做，沿用原准备身份。已完成步骤命中有效结果，不重复安装。
- 超时后关闭测试 iframe/端口、退休旧代际；迟到消息不能激活环境。当前浏览器步骤不产生外部业务效果；原生未知结果保留原操作关联，由 Adapter 先查询。
- 摘要错误、资源损坏和错误版本拒绝使用；重新取得同一固定资源并校验，不请求“最新版”。设备缺特性与资源暂时不可取分型，不能因网络失败判设备不支持。
- 缓存读写失败保留诊断和原可用环境，不显示已持久就绪；提供必要修复动作，不清除作品库。不确定权限时不自动提升权限。
- 新环境仅在全部必需检查完成后成为该固定绑定的可用候选。旧发布活动仍绑定原组件版本；新版失败也不把新版活动静默降级运行旧代码。保留旧环境不等于授权跨版本回退。
- 每项能力独立开关。高亮依赖失败时保留基础阅读、笔记编辑和导出；基础视图也无法加载时，回到现有「作品」读取/导出入口，不能清空状态。
- 学生实例的热替换须先通过原 workspace 离开保护；失败时保留当前视图和输入。准备完成不能凭旧 contentId 重写作品、重开已关闭活动或调用执行器。

## 浏览器依赖与隔离自检

### 依赖如何真正使用

选择 `mark.js@8.11.1` 是工程建议，官方提供无需 jQuery 的独立浏览器发行文件和异步完成回调，适用于现有纯 HTML 标注页。来源见 [mark.js 官方文档](https://markjs.io/)；本次通过 npm 元数据核对精确版本及 MIT 许可证，尚未下载或评估实际集成效果。

实现时仅将固定发行文件纳入组件导入资料，并保留 MIT 许可证；浏览器获得的每份字节均在导入和使用前按清单核对长度及 SHA-256。依赖单列资源，不预先内联进 entry 冒充动态准备；主 Web 产物保持不变也能导入兼容组件新版。

沿用当前独立 `/view` 与 opaque-origin iframe。宿主取得并验证依赖，从当前 MessagePort 将批准字节交给组件加载；组件仅在自己的隔离文档中作为脚本使用，不能让主窗口执行导入代码。使用当前内联脚本能力，无需 `eval`、同源 iframe、CDN、任意网络、宿主凭据或放宽父文档 CSP。具体传输上限、脚本插入和代际核对在首个浏览器切片实测，失败即调整方案并保留证据。

高亮实现调用真实库，并等待其完成回调；只处理开放材料文本，保留原文字内容及选择行为。缺少库不能用本地替代算法返回自检通过。使用固定完整引文匹配，显式关闭宽松分词/大小写等可能误导精确匹配的默认项；标注多次出现的文字只是匹配展示，不写回来源偏移。

### 自检不能成为学生操作

产品创建独立 preparationId/testInstanceId，加载同一固定视图代码和依赖，供给公开样例及临时状态。独立准备桥接仅允许读取样例、修改临时状态和报告自检结果；不连接真实 ReliableWorkspace、学习数据写入、问题草稿、执行接收器或学习事件入口。

第一组固定自检覆盖：依赖实际初始化；中文/换行文本匹配；真实高亮 DOM 的数量与文字；解除高亮后正文保持；标注加入、修改、读取临时状态的一致性；不匹配/无效输入负例。驱动使用视图同一实现，不另写一份假算法。宿主核对固定预期、消息顺序、阶段与超时；不能只凭 `component.ready` 或组件自报 `passed=true` 激活能力。

Opaque iframe 的 DOM 不能由父页面直接读取：视图测试入口负责返回有界观察，准备桥接独立核对状态及固定预期；真实 Chrome 验收再从实际 DOM 验证行为。此自检是兼容性检查，**不声称能够证明恶意组件诚实**。隔离和资格校验始终由宿主实施，不能由组件自检结果豁免。

自检/预览结束清理临时实例及端口；保留原准备记录与诊断。记录精确组件/依赖/自检/宿主版本、设备、条件、实际耗时和可取得的资源统计。拿不到精确内存值时注明统计口径，不以整个浏览器内存冒充组件用量。教师预览沿用受支持的导入/预览接口，报告限于实际设备；不提前建设教师库页面。

## UI 与维护

沿用 [DESIGN.md](../../../DESIGN.md) 和现有中心工具区、标注左右布局、浅深色 token。默认自动准备；在受影响操作附近短暂显示进度，失败显示原因、仍可用能力及必要的继续/修复动作。不要求学生写清单、选择节点、检查端口、手动保存或冻结。

不增加日常工程向导；没有阻断问题时不常驻准备/保存标签。高亮使用已有语义 token，键盘、中文输入、选中文字和原焦点行为必须回归。若最终布局变化达到较大调整，交付必须附实际运行前后截图；即使只增加就近错误状态，也记录实际浅深色及窄桌面界面。

新增资源保留引用与准备报告纳入课程 owner 的迁移、维护关闸、校验及恢复。浏览器准备缓存是设备本地事实，不声称进入服务器完整备份；还原后重新核对实际设备和缓存，恢复报告不能直接激活环境。新资源损坏不靠重跑学生实验修复。

本票不提供破坏性清理入口。组件活动、固定发布及未来运行占用的环境不能回收；仅未引用候选可按后续明确策略处理。完整跨 owner 备份/隔离还原/唯一接管仍由 #176 交付，本票须提供其可登记和验证的所属对象与引用。

## 实施切片与验收

每个切片完成相应生产接线和验证，不先堆一批未使用的抽象。下表是实施顺序，不是实时进度表。

| 切片 | 写集与交付 | 可观察的通过依据 |
| --- | --- | --- |
| 1. 版本与资源链路 | contracts、课程组件 owner、导入 CLI、HTTP/学校转发、样例打包 | 旧版摘要不变；新版依赖单独导入/重读；错误摘要/版本拒绝；同版本换字节冲突；最小真实 iframe 能消费实际依赖 |
| 2. 确定性准备 | Web 准备 Module、浏览器持久记录和缓存 | 冷/热准备、按原身份查询/继续、并发去重、缓存损坏、写失败、检查项精确失效；不改作品 |
| 3. 独立自检与启用 | 标注样例新版本、隔离准备桥接、能力投影 | 实际库与实际视图的正负例；自检中断/迟到回调不启用；正常活动与预览互不写入；失败不替换旧环境 |
| 4. 产品接线与维护 | ComponentView、必要样式、报告所属登记、runtime 维护及恢复校验 | 正式活动就近恢复；输入/问题草稿/原回执保持；依赖与报告纳入真实资源保留及所属恢复；旧协议可用 |
| 5. 交付取证 | 真实产品包、Chrome 探针、工程回归和交接记录 | Windows 与 Mac 分别记录版本、数据链路、耗时和资源口径；未执行不记通过；只提交本票写集并推送 wp03 |

### 行为验收矩阵

| 场景 | 必须验证的结果 |
| --- | --- |
| 首次缺依赖、热重开 | 冷准备真正取得/验证/消费库；热准备命中持久记录及缓存，仍核对实际可用性 |
| 错版本、损坏、未知协议/设备缺特性 | 原因分型；错误字节不执行；只关闭相应能力；基础编辑/历史作品保留 |
| 下载/缓存/自检阶段中断 | 同 preparationId 可查询已完成阶段并继续；旧异步结果不激活环境；失败诊断可重读 |
| 并发打开、同 ID 换输入 | 原准备去重；改变输入拒绝；两活动状态与预览实例隔离 |
| 组件/配置/依赖/环境变化 | 受影响检查重新执行，无关结果复用；新版失败保留原环境，原活动版本不漂移 |
| 准备自检/教师预览 | 临时作品真实读写；真实学生作品、草稿、操作回执和学习证据无新增或覆盖 |
| 缓存/报告落盘失败、权限待确认 | 不假称持久 ready；保留诊断和原作品；人工处理仅呈现必要步骤 |
| 失权与资源隔离 | 旧连接不可重新装配或提交报告；不跨主体命中准备记录；组件不能借 cookie/网络直调业务 API |
| 本机/学校产品链路 | 真实资源由登记 owner 经获准连接到实际 iframe；不能以 fixture 或开发代理冒充完整路径 |
| 保存回归与更新竞争 | 准备期间编辑、切换、刷新、双标签及保护失败；标注、问题草稿与原操作回执均按原机制恢复 |
| 维护/恢复 | 新依赖及报告真实持久重读；资源引用完整；维护排空；恢复后重验设备，不把报告当可运行环境 |

测试从公开准备 Interface、生产桥接及资源入口进入。故障注入只控制真实阶段的时序、传输或存储失败；不替换实际库、DOM、自检或 PostgreSQL。使用固定独立预期，不能由被测输出生成预期。

工程检查选择：受影响 workspace 类型检查/构建、`npm run check:contracts:browser`、相关 Vitest、原生组件集成、现有可靠保存及 productUi Chrome 回归、定向文档链接检查和 `git diff --check`。全仓检查若因无关已有问题失败，应保留原失败及本票范围结果，不通过修改无关文件消除失败。新增命令待代码落地后记录实际调用，不在此声称已运行。

真实浏览器只要求桌面 Chrome，目标为 Windows 11 x64 与 Apple Silicon Mac，使用正式产品资源链路。至少覆盖冷/热准备、失败修复、中断继续、版本变化、实际自检与原内容恢复；学校转发变化另验实际获准连接。当前设备只能直接承担 Windows 验收，Mac 需后续取得真实设备/交接结果，不能以模拟平台代替。

交付分别报告工程检查、真实依赖/自检、Chrome 与产品路径、教学效果。教学效果本票不作通过结论；未测平台、连接、耗时和资源项明确列出，不关闭未完整验收的实施票。

## 实施前确认与风险

本节保留 2026-11-02 规划时的授权边界；工程方案和迁移 9 后续已获授权，见下方实施记录。复审修复不新增数据库迁移。

本轮没有修改运行代码、依赖、数据库、浏览器库或环境配置。准备进入实施前，需要负责人确认上文工程方案，特别是高亮样例的产品行为及新增持久化结构。

按根 [AGENTS.md](../../../AGENTS.md) 的「大改动前先在出方案，我确认后再动手」和「数据库 schema 变更或数据迁移」红线，实施将单独说明并取得迁移授权：预计在课程 owner 新增准备诊断/引用登记结构，在浏览器新增准备元数据/缓存结构。采用新增、非破坏迁移，具体 DDL/版本与兼容规则在执行前核实；风险是升级失败、空间配额、旧客户端无法理解新格式或错误启用缓存。通过旧格式保留、逐阶段确认、旧环境保留及真实恢复验证控制这些风险。本次规划不等于执行迁移授权。

若需要删除旧文件、改 `.env`/密钥/CI 或公开部署，另按红线说明具体对象、理由及风险后询问。当前方案无需上述操作。后续普通开发分支提交与推送已由本轮要求授权；只暂存本票文件、不强推、不创建 PR、不合 main，不将推送解释为生产发布或两平台完整验收。

## 实施结果与验收证据

### 2026-11-03 复审修复范围

本轮按负责人要求复核 `219bb4c`，修复缓存损坏恢复、并发身份准入、固定报告重试、存储未知、准备/自检时限、按相依检查组复用及生产加载诊断。保持既有清单和数据库 schema，不新增迁移，不改变课程范围；Mac 补齐可执行交接并按实际平台生成报告。以下原实现验收记录不自动证明这些修复通过，修复后的证据另行补记。

本节记录实际落地，不是对上方规划的追认。基线 `60f58c5`，实施于 `wp03`，未创建 PR、未合并 `main`。

### 切片 1：版本与资源链路

- [组件 wire](../../../packages/contracts/src/components.ts)：新增 `formatVersion=2` 分支（`componentPreparedManifestSchema`），声明依赖资源、环境/设备需求、预算、固定自检与 `preparationProtocolVersion=1`；`formatVersion=1` 分支对象字面量逐字未动，规范化结果与摘要不变。运行测试以固定值 `e553551c0213e6bd6fa1e8491de88606414a5a68f60aec0df61eca9ed154caf8` 硬断言旧摘要，客户端由返回清单重算摘要也必须一致。
- 新增准备协议 wire：`componentPreparationMessageSchema` / `componentPreparationReplySchema`（observation 与 error 二选一）、`componentInitializeSchema`（format 2 必须显式携带 `preparation.mode`）、准备状态/原因码/逐能力投影、`componentPreparationReportSchema` 与提交/回执/列表 schema。准备协议、宿主协议、清单格式、状态结构与迁移版本各自编号。
- 课程 owner（[components.ts](../../../packages/learning-space/src/courses/components.ts)）：`register` 校验 entry 与全部依赖字节后原子登记；每个依赖使用独立保留引用 `component/<componentId>/<version>/dependency/<dependencyId>`，entry 沿用原引用 ID，因此旧版 `validate()` 断言仍然成立；新增 `dependencyBytes` / `dependencyContent`；同版本换定义或换字节仍为 `identity-conflict`；`verify` 与 `validate` 覆盖依赖字节与依赖保留引用。预算超限、未知必需特性、缺失或多余依赖资源在 schema 层被拒（refine 全部为全函数，避免抛非校验错误被误映射为 503）。
- **迁移 9（负责人已授权）**：新增非破坏表，不改既有表：
  ```sql
  CREATE TABLE component_preparation_reports(report_id uuid PRIMARY KEY,
    component_id uuid NOT NULL,version integer NOT NULL,
    preparation_protocol_version integer NOT NULL,self_test_version integer NOT NULL,
    request_id uuid NOT NULL,fingerprint text NOT NULL,report jsonb NOT NULL,
    submitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY(component_id,version) REFERENCES course_components(component_id,version));
  ```
  写入走既有 `storage.request` 回执去重；`components.validate()` 重新解析每条报告并核对组件/版本/摘要，纳入 owner 的维护与恢复校验。format 1 组件不接受报告（返回 `invalid`），报告不是任何设备或资格的 ready 凭证。
- 正式 HTTP（[learning-entry](../../../packages/learning-space/src/learning-entry/index.ts)）新增三个固定路由，均先走既有 `authorizedRelease` 资格校验，不接受任意路径或 URL：`GET releases/<releaseId>/components/<key>/dependencies/<dependencyId>`、`POST .../preparation-report`、`GET .../preparation-reports`。学校转发（[school-client](../../../packages/product-runtime/src/school-client.ts)）的允许列表与响应校验同步扩展，未加 `/view` 等不经过转发的路径。
- 本地 CLI（[cli.ts](../../../apps/local-runtime/src/cli.ts)）的 `component-import` 支持 `dependencies: [{ dependencyId, path }]`，路径仍限制在导入目录内，`resourceId` 取自清单声明，不接受调用方自选。
- 标注样例新增版本 2（[view-v2.html](../../../components/material-annotation/view-v2.html)），`package.mjs` 同时生成 `component.json`（版本 1，未变）与 `component-v2.json`。依赖为 `mark.js@8.11.1` 的 `dist/mark.min.js`，16917 字节，SHA-256 `21d62e1053f7589fe6365cccd7c636d1781abf7879a605d8ce5f1f5b81a7b8fa`，随附 MIT 许可证与取得方式见 [vendor/README.md](../../../components/material-annotation/vendor/README.md)。版本 1 的 `view.html` 未改动。

### 切片 2–3：准备 Module、独立自检与逐能力启用

[apps/web/src/component-preparation](../../../apps/web/src/component-preparation/preparation.ts) 提供 `prepare` / `query` / `resume` / `capabilities` / `dependencies` / `reports` / `subscribe` / `scopeKey`：

- 身份：`preparationId` 持久随机身份；`requestDigest` 固定组件定义、配置、自检/协议版本与实际设备指纹（不含调用方 requestId），同范围同指纹复用原身份，同 requestId 换输入拒绝。`scopeKey` 含恢复 namespace、环境/空间/主体与完整定义，不跨主体命中。
- 持久：独立 IndexedDB `xunjie-component-preparation-v1`（preparations / checks / resources / environments），与学生作品库 `xunjie-reliable-works-v1` 分离；准备代码不读写作品表。每一步先落盘再推进；Web Locks 做跨标签互斥，缺失时退化为同页互斥。
- 缓存：依赖字节按 SHA-256 存；命中后仍重新计算摘要才使用；缓存写失败保留本页内存副本并记录诊断，不因此断言已持久就绪；可用环境指针写失败则状态为 `repairable`/`storage-unavailable` 且 `environmentId` 为空。
- 自检：[self-test.ts](../../../apps/web/src/component-preparation/self-test.ts) 用同一 `/view` 资源、同一固定视图代码，在独立 iframe 中由 [bridge.ts](../../../apps/web/src/component-preparation/bridge.ts) 提供**仅内存**临时状态；该桥接不接可靠工作区、学习数据、问题草稿、执行接收器或学习事件，且无执行/引用能力。宿主核对固定预期、消息顺序与 `selfTestTimeoutMs`；超时或畸形应答记为 `interrupted`，不激活环境。
- 原实现复用粒度为全有或全无；2026-11-03 复审修复后改为按相依能力组复用，组内保持原顺序和临时状态前提；高亮依赖变化不使作品读写检查失效。仅显示标题变化仍复用检查；代码、实际公共样例/初始状态或设备变化重新核对相关组。
- 逐能力：`workspace.read` / `workspace.change` 由标注往返与负例检查把关；`material.highlight` 另需其声明依赖取得、校验并实际加载。执行能力不投影、桥接直接拒绝。
- 报告：提交前先持久 `reportId` 与 `requestId`，上传失败不阻塞本机已验证能力，下次打开按原身份重试。

### 切片 4：产品接线

[ComponentView](../../../apps/web/src/component-host/ComponentView.tsx)：`formatVersion=1` 保持原路径；`formatVersion=2` 先完成清单/材料校验与准备，激活环境后才挂载并把已验证依赖经同一 MessagePort 交付，组件侧再按清单摘要与长度独立复核后才执行。失败时就近显示原因、可用能力与「按原准备身份继续」；环境未激活时不挂载，新版失败不改绑旧版本。

### 浏览器高亮的一处实现修正

`mark.js` 的 `accuracy: 'exactly'` 会把关键词包成 `(^|\s)(quote)(?=$|\s)`，要求两侧为空白或边界，在中文正文中无法命中句内引文。实现改用 `accuracy: 'partially'` 配合 `separateWordSearch: false`（整段引文作单一关键词）、`caseSensitive: true`、`diacritics: false`、`acrossElements: true`，并关闭 wildcards/synonyms/ignoreJoiners/ignorePunctuation，得到「整段引文、区分大小写、按精确子串」的固定匹配；高亮完成以库的 `done` 回调为准，不用本地替代算法。界面只呈现「材料中 N 处匹配」，并明示同一段文字多处出现不代表原选区位置。

### 实际调用的检查

```sh
node scripts/build.mjs typecheck            # 全工作区类型检查
node scripts/build.mjs all                  # 构建
npm run check:contracts:browser             # 11 个公开导出浏览器安全
npm run check:docs                          # 172 个 Markdown、1363 个本地目标、0 失败
npm test -w @xunjie/web                     # 61 个文件 / 709 项
node scripts/test.mjs server                # 本地（非 external）
node scripts/test.mjs product-runtime
node scripts/test.mjs storage
node scripts/test.mjs checks
# 原生集成（需 XUNJIE_PRODUCT_POSTGRES_BIN 指向 PostgreSQL 18.6）
node --test apps/server/tests/component-host.runtime.test.mjs
node scripts/probe-component-preparation.mjs   # 真实桌面 Chrome
node scripts/probe-component-host.mjs          # 既有 v1 回归
```

### 结果

工程检查（全部实际运行，非推算）：

| 检查 | 结果 |
| --- | --- |
| 类型检查 / 构建 / 公开契约浏览器检查 / 文档链接 | 通过 |
| `@xunjie/web` Vitest | 61 文件 709 项通过；其中新增准备桥接 5 项、准备 Module 11 项 |
| 服务端原生集成（PostgreSQL 18.6 + 产品运行时） | 2 项通过：版本 1 原路径；版本 2 导入、依赖读取、报告、重启与损坏资源处置 |
| 新验收探针（桌面 Chrome，本机 Windows 11 x64） | 13 项通过，见下 |
| 既有 v1 宿主探针 | 15 项通过，未回归 |
| 服务端本地套件 | 75/78 通过；3 项为 Windows 平台限制（见下） |
| product-runtime 本地套件 | 14 个文件中 12 个通过；`connections.test.ts` 单独重跑 31/31 通过（并发下的时序抖动） |
| storage 本地套件 | 除 Windows symlink 一项外通过 |
| checks 组 | 7 个文件中 6 个通过；`ci-build-artifact.test.mjs` 在基线 `60f58c5` 上同样 5/5 失败（GNU tar 把 `C:` 当远程主机） |

新探针覆盖：导入不改变主前端产物；冷准备真实取得/校验/自检并激活单一环境；独立自检不产生学生作品；生产 iframe 真正以脚本执行交付字节并定义声明全局；真实库对中文字段多处匹配计数并还原正文；热重开命中记录与缓存且不重跑自检；报告经生产路由进入 PostgreSQL 并记录真实设备；中断后按原 `preparationId` 继续；依赖取不到只关闭高亮、标注与持久化继续并显示就近原因；准备存储失败不挂载、不宣称就绪、已确认作品无损；版本 1 发布仍走原路径且不建准备环境；浅色/深色/窄桌面截图；失权同时关闭依赖路由。

### 未执行或未通过项

- **Apple Silicon Mac**：本机无该设备，未运行；不作为通过。
- **教学效果**：未评估，不作通过结论。
- **Windows 平台限制导致的既有失败**（不在本票写集内，未修改）：
  - `apps/server/tests/account-control.test.ts`：`local-socket.ts` 的 `s.uid !== process.getuid?.()` 在 Windows 恒为真（uid 为 0，`getuid` 未定义），必然 `LOCAL_SOCKET_CONFLICT`。
  - `apps/server/tests/application-database.test.ts`、`packages/product-runtime/test/recovery-files.test.mjs`、`packages/storage/test/blobs.test.mjs`：本机创建符号链接返回 `EPERM`（需开发者模式或提权）。
  - `packages/product-runtime/test/lifecycle.test.mjs`：清理临时目录时 `EBUSY`（Windows 句柄未释放）。
  - `scripts/ci-build-artifact.test.mjs`：GNU tar 解析 `C:` 为远程主机；基线同样失败。
- `connections.test.ts` 在并发全量下偶发时序失败，单独重跑通过；未用放宽断言掩盖。

### 已知取舍

- 原有全有或全无自检缓存已在复审中修复，见下方修复验收记录。
- 准备报告表不设容量上限，读取按提交时间取最近 50 条；清理与跨 owner 恢复仍归 #176。
- 浏览器准备缓存只在本机有效，未进入服务器备份；恢复后重新探测设备并重读依赖字节，恢复报告不能激活环境。

## 2026-11-03 复审与修复验收

审查固定点为 `60f58c5`，审查实现提交 `219bb4c`，只改本票写集；原有 `tools/xj-dev/xj-dev.mjs`、`apps/student/` 和 `course_matrial/data_logic/.gitignore` 保持未暂存。未修改 `.env`、密钥、CI 或 PostgreSQL schema，未新增迁移、PR、main 合并或生产部署。

### Standards

独立标准审查没有发现 owner 归属、公开依赖方向、目录或设计 token 的硬性违反。发现 1 项判断性建议：准备桥接重复实现规范化摘要；本轮已复用本准备 Module 的 `fingerprint`，没有扩大为全仓重构。最主要标准风险是相同身份计算代码日后漂移，当前重复已收敛。

### Spec

独立需求审查发现 5 项：自检加载漏掉超时、生产依赖加载失败未降级/未正确核对回执、存储故障冒充记录不存在、检查缓存失效过宽、Mac 缺少可执行交接。最严重项是视图加载无限等待，导致准备持锁无法恢复；本轮全部修复，并补齐[Mac 交接](../wp03-171-mac-handoff.md)。Mac 实际运行仍待真实设备，文档完整不等于平台验收通过。

主审另通过公开 Module 回归复现并修复首次并发双身份、热缓存损坏、固定报告重试内容漂移；复核又补齐激活原子性及统一总准备期限。最终独立复核没有发现新的阻塞缺陷。

### 代码行为变化

- 按稳定 scope 在分配身份之前加锁，旧准备原 requestId 保持；两个冷标签共享原身份。缓存缺失/损坏重新取得原固定字节，沿同 preparationId 继续。
- 准备查询或身份列表读取失败不再当空记录。没有已确认环境时，能力投影为不可用/未核实；实际设备变化也不能读取旧环境的能力。
- 以相依能力组复用自检，组内按原顺序使用临时状态；指纹包含实际代码、公开输入、设备和相关依赖，不再以整个定义版本使所有组失效。
- 报告完整 payload 在发出前持久固定；丢 ACK 重放相同 reportId/requestId/内容，后来观察另用新身份。预览报告正确标记 `preview`；上传是激活后的独立诊断阶段，单次最多等待 5 秒，不决定本机能力。
- 总准备截止时间覆盖取得与自检，自检自身预算也约束 iframe 加载、握手和步骤；超时/畸形/超消息预算的观察不激活环境。加载明确失败只关闭相关依赖能力；失败的临时状态复位不能被忽略。
- 最终准备记录及环境指针在同一 IndexedDB 事务提交，事务失败不提前挂载、不留下新指针；没有新增浏览器库版本或迁移。
- 生产加载核对连接、实例和原消息身份，等待真实加载观察；错误或超时就近关闭受影响能力。降级状态增加「按原准备身份继续」，使用 `workspace.leave()` 等待在途输入及本机保护；失败保留原 iframe 和可复制输入。未重排产品布局。
- 新旧 Chrome 探针均按实际系统记录 Mac 状态，允许通过环境变量隔离输出；新探针同时记录实际源码版本、相关源码脏状态/摘要、冷准备耗时及资源量。

### 本轮验证与证据

定向回归最初新增 5 项全部失败，分别捕获缓存无法恢复、双身份、报告重试变动、读取失败返回 null 和下载无限等待；修复后通过，并补充无环境能力与总期限测试。没有通过放宽原断言或替换真实计算来获得通过。

- 工程：全 workspace 类型检查、Web 构建、正式 `web:runtime` 构建及 11 个公开契约浏览器检查通过。Web Vitest 61 个文件、716 项通过；准备 Module 18 项加准备桥接 5 项通过。
- 原生：真实 Node 24.21.0、PostgreSQL 18.6、产品 owner/资源集成 2/2 通过，未使用受控接收器替代依赖资源或准备报告。
- 浏览器：Windows 11 x64、Google Chrome 156、非 headless。新准备探针 18/18 通过，包含实际库、冷/热准备、缓存损坏修复、冷双标签、自检加载超时/恢复、生产加载错误降级、激活事务中止/继续、作品保护、v1、主题/窄桌面及撤权；v1 完整宿主探针 17/17 通过。
- 既有正式 UI/作品编辑 Chrome 回归：`productUi.spec.ts` 与 `worksEditor.spec.ts` 共 24/24 通过（`chrome --headed`），覆盖导航、固定问题、迟到确认、存储失败、双标签和原内容保留；不作为真实 Agent 或教学效果证据。
- 文档：全库 173 份 Markdown、1381 个本地目标、0 失败；差异格式检查通过。
- 本轮正式资源组合从 `apps/web/dist-runtime`、原生 PostgreSQL 18.6 和同一候选源码装配；不是独立分发安装包复验，也不声称学校真实跨机连接已经补验。最后一轮准备报告和截图在本机 `.verification/wp03-171-review-delivery/`，v1 报告在 `.verification/wp03-169-review-final/`，不提交临时产品 root 或凭据。
- UI 对照来自实际 Chrome：修复前 `.verification/wp03-171/prepared-degraded-light.png`，修复后 `.verification/wp03-171-review-delivery/prepared-degraded-light.png`；生产加载错误另见 `production-load-failure-light.png`。变化只增加就近恢复入口与真实失败降级，不另造页面；已核对浅深色及窄桌面。

保留运行失败记录：首次原生集成及首次根类型检查误用系统 Node 24.15.0，产品版本校验拒绝；改用既有固定 24.21.0 后通过。一次并行构建在 Windows 缓存锁文件 rename 时返回 EPERM，串行重跑通过；未修改构建锁或绕过版本校验。既有大 chunk 和 Zod PURE 注释提示仍存在，构建成功不等于消除这些提示。

**Windows 系统中文输入法补验（2026-11-03）：** 在 `e49e6e4` 的独立本机产品环境和桌面 Chrome 中，负责人使用系统拼音候选窗选词，确认刷新并重新打开材料标注后文字完整。通过生产作品接口核对，笔记实际保存为「观察与解释」。证据保存在本机 `.verification/wp03-171-ime-confirm/`，独立测试环境已停止。

**剩余验收：Apple Silicon Mac（含系统输入法）与真实学校跨机连接。** 两条路径由 [补充验收 #181](https://github.com/paher-din/XunJie/issues/181) 跟进。教学效果未评估，#171 保持开放。

2026-11-03 本轮补验最终固定到 `6171351`，实际结果见 [#179 / #181 Mac 与真实学校验收](../wp03-mac-school-acceptance.md)。新完整 Mac 产品包的 CLI、18 项准备、26 项宿主和 25 项正式 UI/编辑器已通过；冷准备 39 ms / 16917 依赖字节，热开不重新取得依赖。直连学校新增路由已补环境/空间/主体绑定反例，真实停服另补公共预连接与排空回归。Mac/Windows 学校网页各 13 项、安装客户端各 15 项均通过，所属环境与新增规则已清理；当前仅待真实 macOS 系统 IME，两票保持开放。
