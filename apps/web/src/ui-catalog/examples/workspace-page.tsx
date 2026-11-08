import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  WorkspaceChatInput, WorkspaceChatPaneView, WorkspaceDockedChat, WorkspaceFloatingChat, WorkspaceHeader,
  WorkspaceMissingTask, WorkspacePinnedCardsColumn, WorkspacePinnedGeneratedCard, WorkspacePinnedLearningCard,
  WorkspaceTaskIntro, WorkspaceToast, WorkspaceToolkitPending,
} from '@xunjie/ui/workspace'
import { GenCard, type ChatMessageData, type GenCardData, type GenHostFactory } from '@xunjie/ui/chat'
import type { CatalogEntry } from '../types'

const workspacePageViews = '@xunjie/ui/workspace'
const source = 'packages/ui/src/workspace/WorkspacePageViews.tsx'
const toastSource = 'packages/ui/src/foundation/ShellParts.tsx'
const exampleSource = 'apps/web/src/ui-catalog/examples/workspace-page.tsx'

function Surface({ children }: { children: ReactNode }) {
  return <div className="ws" style={{ width: '100%' }}><div className="ws-body">{children}</div></div>
}
const progress = { percent: 60, done: false, status: '进行中', title: '示例任务进度 60%', ariaLabel: '任务进度 60%' }
function HeaderDemo({ done = false }: { done?: boolean }) {
  const [tabs, setTabs] = useState<HTMLDivElement | null>(null)
  const [run, setRun] = useState<HTMLDivElement | null>(null)
  const [message, setMessage] = useState('')
  return <div className="ws" style={{ width: '100%' }}><WorkspaceHeader progress={done ? { ...progress, percent: 100, done: true, status: '已完成', title: '示例任务进度 100%', ariaLabel: '任务进度 100%' } : progress}
    tabsRef={setTabs} runRef={setRun} onBack={() => setMessage('已触发示例返回')} />
    {tabs && createPortal(<span>示例工具标签</span>, tabs)}{run && createPortal(<span>示例运行状态</span>, run)}
    <div className="ws-body"><output>{message}</output></div></div>
}
function HeaderInProgress() { return <HeaderDemo /> }
function HeaderDone() { return <HeaderDemo done /> }
function IntroDemo({ done = false }: { done?: boolean }) {
  const [open, setOpen] = useState(true)
  const [flying, setFlying] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  return <Surface><div className="ws-center" style={{ padding: 24 }}><button type="button" className="outline" onClick={() => setOpen(true)}>重新打开示例任务</button></div>
    {open && <WorkspaceTaskIntro status={done ? '已完成' : '进行中'} name="示例项目" course="示例课程" deadline="无截止时间"
      goal="完成一个用于展示的项目。" percent={done ? 100 : 60} done={done} currentProgress="这是合成示例进度。"
      actionLabel="进入任务" flying={flying} onStart={() => { setFlying(true); timer.current = setTimeout(() => { setOpen(false); setFlying(false) }, 500) }} />}</Surface>
}
function IntroInProgress() { return <IntroDemo /> }
function IntroDone() { return <IntroDemo done /> }
function PendingDemo() { return <Surface><WorkspaceToolkitPending title="示例课程工具包正在接入。" description="此预览只展示提示，不读取课程配置。" /></Surface> }
function MissingDemo() { const [message, setMessage] = useState(''); return <div><WorkspaceMissingTask onBack={() => setMessage('已触发示例返回')} /><output>{message}</output></div> }
function LearningCardDemo({ docked = false }: { docked?: boolean }) {
  const [visible, setVisible] = useState(true)
  return <Surface><div className="ws-center" style={{ padding: 24 }}><button type="button" className="outline" onClick={() => setVisible(true)}>显示示例卡片</button></div>
    {visible && <WorkspacePinnedCardsColumn docked={docked}><WorkspacePinnedLearningCard title="示例教学卡" onUnpin={() => setVisible(false)}>
      <p>卡片内容由调用方提供；这是本地示例。</p></WorkspacePinnedLearningCard></WorkspacePinnedCardsColumn>}</Surface>
}
function ColumnDefault() { return <LearningCardDemo /> }
function ColumnDocked() { return <LearningCardDemo docked /> }
function LearningCard() { return <LearningCardDemo /> }

