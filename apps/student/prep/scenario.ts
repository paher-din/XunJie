/**
 * I0-A 准备场景：固定的合成 C / TextScope 活动与合成身份。
 *
 * 只存在于开发进程的 fixture 里（`npm run dev:prep`），**不进生产 bundle、不进真实模式**。
 * 固定 bootstrap 引用带 `prep-` 前缀；03 的 Attempt/文件/快照使用进程内随机 UUID。
 * 这些合成对象不与任何正式 Assignment / ActivityVersion / Resource 混称，
 * 也不能被当成正式对象硬编码进客户端。
 *
 * 响应形状照抄主仓库现有契约与 integration 测试样例，来源在 `prep/plugin.ts` 的路由处逐项标注：
 * - 信封与错误码：`apps/teaching/contracts/common/http.ts`
 * - `activityViewSchema` / `assignmentViewSchema` / `projectedMaterialSchema`：
 *   `apps/teaching/contracts/design/results.ts:45-56`
 * - student 视角的材料裁剪规则：`apps/teaching/server/design/projection.ts:38-50`
 * - 活动正文字段：`apps/teaching/contracts/design/draft.ts:10-20` 的 `contentShape`
 * - `runtimeProfileVersion` 字面量：`apps/teaching/tests/evidence/a2/acceptance.a2-integration1.evidence.json`
 */

import { createHash } from 'node:crypto'
import type { ActivityContent, HelpPolicyView, MaterialParagraph, ProjectedMaterial } from '../src/workspace/contracts'

/* ---------- 合成身份 ---------- */

export const SYNTHETIC_ACCOUNT = {
  loginName: 'i0-prep-student',
  password: 'prep-only-not-a-real-credential',
  userId: 'prep-student-01',
  courseId: 'prep-course-c17',
} as const

export const SCENARIO_ID = 'i0-prep-textscope-c'

/* ---------- 固定对象引用 ---------- */

export const REFS = {
  assignmentId: 'prep-assignment-textscope-c-01',
  activityVersionId: 'prep-activity-version-textscope-c-01',
  blueprintId: 'prep-blueprint-textscope-c',
  helpPolicyVersionId: 'help-v1',
  checkRuleVersionId: 'textscope-core-v1',
  runtimeProfileVersionId: 'c17-gcc15.3.0-textscope-v1',
} as const

/* ---------- 材料 ---------- */

export type MaterialKind = 'learning_material' | 'private_answer' | 'validation_asset'
export type MaterialFormat = 'txt' | 'markdown' | 'paste'

/** fixture 内部的材料记录；对外只按 student 视角投影，规则与服务端 projection.ts 一致。 */
export interface FixtureMaterial {
  resourceVersionId: string
  kind: MaterialKind
  format: MaterialFormat
  title: string
  text: string
  visibility: { student: boolean; tutor: boolean }
  /** 固定版本与当前草稿不一致时置 false，投影成 `{ status: 'unavailable' }`。 */
  available: boolean
}

const BRIEF_TEXT = [
  'TextScope 是一个只读文本统计工具：读入若干 UTF-8 文本文件，输出词频统计、指定词查找与 Top-N 结果。',
  '本活动使用 C17，编译与运行都在课程的隔离运行时里完成；不在浏览器或应用宿主里编译 C。',
  '入口文件是 main.c，命令行参数决定操作类型（stats / find / top）。',
  '输入文本文件由课程提供，不要把你的作品写成只能处理某一个固定文件。',
  '输出必须是纯文本，按行给出结果；不要输出调试用的额外内容。',
].join('\n')

const CONVENTION_TEXT = [
  '统计口径：以空白分隔切词，区分大小写，不去标点。',
  '词频按出现次数降序，次数相同按字典序升序。',
  'find 操作在找不到目标词时输出 0，不报错、不返回非零退出码。',
  '所有计数使用无符号类型；单个文件大小上限按课程约束，超出时按失败处理而不是截断。',
].join('\n')

