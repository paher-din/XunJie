---
version: alpha
name: 循阶
description: 学生端引导式项目制教学测验界面的设计系统——纯白中性基底 + Apple 系统蓝强调 + 亮底深字的语义色，配收敛后的字号、圆角、间距、分层与动效规范；深色模式是同一角色集的炭灰对应值。frontmatter 的 colors 记浅色定稿值，深色值见正文「深色模式」一节。
colors:
  canvas: "#ffffff"
  sidebar: "#f9f9f8"
  line: "#e8e8e6"
  line-strong: "#e0e0de"
  ink: "#1f2328"
  ink-soft: "#42474d"
  muted: "#656d76"
  faint: "#9ca0a6"
  hover: "#f4f4f2"
  chip: "#f1f1ef"
  primary: "#1f2328"
  danger: "#d5443e"
  inverse: "#1a1d23"
  on-solid: "#ffffff"
  accent: "#007aff"
  status-progress-bg: "#cffafe"
  status-progress-fg: "#155e75"
  status-done-bg: "#ecfccb"
  status-done-fg: "#3f6212"
  status-pending-bg: "#fef9c3"
  status-pending-fg: "#854d0e"
  status-overdue-bg: "#ffe4e6"
  status-overdue-fg: "#9f1239"
  label-purple-bg: "#f3e8ff"
  label-purple-fg: "#6b21a8"
  label-purple-solid: "#e9d5ff"
  label-pink-bg: "#fce7f3"
  label-pink-fg: "#9d174d"
  label-pink-solid: "#fbcfe8"
  label-teal-bg: "#ccfbf1"
  label-teal-fg: "#115e59"
  label-teal-solid: "#99f6e4"
  label-orange-bg: "#ffedd5"
  label-orange-fg: "#9a3412"
  label-orange-solid: "#fed7aa"
  label-gray-bg: "#f3f4f6"
  label-gray-fg: "#1f2937"
  label-gray-solid: "#e5e7eb"
  chart-blue-0: "#d9ebff"
  chart-blue-1: "#a6ccff"
  chart-blue-2: "#409cff"
  chart-blue-3: "#007aff"
  chart-blue-4: "#0059d0"
  chart-neut-0: "#f0f1f4"
  chart-neut-1: "#e8e8e6"
  data-now: "#0059d0"
  mosaic-0: "#4f6ef7"
  mosaic-1: "#a9befc"
  mosaic-2: "#2b3a8f"
  mosaic-3: "#ffb347"
  course-0-bg: "#eff3fb"
  course-0-fg: "#5b7bb5"
  course-1-bg: "#fbf4ea"
  course-1-fg: "#9c7f52"
  course-2-bg: "#f2f0f9"
  course-2-fg: "#8776a8"
typography:
  sans:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif"
  serif:
    fontFamily: "'LXGW WenKai', 'Kaiti SC', 'STKaiti', serif"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
  font-size-11:
    fontFamily: "{typography.sans}"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: "1.5"
  font-size-12:
    fontFamily: "{typography.sans}"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "1.5"
  font-size-13:
    fontFamily: "{typography.sans}"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "1.5"
  font-size-15:
    fontFamily: "{typography.sans}"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: "1.5"
  font-size-17:
    fontFamily: "{typography.sans}"
    fontSize: "17px"
    fontWeight: 600
    lineHeight: "1.5"
  font-size-20:
    fontFamily: "{typography.sans}"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: "1.5"
  font-size-22:
    fontFamily: "{typography.sans}"
    fontSize: "22px"
    fontWeight: 400
    lineHeight: "1.5"
  font-size-28:
    fontFamily: "{typography.sans}"
    fontSize: "28px"
    fontWeight: 600
    lineHeight: "1.5"
  font-size-34:
    fontFamily: "{typography.sans}"
    fontSize: "34px"
    fontWeight: 600
    lineHeight: "1"
  body:
    fontFamily: "{typography.sans}"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: "1.5"
  h1:
    fontFamily: "{typography.serif}"
    fontSize: "28px"
    fontWeight: 600
    lineHeight: "1.5"
  h2:
    fontFamily: "{typography.serif}"
    fontSize: "17px"
    fontWeight: 600
    lineHeight: "1.5"
  h3:
    fontFamily: "{typography.serif}"
    fontSize: "17px"
    fontWeight: 400
    lineHeight: "1.5"
  numeric:
    fontFamily: "{typography.mono}"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "1.5"
rounded:
  radius-0: "0px"
  radius-4: "4px"
  radius-6: "6px"
  radius-8: "8px"
  radius-12: "12px"
  radius-16: "16px"
  radius-20: "20px"
spacing:
  space-2: "2px"
  space-4: "4px"
  space-6: "6px"
  space-8: "8px"
  space-10: "10px"
  space-12: "12px"
  space-14: "14px"
  space-16: "16px"
  space-20: "20px"
  space-24: "24px"
  space-32: "32px"
  control-height-20: "20px"
  control-height-24: "24px"
  control-height-28: "28px"
  control-height-32: "32px"
  control-height-36: "36px"
  control-height-40: "40px"
  control-height-44: "44px"
  control-height-48: "48px"
  control-height-52: "52px"
  control-height-56: "56px"
components:
  panel:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    rounded: "{rounded.radius-16}"
    padding: "16px"
  task-card:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    rounded: "{rounded.radius-8}"
    padding: "20px"
  course-tile:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    rounded: "{rounded.radius-12}"
    padding: "0 0 16px"
  status-badge-progress:
    backgroundColor: "{colors.status-progress-bg}"
    textColor: "{colors.status-progress-fg}"
    rounded: "{rounded.radius-6}"
    padding: "4px 8px"
  status-badge-done:
    backgroundColor: "{colors.status-done-bg}"
    textColor: "{colors.status-done-fg}"
    rounded: "{rounded.radius-6}"
    padding: "4px 8px"
  status-badge-pending:
    backgroundColor: "{colors.status-pending-bg}"
    textColor: "{colors.status-pending-fg}"
    rounded: "{rounded.radius-6}"
    padding: "4px 8px"
  status-badge-overdue:
    backgroundColor: "{colors.status-overdue-bg}"
    textColor: "{colors.status-overdue-fg}"
    rounded: "{rounded.radius-6}"
    padding: "4px 8px"
  label-tag:
    backgroundColor: "{colors.label-purple-bg}"
    textColor: "{colors.label-purple-fg}"
    rounded: "{rounded.radius-6}"
    padding: "4px 10px"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-solid}"
    rounded: "{rounded.radius-8}"
    padding: "8px 16px"
  button-outline:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.radius-8}"
    padding: "8px 16px"
  ask-bubble:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    rounded: "12px"
    padding: "0 10px"
  ask-bubble-open:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    rounded: "27px"
    padding: "0 10px 0 16px"
  prompt-input:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    rounded: "{rounded.radius-12}"
    padding: "14px 14px 10px"
  overlay-tip:
    backgroundColor: "{colors.inverse}"
    textColor: "{colors.on-solid}"
    rounded: "{rounded.radius-8}"
    padding: "6px 10px"
  overlay-menu:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    rounded: "{rounded.radius-12}"
    padding: "6px"
  overlay-panel:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    rounded: "{rounded.radius-16}"
    padding: "14px 18px"
  toast:
    backgroundColor: "{colors.inverse}"
    textColor: "{colors.on-solid}"
    rounded: "{rounded.radius-8}"
    padding: "10px 18px"
  mosaic:
    backgroundColor: "{colors.inverse}"
    textColor: "{colors.on-solid}"
    rounded: "{rounded.radius-16}"
    padding: "4px"
