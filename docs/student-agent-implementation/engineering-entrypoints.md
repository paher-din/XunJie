# 工程入口与 WP01 接入交接

本页承接 [#146：工程目录、公共契约与构建入口整理](https://github.com/paher-din/XunJie/issues/146)，供 [#143：产品安装、独立环境与部署连接](https://github.com/paher-din/XunJie/issues/143)和 [#144：PostgreSQL 事务与服务资源存储](https://github.com/paher-din/XunJie/issues/144)接入。结构准备不代表新产品运行、存储或课程执行改造已完成；完整职责见 [WP01 规范](specs/wp01-product-runtime-and-data.md)。

## 当前工程入口

| 入口 | 当前职责与接入方式 |
| --- | --- |
| [apps/web](../../apps/web/package.json)，`@xunjie/web` | 师生共用浏览器应用；页面与权限投影区分身份。[运行说明](../../apps/web/README.md) |
| [apps/server](../../apps/server/package.json)，`@xunjie/server` | 可组合后端与既有课程 runner。[启动入口](../../apps/server/server/main.ts)读取[宿主配置](../../apps/server/server/app/config.ts)；普通无业务配置启动只有基础健康服务。旧 runner 仍在 [runner/](../../apps/server/runner)，其搬迁不代表 WP03 执行改造完成。 |
| [packages/contracts](../../packages/contracts/package.json)，`@xunjie/contracts` | 编译后的浏览器安全 wire 导出；当前根导出汇合 `./http` 与 `./editor-diagnostics`，分别提供响应/错误和编辑诊断数据及纯校验。Web 与后端从公开 package exports 消费。 |
| [apps/local-runtime](../../apps/local-runtime/README.md)、[packages/product-runtime](../../packages/product-runtime/package.json) | 产品安装、进程、环境、部署连接与维护接入；`@xunjie/contracts/product-runtime` 提供对应 wire。实际资源、验证与后续项目见[运行交接](runtime-acceptance.md)。 |
| [tools/xj-dev](../../tools/xj-dev/README.md) | 成员开发、三模式连接、独立基线与复现。当前内部工厂/测试夹具依赖仅用于开发；后续产品运行 package 不继承它们，产品底座接入与新对象复现归 WP13。 |

`@xunjie/contracts` 的浏览器导出及传递依赖不含 Node 专属库，不从 runner/数据库的 `ReturnType` 推导公开 wire。内部 schema、repository 和权限投影留在后端，viewmodel 留在 Web；旧 `apps/server/contracts` 中未提取的内部类型不因此成为新产品长期公开协议。后续按事实 owner 增加真实消费者需要的导出，不跨 app 导入 implementation。

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

验证入口实时保存原始 stdout/stderr，并输出阶段、耗时和失败摘要。`.verification/latest.json` 指向本轮完整日志与阶段结果，每轮日志单独保存；CI 无论成功或失败均上传日志，保留 7 天。日志目录不进入 Git。使用 RTK 时执行 `rtk bypass npm run verify`，保留实时进度。

根类型检查先编译 contracts / product-runtime；根构建按 contracts → product-runtime → server → Web / 独立运行网页 → local-runtime 排序。测试先构建契约与独立网页，产品运行测试通过公开 package 执行。保留 Web 的 TypeScript 5.9 与 server 的 TypeScript 7，各 workspace 使用自己的编译器和配置。页面开发使用 `npm run dev:prep -w @xunjie/web`（合成数据）或 `npm run dev -w @xunjie/web`；构建后 `npm start -w @xunjie/server` 启动后端，真实课程仍需相应宿主配置。

[scripts/build-server.mjs](../../scripts/build-server.mjs)先清空 `apps/server/dist`，再按[生产配置](../../apps/server/tsconfig.build.json)编译，并检查实际输出；发现测试、fixtures、support 或验收宿主等测试专用文件即失败。仅在 tsconfig 中排除文件不足以阻止 import 把它们带回产物。发布清单与依赖仍须核对，现行云端打包入口是 [build-runtime-artifact.mjs](../../tools/i0-cloud/build-runtime-artifact.mjs)。

根 `npm test` 运行验证脚本回归、`packages`、`apps` 下声明了测试脚本的 workspace，以及全部本地工具测试（含 Python 部署测试）；新增 workspace 无需再加入一份手写工程列表。后端、契约、工具与验证脚本共用 [scripts/test.mjs](../../scripts/test.mjs)：

```sh
node scripts/test.mjs server --list
node scripts/test.mjs tools --list
node scripts/test.mjs checks --list
node scripts/test.mjs product-runtime --list
npm run test:product-runtime:native
npm run test:external -- --list
npm run test:external:tools -- --list
```

其接口为 `node scripts/test.mjs <server|contracts|product-runtime|tools|checks> [--external] [--list]`：递归发现 `**/*.test.{ts,mjs,py}`，排除 `node_modules`、`dist`、`evidence`；`--list` 只列清单。产品原生 PG 测试为 `*.runtime.test.mjs`，进入 external 组，需 `XUNJIE_PRODUCT_POSTGRES_BIN` 指向固定完整 PG 18.6。Web 继续使用自身 Vitest 配置；浏览器测试单独从根 `npm run test:e2e` 进入。

| 分组 | 文件与环境 |
| --- | --- |
| 后端外部组：`npm run test:external` | `**/*.runtime.test.ts`、`runner/node.rpc.test.ts`、`server/tutoring/test/real-provider-failures.test.ts`；需要对应 Linux VM、容器镜像/工具链或真实模型配置，具体标志见下表。 |
| 工具外部组：`npm run test:external:tools` | `tools/xj-dev-access/ssh-policy.test.py`；在已有 `/usr/sbin/sshd` 和主机密钥的 Linux 环境以 root 运行。只在临时配置中验证 sshd parser，不重载宿主 SSH。 |

混合文件仍由本地组发现，真实模型或 VM 子案例按原有条件运行或显示原生 skip 结果；本地组通过不代表这些子案例已验收。外部组不会自动配置环境，也不替代各文件原有条件：

| 既有测试 | 当前环境标志与依赖 |
| --- | --- |
| [真实模型支持](../../apps/server/server/tutoring/test/real-model-support.ts)及其调用者 | `XUNJIE_P2_REAL_MODEL`、`XUNJIE_DL_B_REAL_MODEL`、`XUNJIE_DL_B_REAL_SEMANTIC_FIX`、`XUNJIE_B3_REAL_MODEL` 各自以严格值 `approved-synthetic` 启用对应案例；需从既有私有渠道配置 `DEEPSEEK_API_KEY`。 |
| student-help 语义修正/性能批次、real-provider-failures | 需 `XUNJIE_P2_REAL_MODEL=approved-synthetic`，再分别满足 `XUNJIE_P2_REAL_SEMANTIC_FIXES`、`XUNJIE_P2_REAL_PERFORMANCE`、`XUNJIE_P2_REAL_FAILURES` 的 `approved-synthetic` 条件。 |
| [Docker runtime](../../apps/server/runner/docker.runtime.test.ts) | Linux、`XUNJIE_C1_RUNTIME=1`、`XUNJIE_C1_RUNTIME_IMAGE` 为实际镜像摘要；需要既有专用 Docker/socket、编译镜像及挂载条件。 |
| [node RPC](../../apps/server/runner/node.rpc.test.ts)、[编辑诊断 runtime](../../apps/server/runner/editor-diagnostics.runtime.test.ts) | Linux、`XUNJIE_C1_SSH=1`；`XUNJIE_C1_HOST_BASE` 默认 `/opt/xunjie-runner/vm`，其中需已有 SSH keys/known_hosts 及目标 VM。编辑诊断另需 `XUNJIE_EDITOR_NODE_CONFIG` 指向目标节点配置。 |
| [HDL runtime](../../apps/server/runner/hdl.runtime.test.ts)、[板输入 runtime](../../apps/server/runner/hdl-board-inputs.runtime.test.ts) | `XUNJIE_DLC_CONFIG` 指向已有 HDL 节点配置，包含实际容器/工具链条件；板输入案例还检查 Linux。 |
| 本地组内 [ALU](../../apps/server/runner/alu-check.test.ts)和 [HDL clock](../../apps/server/runner/hdl-clock.test.ts)的真实工具链案例 | Linux 且设置 `XUNJIE_DLC_TOOLCHAIN`，指向已有 Icarus 工具链；其他子案例保留自身平台条件。 |
| 本地组内 [workspace integration](../../apps/server/server/workspace/integration.test.ts)、[runs](../../apps/server/server/workspace/runs.test.ts)及 [design activities](../../apps/server/tests/design-activities.test.ts)的 VM 案例 | 前两者使用 `XUNJIE_C2_RUNTIME=1`；integration 从 `XUNJIE_C2_SSH_CONFIG` 读取 JSON，runs 还检查 Linux 并使用 `/opt/xunjie-runner/vm/keys` 与 `127.0.0.1:2222` 的既有节点；design 使用 `XUNJIE_A2_RUNTIME=1` 与 `XUNJIE_A2_SSH_CONFIG` 配置文件。 |

以上均为现有测试标志，不另增启用变量。源码中的探针、合成案例及 skip 不构成新产品安装矩阵或教学效果验收。

## 后续写集与责任

| 票 | 继续使用的入口 | 仍待该票实现与验证 |
| --- | --- | --- |
| [#143 运行安装](https://github.com/paher-din/XunJie/issues/143) | 已建立 `apps/local-runtime`、`packages/product-runtime`、独立运行网页与环境 wire；[实际资源和验收](runtime-acceptance.md) | 继续目标设备安装与学校/真实跨机组合验收；Windows 实机待负责人回家后继续，签名/公证已由负责人移出本轮执行范围。 |
| [#144 存储](https://github.com/paher-din/XunJie/issues/144) | 后端所属 module；[旧 SQLite 事务入口](../../apps/server/server/db/transaction.ts)与[个人模型存储](../../apps/server/server/personal-agent/store.ts)仅供核对现状，公开 wire 使用 `@xunjie/contracts` | 建立 `packages/storage`，实现 PostgreSQL 事务/迁移、所属资源发布/保留/GC 与维护参与；业务 module 拥有自己的表和规则。用真实 PG、文件/S3 后端及独立消费者验证竞争、未知提交与崩溃恢复。 |

运行安装提供资源与连接，存储提供事务与资源机制，不互相接管事实。环境/服务身份、凭据引用、维护参与 interface、PG 18.6 与初始化条件现从[产品运行交接](runtime-acceptance.md)消费；存储可独立开发并完成最终关键事务验收。旧数据、DTO 或队列不自动接入新产品。工作区、原生执行、模型与 Agent 深化分别随所属 WP，备份升级与恢复交接按 WP01 对应后续票完成。
