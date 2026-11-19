import { useEffect, useRef, type ReactNode, type Ref } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Icon, IconText } from '../icons'
import { ProgressBar } from '../foundation/ProgressBar'
import { StatusChip, type TaskDisplayStatus } from '../foundation/StatusChip'
import { TaskProgress, type TaskProgressProps } from './TaskPresentation'
import { AgentMessage, type AgentMessageProps } from '../chat/AgentMessage'
import { GenCard } from '../chat/GenCard'
import type { GenHostFactory } from '../chat/genHost'
import type { ChatMessageData, GenCardData } from '../chat/types'
import './workspace-task-intro.css'

/** The host owns navigation and the contents portalled into the two toolbar slots. */
export interface WorkspaceHeaderProps {
  progress: TaskProgressProps
  onBack: () => void
  tabsRef?: Ref<HTMLDivElement>
  runRef?: Ref<HTMLDivElement>
}

export function WorkspaceHeader({ progress, onBack, tabsRef, runRef }: WorkspaceHeaderProps) {
  return <header className="ws-head">
    <div className="ws-navbtns"><button className="ws-navbtn" aria-label="返回" onClick={onBack}>
      <Icon name="arrow-left" size={18} />
    </button></div>
    <div className="ws-head-tabs" ref={tabsRef} />
    <TaskProgress {...progress} />
    <div className="ws-head-run" ref={runRef} />
  </header>
}

export interface WorkspaceTaskIntroProps {
  status?: TaskDisplayStatus
  name: string
  course: string
  deadline?: string
  goal?: string
  percent?: number
  done?: boolean
  currentProgress?: string
  actionLabel: string
  flying?: boolean
  onStart: () => void
  children?: ReactNode
  dialog?: {
    onClose: () => void
    busy?: boolean
    startDisabled?: boolean
    dock?: { target: HTMLElement; onComplete: () => void }
  }
}

/** Only presentation and the start action live here; the host owns first-entry state. */
export function WorkspaceTaskIntro({ status, name, course, deadline, goal, percent, done = false, currentProgress,
  actionLabel, flying, onStart, children, dialog }: WorkspaceTaskIntroProps) {
  const badge = status && <StatusChip status={status} />
  const meta = <p className="ws-intro-meta">{course}{deadline && ` · ${deadline}`}</p>
  const overview = <>
    {goal && <p className="ws-intro-goal">{goal}</p>}
    {percent != null && <div className="ws-intro-progress"><span>当前进度 {percent}%</span><ProgressBar percent={percent} done={done} /></div>}
    {currentProgress && <p className="ws-intro-last">{currentProgress}</p>}
    {children}
  </>
  const actions = <div className="ws-intro-actions"><button type="button" className="primary"
    disabled={dialog?.busy || dialog?.startDisabled} onClick={onStart}>
    <IconText name="arrow-right" position="end">{actionLabel}</IconText>
  </button></div>
  if (dialog) return <TaskIntroDialog name={name} badge={badge} meta={meta} actions={actions} {...dialog}>{overview}</TaskIntroDialog>
  return <div className="ws-intro-veil"><div className={flying ? 'ws-intro-card fly' : 'ws-intro-card'}>
    {badge}<h1>{name}</h1>{meta}{overview}{actions}
  </div></div>
}

