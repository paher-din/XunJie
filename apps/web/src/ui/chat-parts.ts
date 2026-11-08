/** 旧版对话内部 UI 部件入口；保留原 props、局部状态、样式及领域／运行依赖。 */

/** 回合状态与动作：等待计时、思考摘要、停止／失败、复制与重试。 */
export {
  WaitTail as AgentWaitTail,
  ThinkTail as AgentThinkTail,
  ThinkingSettled as AgentThinkingSettled,
  StopLine as AgentStopLine,
  FailureCard as AgentFailureCard,
  ActionBar as AgentActionBar,
} from '../components/chat/AgentMessage'

/** 概念卡槽保留收纳状态与 portal；波形接收原 WaveSpec 数据。 */
export { ConceptBlock as AgentConceptBlock } from '../components/chat/AgentMessage'
export { Waveform as ConceptWaveform } from '../components/chat/ConceptCard'

/** 生成卡：失败展示；Live 部件仍装配 GenSandboxHost 与 iframe 协议。 */
export {
  GenFailCard as GeneratedCardFailure,
  GenLiveCard as GeneratedCardLive,
} from '../components/chat/GenCard'

/** Markdown 部件接收 marked token；保留 memo 比较、流式尾部与复制／滚动状态。 */
export {
  Block as MarkdownBlock,
  CodeBlock as MarkdownCodeBlock,
  ListBlock as MarkdownListBlock,
  TableBlock as MarkdownTableBlock,
  Inline as MarkdownInline,
  Chars as MarkdownChars,
} from '../components/chat/Markdown'

/** 原有生成卡动作槽类型；回调仍由业务调用方提供。 */
export type { GenCardSlots } from '../components/chat/AgentMessage'
