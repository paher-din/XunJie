# UI-PREP-07：当前学生端依赖审计与精确修复提案

核查日期：2026-10-15（Asia/Shanghai）；主责 UI / Robert。基线 `i0/ui-frontend` / PR75 merge `37b628b75ec3a2238b9b77c8bd1882d36a2e55a6`。范围与授权见[本轮任务 §1～2](../../../I0-UI_PREP_04_07_08_CLOSEOUT.md#2-写集方案与完成判据)。本项交付是当前审计和修复方案；下列升级与构建映射均为**待负责人确认的提案，未实施**。

## 1. 结论与可核查输入

完整 audit 报6个包级条目（2 critical、1 high、1 moderate、2 low）；`--omit=dev` 报2个 low 包级条目，即 `monaco-editor → dompurify`。按公告URL去重也是6条，但这不表示6条已经证明可利用的漏洞：严重度是 registry 对依赖条目的归类，包级条目包含上游传播。两个结果均成功取回结构化数据、进程退出1；这里的1是发现通报，不是网络失败，亦不算审计通过。

实际锁定 `vitest 3.2.7 / @vitest/mocker 3.2.7 / tinypool 1.1.1`、`vite 7.3.6 / postcss 8.5.28 / source-map-js 1.2.1`、`monaco-editor 0.57.0 / dompurify 3.4.15`；`npm ls --all --json` 退出0，8个相关包安装版本与lock一致。当前采样命令使用 Node `24.15.0`、npm `11.12.1`；项目说明要求 Node24，后续工程回归沿现有正常Node24运行环境，不据此次只读审计切换运行时。

| 输入/证据 | SHA-256或结果 |
| --- | --- |
| [package.json](../../../../../apps/student/package.json) | `dda67530bda121133858f9d70097fa4326471c17dba000e09075697a616b7abd` |
| [package-lock.json](../../../../../apps/student/package-lock.json)，lockfileVersion3 | `8c9a86c6951c26f6378002d39caa9ab7250c0fd066efb0abb5104afb776750e9` |
| [完整audit同值LF JSON](audit-full.json)，采样完成于2026-10-15 00:00:23 +08:00 | 公开6329 bytes；`254e0ed3df2d3e9bad046ad8ab8cde8679138697196a1fd77dae398ac535d0bc`；原CRLF输出6571 bytes/`7ae1e073ecafb36a4ea4859a1a80ded02935958c7968a5008ca2c51fcb97c4cf`另留存 |
| [运行时audit同值LF JSON](audit-runtime.json)，采样完成于2026-10-15 00:00:20 +08:00 | 公开2219 bytes；`d3fe350428b0e597ec53f08f322c1bf522e89d6911aaf64a08958198ba794df6`；原CRLF输出2310 bytes/`019fe7b81b7bb045974b8d6d2461dd77cd8b3d94eee26a9add65e085bd00aca8`另留存 |
| [摘要/锁定路径/源码摘要](audit-summary.json) | 含所有6公告、版本、integrity、命令退出值、未执行与网络读取限制 |
| [精确候选的registry返回](registry-candidates.json) | 8次明确版本/标签查询均退出0；不含npm配置或凭据 |

audit metadata 的 prod43、dev152、total195是其依赖分类；optional54是子集，不能再相加成249。完整安装树、原始 `npm explain` 和查询 stderr 留本轮本机证据区；可协同依据是上表已入库的固定摘要与JSON，不要求其他成员访问个人磁盘路径。

发布前原始Git暂存检查把Windows stdout的CRLF判为新增尾随空白。仅这两份本轮JSON的外层换行规范为LF；逐解析值完全相等，且把公开LF恢复成CRLF可逐字节重建原捕获输出。原字节未改，摘要`capturedRaw`保留原bytes/hash、`presentationNormalization`列公开转换；上表现在区分两种表示。不改公告、时间、范围或计数，没有为此重跑audit。

## 2. 每个包级条目及实际路径

| audit条目/等级 | 固定依赖路径与实际用途 | 公告和可达性判断 |
| --- | --- | --- |
| `@vitest/mocker` moderate | dev：`vitest 3.2.7 → @vitest/mocker 3.2.7`；Vitest内置mock读取 | GHSA-82fw-gwwq-j7x9，详见§3。当前配置是Node测试，没有启用Vitest Browser Mode或把 `mockerPlugin/interceptorPlugin` 作为应用插件；所述公开注册通道未在固定应用配置发现。没有进行网络攻击复现，潜在其他开发启动方式未知 |
| `vitest` critical | 直接dev；`npm test` 为 `vitest run`；[Vite配置](../../../../../apps/student/vite.config.ts) 从 `vitest/config` 导入 `defineConfig`，因此迁移也要核正常build/prep/real启动 | 等级由mocker及tinypool依赖传播，不是另一个独立critical公告。属于维护者/测试进程，不随学生浏览器业务执行；仍须修复测试工具链 |
| `tinypool` critical | dev：`vitest 3.2.7 → tinypool 1.1.1`；Vitest内部forks/threads worker池 | GHSA-5gmw-xhrv-c9v3、GHSA-85c8-ppgw-ccpr。需已有 `Object.prototype` 污染，不能由包存在推出RCE。本机Vitest在构造worker时有自身env/execArgv，但 `pool.run(data, {name, channel})` 的选项无自身filename，第二条gadget形状确实存在；未发现/未穷尽证明上游污染源，也未执行污染或恶意worker |
| `source-map-js` high | dev：`vite 7.3.6 → postcss 8.5.28 → source-map-js 1.2.1`；PostCSS `previous-map.js / input.js / map-generator.js` 使用SourceMapConsumer/Generator | GHSA-68fv-2mgg-jv7q；攻击输入是畸形indexed source map，不是普通学生C文本。实际构建器会处理已有CSS map；未在学生业务上传链发现把作品当CSS/map交给它的通路。恶意第三方CSS/map或构建输入仍属工具链暴露，未进行CPU/内存耗尽复现 |
| `dompurify` low | runtime：`monaco-editor 0.57.0 → dompurify 3.4.15`；Monaco还内嵌同版实现，见§4 | 两条公告均需要 `IN_PLACE` Node输入；当前Monaco调用使用字符串净化、RETURN_DOM_FRAGMENT或RETURN_TRUSTED_TYPE，未启用IN_PLACE。前提未在所读调用图发现；没有据此宣布依赖无风险 |
| `monaco-editor` low | 直接runtime；单栏编辑、diff比较、语言注册、worker、提示/消息中的Markdown净化 | 等级由DOMPurify传播。当前审批精确锁0.57.0，不能因audit推荐直接降级；目前官方latest仍0.57.0，尚无经确认包含3.4.16的后续稳定Monaco候选 |

应用自身[聊天Markdown](../../../../../apps/student/src/components/chat/Markdown.tsx)用 `marked` lexer与React节点，原始HTML/图片按文字兜底，不走DOMPurify或HTML注入。`dangerouslySetInnerHTML` 另出现在固定导入SVG图标，不是本次DOMPurify调用路径。这些只用于定位本次通报，不构成整站XSS评审。未因audit无通报而宣布marked、remend、React或其他依赖没有潜在缺陷。

## 3. 逐公告官方核对

| 唯一公告 | 当前lock命中与必要前提 | 官方修复及来源差异 |
| --- | --- | --- |
| [Vitest GHSA-82fw-gwwq-j7x9](https://github.com/vitest-dev/vitest/security/advisories/GHSA-82fw-gwwq-j7x9) | vitest/mocker `>=2.1.0 <4.1.11`，本项目3.2.7命中。需触及开发服务mock注册通道后请求redirect mock；公开插件的HMR WebSocket与Vitest Browser Mode的token RPC不同 | 4.1.11；5预发布修于5.0.0-rc.2。官方说明2/3旧线不回补；[v4.1.11 release](https://github.com/vitest-dev/vitest/releases/tag/v4.1.11)、[修复PR10974](https://github.com/vitest-dev/vitest/pull/10974)核redirect目标的server.fs边界并关闭原始Browser注册事件 |
| [Tinypool GHSA-5gmw-xhrv-c9v3](https://github.com/tinylibs/tinypool/security/advisories/GHSA-5gmw-xhrv-c9v3) | `<=2.1.0`，本项目1.1.1命中；已有prototype污染后，继承execArgv/env可成为执行gadget | 修于2.1.1；[v2.1.1](https://github.com/tinylibs/tinypool/releases/tag/v2.1.1)、[PR134](https://github.com/tinylibs/tinypool/pull/134)。仓库公告High，当前[Reviewed数据库](https://github.com/advisories/GHSA-5gmw-xhrv-c9v3)为Critical；保留来源差异 |
| [Tinypool GHSA-85c8-ppgw-ccpr](https://github.com/tinylibs/tinypool/security/advisories/GHSA-85c8-ppgw-ccpr) | 当前npm/Reviewed `<2.1.2`，1.1.1命中；已有prototype.filename污染，调用run第二参数且参数无自身filename | 修于2.1.2；[v2.1.2](https://github.com/tinylibs/tinypool/releases/tag/v2.1.2)、[PR135](https://github.com/tinylibs/tinypool/pull/135)。仓库公告仍写<=2.1.0/High；[Reviewed数据库](https://github.com/advisories/GHSA-85c8-ppgw-ccpr)为<2.1.2/Critical，npm此次CVSS数值0；不静默统一范围/等级/数值 |
| [source-map-js GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) | `>=1.0.0 <1.2.2`，1.2.1命中；indexed map section巨大offset等形状阻塞事件循环或耗内存 | 修于1.2.2；维护者[PR79](https://github.com/7rulnik/source-map-js/pull/79)与[固定修复commit](https://github.com/7rulnik/source-map-js/commit/cf7658058ceeaa8619d5ae0ec90be6905209d016)已合，精确registry版本查询退出0 |
| [DOMPurify GHSA-p98j-92pf-mc4p](https://github.com/cure53/DOMPurify/security/advisories/GHSA-p98j-92pf-mc4p) | `>=3.4.13 <=3.4.15`，3.4.15命中；IN_PLACE配合会移除非根节点的afterSanitize hook，脱离子树事件属性残留 | 公告结构化patched version为3.4.16；正文“截至3.4.15未修”是较早描述。由[3.4.16 release](https://github.com/cure53/DOMPurify/releases/tag/3.4.16)对应hook修复与registry返回交叉核对，不沿用旧正文“无修复版” |
| [DOMPurify GHSA-6688-9rhm-gjv2](https://github.com/cure53/DOMPurify/security/advisories/GHSA-6688-9rhm-gjv2) | `<=3.4.15`，3.4.15命中；IN_PLACE移除rawtext根后返回节点，调用方把其序列化再按HTML重解析 | patched3.4.16；同一[官方release](https://github.com/cure53/DOMPurify/releases/tag/3.4.16)列raw-text修复。单纯appendChild与重新解析HTML的前提不同；没有将该机制解释成普通React文本渲染可利用 |

## 4. Runtime修复不能只看audit变绿

固定安装文件 `node_modules/monaco-editor/esm/vs/base/browser/domSanitize.js:4` 导入 `./dompurify/dompurify.js`，不是裸包 `dompurify`。该内嵌文件首行license和第473行version均为3.4.15，SHA `493e9f430fbdde595f9e12ff46aa5b3606a514d5c8556eb144da69612f77fc8e`；详见[audit-summary](audit-summary.json)。已有dist的 `markdownRenderer-8dBYP_FZ.js` 也含3.4.15，SHA `6f1daf47f54a5b2b65f32142d85426609b9d53a4d7bb854d441faf9f35974d63`。本项仅读现有dist，没有重建或另绑定其sourceCommit。

因而仅新增 `overrides` 把registry依赖换成3.4.16，不能替换内嵌代码。audit建议的0.56.0降级是包范围解算结果：精确registry元数据锁DOMPurify3.4.8，仍落第二条公告范围；且本项目依赖0.57分拆exports、`editor/editor.api`、`features/*/register`、C语言id等，降级兼容未验。不采用降级来消除audit计数。[Monaco官方release列表](https://github.com/microsoft/monaco-editor/releases)及本次registry latest都为0.57.0。

**runtime具体候选：保留Monaco0.57.0，使用精确DOMPurify3.4.16，同时保证Monaco内嵌导入真正映射到该官方ESM实现。** 若负责人选择立即修复，提议写集为学生端package/lock和Vite构建映射及相应验证，依旧不改教学业务、后端或数据库：

1. 在学生根package中按Monaco0.57.0限定DOMPurify override到 `3.4.16`，使锁树也反映真实补丁；不覆盖其他依赖或直接改node_modules。
2. 构建映射仅针对上述Monaco sanitizer内嵌导入，指向该3.4.16官方ESM模块，保留default export、Trusted Types恢复、RETURN_DOM_FRAGMENT及license；其他导入不改。可用Vite alias/customResolver实现，但具体API/产物兼容尚未实际验证，不提供“已经能用”的假结论。[npm overrides](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#overrides)、[Vite resolve.alias](https://vite.dev/config/shared-options.html#resolve-alias)
3. 用模块解析/最终chunk字节证明旧内嵌3.4.15没有进入实际加载链；新3.4.16只在测试安装树或npm树出现不算修复完成。若局部映射无法保留以上行为，停止该候选，不静默换编辑器或复制未追溯vendor文件。

另一条是接收后续**经实际发布和内嵌字节核对**、包含DOMPurify>=3.4.16的Monaco稳定版。当前不存在已核实的精确Monaco版本，不能写虚构的0.57.1/0.58.0或预先标通过。若负责人暂选等待，只记录已定位触发前提与未更新，不关闭runtime修复。

## 5. Dev工具链精确提案与回归范围

| 组/建议顺序 | 精确候选与拟议写集 | 兼容证据/待验证 |
| --- | --- | --- |
| 1：source-map-js | 保留Vite7.3.6/PostCSS8.5.28；仅把传递 `source-map-js 1.2.1 → 1.2.2` 锁定。当前PostCSS声明 `^1.2.1` 已允许；优先窄更新lock，只有无法保持精确解算时才提议限定override1.2.2 | 补丁更新、Node engine>=0.10，当前Node24在范围。无新增业务依赖/主版本；安装与实际CSS构建未执行 |
| 2：Vitest整组 | 根dev `vitest: 4.1.11` 精确替代3.2.7，lock中同组 `@vitest/*` 同步4.1.11；保留Vite7.3.6，不添加Vitest UI/browser/coverage依赖。本组跨主版本，须确认迁移范围后实施 | [4.1.11 package.json](https://raw.githubusercontent.com/vitest-dev/vitest/v4.1.11/packages/vitest/package.json)与registry：Node `^20 || ^22 || >=24`、Vite `^6 || ^7 || ^8`兼容当前声明。官方4.1线仍收重要/安全修复；4已移除Tinypool。lock新树是否确实消除Tinypool路径须在实施后核实 |
| 不采用：仅override Tinypool | 2.1.2可独立修两条gadget，Node `^20 || >=22`；但它超出Vitest3声明 `^1.1.1`，且不修mocker | 不用跨主版本传递override代替Vitest整组迁移；元数据兼容不代表Vitest3 worker行为兼容 |
| 不采用：audit fix强制推荐5.0.4 | npm返回Vitest5.0.4/isSemVerMajor=true；确有该稳定版，Node/Vite声明覆盖本项目 | 已有受维护4.1.11满足本次三条通报，直接3→5扩大迁移不必要。[支持策略](https://vitest.dev/releases)、[4.1.11 release](https://github.com/vitest-dev/vitest/releases/tag/v4.1.11) |

Vitest4迁移正文要求核pool与mock变化。[官方3→4迁移](https://v4.vitest.dev/guide/migration.html)明确移除Tinypool/poolOptions，改变部分spy恢复、构造器mock及默认排除规则。本项目test只有Node环境和显式 `src/**/*.test.ts/js`、`prep/**/*.test.ts` include；未使用poolOptions/workspace/Browser Mode/coverage配置。现有 `vi.hoisted / vi.mock / vi.fn / vi.clearAllMocks` 的同步/异步模块替身与调用序列仍需实际全部单元回归，不改原断言、skip或收窄include以迁就新版本。因为Vite配置依赖 `vitest/config`，build和开发启动也纳入本组回归。

以下命令是**获准实施后的验证清单，本次未执行升级验证**，在 `apps/student`：

```sh
npm ls --all --json
npm ls vitest @vitest/mocker tinypool vite postcss source-map-js monaco-editor dompurify
npm audit --json
npm audit --omit=dev --json
npm run typecheck
npm test
npm run build
```

source-map-js补丁先核正常CSS产物与prep/real启动、无map处理失败和端口释放；不因工具链补丁重跑远端C1/模型。Vitest组覆盖现有完整单元（PR75已有464项是基线证据，升级后实际数量/退出值另记）、类型、正常build和两个原开发入口一次启动关闭；专项通过后不无理由多轮重跑业务服务。

runtime构建映射需要匹配编辑器风险的现有浏览器专项：`npm run test:e2e -- e2e/editor.spec.ts e2e/editorProtection.spec.ts e2e/compare.spec.ts e2e/fileHistory.spec.ts e2e/keyboardWorkflow.spec.ts e2e/tutoringReturn.spec.ts`。核懒加载/worker、打开/切文件/原文/undo、只读diff、返回焦点与保留模型。辅导Markdown与Monaco提示净化、Trusted Types失效恢复和两公告相关调用前提的有界安全反例也须验；这是未来实现所需验收，不把本次静态查源码或旧浏览器证据计新补丁通过。真实IME按UI-PREP-04单独记录，不能用文本insertText替代。

## 6. 本次执行、失败与未执行

已执行：full/omit-dev audit、完整npm ls、4包npm explain、8次官方registry精确候选查询、lock/已安装版本/用途与相关调用源码、现有build内嵌版本读取、官方公告/release/迁移核对。package/lock SHA首尾一致，相关源码/构建配置只读，未安装、更新、降级或自动修复。07原判据的审计/区分/精确方案已交付，依赖修复本身保持待批准/未执行。

网络读取限制：web reader打开source-map-js `releases/tag/1.2.2` 返回404，改用官方已合PR79/固定commit和成功的npm精确查询；web reader读取两个registry单版本URL返回Internal Error，native `npm view --registry=https://registry.npmjs.org` 均返回0，保存原始元数据。后台一手核查也无法用web reader读取registry，已由主审计native查询交叉核对；不把web fetch失败描述成版本不存在或npm audit网络失败。

本机静态定位有两次可纠正读错路径：在student目录用仓库根相对路径搜索规范，以及把聊天Markdown误读为 `src/components/Markdown.tsx`；随后分别按仓库根与 `src/components/chat/Markdown.tsx` 重读。首次宽搜索/完整lock输出被截断，后续窄读取/结构化提取补齐；不依赖被截断输出判断完整性。这些是取证工具失败，不是应用缺陷。

未执行：npm install/ci、audit fix、锁树改写、升级后的typecheck/build/单元/浏览器、恶意输入/原型污染利用演示、SSH/模型/CI或远端环境动作。未修依赖、未宣称零漏洞、未提交Git/创建PR/对外发送交接。产品或整体安全验收不由本项替代。