/** 仅在目录中模拟宿主协议；不访问网络、课程运行时或用户存储。 */
const sampleHost: GenHostFactory = ({ callbacks }) => {
  let element: HTMLDivElement | null = null
  let count = 0
  const mount = (container: HTMLElement, _source: string, snapshot?: unknown) => {
    count = typeof snapshot === 'object' && snapshot !== null && 'count' in snapshot && typeof snapshot.count === 'number' ? snapshot.count : 0
    element = document.createElement('div')
    element.style.padding = '16px'
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'outline'
    const label = document.createElement('p')
    const update = () => { label.textContent = `本地示例计数：${count}` }
    button.textContent = '示例 +1'
    button.onclick = () => { count += 1; update(); callbacks.onState({ count }) }
    update()
    element.append(label, button)
    container.appendChild(element)
    callbacks.onReady()
  }
  return { mount, unmount: () => { element?.remove(); element = null }, snapshot: async () => ({ count }),
    reload: (_source, snapshot) => { count = typeof snapshot === 'object' && snapshot !== null && 'count' in snapshot && typeof snapshot.count === 'number' ? snapshot.count : 0; callbacks.onReady() },
    loadVersion: (_source, snapshot) => { count = typeof snapshot === 'object' && snapshot !== null && 'count' in snapshot && typeof snapshot.count === 'number' ? snapshot.count : 0; callbacks.onReady() } }
}
const sampleCard: GenCardData = { cardId: 'sample-card', title: '示例互动卡', taskId: 'sample', claimSim: false, srcdoc: '', version: 1 }
function GeneratedCardDemo() {
  const [visible, setVisible] = useState(true)
  const [notice, setNotice] = useState('')
  return <Surface><div className="ws-center" style={{ padding: 24 }}><button type="button" className="outline" onClick={() => setVisible(true)}>显示示例生成卡</button><output>{notice}</output></div>
    {visible && <WorkspacePinnedCardsColumn docked={false}><WorkspacePinnedGeneratedCard card={sampleCard} createHost={sampleHost}
      onUnpin={() => { setVisible(false); setNotice('已触发示例收纳') }} onStateSync={() => setNotice('示例状态已变化')} /></WorkspacePinnedCardsColumn>}</Surface>
}

