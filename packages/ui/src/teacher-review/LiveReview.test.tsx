import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { act, createRef, useState } from 'react'
import type { Root } from 'react-dom/client'
import { LiveEvidenceChoices, LiveFeedbackPanel, LiveReviewRoster, LiveRevisionPanel, liveEvidenceKey } from './LiveReview'
import { MaterialDocumentDialog } from './Materials'
import type { LiveEvidenceRef, LiveReviewDisplayContext } from './LiveReview'

const { JSDOM } = createRequire(import.meta.url)('jsdom')
let dom: ReturnType<typeof JSDOM>, root: Root
let createRoot: typeof import('react-dom/client').createRoot

beforeAll(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://ui.invalid', pretendToBeVisual: true })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'Node', 'Event', 'MouseEvent'])
    vi.stubGlobal(name, dom.window[name])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  ;({ createRoot } = await import('react-dom/client'))
})
beforeEach(() => { const host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = '' })
afterAll(() => { dom.window.close(); vi.unstubAllGlobals() })

const ref: LiveEvidenceRef = { kind: 'snapshot', id: 'snapshot-a', attemptId: 'attempt-a' }
const context: LiveReviewDisplayContext = {
  attempt: { attemptId: 'attempt-a', attemptRevision: 2, status: 'reviewed' },
  submission: { submissionId: 'submission-a', snapshotId: 'snapshot-a', workspaceRevision: 1, submittedAt: '' },
  submissions: [], artifact: [], runs: [], competencies: { domain: [], project: [], ai_collaboration: [] },
  learnerStateRevision: 1, help: { messages: [], actions: [] }, coverage: { intervals: [] },
  decisions: [], feedback: { entries: [] }, disputes: [], reopen: { state: 'none', actionable: false },
}

it('keeps evidence identity stable and sends the selected original reference key', async () => {
  expect(liveEvidenceKey(ref)).toBe(liveEvidenceKey({ attemptId: 'attempt-a', id: 'snapshot-a', kind: 'snapshot' }))
  expect(liveEvidenceKey(ref)).not.toBe(liveEvidenceKey({ ...ref, attemptId: 'attempt-b' }))
  const changed = vi.fn()
  function Fixture({ canWrite }: { canWrite: boolean }) {
    const [values, setValues] = useState<string[]>([])
    return <LiveEvidenceChoices values={values} availableRefs={[{ ref, label: '固定作品' }]} canWrite={canWrite}
      onChange={next => { setValues(next); changed(next) }} />
  }
  await act(async () => root.render(<Fixture canWrite={false} />))
  const checkbox = document.querySelector('input')!
  expect(checkbox.matches(':disabled')).toBe(true)
  await act(async () => checkbox.click())
  expect(changed).not.toHaveBeenCalled()
  await act(async () => root.render(<Fixture canWrite />))
  await act(async () => checkbox.click())
  expect(changed).toHaveBeenLastCalledWith([liveEvidenceKey(ref)])
  expect(checkbox.checked).toBe(true)
  await act(async () => checkbox.click())
  expect(changed).toHaveBeenLastCalledWith([])
})

it('keeps historical submissions read-only for formal review and revision', async () => {
  const save = vi.fn(), reopen = vi.fn()
  const noop = () => {}
  await act(async () => root.render(<>
    <LiveFeedbackPanel context={context} canWrite selectedLatest={false} busy={false}
      feedbackId="" feedbackKind="submission_review" summary="" reason="" evidence={[]} availableRefs={[]}
      onFeedbackSelect={noop} setFeedbackKind={noop} setSummary={noop} setReason={noop} setEvidence={noop} onSave={save} />
    <LiveRevisionPanel context={context} canWrite selectedLatest={false} reopenReason="" setReopenReason={noop} onAllowRevision={reopen} />
  </>))
  const buttons = [...document.querySelectorAll('button')]
  const saveButton = buttons.find(button => button.textContent === '保存教师反馈')!
  const reopenButton = buttons.find(button => button.textContent === '允许修订本次提交')!
  expect(saveButton.disabled).toBe(true)
  expect(reopenButton.disabled).toBe(true)
  expect(document.querySelector<HTMLOptionElement>('option[value="submission_review"]')?.disabled).toBe(true)
  await act(async () => { saveButton.click(); reopenButton.click() })
  expect(save).not.toHaveBeenCalled()
  expect(reopen).not.toHaveBeenCalled()
})

it('associates repeated roster and document instances with their own headings', async () => {
  const material = { id: 'm', courseId: 'c', title: '材料', kind: 'learning' as const, content: '正文', source: '课程',
    student: false, tutor: false, teacherDesign: false, version: 1 }
  const props = { opened: material, preview: true, courses: [{ id: 'c', title: '课程' }], onClosed: () => {} }
  await act(async () => root.render(<>
    <LiveReviewRoster courseMembers={[]} loading={false} /><LiveReviewRoster courseMembers={[]} loading={false} />
    <MaterialDocumentDialog {...props} contentDialog={createRef<HTMLDialogElement>()} />
    <MaterialDocumentDialog {...props} contentDialog={createRef<HTMLDialogElement>()} />
  </>))
  const labels = [...document.querySelectorAll<HTMLElement>('[aria-labelledby]')].map(element => element.getAttribute('aria-labelledby')!)
  expect(labels).toHaveLength(4)
  expect(new Set(labels).size).toBe(4)
  for (const id of labels) expect(document.getElementById(id)).not.toBeNull()
})
