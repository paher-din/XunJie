import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { lexer, type Tokens } from 'marked'
import {
  ActionBar, AgentEmptyState, AgentMessage, AttachmentTile, BackToBottom, Block, Chars,
  ChatComposerDock, ChatError, ChatViewport, CodeBlock, ConceptBlock, ConceptCard, FailureCard,
  GenCard, GenFailCard, GenLiveCard, Inline, ListBlock, Markdown, MessageRail, MessageTaskCard,
  PromptInput, QueueNotice, QuizCard, StepsBlock, StopLine, TableBlock, TaskPicker,
  ThinkingSettled, ThinkTail, TurnAriaStatus, UserMessage, WaitTail, Waveform,
  type ChatMessageData, type ConceptCardData, type GenCardData, type GenHostFactory,
  type PromptAttachment, type TileRect, type TurnPhase,
} from '@xunjie/ui/chat'
import { Button, ContextRing } from '@xunjie/ui/foundation'
import type { CatalogEntry } from '../types'

const importPath = '@xunjie/ui/chat'
const exampleSource = 'apps/web/src/ui-catalog/examples/chat.tsx'
const agentSource = 'packages/ui/src/chat/AgentMessage.tsx'
const sectionSource = 'packages/ui/src/chat/ConversationSections.tsx'
const markdownSource = 'packages/ui/src/chat/Markdown.tsx'
const genSource = 'packages/ui/src/chat/GenCard.tsx'
const image = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="160" height="100" fill="#e6f0ff"/><text x="20" y="57" font-size="20" fill="#155e75">EXAMPLE</text></svg>')
const wave = { rows: [{ name: 'CLK', clk: true }, { name: 'reset', segs: [[140, 0], [260, 1]] as [number, number][] }], highlight: [120, 200] as [number, number], markers: [140], labels: [{ x: 140, text: '示例复位' }] }
const concept: ConceptCardData = { title: '示例：同步复位', points: ['先确认采样边沿。', '比较边沿前后的复位信号。'], note: '示例图中的高亮表示观察区间。', wave }
const quiz = { title: '示例单选', topic: '采样边沿', stem: '同步复位在什么时候被采样？', options: [{ key: 'A', text: '有效时钟边沿' }, { key: 'B', text: '任意时刻' }], answer: 'A', explain: '本示例约定同步复位只在有效边沿被采样。' }
const sampleText = '这是本地示例回复。\n\n**先描述输入**，再用空输入与重复词验证边界。\n\n```c\nint count = 0;\n```\n\n最后比较预期与实际输出。'
const code = lexer('```verilog\nassign sum = a + b;\n```').find(token => token.type === 'code') as Tokens.Code
const list = lexer('1. 确认输入\n2. 写出预期\n3. 比较结果\n').find(token => token.type === 'list') as Tokens.List
const table = lexer('| 输入 | 预期 |\n| --- | --- |\n| 空文本 | 0 |\n| a a | 2 |').find(token => token.type === 'table') as Tokens.Table
const paragraph = lexer('示例中的 **强调**、`代码` 和 ~~删除线~~。').find(token => token.type === 'paragraph') as Tokens.Paragraph

