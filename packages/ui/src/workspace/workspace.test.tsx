// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskInfo, TaskProgress, FileTabs, ConfirmationCluster, WorkspacePopover,
  RunPanel, RunHistoryPanel, SideDock, type CoreSelection, type HistoryRunDisplay } from './index'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

function render(node: ReactNode) { act(() => root.render(node)) }
function click(element: Element | null) {
  expect(element).not.toBeNull()
  act(() => element!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}
function key(element: Element, value: string, shiftKey = false) {
  act(() => element.dispatchEvent(new KeyboardEvent('keydown', { key: value, shiftKey, bubbles: true })))
}
function button(text: string, scope: ParentNode = container) {
  const result = Array.from(scope.querySelectorAll('button')).find(node => node.textContent === text)
  expect(result).toBeDefined()
  return result!
}

describe('standalone workspace contracts', () => {
  it('keeps task presentation caller-owned and gradient references unique', () => {
    render(<><TaskProgress percent={25} done={false} status="进行中" title="阶段" ariaLabel="任务进度 25%" />
      <TaskProgress percent={100} done status="已完成" title="完成" ariaLabel="任务进度 100%" />
      <TaskInfo name="任务" status={<span>已分配</span>} goal="目标" percent={0} done={false}
        currentProgress="尚未开始" stage="0 / 4" deadline="无" course="课程" /></>)
    const ids = Array.from(container.querySelectorAll('linearGradient')).map(node => node.id)
    expect(new Set(ids).size).toBe(4)
    for (const arc of container.querySelectorAll('.ws-taskprogress-arc')) {
      expect(ids).toContain(arc.getAttribute('stroke')!.slice(5, -1))
    }
    expect(container.querySelector('.ws-demo-flag')).toBeNull()
    expect(container.querySelector('.ws-taskinfo')?.textContent).not.toContain('演示')
  })

  it('reports file open and close independently without mutating caller data', () => {
    const files = [{ id: 'a', name: 'main.c' }, { id: 'b', name: 'notes.md' }]
    const onOpen = vi.fn(), onClose = vi.fn()
    render(<FileTabs files={files} activeId="a" onOpen={onOpen} onClose={onClose} tabRoles />)
    click(container.querySelector('[title="notes.md"]'))
    click(container.querySelector('[aria-label="关闭 main.c 的标签"]'))
    expect(onOpen.mock.calls).toEqual([['b']])
    expect(onClose.mock.calls).toEqual([['a']])
    expect(files).toHaveLength(2)
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(2)
  })

  it('keeps an unknown confirmation on the original retry callback with save disabled', () => {
    const onSave = vi.fn(), onRetry = vi.fn()
    render(<ConfirmationCluster phase="unknown" hasAttempt unconfirmedCount={1} workspaceRevision={2}
      canSave canSnapshot onOpen={vi.fn()} onSave={onSave} onSnapshot={vi.fn()} onRetry={onRetry} onReload={vi.fn()} />)
    expect(button('确认保存').disabled).toBe(true)
    click(button('重试上次保存'))
    expect(onRetry).toHaveBeenCalledOnce()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('opens in a body portal, focuses a control and returns focus on Escape and Shift+Tab', () => {
    render(<WorkspacePopover label="版本"><button>读取</button></WorkspacePopover>)
    const trigger = button('版本')
    click(trigger)
    const panel = document.body.querySelector('.ws-control-popover')!
    expect(container.contains(panel)).toBe(false)
    const read = button('读取', panel)
    expect(document.activeElement).toBe(read)
    key(read, 'Escape')
    expect(document.body.querySelector('.ws-control-popover')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    click(trigger)
    key(button('读取', document.body), 'Tab', true)
    expect(document.body.querySelector('.ws-control-popover')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('closes a popover after an action and when focus leaves it', () => {
    const onRead = vi.fn()
    render(<><WorkspacePopover label="版本" closeOnAction><button onClick={onRead}>读取</button></WorkspacePopover><button>其他</button></>)
    click(button('版本'))
    click(button('读取', document.body))
    expect(onRead).toHaveBeenCalledOnce()
    expect(document.body.querySelector('.ws-control-popover')).toBeNull()
    expect(document.activeElement).toBe(button('版本'))
    click(button('版本'))
    act(() => button('其他').focus())
    expect(document.body.querySelector('.ws-control-popover')).toBeNull()
  })

  it('chooses native select boundaries without changing the controlled selection', () => {
    const selection: CoreSelection = { snapshotId: 'one', entryFileId: 'a', fileIds: ['a'], operation: 'stats', word: '', count: '10' }
    const onSelect = vi.fn()
    render(<RunPanel snapshots={[{ id: 'one', label: '一', files: [] }, { id: 'two', label: '二', files: [] }]}
      selection={selection} result={null} busy={false} canRun notice={null} synthetic={false}
      onSelect={onSelect} onRun={vi.fn()} onRead={vi.fn()} onReturn={vi.fn()} />)
    key(container.querySelector('[aria-label="确认快照"]')!, 'End')
    expect(onSelect.mock.calls).toEqual([[{ ...selection, snapshotId: 'two', entryFileId: '', fileIds: [] }]])
    expect(selection.snapshotId).toBe('one')
  })

  it('passes only the visible history identity to help and gates stale results', () => {
    const result: HistoryRunDisplay = { runId: 'run-one', jobId: 'job', snapshotId: 'snapshot', snapshotHash: 'hash',
      profile: 'profile', image: 'image', mode: 'run', statusLabel: '完成', parameters: null, diagnostics: null,
      files: { status: 'available', files: [{ id: 'file', name: 'output.txt', status: 'complete', text: '' }] }, filesNotice: null }
    const onHelp = vi.fn(), onDownload = vi.fn()
    const props = { options: [{ id: result.runId, label: '一次运行' }], busy: false, notice: null, synthetic: false,
      onSelect: vi.fn(), onRead: vi.fn(), onReturn: vi.fn(), onHelp, onDownload }
    render(<RunHistoryPanel {...props} sides={[{ runId: result.runId, busy: false, notice: null, result }, { runId: '', busy: false, notice: null, result: null }]} />)
    click(button('就这次运行求助'))
    click(container.querySelector('[aria-label="下载 output.txt"]'))
    expect(onHelp.mock.calls).toEqual([[{ runId: 'run-one', snapshotId: 'snapshot' }]])
    expect(onDownload.mock.calls).toEqual([[0, 'file']])
    render(<RunHistoryPanel {...props} sides={[{ runId: 'different-run', busy: false, notice: null, result }, { runId: '', busy: false, notice: null, result: null }]} />)
    expect(button('就这次运行求助').disabled).toBe(true)
  })

  it('preserves reduced-motion dock task, stash, open and pin interactions', () => {
    const onPin = vi.fn(), onOpen = vi.fn(), onToast = vi.fn()
    const props = { taskInfo: <p>原任务信息</p>, stash: [{ key: 'card', title: '生成卡', gen: { claimSim: true, version: 2 } }], onPin, onOpen, onToast }
    render(<SideDock {...props} />)
    click(container.querySelector('[aria-label="任务信息"]'))
    expect(container.querySelector('.ws-popcard')?.textContent).toContain('原任务信息')
    key(document.body, 'Escape')
    expect(container.querySelector('.ws-popcard')).toBeNull()
    click(container.querySelector('[aria-label="卡片收纳"]'))
    click(button('打开'))
    click(button('钉住'))
    expect(onOpen.mock.calls).toEqual([['card']])
    expect(onPin.mock.calls).toEqual([['card']])
    render(<SideDock {...props} stash={[]} />)
    expect(container.querySelector('.ws-popstash')).toBeNull()
    click(container.querySelector('[aria-label="卡片收纳"]'))
    expect(onToast).toHaveBeenCalledOnce()
  })
})