function TaskIntroDialog({ name, badge, meta, actions, children, onClose, busy, dock }: NonNullable<WorkspaceTaskIntroProps['dialog']> & {
  name: string; badge: ReactNode; meta: ReactNode; actions: ReactNode; children: ReactNode
}) {
  const card = useRef<HTMLDivElement>(null)
  const overlay = useRef<HTMLDivElement>(null)
  const title = useRef<HTMLHeadingElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const target = dock?.target
  const complete = dock?.onComplete
  useEffect(() => {
    if (!target || !complete) return
    const panel = card.current
    if (!panel?.animate || !target.isConnected || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      complete()
      return
    }
    const from = panel.getBoundingClientRect()
    const to = target.getBoundingClientRect()
    const x = to.left + to.width / 2 - (from.left + from.width / 2)
    const y = to.top + to.height / 2 - (from.top + from.height / 2)
    const scale = Math.min(to.width / from.width, to.height / from.height)
    const duration = 440
    const animation = panel.animate([
      { transform: 'none', opacity: 1 },
      { opacity: 0.9, offset: 0.62 },
      { transform: `translate(${x}px, ${y}px) scale(${scale})`, opacity: 0 },
    ], { duration, easing: 'cubic-bezier(0.3, 1, 0.35, 1)', fill: 'forwards' })
    const fade = overlay.current?.animate([{ opacity: 1 }, { opacity: 0 }], { duration, fill: 'forwards' })
    let active = true
    void animation.finished.then(() => { if (active) complete() }, () => {})
    return () => { active = false; animation.cancel(); fade?.cancel() }
  }, [target, complete])
  const locked = busy || !!dock
  return <Dialog.Root open onOpenChange={open => { if (!open && !locked) onClose() }}>
    <Dialog.Portal>
      <Dialog.Overlay ref={overlay} className="ws-intro-veil ws-task-dialog-veil" />
      <Dialog.Content ref={card} className="ws-intro-card ws-task-dialog" aria-describedby={undefined} aria-busy={locked || undefined}
        onOpenAutoFocus={event => {
          previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
          event.preventDefault()
          title.current?.focus({ preventScroll: true })
        }} onCloseAutoFocus={event => {
          event.preventDefault()
          const focus = target ?? previousFocus.current
          if (focus?.isConnected) focus.focus({ preventScroll: true })
        }} onEscapeKeyDown={event => { if (locked) event.preventDefault() }}
        onPointerDownOutside={event => { if (locked) event.preventDefault() }}>
        <Dialog.Close asChild><button type="button" className="ws-task-dialog-close" aria-label="关闭任务预览" disabled={locked}>
          <Icon name="close" size={16} />
        </button></Dialog.Close>
        <div className="ws-task-dialog-body">
          <header className="ws-task-dialog-heading">
            {badge}<Dialog.Title asChild><h2 ref={title} tabIndex={-1}>{name}</h2></Dialog.Title>{meta}
          </header>
          {children}
        </div>
        {actions}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}

export interface WorkspaceToolkitPendingProps { title: string; description: string }
export function WorkspaceToolkitPending({ title, description }: WorkspaceToolkitPendingProps) {
  return <div className="ws-center"><div className="ws-toolkit-pending"><p>{title}</p><p>{description}</p></div></div>
}

export interface WorkspaceMissingTaskProps { onBack: () => void }
export function WorkspaceMissingTask({ onBack }: WorkspaceMissingTaskProps) {
  return <div className="ws-missing"><p>没有找到这个任务。</p><button className="outline" onClick={onBack}>返回首页</button></div>
}

export interface WorkspacePinnedCardsColumnProps { docked: boolean; children: ReactNode }
export function WorkspacePinnedCardsColumn({ docked, children }: WorkspacePinnedCardsColumnProps) {
  return <div className="ws-pinned-col" style={{ right: docked ? 336 : 14 }}>{children}</div>
}

export interface WorkspacePinnedLearningCardProps { title: string; onUnpin: () => void; children: ReactNode }
export function WorkspacePinnedLearningCard({ title, onUnpin, children }: WorkspacePinnedLearningCardProps) {
  return <div className="ws-pinned-card"><div className="ws-cardhead"><span>{title}</span>
    <button onClick={onUnpin}><IconText name="undo-left-round" position="end">放回收纳</IconText></button>
  </div>{children}</div>
}

export interface WorkspacePinnedGeneratedCardProps {
  card: GenCardData
  createHost: GenHostFactory
  onUnpin: (snapshot: unknown) => void
  onStateSync: (snapshot: unknown) => void
}
export function WorkspacePinnedGeneratedCard({ card, createHost, onUnpin, onStateSync }: WorkspacePinnedGeneratedCardProps) {
  return <div className="ws-pinned-card"><GenCard card={card} createHost={createHost} collectLabel="放回收纳"
    onCollect={onUnpin} onStateSync={onStateSync} /></div>
}

export interface WorkspaceDockedChatProps { onUndock: () => void; children: ReactNode }
export function WorkspaceDockedChat({ onUndock, children }: WorkspaceDockedChatProps) {
  return <aside className="ws-rail"><div className="ws-rail-head"><span>已固定的引导对话</span>
    <button className="textbtn" onClick={onUndock}><IconText name="unpin" position="end">取消固定</IconText></button>
  </div>{children}</aside>
}

