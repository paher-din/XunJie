<div align="center">

# 循阶 · XunJie

**面向高校 CS 课程的 AI 项目学习空间**

教师与 Agent 共同设计项目，学生在动手实践、就地求助与反馈修订中学习。

[产品介绍](https://xunjie-learning-studio.tsts19891213.chatgpt.site/) · [功能概览](#功能概览) · [开始使用](#开始使用)

</div>

项目正在进行新一轮设计与重构，已定设计、Wayfinder 本地决议和实施总览见[本轮架构与设计](docs/student-agent-implementation/README.md)。开发规则见 [AGENTS.md](AGENTS.md)，UI 设计遵循根目录 [DESIGN.md](DESIGN.md)。旧文档及其证据已移入 [docs/archive/](docs/archive/)，停止使用和维护，不作为本轮开发依据。以下使用说明对应现有演示实现。

WP02 正式学习空间已统一复用产品外壳、首页与沉浸工作区；实际产品包与普通 Web 默认入口消费同一实现。当前能力、启动方式和后续 WP 接入见 [Web 入口](apps/web/README.md#正式产品入口与后续-wp)，真实前后界面及验收边界见 [#159 交付](docs/student-agent-implementation/wp02-product-ui.md)。

## 功能概览

| 功能 | 可以做什么 |
| --- | --- |
| 项目工作区 | 在浏览器中阅读任务、管理文件、编辑代码、保存作品并查看运行与检查结果。 |
| AI 就地辅导 | 围绕当前任务、代码与运行结果，获得概念讲解、问题定位和验证建议。 |
| 数字逻辑实验 | 编写 Verilog / SystemVerilog，通过真实 RTL 仿真操作虚拟板，观察 LED、数码管与波形。 |
| 教师工作台 | 设计与分配项目、审阅学生作品、提供反馈，并安排修订与后续任务。 |
| 个人模型配置 | 配置自己的模型服务，在项目辅导与独立对话中使用。 |

**当前课程：** C 程序设计（TextScope 文本分析项目）与数字逻辑与部件设计（4 位 ALU 实验）。数字逻辑使用虚拟板与 RTL 仿真，不生成实体 FPGA bitstream。

## 开始使用

当前为开发演示版本，暂不开放公开注册。上方链接为产品介绍页；实际课程应用的访问地址与账号由团队提供，可用功能以对应课程环境为准。

**学生：** 登录后选择课程与任务，阅读要求、编辑并保存作品，运行 C 程序或 HDL 仿真；遇到问题时就地向 AI 求助，提交作品后根据教师反馈修订。

在侧边栏 Agent 对话中，回复明确涉及单项本人任务时，可点回复底部的「进入任务」前往对应工作区；多任务回复不自动选择入口。

**教师：** 使用教师账号进入 `/#/teacher`，设计并分配项目，审阅学生提交、发布反馈，再开放修订或安排后续任务。

AI 功能需课程环境启用模型服务；支持个人配置的环境中，可在设置页填写模型服务与 API Key。

教师项目设计页提供“AI 协助设计”：可请求项目候选、局部建议或量规试评，教师显式采纳后才写入草稿。它需要宿主配置真实 provider 和独立教师预算；个人模型设置不自动开启该预算。

### 在本机运行应用

准备 Git、Node.js 24.21.0（含 npm）和桌面 Chrome。首次构建需要联网下载依赖和产品运行资源。Windows 11 x64 从源码打包还需要 MinGW-w64 GCC；可安装 [MSYS2](https://www.msys2.org/) 的 `mingw-w64-ucrt-x86_64-gcc`，并将其 `ucrt64/bin` 加入 `PATH`。macOS 支持 Apple Silicon，macOS 和 Linux 打包需要 `tar`、`unzip`。

在终端执行：

```sh
git clone https://github.com/paher-din/XunJie.git
cd XunJie
node --version  # 应为 v24.21.0
npm ci
npm run package:product
```

打包完成后，在仓库根目录按系统运行对应命令，首次启动会自动安装并打开应用：

```powershell
# Windows 11 x64
.\dist\product-win32-x64\xunjie.cmd
```

```sh
# Apple Silicon macOS
./dist/product-darwin-arm64/xunjie

# Linux x64
./dist/product-linux-x64/xunjie
```

Windows 也可双击 `dist/product-win32-x64/xunjie.cmd`，macOS 可双击 `dist/product-darwin-arm64/循阶.command`。应用会打开系统默认浏览器；如需使用 Chrome，可将启动结果中 `endpoint` 的地址复制到 Chrome。以后再次运行同一入口即可打开应用。

首次进入的是本机个人学习空间。需要课程时，在设置中连接学校提供的入口；使用 Agent 前，在设置中配置并选用自己的模型服务与 API Key。关闭网页不会停止服务；如需停止，在上述启动命令后加 `stop`，数据会保留。Windows 首次启动如果提示缺少 VC++ 运行库，按提示安装后重试。已有环境沿用原安装的运行资源，升级及其他运行方式见[产品运行说明](apps/local-runtime/README.md)。

<details>
<summary>开发者文档</summary>

[本轮架构与设计](docs/student-agent-implementation/README.md) · [领域术语](CONTEXT.md) · [协作规范](AGENTS.md) · [UI 设计规范](DESIGN.md) · [正式 UI 组件库](packages/ui/README.md) · [Web 运行说明](apps/web/README.md) · [工程入口与后续接入](docs/student-agent-implementation/engineering-entrypoints.md)

师生共用 `apps/web`（`@xunjie/web`）；后端与既有 runner 位于 `apps/server`（`@xunjie/server`）；真实跨端 wire 契约从 `packages/contracts`（`@xunjie/contracts`）的公开导出消费；新 PostgreSQL 与所属资源机制见 [packages/storage](packages/storage/README.md)。依赖统一在仓库根执行 `npm ci`，使用根 `package-lock.json`。

在仓库根执行 `npm run typecheck`、`npm run build`、`npm test`，分别完成 workspace 的类型检查、构建和测试。单工程开发命令使用 `-w` 指定 workspace，例如 `npm run dev -w @xunjie/web`；后端配置与启动边界见[开发工具](docs/development-tooling.md#新-agent-的工具入口)。

完整门禁与 CI 共用 `npm run verify`，包含公共契约浏览器检查和 Markdown 相对链接检查。默认直接输出检查结论和失败详情；需要保存供排障使用的日志时显式指定 `-- --report-dir <目录>`。用法见[工程入口与后续接入](docs/student-agent-implementation/engineering-entrypoints.md#安装构建与测试)。

### 成员开发上手

在本仓库的编码 Agent 中调用一次：

```text
$xunjie-development
```

Agent 检查并复用本机配置、依赖与本人身份，准备本地环境及获准的云连接，再介绍可用功能、适用场景、数据归属和未就绪能力。缺少邀请时，只需把维护者给本人的邀请拖给 Agent 或提供文件路径；无需手建文件、填写连接配置或复制长提示。

首次介绍后，直接说“启动开发”“本地页面连云端后端”“回本地”或描述问题即可。Agent 用[仓库外展示标记](docs/development-tooling.md#首引导状态)在新会话识别已介绍状态，只续缺失步骤；标记不代表连接成功，只读询问也不会初始化环境。

若宿主尚未发现 Skill，让 Agent 按[安装与发现](docs/development-tooling.md#安装与发现)建立本机入口；换电脑、工作树或 Agent 宿主需重新核对发现路径。完整 CLI 说明按任务查阅 [tools/xj-dev](tools/xj-dev/README.md)，不要求成员预读。

## 开发 skills

项目技能位于 [skills/](skills/)，按当前任务需要选用，使用与修改范围遵循 [AGENTS.md](AGENTS.md)。

</details>
