import { useId, useRef, useState, type ReactNode } from 'react'
import * as W from '@xunjie/ui/workspace'
import { StatusChip } from '@xunjie/ui/foundation'
import type { CatalogEntry, CatalogState } from '../types'

const importPath = '@xunjie/ui/workspace'
const exampleSource = 'apps/web/src/ui-catalog/examples/workspace.tsx'
const source = (file: string) => `packages/ui/src/workspace/${file}.tsx`
const state = (id: string, name: string, component: CatalogState['component'], height = 620): CatalogState => ({ id, name, component, viewport: 'wide', height })
function entry(name: string, file: string, description: string, props: string[], dependencies: string[], states: CatalogState[]): CatalogEntry {
  return { id: name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase(), name, importPath, source: source(file), exampleSource,
    description, props, dependencies, states }
}
function Stage({ children, event, height = 480 }: { children: ReactNode; event?: string; height?: number }) {
  return <div style={{ width: '100%', padding: 24, minHeight: height, position: 'relative', color: 'var(--ink)' }}>
    <p style={{ color: 'var(--muted)', fontSize: 12 }}>本地受控示例 · 不连接课程、模型或执行服务</p>
    {children}{event !== undefined && <output style={{ display: 'block', marginTop: 20 }} aria-live="polite">{event || '操作结果将在此显示'}</output>}
  </div>
}
function useEvent() { return useState('') }

const files: W.WorkspaceFile[] = [
  { fileId: 'example-main', path: 'main.c', lifecycle: 'active', confirmed: { text: 'int main(void) {\r\n    return 0;\r\n}\n', version: 2, lifecycle: 'active' } },
  { fileId: 'example-notes', path: 'notes.md', lifecycle: 'active', confirmed: null },
  { fileId: 'example-old', path: 'old.c', lifecycle: 'recycled', confirmed: { text: '// 原实例\n', version: 1, lifecycle: 'active' } },
]
const originalText = '\ufeffint main(void) {\r\n    return 0;\r\n}\n'
const snapshots: W.RunSnapshotOption[] = [{ id: 'snapshot-a', label: '示例确认作品 v2', files: [
  { id: 'example-main', path: 'main.c', ascii: true }, { id: 'input', path: 'input.txt', ascii: true }, { id: 'unicode', path: '中文.txt', ascii: false },
] }]

function TaskProgressDemo({ done = false }: { done?: boolean }) {
  const [percent, setPercent] = useState(done ? 100 : 40)
  return <Stage><W.TaskProgress percent={percent} done={percent === 100} status={percent === 100 ? '已完成' : '进行中'} title={`示例任务进度 ${percent}%`} ariaLabel={`任务进度 ${percent}%`} />
    <label style={{ display: 'block', marginTop: 24 }}>示例进度 <input aria-label="示例进度" type="range" min={0} max={100} value={percent} onChange={event => setPercent(Number(event.target.value))} /></label></Stage>
}
function TaskInfoDemo({ demo = false }: { demo?: boolean }) {
  return <Stage><div style={{ maxWidth: 420 }}><W.TaskInfo name="示例：文本统计" status={<StatusChip status="进行中" />}
    demoNotice={demo ? '演示数据 · 不写入学习记录' : undefined} goal="处理空输入与重复词。" percent={40} done={false}
    currentProgress="已完成基本分词" stage="2 / 5" deadline="示例：无截止时间" course="示例程序设计" /></div></Stage>
}
function FileTabsDemo({ empty = false }: { empty?: boolean }) {
  const [opened, setOpened] = useState(empty ? [] : files.slice(0, 2)), [active, setActive] = useState('example-main')
  const [event, setEvent] = useEvent()
  return <Stage event={event}><W.FileTabs files={opened.map(file => ({ id: file.fileId, name: file.path,
    decoration: !file.confirmed ? <span className="cw-tag-new">新建</span> : undefined }))} activeId={active} tabRoles
    onOpen={id => { setActive(id); setEvent(`打开 ${id}`) }} onClose={id => { setOpened(items => items.filter(file => file.fileId !== id)); setEvent(`关闭标签 ${id}，文件仍在示例项目中`) }} />
    <button type="button" onClick={() => setOpened(files.slice(0, 2))}>恢复示例标签</button></Stage>
}
function ConfirmationDemo({ initial = 'ready' }: { initial?: W.ConfirmationPhase }) {
  const [phase, setPhase] = useState(initial), [dirty, setDirty] = useState(2), [event, setEvent] = useEvent()
  return <Stage event={event}><W.ConfirmationCluster phase={phase} hasAttempt={phase !== 'idle'} unconfirmedCount={dirty} workspaceRevision={phase === 'idle' ? null : 2}
    snapshot={dirty === 0 ? { workspaceRevision: 2 } : null} canSave canSnapshot canRetry canCompareVersions
    onOpen={() => { setPhase('ready'); setEvent('本地示例尝试已打开') }} onSave={() => { setDirty(0); setEvent('本地确认回调，未发请求') }}
    onSnapshot={() => setEvent('冻结回调：示例 v2')} onRetry={() => { setPhase('ready'); setEvent('核对原示例请求') }}
    onReload={() => { setPhase('ready'); setEvent('本地重读回调') }} onCompareVersions={() => setEvent('比较示例版本')} />
    <button type="button" onClick={() => setDirty(2)}>恢复未确认状态</button></Stage>
}
function PopoverDemo() {
  const [event, setEvent] = useEvent()
  return <Stage event={event}><W.WorkspacePopover label="版本与恢复" icon="clock-circle" closeOnAction>
    <p>打开后焦点进入操作区；Escape 返回入口。</p><button type="button" className="ws-btn ghost" onClick={() => setEvent('已触发本地重读')}>重读示例</button>
    <button type="button" className="ws-btn ghost" onClick={() => setEvent('已选择本地版本')}>选择版本</button></W.WorkspacePopover>
    <button type="button">后续焦点目标</button></Stage>
}
const runResult: W.CoreResultDisplay = { runId: 'example-run', snapshotId: 'snapshot-a', snapshotHash: 'example-hash', snapshotLabel: '确认作品 v2',
  statusLabel: '示例结果：已完成', parameters: 'stats input.txt', diagnostics: { stdout: 'words: 12\nlines: 3', stderr: '' } }
function RunDemo({ operation = 'stats', busy = false, unavailable = false }: { operation?: W.CoreSelection['operation']; busy?: boolean; unavailable?: boolean }) {
  const [selection, setSelection] = useState<W.CoreSelection>({ snapshotId: 'snapshot-a', entryFileId: 'example-main', fileIds: ['input'], operation, word: 'hello', count: '10' })
  const [result, setResult] = useState<W.CoreResultDisplay | null>(unavailable ? null : runResult), [event, setEvent] = useEvent()
  return <Stage event={event}><W.RunPanel snapshots={snapshots} selection={selection} onSelect={setSelection} result={result} busy={busy} canRun={!busy} notice={unavailable ? '示例：结果暂不可回取' : null} synthetic
    control={{ canStop: busy, canReconcile: unavailable, busy: false, onStop: () => setEvent('停止本地示例运行'), onReconcile: () => setEvent('核对原示例运行') }}
    onRun={() => { setResult({ ...runResult, parameters: `${selection.operation} · ${selection.fileIds.join(', ')}` }); setEvent('仅更新示例结果，未编译或执行代码') }}
    onRead={() => setEvent('本地重读结果')} onReturn={() => setEvent('本地返回编辑')} onOpenHistory={() => setEvent('本地历史入口')} onHelp={target => setEvent(`原运行 ${target.runId} / ${target.snapshotId}`)} /></Stage>
}
const historyResult: W.HistoryRunDisplay = { runId: 'example-run', jobId: 'example-job', snapshotId: 'snapshot-a', snapshotHash: 'example-hash',
  profile: '示例 Core profile', image: '示例本地镜像标识', mode: 'run', statusLabel: '示例结果：完成', parameters: 'stats input.txt', diagnostics: { stdout: 'words: 12', stderr: '' },
  files: { status: 'available', files: [{ id: 'output', name: 'output.txt', status: 'complete', text: 'words: 12', bytes: 9 }, { id: 'partial', name: 'partial.txt', status: 'incomplete' }] }, filesNotice: null }
