// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import type { QuestionDraftSync } from '@xunjie/contracts/question-drafts'
import { NETWORK_DRAFT_MAX_WAIT_MS, ReliableQuestionDraft } from './draft'
import { DraftStore } from './draft-store'

function fixture(code: 'unavailable' | 'invalid') {
  const key = crypto.randomUUID(), draftId = crypto.randomUUID(), store = new DraftStore()
  let parentReceived = false
  const sync = vi.fn(async (input: QuestionDraftSync) => {
    if (!parentReceived) throw Object.assign(new Error('Parent reflection has not arrived'), { code })
    return { draftId: input.draftId, revision: input.baseRevision + 1, revisionId: crypto.randomUUID(),
      question: input.question, references: [] }
  })
  const draft = new ReliableQuestionDraft(key, { read: async () => ({ draftId, revision: 0, revisionId: null,
    question: '', references: [] }), receipt: async () => null, sync })
  return { draft, sync, stored: () => store.read(key), receiveParent: () => { parentReceived = true } }
}

describe('question draft source retry', () => {
  it('keeps an unavailable source pending and retries the original request when it arrives', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const env = fixture('unavailable')
    try {
      await env.draft.open()
      env.draft.change('解释修订仍等待父来源。', [])
      await env.draft.leave()
      const original = (await env.stored())!.pending
      await vi.advanceTimersByTimeAsync(NETWORK_DRAFT_MAX_WAIT_MS)
      await vi.waitFor(() => expect(env.sync).toHaveBeenCalledWith(original))
      expect((await env.stored())!.pendingRejected).not.toBe(true)
      expect((await env.stored())!.pending).toEqual(original)
      env.receiveParent()
      await vi.advanceTimersByTimeAsync(NETWORK_DRAFT_MAX_WAIT_MS)
      await vi.waitFor(async () => expect((await env.stored())!.pending).toBeNull())
      expect(env.sync.mock.calls.every(([input]) => input.requestId === original!.requestId)).toBe(true)
      expect(env.draft.snapshot().revision).toBe(1)
      expect(env.draft.snapshot().question).toBe('解释修订仍等待父来源。')
    } finally { env.draft.dispose(); vi.useRealTimers() }
  })

  it('keeps a genuinely invalid request rejected until its content is corrected', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const env = fixture('invalid')
    try {
      await env.draft.open()
      env.draft.change('服务已明确拒绝这份内容。', [])
      await env.draft.leave()
      await vi.advanceTimersByTimeAsync(NETWORK_DRAFT_MAX_WAIT_MS)
      await vi.waitFor(async () => expect((await env.stored())!.pendingRejected).toBe(true))
      const rejected = await env.stored()
      env.receiveParent()
      await vi.advanceTimersByTimeAsync(3 * NETWORK_DRAFT_MAX_WAIT_MS)
      expect(await env.stored()).toEqual(rejected)
      expect(env.draft.snapshot().revision).toBe(0)
      expect(env.draft.snapshot().question).toBe('服务已明确拒绝这份内容。')
    } finally { env.draft.dispose(); vi.useRealTimers() }
  })
})