export interface WorkspaceFloatingChatProps { onDock: () => void; onClose: () => void; children: ReactNode }
export function WorkspaceFloatingChat({ onDock, onClose, children }: WorkspaceFloatingChatProps) {
  return <div className="ws-chatpop"><div className="ws-chatpop-head">
    <IconText name="assistant-mark">学习助手 · 绑定当前任务</IconText>
    <span><button onClick={onDock}><IconText name="pin" position="end">固定到右侧</IconText></button>
      <button onClick={onClose}><IconText name="close" position="end">收起</IconText></button></span>
  </div>{children}</div>
}

export interface WorkspaceChatInputProps {
  draft: string
  busy: boolean
  onDraft: (value: string) => void
  onSend: (text: string) => void
  onStop: () => void
}
export function WorkspaceChatInput({ draft, busy, onDraft, onSend, onStop }: WorkspaceChatInputProps) {
  return <form className="ws-chatinput" onSubmit={event => { event.preventDefault(); onSend(draft) }}>
    <input aria-label="就这个任务提问" placeholder="就这个任务提问…" autoComplete="off" value={draft}
      onChange={event => onDraft(event.target.value)} />
    {busy ? <button type="button" className="send stop" aria-label="停止生成" onClick={onStop}>
      <Icon name="stop" size={18} />
    </button> : <button type="submit" className="send" aria-label="发送消息"><Icon name="arrow-up" size={20} /></button>}
  </form>
}

export interface WorkspaceChatPaneViewProps extends WorkspaceChatInputProps {
  messages: ChatMessageData[]
  live: ChatMessageData | null
  queued: string | null
  queueText: string
  taskName: string
  onResume: () => void
  onRetry: () => void
  onOpenGenTab: (cardId: string, card?: GenCardData) => void
  onCollectGen: (messageIndex: number, snapshot: unknown) => void
  onSyncGen: (cardId: string, snapshot: unknown) => void
  onConceptCollect: () => void
  renderGeneratedCard?: AgentMessageProps['renderGeneratedCard']
  quizRecordLabel?: AgentMessageProps['quizRecordLabel']
  failureCopy?: AgentMessageProps['failureCopy']
}

/** The host supplies messages, generated-card runtime and all actions; DOM and scroll behavior match the old pane. */
export function WorkspaceChatPaneView({ messages, live, busy, queued, queueText, draft, onDraft, onSend, onStop,
  onResume, onRetry, taskName, onOpenGenTab, onCollectGen, onSyncGen, onConceptCollect,
  renderGeneratedCard, quizRecordLabel, failureCopy }: WorkspaceChatPaneViewProps) {
  const bodyRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, live?.text])

  const lastAgentIdx = messages.map(message => message.role).lastIndexOf('agent')
  const canRetry = messages.slice(0, lastAgentIdx).some(message => message.role === 'user')
  const presentation = { renderGeneratedCard, quizRecordLabel, failureCopy }

  return <div className="ws-chatpane">
    <div className="ws-chatbind">绑定任务：{taskName} · 与「Agent 对话」分开的会话</div>
    <div className="ws-chatbody" ref={bodyRef}>
      {messages.map((message, index) => message.role === 'user' ? <div key={index} className="chat-message user">
        <div className="bubble">{message.text}</div>
      </div> : <AgentMessage key={index} message={message} {...presentation}
        onResume={index === lastAgentIdx ? onResume : undefined}
        onRetry={index === lastAgentIdx && canRetry ? onRetry : undefined}
        onConceptCollect={message.concept ? onConceptCollect : undefined}
        genCardSlots={message.genCard ? {
          taskName,
          onCollect: snapshot => onCollectGen(index, snapshot),
          onOpen: message.genCard.collected ? () => onOpenGenTab(message.genCard!.cardId, message.genCard) : undefined,
          onOpenInWorkspace: () => onOpenGenTab(message.genCard!.cardId, message.genCard),
          onStateSync: snapshot => onSyncGen(message.genCard!.cardId, snapshot),
        } : undefined} />)}
      {live && <AgentMessage message={live} {...presentation} />}
    </div>
    {queued && <div className="queue-tip">{queueText}</div>}
    <WorkspaceChatInput draft={draft} busy={busy} onDraft={onDraft} onSend={onSend} onStop={onStop} />
  </div>
}

/** Reuse the existing formal toast; the host controls when it is mounted. */
export { Toast as WorkspaceToast } from '../foundation/ShellParts'