function HistoryDemo({ kind = 'available' }: { kind?: 'available' | 'redacted' | 'unavailable' | 'empty' }) {
  const [selected, setSelected] = useState(['example-run', 'example-run-b']), [event, setEvent] = useEvent()
  const result = { ...historyResult, files: kind === 'redacted' ? { status: 'redacted' as const } : kind === 'unavailable' ? { status: 'unavailable' as const } : historyResult.files }
  return <Stage event={event}><W.RunHistoryPanel options={kind === 'empty' ? [] : [{ id: 'example-run', label: '示例运行 A' }, { id: 'example-run-b', label: '示例运行 B' }]}
    sides={[0, 1].map(index => ({ runId: selected[index], busy: false, notice: null,
      result: kind === 'empty' || !selected[index] ? null : { ...result, runId: selected[index], snapshotId: index ? 'snapshot-b' : 'snapshot-a' } })) as [W.HistorySideDisplay, W.HistorySideDisplay]}
    busy={false} notice={null} synthetic onSelect={(side, id) => setSelected(items => items.map((value, index) => index === side ? id : value))}
    onRead={() => setEvent('本地读取历史')} onReturn={() => setEvent('返回示例运行')} onDownload={(side, id) => setEvent(`下载回调：${side === 0 ? 'A' : 'B'} / ${id}（不创建文件）`)}
    onHelp={target => setEvent(`明确原结果：${target.runId} / ${target.snapshotId}`)} /></Stage>
}
function DockDemo({ empty = false }: { empty?: boolean }) {
  const [stash, setStash] = useState<W.StashItem[]>(empty ? [] : [{ key: 'plain', title: '旧版教学卡' }, { key: 'generated', title: '生成卡示例', gen: { claimSim: true, version: 2 } }])
  const [event, setEvent] = useEvent()
  return <Stage event={event} height={560}><div className="ws-body" style={{ height: 400 }}><W.SideDock taskInfo={<W.TaskInfo name="示例任务" status={<StatusChip status="进行中" />} goal="比较两种实现。" percent={20} done={false}
    currentProgress="阅读任务" stage="1 / 5" deadline="无" course="示例课程" />} stash={stash} onPin={key => { setStash(items => items.filter(item => item.key !== key)); setEvent(`本地钉住 ${key}`) }}
    onOpen={key => setEvent(`本地打开 ${key}`)} onToast={setEvent} /></div></Stage>
}

function CenterDemo({ variant = 'digital-logic' }: { variant?: W.CenterVariant }) {
  const [layout, setLayout] = useState(() => W.defaultLayout()), [tool, setTool] = useState<W.ToolKey>('board'), [event, setEvent] = useEvent()
  const [tabsSlot, setTabsSlot] = useState<HTMLDivElement | null>(null), [runSlot, setRunSlot] = useState<HTMLDivElement | null>(null)
  return <Stage event={event} height={620}><div className="ws" style={{ height: 490 }}><header className="ws-head"><div className="ws-head-tabs" ref={setTabsSlot} /><div className="ws-head-run" ref={setRunSlot} /></header>
    <div className="ws-body"><W.CenterToolArea layout={layout} onLayoutChange={setLayout} tool={tool} onToolChange={setTool} onToast={setEvent} variant={variant} tabsSlot={tabsSlot} runSlot={runSlot}
      boardBody={variant === 'digital-logic-real' ? <W.HdlBoardPane session={hdlSession} result={hdlResult} inputs={hdlInputs} bindings={hdlBoard.bindings} pending={false} disabled onInteract={() => setEvent('板卡只读样本')} /> : undefined}
      waveBody={variant === 'digital-logic-real' ? <W.HdlTracePane session={hdlSession} result={hdlResult} pending={false} /> : undefined} /></div></div></Stage>
}
function DigitDemo({ tone = 'board' }: { tone?: 'board' | 'card' }) {
  const [number, setNumber] = useState(5)
  return <Stage><div className={tone === 'board' ? 'ws-board' : 'ws-segwrap'}><W.Seg7 n={number} tone={tone} /></div>
    <label>数字 <input aria-label="数码管数字" type="range" min={0} max={9} value={number} onChange={event => setNumber(Number(event.target.value))} /></label></Stage>
}
function DemoBoard() {
  const [count, setCount] = useState(3), [sw, setSw] = useState([true, false, true, false])
  return <Stage><W.BoardPane count={count} sw={sw} loaded="示例 v3" onCount={() => setCount(value => (value + 1) % 16)} onReset={() => setCount(0)} onSw={index => setSw(items => items.map((value, i) => i === index ? !value : value))} /></Stage>
}
function DividerDemo() {
  const [ratio, setRatio] = useState(0.5)
  return <Stage event={`左窗格比例 ${Math.round(ratio * 100)}%`}><div className="ws-split row" style={{ height: 220 }}>
    <div style={{ width: `${ratio * 100}%`, padding: 20, background: 'var(--sunken)' }}>拖动分隔条</div>
    <W.Divider horiz onResize={value => setRatio(Math.max(0.2, Math.min(0.8, value)))} /><div className="ws-split-child grow" style={{ padding: 20 }}>右窗格</div></div></Stage>
}
function ToolTabsDemo() {
  const [pane, setPane] = useState<W.PaneNode>({ kind: 'pane', id: 'example-pane', tabs: ['design', 'board', 'wave', 'gen:card'], active: 'design' }), [event, setEvent] = useEvent()
  return <Stage event={event}><W.ToolTabs pane={pane} tools={W.DIGITAL_LOGIC_TOOLS} genCards={[{ cardId: 'card', title: '示例生成卡' }]} allowDrop
    onActivate={active => setPane(item => ({ ...item, active }))} onDragStart={key => setEvent(`开始拖动 ${key}`)} onDragEnd={() => setEvent('结束拖动')}
    onDropOn={id => setEvent(`放入 ${id}`)} onClose={key => setPane(item => ({ ...item, tabs: item.tabs.filter(tab => tab !== key), active: 'design' }))} /></Stage>
}
function DemoRunCluster({ synced = false }: { synced?: boolean }) {
  const [dirty, setDirty] = useState(!synced), [event, setEvent] = useEvent()
  return <Stage event={event}><W.DigitalLogicRunCluster dirty={dirty} onBuild={() => setEvent('仅触发模拟构建回调')} onLoad={() => { setDirty(false); setEvent('本地演示已装载 v4') }} /></Stage>
}

