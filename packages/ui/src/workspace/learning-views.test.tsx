// @vitest-environment jsdom
import { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MaterialList, InitUnavailable, TextScopeRunCluster } from './TextScopePanes'
import { ExecutionNodeSelect } from './ExecutionNodeSelect'
import { SubmissionFeedbackPanel } from './SubmissionFeedbackPanel'
import { TutorMessageView } from './TutorMessageView'
import { TutoringPaneView, type TutoringPaneViewProps } from './TutoringPaneView'
import type { SubmissionFeedbackDisplay, SubmissionSnapshotDisplay } from './submissionPresentation'

let host: HTMLDivElement, root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals() })
function click(node: Element) { act(() => node.dispatchEvent(new MouseEvent('click', { bubbles: true }))) }
function choose(node: HTMLSelectElement, value: string) {
  act(() => { node.value = value; node.dispatchEvent(new Event('change', { bubbles: true })) })
}
function button(label: string) {
  const node = Array.from(host.querySelectorAll('button')).find(item => item.textContent === label)
  expect(node).toBeDefined(); return node!
}

it('shows exact material availability without inventing unreadable titles or reporting/render-time requests', () => {
  const out = renderToStaticMarkup(<MaterialList materials={[
    { index: 0, state: { kind: 'not-readable', reason: 'redacted' } },
    { index: 1, state: { kind: 'loaded', view: { title: '公开材料', text: '原文', paragraphs: ['one'] } } },
    { index: 2, state: { kind: 'failed' } },
  ]} />)
  expect(out).toContain('redacted'); expect(out).toContain('公开材料'); expect(out).toContain('共 1 段')
  expect(out).toContain('读取失败'); expect(out).not.toContain('undefined')
  const mode = { preparation: false, courseLabel: '课程', prepNotice: '合成标识' }
  expect(renderToStaticMarkup(<InitUnavailable mode={mode} init={{ kind: 'stale' }} onReload={vi.fn()} />)).toBe('')
  expect(renderToStaticMarkup(<TextScopeRunCluster init={null} mode={mode} />)).toContain('初始化读取中')
})

it('execution selection remains caller-owned and does not make an unready computer ready', () => {
  const onSelect = vi.fn(), onRefresh = vi.fn()
  const props = { state: { status: 'ready' as const, selectedNodeId: 'n1', notice: null,
    nodes: [{ nodeId: 'n1', label: '电脑一', cReady: false, hdlReady: true }, { nodeId: 'n2', label: '电脑二', cReady: true, hdlReady: false }] },
    identityCurrent: true, kind: 'c' as const, busy: false, onSelect, onRefresh }
  act(() => root.render(<ExecutionNodeSelect {...props} />))
  click(host.querySelector('button')!)
  const panel = document.body.querySelector('.ws-control-popover')!
  expect(panel.textContent).toContain('执行电脑未就绪；仍可编辑和保存')
  choose(panel.querySelector('select')!, 'n2')
  expect(onSelect.mock.calls).toEqual([['n2']])
  expect(props.state.selectedNodeId).toBe('n1')
  click(Array.from(panel.querySelectorAll('button')).find(item => item.textContent === '刷新')!)
  expect(onRefresh).toHaveBeenCalledOnce()
  act(() => root.render(<ExecutionNodeSelect {...props} identityCurrent={false} />))
  expect(host.textContent).toBe('')
})

it('submits only the explicitly selected snapshot and its matching check; an identity change clears the selection', () => {
  const snapshot = (id: string): SubmissionSnapshotDisplay => ({ snapshotId: id, workspaceRevision: 2, hash: id,
    createdAt: '2026-10-10T00:00:00Z', files: [{ fileId: 'f', path: 'main.c', documentVersion: 1 }] })
  const state: SubmissionFeedbackDisplay = { phase: 'ready', pending: null, assignment: { active: true }, notice: null, feedbackNotice: null, feedback: null,
    recovery: { attempt: { status: 'active', attemptRevision: 3 }, reopen: { actionable: false, state: 'none' }, submissions: [],
      runs: [{ runId: 'matching', mode: 'check', snapshotId: 'b', outcome: 'failed' }, { runId: 'other', mode: 'check', snapshotId: 'a', outcome: 'passed' }] } }
  const onSubmit = vi.fn()
  const props = { state, snapshots: [snapshot('a'), snapshot('b')], unconfirmedCount: 1, resetKey: 1,
    onReturn: vi.fn(), onRefresh: vi.fn(), onReconcile: vi.fn(), onResume: vi.fn(), onSubmit }
  act(() => root.render(<SubmissionFeedbackPanel {...props} />))
  choose(host.querySelector('select')!, 'b')
  expect(host.textContent).toContain('不会包含在这次提交中')
  expect(host.querySelector('fieldset')?.textContent).toContain('matching')
  expect(host.querySelector('fieldset')?.textContent).not.toContain('other')
  click(host.querySelector('input[type="checkbox"]')!)
  click(button('提交所选作品'))
  expect(onSubmit).not.toHaveBeenCalled()
  click(button('确认提交所选快照'))
  expect(onSubmit.mock.calls).toEqual([['b', '', ['matching']]])
  act(() => root.render(<SubmissionFeedbackPanel {...props} resetKey={2} />))
  expect(host.querySelector('select')?.value).toBe('')
  expect(button('提交所选作品').disabled).toBe(true)
})

it('formal message DOM has the same direct body selector and emits acknowledgements only on explicit clicks', () => {
  const onAcknowledge = vi.fn()
  const message = { valid: true, shown: true, facts: {}, payload: { actionId: 'original-action', content: '获准正文', basisRevised: false } }
  act(() => root.render(<TutorMessageView message={message} preparation={false} onAcknowledge={onAcknowledge} />))
  expect(host.querySelector('[data-testid="tutor-message"]')?.querySelector(':scope > .chat-message.agent > .turn-body')?.textContent).toBe('获准正文')
  expect(onAcknowledge).not.toHaveBeenCalled()
  click(button('我先试试'))
  expect(onAcknowledge).toHaveBeenCalledOnce()
  expect(message.facts).toEqual({})
})

it('conversation keeps IME Enter and replacement sends distinct without issuing requests during render', () => {
  const onSend = vi.fn()
  const props: TutoringPaneViewProps = { preparation: true, expanded: false, atBottom: true, hasMessages: false,
    scrollerRef: createRef(), onScroll: vi.fn(), exchanges: [], renderMessage: () => null,
    running: false, waitExceeded: false, pending: false, busy: false, canStop: false, canReadHistory: false,
    notice: null, unavailable: null, draft: '问题', canSend: true,
    onToggleExpanded: vi.fn(), onClose: vi.fn(), onJumpLatest: vi.fn(), onReadHistory: vi.fn(), onRetry: vi.fn(), onRead: vi.fn(),
    onStop: vi.fn(), onDraft: vi.fn(), onSend }
  act(() => root.render(<TutoringPaneView {...props} />))
  const input = host.querySelector('textarea')!
  act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true })))
  act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true })))
  expect(onSend).not.toHaveBeenCalled()
  act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  expect(onSend.mock.calls).toEqual([[false]])
  act(() => root.render(<TutoringPaneView {...props} running />))
  click(host.querySelector('[aria-label="替换并发送"]')!)
  expect(onSend.mock.calls).toEqual([[false], [true]])
  expect(host.textContent).toContain('合成准备场景 · 不调用模型')
})
