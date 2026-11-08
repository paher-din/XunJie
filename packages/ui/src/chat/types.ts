/** 对话展示事实；宿主负责数据读取、持久化和权限。 */
export type TurnPhase = 'waiting' | 'thinking' | 'streaming' | 'settled' | 'stopped' | 'failed'
export type FailureReason = 'network' | 'model' | 'quota'
export interface WaveRow { name: string; clk?: boolean; segs?: [number, number][] }
export interface WaveSpec { rows: WaveRow[]; highlight?: [number, number]; markers?: number[]; labels?: { x: number; dx?: number; text: string }[] }
export interface ConceptCardData { title: string; points: string[]; note?: string; afterPara?: number; wave?: WaveSpec }
export interface QuizResult { selected: string; correct: boolean; attempts: number }
export interface QuizOption { key: string; text: string }
export interface QuizCardData { topic: string; title: string; stem: string; options: QuizOption[]; answer: string; explain: string; result?: QuizResult }
export interface GenCardData {
  cardId: string; title: string; taskId: string | null; claimSim: boolean; srcdoc: string
  fallbackSrcdoc?: string; snapshot?: unknown; version: number; genFailure?: { code: string }
  collected?: { taskId: string; at: string } | null
}
export interface ChatImage { name: string; dataUrl: string }
export interface ChatMessageData {
  role: 'user' | 'agent'; text: string; images?: ChatImage[]; at?: string; phase?: TurnPhase
  thinking?: { summary: string; seconds: number }; failure?: { reason: FailureReason; code?: string }
  concept?: ConceptCardData; quiz?: QuizCardData; steps?: string[]; genCard?: GenCardData
}
/** 选择器只需要展示字段，不依赖旧任务实体。 */
export interface ChatTaskOption { id: string; course: string; name: string; status: string; deadlineAt: string | null }