function EditorDemo({ readOnly = false }: { readOnly?: boolean }) {
  const identity = useId(), editor = useRef<W.CodeEditorHandle>(null)
  const [view, setView] = useState<'editor' | 'compare' | 'hidden'>('editor')
  const [fileId, setFileId] = useState('a'), [texts, setTexts] = useState({ a: originalText, b: '// 第二个文件实例\n' }), [event, setEvent] = useEvent()
  return <Stage event={event} height={600}><div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
    <button onClick={() => setFileId(fileId === 'a' ? 'b' : 'a')}>切换同名文件实例</button><button onClick={() => editor.current?.focus()}>聚焦代码</button>
    <button onClick={() => setEvent(JSON.stringify(editor.current?.captureSelection()))}>读取原文选区</button>
    <button onClick={() => setView(view === 'compare' ? 'editor' : 'compare')}>{view === 'compare' ? '返回编辑' : '切到比较'}</button>
    <button onClick={() => setView(view === 'hidden' ? 'editor' : 'hidden')}>{view === 'hidden' ? '显示编辑器' : '隐藏编辑器'}</button></div>
    <div style={{ height: 360, position: 'relative', display: 'flex', flexDirection: 'column' }}>{view === 'editor' ? <W.CodeEditorHost ref={editor} workspaceKey={`catalog-editor-${identity}`} fileId={fileId} language="c" initialText={texts[fileId as 'a' | 'b']}
      readOnly={readOnly} readOnlyReason={readOnly ? '目录中的只读状态' : null} onTextChange={(id, text) => setTexts(items => ({ ...items, [id]: text }))}
      onCursorChange={position => setEvent(position ? `原文行 ${position.line}，列 ${position.column}` : '无光标')} /> : view === 'compare' ?
      <W.CompareDiff path="same.c" leftText={originalText} rightText={texts[fileId as 'a' | 'b']} leftLabel="初始示例" rightLabel="当前原文" readOnlyReason="比较只读；返回编辑后可继续修改。" /> : null}</div>
    <details><summary>受控原文（保留 BOM／换行）</summary><pre>{JSON.stringify(texts[fileId as 'a' | 'b'])}</pre></details></Stage>
}
function CodeDemo({ target = 'workspace', readOnly = false, empty = false }: { target?: 'workspace' | 'strip'; readOnly?: boolean; empty?: boolean }) {
  const identity = useId(), [items, setItems] = useState<W.WorkspaceFile[]>(empty ? [] : files), [active, setActive] = useState(empty ? '' : 'example-main')
  const [opened, setOpened] = useState(empty ? [] : ['example-main', 'example-notes']), [texts, setTexts] = useState<Record<string, string>>({ 'example-main': originalText, 'example-notes': '# 示例笔记\n', 'example-old': files[2].confirmed!.text })
  const [menu, setMenu] = useState(target === 'strip'), [event, setEvent] = useEvent()
  const access: W.WorkspaceAccess = readOnly ? { kind: 'read-only', reason: '目录中的历史作品样本' } : { kind: 'editable' }
  const open = (id: string) => { setActive(id); setOpened(value => value.includes(id) ? value : [...value, id]); setEvent(`打开实例 ${id}`) }
  const close = (id: string) => { setOpened(value => value.filter(item => item !== id)); if (active === id) setActive(''); setEvent(`只关闭标签 ${id}`) }
  const create = (name: string): W.CreateOutcome => {
    if (!name.trim()) return { ok: false, problem: 'empty' }
    if (items.some(file => file.path === name && file.lifecycle === 'active')) return { ok: false, problem: 'duplicate' }
    const id = `local-${items.length}`; setItems(value => [...value, { fileId: id, path: name, lifecycle: 'active', confirmed: null }]); setTexts(value => ({ ...value, [id]: '' })); open(id)
    return { ok: true, fileId: id }
  }
  const recycle = (id: string) => { setItems(value => value.map(file => file.fileId === id ? { ...file, lifecycle: 'recycled' } : file)); setEvent(`本地回收意图 ${id}`) }
  const restore = (id: string) => { setItems(value => value.map(file => file.fileId === id ? { ...file, lifecycle: 'active' } : file)); setEvent(`本地恢复意图 ${id}`) }
  const state: W.CodeWorkspaceDisplay = { loaded: true, files: items, openFiles: items.filter(file => opened.includes(file.fileId)), activeFile: items.find(file => file.fileId === active) ?? null,
    access, protection: { status: 'protected', reason: null }, usage: { activeFiles: items.filter(file => file.lifecycle === 'active').length, activeBytes: 80 },
    createdFileIds: items.filter(file => !file.confirmed).map(file => file.fileId), dirtyFileIds: ['example-main'], fileActions: Object.fromEntries(items.map(file => [file.fileId, {
      recycleBlockedReason: readOnly || !file.confirmed ? '此示例状态不能回收' : null, restoreBlockedReason: readOnly ? '此示例状态不能恢复' : null, occupant: null }])) }
  return <Stage event={event} height={580}><div style={{ height: 420, position: 'relative', display: 'flex', flexDirection: 'column' }}>{target === 'workspace' ? <W.CodeWorkspace state={state} text={texts[active] ?? ''} workspaceKey={`catalog-code-${identity}`}
    onOpen={open} onCloseTab={close} onCreate={create} onDraftChange={(id, text) => setTexts(value => ({ ...value, [id]: text }))} onRecycle={recycle} onRestore={restore}
    diagnostics={{ status: 'ready', result: { status: 'ready', diagnostics: [{ severity: 'warning', message: '本地静态诊断样本，未运行编译器', path: 'main.c', line: 2 }] } }} /> :
    <W.FileStrip files={items.filter(file => file.lifecycle === 'active')} recycledFiles={items.filter(file => file.lifecycle === 'recycled')} openFiles={state.openFiles} activeFileId={active || null}
      isDirty={file => file.fileId === 'example-main'} isCreated={file => !file.confirmed} lifecyclePending={file => file.confirmed?.lifecycle !== file.lifecycle}
      canCreate={!readOnly} createBlockedReason={readOnly ? '历史作品只读' : null} canManage={!readOnly} manageBlockedReason={readOnly ? '历史作品只读' : null}
      recycleBlockedReason={file => state.fileActions[file.fileId].recycleBlockedReason} restoreBlockedReason={file => state.fileActions[file.fileId].restoreBlockedReason} restoreOccupant={() => null}
      usage={state.usage} menuOpen={menu} onMenuOpenChange={setMenu} onOpen={open} onClose={close} onCreate={create} onRecycle={recycle} onRestore={restore} />}</div></Stage>
}
function StatusDemo({ failed = false }: { failed?: boolean }) {
  return <Stage><W.StatusBar file={files[0]} cursor={{ line: 2, column: 5 }} text={originalText} created={false} dirty loaded protection={{ status: failed ? 'failed' : 'protected', reason: failed ? '示例：本地空间不足' : null }} /></Stage>
}
function ProtectionDemo({ status }: { status: W.ProtectionStatus }) { return <Stage><W.ProtectionChip status={status} reason={status === 'failed' ? '示例：本地空间不足' : null} /></Stage> }
function CodeRunDemo({ locked = false }: { locked?: boolean }) {
  const [count, setCount] = useState(locked ? 0 : 2), [event, setEvent] = useEvent()
  return <Stage event={event}><W.CodeRunCluster access={locked ? { kind: 'paused', reason: '示例分配暂停' } : { kind: 'editable' }} lifecyclePendingCount={count ? 1 : 0} unconfirmedCount={count} confirmedRevision={2}
    onSave={() => { setCount(0); setEvent('仅确认示例内存状态') }} /></Stage>
}

const comparisonFile: W.ComparisonFile = { localId: 'example-main', path: 'main.c', base: 'return 0;', mine: originalText, theirs: 'int main(void) {\n    return 1;\n}\n' }
const versionFile: W.VersionFile = { fileId: 'example-main', path: 'main.c', documentVersion: 2, contentHash: 'example-hash-a', text: originalText, lifecycle: 'active' }
function CompareDemo({ kind, missing = false }: { kind: 'diff' | 'read' | 'conflict' | 'file' | 'versions' | 'row'; missing?: boolean }) {
  const [event, setEvent] = useEvent(), [left, setLeft] = useState('a'), [right, setRight] = useState('b')
  const file = { ...comparisonFile, theirs: missing ? null : comparisonFile.theirs }
  const nextVersion: W.VersionFile = { ...versionFile, documentVersion: 3, contentHash: 'example-hash-b', text: 'int main(void) { return 1; }', lifecycle: 'recycled' }
  const row: W.VersionRow = { key: 'example-main', fileId: 'example-main', path: 'main.c', left: versionFile, right: missing ? null : nextVersion }
  const selectedRow: W.VersionRow = { ...row, left: left === 'a' ? versionFile : nextVersion, right: missing ? null : right === 'a' ? versionFile : nextVersion }
  return <Stage event={event} height={620}>{kind === 'diff' ? <W.CompareDiff path="main.c" leftText={originalText} rightText={comparisonFile.theirs!} leftLabel="示例本机" rightLabel="示例确认作品" readOnlyReason="目录比较只读" /> :
    kind === 'read' ? <W.CompareReadOnly path="main.c" text={originalText} ariaLabel="示例原文" readOnlyReason="目录原文只读" /> :
    kind === 'conflict' ? <W.ConflictCompare comparison={{ commandKey: 'example-original-command', source: 'version-conflict', files: [file] }} busy={false} resolvable={!missing}
      onReturn={() => setEvent('返回示例编辑')} onKeepMine={() => setEvent('保留示例本页正文（未写存储）')} onAdoptServer={() => setEvent('采用示例对侧正文（未写存储）')} /> :
    kind === 'file' ? <W.CompareFile file={file} /> : kind === 'row' ? <W.VersionRowView row={row} leftLabel="示例 v2" rightLabel="示例 v3" /> :
    <W.VersionCompare comparison={{ kind: 'versions', source: 'snapshots', leftLabel: `示例 ${left}`, rightLabel: `示例 ${right}`, rows: [selectedRow], changedCount: missing || left !== right ? 1 : 0 }} options={[{ id: 'a', label: '示例版本 A' }, { id: 'b', label: '示例版本 B' }]}
      leftId={left} rightId={right} onSelect={(side, id) => { if (side === 'left') setLeft(id); else setRight(id); setEvent(`选择 ${side} / ${id}`) }} onReturn={() => setEvent('返回示例编辑')} />}</Stage>
}

const hdlInputs: W.HdlInputs = { switches: '0000000000000011', buttons: '00000', resetN: '1' }
const hdlFrame: W.HdlFrame = { ...hdlInputs, leds: '0000000000000011', anodes: '11111110', segments: '0010010', dp: '1', simTimePs: '90071992547409930' }
const hdlBoard: W.HdlBoardProfile = { boardProfileVersion: 'example-board-v1', mappingVersion: 'example-mapping-v1', topModule: 'example_alu',
  bindings: [{ signal: 'buttons', offset: 0, port: 'buttons', portOffset: 0, width: 5 }, { signal: 'resetN', offset: 0, port: 'rst_n', portOffset: 0, width: 1 }] }
const hdlSession: W.HdlSessionView = { sessionId: 'example-session', buildId: 'example-build', snapshotId: 'snapshot-a', snapshotHash: 'example-hash', boardProfileVersion: hdlBoard.boardProfileVersion,
  mappingVersion: hdlBoard.mappingVersion, engineVersion: 'example-engine', runtimeProfileVersion: 'example-profile', sessionRevision: 2, confirmedSequence: 1,
  simTimePs: hdlFrame.simTimePs, status: 'active', terminationConfirmed: false, stopRequested: false, createdAt: '2026-11-08T00:00:00Z', deadline: '2099-01-01T00:00:00Z', lastOperationAt: '2026-11-08T00:00:00Z' }