---

# 循阶 Design System

接收日期：2026-10-15。来源为 XunJie_Design 的 [docs/DESIGN.md](https://github.com/wubq511/XunJie_Design/blob/a9bb1dd016489d3e60e0b45933e440296c1194d8/docs/DESIGN.md)。接收时来源仓库 HEAD 为 `16558426ce70524218eacbf7ce8fde35681c0503`；源文件最后修改提交为 `5a9486b4d33e43e4116c36aa537c6c9940771f73`，内容与首次导入的已发布提交 `a9bb1dd016489d3e60e0b45933e440296c1194d8` 完全相同（Git blob `67d96c1c0e52e7601a3c74137e89e66742d7b476`）。未导入的设计页、原型与研究证据链接固定到该已发布来源；本仓库代码路径已改为 `apps/student/`。原文件保留，设计取值与规则照录。

本文件用于此后学生端的视觉与交互改动；产品范围、权限、数据、真实状态与验收以主仓库 [PRD](product/PRD.md)、[MVP_SPEC](product/MVP_SPEC.md)、[TECH_DESIGN](product/TECH_DESIGN.md) 和当前获准任务为准。设计示例中的看板、进度、课程状态等不代表已有真实业务字段；不得用演示数据填补。正文的“合并结果”及 2026-10-11 测试、对比度与实屏验收均是来源仓库的历史记录，不是本次主仓库的新验证；来源映射与后续同步边界见 [IMPORT_SOURCE](../apps/student/IMPORT_SOURCE.md)。

## Overview

学习空间是「循阶」学生端界面的设计系统，覆盖首页、课程任务、Agent 对话页、任务工作区四个已确认页面。系统从零逐因素定稿（①配色 → ⑩ IP 与插画，2026-10-01 至 2026-10-10 全部结项），每个因素都做过变体 library 原型评审，结论汇于本文档。本文档是 token 的权威来源；**合并已于 2026-10-11 执行完毕**——[apps/student/src/styles/tokens.css](../apps/student/src/styles/tokens.css)、[apps/student/src/styles/app.css](../apps/student/src/styles/app.css)、[apps/student/src/icons/icons.css](../apps/student/src/icons/icons.css) 与 [apps/student/src/components/dashboard/widgets.tsx](../apps/student/src/components/dashboard/widgets.tsx) 已是本文档的可执行形态，落地清单与逐值复核见 [docs/prototypes/design-system/README.md](https://github.com/wubq511/XunJie_Design/blob/a9bb1dd016489d3e60e0b45933e440296c1194d8/docs/prototypes/design-system/README.md) 的「2026-10-11 落地记录」与本文 Source Analysis。

系统性格由三处咬合决定：

- **中性基底 + 一个强调蓝**：纯白画布、浅灰侧栏、hairline 描边，配 Apple 系统蓝；语义色只做小面积状态标记，成片着色不进入设计。
- **文档化而非 App 化**：标题用中文衬线、字号与字重收敛到 Apple 系统阶与 400/500/600 三档、控件去胶囊改圆角矩、阴影近零——与 Notion 一脉的基底同气质。
- **背景安静、前景克制**：动效四档时长 + 两条曲线，反馈幅度减半；仪器材质（虚拟开发板底座）与 IP 领地（动画形象）刻意排除在通用规则之外。

## Colors

**中性基底**：画布 `canvas #ffffff`、侧栏 `sidebar #f9f9f8`、hairline `line #e8e8e6`。文字四级 `ink #1f2328` / `ink-soft #42474d` / `muted #656d76` / `faint #9ca0a6`；面两级 `hover #f4f4f2`（悬停）与 `chip #f1f1ef`（次级填充）。控件描边比 hairline 深半档：`line-strong #e0e0de`，属①角色表刻意保留，**不要**当残值清成 hairline。主按钮用近黑 `primary #1f2328`，不用强调蓝做大面积底。

**四级字的用法口径（2026-10-11 补记）**：`faint #9ca0a6` 在白底只有 2.63:1，**只留给纯装饰墨色**（分隔点、隐藏态图标、开发板刻度这类不承载信息的位置）；任何「说了话」的辅助文字——行内 hint、说明小字、等宽取值、空态说明、时间戳——一律用 `muted`（白底 5.2:1、`chip` 底 4.6:1，达标 AA）。`ink-soft` 只给正文级信息（等宽取值、次级正文）。链接蓝若落在 12–13px 小字上，用 `accent-deep #0059d0`（6.3:1）而不是 `accent #007aff`（4.0:1）；危险语义小字同理走 `danger-deep #c1352d`，`--danger` 只留给图形与大面积底色。

**强调色**：`accent #007aff`（Apple 系统蓝）。已知受限：白字对比仅 4.02:1，低于 AA 的 4.5:1，处置约束见 Do's and Don'ts。它同时是图表数据蓝的第 3 档——全站只有一个蓝系。

**状态语义 = 亮底深字 · 轻盈档**（配方来自 boardui：Tailwind 100 底 + 同 hue 800 字；进行中取青不取蓝，避免状态蓝与品牌蓝粘连而把「进行中」误读为可点击）：

| 状态 | 底 | 字 |
| --- | --- | --- |
| 进行中 | cyan-100 `#cffafe` | cyan-800 `#155e75` |
| 完成 | lime-100 `#ecfccb` | lime-800 `#3f6212` |
| 等待中 | yellow-100 `#fef9c3` | yellow-800 `#854d0e` |
| 逾期 | rose-100 `#ffe4e6` | rose-800 `#9f1239` |

**备用标签库**：语义色库共 10 hue——4 个绑定状态（完成 lime / 进行中 cyan / 等待 yellow / 逾期 rose）+ 未绑定的同族蓝 + 5 个备用 hue（紫 / 粉 / 青碧 / 橙 / 中性灰）。每 hue 有三档：soft（100 底 + 800 字，即上表配方）、base 与 bold（实底第二表达，深底白字，见 frontmatter 的 `*-solid`）。备用 hue 用于分类、里程碑、知识点标签等，**不作强调色**——紫相强调有「一眼 AI」风险。实底白字只配 base/bold 档，**不要**在 soft 底（100 档）上压白字。

**图表用色**：数据蓝收敛为 Apple 蓝五档 `chart-blue-0 #d9ebff` → `-1 #a6ccff` → `-2 #409cff` → `-3 #007aff` → `-4 #0059d0`；原先 14 个蓝值、四代并存（钢蓝 `#587cb8` / 亮钴 `#4f6ef7` 系 / 热力淡蓝 / 皮肤钴）全部并入这一族——热力四档、bars7、环形、雷达、趋势、周节奏气泡、目标条、时间线、技能 / XP / 等级同源。中性两档：槽底（热力空格 / 进度轨道 / 技能条 / XP 轨道 / 周节奏空点）统一 `chart-neut-0 #f0f1f4`，描线（雷达网 / 趋势网格 / 时间线竖线 / goal tick / 周线指引 / 环形轨道）统一 `chart-neut-1 #e8e8e6`（即 hairline）；8 个近灰值收敛到 2 档。

「现在 / 今天」五处（bars7 今天柱 + 标签、时间线 now 点、周圆点 today、热力 today 描边、goal-now 标签 + 箭头）统一 `data-now #0059d0`（即 b4），光晕 `rgba(0,89,208,.15)`。**「暖 = 此刻」的语义已取消**，此刻改由位置与形状承载；`#ff8a3d` 系列不再是 token。构成图（mosaic）是有意例外：四格保持现状 `#4f6ef7` / `#a9befc` / `#2b3a8f` / `#ffb347`，是全看板唯一不跟随 Apple 蓝的图表（同屏两种蓝），也是唯一保留暖色处。**课程色与插画**：课程色 `course-0 #eff3fb/#5b7bb5`、`course-1 #fbf4ea/#9c7f52`、`course-2 #f2f0f9/#8776a8`（以 `tokens.css` 现役值为准；本文件早前写作 `#eef3fd/#7d99c5`、`#fff4e9/#b49365`、`#f0edfa/#9985ba`，其中 `#7d99c5` 实为工作区中栏插画的描边色，已勘误）；火焰是 OpenMoji 资产贴纸（`#fcea2b` / `#f1b31c`），属插画体系、不参与图表调色板，且已去光晕。

## Typography

三套字体族各司其职：**正文 / 控件 = 系统栈**（`sans`，不引入正文 webfont）；**标题衬线 = 霞鹜文楷**（`serif`），仅用于 h1–h3，自托管于 [apps/student/public/fonts/lxgw-wenkai-regular.woff2](../apps/student/public/fonts/lxgw-wenkai-regular.woff2)；**等宽 = 系统等宽栈**（`mono`），用于数值、版本号、token 计数。已知约束：文楷目前只自托管 Regular 一档，标题的 600 由浏览器合成加粗。

字号阶梯 = Apple 系统阶 9 级 **11 / 12 / 13 / 15 / 17 / 20 / 22 / 28 / 34**，吸附规则等距最近、平局向上。已确认落点：正文 `14 → 15`（body 的 `font:` 简写整体升半档）、h1 `29 → 28`、h2/h3 `16 → 17`、品牌行 `16 → 17`。

字重三档 **400 / 500 / 600**：700 / 750 / 800 全归 600（苹方原生上限，跨平台所见即所得），550 → 500，非标中间值全部消失。行高收一档 **1.5 / 1.7 / 1.9**（平局向下）：正文 `1.55 → 1.5`、卡片 `1.6 → 1.5`、气泡 `1.75 → 1.7`、长阅读 1.9 保持；< 1.2 或 > 2.4 豁免（看板大数字的 `line-height: 1` 即此例）。字距四档 **-0.4 / 0 / 1 / 1.5px**（平局向下，避免 0.5→1 的抬升）：h1 的 -0.7、大数字的 -0.5 归 -0.4，导航字距 `1px` 等保留。字号与字重即信息层级上限：主操作文字不小于 12px，状态注释、图表刻度、附件角标停在辅助层级。

### 学生端文字层级定稿（2026-10-19）

本轮保留原有字体家族：首页问候为文楷 28px／600，区块标题为文楷 17px／600；首页继续任务标题收敛为 600，课程卡与准备入口标题为 15px／500。设置分组继续使用文楷 17px／600，不改为系统无衬线。

首页课程标签、月份、课程数量、看板辅助说明为 12px；继续任务的句子说明为 13px。小号课程文字用 `accent-deep`，旁边装饰点保留 `accent`；月份与数量等信息用 `muted`。

独立 Agent 正文保留 15px，行高为 1.7；回答内任务卡标题为系统字体 15px／500，课程标签与环境说明为 12px，环境说明用 `muted`。这些局部规则仅作用于首页和独立 Agent 页；工作区辅导的正文行高与样式保持现状。

## Layout

**外壳与栅格**：inset 布局——全局侧栏展开宽度固定 **248px**（不压缩侧栏本身；无手动选择时，窗口 <1024px 默认收起为 60px 轨道，详见下方 C5），承载首页 / Agent 对话两个一级入口与对话历史展开区；主区是屏幕上唯一一张白卡片（1px 描边、单层轻投影、上 / 右 / 下各留 10px），**滚动发生在主卡内部**，四个圆角始终完整可见。展开 ↔ 收起共走一条 0.35s 曲线，收起后左侧留 60px 浅灰轨道放图标列（首页 / Agent 对话 / 新对话 / 已归档 / 搜索，归档仅 /agent 页且有归档时露面）。工作区（`/task/*`）进入沉浸模式：侧栏 248px → 0 滑出，主区去掉 margin 与圆角、占满全屏，**保留 1px hairline 描边与 l2 轻投影**（2026-10-11 终验按 computed 实测勘误：`.shell.immersive .main` 实为 `height:100vh; margin:0; border-radius:0`，`border-top` = `1px #e8e8e6`、`box-shadow` = `0 1px 2px rgba(24,34,57,.05)`，与原型注入态逐值一致），返回靠工作区内的单枚「‹ 返回」（走历史回退）。

**间距与密度**：阶梯 = **2px 偶数化**——奇数抖动值（3/5/7/9/11/13…共 91 处）归相邻偶数（平局向上），主力值 6/8/10/12px 全部保留，只清抖动、不动节奏。方形控件（头像、图标按钮、状态块）高度走 4 级数表 **20 / 24 / 28 / 32 / 36 / 40 / 44 / 48 / 52 / 56**，平局向上；区间 `[20, 58]px` 之外豁免（长条输入、整卡高度不参与）。已确认落点：头像 `30 → 32`、工作区 dbtn `30 → 32`、navbtn `26 → 28`、方块按钮 52/54/56 → 52/56。工作区指挥栏基准：32px 控件高 / 8px 圆角 / 文字 12.5px（按阶梯归 13）；状态一律裸排、只有操作用盒，窄窗口先收起辅助文字、保留图形与关键数值。

**动效与反馈**：时长四档 **150 / 240 / 350 / 500ms**，对应四种真实运动规模——微反馈 150（悬停、按压、变色）、展开 240（菜单、气泡弹出）、布局移动 350（侧栏滑出、面板位移）、入场 500（页面级渐现）。豁免**白名单制**：>900ms 与 0s 技巧需显式入清单才可用（当前清单：循环装饰 bob / blink 的 4–5s、IP 骨架待命 12.4s / 倾听 7.6s / 单次邀请 1.6s / 单次庆祝 1.66s / 换装下探-亮出 1.0s、`visibility` 切换用的 0s linear 技巧）。曲线两条：**S = `cubic-bezier(0.3, 1, 0.35, 1)`** 为全站标准（侧栏滑动、菜单展开、卡片位移）；**B = `cubic-bezier(0.34, 1.56, 0.64, 1)`** 用于小元素弹出（✓ 弹跳、引导气泡、菜单 scale+fade）。隐式 `ease` 不单独建档——它等价于 `cubic-bezier(0.25, 0.1, 0.25, 1)`，需要显式化时直接写这条；**关键帧内的过冲随关键帧保留**（`check-pop` 60% 处 `scale(1.25)`、`bubblepop` 62% 处 `scale(1.045)`）。反馈幅度**收敛 ×0.5**：卡片悬停位移 `-2 → -1px`、按压缩放 `0.9 → 0.95`、IP 摆动 `-4 → -2px`；所有悬停规则都有颜色 / 描边并行通道，位移减半不损失可察觉性。`prefers-reduced-motion` 下全局禁用。

### 工作区信息组织（2026-10-19 确认，供后续重构）

工作区围绕**任务目标、当前作品和运行结果**组织信息，让学生能够理解要完成什么、正在处理哪份作品，以及结果与作品之间的关系。该原则不指定新的面板数量或布局；当前工作区暂不改动，在后续工作区重构时落实。

- 任务目标、要求和材料应容易找到，不能默认排在会话、Assignment 或运行时标识之后。
- 当前作品、保存状态、只读状态与运行结果应有清楚的关联；明确结果对应的作品版本，避免让学生靠多个分散控件推断。
- 会话 ID、活动 ID、`recoveryGeneration`、`loadEpoch` 等工程信息进入按需展开的技术详情。会影响当前操作的保存失败、版本冲突、连接状态和恢复提示仍需直接可见。
- 面向学生的文案优先表达学习与作品操作；底层术语在需要排障或核对时保留。调整呈现不能改变尝试创建、保存确认、快照固定、运行来源和只读终态的实际语义。

### 页面入场（2026-10-11）

**一次进入 = 两拍**：容器 `.page-enter` 240ms 渐现给出「换了一屏」，页面的主区块各自 350ms 自下 8px 浮入，按阅读顺序错峰——同一时刻出现的元素越多越读不出结构，级联把「先看什么」写进时间轴。全部落在 ⑦ 既有时长档内（容器用页面级渐现、区块用布局移动、浮层用展开），不新增档位；时间轴变量集中在 `app.css` 头部：`--enter-page / --enter-rise / --enter-stagger / --enter-i`。

| 页面 | 级联顺序 | 拍长 |
| --- | --- | --- |
| 首页 | 问候 → 看板 → 课程与任务；看板内部再走半拍（标题行 → 两块卡 160/200/240ms） | 70ms |
| Agent 对话 | 对话流 → 输入框；消息内块的入场由各自的 `.turn-linein` / `.chat-message` 照旧，回访时整段不重播 | 70ms |
| 设置 | 左列 8px 横向滑入 → 内容；内容里每个 `.st-section` 再各排一拍（标签切换即重排——`.st-body-in` 挂 `key`，切换必须重新发生，整页刷新与标签切换才都有入场） | 50ms |
| 任务工作区 | 指挥栏自上 −6px 落位 → 工作区主体；首次进入的任务信息卡延到 240ms，避免两个页面同时进场 | 70ms |
| 首页看板 · 热力图 | 格子步长沿用 JS 内联（`i*20 + j*9ms`），比卡片落位早一拍起步、收在折线描画（1s 白名单长动画）之后 | 20/9ms |

**只在首次进入时播**：`.page-enter` 按 `location.key` 重挂载，`AppShell` 维护已访问路径集合，回访时落 `.revisit` 一档摘掉动画——入场是「新页面出现」的反馈，不是路由动作的装饰；搜索串变化（`/?course=`）不重挂载、不播，后退与已访问页之间来回也不重播。判定不依赖 `navType`（`POP` 同时覆盖「后退」与「再次点导航进入」，后者期望播）。

容器只声明 `overflow: hidden`，可见性基准必须是 1——`backwards` 填充只借属性值播动画、播完即还权，容器不能靠填充保持可见（首版曾把 `opacity: 0` 写成属性，数据晚到一帧整页就永久空白，实屏抓到后已改）。


## Elevation & Depth

**l2 = 描边 + 微阴影**：面板族统一 `border: 1px solid var(--line)`（hairline）+ `box-shadow: 0 1px 2px rgba(24,34,57,0.05)`。白卡浮在浅灰底上靠这双重轻分层，不靠加重阴影。**面板族**（应用 l2）：`.main` / `.task-card` / `.course-tile` / `.msg-task-card` / `.dash-grid`（看板**整卡**）/ `.ws-pinned-card` / `.ws-board` / `.ws-intro-card` / `.prompt-tile`。

**o2 = 浮层三级递进**，阴影色统一 `rgba(28,36,48,α)`；深度差本身就是层级信号（提示 < 菜单 < 托盘），深色浮层（`.db-tip` / `.db-tray` / `.toast`）用 `inverse #1a1d23` 或 `#1f2328` 底 + 白字：

| 档 | 值 | 族 |
| --- | --- | --- |
| 轻 | `0 4px 12px rgba(28,36,48,0.10)` | 工具提示 `.db-tip` |
| 中 | `0 12px 32px rgba(28,36,48,0.14)` | `.account-menu` / `.prompt-model-menu` / `.ctx-tip` / `.ws-bubble` / `.ws-popstash` / `.ws-popcard` |
| 重 | `0 20px 56px rgba(28,36,48,0.18)` | `.db-tray` / `.ws-chatpop` / `.ask`（开态）/ `.railpanel` |

**刻意排除**（不参与本因素）：`.db-card`（看板内部细分格，保持官方稿平层，l2 只作用于整块看板）、`.ws-dock`（仪器底座，自带 inset 材质高光）、`.mascot`（⑩ 的 IP 领地）、强调光（LED 脉冲、进度条光晕、IP 光效）与语义色填充——它们是状态信号，不是分层手段。

## Shapes

圆角阶梯 = **嵌套友好 6 级** `0 / 4 / 6 / 8 / 12 / 16 / 20`。规则是**内层比外层小 4px**（卡片 16 / 内嵌卡 12 / 输入 8），让嵌套时圆心对齐、不出「洋葱角」——为「看板内嵌任务卡 / 面板」场景准备。吸附规则等距最近、平局向上；吸附豁免一直有效的是四类：`0`、百分比 / `50%`、`≥999px`、**语义胶囊**（`≥32px`，或半径恰为其半高——`.ask` 开态 27px = 54px 高的一半；同一盒子收起态的 34px 高 / 12px 圆角照旧走阶梯）。

**控件形状 = 全套圆角矩（去胶囊）**：badge / tag / chip / pill / status 族全部去掉 `999px` → **6px**；按钮、输入、导航块停在 8px；卡片与面板 12 / 16 / 20px。`999px` 只允许存在于豁免四类。例外与保留：**50% 正圆**是形状选择而非胶囊——头像、状态圆点、图表图例圆点保留圆，判据是元素近正方而非「细长条圆到头」；**`.ask` 开态 27px（= 半高）**与其它 ≥32px 语义胶囊保留，它们表达「长条输入」；**mosaic 构成块**不做 6px 化——它是 4px 间隙的深底网格，块本身无圆角，只由容器 16px 圆角裁切，图例 / 色块类元素按此逻辑走小档或 0。

### 课程区域定稿 C1–C4（2026-10-19）

课程封面与回退色块统一为 128px 高，保留课程色、48px 图标、12px 圆角与共享 hover；标题完整换行，同排卡片操作靠底对齐。任务目标说明采用 13px／1.7、muted，标题下距 8px、说明下距 16px；20px 内边距与至少 195px 高度不变，缺少进度、截止或目标时不补占位数据。

课程区域依据自身可用宽度排布：课程最多三列，最小列宽 280px、间距 8px（856px／568px 分界）；任务最多两列，最小列宽 320px、间距 12px（652px 分界）。工具栏区域宽度不足 720px 时搜索独占下一行，否则搜索宽 224px；筛选为 12px／muted，激活态仍用 chip 与 ink。

选课与直接课程链接沿用首页 `?course=`，主卡滚动定位到标题距顶部约 24px。任务区留足最小高度，使少任务或空课程也能定位。键盘选课把焦点移到标题，返回恢复触发卡焦点与原滚动位置；各浏览器历史条目分别保存位置，课程切换不重置筛选。此处不改变首页模块顺序；自动收起导航与焦点行为按下方已确认的 C5 执行。

### 窄窗口导航定稿 C5（2026-10-19）

未手动选择时，窗口 **<1024px** 使用现有 **60px** 图标轨道；**≥1024px** 使用 **248px** 展开侧栏。当前应用外壳会话中一旦手动展开或收起，窗口变化与跨页导航都保持该选择；刷新或重新挂载外壳后重新按窗口确定默认状态，不写入持久化偏好。

隐藏的侧栏、轨道、Agent 历史展开区与轨道浮层在退场开始时设置 `inert` 与 `aria-hidden`。自动切换导致当前焦点进入隐藏导航时，迁移到可见的侧栏切换按钮；工作区保持沉浸模式。轨道历史与搜索浮层打开后聚焦搜索框；归档箱打开后聚焦其中首个可操作按钮。Escape、外部点击或再次点击入口关闭浮层后，焦点返回对应触发按钮。复用既有导航图标、顺序、尺寸与动效。

## Components

| 组件 | 规格要点 |
| --- | --- |
| 面板 / 卡片 | 白底 + 1px hairline + `0 1px 2px rgba(24,34,57,.05)`，16px 圆角；任务卡 8px 圆角、20px 内边距 |
| 课程卡 | 顶部课程封面（色底 + 课程图标）+ 名称 + 待完成数 + 深色「查看任务」主按钮；12px 圆角 |
| 卡片组 fluid hover（课程卡 / 课程内任务卡共用） | 整组只有一块 `.card-grid-highlight`（`#f1f1ef`、12px 圆角、0.15s 淡入淡出），由 `lib/fluidHover.ts` 的 rAF 临界阻尼弹簧驱动滑向指针最近的卡片；卡片自身不做 hover 位移 / 描边变色，且透明底让高亮透出（卡片 `position: relative; z-index: 1`）。表内两种卡片组不得各自造一套 hover |
| 课程封面回退（e2 几何构成） | 保留 `course-0/1/2` 色底与课程图标，叠加右上角小圆（`currentColor` 10% 透明，直径 = 卡宽的 34%，上 / 右各出血 18% 卡高 / 8% 卡宽）+ 左下胶囊色带（`currentColor` 22% 透明，52% 宽 / 7px 高 / 99px 圆角）。全部取 `currentColor`、不依赖外部美术；插画产出后可换 `img` 封面，`onError` 回退不动 |
| 状态徽章 | 亮底深字（100 底 / 800 字），6px 圆角，`4px 8px` 内边距；状态**必须同时有文字**，不靠颜色单独表意 |
| 标签 / 筛选 | 备用 hue 的 soft 底 + 800 字，或中性 `chip` + ink；6px 圆角 |
| 任务搜索框（任务工具栏） | 无边框轻量字段 = 前置 14px 放大镜（`minimalistic-magnifier`，与对话搜索同图）+ 输入 + 有内容时右侧 16px 清除 ×（`close`，圆底，与设置页 chip 的 × 同规格）。静止只有 1px 下划线，悬停下划线加深（`#e0e0de` → `#c9cac8`）、图标转 `ink-soft`；聚焦转 **accent 2px 下划线 + `--hover-bg` 浅底 + accent 放大镜**（6px 圆角，0.15s S 曲线过渡）。无边框字段**不加方框焦点环**——焦点反馈落在字段自己的下划线上；表格类白底输入框仍走 accent 描边 + 3px 柔光晕（`.st-input:focus`） |
| 按钮 | 主 / 次共用同一个盒：高 **32px**（吸附控件高度阶梯）、文字 13px、8px 圆角、横向 16px 内边距、图标与文字间距 6px；主按钮近黑 `#1f2328` 底 + 白字，次级白底 + `line-strong` 描边 + `ink-soft` 字。强调蓝不做大面积按钮底。局部场景（个人资料卡操作区、看板「编辑」、设置页 `st-xs` 小号）各自另有尺寸覆盖，不回到 40px 以上的大按钮 |
| 首页悬浮输入（composer / `.ask`） | 一枚气泡两形态：收态是 34px 高 / 12px 圆角的入口胶囊「有问题，问我 ⌘J」（白底、面板档阴影、宽度按内容实测），开态是 456px × 54px / 27px 半径的输入气泡（重档阴影，间距与几何见 [home-design.md](https://github.com/wubq511/XunJie_Design/blob/a9bb1dd016489d3e60e0b45933e440296c1194d8/docs/home-design.md) 同名一节）；右缘贴 IP 左侧、尾巴指向 IP，宽 / 高 / bottom 过渡长开（开 350ms / 收 240ms，S 曲线）；点击 / ⌘J 唤起 |
| 独立对话页输入（prompt-input） | 浅色／深色使用现有 `raised` 底，12px 圆角、1px 边界与 `panel-shadow`；聚焦使用 `accent` 边界 + `focus-glow`，不改变尺寸。正文与输入共用 780px 宽度上限；附件与发送均保持 36px 正圆；模型菜单仍为中档阴影 |
| 浮层 | 提示 = `inverse` 底白字 8px 圆角（轻档）；菜单 = 白卡 12px 圆角（中档，开为 S 曲线 scale+fade、锚在按钮处，关为 0.14s 加速收束后卸载，菜单项按 30/65/100ms 错峰浮入）；托盘 / 悬浮对话面板 / rail 面板 = 白卡（托盘用 `inverse` 底）16px 圆角（重档） |
| 对话框（个人资料卡） | 20px 圆角、宽 `min(1120px, 100vw − 40px)`、高度随内容并受视口约束；760px 以下单栏。宽度上限取决于「宽高比向视口靠拢」：高度已被 `100dvh − 40px` 顶住，上限偏小（原 860px）时卡片在宽窗口里会读成竖长条 |
| toast | `inverse` 底 + 白字、8px 圆角、顶部居中 |
| 构成图（mosaic） | `inverse` 深底板 16px 圆角、4px 间隙、四格现状四色（有意例外）；格内大数字 34px/600 |
| 成就徽章 | OpenMoji 彩色图案 + 奶白圆底；未解锁用 CSS 降饱和 + 独立文字；等级数字是界面元素 |
| 图标 | Solar Linear 单色为主（24×24 画布、1.5px 线宽、圆润端点与转角、`currentColor`），当前导航用 Bold；内容类型可小面积语义色；附件统一折角文件轮廓。`IconText` 未指定尺寸时按相邻字号 1.15em 缩放并限制在 14–18px，独立取用默认 16px |
| 火焰（连续学习） | OpenMoji 资产贴纸原色，**无光晕**：`.db-flame` 的 `drop-shadow` 已删（落实「不使用额外闪烁或发光效果」） |

### 学生端容器与控件定稿（2026-10-19）

独立 Agent 输入区采用上述轻面板与聚焦规范，全局 `shadow-tray` 及工作区浮层不变。12px 圆角和 36px 按钮为本轮实测并确认保留的尺寸，替代此前文档中的 20px／34px 记录。

学生设置的「思考强度」为普通字段组，取消单独的面板边框、阴影和内边距；与模型卡相距 16px，标签与分段控件间距 8px。供应商卡及模型选项的边界、选中态保留。分段选项高 32px；输入框高 36px，直接配对的行内保存按钮高 36px；其他操作按钮沿用原有尺寸。

个人模型配置的操作组间距 8px，可换行。状态在组下方固定位置显示，最小高度 18px、上距 8px、12px／1.5 行高：普通状态用 `muted`，失败用 `danger-deep` 并保留当前配置和错误原因。只有现有保存接口确认后才显示「已保存」；重新读取、保存等待或失败不显示旧成功提示，管理员停用提示仍可见。状态文字可自然换行，不引入自动保存或重试。

这些规则仅作用于独立 Agent 与学生设置。教师端复用的模型组件默认保持原样；工作区、Portal 表单和共享 token 不由本轮全局覆盖。

## Do's and Don'ts

**Do**

- 文本与背景的对比度按实际字号和字重判断：普通文字至少 4.5:1，大文字至少 3:1；大文字指至少 24px 常规字重或约 18.67px 粗体。14px 或 600 字重本身不能补偿对比不足。依据：[W3C Contrast Minimum](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)。
- 状态用「亮底深字」并**同时**给文字标签，颜色只做辅助。
- 嵌套圆角按「内层 = 外层 − 4px」取值，豁免四类（0 / 百分比 / ≥999px / ≥32px）跳过吸附。
- 分层优先「hairline 描边 + 1px 微阴影」；浮层取三级递进中的一档，阴影色统一 `rgba(28,36,48,α)`。
- 时长只用 150/240/350/500，缓动用 S 或 B；新的长动画（>900ms）与 0s 技巧先进豁免白名单再实现。
- 字号只走 9 级阶梯、字重只用 400/500/600；正文与控件用系统栈，衬线只在 h1–h3。
- 图表同色相时，用形状与位置区分「数据」与「可操作元素」。

**Don't**

- 不要把 `accent` 浅色主题下约 4.02:1 的白字组合用于普通大小文本；需要小字时使用经核对的深字浅底或 `primary` 近黑底。
- 不要给 badge / tag / chip / pill / status 族加回 `999px`——它只留在豁免四类。
- 不要把 50% 正圆头像 / 圆点当胶囊删掉，也不要把 `.ask` 开态 27px（= 半高）当「抖动值」吸附到 20px。
- 不要把「现在 / 今天」重新染成暖色：`#ff8a3d` 系列已废，此刻固定 `data-now`。
- 不要为「多色可辨」把构成图改成数据蓝：mosaic 与火焰是记录在案的有意例外（若日后改主意：mosaic 换 Apple 蓝四档，或火焰并入某档语义色）。
- 不要把 `.db-card` / `.ws-dock` / `.mascot` 拉进 l2 面板族或 o2 浮层族——它们是平层、仪器材质与 IP 领地。
- 不要引入橙 / 紫作为强调色，也不要把备用标签 hue 当强调色用（紫相「一眼 AI」）。
- 不要把 A / B / C 三组（对话页 IP 出场、空状态档位、IP 点缀色）当已定 token：它们**明确移出设计系统范围**，属页面打磨阶段决策，届时落点是 [docs/agent-page-design.md](https://github.com/wubq511/XunJie_Design/blob/a9bb1dd016489d3e60e0b45933e440296c1194d8/docs/agent-page-design.md) 与页面对照。
- 不要为了让「数据蓝 = 强调蓝」而让可操作元素只靠颜色标明（同色相是已知代价，靠形状 / 位置补偿）。
- 不要在正文层引入 webfont，或把霞鹜文楷铺到正文与看板大数字上。

## Usage Rights

- **霞鹜文楷（LXGW WenKai）**：SIL Open Font License 1.1（Copyright 2021-2023 LXGW，含 The Klee Project Authors 部分）；完整条款见 [apps/student/public/fonts/OFL.txt](../apps/student/public/fonts/OFL.txt)。自托管分发，正文层不使用。
- **Solar 图标**：作者 480 Design（`https://github.com/480-Design/Solar-Icon-Set`），SVG 取自已确认评审稿的 Iconify Solar 集合本地快照；许可 **CC BY 4.0**。`file-presentation-linear.svg` 是衍生图形（保留 Solar 文件轮廓 + 自绘演示框），继续按 CC BY 4.0 标注；其余图形路径未修改。
- **OpenMoji**（成就徽章、火焰资产）：作者 HfG Schwäbisch Gmünd 与 OpenMoji contributors，来源 Iconify OpenMoji 集合本地快照；许可 **CC BY-SA 4.0**。原 SVG 路径保留；修改图形时记录改动并沿用 CC BY-SA 4.0。未解锁态由 CSS 降饱和显示，徽章外框、等级数字与文字是独立界面元素。
- **项目专属图形**：`learning-space` / `assistant-mark` / `virtual-board` / `digital-waveform` / `load-board` / `insert-prompt` / `unpin` / `analogy` 为本项目自绘，归属学习空间项目，未另行指定公共开源许可。
- **既有品牌资源**：`brand-deepseek-native.svg` / `brand-mimo-native.svg` 沿用仓库原有资产记录，本轮未重新核验；不以通用图标库许可覆盖品牌图形或商标。
- 所有资产随应用本地分发、不在运行时访问外部 CDN；逐项来源与许可见 [apps/student/src/icons/ATTRIBUTION.md](../apps/student/src/icons/ATTRIBUTION.md)，摘要见 [apps/student/src/icons/provenance.json](../apps/student/src/icons/provenance.json)，正式分发时随第三方资源说明保留。

## Source Analysis

本文件所有取值来自以下权威来源，未引入来源之外的值：

| 来源 | 提供内容 |
| --- | --- |
| [docs/prototypes/design-system/README.md](https://github.com/wubq511/XunJie_Design/blob/a9bb1dd016489d3e60e0b45933e440296c1194d8/docs/prototypes/design-system/README.md) | **唯一权威值源**：①–⑩ 十个因素的定稿记录与决策理由（配色 / 字体 / 字号字重 / 圆角形状 / 分层 / 间距密度 / 动效 / 图标 / 图表 / IP 与插画） |
| [docs/prototypes/design-system/](https://github.com/wubq511/XunJie_Design/tree/a9bb1dd016489d3e60e0b45933e440296c1194d8/docs/prototypes/design-system/) 下 `color.html`①、`font.html`②、`type.html`③、`shape.html`④、`layer.html`⑤、`density.html`⑥、`motion.html`⑦、`charts.html`⑨、`illustration.html`⑩ | 各因素变体 library 原型与吸附 / 注入实现；10 hue 三档色值与实底第二表达、字号 / 圆角 / 时长吸附规则、o2 三档阴影与 l2 规则的实测值均在此 |
| [docs/home-design.md](https://github.com/wubq511/XunJie_Design/blob/a9bb1dd016489d3e60e0b45933e440296c1194d8/docs/home-design.md) | 首页 / 课程任务 / Agent 入口 / 任务工作区的已确认设计：inset 外壳、248px 侧栏、沉浸模式、看板与个人资料卡、图标落点 |
| [docs/agent-page-design.md](https://github.com/wubq511/XunJie_Design/blob/a9bb1dd016489d3e60e0b45933e440296c1194d8/docs/agent-page-design.md) | Agent 对话页的回合、思考、流式与消息内块（页面骨架与输入框仍以 home-design 为准） |
| [CONTEXT.md](https://github.com/wubq511/XunJie_Design/blob/a9bb1dd016489d3e60e0b45933e440296c1194d8/CONTEXT.md) | 领域词汇：循阶、项目任务、学生画像、学科工具包、虚拟开发板、虚拟烧录等，文案与类型命名的对齐依据 |
| [apps/student/src/styles/tokens.css](../apps/student/src/styles/tokens.css) | 现役语义 token（`--accent`、状态语义四组、`--panel-shadow`、`--panel-radius`、`--line`、`--shell-bg`、`course-0/1/2`、文字阶）——2026-10-11 已按本文档换值（12 处）；原 `prototype-styles.css` 的中性覆盖层已于 2026-10-10 并入 `app.css`，文件随之删除 |
| [apps/student/src/styles/app.css](../apps/student/src/styles/app.css) | 组件现状值（吸附对象）：35 种阴影、24 种圆角、27 个字号、38 种间距、26 档时长——本文件的阶梯即对它们的收敛结果 |
| [apps/student/src/icons/README.md](../apps/student/src/icons/README.md) + [apps/student/src/icons/ATTRIBUTION.md](../apps/student/src/icons/ATTRIBUTION.md) | ⑧ 图标体系：取用接口、Solar Linear / Bold / OpenMoji 分工、图文对齐规则与全部许可声明 |
| [apps/student/public/fonts/](../apps/student/public/fonts/) | 霞鹜文楷自托管资产与 `OFL.txt`（[apps/student/src/styles/fonts.css](../apps/student/src/styles/fonts.css) 已备好 `@font-face`） |
| [apps/student/src/lib/theme.ts](../apps/student/src/lib/theme.ts) + [apps/student/index.html](../apps/student/index.html) 内联脚本 | 深色模式机制：偏好三态（`theme.v1`）、系统深浅订阅、首屏防闪与 `data-theme` 落点；深色取值见本文「深色模式」一节 |

**合并结果（2026-10-11）**：`tokens.css` 12 处、`app.css` 599 处、`icons.css` 6 处、`widgets.tsx` 15 处，全部按本文档取值改写完成——h1–h3 的 `font-family` 三行、去胶囊的 badge 族、l2 面板族与 o2 浮层三档、⑨⑩ 的落地注意（时间线 now 描边、热力两代值、`.db-flame` 去光晕、`course-cover-ph` 装饰伪元素）均已落在源码；`prototype-styles.css` 的中性覆盖层已并入 `app.css` 并删除。逐值复核方式与残留定性见 [docs/prototypes/design-system/README.md](https://github.com/wubq511/XunJie_Design/blob/a9bb1dd016489d3e60e0b45933e440296c1194d8/docs/prototypes/design-system/README.md) 的「2026-10-11 落地记录」，证据快照与复跑工具见 [docs/research/design-system-landing-2026-10-11/](https://github.com/wubq511/XunJie_Design/tree/a9bb1dd016489d3e60e0b45933e440296c1194d8/docs/research/design-system-landing-2026-10-11/)；⑧ 图标按目录 README 继续维护。

### Logo 产品场景补充（2026-10-11）

用户已确认独立 Logo C「叠进」精修稿并授权应用。图形为固定紫色 `#999fe8` 与薄荷绿 `#a5d7c7`，作为品牌资产使用；普通控件仍使用语义色 token。中文字标是已转曲的固定字形，应用中跟随 `--ink`，不套用 UI 正文字体阶梯。侧栏用横向组合、关于页用纵向组合、favicon 用独立图形。比例与导出见 [品牌资产库](https://github.com/wubq511/XunJie_Design/blob/a9bb1dd016489d3e60e0b45933e440296c1194d8/docs/brand-assets/xunjie-logo/README.md)。

### IP 产品场景补充（2026-10-11）

用户明确要求首页 IP 周围不要白圈，并增加自然动作。`.mascot` 与 `.ws-ip` 使用透明背景、无边框和投影；保留 64px / 56px 点击区域。键盘焦点保留 2px accent 轮廓。IP 动作由场景驱动，有限手势结束回待命，连续动作仅轻呼吸、眨眼与叶片微动；减少动效时保留静态状态、禁用移动与循环。完整场景与验证见 [产品接入](https://github.com/wubq511/XunJie_Design/blob/a9bb1dd016489d3e60e0b45933e440296c1194d8/docs/research/brand-ip/product-integration/README.md)。

### 深色模式（2026-10-11）

浅色仍是本系统的默认表达：纯白画布、亮底深字状态、近黑主按钮。深色是**同一套角色集的炭灰对应值**，不新增角色，也不改变字号 / 间距 / 圆角 / 分层 / 动效的任何取值。切换机制、键名与验收记录见 [apps/student/src/lib/theme.ts](../apps/student/src/lib/theme.ts)。

**主题机制**：偏好三态 `light / dark / system`（localStorage 键 `theme.v1`，缺失或非法值一律按跟随系统）；实际主题写到 `<html data-theme>` 并同步 `color-scheme`；`index.html` 的内联脚本在首屏绘制前先落一次，避免刷新闪白，React 启动后接管。显式选择后系统深浅变化不再覆盖；跟随系统时实时跟随，并在页面重新可见 / 从 bfcache 返回时补一次核对。

入口是侧栏底部「外观」按钮，点开为浅色 / 深色 / 跟随系统三选一菜单。**按钮图标取实际生效的深浅**——浅色用太阳 `sun`、深色用月亮 `moon`，跟随系统时同样显示当前生效的那一枚，不固定停在某一种；提示写出偏好与当前值（「外观 · 跟随系统（当前浅色）」）。菜单三项用太阳 / 月亮 / 本机 `laptop` 表达三个偏好，选中项打 ✓。`sun` 是本地图标快照没有太阳图形时按 Solar Linear 同风格补绘的项目自绘图形，登记见 [apps/student/src/icons/ATTRIBUTION.md](../apps/student/src/icons/ATTRIBUTION.md)。

**深色取值**（[apps/student/src/styles/tokens.css](../apps/student/src/styles/tokens.css) 的 `:root[data-theme='dark']` 为唯一来源）：

| 角色 | 深色 | 说明 |
| --- | --- | --- |
| 外壳 / 画布 / 内嵌面 / 浮层 | `#181818` / `#1f1f1f` / `#262626` / `#2b2b2b` | 层级靠「面比底亮 + hairline 描边」，阴影只做补强 |
| 悬停 / 次级填充 / 按下态 | `#303030` / `#343434` / `#454545` | 按下档必须比悬停档重半档，否则按压反馈消失 |
| hairline / 控件描边 | `#3a3a3a` / `#4a4a4a` | 与浅色同角色，不是新档 |
| 文字四级 | `#ededed` / `#c8c8c8` / `#acacac` / `#999999` | 正文 ≥ 12:1、辅助小字 ≥ 4.5:1 |
| 强调蓝 | `#409cff`（深一档 `#6cb2ff`） | 与图表数据蓝同源提亮 |
| 主按钮 | `#ededed` 底 + `#1f1f1f` 字 | 实底整体反转 |
| 深色浮层（提示 / toast / 小气泡） | `#343a41` 底 + `#f5f5f5` 字 | 保持「深色浮在内容之上」的语义 |
| 状态语义 | 进行中 `#16343d/#67e8f9`、完成 `#29371b/#bef264`、等待 `#3b3215/#fde047`、逾期 `#411f2b/#fda4af` | **同色相暗底亮字**：色相绑定不变，只反转明暗 |
| 图表 | 蓝色五档反转为「深→浅」递进；槽底 `#2e2e2e`、描线 `#3a3a3a`、「现在」`#7cc0ff` | ⑨ 的档位关系不变 |
| 课程色 | `#1f2b3d/#8fb3e6`、`#322a1f/#d0b083`、`#2a2735/#b3a3d9` | 仍是三组低饱和配对 |

**不参与主题、两套主题保持原值**：虚拟开发板与七段数码管等仪器材质（`.ws-board` 及其内部控件）、IP 与品牌资产、OpenMoji 徽章、默认渐变头像、马赛克构成图四色（⑨ 记录在案的例外）、火焰贴纸、工作表里的 code 高亮色相以外的马卡龙液滴（`#d9f273` 等 SideDock 动效色）。

**实现约定**：颜色只从 `tokens.css` 取——组件里新增颜色先登记两套值；SVG 的内联颜色走 `style={{ fill: 'var(--…)' }}`（presentation attribute 不解析 `var()`）；浮层挂到 `body` 也受 `data-theme` 覆盖（主题写在 `<html>`）。`lib/settings.ts` 的清缓存保留清单包含 `theme.v1`。

**验收（2026-10-11）**：`npm test` 75 项通过（含 `theme.test.ts` 13 项：默认跟随系统、保存后恢复、系统变化、显式覆盖、非法存储值、存储失败、跨标签同步），`npm run build` 通过。实屏核对浅深两套主题的首页、课程任务、Agent 对话、任务工作区、设置六个标签页与账号菜单 / 个人资料卡 / 外观菜单 / toast；对全部页面做过正文与辅助文字的对比度扫描，深色下无低于 WCAG AA 的正文项（仅剩两处浅色下即低于 AA 的弱装饰墨色，深色反而更清晰）。证据截图与复跑方法见 [docs/research/dark-mode-2026-10-11/](https://github.com/wubq511/XunJie_Design/blob/a9bb1dd016489d3e60e0b45933e440296c1194d8/docs/research/dark-mode-2026-10-11/README.md)。