function Frame({ children }: { children: ReactNode }) {
  return <div className="agent-layout" style={{ width: '100%', height: 'auto', minHeight: 0, overflow: 'visible', padding: 24 }}><div style={{ width: '100%', maxWidth: 780, margin: 'auto' }}>{children}</div></div>
}
function ActionsDemo() {
  const [count, setCount] = useState(0)
  return <Frame><Markdown text="示例：复制这条回复，或触发本地重新生成回调。" /><ActionBar text="示例回复" at="2026-11-08T10:30:00+08:00" onRetry={() => setCount(value => value + 1)} /><output>重新生成回调 {count} 次</output></Frame>
}
function UserDemo({ images = false }: { images?: boolean }) {
  const [text, setText] = useState('示例：如何检查文本分析的边界输入？'), [busy, setBusy] = useState(false)
  return <Frame><UserMessage text={text} at="2026-11-08T10:30:00+08:00" onEdit={setText} busy={busy} images={images ? [{ name: '示例图片.svg', dataUrl: image }] : undefined} />
    <Button type="button" variant="outline" onClick={() => setBusy(!busy)}>{busy ? '允许编辑' : '示例：生成中，禁用编辑'}</Button><output>编辑仅更新本页内存。</output></Frame>
}
function AgentDemo({ phase }: { phase: TurnPhase }) {
  const [action, setAction] = useState('')
  const message: ChatMessageData = { role: 'agent', text: phase === 'waiting' || phase === 'thinking' ? '' : sampleText, phase,
    thinking: phase === 'thinking' || phase === 'settled' ? { summary: '示例：先列出边界，再比较测试结果。', seconds: 3 } : undefined,
    failure: phase === 'failed' ? { reason: 'network', code: 'TURN_CONNECTION_LOST' } : undefined,
    concept: phase === 'settled' ? concept : undefined, steps: phase === 'settled' ? ['定义输入', '检查输出'] : undefined }
  return <Frame><AgentMessage message={message} onResume={() => setAction('继续生成')} onRetry={() => setAction('重试')}
    onSwitchModel={() => setAction('切换模型')} onConceptCollect={() => setAction('收纳概念卡')} sourceLabel="本地目录示例" /><output>{action && `示例回调：${action}`}</output></Frame>
}
function AttachmentDemo({ kind = 'file' }: { kind?: 'file' | 'image' | 'uploading' | 'broken' }) {
  const [removed, setRemoved] = useState(false), [leaving, setLeaving] = useState<TileRect>(), [progress, setProgress] = useState<number | undefined>(kind === 'uploading' ? 45 : undefined)
  useEffect(() => { if (!leaving) return; const timer = window.setTimeout(() => setRemoved(true), 280); return () => clearTimeout(timer) }, [leaving])
  const attachment: PromptAttachment = { id: 'sample-attachment', name: kind === 'file' ? '示例代码.c' : '示例图片.svg', size: 512,
    kind: kind === 'file' ? 'code' : 'image', src: kind === 'broken' ? 'data:image/png;base64,broken' : kind === 'file' ? undefined : image, progress }
  return <div className="demo-stack" style={{ padding: 24 }}><div className="prompt-attachments-row">
    {!removed && <AttachmentTile attachment={attachment} leavingRect={leaving} onRemove={setLeaving} />}
  </div><div className="demo-row"><Button type="button" variant="outline" onClick={() => { setRemoved(false); setLeaving(undefined) }}>重置瓦片</Button>
    {kind === 'uploading' && <Button type="button" variant="outline" onClick={() => setProgress(progress === 45 ? 100 : undefined)}>推进示例进度</Button>}</div>
    <output>{removed ? '示例：附件已移除' : '示例附件；不会上传文件。'}</output></div>
}
function BackDemo() {
  const [count, setCount] = useState(0)
  return <div style={{ width: 360, paddingTop: 80 }}><div className="composer-anchor away" style={{ position: 'relative' }}><BackToBottom onClick={() => setCount(value => value + 1)} /><output>回底回调 {count} 次</output></div></div>
}
function InputDemo({ mode = 'ready', embedded = false, value: controlled, onValueChange }: { mode?: 'ready' | 'attachments' | 'disabled' | 'busy' | 'error'; embedded?: boolean; value?: string; onValueChange?: (text: string) => void }) {
  const [draft, setDraft] = useState(''), [modelId, setModel] = useState('sample-one'), [effort, setEffort] = useState('高')
  const [busy, setBusy] = useState(mode === 'busy'), [blocked, setBlocked] = useState(mode === 'disabled'), [error, setError] = useState(mode === 'error')
  const [attachments, setAttachments] = useState<PromptAttachment[]>(mode === 'attachments' ? [
    { id: 'image', name: '示例图片.svg', kind: 'image', src: image, size: 512 }, { id: 'code', name: '示例代码.c', kind: 'code', size: 32 },
  ] : [])
  const [notice, setNotice] = useState(''), nextId = useRef(0)
  const models = [{ id: 'sample-one', name: '示例模型一', note: '纯内存选项', icon: 'model' as const }, { id: 'sample-two', name: '示例模型二', note: '不会发起模型请求', icon: 'model' as const }]
  const text = controlled ?? draft, change = onValueChange ?? setDraft
  const content = <><PromptInput value={text} onChange={change} onSend={() => { setNotice(`示例接纳：${text.trim() || '仅附件'} · ${attachments.length} 个附件`); change(''); setAttachments([]) }}
    canSend={!blocked && !error && (!!text.trim() || attachments.length > 0)} submitting={blocked} busy={busy} onStop={() => { setBusy(false); setNotice('已停止本地示例') }}
    attachments={attachments} onAddFiles={files => setAttachments(previous => [...previous, ...files.map(file => ({ id: `selected-${++nextId.current}`, name: file.name, size: file.size,
      kind: file.type.startsWith('image/') ? 'image' as const : 'document' as const, src: file.type.startsWith('image/') ? image : undefined }))])}
    onRemoveAttachment={id => setAttachments(previous => previous.filter(attachment => attachment.id !== id))} attachmentTitle="添加本地示例附件（不会上传）"
    model={models.find(model => model.id === modelId)!} models={models} onModelChange={setModel} modelDisabled={blocked}
    effort={effort} efforts={['低', '高', '最高']} onEffortChange={(_id, next) => setEffort(next)} effortDisabled={blocked}
    status={error ? { role: 'alert', text: '示例：模型选择未确认' } : blocked ? { role: 'status', text: '示例：输入暂时禁用' } : undefined}
    contextIndicator={<ContextRing tokens={3800} limit={64000} />} />
    <output aria-live="polite">{notice || '全部数据仅保存在本页内存中。'}</output>
    {(blocked || error) && <Button type="button" variant="outline" onClick={() => { setBlocked(false); setError(false) }}>恢复示例输入</Button>}</>
  return embedded ? <div>{content}</div> : <Frame><div style={{ paddingTop: 180 }}>{content}</div></Frame>
}
function DockDemo({ away = false, queued = false }: { away?: boolean; queued?: boolean }) {
  const anchorRef = useRef<HTMLDivElement>(null), [atBottom, setAtBottom] = useState(!away), [draft, setDraft] = useState(''), [pending, setPending] = useState(queued)
  return <Frame><div style={{ paddingTop: 40 }}><Button type="button" variant="outline" onClick={() => setAtBottom(!atBottom)}>{atBottom ? '示例：翻阅历史' : '示例：回到底部'}</Button></div>
    <div style={{ paddingTop: 240 }}><ChatComposerDock anchorRef={anchorRef} atBottom={atBottom}
      suggestions={{ items: ['示例：怎样检查空输入？', '示例：怎样比较输出？'], show: atBottom && !draft, onPick: setDraft }}
      followUps={{ items: [], show: false, onPick: setDraft, label: '延伸探讨' }}
      queue={pending ? { message: '示例排队问题仍保留。', action: { label: '发送排队问题', onSend: () => { setPending(false); setDraft('示例排队问题') } } } : undefined}
      onBackToBottom={() => setAtBottom(true)} input={<InputDemo embedded value={draft} onValueChange={setDraft} />} disclaimer="目录示例 · 不连接模型服务" usageLabel=" · 示例用量 3800 tokens" /></div></Frame>
}
function ErrorDemo({ empty = false }: { empty?: boolean }) {
  const [error, setError] = useState(!empty)
  return <Frame><ChatError message={error ? '示例：会话读取失败，请重试。' : undefined} /><Button type="button" variant="outline" onClick={() => setError(!error)}>切换示例错误</Button></Frame>
}
function RailDemo({ short = false, viewport = false }: { short?: boolean; viewport?: boolean }) {
  const scrollerRef = useRef<HTMLDivElement>(null), [jumped, setJumped] = useState('')
  const onJump = (target: HTMLElement, last: boolean) => {
    const scroller = scrollerRef.current
    if (scroller) scroller.scrollTo({ top: scroller.scrollTop + target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 70, behavior: 'smooth' })
    setJumped(last ? '已跳到最后一条' : '已跳到所选消息')
  }
  const messages = Array.from({ length: short ? 1 : 16 }, (_, index) => index % 2 === 0
    ? <UserMessage key={index} text={`示例问题 ${index / 2 + 1}：怎样检查输入边界？`} />
    : <AgentMessage key={index} message={{ role: 'agent', text: `示例回答 ${Math.ceil(index / 2)}：先写出预期，再观察实际输出。\n\n检查空文本、重复词和末尾换行，分别说明结果。`, phase: 'settled' }} />)
  return <Frame><div style={{ height: 430, display: 'flex', flexDirection: 'column', position: 'relative' }}>
    {viewport ? <ChatViewport scrollerRef={scrollerRef} onJump={onJump} onScroll={() => {}} phase="settled" padSuggestions={false} queued={false} busy={false}>{messages}</ChatViewport>
      : <div className="chat-viewport"><MessageRail scrollerRef={scrollerRef} onJump={onJump} /><div className="chat-wrap" ref={scrollerRef}><div className="chat-inner">{messages}</div></div></div>}
  </div><output>{jumped || (short ? '一条消息，不显示导航刻度。' : '滚动、悬停或聚焦左侧刻度，再点击跳转。')}</output></Frame>
}
function ConceptDemo({ stage = 'ready', block = false }: { stage?: 'ready' | 'drawing' | 'paused'; block?: boolean }) {
  const [pinned, setPinned] = useState(false)
  return <Frame>{block ? <ConceptBlock card={concept} stage={stage} /> : <ConceptCard card={concept} stage={stage} pinned={pinned} onTogglePin={() => setPinned(!pinned)} />}
    <output>{block ? '收纳会在独立预览内钉到右缘，可再次点击取消。' : pinned ? '本地示例已收纳' : '概念卡使用明确的示例波形。'}</output></Frame>
}
function FailureDemo({ reason = 'network', code: failureCode = 'TURN_CONNECTION_LOST' }: { reason?: 'network' | 'model' | 'quota'; code?: string }) {
  const [action, setAction] = useState('')
  return <Frame><FailureCard message={{ role: 'agent', text: '', phase: 'failed', failure: { reason, code: failureCode } }} onRetry={() => setAction('重试')}
    onSwitchModel={() => setAction('换个模型')} /><output>{action && `示例回调：${action}`}</output></Frame>
}
function QuizDemo({ answered = false }: { answered?: boolean }) {
  const [record, setRecord] = useState(answered ? '示例：本页已记录作答' : undefined)
  return <Frame><QuizCard quiz={{ ...quiz, result: answered ? { selected: 'A', correct: true, attempts: 2 } : undefined }}
    onSubmitAnswer={() => setRecord('示例：本页已记录作答')} recordLabel={record} /><output>单选与重答仅更新本地组件状态，不写入学习画像。</output></Frame>
}
function StepsDemo({ running = false }: { running?: boolean }) {
  return <Frame><StepsBlock steps={['确认输入数据', '写出预期输出', '比较边界结果']} running={running} /></Frame>
}
function StopDemo({ empty = false }: { empty?: boolean }) {
  const [action, setAction] = useState('')
  return <Frame>{!empty && <Markdown text="示例：停止前已生成的部分。" />}<StopLine empty={empty} onResume={() => setAction('继续生成')} onRetry={() => setAction('重新生成')} /><output>{action}</output></Frame>
}
function PickerDemo({ empty = false }: { empty?: boolean }) {
  const [open, setOpen] = useState(true), [chosen, setChosen] = useState('')
  const tasks = [{ id: 'text', course: '示例：C 程序设计', name: '示例文本分析', status: '进行中', deadlineAt: '2026-11-30' }, { id: 'done', course: '示例：C 程序设计', name: '示例已完成任务', status: '已完成', deadlineAt: null }, { id: 'alu', course: '示例：数字逻辑', name: '示例加法器', status: '未开始', deadlineAt: null }]
  return <Frame><Button type="button" onClick={() => setOpen(true)}>打开示例任务选择器</Button><output>{chosen}</output>
    {open && <TaskPicker tasks={empty ? [] : tasks} onPick={id => { setChosen(`选择了示例：${id}`); setOpen(false) }} onCancel={() => { setOpen(false); setChosen('示例已取消') }} />}</Frame>
}
function ThinkingDemo() { return <Frame><ThinkingSettled thinking={{ summary: '示例摘要：先比较输入与预期，再选择边界测试。', seconds: 4 }} /></Frame> }
function ThinkDemo({ known = false }: { known?: boolean }) { return <Frame><div className="turn-status"><ThinkTail thinking={known ? { summary: '示例摘要', seconds: 6 } : undefined} /></div></Frame> }
function WaitDemo() { return <Frame><div className="turn-status"><WaitTail /></div><output>本地计时：4 秒显示等待文字，12 秒显示经过秒数。</output></Frame> }
function AriaDemo() {
  const [phase, setPhase] = useState<TurnPhase>('waiting')
  return <Frame><TurnAriaStatus phase={phase} /><div className="demo-row">{(['waiting', 'streaming', 'settled', 'stopped', 'failed'] as const).map(value => <Button type="button" key={value} variant="outline" onClick={() => setPhase(value)}>{value}</Button>)}</div>
    <output>当前相位：{phase}。正式组件只向读屏状态区播报，不另加可见文字。</output></Frame>
}
function QueueDemo({ active = false }: { active?: boolean }) {
  const [sent, setSent] = useState(false)
  return <Frame><div className="composer-anchor" style={{ position: 'relative', paddingTop: 80 }}>
    {!sent && <QueueNotice message={active ? '示例：已排队，等待当前回答完成。' : '示例：上一轮已中断，问题仍保留。'} action={active ? undefined : { label: '发送排队问题', onSend: () => setSent(true) }} />}
    <output>{sent ? '已调用本地发送回调' : '纯内存示例队列'}</output></div></Frame>
}
function TaskDemo({ unknown = false }: { unknown?: boolean }) {
  const [opened, setOpened] = useState(false)
  return <Frame><MessageTaskCard status={unknown ? '已分配' : '进行中'} course="示例课程" title="示例文本分析" metadata={unknown ? ['当前开放', '完成状态未知'] : ['40%', '阶段 2/5', '截止 11 月 30 日']}
    progress={unknown ? undefined : { percent: 40, done: false }} onOpen={() => setOpened(true)} /><output>{opened ? '已触发本地打开回调，不导航' : '示例任务'}</output></Frame>
}
function MarkdownDemo({ streaming = false }: { streaming?: boolean }) {
  const [length, setLength] = useState(streaming ? 8 : sampleText.length)
  useEffect(() => { if (!streaming) return; const timer = window.setInterval(() => setLength(value => { if (value + 2 >= sampleText.length) window.clearInterval(timer); return Math.min(value + 2, sampleText.length) }), 70); return () => window.clearInterval(timer) }, [streaming])
  return <Frame><Markdown text={sampleText.slice(0, length)} live={streaming && length < sampleText.length} /><output>{streaming ? '本地逐字输入，不调用模型。' : '真实 Markdown token 渲染。'}</output></Frame>
}
function MarkdownPart({ part, pending = false }: { part: 'block' | 'code' | 'list' | 'table' | 'inline' | 'chars'; pending?: boolean }) {
  const caret = pending ? <span className="turn-caret" /> : undefined
  return <Frame><div className="turn-body">{part === 'block' ? <Block token={paragraph} caret={caret} tail={pending} />
    : part === 'code' ? <CodeBlock token={code} caret={caret} /> : part === 'list' ? <ListBlock token={list} caret={caret} tail={pending} />
      : part === 'table' ? <TableBlock token={table} caret={caret} /> : part === 'inline' ? <p id="example-inline"><Inline tokens={paragraph.tokens} /></p> : <p><Chars text="示例：逐字淡入的中文内容。" /></p>}</div></Frame>
}

