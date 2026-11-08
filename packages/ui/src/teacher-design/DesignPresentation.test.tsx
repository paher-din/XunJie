import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { act, createElement, createRef, useState } from 'react'
import type { Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  DesignValue, DesignLinkedChoices, PreviewDesignDialogs, LiveDesignDialogs, PreviewDesignSupport, DesignAgentView,
  type PreviewDesignDialogsProps, type LiveDesignDialogsProps, type DesignAgentViewProps,
} from './index'

const { JSDOM } = createRequire(import.meta.url)('jsdom')
let dom: ReturnType<typeof JSDOM>, root: Root
let createRoot: typeof import('react-dom/client').createRoot
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)) }
const draw = async (element: React.ReactNode) => { await act(async () => { root.render(element); await settle() }) }
const draft: PreviewDesignDialogsProps['draft'] = { id: 'd', courseId: 'c', title: '合成项目', problem: '问题', audience: '', deliverable: '',
  choices: '', foundation: '', duration: '', goals: [], milestones: [], rubric: [], helpPolicy: '', resourceIds: [], revision: 2, savedAt: 'saved' }

beforeAll(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://design.invalid', pretendToBeVisual: true })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLDialogElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent'])
    vi.stubGlobal(name, dom.window[name])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  ;({ createRoot } = await import('react-dom/client'))
})
beforeEach(() => { const host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = '' })
afterAll(() => { dom.window.close(); vi.unstubAllGlobals() })

it('renders nested proposal values with labels, unknown keys and empty-value semantics', () => {
  const html = renderToStaticMarkup(createElement(DesignValue, { value: { projectTitle: '标题', goals: [{ title: '目标' }], custom: null, routes: [] } }))
  expect(html).toContain('<dt>项目标题</dt><dd><span>标题</span>')
  expect(html).toContain('<dt>custom</dt><dd><span class="td-hint">无</span>')
  expect(html).toContain('<ul><li><dl>')
})

it('removes an invalid association without dropping the remaining selected reference', async () => {
  const onChange = vi.fn()
  await draw(createElement(DesignLinkedChoices, { title: '关联目标', options: [{ id: 'known', title: '目标' }], value: ['known', 'missing'], onChange }))
  const invalid = document.querySelector<HTMLInputElement>('.tld-invalid-link input')!
  await act(async () => invalid.click())
  expect(onChange).toHaveBeenCalledWith(['known'])
  expect(document.querySelector('.tld-links legend')?.textContent).toBe('关联目标')
})

it('retains native preview dialog cancellation and backdrop behavior', async () => {
  const setModal = vi.fn(), onRelease = vi.fn()
  const props: PreviewDesignDialogsProps = {
    dialog: createRef(), modal: 'assign', setModal, suggestion: null, draft, conflicts: false, preview: true,
    adoptSuggestion: vi.fn(), role: 'student', setRole: vi.fn(), revisionLabel: 'v2', dirty: false,
    course: { title: '课程' }, visibleResources: [], acknowledged: false, setAcknowledged: vi.fn(), ready: true,
    blocks: [], setAssistantTab: vi.fn(), learners: [{ id: 's', name: '学生' }], students: [], setStudents: vi.fn(),
    releaseDisabled: true, onConfirmPreview: vi.fn(), onRelease,
  }
  await draw(createElement(PreviewDesignDialogs, props))
  const dialog = document.querySelector('dialog')!
  expect(dialog).toBe(props.dialog.current)
  await act(async () => dialog.querySelector('strong')!.click())
  expect(setModal).not.toHaveBeenCalled()
  await act(async () => dialog.click())
  expect(setModal).toHaveBeenCalledWith(null)
  setModal.mockClear()
  await act(async () => dialog.dispatchEvent(new Event('cancel', { cancelable: true })))
  expect(setModal).toHaveBeenCalledWith(null)
  await act(async () => document.querySelector<HTMLButtonElement>('.td-dialog-footer .td-btn-primary')!.click())
  expect(onRelease).not.toHaveBeenCalled()
  expect(dialog.textContent).toContain('合成学生')
})