const hdlResult: W.HdlOperationResult = { operationId: 'example-operation', sessionId: hdlSession.sessionId, buildId: 'example-build', snapshotId: 'snapshot-a', snapshotHash: 'example-hash',
  boardProfileVersion: hdlBoard.boardProfileVersion, mappingVersion: hdlBoard.mappingVersion, engineVersion: 'example-engine', sequence: 1, sessionRevision: 2,
  frames: Array.from({ length: 33 }, (_, index) => ({ ...hdlFrame, simTimePs: String(BigInt(hdlFrame.simTimePs) + BigInt(index)), leds: index % 2 ? '00000000000000xz' : hdlFrame.leds })),
  finalFrame: hdlFrame, sampleCount: 40, droppedFrames: 7, coverage: 'incomplete', resultHash: 'example-result-hash' }
const hdlBuild: W.HdlBuildView = { status: 'succeeded', result: { buildId: 'example-build', snapshotId: 'snapshot-a', snapshotHash: 'example-hash', board: hdlBoard,
  runtimeProfileVersion: 'example-profile', engineVersion: 'example-engine', imageDigest: 'example-image', configurationHash: 'example-config', status: 'succeeded', terminationConfirmed: true,
  artifactHash: 'example-artifact', diagnostics: [{ severity: 'warning', message: '本地诊断样本：注意信号位宽。', fileId: 'example-main', path: 'alu.sv', line: 2, location: 'line-only' }], stdout: 'example build log', stderr: '' } }
function HdlDemo({ target, mode = 'ready' }: { target: 'digit' | 'board' | 'trace' | 'run' | 'build'; mode?: 'ready' | 'unknown' | 'empty' | 'pending' | 'failed' }) {
  const [inputs, setInputs] = useState(hdlInputs), [pending, setPending] = useState(mode === 'pending'), [event, setEvent] = useEvent()
  const frame = mode === 'unknown' ? { ...hdlFrame, anodes: 'xxxxxxx0', segments: 'xz01xz0', leds: 'xxxxxxxxzzzzzzzz', dp: 'z' } : hdlFrame
  const session = mode === 'empty' ? null : mode === 'pending' ? { ...hdlSession, stopRequested: true, status: 'stopping' as const } : hdlSession
  const result = mode === 'empty' ? null : { ...hdlResult, finalFrame: frame }
  const build = mode === 'empty' ? { status: 'succeeded' as const, result: null } : mode === 'failed' ? { ...hdlBuild, status: 'failed' as const, result: { ...hdlBuild.result!, status: 'failed' as const,
    diagnostics: [{ severity: 'error' as const, message: '示例：语法错误', location: 'unavailable' as const }], stderr: 'example compiler error' } } : hdlBuild
  return <Stage event={event} height={640}><p>以下是响应形状的本地样本，不运行 HDL 仿真；输入操作仅触发本地回调。</p>
    {target === 'digit' ? <div className="ws-board"><W.SignalDigit frame={mode === 'empty' ? null : frame} index={0} /></div> :
      target === 'board' ? <W.HdlBoardPane session={session} result={result} inputs={inputs} bindings={hdlBoard.bindings} pending={pending} disabled={false}
        onInteract={(next, cycles) => { setInputs(next); setEvent(`本地输入回调：推进 ${cycles} 周期；输出仍为原采样样本`) }} canLoad onLoad={() => setEvent('本地装载回调')}
        onRead={() => { setPending(false); setEvent('本地状态读取回调') }} /> : target === 'trace' ? <W.HdlTracePane session={session} result={result} pending={pending} /> :
      target === 'build' ? <W.HdlBuildPane build={build} onRead={() => setEvent('本地读取构建结果')} canHelp onHelp={() => setEvent('引用原示例构建')}
        onDiagnostic={diagnostic => setEvent(`定位回调：${diagnostic.path} / ${diagnostic.line}`)} /> :
      <W.HdlRunCluster build={build} session={session} busy={pending} unknown={mode === 'unknown'} canBuild={!pending} canLoad={!pending} canStop={!!session} snapshotLabel="示例确认作品 v2"
        onBuild={() => setEvent('本地构建回调')} onLoad={() => setEvent('本地装载回调')} onStop={() => { setPending(true); setEvent('本地停止回调，等待示例核对') }} onRefresh={() => { setPending(false); setEvent('本地核对回调') }} />}
  </Stage>
}

const materials: W.MaterialDisplay[] = [
  { index: 0, state: { kind: 'loaded', view: { title: '示例任务说明', text: '保留空输入和重复词的处理依据。\n这是独立目录样本。', paragraphs: ['a', 'b'] } } },
  { index: 1, state: { kind: 'not-readable', reason: 'redacted' } }, { index: 2, state: { kind: 'not-readable', reason: 'unavailable' } }, { index: 3, state: { kind: 'failed' } },
]
const init: W.TextScopeReadyDisplay = { kind: 'ready', context: { trustedRecoveryGeneration: 'example-generation', loadEpoch: 1 }, session: { userId: 'example-student', courses: [{ courseId: 'example-course', role: 'student' }] },
  assignment: { assignmentId: 'example-assignment', activityVersionId: 'example-activity', studentId: 'example-student', status: 'active', active: true, assignmentRevision: 1, activityControlRevision: 1, reasons: {} },
  activity: { activityVersionId: 'example-activity', runtimeProfileVersionId: 'example-profile', courseId: 'example-course', status: 'active', activityControlRevision: 1,
    execution: { kind: 'c_program' }, helpPolicy: { versionId: 'example-policy', helpAllowed: true, wholeSolutionAllowed: false }, content: { content: {
      projectTitle: '示例：文本统计', problem: '如何处理空输入？', artifact: '示例 C 程序与测试说明', audience: '示例读者', studentBackground: '已了解循环与数组', timeConstraints: '示例：一课时',
      routes: ['字符扫描', '分词后统计'], goals: [{ title: '解释边界处理', domain: 'domain', core: true }], tasks: [{ title: '完成统计' }], milestones: [{ title: '核对边界' }], observations: [{ description: '能说明空输入行为' }], rubricCriteria: [{ description: '用测试支持判断' }],
    } } }, materials, prepContext: { scenarioId: 'example-scenario', preparationEpoch: 'example-epoch', authority: { activeSessions: 1 }, capabilities: { attemptCreate: true, workspaceSync: true, snapshot: true, run: false } } }
function ReadingDemo({ target, mode = 'ready' }: { target: 'body' | 'run' | 'info' | 'ready' | 'capability' | 'materials' | 'unavailable'; mode?: 'ready' | 'preparation' | 'loading' | 'unavailable' | 'paused' }) {
  const [event, setEvent] = useEvent()
  const display = mode === 'loading' ? null : mode === 'unavailable' ? { kind: 'unavailable' as const, stage: 'assignment', reason: '示例：当前无法读取分配。' } :
    mode === 'paused' ? { ...init, assignment: { ...init.assignment, active: false, status: 'paused' } } : init
  const presentation = { preparation: mode === 'preparation', courseLabel: '示例 C 准备', prepNotice: '合成准备样本 · 不写入学习记录',
    returnLink: <a href="#example-return" className="primary" onClick={event => { event.preventDefault(); setEvent('本地返回回调') }}>返回我的任务</a> }
  return <Stage event={event}>{target === 'body' ? <W.TextScopeBodyPane init={display} mode={presentation} onReload={() => setEvent('本地重新读取')} /> :
    target === 'run' ? <W.TextScopeRunCluster init={display} mode={presentation} /> : target === 'info' ? <W.PrepTaskInfo init={display} mode={presentation} onReload={() => setEvent('本地重新读取')} /> :
    target === 'ready' ? <W.ReadyTaskInfo init={init} mode={presentation} /> : target === 'capability' ? <W.CapabilityList init={init} /> : target === 'materials' ? <W.MaterialList materials={materials} /> :
    <W.InitUnavailable init={{ kind: 'unavailable', stage: 'assignment', reason: '示例：分配暂不可用，请重试。' }} mode={presentation} onReload={() => setEvent('本地重试回调')} />}</Stage>
}

const tutorMessage: W.TutorMessageDisplay = { valid: true, shown: true, facts: { received: { state: 'confirmed' } }, payload: { actionId: 'example-action', content: '先用一个**空输入**样本验证循环是否正确终止。', basisRevised: false,
  expectedStudentAction: '自行补充边界测试', jobId: 'example-job', messageId: 'example-message', targetVersions: { policyVersionId: 'example-policy' },
  basis: { hdl: { snapshotId: 'snapshot-a', snapshotHash: 'example-hash', buildId: 'example-build', buildStatus: 'succeeded', workspaceRevision: 2 } },
  rationale: '定位边界条件', assistanceContext: '示例概念提示', unresolved: ['尚未验证所有标点情况'], resourceRefs: ['example-material'], evidenceIds: ['example-evidence'] } }