/** 受控目录宿主：只建本地 DOM 和内存快照，不装载 iframe 或执行源文档。 */
function GeneratedDemo({ part = 'card', mode = 'live' }: { part?: 'card' | 'live'; mode?: 'live' | 'loading' | 'dead' | 'error' | 'collected' | 'failed' }) {
  const [collected, setCollected] = useState(mode === 'collected'), [notice, setNotice] = useState('')
  const controls = useRef<{ ready: () => void; dead: () => void; error: () => void } | null>(null)
  const createHost = useMemo<GenHostFactory>(() => options => {
    let box: HTMLDivElement | null = null, value = 0
    const paint = (container: HTMLElement) => {
      box = document.createElement('div'); box.style.cssText = 'padding:20px;background:var(--sunken);color:var(--ink);border-radius:8px'
      const title = document.createElement('p'); title.textContent = '受控示例交互（纯本地 DOM）'
      const button = document.createElement('button'); button.type = 'button'; button.className = 'outline'; button.textContent = `计数 ${value}`
      button.onclick = () => { value++; button.textContent = `计数 ${value}`; options.callbacks.onState({ count: value }) }
      box.append(title, button); container.append(box)
    }
    let container: HTMLElement | null = null
    const ready = () => { if (box) options.callbacks.onReady(110) }
    return {
      mount(target, _source, snapshot) {
        container = target; value = typeof snapshot === 'object' && snapshot && 'count' in snapshot ? Number(snapshot.count) : 0
        paint(target); controls.current = { ready, dead: () => options.callbacks.onDead(), error: () => options.callbacks.onRuntimeError({ message: '示例运行错误' }) }
        if (mode === 'dead') options.callbacks.onDead()
        else if (mode !== 'loading') { ready(); if (mode === 'error') options.callbacks.onRuntimeError({ message: '示例运行错误' }) }
      },
      unmount() { box?.remove(); box = null; container = null; controls.current = null },
      snapshot: async () => ({ count: value }),
      reload() { if (container) { box?.remove(); paint(container); queueMicrotask(ready) } },
      loadVersion() { if (container) { box?.remove(); paint(container) } },
    }
  }, [mode])
  const card: GenCardData = { cardId: 'catalog-example', title: '示例：计数交互', taskId: null, claimSim: false,
    srcdoc: '<p>目录宿主不执行此源文档。</p>', fallbackSrcdoc: '<p>示例备用版本。</p>', version: 1,
    collected: collected ? { taskId: 'sample-task', at: '2026-11-08T10:00:00Z' } : undefined,
    genFailure: mode === 'failed' ? { code: 'EXAMPLE_GENERATION_FAILED' } : undefined }
  const onCollect = (snapshot: unknown) => { setNotice(`示例快照：${JSON.stringify(snapshot)}`); if (part === 'card') setCollected(true) }
  return <Frame>{part === 'live' ? <GenLiveCard card={card} createHost={createHost} collectLabel="收纳示例" onCollect={onCollect} onStateSync={state => setNotice(`内存状态：${JSON.stringify(state)}`)} />
    : <GenCard card={card} createHost={createHost} taskName="示例任务" onCollect={onCollect} onOpen={() => setNotice('已触发示例打开回调')} onRetry={() => setNotice('已触发示例生成重试')} />}
    <div className="demo-row" style={{ marginTop: 12 }}><Button type="button" variant="outline" onClick={() => controls.current?.ready()}>示例就绪</Button>
      <Button type="button" variant="outline" onClick={() => controls.current?.dead()}>示例超时</Button><Button type="button" variant="outline" onClick={() => controls.current?.error()}>示例运行错误</Button>
      {collected && <Button type="button" variant="outline" onClick={() => setCollected(false)}>取消示例收纳</Button>}</div><output>{notice || '目录宿主不请求任何服务。'}</output></Frame>
}
function GenFailureDemo() { const [count, setCount] = useState(0); return <Frame><GenFailCard code="EXAMPLE_GENERATION_FAILED" onRetry={() => setCount(value => value + 1)} /><output>本地重试回调 {count} 次</output></Frame> }

