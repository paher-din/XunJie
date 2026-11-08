// @vitest-environment jsdom
import { act, createRef, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CenterToolArea, type CenterToolAreaHandle } from './CenterToolArea'
import { defaultLayout, panes, type LayoutNode } from './wsLayout'
import { FileStrip, type FileStripProps } from './FileStrip'
import { CodeWorkspace, ProtectionChip, type CodeWorkspaceDisplay } from './CodeWorkspace'
import { HdlBoardPane, HdlTracePane, hdlInputChange, hdlTracePositions } from './HdlToolArea'
import { ConflictCompare } from './ConflictCompare'
import { VersionCompare } from './VersionCompare'
import { OriginalEditHistory, projectOriginal } from './originalText'
import type { WorkspaceFile } from './filePresentation'

let host: HTMLDivElement, root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function render(node: ReactNode) { act(() => root.render(node)) }
function event(node: Element, type: string) { act(() => node.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }))) }
function click(node: Element) { act(() => node.dispatchEvent(new MouseEvent('click', { bubbles: true }))) }

it('owns actual split/tab/Portal UI but does not read or write layout storage', () => {
  const read = vi.spyOn(Storage.prototype, 'getItem'), write = vi.spyOn(Storage.prototype, 'setItem')
  const tabs = document.createElement('header'), run = document.createElement('header')
  host.append(tabs, run)
  const ref = createRef<CenterToolAreaHandle>()
  let current: LayoutNode
  function Harness() {
    const [layout, setLayout] = useState(() => defaultLayout())
    current = layout
    return <CenterToolArea ref={ref} layout={layout} onLayoutChange={setLayout} tool="board"
      onToolChange={vi.fn()} onToast={vi.fn()} tabsSlot={tabs} runSlot={run}
      genCards={[{ cardId: 'card', title: '引用卡' }]} renderGeneratedCard={id => <p>内容 {id}</p>} />
  }
  render(<Harness />)
  expect(tabs.querySelectorAll('[role="tab"]')).toHaveLength(3)
  expect(run.textContent).toContain('检查并构建')
  event(tabs.querySelectorAll('[role="tab"]')[0], 'dragstart')
  event(host.querySelector('.ws-dropzone.right')!, 'drop')
  expect(current!.kind).toBe('split')
  expect(host.querySelectorAll('.ws-pane')).toHaveLength(2)
  expect(tabs.querySelectorAll('[role="tab"]')).toHaveLength(0)
  act(() => ref.current!.openGenTab('card'))
  expect(panes(current!).flatMap(pane => pane.tabs)).toContain('gen:card')
  expect(host.textContent).toContain('内容 card')
  act(() => ref.current!.closeGenTab('card'))
  expect(panes(current!).flatMap(pane => pane.tabs)).not.toContain('gen:card')
  click(Array.from(run.querySelectorAll('button')).find(button => button.textContent === '默认布局')!)
  expect(current!.kind).toBe('pane')
  expect(tabs.querySelectorAll('[role="tab"]')).toHaveLength(3)
  expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled()
})

it('never substitutes simulated board, wave or editor for missing real HDL data', () => {
  const props = { onLayoutChange: vi.fn(), onToolChange: vi.fn(), onToast: vi.fn() }
  for (const tool of ['board', 'wave', 'design'] as const) {
    const markup = renderToStaticMarkup(<CenterToolArea {...props} layout={defaultLayout(undefined, tool)} tool={tool} variant="digital-logic-real" />)
    expect(markup).not.toContain('板卡行为由界面脚本模拟')
    expect(markup).not.toContain('静态演示代码')
    expect(markup).not.toContain('模拟构建')
  }
  const demo = renderToStaticMarkup(<CenterToolArea {...props} layout={defaultLayout()} tool="board" />)
  expect(demo).toContain('板卡行为由界面脚本模拟')
})