const tutorHistory: W.TutorHistoryEntryDisplay = { action: { actionId: 'example-old-action', jobId: 'example-old-job', messageId: 'example-old-reply', basis: { decisionEpoch: 1 },
  targetVersions: { policyVersionId: 'example-old-policy' }, disposition: 'stale', basisRevised: true, receipts: [{ receiptKind: 'displayed' }] },
  question: { messageId: 'example-old-question', envelope: { question: '示例：怎样处理空输入？' } },
  message: { envelope: { body: { content: '这是原教学历史样本，**不表示当前建议**。', expectedStudentAction: '核对当前代码', assistanceContext: '原概念提示', unresolved: [] } } } }
function TutorMessageDemo({ history = false, sourceOnly = false, stale = false }: { history?: boolean; sourceOnly?: boolean; stale?: boolean }) {
  const [message, setMessage] = useState({ ...tutorMessage, valid: !stale, payload: { ...tutorMessage.payload, basisRevised: stale } }), [event, setEvent] = useEvent()
  return <Stage event={event}>{history ? <W.TutorHistoryView entry={tutorHistory} preparation={false} /> : sourceOnly ? <W.HdlSource basis={tutorMessage.payload.basis!.hdl!} /> :
    <W.TutorMessageView message={message} preparation={false} onAcknowledge={() => { setMessage(value => ({ ...value, facts: { ...value.facts, acknowledged: { state: 'confirmed' } } })); setEvent('本地回应回调，不发送回执') }}
      onExample={() => setEvent('本地资料阅读回调')} hdlSourceNotice={stale ? '原 HDL 来源已变化，仅保留历史。' : undefined} />}</Stage>
}
function TutorPaneDemo({ running = false, blocked = false, empty = false }: { running?: boolean; blocked?: boolean; empty?: boolean }) {
  const [draft, setDraft] = useState('如何验证空输入？'), [expanded, setExpanded] = useState(false), [open, setOpen] = useState(true), [event, setEvent] = useEvent()
  const [sent, setSent] = useState(false), scroller = useRef<HTMLDivElement>(null)
  return <Stage event={event} height={740}>{!open && <button onClick={() => setOpen(true)}>重新打开示例辅导</button>}{open && <W.TutoringPaneView preparation expanded={expanded} atBottom={false} hasMessages={!empty || sent}
    scrollerRef={scroller} onScroll={() => {}} exchanges={empty && !sent ? [] : [{ key: 'example-exchange', command: { question: '如何检查边界？', statusLabel: '已受理' }, messageIds: ['example-action'] }]}
    renderMessage={id => <W.TutorMessageView key={id} message={tutorMessage} preparation onAcknowledge={() => setEvent(`本地回应 ${id}`)} />}
    running={running} waitExceeded={running} pending={blocked} busy={false} canStop={running} job={running ? { jobId: 'example-job', status: 'running', stopRequested: false } : null}
    history={{ phase: 'ready', notice: null, data: { questions: [], entries: [tutorHistory] } }} canReadHistory notice={blocked ? '示例原请求尚待核对。' : null}
    hdlSelection={{ snapshotId: 'snapshot-a', buildId: 'example-build' }} unavailable={blocked ? '示例：限定检查未确认，暂不能新求助。' : null} draft={draft} canSend={!blocked && !!draft.trim()}
    onToggleExpanded={() => setExpanded(value => !value)} onClose={() => setOpen(false)} onJumpLatest={() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight }); setEvent('本地滚动到最新') }}
    onReadHistory={() => setEvent('本地历史读取回调')} onRetry={() => setEvent('核对原示例请求')} onRead={() => setEvent('本地读取辅导')} onStop={() => setEvent('停止原示例 Job')}
    onDraft={setDraft} onSend={replace => { setEvent(`${replace ? '替换' : '发送'}本地问题：${draft}`); setDraft(''); setSent(true) }} />}</Stage>
}
function ControlsDemo({ limited = false, mismatch = false }: { limited?: boolean; mismatch?: boolean }) {
  const [attempt, setAttempt] = useState({ attemptId: 'example-attempt', captureRevision: 1, status: 'active', collecting: true, reminders: false }), [event, setEvent] = useEvent()
  return <Stage event={event}><W.TutoringControlsView identityMatches={!mismatch} hasAttempt hasClient busy={false} policy={{ version: 'example-policy', description: '示例帮助政策：允许概念提示。', help: '主动求助由学生发起。' }}
    state={{ phase: 'ready', limitedCheck: limited, pending: false, notice: null }} attempt={attempt} authoritativeAssignment={{ active: true }}
    coverage={{ attemptId: 'example-attempt', captureRevision: 1, intervals: [{ captureRevision: 1, fromServerSeq: 0, state: attempt.collecting ? 'collecting' : 'paused', from: '示例起点', open: true }] }}
    canToggleAttempt canToggleCapture canToggleReminders onToggleAttempt={() => setAttempt(value => ({ ...value, status: value.status === 'paused' ? 'active' : 'paused' }))}
    onToggleCapture={() => setAttempt(value => ({ ...value, collecting: !value.collecting }))} onToggleReminders={() => setAttempt(value => ({ ...value, reminders: !value.reminders }))}
    onRetry={() => setEvent('本地核对原控制')} onRefresh={() => setEvent('本地读取控制')} /></Stage>
}
function TutoringExampleDemo({ unavailable = false }: { unavailable?: boolean }) {
  const [event, setEvent] = useEvent()
  return <Stage event={event}><W.TutoringExample resource={unavailable ? { kind: 'unavailable', notice: '示例：原资料暂不可回取，保留来源边界。' } :
    { kind: 'ready', resource: { title: '示例：边界测试说明', text: '先观察**空输入**，再观察重复词。\n\n此材料不提供完整实现。' }, sourceLabel: '本地公开材料样本', nature: 'course-material' }}
    onReturn={() => setEvent('返回原示例作品，不保存／发送')} returnNotice="示例：原文件实例仍可定位" /></Stage>
}
const submissionSnapshots: W.SubmissionSnapshotDisplay[] = ['a', 'b'].map((id, index) => ({ snapshotId: `snapshot-${id}`, workspaceRevision: index + 2, createdAt: '2026-11-08T00:00:00Z', hash: `example-${id}`,
  files: [{ fileId: 'example-main', path: 'main.c', documentVersion: index + 2 }] }))
const sampleSubmission = { submissionId: 'example-submission', workspaceRevision: 2, submittedAt: '2026-11-08T00:00:00Z', snapshotId: 'snapshot-a', snapshotHash: 'example-a', hasReflection: true, checkRefs: [{ runId: 'check-a' }] }
const submissionState: W.SubmissionFeedbackDisplay = { phase: 'ready', assignment: { active: true }, pending: null, notice: null, feedbackNotice: null,
  recovery: { attempt: { status: 'active', attemptRevision: 2 }, runs: [{ runId: 'check-a', snapshotId: 'snapshot-a', mode: 'check', outcome: 'failed' }, { runId: 'check-b', snapshotId: 'snapshot-b', mode: 'check', outcome: 'passed' }],
    reopen: { actionable: false, state: 'none' }, submissions: [] }, feedback: { entries: [] } }
