import { QuizCard as QuizCardView, type QuizCardProps as ViewProps } from '@xunjie/ui/chat'
export type QuizCardProps = Omit<ViewProps, 'recordLabel'>
/** 兼容旧宿主的画像文案；正式组件不推断持久化事实。 */
export function QuizCard(props: QuizCardProps) {
  return <QuizCardView {...props} recordLabel={`已记入学习画像 · ${props.quiz.topic}：掌握`} />
}
