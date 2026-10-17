# W5：旧文档归档与新一轮开发入口

日期：2026-10-18（Asia/Shanghai）。负责人：Robert；执行：本会话 Agent。

## 授权与范围

Robert 明确要求将 `docs/` 中除 `DESIGN.md` 外的全部文档移入 `docs/archive/`，停止使用和维护旧文档，准备新一轮重构与开发；将 `DESIGN.md` 移到仓库根目录。随后明确授权重写根 `AGENTS.md`，移除旧文档对 Agent 的约束，并要求 UI 设计遵循保留的 `DESIGN.md`。

负责模块：文档组织与开发入口。可写：上述移动、根 `AGENTS.md`、根 `README.md`、迁移所需的 `DESIGN.md` 链接与依据说明、学生端 README/IMPORT_SOURCE 的直接入口同步、本文及归档说明。旧正文与证据原样保留；应用业务逻辑、依赖、CI/CD、数据库、运行环境及个人记忆不在本次范围。已有未跟踪 `.zcodeignore` 保留。

直接执行依赖修复：两个现有 HDL 测试与本地课程工具读取已归档 JSON，移动后会 ENOENT。本次将同一份数据独立为 `tools/i0-hdl/fixtures/hdl-reference.json`，仅调整读取路径及用途说明，保持测试与工具行为；不启动或恢复任何旧环境。涉及 `hdlStore.test.ts`、`hdlWorkspace.test.ts`、`seed-local-courses.mjs` 与其 `SEED_LOCAL_COURSES.md`。

迁移前已读：根 README、AGENTS；PRD §1–1.2，MVP_SPEC §1–1.3，TECH_DESIGN §1–2；TEAM_WORK_PLAN §1–3；W4 §1–2；DESIGN 接收说明、Overview、来源与本地链接。旧文档仅用于理解本次迁移影响，新的明确归档指令优先；本次不实现或重新确认旧 M/AC/NFR、接口契约及阶段验收。

## 方案与验收

1. 保留原目录结构、文件内容和证据附件，整体移入 `docs/archive/`；移动前后逐文件比对 SHA-256、数量与大小。
2. 根 `DESIGN.md` 仅修正相对链接与已退役的产品依据说明，保留视觉规范；新 AGENTS 明确 UI 遵循该文件，默认阅读和搜索排除归档，旧文档不构成需求、授权、分工或验收依据。
3. README 保留启动信息，以新规则和设计规范作为开发入口；归档说明标明停止维护。
4. 验证现役入口的本地链接、规则中旧引用清除情况、差异空白、写集与无关改动保留。不重跑无变化的应用测试，不把文档检查表述为产品验收。

迁移前 `node tools/a0-review/check.mjs` 退出码 0：150 文档、2012 内链、errors=[]。该工具绑定即将退役的旧产品与 A0 任务结构；新规则不再将其列为开工或交付门禁。

## 执行与验证

本地整理完成。原 `docs/` 内 696 个已跟踪文件中，`DESIGN.md` 移至根目录，另外 695 个文件（147 份 Markdown 文档及 548 个附件/证据文件）按原结构移入 `docs/archive/`。原有忽略文件 `.DS_Store` 也随目录移动；全部 696 个归档原文件的 SHA-256 与大小逐一匹配，无缺失、覆盖或正文变更。归档内另外新增本记录与 README；`docs/` 归档外已无 Markdown 文档。

根 AGENTS 重写为 39 行，仅链接 README 与 DESIGN；移除旧基线、固定分工、阶段门禁和强制旧文档检查，明确默认排除归档且间接引用不恢复其效力，UI 必须遵循根 DESIGN。README、学生端 README 与来源记录同步当前入口；DESIGN frontmatter 与设计正文保持一致，仅调整开头依据说明和本地相对链接。

| 验证 | 实际结果 |
| --- | --- |
| 迁移前后文件 SHA-256、大小与数量比对 | 696 个归档原文件全部一致，包含 695 个已跟踪文件 |
| 8 份本次涉及文档的本地链接检查 | 107 处通过；范围为根 AGENTS/README/DESIGN、学生 README/IMPORT_SOURCE、归档 README/本文、SEED_LOCAL_COURSES |
| 根 AGENTS 旧路径/旧规范名称断言 | 通过；仅有 README 与 DESIGN 两个文档链接 |
| DESIGN frontmatter 与 Overview 后正文对照 | 通过；规范和取值不变，仅重定位本地链接 |
| `git diff --check` 与新文档空白检查 | 通过 |
| 学生工程 `rtk npm test -- src/workspace/hdlStore.test.ts src/workspace/hdlWorkspace.test.ts` | 移动后修复前两套件因 ENOENT 失败；独立 fixture 后 28/28 通过 |
| `node --check tools/i0-hdl/seed-local-courses.mjs` | 通过 |
| `node tools/i0-hdl/seed-local-courses.mjs --teaching-root "$PWD/apps/teaching"` 及追加 `--full-inputs` | 两种 dry-plan 通过；未执行 apply、网络请求或环境写入 |
| 归档后旧 `node tools/a0-review/check.mjs` | 退出码 1：`Missing A0 task document`；工具仅服务已停用的旧规格流程，未接入工程 npm scripts/CI，未改成继续维护归档，不计作通过 |

独立 HDL fixture 为 305474 字节，SHA-256 为 `423fe94a4398f8fa94ea2d40c251d29c7874b040a4962f180c8df2baa6ae6985`，与原已跟踪数据逐字节一致；三个读取点不再依赖 docs。未找到直接覆盖 seed 的既有测试，语法与 dry-plan 检查不冒充测试数量。

事实面：文档与规则为 changed-and-verified；测试/工具数据路径为 changed-and-verified，业务逻辑未变；运行环境、部署、教学效果及个人记忆为 out-of-scope；工作区写集与 Git index 已复核。旧正文、内部链接及专用历史检查均停止维护，不宣称全仓所有旧文档/工具检查通过。

现场差异：开工时原有未跟踪 `.zcodeignore`，复核时该文件已不存在；主 Agent 和子 Agent 均未操作它，未擅自重建。`docs/.DS_Store` 在移动后重新出现，属于忽略文件，未清理。无本次产生且需删除的临时文件。

交付为本地修改，未暂存、提交、推送、合并或部署；本次范围无剩余待办。回滚时可反向移动目录并还原本次入口/路径变更，需保留期间其他改动。本记录随本轮旧文档一并归档，仅作为此次整理的历史记录，不作为后续开工材料。