const file: WorkspaceFile = { fileId: 'instance', path: 'same.c', lifecycle: 'active', confirmed: { text: 'original', version: 2, lifecycle: 'active' } }
it('file menu uses instance IDs and returns focus on Escape; callbacks own lifecycle changes', () => {
  const recycle = vi.fn(), restore = vi.fn()
  const old: WorkspaceFile = { ...file, fileId: 'recycled-instance', lifecycle: 'recycled' }
  const props: FileStripProps = { files: [file], recycledFiles: [old], openFiles: [file], activeFileId: file.fileId,
    isDirty: () => false, isCreated: () => false, lifecyclePending: () => false, canCreate: true, createBlockedReason: null,
    canManage: true, manageBlockedReason: null, recycleBlockedReason: () => null, restoreBlockedReason: () => '路径被占用',
    restoreOccupant: () => file, usage: { activeFiles: 1, activeBytes: 8 }, menuOpen: false,
    onMenuOpenChange: vi.fn(), onOpen: vi.fn(), onClose: vi.fn(), onCreate: vi.fn(), onRecycle: recycle, onRestore: restore }
  function Harness() { const [open, setOpen] = useState(false); return <FileStrip {...props} menuOpen={open} onMenuOpenChange={setOpen} /> }
  render(<Harness />)
  const trigger = host.querySelector('.cw-stripbtn')!
  click(trigger)
  click(host.querySelector('[aria-label="回收 same.c"]')!)
  expect(recycle.mock.calls).toEqual([[file.fileId]])
  expect((host.querySelector('[aria-label="恢复 same.c"]') as HTMLButtonElement).disabled).toBe(true)
  expect(restore).not.toHaveBeenCalled()
  act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(host.querySelector('.cw-filemenu')).toBeNull()
  expect(document.activeElement).toBe(trigger)
  expect(file.lifecycle).toBe('active')
})

it('renders recycled and read-only code facts without mounting an editor or conflating local protection with confirmation', () => {
  const recycled = { ...file, lifecycle: 'recycled' as const }
  const state: CodeWorkspaceDisplay = { loaded: true, files: [recycled], openFiles: [], activeFile: recycled,
    access: { kind: 'read-only', reason: '历史作品' }, protection: { status: 'failed', reason: 'quota' },
    usage: { activeFiles: 0, activeBytes: 0 }, createdFileIds: [], dirtyFileIds: [], fileActions: {} }
  const out = renderToStaticMarkup(<CodeWorkspace state={state} text="\ufefforiginal\r\n" workspaceKey="space" onOpen={vi.fn()}
    onCloseTab={vi.fn()} onCreate={vi.fn()} onDraftChange={vi.fn()} onRecycle={vi.fn()} onRestore={vi.fn()} />)
  expect(out).toContain('这个实例已回收，草稿保留。')
  expect(out).toContain('待确认回收')
  expect(out).toContain('本机草稿未保护')
  expect(out).not.toContain('cw-editor-wrap')
  expect(renderToStaticMarkup(<ProtectionChip status="protected" reason={null} />)).toContain('本机草稿已保护')
})

it('compares supplied identities and reports choices without changing source files', () => {
  const keep = vi.fn(), adopt = vi.fn(), select = vi.fn()
  const comparison = { commandKey: 'original-command', source: 'version-conflict' as const, files: [] }
  render(<ConflictCompare comparison={comparison} busy resolvable onKeepMine={keep} onAdoptServer={adopt} onReturn={vi.fn()} />)
  expect(Array.from(host.querySelectorAll('button')).filter(button => button.disabled)).toHaveLength(2)
  expect(keep).not.toHaveBeenCalled(); expect(adopt).not.toHaveBeenCalled()
  render(<VersionCompare comparison={{ kind: 'versions', source: 'snapshots', leftLabel: 'A', rightLabel: 'B', rows: [], changedCount: 0 }}
    options={[{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]} leftId="a" rightId="b" onSelect={select} onReturn={vi.fn()} />)
  click(host.querySelector('[aria-label="切换左侧来源"]')!)
  expect(select.mock.calls).toEqual([['left', 'b']])
  expect(comparison.commandKey).toBe('original-command')
})

it('preserves raw BOM/mixed-EOL history and exact four-state sampled timestamps in package helpers', () => {
  const text = '\ufefffirst\r\nsecond\rthird\n'
  const history = new OriginalEditHistory(text, 1)
  history.push(text + '中文', 2)
  expect(history.restore(1)).toBe(true)
  expect(history.current).toBe(text)
  expect(projectOriginal(text).modelText).toBe('first\nsecond\nthird\n')
  const frame = { switches: '0'.repeat(16), buttons: '00000', resetN: '1', leds: 'x'.repeat(16), anodes: 'z'.repeat(8), segments: 'x'.repeat(7), dp: 'z', simTimePs: '90071992547409930' }
  expect(hdlTracePositions([frame, { ...frame, simTimePs: '90071992547409931' }])).toEqual([0, 960])
  expect(hdlInputChange(frame, 'switches', 0, '1').switches).toBe('0'.repeat(15) + '1')
  const board = renderToStaticMarkup(<HdlBoardPane session={null} result={null} pending={false} disabled={false} inputs={frame} onInteract={vi.fn()} />)
  expect(board).toContain('不会显示默认零输出')
  const trace = renderToStaticMarkup(<HdlTracePane session={null} result={null} pending />)
  expect(trace).toContain('等候结果不代表零信号')
})
