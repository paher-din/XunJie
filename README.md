<div align="center">

# 循阶 · XunJie

**面向高校 CS 课程的 AI 项目学习空间**

教师与 Agent 共同设计项目，学生在动手实践、就地求助与反馈修订中学习。

[产品介绍](https://xunjie-learning-studio.tsts19891213.chatgpt.site/) · [功能概览](#功能概览) · [开始使用](#开始使用)

</div>

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

教师项目设计页提供“AI 协助设计”：可请求项目候选、局部建议或量规试评，教师显式采纳后才写入草稿。它需要宿主配置真实 provider 和独立教师预算；个人模型设置不自动开启该预算。本地实现、验证与待确认接线见[本轮任务](docs/tasks/I1_TEACHER_DESIGN_AI_UI_20261015.md)。

### 本地界面预览

准备 Git 和 Node.js 24，在终端执行：

```sh
git clone https://github.com/paher-din/XunJie.git
cd XunJie/apps/student
npm ci
npm run dev:prep
```

打开 `http://127.0.0.1:5601`。此模式使用演示数据，不连接真实课程、执行节点或模型；完整课程使用与服务接入见[运行说明](apps/student/README.md)。

<details>
<summary>开发者文档</summary>

[协作规范](AGENTS.md) · [产品需求](docs/product/PRD.md) · [首版范围](docs/product/MVP_SPEC.md) · [技术设计](docs/product/TECH_DESIGN.md) · [任务计划](docs/planning/TEAM_WORK_PLAN.md) · [任务记录](docs/tasks/)

## 开发 skills

项目技能位于 [skills/](skills/)，首次接入见[配置说明](docs/tasks/W1_CODEX_SKILLS_CONFIG.md)。使用与修改范围遵循 [AGENTS.md](AGENTS.md)。

</details>
