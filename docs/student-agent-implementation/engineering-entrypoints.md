# 工程入口与 WP01 接入交接

本页承接 [#146：工程目录、公共契约与构建入口整理](https://github.com/paher-din/XunJie/issues/146)，供 [#143：产品安装、独立环境与部署连接](https://github.com/paher-din/XunJie/issues/143)和 [#144：PostgreSQL 事务与服务资源存储](https://github.com/paher-din/XunJie/issues/144)接入。该任务记录工程入口的最初整理；当前 Agent 包职责与测试入口以下文和对应包 README 为准，不沿用历史任务状态作为本轮验收结论。WP01 原始职责见 [WP01 规范](specs/wp01-product-runtime-and-data.md)。

## 当前工程入口

| 入口 | 当前职责与接入方式 |
| --- | --- |
| [apps/web](../../apps/web/package.json)，`@xunjie/web` | 师生共用浏览器应用；页面与权限投影区分身份。[运行说明](../../apps/web/README.md) |
| [apps/server](../../apps/server/package.json)，`@xunjie/server` | 可组合后端与既有课程 runner。[启动入口](../../apps/server/server/main.ts)读取[宿主配置](../../apps/server/server/app/config.ts)；普通无业务配置启动只有基础健康服务。旧 runner 仍在 [runner/](../../apps/server/runner)，其搬迁不代表 WP03 执行改造完成。 |
| [packages/contracts](../../packages/contracts/package.json)，`@xunjie/contracts` | 编译后的浏览器安全 wire 导出；当前根导出汇合 `./http` 与 `./editor-diagnostics`，分别提供响应/错误和编辑诊断数据及纯校验。Web 与后端从公开 package exports 消费。 |
| [apps/local-runtime](../../apps/local-runtime/README.md)、[packages/product-runtime](../../packages/product-runtime/package.json) | 产品安装、进程、环境、部署连接与维护接入；`@xunjie/contracts/product-runtime` 提供对应 wire。实际资源、验证与后续项目见[运行交接](runtime-acceptance.md)。 |
| [tools/xj-dev](../../tools/xj-dev/README.md) | 成员开发、三模式连接、独立基线与复现。当前内部工厂/测试夹具依赖仅用于开发；后续产品运行 package 不继承它们，产品底座接入与新对象复现归 WP13。 |

本轮 Agent 源码职责从 [通用内核](../../packages/agent-runtime/README.md)、[场景/能力与 v2 transport](../../packages/agents/README.md)、[模型 Gateway](../../packages/model-gateway/README.md)、[学习数据 owner](../../packages/learning-space/README.md) 和 [可信产品宿主](../../packages/product-runtime/README.md)读取。运行依赖为 contracts → storage → runtime/model/learning → agents → product-runtime/server；浏览器消费 contracts 与正式 UI。部署保留 teaching-agent/model-connection 标识，旧开发数据处理见[显式重置](../deployment.md#旧开发-agent-数据的显式重置)。

`@xunjie/contracts` 的浏览器导出及传递依赖不含 Node 专属库，不从 runner/数据库的 `ReturnType` 推导公开 wire。内部 schema、repository 和权限投影留在后端，viewmodel 留在 Web；旧 `apps/server/contracts` 中未提取的内部类型不因此成为新产品长期公开协议。后续按事实 owner 增加真实消费者需要的导出，不跨 app 导入 implementation。

## 统一产品 UI

[#159](https://github.com/paher-din/XunJie/issues/159) 将默认 Web 和独立产品包接到同一个 [LearningApp](../../apps/web/src/product/LearningApp.tsx)。外壳、首页课程与任务卡、中心工具区、Monaco、文件标签和选区组件复用既有产品实现；业务状态只从新公开契约与[可靠工作区](../../apps/web/src/reliable-workspace/README.md)消费。

后续 WP 的接入位置、临时旧消费方及移除责任统一见 [Web 入口表](../../apps/web/README.md#正式产品入口与后续-wp)。WP03 扩展当前中心工具与结果，Agent 会话在当前问题／引用面板通过 v2 原 owner 接收固定输入，WP12 扩展当前活动交付；均随能力完成真实接线与旧路径清理。`runtime/` 是装配与辅助诊断，`dev:prep` 是隔离 UI 参考，二者都不是另建正式学习页的入口。基线、映射和真实截图见 [UI 整合交付](wp02-product-ui.md)。

## 安装、构建与测试

使用根 [package.json](../../package.json)要求的 Node.js `24.21.0`，本地工具测试还需要 `python3`。所有下列命令均在仓库根执行；workspace 依赖只使用根 [package-lock.json](../../package-lock.json)，不在 app 内单独安装或生成锁文件。

```sh
npm ci
npm run typecheck
npm run build
npm test
npm run verify
```

`npm run verify` 与 CI 共用完整门禁，包含公共契约的浏览器打包检查和 Markdown 相对链接检查。用 `npm run verify -- --list` 查询阶段，`-- --help` 查看用法；查询不会执行检查。单独检查可运行 `npm run check:contracts:browser`（先构建 contracts）或 `npm run check:docs -- path/to/file.md`；省略文档路径时检查受维护的 Markdown，自动排除归档、缓存和测试证据，不请求外部 URL 或校验标题锚点。

验证入口默认直接输出阶段、耗时和失败详情，不保存报告文件；CI 使用同一控制台结果，不再上传重复日志附件。确需完整日志供排障时，运行 `npm run verify -- --report-dir .verification/当前问题`，在指定目录保存原始 stdout/stderr、阶段结果和 `latest.json`；独立 `scripts/test.mjs` 入口也支持此参数。使用 RTK 时执行 `rtk bypass npm run verify`，保留实时进度。

任务结束运行 `npm run clean:verification` 清空本地验证残留；`-- --keep <相对路径>` 可重复指定明确仍会使用的结果，`-- --dry-run` 只预览。脚本不清理目录外的文件；Agent 也可直接清理自己创建且已无用途的临时文件。旧验收记录中的本地路径是当时的运行位置，不表示文件需要永久保留。

浏览器测试默认只执行断言，不保存截图、报告或 trace；框架内部临时结果在进程退出时清理。实际 UI 验收需要图片时，显式设置 `XUNJIE_EVIDENCE_DIR=<目录>`（专项输出变量仍有效）。独立探针也仅在显式传入输出路径时保存报告和截图，供后续步骤读取的输入文件照常生成并在使用后清理。

探针所需产品包和 PostgreSQL 路径通过对应参数或环境变量传入，不依赖旧 `.verification/` 验收包。

构建准备共用内容缓存 `.cache/xunjie-build/`：源码、配置、依赖、工具链或相关环境变化，以及产物缺失、篡改或多出陈旧文件，都会触发重建；未提交的文件变化也计入。测试结果不缓存。`npm run build -- --force` 可强制重建。根测试会准备普通 Web 与 runtime Web 两套产物，不依赖上次构建残留。

CI 的 `prepare` 分组构建并检查一次，再将绑定本次提交、Git tree、Node 与平台的产物分发到独立 Ubuntu runner。server 按 [hosted 耗时权重](../../scripts/server-test-weights.json)用稳定的 LPT 分为四片：按估计耗时降序，将每个文件分给累计权重最小的一片；同权重按路径排序，同负载选编号最小的一片。未知文件估计为 10 秒，仅显式传入 `--shard` 时启用加权分片及片内最长优先；未分片的本地 server 保留路径字典序，避免多个重负载文件集中启动。权重仅影响调度，不决定测试发现范围。tools 按恢复、生命周期、状态与证书、其余测试分为四组；全部通过后，main 的发布流程复用同一产物。纯 Markdown／文档图片变更不启动 CI，文档目录中的代码仍触发；当前没有必需检查，未来设置分支保护时不能将被路径过滤跳过的工作流设为必需检查。

```sh
npm run verify -- --group prepare
npm run verify -- --group unit
npm run verify -- --group server --shard 1/4
npm run verify -- --group tools --shard 1/4
npm run verify -- --group tests --jobs 4
```

不传分组仍运行完整门禁，`tests` 包含全部本地测试；构建准备完成后，unit/server/tools 测试先交错排队，共用 1–4 个 worker；未分片的本地 server 保持字典序。恢复工作树使用独立输出，contracts 在 staging 中实际编译，字节一致时保留现有 dist，因此六个生命周期文件可与其他独立测试并行。有界协议时序测试 `packages/product-runtime/test/connections.test.ts` 及未知 workspace 的 npm 测试回退仍在最后阶段逐个独占执行；协议时序断言和期限保持不变。单文件内部仍串行；分片只改变调度，不改变 local/external 分类。`cloud-release` 的手动入口同样先运行完整验证；`publish=false` 只装配并上传产物证据，不创建 Release 或清理旧发布。

根类型检查、构建和测试按 workspace 依赖准备公共包与产物，同一输入复用已核对的构建；产品运行和存储测试仍从公开 package 消费。保留 Web 的 TypeScript 5.9 与 server 的 TypeScript 7，各 workspace 使用自己的编译器和配置。页面开发使用 `npm run dev:prep -w @xunjie/web`（合成数据）或 `npm run dev -w @xunjie/web`；构建后 `npm start -w @xunjie/server` 启动后端，真实课程仍需相应宿主配置。

[scripts/build-server.mjs](../../scripts/build-server.mjs)先清空 `apps/server/dist`，再按[生产配置](../../apps/server/tsconfig.build.json)编译，并检查实际输出；发现测试、fixtures、support 或验收宿主等测试专用文件即失败。仅在 tsconfig 中排除文件不足以阻止 import 把它们带回产物。发布清单与依赖仍须核对，现行云端打包入口是 [build-runtime-artifact.mjs](../../tools/i0-cloud/build-runtime-artifact.mjs)。

根 `npm test` 运行验证脚本回归、已知 Node 测试目录及 `packages`、`apps` 下声明了测试脚本的其他 workspace，以及全部本地工具测试（含 Python 部署测试）；新增 workspace 无需再加入一份手写工程列表。后端、契约、工具与验证脚本共用 [scripts/test.mjs](../../scripts/test.mjs)：

```sh
node scripts/test.mjs server --list
node scripts/test.mjs tools --list
node scripts/test.mjs checks --list
node scripts/test.mjs product-runtime --list
node scripts/test.mjs agent-runtime --external --list
node scripts/test.mjs agents --list
node scripts/test.mjs agents --external --list
node scripts/test.mjs learning-space --list
node scripts/test.mjs learning-space --external --list
npm run test:product-runtime:native
npm run test:storage:native
npm run test:external -- --list
npm run test:external:tools -- --list
```

其接口为 `node scripts/test.mjs <server|contracts|storage|agent-runtime|agents|learning-space|product-runtime|tools|checks> [--external] [--list]`：递归发现 `**/*.test.{ts,mjs,py}`，排除 `node_modules`、`dist`、`evidence`；`--list` 只列清单。产品原生 PG 测试为 `*.runtime.test.mjs`，进入 external 组，需 `XUNJIE_PRODUCT_POSTGRES_BIN` 指向支持的完整 PostgreSQL 17.10、17.11 或 18.6 分发。存储真实 PG/S3 与 HTTP 消费者由 `test:storage:native` 一并运行，另需 `XUNJIE_STORAGE_S3_CONFIG`，见[存储验收](storage-acceptance.md)。Web 继续使用自身 Vitest 配置；浏览器测试单独从根 `npm run test:e2e` 进入。

新增 core、Agent scene/transport 与学习数据的真实 PG 测试位于各包 `test/*.runtime.test.mjs`，统一 verify/unit 不运行这些文件，也不将 native-only workspace 的 0 个 local 文件计为通过。fixture 支持文件不带 `.test` 后缀；当前文件系统递归发现，不保存已删测试的任务清单。learning-space 即使没有 npm test script 也纳入已知 Node 目录，本地 HTTP body 用例的独立入口准备 product-runtime 依赖；模型回归仍在 server 测试目录。

`node scripts/test.mjs <target>` 和常规 typecheck/build 会准备并写 workspace dist。共享 checkout 有主构建占用时先协调统一构建，避免清理另一测试正在读取的产物；等待期间可用各包编译器直接 `tsc --noEmit -p <tsconfig>`，或对已准备且不变的 dist 执行 `node --test <文件>`。这些操作不证明浏览器、真实供应商或跨机验收通过。

工具组会启动真实 CLI 并重建同一 checkout 的公共契约产物，因此按文件串行，避免另一文件在编译写入期间导入同一产物；其他 Node 分组仍按 4 个文件并行。单个文件内刻意验证的并发、竞争和多进程场景保持原样。

| 分组 | 文件与环境 |
| --- | --- |
| 后端外部组：`npm run test:external` | `**/*.runtime.test.{ts,mjs}`、`runner/node.rpc.test.ts`、`server/tutoring/test/real-provider-failures.test.ts`；需要对应 Linux VM、容器镜像/工具链或真实模型配置，具体标志见下表。 |
| 工具外部组：`npm run test:external:tools` | `tools/xj-dev-access/ssh-policy.test.py`；在已有 `/usr/sbin/sshd` 和主机密钥的 Linux 环境以 root 运行。只在临时配置中验证 sshd parser，不重载宿主 SSH。 |

混合文件仍由本地组发现，真实模型或 VM 子案例按原有条件运行或显示原生 skip 结果；本地组通过不代表这些子案例已验收。外部组不会自动配置环境，也不替代各文件原有条件：

| 既有测试 | 当前环境标志与依赖 |
| --- | --- |
| [真实模型支持](../../apps/server/server/tutoring/test/real-model-support.ts)及其调用者 | `XUNJIE_P2_REAL_MODEL`、`XUNJIE_DL_B_REAL_MODEL`、`XUNJIE_DL_B_REAL_SEMANTIC_FIX`、`XUNJIE_B3_REAL_MODEL` 各自以严格值 `approved-synthetic` 启用对应案例；需从既有私有渠道配置 `DEEPSEEK_API_KEY`。 |
| student-help 语义修正/性能批次、real-provider-failures | 需 `XUNJIE_P2_REAL_MODEL=approved-synthetic`，再分别满足 `XUNJIE_P2_REAL_SEMANTIC_FIXES`、`XUNJIE_P2_REAL_PERFORMANCE`、`XUNJIE_P2_REAL_FAILURES` 的 `approved-synthetic` 条件。 |
| [Docker runtime](../../apps/server/runner/docker.runtime.test.ts) | Linux、`XUNJIE_C1_RUNTIME=1`、`XUNJIE_C1_RUNTIME_IMAGE` 为实际镜像摘要；需要既有专用 Docker/socket、编译镜像及挂载条件。 |
| [node RPC](../../apps/server/runner/node.rpc.test.ts)、[编辑诊断 runtime](../../apps/server/runner/editor-diagnostics.runtime.test.ts) | Linux、`XUNJIE_C1_SSH=1`；`XUNJIE_C1_HOST_BASE` 默认 `/opt/xunjie-runner/vm`，其中需已有 SSH keys/known_hosts 及目标 VM。编辑诊断另需 `XUNJIE_EDITOR_NODE_CONFIG` 指向目标节点配置。 |
| [HDL runtime](../../apps/server/runner/hdl.runtime.test.ts)、[板输入 runtime](../../apps/server/runner/hdl-board-inputs.runtime.test.ts) | `XUNJIE_DLC_CONFIG` 指向已有 HDL 节点配置，包含实际容器/工具链条件；板输入案例还检查 Linux。 |
| [ALU 节点账本 runtime](../../apps/server/runner/alu-node.runtime.test.ts) | Linux，需预先准备当前节点用户可写的 `/run/xunjie-dlc`；验证真实节点的不可变元数据、占用拒绝及私有结果边界。经 `npm run test:external` 进入，默认工程门禁保留纯 ALU 逻辑测试。CI 单独准备该空目录，再以普通 runner 用户执行此文件。 |
| 本地组内 [ALU](../../apps/server/runner/alu-check.test.ts)和 [HDL clock](../../apps/server/runner/hdl-clock.test.ts)的真实工具链案例 | Linux 且设置 `XUNJIE_DLC_TOOLCHAIN`，指向已有 Icarus 工具链；其他子案例保留自身平台条件。 |
| 本地组内 [workspace integration](../../apps/server/server/workspace/integration.test.ts)、[runs](../../apps/server/server/workspace/runs.test.ts)及 [design activities](../../apps/server/tests/design-activities.test.ts)的 VM 案例 | 前两者使用 `XUNJIE_C2_RUNTIME=1`；integration 从 `XUNJIE_C2_SSH_CONFIG` 读取 JSON，runs 还检查 Linux 并使用 `/opt/xunjie-runner/vm/keys` 与 `127.0.0.1:2222` 的既有节点；design 使用 `XUNJIE_A2_RUNTIME=1` 与 `XUNJIE_A2_SSH_CONFIG` 配置文件。 |

以上均为现有测试标志，不另增启用变量。源码中的探针、合成案例及 skip 不构成新产品安装矩阵或教学效果验收。

## Agent session v2 专项入口

旧活动级 Agent 的人工 probe、专属跨机控制器及 WP08 旧备份 probe 已退休；当前回归直接使用公开 session v2 / 安装产品测试，不保留旧 wrapper。旧教学引擎备份与 session v2 不兼容，不把历史恢复样本当作新 schema 升级测试。旧证据仍保留原版本、失败和通过状态。

| 范围 | 当前测试入口 |
| --- | --- |
| 独立部署、学校连接与丢回执 | [agent-connection-v2](../../packages/product-runtime/test/agent-connection-v2.runtime.test.mjs)、[standalone-agent](../../packages/product-runtime/test/standalone-agent.runtime.test.mjs)、[school-session-v2](../../packages/product-runtime/test/school-session-v2.runtime.test.mjs) |
| 原输入、steering、等待、停止与回应 | [input-control](../../packages/agent-runtime/test/capabilities.runtime.test.mjs)、[agent-student-ask](../../packages/product-runtime/test/agent-student-ask.runtime.test.mjs) |
| 原生输入拒绝、固定控制回执与等待恢复 | [teaching-tools-host](../../apps/server/tests/teaching-tools-host.runtime.test.mjs)、[workspace-control-wait](../../packages/product-runtime/test/workspace-control-wait.runtime.test.mjs)、[workspace-agent-waits](../../packages/product-runtime/test/workspace-agent-waits.test.mjs) |
| 三协议原生续接、装配、压缩与工具发现 | [conversation-native](../../packages/agents/test/conversation-native.runtime.test.mjs)、[tool-discovery](../../packages/agents/test/tool-discovery.runtime.test.mjs) |
| 备份、完整 service sources 与独立 owner 恢复 | [recovery-agent-sessions](../../packages/product-runtime/test/recovery-agent-sessions.runtime.test.mjs)、[independent-recovery](../../apps/server/tests/teaching-agent.independent-recovery.runtime.test.mjs)、[recovery](../../apps/server/tests/teaching-agent.recovery.runtime.test.mjs) |
| PDF 原页/图像、continuation 与固定原件恢复 | [pdf-agent](../../apps/server/tests/pdf-agent.runtime.test.mjs)、[pdf-recovery](../../apps/server/tests/pdf-recovery.runtime.test.mjs)、[workspace-assistant](../../packages/agents/test/workspace-assistant.runtime.test.mjs) |
| Skills 与跨 owner 依赖 | [skills](../../packages/agents/test/skills.runtime.test.mjs)、[session-dependencies](../../packages/agents/test/session-dependencies.runtime.test.mjs) |
| 真实浏览器命令身份与生成产物 | [agent-browser-v3](../../apps/server/tests/agent-browser-v3.runtime.test.mjs)、[artifact-generation](../../apps/server/tests/teaching-artifact-generation.runtime.test.mjs)、[artifact-stop-adopt](../../apps/server/tests/teaching-artifact-stop-adopt.runtime.test.mjs) |

以上文件属于 external，需独立临时 PG fixture。统一构建完成、产物就绪后，可使用 Node 24.21.0 直接 `node --test --test-concurrency=1 <文件>` 定向运行；`--external --list` 只查看发现结果。本页只提供当前源码入口，不宣称本轮已执行或通过。

仍保留 [ALU 产物/执行界面 probe](../../scripts/probe-wp09-alu.mjs) 与 [PDF 界面 probe](../../scripts/probe-pdf-ui.mjs)：它们消费领域接口，未依赖旧 Agent runtime。使用前仍需按真实产品包与桌面环境核验，不能用旧报告代替新运行。

原 probe 中的真实供应商三协议/扫描 PDF、真实双机 HTTPS 与跨安装接管、系统中文输入法的物理候选操作不由上述 native 回归证明。[session v2 浏览器用例](../../apps/web/e2e/sessionV2.spec.ts)与[input control 用例](../../apps/web/e2e/inputControl.spec.ts)也不能代替系统输入法或跨机实测。是否补充当前专项测试由主验收范围决定；工程、真实 host/UI、供应商和跨机结果分别记录。

## 后续写集与责任

| 票 | 继续使用的入口 | 仍待该票实现与验证 |
| --- | --- | --- |
| [#143 运行安装](https://github.com/paher-din/XunJie/issues/143) | `apps/local-runtime`、`packages/product-runtime`、独立运行网页与环境 wire；[实际资源和验收](runtime-acceptance.md) | 子票已完成目标设备、学校和真实跨机验收；本轮签名/公证排除，Windows 依赖和安装前提按实际证据记录。组合核对见[父票验收](wp01-acceptance.md)。 |
| [#144 存储](https://github.com/paher-din/XunJie/issues/144) | [packages/storage](../../packages/storage/README.md)、[实际 module 示例](../../apps/server/server/storage-sample/index.ts)及 `@xunjie/contracts/storage`；旧 SQLite 原件独立保留 | 子票已交付 PostgreSQL 事务/迁移、资源发布/保留/GC 与维护接入。当前版本在 #145 修改后的补验、接口和故障范围见[父票验收](wp01-acceptance.md)及[存储交接](storage-acceptance.md)。 |
| [#145 维护恢复](https://github.com/paher-din/XunJie/issues/145) | [公开运行库](../../packages/product-runtime/README.md)与[维护操作和证据](maintenance-acceptance.md) | 子票已交付一致备份、隔离还原、升级和权威接管；新业务 owner 随所属 WP 登记并完整验收，父票不预先声称其恢复已完成。 |

运行安装提供资源与连接，存储提供事务与资源机制，不互相接管事实。环境/服务身份、凭据引用、维护参与 interface、PG 18.6 与初始化条件现从[产品运行交接](runtime-acceptance.md)消费；存储可独立开发并完成最终关键事务验收。旧数据、DTO 或队列不自动接入新产品。工作区、原生执行、模型与 Agent 深化分别随所属 WP，备份升级与恢复交接按 WP01 对应后续票完成。