/**
 * 三条材料覆盖投影的三种状态：
 * - 两条 `learning_material` 且 student 可见 → available，返回正文与段落；
 * - 一条 `private_answer` → redacted，不返回任何 ID、标题或正文；
 * - 一条固定版本与当前草稿不一致 → unavailable。
 */
export const MATERIALS: FixtureMaterial[] = [
  {
    resourceVersionId: 'prep-resource-brief-01',
    kind: 'learning_material',
    format: 'markdown',
    title: 'TextScope 任务说明',
    text: BRIEF_TEXT,
    visibility: { student: true, tutor: true },
    available: true,
  },
  {
    resourceVersionId: 'prep-resource-convention-01',
    kind: 'learning_material',
    format: 'txt',
    title: '统计口径与输出约定',
    text: CONVENTION_TEXT,
    visibility: { student: true, tutor: true },
    available: true,
  },
  {
    resourceVersionId: 'prep-resource-private-answer-01',
    kind: 'private_answer',
    format: 'txt',
    title: '参考实现（教师私有）',
    text: '这段正文永远不应该出现在学生响应里。',
    visibility: { student: false, tutor: false },
    available: true,
  },
  {
    resourceVersionId: 'prep-resource-stale-01',
    kind: 'learning_material',
    format: 'txt',
    title: '已过期的补充材料',
    text: '固定版本与当前草稿不一致，学生侧应为 unavailable。',
    visibility: { student: true, tutor: true },
    available: false,
  },
]

/* ---------- 段落与摘要 ---------- */

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export interface FixtureParagraph extends MaterialParagraph {
  paragraphId: string
}

/** 按换行切段，保留原文偏移；空行不成段。偏移用 UTF-16 码元，与 JS 字符串下标一致。 */
export function paragraphsOf(resourceVersionId: string, text: string): FixtureParagraph[] {
  const out: FixtureParagraph[] = []
  let cursor = 0
  let ordinal = 0
  for (const line of text.split('\n')) {
    const start = cursor
    const end = start + line.length
    cursor = end + 1
    if (line.length === 0) continue
    ordinal += 1
    out.push({
      paragraphId: `${resourceVersionId}-p${ordinal}`,
      ordinal,
      start,
      end,
      text: line,
      contentHash: sha256Hex(line),
    })
  }
  return out
}

/* ---------- 活动正文（student 投影后的字段集合） ---------- */

const goalRef = (competencyId: string, competencyVersion: number) => ({ competencyId, competencyVersion })