it('blocks native cancellation and member changes while a real assignment is busy', async () => {
  const setModal = vi.fn(), setStudents = vi.fn(), onAssign = vi.fn()
  const props: LiveDesignDialogsProps = {
    dialog: createRef(), modal: 'assign', setModal, busy: '正在分配…', error: '', currentPreview: undefined,
    role: 'student', onRoleSelect: vi.fn(), course: { title: '课程' }, courseId: 'c', policy: undefined,
    acknowledged: false, setAcknowledged: vi.fn(), visitedRoles: [], version: 'v2',
    released: { activityVersionId: 'a', sourceRevision: 2, title: '固定项目' }, members: [{ userId: 's', displayName: '学生' }],
    students: [], setStudents, assignments: [], locked: true, ready: true, onRelease: vi.fn(), onAssign,
  }
  await draw(createElement(LiveDesignDialogs, props))
  const cancel = new Event('cancel', { cancelable: true })
  await act(async () => document.querySelector('dialog')!.dispatchEvent(cancel))
  expect(cancel.defaultPrevented).toBe(true); expect(setModal).not.toHaveBeenCalled()
  await act(async () => document.querySelector<HTMLInputElement>('.td-learner-option input')!.click())
  expect(setStudents).not.toHaveBeenCalled()
  expect(document.querySelector<HTMLButtonElement>('.td-dialog-footer .td-btn-primary')?.disabled).toBe(true)
  expect(document.querySelector('dialog')?.textContent).toContain('课程学生')
})

it('keeps the support tabs controlled and moves keyboard focus with arrow keys', async () => {
  function Harness() {
    const [assistantTab, setAssistantTab] = useState<'assistant' | 'checks'>('assistant')
    return createElement(PreviewDesignSupport, { preview: true, assistantTab, setAssistantTab, blocks: [], questions: [],
      setSection: vi.fn(), prompt: '', setPrompt: vi.fn(), suggestion: null, conflicts: false, ready: true,
      setModal: vi.fn(), showSuggestion: vi.fn(), openPreview: vi.fn() })
  }
  await draw(createElement(Harness))
  const assistant = document.getElementById('td-assistant-tab')!
  await act(async () => assistant.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
  expect(document.activeElement?.id).toBe('td-checks-tab')
  expect(document.getElementById('td-checks-tab')?.getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector('[role="tabpanel"]')?.id).toBe('td-checks-panel')
})

it('keeps stale proposals visible while preventing adoption and limiting reference selection', async () => {
  const onAdopt = vi.fn(), setCandidate = vi.fn()
  const props: DesignAgentViewProps<'problem'> = {
    hasDraft: true, dirty: false, blocked: false, active: false, disabled: false, busy: false,
    mode: 'patch', setMode: vi.fn(), request: '请求', setRequest: vi.fn(), fields: ['problem'], setFields: vi.fn(), availableFields: ['problem'],
    selected: Array.from({ length: 64 }, (_, i) => 'p' + i), setSelected: vi.fn(), samples: [], setSamples: vi.fn(),
    paragraphs: [{ paragraphId: 'extra', title: '材料', ordinal: 0, private: false, text: '段落' }], error: '', canRecover: false,
    run: { jobId: 'j' }, job: { status: 'succeeded' }, restoreId: '', setRestoreId: vi.fn(),
    proposal: { baseRevision: 2, body: { kind: 'candidates', candidates: [{ projectTitle: '候选' }] }, rationale: '', affectedReferences: [], diff: [] },
    candidate: undefined, setCandidate, stale: true, canAdopt: false,
    onGenerate: vi.fn(), onCancel: vi.fn(), onAdopt, onReload: vi.fn(), onRestore: vi.fn(),
  }
  await draw(createElement(DesignAgentView<'problem'>, props))
  expect(document.querySelector<HTMLInputElement>('.tda-references input')?.disabled).toBe(true)
  await act(async () => document.querySelector<HTMLInputElement>('[name="design-candidate"]')!.click())
  expect(setCandidate).toHaveBeenCalledWith(0)
  await act(async () => document.querySelector<HTMLButtonElement>('.tda-proposal .td-btn-primary')!.click())
  expect(onAdopt).not.toHaveBeenCalled()
  expect(document.querySelector('.tda-proposal')?.textContent).toContain('候选已过时')
})