export const chatEntries: CatalogEntry[] = [
  { id: 'action-bar', name: 'ActionBar', description: '复制反馈、时间戳与本地重新生成回调。', importPath, source: agentSource, exampleSource, props: ['text/at/onRetry'], dependencies: ['浏览器剪贴板'], states: [{ id: 'interactive', name: '复制／重新生成', component: ActionsDemo }] },
  { id: 'agent-empty-state', name: 'AgentEmptyState', description: '角色与可选说明，不自行判断首次使用。', importPath, source: sectionSource, exampleSource, props: ['title/description'], dependencies: ['MascotSvg'], states: [
    { id: 'first', name: '首次使用示例', component: () => <AgentEmptyState title="你好，我是循阶教学助手" description="目录示例：解答课程难点，梳理实验思路。" /> },
    { id: 'new', name: '新对话', component: () => <AgentEmptyState title="今天想探讨什么？" /> },
  ] },
  { id: 'agent-message', name: 'AgentMessage', description: '各回合阶段与消息内容的真实组件组合。', importPath, source: agentSource, exampleSource, props: ['message', 'onResume/onRetry/onSwitchModel/onConceptCollect', 'renderGeneratedCard/quizRecordLabel/failureCopy'], dependencies: ['Markdown', 'ConceptCard', 'StepsBlock', '品牌素材'], states: [
    { id: 'waiting', name: '等待', component: () => <AgentDemo phase="waiting" /> }, { id: 'thinking', name: '思考', component: () => <AgentDemo phase="thinking" /> },
    { id: 'streaming', name: '输出中', component: () => <AgentDemo phase="streaming" /> }, { id: 'settled', name: '完成与概念卡', component: () => <AgentDemo phase="settled" />, height: 800 },
    { id: 'stopped', name: '停止／继续', component: () => <AgentDemo phase="stopped" /> }, { id: 'failed', name: '连接中断／重试', component: () => <AgentDemo phase="failed" /> },
  ] },
  { id: 'attachment-tile', name: 'AttachmentTile', description: '示例附件、进度、图片回退与移除退场。', importPath, source: 'packages/ui/src/chat/AttachmentTile.tsx', exampleSource, props: ['attachment/leavingRect/onRemove'], dependencies: ['Icon', '示例内联图片'], states: [
    { id: 'file', name: '代码文件／移除', component: () => <AttachmentDemo /> }, { id: 'image', name: '图片缩略图', component: () => <AttachmentDemo kind="image" /> },
    { id: 'uploading', name: '手动推进示例进度', component: () => <AttachmentDemo kind="uploading" /> }, { id: 'broken', name: '无效图片回退', component: () => <AttachmentDemo kind="broken" /> },
  ] },
  { id: 'back-to-bottom', name: 'BackToBottom', description: '在实际 away 定位上下文内显示回底按钮。', importPath, source: sectionSource, exampleSource, props: ['onClick'], dependencies: ['composer-anchor.away 定位上下文'], states: [{ id: 'interactive', name: '回底回调', component: BackDemo }] },
  { id: 'block', name: 'Block', description: '真实 marked 段落 token 与 memo 块渲染。', importPath, source: markdownSource, exampleSource, props: ['token/caret/tail'], dependencies: ['marked token', 'turn-body 上下文'], states: [
    { id: 'paragraph', name: '段落', component: () => <MarkdownPart part="block" /> }, { id: 'tail', name: '流式尾块', component: () => <MarkdownPart part="block" pending /> },
  ] },
  { id: 'chars', name: 'Chars', description: '正文段落中的逐字淡入。', importPath, source: markdownSource, exampleSource, props: ['text'], dependencies: ['turn-body 段落上下文'], states: [{ id: 'text', name: '中文字形', component: () => <MarkdownPart part="chars" /> }] },
  { id: 'chat-composer-dock', name: 'ChatComposerDock', description: '建议叠层、输入位置、排队提示和回底换挡。', importPath, source: sectionSource, exampleSource, props: ['anchorRef/atBottom', 'suggestions/followUps/queue', 'onBackToBottom/input/disclaimer/usageLabel'], dependencies: ['SuggestionStack', 'PromptInput 示例'], states: [
    { id: 'suggestions', name: '建议填入草稿', component: () => <DockDemo />, height: 700 }, { id: 'away', name: '翻阅历史／回底', component: () => <DockDemo away />, height: 700 },
    { id: 'queued', name: '保留排队问题', component: () => <DockDemo queued />, height: 700 },
  ] },
  { id: 'chat-error', name: 'ChatError', description: '明确错误与无错误状态。', importPath, source: sectionSource, exampleSource, props: ['message'], dependencies: [], states: [
    { id: 'error', name: '错误提示', component: () => <ErrorDemo /> }, { id: 'clear', name: '无错误', component: () => <ErrorDemo empty /> },
  ] },
  { id: 'chat-viewport', name: 'ChatViewport', description: '真实可滚动消息布局、导轨与读屏状态。', importPath, source: sectionSource, exampleSource, props: ['scrollerRef/onScroll/onJump', 'phase/padSuggestions/queued/busy/children'], dependencies: ['MessageRail', 'TurnAriaStatus'], states: [
    { id: 'history', name: '长消息历史／导航', component: () => <RailDemo viewport />, height: 560 }, { id: 'short', name: '短对话', component: () => <RailDemo viewport short />, height: 560 },
  ] },
  { id: 'code-block', name: 'CodeBlock', description: '真实 Verilog fenced code token 与复制操作。', importPath, source: markdownSource, exampleSource, props: ['token/caret'], dependencies: ['marked Tokens.Code', '浏览器剪贴板'], states: [
    { id: 'code', name: '代码与复制', component: () => <MarkdownPart part="code" /> }, { id: 'tail', name: '生成尾部', component: () => <MarkdownPart part="code" pending /> },
  ] },
  { id: 'concept-block', name: 'ConceptBlock', description: '概念内容及预览 iframe 内的钉右缘行为。', importPath, source: agentSource, exampleSource, props: ['card/stage/onCollect'], dependencies: ['ConceptCard', 'document.body portal'], states: [
    { id: 'ready', name: '收纳／取消收纳', component: () => <ConceptDemo block />, height: 700 }, { id: 'drawing', name: '生成中', component: () => <ConceptDemo block stage="drawing" />, height: 650 },
  ] },
  { id: 'concept-card', name: 'ConceptCard', description: '示例概念、波形和阶段对应动作。', importPath, source: 'packages/ui/src/chat/ConceptCard.tsx', exampleSource, props: ['card/stage/pinned/onTogglePin'], dependencies: ['Waveform'], states: [
    { id: 'ready', name: '完成／折叠／收纳', component: () => <ConceptDemo />, height: 650 }, { id: 'drawing', name: '生成中', component: () => <ConceptDemo stage="drawing" />, height: 650 },
    { id: 'paused', name: '暂停内容', component: () => <ConceptDemo stage="paused" />, height: 650 },
  ] },
  { id: 'failure-card', name: 'FailureCard', description: '失败分型、知道了折叠及实际动作回调。', importPath, source: agentSource, exampleSource, props: ['message/failureCopy/onRetry/onSwitchModel'], dependencies: ['包内失败文案'], states: [
    { id: 'connection', name: '连接中断／核对', component: () => <FailureDemo /> }, { id: 'model', name: '模型失败／换模型', component: () => <FailureDemo reason="model" code="EXAMPLE_MODEL_FAILURE" /> },
    { id: 'quota', name: '额度提示／知道了', component: () => <FailureDemo reason="quota" code="EXAMPLE_QUOTA" /> },
  ] },
  { id: 'gen-card', name: 'GenCard', description: '受控示例运行宿主，包含收纳、占位和生成失败。', importPath, source: genSource, exampleSource, props: ['card/createHost/taskName', 'onCollect/onOpen/onRetry/onStateSync'], dependencies: ['GenHostFactory 纯内存示例'], states: [
    { id: 'live', name: '交互／快照／收纳', component: () => <GeneratedDemo /> }, { id: 'collected', name: '已收纳占位', component: () => <GeneratedDemo mode="collected" /> },
    { id: 'failed', name: '生成失败', component: () => <GeneratedDemo mode="failed" /> },
  ] },
  { id: 'gen-fail-card', name: 'GenFailCard', description: '生成失败、折叠与本地重试计数。', importPath, source: genSource, exampleSource, props: ['code/onRetry'], dependencies: [], states: [{ id: 'interactive', name: '失败／知道了／重试', component: GenFailureDemo }] },
  { id: 'gen-live-card', name: 'GenLiveCard', description: '使用受控目录宿主演示装载、就绪、超时、回滚和重试。', importPath, source: genSource, exampleSource, props: ['card/createHost/collectLabel', 'onCollect/onStateSync/onOpenInWorkspace'], dependencies: ['GenHostFactory 纯内存示例，不执行 srcdoc'], states: [
    { id: 'live', name: '就绪／状态更新', component: () => <GeneratedDemo part="live" /> }, { id: 'loading', name: '等待宿主就绪', component: () => <GeneratedDemo part="live" mode="loading" /> },
    { id: 'timeout', name: '超时／重试', component: () => <GeneratedDemo part="live" mode="dead" /> }, { id: 'runtime-error', name: '运行错误／回滚', component: () => <GeneratedDemo part="live" mode="error" /> },
  ] },
  { id: 'inline', name: 'Inline', description: '在真实段落上下文内呈现强调、代码和删除线。', importPath, source: markdownSource, exampleSource, props: ['tokens/tail'], dependencies: ['marked 行内 token'], states: [{ id: 'tokens', name: '行内 token', component: () => <MarkdownPart part="inline" /> }] },
  { id: 'list-block', name: 'ListBlock', description: '真实有序列表 token，保留尾项光标。', importPath, source: markdownSource, exampleSource, props: ['token/caret/tail'], dependencies: ['marked Tokens.List'], states: [
    { id: 'ordered', name: '有序步骤', component: () => <MarkdownPart part="list" /> }, { id: 'tail', name: '尾项输出中', component: () => <MarkdownPart part="list" pending /> },
  ] },
  { id: 'markdown', name: 'Markdown', description: '完整正文及纯本地逐字输入。', importPath, source: markdownSource, exampleSource, props: ['text/live/truncated/insert/insertAfterPara'], dependencies: ['marked', 'remend'], states: [
    { id: 'settled', name: '完成正文', component: () => <MarkdownDemo /> }, { id: 'streaming', name: '本地逐字输入', component: () => <MarkdownDemo streaming /> },
    { id: 'truncated', name: '截断语法修复', component: () => <Frame><Markdown text="示例：尚未闭合的 **强调与 `代码" truncated /></Frame> },
  ] },
  { id: 'message-rail', name: 'MessageRail', description: '使用实际消息 DOM、滚动容器和导航回调。', importPath, source: 'packages/ui/src/chat/MessageRail.tsx', exampleSource, props: ['scrollerRef/onJump'], dependencies: ['chat-message/turn-body/bubble DOM 契约'], states: [
    { id: 'overflow', name: '滚动／预览／跳转', component: () => <RailDemo />, height: 560 }, { id: 'short', name: '无需导轨的短对话', component: () => <RailDemo short />, height: 560 },
  ] },
  { id: 'message-task-card', name: 'MessageTaskCard', description: '对话中的任务事实与打开回调。', importPath, source: 'packages/ui/src/chat/MessageTaskCard.tsx', exampleSource, props: ['status/course/title/metadata/progress/onOpen'], dependencies: ['StatusChip', 'ProgressBar', 'Button'], states: [
    { id: 'progress', name: '明确示例进度', component: () => <TaskDemo /> }, { id: 'unknown', name: '完成状态未知', component: () => <TaskDemo unknown /> },
  ] },
  { id: 'prompt-input', name: 'PromptInput', description: '真实受控输入、附件与模型／强度菜单，选择文件也不会上传。', importPath, source: 'packages/ui/src/chat/PromptInput.tsx', exampleSource, props: ['value/onChange/onSend/canSend/submitting/busy', 'attachments/onAddFiles/onRemoveAttachment', 'model/models/effort/efforts/选择回调/status'], dependencies: ['AttachmentTile', 'ContextRing', 'ResizeObserver'], states: [
    { id: 'ready', name: '输入／菜单／发送', component: () => <InputDemo />, height: 680 }, { id: 'attachments', name: '附件／移除／文件选择', component: () => <InputDemo mode="attachments" />, height: 700 },
    { id: 'disabled', name: '禁用／恢复', component: () => <InputDemo mode="disabled" />, height: 680 }, { id: 'busy', name: '生成中／停止', component: () => <InputDemo mode="busy" />, height: 680 },
    { id: 'error', name: '错误／恢复', component: () => <InputDemo mode="error" />, height: 680 },
  ] },
  { id: 'queue-notice', name: 'QueueNotice', description: '排队中与中断后的显式发送操作。', importPath, source: sectionSource, exampleSource, props: ['message/action'], dependencies: ['composer-anchor 定位上下文'], states: [
    { id: 'active', name: '排队中', component: () => <QueueDemo active /> }, { id: 'interrupted', name: '中断后发送', component: () => <QueueDemo /> },
  ] },
  { id: 'quiz-card', name: 'QuizCard', description: '本地单选判定、解析、重答和明确的示例记录提示。', importPath, source: 'packages/ui/src/chat/QuizCard.tsx', exampleSource, props: ['quiz/onSubmitAnswer/recordLabel'], dependencies: ['QuizCardData 示例'], states: [
    { id: 'unanswered', name: '选择／提交／重答', component: () => <QuizDemo />, height: 600 }, { id: 'answered', name: '已作答快照', component: () => <QuizDemo answered />, height: 600 },
  ] },
  { id: 'steps-block', name: 'StepsBlock', description: '教学步骤与完成后的折叠操作。', importPath, source: 'packages/ui/src/chat/StepsBlock.tsx', exampleSource, props: ['steps/running'], dependencies: ['Icon'], states: [
    { id: 'running', name: '当前步骤进行中', component: () => <StepsDemo running /> }, { id: 'settled', name: '已讲完／折叠', component: () => <StepsDemo /> },
  ] },
  { id: 'stop-line', name: 'StopLine', description: '区分有正文的继续生成与空正文的重新生成。', importPath, source: agentSource, exampleSource, props: ['empty/onResume/onRetry'], dependencies: ['IconText'], states: [
    { id: 'content', name: '保留内容／继续', component: () => <StopDemo /> }, { id: 'empty', name: '空内容／重新生成', component: () => <StopDemo empty /> },
  ] },
  { id: 'table-block', name: 'TableBlock', description: '真实表格 token、复制操作与生成中禁用态。', importPath, source: markdownSource, exampleSource, props: ['token/caret'], dependencies: ['marked Tokens.Table', '浏览器剪贴板'], states: [
    { id: 'table', name: '表格／复制', component: () => <MarkdownPart part="table" /> }, { id: 'pending', name: '生成中', component: () => <MarkdownPart part="table" pending /> },
  ] },
  { id: 'task-picker', name: 'TaskPicker', description: '本地任务选择与空任务列表，不创建真实归属关系。', importPath, source: 'packages/ui/src/chat/TaskPicker.tsx', exampleSource, props: ['tasks/onPick/onCancel'], dependencies: ['最小 ChatTaskOption 展示数据'], states: [
    { id: 'tasks', name: '课程分组／选择／取消', component: () => <PickerDemo />, height: 650 }, { id: 'empty', name: '空任务列表／取消', component: () => <PickerDemo empty />, height: 650 },
  ] },
  { id: 'thinking-settled', name: 'ThinkingSettled', description: '静态思考摘要与展开状态。', importPath, source: agentSource, exampleSource, props: ['thinking.summary/seconds'], dependencies: ['Icon'], states: [{ id: 'expand', name: '展开／收起摘要', component: ThinkingDemo }] },
  { id: 'think-tail', name: 'ThinkTail', description: '本地计时与明确提供的思考秒数。', importPath, source: agentSource, exampleSource, props: ['thinking?'], dependencies: ['本地计时器'], states: [
    { id: 'timer', name: '本地计时', component: () => <ThinkDemo /> }, { id: 'known', name: '提供的秒数', component: () => <ThinkDemo known /> },
  ] },
  { id: 'turn-aria-status', name: 'TurnAriaStatus', description: '通过相位按钮体验真实 polite 状态播报。', importPath, source: 'packages/ui/src/chat/TurnAriaStatus.tsx', exampleSource, props: ['phase'], dependencies: ['屏幕阅读器可读取 status 区'], states: [{ id: 'phases', name: '相位切换与读屏', component: AriaDemo }] },
  { id: 'user-message', name: 'UserMessage', description: '消息复制、原位编辑、取消与忙碌禁用。', importPath, source: 'packages/ui/src/chat/UserMessage.tsx', exampleSource, props: ['text/at/onEdit/busy/images'], dependencies: ['浏览器剪贴板'], states: [
    { id: 'text', name: '编辑／复制／禁用', component: () => <UserDemo /> }, { id: 'images', name: '内联示例图片', component: () => <UserDemo images /> },
  ] },
  { id: 'wait-tail', name: 'WaitTail', description: '真实等待计时，保留 4 秒／12 秒文案节奏。', importPath, source: agentSource, exampleSource, props: ['无 props'], dependencies: ['本地计时器'], states: [{ id: 'timer', name: '等待计时', component: WaitDemo }] },
  { id: 'waveform', name: 'Waveform', description: '带信号、区间、标记与文字的真实 SVG 波形。', importPath, source: 'packages/ui/src/chat/ConceptCard.tsx', exampleSource, props: ['spec.rows/highlight/markers/labels'], dependencies: ['WaveSpec 示例'], states: [
    { id: 'annotated', name: '高亮与标记', component: () => <Frame><div className="concept-body"><Waveform spec={wave} /></div></Frame> },
    { id: 'signals', name: '仅信号行', component: () => <Frame><Waveform spec={{ rows: wave.rows }} /></Frame> },
  ] },
]
