# I0-A：正常宿主 readiness 503 修复

日期：2026-10-14。负责人：A。状态：实现与37/37专项回归通过，交付分支为 `codex/i0-host-readiness`；固定源码以承载本文件的提交/PR head 为准，PAHER现场复验未执行。

## 依据与范围

用户要求处理 C 回交的宿主 `/health/ready` 503。固定 main 基线为 `eea962322ace4a1fd3dc86ce531adf5711552da9`。
C 的[原始回交](https://github.com/paher-din/XunJie/issues/30#issuecomment-6161397303)指出：原业务源 `9fa76ad` 的严格 TLS 20 项通过，但健康请求实际 503，不计通过；C/HDL 节点 ready 不能代替 HTTP 宿主就绪。

已读 AGENTS、README、PRD §3.2/4.1–4.3、MVP_SPEC M-09/M-10、§4–5，以及 TECH_DESIGN §10.1–10.2、TEAM_WORK_PLAN §3.1、I0-B_HOST_COMPOSITION 全文，当前 main/app/I0 消费与关停、数据库事务和原 runtime 验收接缝。适用 M-09/10、AC-06/12、NFR-04；本次不宣称完整 AC/NFR 验收。

可写：`apps/teaching/server/app.ts`、`server/app/i0.ts`、相关健康/宿主测试、本任务记录与本人协调清单。README 仅同步实际健康使用说明。产品、规划、规范、参考文档只读；MVP_SPEC §10 待授权维护者汇总。保留现有未跟踪材料，不暂存或提交其他任务。

不改 schema、原 24/28 表工厂、B/C 契约、执行指纹/代际判据、运行参数、凭据、配置、CI 或 UI；不维护执行节点或调用模型。本地合成验证沿原获准工厂创建并保留测试库，不迁移既有库。实现完成后，用户于2026-10-14明确要求“推送”，批准发布本修复、测试及任务证据；不包括部署/合并、库文件、其他本地材料或扩大现场操作许可。

## 修复方案与验收

根因是 `createApp` 的 readiness 无条件拒绝，I0 装配没有检查入口。保留无业务配置的默认 503；增加内部可选检查回调，仅 I0 正常组合装配，成功沿原 requestId 信封返回 `data.status=ready`，失败沿原安全错误信封，响应禁用缓存。

I0 每次查询必须满足：宿主接受业务且原消费者已启动、必需扫描最近完成成功；数据库实际短事务可用；原 `availableRuntime` 验证当前节点 ready/profile/验收指纹，并与受控恢复代际一致。外部等待在事务外；查询结束重核宿主/消费者、数据库和代际，防止在途检查跨关停或数据库失效返回 200。执行器缺失/失联/证据不符仍拒绝 ready，编辑与保存沿原独立接口降级，不封锁整个应用。模型故障不作为 readiness 前提，不调用供应商试探或将配置存在宣称为模型通过。

健康查询等待限定 5 秒，只限制健康响应，不修改 C transport/作业运行参数；超时返回原依赖不可用，迟到结果不将响应改为成功。关停立即撤销 readiness，包括直接关闭 Fastify 时的 preClose 生命周期。消费者扫描失败撤销就绪，原扫描恢复成功后重新可用；原作业自身失败不等同于扫描循环故障。

验证：先用公开 HTTP 健康入口复现当前正常组合仍 503；覆盖健康组合 200、未启动消费者、数据库故障、扫描失败/恢复、ready=false/错误验收 hash/代际不符/断线、等待超时、在途关停与数据库失效、模型禁用但作品链可用。复用原正常宿主/教学消费者/默认健康入口/错误与启动回归；Node 24.21.0、原锁依赖，typecheck/build 与文档检查。未执行的 PAHER 严格 TLS/真实 C1/UI 验收单列给 C/UI 回交，不以本机合成结果替代。

## 实际结果与交接

实现位于 [基础健康入口](../../apps/teaching/server/app.ts)、[I0正常组合](../../apps/teaching/server/app/i0.ts)，新增 [8项readiness专项](../../apps/teaching/server/app/i0-readiness.test.ts)。原消费者仅增加扫描健康记录和preClose就绪撤销，原Job的身份、执行、停止与持久接纳未改。

验证使用 Windows x64 / Node **24.21.0**、与main锁文件哈希一致的既有依赖，在独占隔离副本执行；实际运行日志与三份测试源码哈希见[验证清单](evidence/i0-a-host-readiness-20261014/verification.json)。发布日志按Git LF字节保存，`bytes/sha256`对应仓库文件；`recordedBytes/recordedSha256`保留原Windows日志字节摘要，原输出未改写。源码`sha256`对应实际测试工作树，`gitNormalizedSha256`对应Git LF源码。复用已有student dist只核原静态读取行为，不作为当前PR #57页面构建/浏览器验收。首次复制测试用了错误相对路径，测试未加载，保留 `red-setup-failed.txt`；纠正执行路径后开始真实复现。

| 验证 | 命令/结果 | 覆盖与边界 |
| --- | --- | --- |
| 修复前复现 | `node --test --test-name-pattern='host readiness requires the original consumer' --test-reporter=tap server/app/i0-readiness.test.ts`：0通过/1预期失败 | 已启动消费者的健康宿主仍503，断言“Healthy host did not become ready”；不是依赖加载失败 |
| 最终类型检查 | `node node_modules/typescript/bin/tsc --noEmit`：exit0 | 包含全部新增测试；使用原运行时检查和原严格配置 |
| 最终构建 | `node node_modules/typescript/bin/tsc -p tsconfig.build.json`：exit0 | 原main用于随后启动专项，没有放宽类型或运行时检查 |
| 最终组合回归 | `node --test --test-concurrency=1 --test-reporter=tap server/app/i0-readiness.test.ts server/app/i0.test.ts server/app/i0-tutoring.test.ts tests/app.test.ts tests/errors.test.ts tests/startup.test.ts`：**37总/37通过/0失败/0取消/0跳过** | 新8项、原I0 10项、教学宿主6项、基础健康3项、安全错误6项、启动4项。原作品离线保存/重放/暂停、自动Job与取消/未知重启、真实HTTP监听和关停均保持；最终超时反例另断言确已进入挂起的runner查询，避免误把其他503判据当超时通过 |
| 保留库 | 最终组合26个新SQLite实查：24表18个、28表8个，全部`integrity_check=ok` | 仅读sqlite_master与一致性，不读账号/业务行；不公开SQLite文件，不把旧轮库累计进此统计 |
| 文档/空白 | 根目录 `node tools/a0-review/check.mjs` 改前/改后exit0、errors=[]；`git diff --check`通过 | 修改本人清单正文及README使用说明；保护基线未改 |

负例覆盖：消费者未启动、缺runner、ready=false/错误hash/未来验收时间/profile不匹配/错误代际/断线、SQL事务失败、运行或教学扫描失败与恢复、五秒无响应、检查途中数据库失效/代际变化/service.close或直接app.close。健康探测不产生Job/Attempt/Receipt/Event/Session，不调用provider。模型关闭时正常Session仍可读取；原I0回归另覆盖执行器离线时保存。

与C原业务源`9fa76ad`相比，当前main的 `runner/` 和 `contracts/runner/` 无差异；本修复也不修改指纹输入。因此不要求C为本补丁维护节点或重登记指纹，但现场仍必须实读当前性。代码审查核对：网络在事务外，响应前重核本地条件；超时/迟到/关停没有200分支；响应不包含配置路径、私钥、账号、会话或原节点证据。未装配业务时的默认503保持。

当前未执行：PAHER实际严格TLS与C1回读、本批整个应用全量、并发负载/NFR、WSL/VM重启、实际浏览器、真实模型及真人验收。验证清单中的 `remotePublication=false` 是运行验证时的事实，本次随后获准推送不改写该原记录。未发布Issue评论、未改变PAHER当前服务；本人协调清单的正文更新保留本地，未将其依赖的其他任务材料混入本次交付。产品基线/MVP_SPEC §10待授权维护者汇总。

## C接收修复后的具体回交

1. C从 `codex/i0-host-readiness` 所在PR取得固定head与本记录/证据，接收完整固定应用源码；不要把两份应用文件直接覆盖进旧`9fa76ad`源码树。沿原Node24.21.0/lock进行typecheck/build，保留旧副本。当前main含教学宿主组合，仍允许原24表、无`tutoring`的现有配置；不切35表，不重复初始化库。A的Windows测试源码哈希按实际工作树字节记录；Linux接收按固定Git对象核原LF字节，不把换行差异当业务源码变更。
2. C在已有准确许可覆盖的PAHER窗口，引用原受控TLS/签名、配置、保留库、generationFile与application SSH/pinned known_hosts启动正常main及原消费者。不替换凭据、关闭TLS检查或修改执行节点。记录实际应用SHA/Node及本批配置来源；未覆盖操作先列准确对象给负责人。
3. 使用原严格Node TLS客户端检查 `/health/live` 200，以及 `/health/ready` **200、`data.status=ready`、新requestId、`Cache-Control: no-store`**；同时回交当前C readiness/验收指纹/代际一致的去敏摘要。若仍503，交请求时间、HTTP状态/安全error code、当前消费者及依赖状态，不写固定true或隐藏失败。无需重跑已完成整20项来证明旧结果。
4. 复用原合成账号正常登录、读取新合法Assignment/bootstrap与Attempt，确认新宿主仍接原持久库和对象；不手工processJob，不创建替代对象补结果。保留启动/就绪/关停事实与原输出引用，交A实审→UI据当前窗口接线。关闭后连接不可达是停止事实，不记为“HTTP返回503”；关停在途请求拒绝由本批专项已验。

浏览器信任/账号新通道、页面验收、DL-A35表HDL组合及完整G/AC/NFR门禁仍按各自原范围推进，不由健康修复关闭Issue #30/#38。