function SubmissionDemo({ mode = 'active' }: { mode?: 'active' | 'feedback' | 'unknown' | 'paused' }) {
  const [display, setDisplay] = useState<W.SubmissionFeedbackDisplay>(() => mode === 'unknown' ? { ...submissionState, phase: 'unknown', pending: { kind: 'submit' }, notice: '示例：核对原提交请求' } :
    mode === 'paused' ? { ...submissionState, assignment: { active: false } } : mode === 'feedback' ? { ...submissionState, recovery: { ...submissionState.recovery!, attempt: { status: 'reviewed', attemptRevision: 3 },
      reopen: { state: 'valid', actionable: true, reason: '示例：补充边界测试' }, submissions: [sampleSubmission], latestSubmissionId: sampleSubmission.submissionId }, feedback: { entries: [{ feedbackId: 'example-feedback', threadRevision: 2, kind: 'submission_review', current: true,
        createdAt: '2026-11-08T00:00:00Z', summary: '示例反馈：请补充空输入验证。', reason: '当前说明没有展示边界行为。', disputed: true, submissionId: 'example-submission', basis: [{ claimId: 'example-claim', claimRevision: 1, status: 'revised' }] }] } } : submissionState)
  const [event, setEvent] = useEvent()
  return <Stage event={event}><W.SubmissionFeedbackPanel state={display} snapshots={submissionSnapshots} unconfirmedCount={2} resetKey={1} onReturn={() => setEvent('本地返回作品')}
    onRefresh={() => { setDisplay(value => ({ ...value, phase: 'ready' })); setEvent('本地读取反馈') }} onReconcile={() => { setDisplay(value => ({ ...value, phase: 'ready', pending: null })); setEvent('仅核对原示例请求') }}
    onSubmit={(id, reflection, checks) => { const selected = submissionSnapshots.find(item => item.snapshotId === id)!; setEvent(`明确示例快照 ${id}；反思 ${reflection.length} 字；检查 ${checks.join(', ')}`); setDisplay(value => ({ ...value, recovery: { ...value.recovery!, attempt: { status: 'submitted', attemptRevision: 3 }, latestSubmissionId: 'example-submission', submissions: [{ ...sampleSubmission, snapshotId: id, workspaceRevision: selected.workspaceRevision, snapshotHash: selected.hash, hasReflection: !!reflection, checkRefs: checks.map(runId => ({ runId })) }] } })) }}
    onResume={() => { setEvent('主动开始本地示例修订'); setDisplay(value => ({ ...value, recovery: { ...value.recovery!, attempt: { status: 'active', attemptRevision: 4 }, reopen: { state: 'consumed', actionable: false } } })) }} /></Stage>
}
function ExecutionDemo({ mode = 'ready' }: { mode?: 'ready' | 'unready' | 'loading' }) {
  const [display, setDisplay] = useState<W.ExecutionNodesDisplay>({ status: mode === 'loading' ? 'loading' : 'ready', selectedNodeId: mode === 'unready' ? 'b' : 'a', notice: null,
    nodes: [{ nodeId: 'a', label: '示例电脑 A', cReady: true, hdlReady: true }, { nodeId: 'b', label: '示例电脑 B', cReady: false, hdlReady: false }] }), [event, setEvent] = useEvent()
  return <Stage event={event}><W.ExecutionNodeSelect state={display} identityCurrent kind="c" busy={false} onSelect={id => { setDisplay(value => ({ ...value, selectedNodeId: id })); setEvent(`仅选择本地电脑 ${id}`) }}
    onRefresh={() => { setDisplay(value => ({ ...value, status: 'ready' })); setEvent('本地刷新回调') }} /></Stage>
}

const localGenHost: W.GenHostFactory = options => {
  let container: HTMLElement | null = null, count = 0
  const paint = () => {
    if (!container) return
    const button = document.createElement('button'); button.type = 'button'; button.textContent = `本地交互样本：${count} 次`
    button.style.cssText = 'padding:16px;color:var(--ink);background:var(--sunken);border:1px solid var(--line);border-radius:8px'
    button.onclick = () => { count++; paint(); options.callbacks.onState({ count }, 100) }
    container.replaceChildren(button)
  }
  const load = (_source: string, snapshot?: unknown) => { count = typeof snapshot === 'object' && snapshot !== null && 'count' in snapshot ? Number(snapshot.count) || 0 : 0; paint(); options.callbacks.onReady(100) }
  return { mount: (element, text, snapshot) => { container = element; load(text, snapshot) }, unmount: () => { container?.replaceChildren(); container = null },
    snapshot: async () => ({ count }), reload: load, loadVersion: load }
}
function GenDemo({ missing = false }: { missing?: boolean }) {
  const [event, setEvent] = useEvent(), [snapshot, setSnapshot] = useState<unknown>({ count: 2 })
  return <Stage event={event}><W.GenToolPane card={missing ? null : { cardId: 'example-card', title: '本地计数交互', taskId: 'example-task', claimSim: false, srcdoc: 'local-demo', version: 1, snapshot }} createHost={localGenHost}
    onCollect={value => { setSnapshot(value); setEvent(`本地收纳快照 ${JSON.stringify(value)}`) }} onStateSync={value => setEvent(`本地状态 ${JSON.stringify(value)}`)} onClose={() => setEvent('关闭缺失卡的示例标签')} /></Stage>
}
function GuidanceDemo({ direct = false, quiet = false, rich = false }: { direct?: boolean; quiet?: boolean; rich?: boolean }) {
  const [event, setEvent] = useEvent(), [id, setId] = useState(1)
  const Presentation = direct ? W.VisibleGuidance : W.GuidancePresentation
  return <Stage event={event} height={650}><div style={{ position: 'relative', height: 470, border: '1px solid var(--line)' }}>
    <button onClick={() => setId(value => value + 1)}>替换当前展示</button><Presentation key={`example-guidance-${id}`} item={{ id: `example-guidance-${id}`, label: '本地引导示例', content: rich ? { kind: 'card', title: '七段管演示', body: <W.SegmentsDemo /> } :
      { kind: 'text', text: '先阅读任务，再对照当前代码。\n只有明确操作才触发回调。' }, actions: [{ id: 'next', label: '下一步', primary: true }, { id: 'disabled', label: '禁用操作', disabled: true }] }}
    state={quiet ? 'quiet' : 'showing'} companionAction={{ id: 'chat', label: '打开本地学习助手' }} onAction={receipt => setEvent(`${receipt.presentationId} / ${receipt.actionId} / ${receipt.source}`)} /></div></Stage>
}
function GuideDemo({ card = false }: { card?: boolean }) {
  const [step, setStep] = useState(0), [collected, setCollected] = useState<string[]>([]), [event, setEvent] = useEvent()
  const steps: W.GuideStep[] = [{ at: 'dock', text: '本地引导：先阅读任务。' }, { at: 'boardRich', card: 'debounce', below: true }]
  return <Stage event={event} height={700}><div style={{ position: 'relative', height: 540 }}><W.GuideLayer step={steps[card ? 1 : step]} stepIndex={card ? 1 : step} total={2} idle={false} busy={false} milestone={0} docked={false}
    collected={collected} pinned={[]} collecting={null} onNext={() => { setStep(value => (value + 1) % 2); setEvent('本地下一步') }} onCollect={key => { setCollected(value => [...value, key]); setEvent(`本地收纳 ${key}`) }}
    onIpClick={() => setEvent('本地打开学习助手')} /></div></Stage>
}

