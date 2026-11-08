/** 看板展示数据，所有统计事实由宿主提供。 */
export interface DashboardData {
  /** 本学期开学日，yyyy-mm-dd。 */
  semesterStart: string
  /** 开学至今逐日学习时长（小时）。 */
  activity: ActivityDay[]
  /** 学习投入构成的总时长（小时）。 */
  compositionTotalHours: number
  composition: CompositionSlice[]
  badges: Badge[]
  radar: RadarAxis[]
  milestones: Milestone[]
  mastery: MasteryRow[]
  xp: XpState
  /** 学习时段分布：7 天（周一起）× 24 小时的时长。 */
  punch: number[][]
}

export interface ActivityDay {
  /** yyyy-mm-dd */
  date: string
  hours: number
}

export interface CompositionSlice {
  label: string
  percent: number
  /** 色板槽位，由样式表决定具体颜色。 */
  tone: 'a' | 'b' | 'c' | 'd'
}

export interface Badge {
  icon: string
  label: string
  unlocked: boolean
  tone: number
}

export interface RadarAxis {
  axis: string
  /** 0-1 */
  value: number
}

export interface Milestone {
  name: string
  note: string
  state: 'done' | 'now' | 'next'
}

export interface MasteryRow {
  label: string
  /** 0-100 */
  percent: number
}

export interface XpState {
  level: number
  total: number
  today: number
  nextLevelRemaining: number
  nextLevelProgress: number
}


export interface DashboardTask {
  name: string
  status: string
  lastStudiedAt: string | null
}
