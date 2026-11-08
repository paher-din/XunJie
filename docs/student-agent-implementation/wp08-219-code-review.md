# WP08 #219 代码审查

审查基线：`39d234cf`。按 `code-review` skill 的 Standards / Spec 两轴审查，以下记录最终处理结果。

## Standards

- **已修复**：`PersonalMaterials.css` 的圆角改为 DESIGN.md 的 6px（版本标签）与 8px（表单），操作按钮最小高度改用 28px / 13px。
- **已修复**：个人笔记本机请求不再创建第二个 IndexedDB；改为 `xunjie-reliable-works-v1` v11 的 `personalMaterials` 分区，复用 `openWorkspaceDatabase`、`ReliableRecordStore` 和 `scope` 索引。
- **已修复**：`teaching-agent/student-facts.ts` 删除读取 learning-data `activities` 的 fallback；`TeachingStudentFactsOptions.activity` 由宿主提供，单元测试也显式注入活动读取器。
- **已修复**：`verifyPersonalMaterialReference` 复核 `personal_materials.activity_id`；跨活动固定引用返回 `invalid`，不泄漏材料。
- **已修复文档**：`teaching-agent/README.md` 记录 v4 边界、事实表和新增工具；`learning-data/README.md` 记录迁移 24；`learning-entry/README.md` 增加 `materials/*` 路由；新增本票交付文档和证据目录，`check:docs` 为 0。
- **保留判断**：`PersonalMaterials.tsx` 与 `PdfMaterials.tsx` 的同构控制器骨架可在后续统一抽象；本轮以可靠保存/定位行为为先，不引入跨材料通用层。

## Spec

- **已修复**：个人笔记检索命中在草稿引用选区之外时，新增 `read_personal_material` 固定版本/UTF-16 范围读取工具，并由产品工具测试覆盖。
- **已修复**：`search_materials` 的 PDF 定位传递 `locator.page`；课程材料命中打开材料面板并按 `data-material-id` 定位；Skill 附件明确提示无独立文件面板；个人笔记按命中范围定位。
- **已修复**：`student-facts` 的 `personalContinuation` 只在非 `current-activity` scope 生效，并同时要求 `activity_course_id IS NULL` 与活动目标匹配，避免跨课程读取。
- **已修复**：检索源失败区分 `missing` / `partial-failure` / `no-access`；空文本归为 `no-text`；显式选定但无草稿引用的个人资料/PDF 归为 `missing`。
- **证据**：桌面 Chrome 前后截图和真实验收环境说明见 [证据索引](evidence/wp08-219/README.md)。本地模型链路通过产品运行时真实 HTTP 工具请求断言来源清单；未使用厂商线上模型，不将本地 fixture 当作真实学习效果。

## 结论

两轴没有未解决的功能性阻塞。工程测试、浏览器验收和教学效果在上文分别列出，不互相替代。