export const workspaceEntries: CatalogEntry[] = [
  entry('TaskProgress', 'TaskPresentation', '受控进度环；每个实例的 gradient ID 独立。', ['percent/done/status', 'title/ariaLabel'], [], [state('progress', '进行中／可调进度', () => <TaskProgressDemo />), state('done', '已完成', () => <TaskProgressDemo done />)]),
  entry('TaskInfo', 'TaskPresentation', '任务展示字段由调用方提供，演示说明可省略。', ['name/status/goal', 'percent/done/currentProgress/stage/deadline/course', 'demoNotice?'], ['ProgressBar', '状态节点插槽'], [state('plain', '无演示标识', () => <TaskInfoDemo />), state('demo', '显式演示标识', () => <TaskInfoDemo demo />)]),
  entry('FileTabs', 'FileTabs', '关闭标签与删除文件明确分离。', ['files/activeId/tabRoles', 'onOpen/onClose'], ['Icon'], [state('tabs', '打开／关闭', () => <FileTabsDemo />), state('empty', '空标签', () => <FileTabsDemo empty />)]),
  entry('ConfirmationCluster', 'ConfirmationCluster', '确认保存、快照与原请求恢复状态。', ['phase/hasAttempt/workspaceRevision/snapshot', 'canSave/canSnapshot/canRetry', 'onOpen/onSave/onSnapshot/onRetry/onReload'], ['WorkspacePopover'], [state('ready', '未确认改动', () => <ConfirmationDemo />), state('unknown', '原请求未知', () => <ConfirmationDemo initial="unknown" />), state('saving', '保存中／禁用操作', () => <ConfirmationDemo initial="saving" />), state('readonly', '只读', () => <ConfirmationDemo initial="readonly" />), state('idle', '尚无尝试', () => <ConfirmationDemo initial="idle" />)]),
  entry('WorkspacePopover', 'WorkspacePopover', '非模态 body Portal；验证 Escape、Tab 与焦点返回。', ['label/icon/children', 'closeOnAction/attention/accessibleLabel'], ['document.body', 'ResizeObserver', '焦点目标'], [state('interactive', '打开／键盘／动作关闭', PopoverDemo)]),
  entry('CoreRunEntry', 'RunPanel', '顶栏运行入口。', ['onOpen'], [], [state('interactive', '本地回调', () => { const [event, setEvent] = useEvent(); return <Stage event={event}><W.CoreRunEntry onOpen={() => setEvent('打开本地运行面板')} /></Stage> })]),
  entry('RunPanel', 'RunPanel', '参数选择与只读结果；所有运行均为明确的本地样本。', ['snapshots/selection/result', 'busy/canRun/synthetic/control', 'onSelect/onRun/onRead/onReturn/onHelp'], [], [state('stats', '统计与结果', () => <RunDemo />), state('find', '查找输入', () => <RunDemo operation="find" />), state('top', '词频数量', () => <RunDemo operation="top" />), state('busy', '提交／停止状态', () => <RunDemo busy />), state('unavailable', '结果不可回取', () => <RunDemo unavailable />)]),
  entry('RunHistoryPanel', 'RunHistoryPanel', '双列历史身份、诊断和产物状态。', ['options/sides/busy/notice/synthetic', 'onSelect/onRead/onReturn/onDownload/onHelp'], [], [state('files', '完整／不完整产物', () => <HistoryDemo />), state('redacted', '裁剪产物', () => <HistoryDemo kind="redacted" />), state('unavailable', '不可回取', () => <HistoryDemo kind="unavailable" />), state('empty', '无历史运行', () => <HistoryDemo kind="empty" />)]),
  entry('SideDock', 'SideDock', '任务胶囊与卡片收纳；WAAPI 和 reduced-motion 维持原行为。', ['taskInfo/stash', 'onPin/onOpen/onToast'], ['浏览器几何', 'Web Animations', '定位祖先'], [state('cards', '信息／收纳／钉住', () => <DockDemo />), state('empty', '空收纳提示', () => <DockDemo empty />)]),
  entry('CenterToolArea', 'CenterToolArea', '受控布局树、工具标签、拖放分屏与双顶栏 Portal。', ['layout/onLayoutChange/tool/onToolChange', 'variant/tools/tabsSlot/runSlot', 'designBody/boardBody/waveBody/runCluster'], ['布局 helper', 'Portal 目标', '本地状态；无布局存储'], [state('demo', '旧版数字逻辑演示', () => <CenterDemo />, 760), state('hdl', '真实 HDL 响应形状样本', () => <CenterDemo variant="digital-logic-real" />, 760), state('c', 'C 工具边界', () => <CenterDemo variant="textscope-c" />, 760)]),
  entry('Seg7', 'CenterToolArea', '数值译码演示七段管；不作为真实 HDL 信号解码器。', ['n/tone'], [], [state('board', '仪器材质', () => <DigitDemo />), state('card', '教学卡材质', () => <DigitDemo tone="card" />)]),
  entry('EditorPane', 'CenterToolArea', '旧版静态演示代码，不可编辑。', [], [], [state('static', '静态代码', () => <Stage><W.EditorPane /></Stage>)]),
  entry('WavePane', 'CenterToolArea', '旧版静态示意波形，不是真实采样。', [], [], [state('static', '演示波形', () => <Stage><W.WavePane /></Stage>)]),
  entry('BoardPane', 'CenterToolArea', '旧版计数板；局部状态明确标为模拟。', ['count/sw/loaded', 'onCount/onReset/onSw'], ['Seg7'], [state('interactive', '计数／复位／开关', DemoBoard)]),
  entry('Divider', 'CenterToolArea', '真实拖拽分隔条，调用方控制比例。', ['horiz/onResize'], ['具有尺寸的父容器', 'PointerEvent'], [state('drag', '拖动调整比例', DividerDemo)]),
  entry('ToolTabs', 'CenterToolArea', '核心工具和生成卡标签，带滑动高亮与拖放动作。', ['pane/tools/genCards/allowDrop', 'onActivate/onDragStart/onDragEnd/onDropOn/onClose'], ['IconText', '布局测量'], [state('interactive', '选择／拖动／关闭', ToolTabsDemo)]),
  entry('DigitalLogicRunCluster', 'CenterToolArea', '旧版数字逻辑模拟运行簇。', ['dirty/onBuild/onLoad'], ['IconText'], [state('dirty', '草稿与板载不同', () => <DemoRunCluster />), state('synced', '板载同步', () => <DemoRunCluster synced />)]),
  entry('CodeWorkspace', 'CodeWorkspace', '真实多文件编辑视图，示例只写 React 内存。', ['state/text/workspaceKey', 'onOpen/onCloseTab/onCreate/onDraftChange/onRecycle/onRestore', 'diagnostics/editorHandleRef'], ['Monaco', 'FileStrip', '独立 workspaceKey；无草稿仓库'], [state('editable', '文件／编辑／回收恢复', () => <CodeDemo />, 730), state('readonly', '历史只读', () => <CodeDemo readOnly />, 730), state('empty', '空项目／新建', () => <CodeDemo empty />, 730)]),
  entry('StatusBar', 'CodeWorkspace', '行列、BOM／换行、确认版本与本机保护分别呈现。', ['file/cursor/text/created/dirty/loaded/protection'], [], [state('facts', '原文事实', () => <StatusDemo />), state('failed', '本机保护失败', () => <StatusDemo failed />)]),
  entry('ProtectionChip', 'CodeWorkspace', '本机保护状态不等于确认作品。', ['status/reason'], [], [state('protected', '已保护', () => <ProtectionDemo status="protected" />), state('saving', '保护中', () => <ProtectionDemo status="saving" />), state('failed', '保护失败', () => <ProtectionDemo status="failed" />)]),
  entry('CodeRunCluster', 'CodeWorkspace', '旧版模拟确认簇，区分生命周期意图。', ['access/lifecyclePendingCount/unconfirmedCount/confirmedRevision/onSave'], [], [state('dirty', '正文与生命周期待确认', () => <CodeRunDemo />), state('paused', '暂停状态', () => <CodeRunDemo locked />)]),
  entry('FileStrip', 'FileStrip', '文件菜单、行内新建、实例回收／恢复与标签。', ['files/recycledFiles/openFiles/activeFileId', 'menuOpen/onMenuOpenChange/isDirty/isCreated/lifecyclePending', '权限／原因／操作回调'], ['FileTabs', '本地文件实例数据'], [state('interactive', '菜单／新建／回收恢复', () => <CodeDemo target="strip" />), state('readonly', '只读限制', () => <CodeDemo target="strip" readOnly />), state('empty', '空项目', () => <CodeDemo target="strip" empty />)]),
  entry('CodeEditorHost', 'CodeEditorHost', '实际 Monaco 编辑器；切换实例并验证撤销和原文选区。', ['workspaceKey/fileId/language/initialText', 'readOnly/readOnlyReason', 'onTextChange/onCursorChange/ref'], ['monaco-editor', '本地 worker', '模型注册表'], [state('editable', '编辑／同名实例切换', () => <EditorDemo />, 730), state('readonly', '只读与提示', () => <EditorDemo readOnly />, 730)]),
  ...(['CompareDiff', 'CompareReadOnly', 'ConflictCompare', 'CompareFile', 'VersionCompare', 'VersionRowView'] as const).map((name, index) => {
    const kinds = ['diff', 'read', 'conflict', 'file', 'versions', 'row'] as const
    const file = index < 2 ? 'CompareText' : index < 4 ? 'ConflictCompare' : 'VersionCompare'
    return entry(name, file, '独立只读比较示例；原文、实例身份与选择回调保留。', [ ['path/leftText/rightText/leftLabel/rightLabel/readOnlyReason/ariaLabel?'], ['path/text/ariaLabel/readOnlyReason'], ['comparison/busy/resolvable', 'onReturn/onKeepMine/onAdoptServer'], ['file'], ['comparison/options/leftId/rightId', 'onSelect/onReturn'], ['row/leftLabel/rightLabel'] ][index], ['Monaco 临时匿名模型', '不修改编辑模型或业务对象'], [state('comparison', '双方原文／交互', () => <CompareDemo kind={kinds[index]} />, 760), ...(index >= 2 ? [state('missing', '一侧缺失／不可解决', () => <CompareDemo kind={kinds[index]} missing />, 760)] : [])])
  }),
  ...(['SignalDigit', 'HdlBoardPane', 'HdlTracePane', 'HdlRunCluster', 'HdlBuildPane'] as const).map((name, index) => {
    const targets = ['digit', 'board', 'trace', 'run', 'build'] as const
    return entry(name, 'HdlToolArea', '真实 HDL 展示契约的本地响应样本；不连接仿真或执行节点。', [ ['frame/index'], ['session/result/inputs/bindings/pending/disabled', 'onInteract/canLoad/onLoad/readBusy/onRead/currentNotice'], ['session/result/pending/currentNotice'], ['build/session/busy/readBusy/unknown/notice/snapshotLabel', 'canBuild/canLoad/canStop/onBuild/onLoad/onStop/onRefresh'], ['build/busy/notice/canHelp/onDiagnostic/onHelp/onRead'] ][index], ['四态信号', '原快照／会话／操作身份', '无 HDL 运行时'], [
      state('sample', '本地确认样本', () => <HdlDemo target={targets[index]} />, 820), state('empty', '未取得结果', () => <HdlDemo target={targets[index]} mode="empty" />, 820),
      ...(index < 2 || index === 3 ? [state('unknown', 'X/Z 或结果未知', () => <HdlDemo target={targets[index]} mode="unknown" />, 820)] : []),
      ...(index === 1 || index === 3 ? [state('pending', '停止／操作待核对', () => <HdlDemo target={targets[index]} mode="pending" />, 820)] : []),
      ...(index === 4 ? [state('failed', '构建诊断失败', () => <HdlDemo target="build" mode="failed" />, 820)] : []),
    ])
  }),
  ...(['TextScopeBodyPane', 'TextScopeRunCluster', 'PrepTaskInfo', 'ReadyTaskInfo', 'CapabilityList', 'MaterialList', 'InitUnavailable'] as const).map((name, index) => {
    const targets = ['body', 'run', 'info', 'ready', 'capability', 'materials', 'unavailable'] as const
    return entry(name, 'TextScopePanes', '初始化、任务或材料的公开展示数据；裁剪与不可用不补造内容。', [ ['init/mode/onReload'], ['init/mode'], ['init/mode/onReload'], ['init/mode'], ['init'], ['materials'], ['init/mode/onReload'] ][index], ['Icon', '本地初始化／材料样本；无 bootstrap'], [
      state('sample', '明确展示样本', () => <ReadingDemo target={targets[index]} />, 900),
      ...(index < 3 ? [state('loading', '初始化读取中', () => <ReadingDemo target={targets[index]} mode="loading" />), state('preparation', '显式合成准备', () => <ReadingDemo target={targets[index]} mode="preparation" />, 900),
        state('unavailable', '初始化不可用', () => <ReadingDemo target={targets[index]} mode="unavailable" />), state('paused', '分配暂停', () => <ReadingDemo target={targets[index]} mode="paused" />, 900)] : []),
    ])
  }),
  entry('InitLoading', 'TextScopePanes', '初始化读取状态，不创建尝试。', [], ['Icon'], [state('loading', '读取中', () => <Stage><W.InitLoading /></Stage>)]),
  entry('Section', 'TextScopePanes', '旧版任务信息分节。', ['title/children'], [], [state('content', '标题与内容', () => <Stage><W.Section title="示例活动要求"><p>调用方提供的本地说明。</p></W.Section></Stage>)]),
  entry('Fact', 'TextScopePanes', '标签与事实读数。', ['label/value'], [], [state('value', '明确读数', () => <Stage><W.Fact label="原确认版本" value="示例 v2" /></Stage>)]),
  entry('Block', 'TextScopePanes', '带标签的多行说明。', ['label/text'], [], [state('text', '说明正文', () => <Stage><W.Block label="示例问题" text="如何说明空输入处理？" /></Stage>)]),
  entry('List', 'TextScopePanes', '有内容时显示的要求列表。', ['title/items'], [], [state('items', '多条要求', () => <Stage><W.List title="示例里程碑" items={['说明边界', '保留验证依据']} /></Stage>)]),
  entry('TutoringExample', 'TutoringExample', '只读资料与返回回调。', ['resource/onReturn/returnNotice'], ['Markdown'], [state('reading', '公开资料样本', () => <TutoringExampleDemo />), state('unavailable', '资料不可回取', () => <TutoringExampleDemo unavailable />)]),
  entry('SubmissionFeedbackPanel', 'SubmissionFeedbackPanel', '明确快照、反思、匹配检查、反馈和主动修订。', ['state/snapshots/unconfirmedCount/resetKey', 'onSubmit(snapshotId, reflection, checks)/onResume/onReconcile/onRefresh/onReturn'], ['本地展示数据；无提交控制器或存储'], [state('active', '选择／确认提交', () => <SubmissionDemo />, 1000), state('feedback', '反馈／异议／修订许可', () => <SubmissionDemo mode="feedback" />, 1000), state('unknown', '核对原请求', () => <SubmissionDemo mode="unknown" />, 1000), state('paused', '教师分配暂停', () => <SubmissionDemo mode="paused" />, 1000)]),
  entry('ExecutionNodeSelect', 'ExecutionNodeSelect', '电脑选择和 readiness 展示；没有节点请求或 store。', ['state/identityCurrent/kind/busy', 'onSelect/onRefresh'], ['WorkspacePopover'], [state('ready', '已就绪／切换', () => <ExecutionDemo />), state('unready', '未就绪仍可编辑', () => <ExecutionDemo mode="unready" />), state('loading', '读取状态样本', () => <ExecutionDemo mode="loading" />)]),
  entry('TutoringControlsView', 'TutoringControlsView', '帮助政策、限定检查和互相独立的学习控制。', ['identityMatches/hasAttempt/hasClient/busy', 'policy/state/attempt/coverage/authoritativeAssignment', '权限布尔值与独立回调'], ['本地状态；无轮询／广播／命令'], [state('controls', '暂停／采集／提醒', () => <ControlsDemo />, 1000), state('limited', '限定帮助检查', () => <ControlsDemo limited />, 1000), state('mismatch', '原身份未核对', () => <ControlsDemo mismatch />)]),
  entry('DebounceDemo', 'cards', '旧版按键抖动教学演示。', [], ['Seg7', '局部演示状态'], [state('interactive', '消抖／计数／重置', () => <Stage><W.DebounceDemo /></Stage>)]),
  entry('SegmentsDemo', 'cards', '数值到段码的旧版教学演示。', [], ['Seg7', 'SEGMAP'], [state('interactive', '增减数值／段码', () => <Stage><W.SegmentsDemo /></Stage>)]),
  entry('ResetDemo', 'cards', '同步／异步复位教学演示；仅本地计时。', [], ['Seg7', '本地 timeout'], [state('interactive', '复位与时序', () => <Stage><W.ResetDemo /></Stage>)]),
  entry('GenToolPane', 'GenCardItems', '注入本地 GenHost 的实际生成卡窗格，不使用旧沙箱服务。', ['card/createHost/onCollect/onStateSync/onClose'], ['GenCard', '本文件 localGenHost'], [state('host', '本地交互／快照／收纳', () => <GenDemo />), state('missing', '卡片缺失', () => <GenDemo missing />)]),
  entry('GuidancePresentation', 'guidance/GuidancePresentation', '引导 Portal 与展示身份／动作回执。', ['item/state/appearance/companionAction/onAction'], ['CompanionButton', 'requestAnimationFrame', '定位区域与 document.body'], [state('text', '文字与动作', () => <GuidanceDemo />, 780), state('card', '教学卡与动作', () => <GuidanceDemo rich />, 780), state('quiet', '安静角色入口', () => <GuidanceDemo quiet />, 780)]),
  entry('VisibleGuidance', 'guidance/GuidancePresentation', '可见引导实例；替换时由示例使用新展示 ID。', ['item/state/companionAction/onAction'], ['CompanionButton', 'Portal／浏览器几何'], [state('visible', '直接实例／展示替换', () => <GuidanceDemo direct />, 780)]),
  entry('TutorMessageView', 'TutorMessageView', '原消息 DOM、来源与受控回执事实；不自行上报 displayed。', ['message/preparation/elementRef/sourceNotice/hdlSourceNotice', 'onAcknowledge/onExample'], ['AgentMessage', '调用方提供回执事实；无观察控制器'], [state('message', '正文／来源／明确回应', () => <TutorMessageDemo />), state('stale', '依据变化的历史内容', () => <TutorMessageDemo stale />)]),
  entry('HdlSource', 'TutorMessageView', '回答原 HDL 来源，不套用当前板卡身份。', ['basis'], [], [state('source', '原快照／构建来源', () => <TutorMessageDemo sourceOnly />)]),
  entry('TutorHistoryView', 'TutorMessageView', '只读原问题、原回答与历史回执。', ['entry/preparation'], ['AgentMessage'], [state('history', '历史依据已修订', () => <TutorMessageDemo history />)]),
  entry('TutoringPaneView', 'TutoringPaneView', '本地受控辅导窗口，保留回合身份与发送／替换／IME 行为。', ['exchanges/renderMessage/history/job', 'scrollerRef/draft/canSend/running/pending/busy', '窗口／滚动／输入／原请求回调'], ['MessageRail', 'TutorMessageView', '无 client、模型或回执服务'], [state('conversation', '窗口／历史／输入', () => <TutorPaneDemo />, 900), state('running', '运行中替换／停止', () => <TutorPaneDemo running />, 900), state('blocked', '原请求／求助受限', () => <TutorPaneDemo blocked />, 900), state('empty', '空会话', () => <TutorPaneDemo empty />, 900)]),
  entry('GuideLayer', 'GuideLayer', '旧课程锚点、步骤和教学卡编排；动作只修改本地样本。', ['step/stepIndex/total/idle/busy/milestone/docked', 'collected/pinned/collecting/onNext/onCollect/onIpClick'], ['GuidancePresentation', 'CARDS', '定位区域'], [state('steps', '下一步与角色入口', () => <GuideDemo />, 850), state('card', '教学卡／收纳', () => <GuideDemo card />, 850)]),
]