export const ACTIVITY_CONTENT: ActivityContent = {
  projectTitle: 'TextScope 文本统计工具',
  problem:
    '给一批 UTF-8 文本文件，做一个只读的命令行统计工具：能给出词频统计、查找指定词的出现次数，' +
    '以及出现最多的前 N 个词。输入文件不由你挑选，程序要对任意符合约定的输入都给出一致结果。',
  audience: '高校 CS 一年级，已完成 C 基础语法、函数与数组',
  artifact: '可编译的 C17 源码（入口 main.c、必要头文件、自带测试文本）与一次 Core 运行的结果',
  studentBackground: '写过百行以内的 C 练习程序，用过数组与结构体，没有做过命令行参数解析与文件读取',
  timeConstraints: '建议 2 次课内实验完成；单次运行有时间与内存上限，超限按基础设施失败处理',
  routes: ['array-count', 'sort-count'],
  goals: [
    {
      ...goalRef('prep-comp-c-text-io', 1),
      domain: 'domain' as const,
      title: '用 C 完成文本读入、切词与计数',
      core: true,
    },
    {
      ...goalRef('prep-comp-project-cli', 1),
      domain: 'project' as const,
      title: '把要求拆成入口、参数与输出约定并逐项落地',
      core: true,
    },
    {
      ...goalRef('prep-comp-ai-boundary', 1),
      domain: 'ai_collaboration' as const,
      title: '说明哪些部分由自己写、哪些借助了模型，并能核对模型给出的代码',
      core: false,
    },
  ],
  tasks: [
    { taskId: 'prep-task-read', title: '读入一个文本文件并按空白切词', goalRefs: [goalRef('prep-comp-c-text-io', 1)] },
    { taskId: 'prep-task-stats', title: '实现 stats：输出词频降序、同频字典序', goalRefs: [goalRef('prep-comp-c-text-io', 1)] },
    { taskId: 'prep-task-cli', title: '实现命令行参数分派与输出约定', goalRefs: [goalRef('prep-comp-project-cli', 1)] },
    { taskId: 'prep-task-topn', title: '实现 top：取出现最多的前 N 个词', goalRefs: [goalRef('prep-comp-project-cli', 1)] },
  ],
  observations: [
    {
      observationId: 'prep-obs-empty-input',
      description: '空文件或全是空白时程序正常结束并输出 0 条结果，不崩溃',
      goalRefs: [goalRef('prep-comp-c-text-io', 1)],
      taskIds: ['prep-task-read', 'prep-task-stats'],
    },
    {
      observationId: 'prep-obs-order',
      description: '词频排序在次数相同的情况下按字典序稳定输出',
      goalRefs: [goalRef('prep-comp-c-text-io', 1)],
      taskIds: ['prep-task-stats', 'prep-task-topn'],
    },
    {
      observationId: 'prep-obs-ai-check',
      description: '学生能指出模型给的代码里哪一处不符合本活动的统计口径并改正',
      goalRefs: [goalRef('prep-comp-ai-boundary', 1)],
      taskIds: ['prep-task-cli'],
    },
  ],
  rubricCriteria: [
    {
      criterionId: 'prep-rubric-correctness',
      description: '对课程给的输入文件，stats / find / top 三个操作的结果都符合约定',
      goalRefs: [goalRef('prep-comp-c-text-io', 1)],
      observationIds: ['prep-obs-empty-input', 'prep-obs-order'],
    },
    {
      criterionId: 'prep-rubric-structure',
      description: '入口、参数解析与统计逻辑分得开，改一个操作不需要动另一个',
      goalRefs: [goalRef('prep-comp-project-cli', 1)],
      observationIds: ['prep-obs-order'],
    },
  ],
  milestones: [
    { milestoneId: 'prep-ms-read', title: '能读入并切词', taskIds: ['prep-task-read'] },
    { milestoneId: 'prep-ms-stats', title: 'stats 结果符合约定', taskIds: ['prep-task-stats'] },
    { milestoneId: 'prep-ms-cli', title: '三个操作都能从命令行跑通', taskIds: ['prep-task-cli', 'prep-task-topn'] },
  ],
  helpPolicyVersionId: REFS.helpPolicyVersionId,
}

export const HELP_POLICY: HelpPolicyView = {
  versionId: REFS.helpPolicyVersionId,
  helpAllowed: true,
  wholeSolutionAllowed: false as const,
  limitedCheckHelpAllowed: false as const,
  description: '可以解释口径与定位错误，不直接给整份实现（准备场景固定策略）',
}

/* ---------- student 视角投影（与 projection.ts:38-50 同规则） ---------- */

export function projectMaterials(audience: 'student' | 'tutor' | 'teacher-validator'): ProjectedMaterial[] {
  return MATERIALS.map((m) => {
    if (!m.available) return { status: 'unavailable' as const }
    if (audience !== 'teacher-validator' && (m.kind !== 'learning_material' || !m.visibility[audience])) {
      return { status: 'redacted' as const }
    }
    return {
      status: 'available' as const,
      resourceVersionId: m.resourceVersionId,
      title: m.title,
      text: m.text,
      contentHash: sha256Hex(m.text),
      paragraphs: paragraphsOf(m.resourceVersionId, m.text),
    }
  })
}
