import { AgentMessage as AgentMessageView, FailureCard as FailureCardView, type AgentMessageProps as ViewProps, type FailureCardProps as FailureProps } from '@xunjie/ui/chat'
import { MascotSvg } from '../Mascot'
import { GenCard } from './GenCard'
import { FAILURE_COPY } from './copy'
export { WaitTail, ThinkTail, ThinkingSettled, ConceptBlock, StopLine, ActionBar } from '@xunjie/ui/chat'
export type { GenCardSlots, WaitTailProps, ThinkTailProps, ThinkingSettledProps, ConceptBlockProps, StopLineProps, ActionBarProps } from '@xunjie/ui/chat'
export type AgentMessageProps = Omit<ViewProps, 'statusIcon' | 'renderGeneratedCard' | 'quizRecordLabel' | 'failureCopy'>
export type FailureCardProps = Omit<FailureProps, 'failureCopy'>
/** 仅注入旧品牌、生成卡运行适配器和旧业务提示；展示在正式包中。 */
export function AgentMessage(props: AgentMessageProps) {
  return <AgentMessageView {...props}
    statusIcon={<MascotSvg className="turn-ip" motion="think" />}
    renderGeneratedCard={(card, slots) => <GenCard card={card} {...slots} />}
    quizRecordLabel={quiz => `已记入学习画像 · ${quiz.topic}：掌握`}
    failureCopy={FAILURE_COPY}
  />
}
export function FailureCard(props: FailureCardProps) { return <FailureCardView {...props} failureCopy={FAILURE_COPY} /> }
