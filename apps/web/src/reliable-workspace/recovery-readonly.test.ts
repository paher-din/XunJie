import { describe, expect, it, vi } from 'vitest'
import { ReliableWorkspace } from './index'
import { ReliableQuestionDraft } from './draft'

describe('isolated recovery state', () => {
  it('reads the owner snapshot without opening browser storage, starting sync, or accepting edits', async () => {
    const scope = JSON.stringify(['restored', crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()])
    const files = [{ objectId: crypto.randomUUID(), contentId: crypto.randomUUID(), name: 'notes.txt', kind: 'text' as const,
      encoding: 'utf8' as const, mediaType: 'text/plain', value: '原备份中的作品' }]
    const workSync = vi.fn(), draftSync = vi.fn(), dispatch = vi.fn()
    const workspace = new ReliableWorkspace(scope, {
      read: async () => ({ revision: 3, files }), receipt: async () => null, sync: workSync,
    }, undefined, true)
    const draft = new ReliableQuestionDraft(scope, {
      read: async () => ({ draftId: crypto.randomUUID(), revision: 2, revisionId: crypto.randomUUID(),
        question: '原问题草稿', references: [] }), receipt: async () => null, sync: draftSync,
    }, true)
    const actions = workspace.actions(draft, {
      list: async () => [], read: async () => null, prepare: dispatch, dispatch, cancel: dispatch,
      capabilities: async () => [],
    })
    try {
      // This node test has no window or IndexedDB. Any accidental local queue/scheduler use fails.
      await Promise.all([workspace.open(), draft.open()])
      await actions.open()
      workspace.resume(); draft.resume(); actions.resume()
      await Promise.all([workspace.leave(), draft.leave()])
      expect(workspace.snapshot().files).toEqual(files)
      expect(draft.snapshot().question).toBe('原问题草稿')
      expect(actions.snapshot().active).toBe(false)
      expect(() => workspace.change([])).toThrow('只读')
      expect(() => draft.change('不能改写', [])).toThrow('只读')
      await expect(actions.cancel(crypto.randomUUID())).rejects.toThrow('不能取消')
      expect(workSync).not.toHaveBeenCalled()
      expect(draftSync).not.toHaveBeenCalled()
      expect(dispatch).not.toHaveBeenCalled()
    } finally { actions.dispose(); workspace.dispose(); draft.dispose() }
  })
})
