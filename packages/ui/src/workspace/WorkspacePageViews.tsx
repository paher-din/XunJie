import { useEffect, useRef, type ReactNode, type Ref } from 'react'
import { Icon, IconText } from '../icons'
import { ProgressBar } from '../foundation/ProgressBar'
import { StatusChip, type TaskDisplayStatus } from '../foundation/StatusChip'
import { TaskProgress, type TaskProgressProps } from './TaskPresentation'
import { AgentMessage, type AgentMessageProps } from '../chat/AgentMessage'
import { GenCard } from '../chat/GenCard'
import type { GenHostFactory } from '../chat/genHost'
import type { ChatMessageData, GenCardData } from '../chat/types'

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
  status: TaskDisplayStatus
  name: string
  course: string
  deadline: string
  goal: string
  percent: number
  done: boolean
  currentProgress: string
  actionLabel: string
  flying: boolean
  onStart: () => void
}

/** Only presentation and the start action live here; the host owns first-entry state. */
export function WorkspaceTaskIntro({ status, name, course, deadline, goal, percent, done, currentProgress,
  actionLabel, flying, onStart }: WorkspaceTaskIntroProps) {
  return <div className="ws-intro-veil">
    <div className={flying ? 'ws-intro-card fly' : 'ws-intro-card'}>
      <StatusChip status={status} />
      <h1>{name}</h1>
      <p className="ws-intro-meta">{course} · {deadline}</p>
      <p className="ws-intro-goal">{goal}</p>
      <div className="ws-intro-progress"><span>当前进度 {percent}%</span><ProgressBar percent={percent} done={done} /></div>
      <p className="ws-intro-last">{currentProgress}</p>
      <div className="ws-intro-actions"><button className="primary" onClick={onStart}>
        <IconText name="arrow-right" position="end">{actionLabel}</IconText>
      </button></div>
    </div>
  </div>
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
