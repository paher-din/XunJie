# 学习空间图标库

2026-10-10 定稿，基于已确认的 `color-polish-v2` 对照稿。这里集中维护图形、取用接口、用途清单和来源；产品页面与网页看板共用同一份资源。

2026-10-11 品牌更新：侧栏的 `learning-space` 占位产品标识已被循阶 C「叠进」定稿替换。旧图形与原始评审条目保留为历史资源；正式 Logo 通过 `brand/XunjieLogo.tsx` 取用，定稿与用法见 [品牌资产库](https://github.com/wubq511/XunJie_Design/blob/a9bb1dd016489d3e60e0b45933e440296c1194d8/docs/brand-assets/xunjie-logo/README.md)（设计仓库固定提交，未随导入复制到本仓库；参见 [IMPORT_SOURCE.md](../../IMPORT_SOURCE.md)）。

## 取用

在 `app/` 运行 `npm run dev`，访问 `http://localhost:5173/#/icons`（实际端口以 Vite 输出为准）。看板支持中文 / 英文名称及用途搜索、来源筛选、浅深背景、16 / 20 / 24 / 32px、风格对照、复制 React 用法与下载独立 SVG。看板是维护入口，不增加学生端导航项。

```tsx
import { Icon, IconText } from '../icons'

<Icon name="paperclip" />
<Icon name="file-spreadsheet" size={24} />
<Icon name="virtual-board" tone="neutral" />
<Icon name="home-2" variant="bold" />
<IconText name="checklist">检查并构建</IconText>
<IconText name="pin" position="end">固定到右侧</IconText>
```

`IconName`、`IconTone` 与 `IconVariant` 有类型约束。每个图标使用清单中的默认风格和颜色，`tone="neutral"` 跟随控件文字颜色。指定的风格未收录时使用该图标默认风格；看板只列出实际收录的风格。组件默认作为装饰图形：按钮的可访问名称放在按钮自身；独立、有意义的图形可传 `label`。

- `svg/`：96 个图形，109 个 SVG 文件（含必要风格变体）。可直接复制 SVG；单色 / 双层图形使用 `currentColor`，在外部工具中按需指定颜色。
- `catalog.ts`：唯一资源清单，包含名称、默认色与风格、用途、作者、来源、许可、修改说明。
- `Icon.tsx` / `icons.css`：本地 React 取用与语义色；无图标包依赖或运行时 CDN。
- `review-inventory.json`：114 项原评审用途归档，含保留项、可选项、后续储备与数据预留；历史源位置不作为当前代码行索引。已删除的任务预览页明确标为「已移除页面」。
- `COVERAGE.md`：当前页面与原始评审的覆盖核对；当前用途以 `catalog.ts` 为准，原始清单不随功能落地改写。
- `provenance.json`：定稿 SVG 的 SHA-256，供后续变更对照；修改资产时同步更新摘要。
- `IconBoard.tsx` / `icon-board.css`：网页看板，应用内 `#/icons` 独立路由。
- `ATTRIBUTION.md`：图形来源与许可说明。

看板自动读取清单。入口样式由 `main.tsx` 最后加载 `icons.css`，确保覆盖旧占位样式。

## 选图与补图

1. 先判断要表达的对象、动作或状态，再查现有资源的图形与用途。语义吻合时复用；现有清单不是可选图标的上限。不能只因外形相近或文件已存在，把其他功能的图标硬塞进新内容。
2. 需要额外图标时自主补充：通用概念优先查同风格的 Solar Linear；库中没有准确表达时，按现有风格自绘。以 24×24 画布、1.5px 线宽、圆润端点与转角、`currentColor` 为基准，保持留白、视觉重量与同组图标协调；彩色附件、成就和品牌沿用各自已确认体系。
3. 新图形统一放入 `svg/`，在 `catalog.ts` 登记语义名称、实际用途、来源、作者、许可与修改说明，同步 `provenance.json` 摘要及必要的来源说明。页面通过 `Icon` 取用；共享图标不散落为页面内联 SVG。新增用途没有原始评审编号时留空，保留 `review-inventory.json` 历史归档。
4. 在实际页面与看板的目标尺寸下检查辨识度、图文对齐和整组协调；需要时同时检查浅深背景。图标辅助相邻文字，不能靠颜色或图形暗示文本未表达的结论；没有必要的装饰可省去。

## 已落入页面

侧栏与收起轨道、产品小标、账号菜单、首页任务入口与课程封面回退、看板编辑、成就徽章、两类对话的助手小标 / 输入 / 停止 / 复制 / 重试 / 思考折叠、彩色附件、建议问题填入、任务工作区导航 / 固定 / 收纳 / 工具标签 / 运行操作、设置页导航与模型供应商管理。

操作图标默认单色 Solar Linear，当前导航用 Bold；附件用同一折角文件轮廓与类型色，正常图片保留缩略图，读取失败才用图片文件图形。成就用 OpenMoji，等级与未解锁状态以独立文字表达。产品小标和助手小标采用这轮确认的专属图形；动画 IP、渐变头像、真实图表 / 数码管 / 波形 / 上传进度环保留。可选及未来用途集中预留，不为了用完图标新增功能。

品牌图形保留既有 DeepSeek / MiMo 文件；后续新增品牌优先调查 Simple Icons / Skill Icons，并记录实际所用资产来源。

## 图标与文字对齐

图文按钮 / 文字标识使用 `IconText`：图标与文字是两个居中对齐的 flex 内容盒，`position="end"` 可把图标放在末尾。不要直接把 SVG 和文字拼在同一行后再加 `translateY` / 负 `vertical-align` 补偿；字号和 CJK 字体变化会让偏移重新出现。纯图标按钮由共享样式按按钮盒居中，已有多元素 flex 菜单保持各自布局。徽章、封面、预览尺寸说明等上下排列的内容不属于同行对齐。

`IconText` 未指定 `size` 时，图标按相邻字号的 `1.15em` 缩放，限制在 14–18px；例如 12px 操作文字配 14px 图标、14px 文字配约 16px 图标。显式 `size` 保持固定尺寸。`Icon` 的独立取用仍默认 16px，导航、发送按钮、封面、徽章与附件按各自用途指定尺寸，不套用同行比例。主要操作文字至少 12px；状态注释、图表刻度与附件角标保留辅助层级。
