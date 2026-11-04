# #175 进行中：课程运行方案、执行位置判定与真实远端执行

日期：2026-11-03（Asia/Shanghai）。对应 [#175](https://github.com/paher-din/XunJie/issues/175)。分支 `wp03`，审查基点 `e5b3743`。本文记录本轮**已实现并验证**的方案与判定链、在学校节点上实测到的隔离能力，以及 #175 尚未完成的远端原生会话、Linux 受限会话入口与跨机验收项。**本票未完成，不关闭。**

## 依据与范围

- [实施票 #175](https://github.com/paher-din/XunJie/issues/175)、[WP03 规范的课程运行方案一节](specs/wp03-course-components-and-execution.md)、[教师拥有的课程执行方案 ADR](adr/0001-teacher-owned-course-execution-plan.md)。
- 本轮只做「方案随发布固定 → 活动快照不漂移 → 按操作判定位置 → 浏览器宿主如实上报」。远端原生会话装配、领取通道复用、Linux 受限会话入口与跨机 Chrome 验收**未完成**，见文末。
- 判定规则只有一条：设备确实不满足、且课程方案声明了匹配的远端条件，才允许远端；缺安装、待授权、准备失败、失联、下载失败都不构成换位置的理由。学生不选节点。

## 已实现的写集

| 部分 | 文件 | 实际行为 |
| --- | --- | --- |
| 新契约集中点 | `packages/contracts/src/execution-plan.ts` | 方案 schema（身份、组件定义/配置摘要、操作、能力、浏览器与原生资源、位置、远端适用条件）；`courseExecutionPlanBasis()` 逐层排序后作为唯一哈希内容；`executionDeviceSchema` 区分「未观察到」与「不支持」；`decideExecutionPlacement()` 返回六态之一；`plannedExecutionScope()` 给出 allowed/drifted/forbidden |
| 契约再导出 | `packages/contracts/src/execution.ts` | `executionCapabilitiesSchema.operations[]` 增加可选 `decision`：未发布方案的组件不带该字段 |
| 课程发布 | `packages/contracts/src/courses.ts`、`packages/learning-space/src/courses/index.ts` | 发布、导入、活动绑定各自携带可选 `executionPlan`；导入时校验摘要、组件键、定义/配置摘要、操作集合、能力子集、位置与组件形态一致、原生预算不超过适配器声明、远端适配器必须匹配某个会话组件；`readRelease`/`validate()` 重跑同一校验并映射为 `corrupt` |
| 活动快照 | 同上 | 活动绑定保存打开时的方案快照；同一 task 的新发布不改写已打开活动 |
| 执行 owner | `packages/learning-space/src/learning-data/plan.ts`、`executions.ts`、`native-sessions.ts` | 浏览器作业与原生会话在接受前都按活动自带方案判定：不再描述该组件为 `corrupt`，越权位置或越权操作为 `forbidden` |
| 浏览器宿主 | `apps/web/src/component-host/bridge.ts`、`ComponentView.tsx`、`apps/web/src/tool-execution/device.ts` | `execution.capabilities` 逐操作回答；能力来自真实探针（Worker、WebAssembly、sandbox 属性）；无法自证的事实保持 `null`；未观察到合格学校节点即报不可用，不用它换位置 |

`decision` 只描述当前操作：正式工作区因此只呈现与该操作相关的准备/连接问题与真实结果，没有节点选择控件。

## 本轮验证

| 检查 | 实际结果 |
| --- | --- |
| 方案与判定契约 | `packages/contracts/test/execution-plan.test.ts` **8/8**：摘要只覆盖自身内容、位置与资源一致、真实不支持才去节点、可运行设备绝不静默转远端（缺安装/待授权/准备失败）、浏览器作业按特性判定且不转远端、未计划操作被拒、`allowed/drifted/forbidden` 三态、未观察事实不变成承诺 |
| 发布与绑定（真实 PostgreSQL 18.6） | `apps/server/tests/course-execution-plan.runtime.test.mjs` **2/2**：方案随发布可读、活动快照不被新发布改写、旧格式线上形态不含 `executionPlan`、六类不一致方案被 400 拒绝、原生方案允许会话而越权组件键被 403 拒绝 |
| 浏览器宿主 | `apps/web/src/component-host/execution-boundary.test.ts` **2/2**（新增一项）与 `bridge.test.ts` **6/6**：无方案时不上报判定；有方案时按操作给出 `browser-satisfied`；缺少必需特性时为 `device-unsupported` 且不带位置 |
| 类型与构建 | `node scripts/build.mjs web:src`、`node scripts/build.mjs web:typecheck` 退出 0 |

命令（Node 24.21.0）：

```sh
node scripts/test.mjs contracts
XUNJIE_PRODUCT_POSTGRES_BIN=$PWD/dist/product-darwin-arm64-wp06-r2/resources/postgres/bin \
  node --test --test-concurrency=1 apps/server/tests/course-execution-plan.runtime.test.mjs
npx vitest run src/component-host/execution-boundary.test.ts --root apps/web
```

## 学校节点隔离能力实测

学校主机为独立 Ubuntu 24.04.5 LTS、x86_64、2 vCPU、1740 MiB 内存、systemd 255 (255.4-1ubuntu8.18)、cgroup v2 统一层级（`cpuset cpu io memory hugetlb pids rdma misc`）、有 `/usr/bin/systemd-run`、**无系统 Node**（产品自带 24.21.0）。以下为 2026-11-03 以该机安装用户（uid 1000，非 root）实际执行的结果，不是推断：

| 尝试 | 实际结果 |
| --- | --- |
| `systemd-run --user --scope -p MemoryMax=48M -p MemorySwapMax=0` 逐步分配 | 进程被内核杀死，退出 **137**；同命令下 `memory.max` 读到 `67108864`、`pids.max` 读到 `32`，可自证生效 |
| `-p TasksMax=8` 后连续 fork | 立即 `Cannot fork`，任务数上限真实生效 |
| `-p IPAddressDeny=any` 连接 `127.0.0.1:22` | 仍然**连上**；同一探针在无该属性时也连上。该属性在此用户 scope 上未产生实际拦截，不能当作禁网证据 |
| `-p RestrictAddressFamilies=AF_UNIX` | `systemd-run` 直接拒绝：`Unknown assignment`。scope 单元不支持命名空间类属性 |
| `--scope` 的进程布局 | 载荷由 `systemd-run` 直接 exec，`pid` 就是载荷自身；stdio 与第 4 号监视管道都被继承，现有「按进程组回收 + 监督器死亡」语义可继续沿用 |
| 服务单元（`--system --unit`，需要 root） | 未在本轮执行。服务单元无法继承调用方的管道，会话协议必须改为 socket 承载 |

结论：在非 root 的 `--user --scope` 下只能得到 **cgroup v2 的内存与任务数上限**，拿不到禁网与只读文件系统。因此「隔离不可用则拒绝启动」在 Linux 上目前成立，而**真正的 Linux 受限会话入口需要在服务单元里实现**：`PrivateNetwork=yes`、`ProtectSystem=strict`、`ReadWritePaths=<会话目录>`、`User=`/`DynamicUser=`、`MemoryMax=`、`TasksMax=`、`RuntimeMax=`，会话协议改为 unix socket 而不是管道。这是 #175 未完成的核心工程，不是配置问题。

现状需要如实说明：`native-sandbox.ts` 目前只有 macOS seatbelt、Windows AppContainer 与进程组兜底三种，**Linux 仍走进程组兜底**，本轮没有把「拒绝启动」写进代码，也没有用拒绝启动冒充隔离交付。

## #175 尚未完成

1. **远端原生会话装配**：同一原生会话组件在独立学校节点运行，固定所有者、节点、安装/恢复代际、监督器与执行器实例；地址变化与重启不改归属。
2. **领取通道复用**：复用已认证连接与持久领取通道；学校网页浏览器任务不要求本机节点/数据库；仅远端客户端维持无本机数据库的 `remote` 组合。
3. **Linux 受限会话入口**：见上表，需要服务单元 + socket 承载，并在准备通过后才登记可用执行能力；不可用时拒绝启动。
4. **撤权与资格变化**：撤权、成员/课程资格变化、旧安装失权在真实跨机链路上的实际拒绝；执行所有者仍可清理进程，结果读取按当前资格。
5. **跨机 Chrome 证据**：Windows 11 x64 与 Apple Silicon Mac 的桌面 Chrome 分别连接真实学校节点，覆盖学校网页浏览器作业、学校网页调用获准本机能力、本机入口调用学校原生会话、无数据库客户端，以及严格 HTTPS、真实断网、原节点查询/停止和连接/资格撤销；SSH 只用于部署与观察。
6. **与 #174 汇合补测**：控制与检查点的实际支持组合。
7. **收尾**：`rtk bypass npm run verify` 全量、code-review 两轴审查、包/组件/系统版本与前后截图记录、临时环境清理。

第 1、2、4、5 项依赖第 3 项的会话承载方式确定后再接线：把服务单元的 socket 会话接上之后，远端与本地只需替换装配位置，执行语义与判定规则不变。