function ChatDemo({ initial = 'floating', initialBusy = false, initialQueued = false }: {
  initial?: 'floating' | 'docked' | 'pane'
  initialBusy?: boolean
  initialQueued?: boolean
}) {
  const [mode, setMode] = useState<'floating' | 'docked' | 'closed'>(initial === 'docked' ? 'docked' : 'floating')
  const [draft, setDraft] = useState('')
  const [messages, setMessages] = useState<ChatMessageData[]>([{ role: 'agent', text: '这是绑定示例任务的本地对话。' }])
  const [busy, setBusy] = useState(initialBusy)
  const [queued, setQueued] = useState<string | null>(initialQueued ? '示例问题' : null)
  const [notice, setNotice] = useState('')
  const stopGeneration = () => {
    setBusy(false)
    if (queued) {
      setMessages(current => [...current, { role: 'user', text: queued }, { role: 'agent', text: '这是本地示例回复。' }])
      setQueued(null)
    }
  }
  const pane = <WorkspaceChatPaneView messages={messages} live={busy ? { role: 'agent', text: '示例生成中', phase: 'streaming' } : null}
    busy={busy} queued={queued} queueText="示例消息已排队" draft={draft} onDraft={setDraft}
    onSend={text => {
      if (!text.trim()) return
      if (busy) setQueued(text)
      else setMessages(current => [...current, { role: 'user', text }, { role: 'agent', text: '这是本地示例回复。' }])
      setDraft('')
    }}
    onStop={stopGeneration} onResume={() => setBusy(true)} onRetry={() => setNotice('已触发示例重试')} taskName="示例项目"
    onOpenGenTab={() => setNotice('已触发示例打开')} onCollectGen={() => setNotice('已触发示例收纳')}
    onSyncGen={() => setNotice('示例卡片状态已变化')} onConceptCollect={() => setNotice('已触发示例收纳')}
    renderGeneratedCard={(card, slots) => <GenCard card={card} createHost={sampleHost} {...slots} />} />
  return <Surface><div className="ws-center" style={{ padding: 24 }}><div><button type="button" className="outline" onClick={() => setMode('floating')}>打开浮动对话</button>{' '}
    <button type="button" className="outline" onClick={() => setMode('docked')}>固定对话</button>{' '}
    <button type="button" className="outline" onClick={() => busy ? stopGeneration() : setBusy(true)}>{busy ? '结束示例生成' : '模拟生成'}</button></div><output>{notice}</output></div>
    {mode === 'floating' && <WorkspaceFloatingChat onDock={() => setMode('docked')} onClose={() => setMode('closed')}>{pane}</WorkspaceFloatingChat>}
    {mode === 'docked' && <WorkspaceDockedChat onUndock={() => setMode('closed')}>{pane}</WorkspaceDockedChat>}</Surface>
}
function FloatingDemo() { return <ChatDemo /> }
function DockedDemo() { return <ChatDemo initial="docked" /> }
function PaneDemo() { return <ChatDemo initial="pane" /> }
function PaneStreaming() { return <ChatDemo initial="pane" initialBusy /> }
function PaneQueued() { return <ChatDemo initial="pane" initialBusy initialQueued /> }
function InputDemo({ initialBusy = false }: { initialBusy?: boolean }) {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(initialBusy)
  const [message, setMessage] = useState('')
  return <div style={{ width: 'min(100%, 420px)' }}><WorkspaceChatInput draft={draft} busy={busy} onDraft={setDraft}
    onSend={text => { setMessage(`示例发送：${text}`); setDraft('') }} onStop={() => setBusy(false)} />
    <button type="button" className="outline" onClick={() => setBusy(value => !value)}>{busy ? '结束示例生成' : '模拟生成'}</button><output>{message}</output></div>
}
function InputReady() { return <InputDemo /> }
function InputBusy() { return <InputDemo initialBusy /> }
function ToastInfo() { return <WorkspaceToast>已完成示例操作</WorkspaceToast> }
function ToastError() { return <WorkspaceToast role="alert">示例操作未完成，请重试。</WorkspaceToast> }

