import type { ActivityDay, DashboardData, LearningMetrics, ProjectTask } from './types'

/**
 * 演示数据集：三门课程、八个任务。
 *
 * 与 docs/prototypes/home 评审原型使用同一份数据，便于对照；
 * 时间字段为完整含时区的 ISO 字符串，显示文本一律由 lib/tasks.ts 派生。
 */
export const demoTasks: ProjectTask[] = [
  {
    id: 'counter',
    name: '可交互数字计数器',
    course: '数字逻辑与部件设计',
    icon: '▦',
    status: '进行中',
    goal: '让按键、计数逻辑与数码管一起工作。',
    last: '已完成复位逻辑，接下来验证按键消抖。',
    stepsDone: 3,
    stepsTotal: 5,
    deadlineAt: '2026-09-30T23:59:00+08:00',
    lastStudiedAt: '2026-09-25T14:32:00+08:00',
  },
  {
    id: 'library',
    name: '校园图书检索系统',
    course: '程序设计基础',
    icon: '⌘',
    status: '进行中',
    goal: '从数据组织到检索，构建一个可用的小系统。',
    last: '已完成书目数据结构。',
    stepsDone: 2,
    stepsTotal: 6,
    deadlineAt: '2026-10-08T23:59:00+08:00',
    lastStudiedAt: '2026-09-24T20:15:00+08:00',
  },
  {
    id: 'traffic-light',
    name: '交通灯状态机',
    course: '数字逻辑与部件设计',
    icon: '◉',
    status: '未开始',
    goal: '设计一个有行人请求的路口控制器。',
    last: '阅读任务要求即可开始。',
    stepsDone: 0,
    stepsTotal: 4,
    deadlineAt: '2026-10-12T23:59:00+08:00',
    lastStudiedAt: null,
  },
  {
    id: 'ledger',
    name: '个人记账工具',
    course: '程序设计基础',
    icon: '⌘',
    status: '已完成',
    goal: '记录、分类并汇总日常收支。',
    last: '已完成任务中的全部阶段。',
    stepsDone: 4,
    stepsTotal: 4,
    deadlineAt: '2026-09-26T23:59:00+08:00',
    lastStudiedAt: '2026-09-25T15:00:00+08:00',
  },
  {
    id: 'sorting-viz',
    name: '排序算法可视化',
    course: '数据结构',
    icon: '≋',
    status: '进行中',
    goal: '让算法的每一步变化都看得见。',
    last: '已实现数组生成与展示。',
    stepsDone: 1,
    stepsTotal: 5,
    deadlineAt: '2026-10-06T23:59:00+08:00',
    lastStudiedAt: '2026-09-24T10:00:00+08:00',
  },
  {
    id: 'maze',
    name: '迷宫路径探索',
    course: '数据结构',
    icon: '⌁',
    status: '未开始',
    goal: '用搜索算法找到出口，并解释搜索过程。',
    last: '阅读任务要求即可开始。',
    stepsDone: 0,
    stepsTotal: 5,
    deadlineAt: null,
    lastStudiedAt: null,
  },
  {
    id: 'decoder',
    name: '组合逻辑译码器',
    course: '数字逻辑与部件设计',
    icon: '▦',
    status: '已完成',
    goal: '把二进制输入映射为七段数码管输出。',
    last: '已完成所有输入组合的验证。',
    stepsDone: 4,
    stepsTotal: 4,
    deadlineAt: '2026-09-24T23:59:00+08:00',
    lastStudiedAt: '2026-09-22T16:00:00+08:00',
  },
  {
    id: 'wordfreq',
    name: '文本词频分析',
    course: '程序设计基础',
    icon: '⌘',
    status: '已完成',
    goal: '从一段文字中提取最常出现的词。',
    last: '已完成任务中的全部阶段。',
    stepsDone: 4,
    stepsTotal: 4,
    deadlineAt: '2026-09-22T23:59:00+08:00',
    lastStudiedAt: '2026-09-20T16:00:00+08:00',
  },
]

/** 学习看板指标（本周口径）。均为模拟数据。 */
export const demoMetrics: LearningMetrics = {
  periodLabel: '本周',
  hours: 6.4,
  days: 4,
  completedThisPeriod: 2,
  weeklyActivity: [25, 48, 0, 65, 92, 0, 0],
}

/* ---- 学习看板模拟数据 ---- */

/** 确定性伪随机，保证每次刷新看到同一份演示数据。 */
function mulberry32(a: number) {
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const isoDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

function genActivity(): ActivityDay[] {
  const rnd = mulberry32(20260929)
  const start = new Date(2026, 5, 1)
  const end = new Date()
  const days: ActivityDay[] = []
  for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const r = rnd()
    const hours = r < 0.42 ? 0 : +((rnd() * 3.2 + 0.3).toFixed(1))
    days.push({ date: isoDate(d), hours })
  }
  return days
}

function genPunch(): number[][] {
  const rnd = mulberry32(20260601)
  return Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, (_, h) => {
      const peak = h >= 19 && h <= 23 ? 0.75 : h >= 14 && h <= 17 ? 0.4 : 0.08
      return rnd() < peak ? +(rnd() * 1.5).toFixed(1) : 0
    }),
  )
}

export const demoDashboard: DashboardData = {
  semesterStart: '2026-06-01',
  activity: genActivity(),
  compositionTotalHours: 38.5,
  composition: [
    { label: '任务实操', percent: 42, tone: 'a' },
    { label: '问答互动', percent: 24, tone: 'b' },
    { label: '概念学习', percent: 20, tone: 'c' },
    { label: '测验挑战', percent: 14, tone: 'd' },
  ],
  badges: [
    { icon: '初', label: '初次点亮', unlocked: true, tone: 0 },
    { icon: '7', label: '连续7天', unlocked: true, tone: 1 },
    { icon: '问', label: '提问达人', unlocked: true, tone: 2 },
    { icon: 'Bug', label: '调试猎手', unlocked: true, tone: 3 },
    { icon: '21', label: '连续21天', unlocked: false, tone: 1 },
    { icon: '综', label: '综合项目', unlocked: false, tone: 2 },
    { icon: '师', label: '助人解惑', unlocked: false, tone: 0 },
    { icon: '夜', label: '深夜学者', unlocked: false, tone: 3 },
    { icon: '全', label: '全勤月', unlocked: false, tone: 1 },
  ],
  radar: [
    { axis: '编程基础', value: 0.85 },
    { axis: '数据结构', value: 0.62 },
    { axis: '算法', value: 0.45 },
    { axis: '硬件原理', value: 0.7 },
    { axis: '调试能力', value: 0.55 },
    { axis: '项目协作', value: 0.38 },
  ],
  milestones: [
    { name: '认识虚拟开发板', note: '9月12日 · 已完成', state: 'done' },
    { name: '点亮第一颗 LED', note: '9月15日 · 已完成', state: 'done' },
    { name: '按键中断实验', note: '9月22日 · 已完成', state: 'done' },
    { name: '串口通信实验', note: '进行中 · 当前里程碑', state: 'now' },
    { name: 'PWM 调光项目', note: '预计 10月上旬', state: 'next' },
    { name: '综合项目：智能台灯', note: '预计 10月下旬', state: 'next' },
  ],
  mastery: [
    { label: 'GPIO 编程', percent: 86 },
    { label: '串口通信', percent: 72 },
    { label: '中断处理', percent: 58 },
    { label: '定时器', percent: 44 },
    { label: 'ADC 采样', percent: 31 },
  ],
  xp: { level: 7, total: 1240, today: 120, nextLevelRemaining: 260, nextLevelProgress: 83 },
  punch: genPunch(),
}
