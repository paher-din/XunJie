// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { expect, it, vi } from 'vitest'
import { ReliableWorkspace, type WorkspaceState } from '../reliable-workspace'
import { readWorkspaceIntro, saveWorkspaceIntro, workspaceIntroSteps } from './WorkspaceOnboarding'
import { workspaceSaveLabel } from './WorkspaceStatus'
import { executionSummary } from './workspace-status-presentation'
import type { ExecutionQuery } from '@xunjie/contracts/execution'

it('keeps first-use preferences isolated and allows replay to resume at welcome', () => {
  const a = 'intro-test:' + crypto.randomUUID(), b = a + ':other'
  expect(readWorkspaceIntro(a)).toBe('welcome')
  saveWorkspaceIntro(a, 'done'); expect(readWorkspaceIntro(a)).toBe('done')
  expect(readWorkspaceIntro(b)).toBe('welcome')
  saveWorkspaceIntro(a, 'welcome'); expect(readWorkspaceIntro(a)).toBe('welcome')
  localStorage.removeItem(a)
})
it('retains a dismissed preference when localStorage is unavailable', () => {
  const key = 'intro-fallback:' + crypto.randomUUID()
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw Error('blocked') })
  const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw Error('blocked') })
  try { saveWorkspaceIntro(key, 'done'); expect(readWorkspaceIntro(key)).toBe('done') }
  finally { read.mockRestore(); write.mockRestore() }
})
it('uses the latest in-memory preference if a write fails over an older saved value', () => {
  const key = 'intro-write-only:' + crypto.randomUUID()
  localStorage.setItem(key, 'welcome')
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw Error('quota') })
  try { saveWorkspaceIntro(key, 'done'); expect(readWorkspaceIntro(key)).toBe('done') }
  finally { write.mockRestore(); localStorage.removeItem(key) }
})
it('omits absent course tools and explains school submission only for school courses', () => {
  expect(workspaceIntroSteps(false, false).map(step => step.id)).toEqual(['goals', 'works', 'help', 'delivery'])
  expect(workspaceIntroSteps(true, true).map(step => step.id)).toContain('tools')
  expect(workspaceIntroSteps(false, false).at(-1)?.text).toContain('没有学校提交步骤')
  expect(workspaceIntroSteps(true, true).at(-1)?.text).toContain('不会自动提交')
})
it('never labels unprotected or unconfirmed work as a confirmed saved version', () => {
  const state: WorkspaceState = { ready: true, files: [], error: '', editorEpoch: 0, conflictReady: true,
    protection: { unprotected: true, pendingConfirmation: false, revision: 2 } }
  expect(workspaceSaveLabel(state, false)).toBe('正在保护作品修改')
  expect(workspaceSaveLabel({ ...state, protection: { unprotected: false, pendingConfirmation: true, revision: 2 } }, false)).toContain('版本待确认')
  expect(workspaceSaveLabel({ ...state, error: 'failed' }, false)).toContain('待核对')
  expect(workspaceSaveLabel(state, true)).toBe('作品只读')
})
it('publishes input protection immediately and after a real local write completes', async () => {
  const workspace = new ReliableWorkspace('intro-save:' + crypto.randomUUID(), {
    read: async () => ({ revision: 0, files: [] }), receipt: async () => null,
    sync: async input => ({ revision: input.baseRevision + 1, files: input.files }),
  })
  try {
    await workspace.open()
    workspace.create('notes.md', 'text')
    expect(workspace.snapshot().protection?.unprotected).toBe(true)
    await workspace.leave()
    expect(workspace.snapshot().protection?.unprotected).toBe(false)
    let complete!: () => void
    const input = new Promise<void>(resolve => { complete = resolve })
    workspace.trackInput(input)
    expect(workspace.snapshot().protection?.unprotected).toBe(true)
    complete(); await input; await Promise.resolve()
    expect(workspace.snapshot().protection?.unprotected).toBe(false)
  } finally { workspace.dispose() }
})
it('deduplicates runs and never calls an unknown last-known state running', () => {
  const running = { requestId: 'same', state: 'running', statusKnowledge: 'confirmed' } as ExecutionQuery
  expect(executionSummary([running, running], false, true)).toBe('运行中 1')
  expect(executionSummary([{ ...running, statusKnowledge: 'unknown' }], false, true)).toBe('运行状态待确认')
  expect(executionSummary([], false, true)).toBe('尚未运行课程工具')
})
