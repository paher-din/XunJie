import { lazy, Suspense, type ReactNode, type RefObject, type UIEventHandler } from 'react'
import { Icon } from '../icons'
import { SuggestionStack } from '../foundation'
import { useToastFeedback } from '../feedback'
import { MessageRail, type MessageRailProps } from './MessageRail'
import { TurnAriaStatus } from './TurnAriaStatus'
import type { TurnPhase } from './types'

const EmptyStateMascot = lazy(() => import('../foundation/Mascot').then(module => ({ default: module.MascotSvg })))

export interface AgentEmptyStateProps { title: string; description?: string }
export function AgentEmptyState({ title, description }: AgentEmptyStateProps) {
  return <div className="chat-empty">
    <div style={{ width: 52, margin: 'auto', aspectRatio: '5 / 6' }}>
      <Suspense fallback={null}><EmptyStateMascot /></Suspense>
    </div>
    <h1>{title}</h1>{description !== undefined && <p style={{ color: 'var(--muted)' }}>{description}</p>}
  </div>
}

export interface ChatErrorProps { message?: string | null }
export function ChatError({ message }: ChatErrorProps) { useToastFeedback(message); return null }

export interface ChatViewportProps {
  scrollerRef: RefObject<HTMLDivElement | null>
  onJump: MessageRailProps['onJump']; onScroll: UIEventHandler<HTMLDivElement>
  phase?: TurnPhase; padSuggestions: boolean; queued: boolean; busy: boolean; children: ReactNode
}
/** 消息视口及 ARIA；消息事实、跳转和吸附策略由调用方控制。 */
export function ChatViewport({ scrollerRef, onJump, onScroll, phase, padSuggestions, queued, busy, children }: ChatViewportProps) {
  return <div className="chat-viewport">
    <MessageRail scrollerRef={scrollerRef} onJump={onJump} />
    <TurnAriaStatus phase={phase} />
    <div className="chat-wrap" ref={scrollerRef} onScroll={onScroll}>
      <div className={'chat-inner' + (padSuggestions ? ' pad-suggest' : '') + (queued ? ' pad-queue' : '')}
        role="log" aria-live="off" aria-busy={busy} aria-label="对话记录">{children}</div>
    </div>
  </div>
}

export interface BackToBottomProps { onClick: () => void }
export function BackToBottom({ onClick }: BackToBottomProps) {
  return <button className="back-bottom" onClick={onClick} aria-label="回到底部"><Icon name="arrow-down" size={15} /></button>
}

export interface QueueNoticeProps { message: string; action?: { label: string; onSend: () => void } }
export function QueueNotice({ message, action }: QueueNoticeProps) {
  return <div className="queue-tip">{message}{action && <button onClick={action.onSend}>{action.label}</button>}</div>
}

export interface ChatComposerDockProps {
  anchorRef: RefObject<HTMLDivElement | null>; atBottom: boolean
  suggestions: { items: string[]; show: boolean; onPick: (text: string) => void }
  followUps: { items: string[]; show: boolean; onPick: (text: string) => void; label: string }
  queue?: QueueNoticeProps; onBackToBottom: () => void
  /** 仅输入控件的位置；菜单、附件、状态属于正式 PromptInput。 */
  input: ReactNode; disclaimer: string; usageLabel?: string
}
export function ChatComposerDock({ anchorRef, atBottom, suggestions, followUps, queue, onBackToBottom,
  input, disclaimer, usageLabel }: ChatComposerDockProps) {
  return <div className="chat-composer"><div className="chat-composer-inner">
    <div className={'composer-anchor' + (atBottom ? '' : ' away')} ref={anchorRef}>
      <SuggestionStack {...suggestions} /><SuggestionStack {...followUps} />
      {queue && <QueueNotice {...queue} />}<BackToBottom onClick={onBackToBottom} />{input}
    </div>
    <div className="chat-disclaimer">{disclaimer}{usageLabel !== undefined && <span>{usageLabel}</span>}</div>
  </div></div>
}