export const workspacePageEntries: CatalogEntry[] = [
  { id: 'workspace-header', name: 'WorkspaceHeader', description: '工作区返回、工具标签槽、进度和运行槽。', importPath: workspacePageViews, source, exampleSource, props: ['progress, onBack, tabsRef?, runRef?'], dependencies: ['工具和运行内容由宿主通过 Portal 插入'], states: [{ id: 'progress', name: '进行中', component: HeaderInProgress }, { id: 'done', name: '已完成', component: HeaderDone }] },
  { id: 'workspace-task-intro', name: 'WorkspaceTaskIntro', description: '首次进入时的任务介绍卡。', importPath: workspacePageViews, source, exampleSource, props: ['status, name, course, deadline, goal, percent, done, currentProgress', 'actionLabel, flying, onStart'], dependencies: ['显示时机由宿主控制'], states: [{ id: 'progress', name: '进行中', component: IntroInProgress }, { id: 'done', name: '已完成', component: IntroDone }] },
  { id: 'workspace-toolkit-pending', name: 'WorkspaceToolkitPending', description: '工具尚未接入时的说明。', importPath: workspacePageViews, source, exampleSource, props: ['title, description'], dependencies: ['说明由宿主提供'], states: [{ id: 'pending', name: '待接入', component: PendingDemo }] },
  { id: 'workspace-missing-task', name: 'WorkspaceMissingTask', description: '任务不存在时的返回入口。', importPath: workspacePageViews, source, exampleSource, props: ['onBack'], dependencies: ['跳转由宿主控制'], states: [{ id: 'missing', name: '未找到', component: MissingDemo }] },
  { id: 'workspace-pinned-cards-column', name: 'WorkspacePinnedCardsColumn', description: '固定卡片容器，随右侧对话调整位置。', importPath: workspacePageViews, source, exampleSource, props: ['docked, children'], dependencies: ['放在相对定位的工作区正文中'], states: [{ id: 'floating', name: '未固定对话', component: ColumnDefault }, { id: 'docked', name: '对话已固定', component: ColumnDocked, viewport: 'wide' }] },
  { id: 'workspace-pinned-learning-card', name: 'WorkspacePinnedLearningCard', description: '固定教学卡及放回操作。', importPath: workspacePageViews, source, exampleSource, props: ['title, onUnpin, children'], dependencies: ['卡片内容由宿主提供'], states: [{ id: 'card', name: '教学卡', component: LearningCard }] },
  { id: 'workspace-pinned-generated-card', name: 'WorkspacePinnedGeneratedCard', description: '固定生成卡与收纳动作。', importPath: workspacePageViews, source, exampleSource, props: ['card, createHost, onUnpin, onStateSync'], dependencies: ['预览使用明确标注的本地示例宿主，不联网'], states: [{ id: 'card', name: '本地互动示例', component: GeneratedCardDemo }] },
  { id: 'workspace-docked-chat', name: 'WorkspaceDockedChat', description: '固定在右侧的引导对话外壳。', importPath: workspacePageViews, source, exampleSource, props: ['onUndock, children'], dependencies: ['消息组件及会话由宿主提供'], states: [{ id: 'docked', name: '固定', component: DockedDemo, height: 620 }] },
  { id: 'workspace-floating-chat', name: 'WorkspaceFloatingChat', description: '浮动引导对话外壳。', importPath: workspacePageViews, source, exampleSource, props: ['onDock, onClose, children'], dependencies: ['消息组件及会话由宿主提供'], states: [{ id: 'floating', name: '浮动', component: FloatingDemo, height: 620 }] },
  { id: 'workspace-chat-input', name: 'WorkspaceChatInput', description: '受控输入与停止按钮。', importPath: workspacePageViews, source, exampleSource, props: ['draft, busy, onDraft, onSend, onStop'], dependencies: ['发送和停止由宿主处理'], states: [{ id: 'ready', name: '输入', component: InputReady }, { id: 'busy', name: '生成中', component: InputBusy }] },
  { id: 'workspace-chat-pane-view', name: 'WorkspaceChatPaneView', description: '任务引导对话的消息、队列和输入。', importPath: workspacePageViews, source, exampleSource, props: ['messages, live, busy, queued, queueText, taskName', 'draft, onDraft, onSend, onStop, onResume, onRetry', '生成卡与概念卡回调及消息展示配置'], dependencies: ['示例消息保存在内存；生成卡需要显式注入宿主'], states: [{ id: 'conversation', name: '示例对话', component: PaneDemo, height: 620 }, { id: 'streaming', name: '生成中', component: PaneStreaming, height: 620 }, { id: 'queued', name: '消息排队', component: PaneQueued, height: 620 }] },
  { id: 'workspace-toast', name: 'WorkspaceToast', description: '复用正式基础提示。', importPath: workspacePageViews, source: toastSource, exampleSource, props: ['children, role?: status | alert'], dependencies: ['宿主控制显示时机'], states: [{ id: 'status', name: '普通提示', component: ToastInfo }, { id: 'error', name: '错误提示', component: ToastError }] },
]
