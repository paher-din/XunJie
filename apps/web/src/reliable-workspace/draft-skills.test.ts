// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { actionInputSchema } from '@xunjie/contracts/action-intents'
import { questionDraftSyncSchema, questionDraftViewSchema, type QuestionDraftSync, type QuestionDraftView } from '@xunjie/contracts/question-drafts'
import { ReliableQuestionDraft } from './draft'
import { DraftStore, initialDraftRecord, sameDraftContent } from './draft-store'
import { ReliableActions } from './actions'

const disposals: (() => void)[] = []
beforeEach(() => { vi.stubGlobal('crypto', webcrypto); vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }) })
afterEach(() => { disposals.splice(0).forEach(dispose => dispose()); vi.useRealTimers(); vi.unstubAllGlobals() })
const pin = () => ({ skillId: crypto.randomUUID(), version: 1 })
async function fixture() {
  const key = JSON.stringify(['skills-test', crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()])
  const store = new DraftStore()
  let remote: QuestionDraftView = { draftId: crypto.randomUUID(), revision: 0, revisionId: null, question: '', references: [] }
  await store.change(key, () => initialDraftRecord(key, remote.draftId))
  const sync = vi.fn(async (input: QuestionDraftSync) => (remote = { ...remote, revision: input.baseRevision + 1,
    revisionId: crypto.randomUUID(), question: input.question, references: [], ...(input.skills === undefined ? {} : { skills: input.skills }) }))
  const transport = { read: async () => remote, receipt: async () => null, sync }
  const open = async () => {
    const draft = new ReliableQuestionDraft(key, transport); draft.suspend(); await draft.open(); disposals.push(() => draft.dispose()); return draft
  }
  return { key, store, open, sync, draft: await open() }
}

it('keeps legacy JSON unchanged and rejects invalid or duplicate version pins', () => {
  const old = { requestId: crypto.randomUUID(), draftId: crypto.randomUUID(), baseRevision: 0, question: '原问题', references: [], bases: [] }
  expect(JSON.stringify(questionDraftSyncSchema.parse(old))).toBe(JSON.stringify(old))
  const skill = pin()
  expect(questionDraftSyncSchema.safeParse({ ...old, skills: [{ ...skill, version: 0 }] }).success).toBe(false)
  expect(questionDraftSyncSchema.safeParse({ ...old, skills: [skill, skill] }).success).toBe(false)
  expect(questionDraftViewSchema.parse({ draftId: old.draftId, revision: 0, revisionId: null, question: '', references: [] })).not.toHaveProperty('skills')
})

it('restores selected versions from IndexedDB, preserves them through typing, and fixes the original action bytes', async () => {
  const env = await fixture(), skill = pin()
  env.draft.change('原问题', [], [], [skill]); await env.draft.leave(); env.draft.dispose()
  const restored = await env.open()
  expect(restored.snapshot().skills).toEqual([skill])
  restored.change('继续编辑原问题', [])
  const actions = new ReliableActions(env.key, restored, () => [], {
    prepare: vi.fn(), read: async () => null, list: async () => [], dispatch: vi.fn(), cancel: vi.fn(), capabilities: async () => [],
  }, { denied: () => false, confirmed() {} })
  actions.suspend(); disposals.push(() => actions.dispose())
  await actions.create({ requestId: crypto.randomUUID(), receiver: { receiverId: 'original', location: 'remote', kind: 'question' } })
  const original = actions.snapshot().items[0].input
  const fixed = actionInputSchema.parse(original)
  expect(fixed.draft.skills).toEqual([skill])
  restored.change('下一次问题', [], [], [{ ...skill, version: 2 }]); await restored.leave()
  expect(actionInputSchema.parse(actions.snapshot().items[0].input)).toEqual(fixed)
  expect(restored.acknowledge(fixed.draft.token)).toBe(false)
  expect(restored.snapshot().skills).toEqual([{ ...skill, version: 2 }])
})

it('keeps the first pending version fixed while a later selection changes and synchronizes both in order', async () => {
  const env = await fixture(), skill = pin()
  env.draft.change('同一问题', [], [], [skill]); await env.draft.leave()
  const first = (await env.store.read(env.key))!.pending!
  env.draft.change('同一问题', [], [], [{ ...skill, version: 2 }]); await env.draft.leave()
  expect((await env.store.read(env.key))!.pending).toEqual(first)
  env.draft.resume()
  await vi.waitFor(() => expect(env.sync).toHaveBeenCalledWith(first))
  await vi.waitFor(async () => expect((await env.store.read(env.key))!.pending?.skills).toEqual([{ ...skill, version: 2 }]))
  await vi.advanceTimersByTimeAsync(1000)
  await vi.waitFor(async () => expect((await env.store.read(env.key))!.pending).toBeNull())
  expect(env.sync.mock.calls.map(([input]) => input.skills)).toEqual([[skill], [{ ...skill, version: 2 }]])
})

it('treats skill-only edits as conflicts and retains the chosen side on reload', async () => {
  const env = await fixture(), skill = pin()
  env.draft.change('共同问题', []); await env.draft.leave()
  const other = await env.open()
  env.draft.change('共同问题', [], [], [skill]); await env.draft.leave()
  other.change('共同问题', [], [], [{ ...skill, version: 2 }])
  await expect(other.leave()).rejects.toThrow('另一标签页')
  await other.leave()
  expect(other.snapshot().conflict).toBeDefined()
  const conflict = other.snapshot().conflict!
  expect(sameDraftContent(conflict.local, conflict.other)).toBe(false)
  await other.resolve(conflict.local.question, conflict.local.references, conflict.local.bases, conflict.local.skills)
  expect(other.snapshot().skills).toEqual([{ ...skill, version: 2 }])
  other.dispose(); expect((await env.open()).snapshot().skills).toEqual([{ ...skill, version: 2 }])
})

it('distinguishes an explicit empty selection from scope defaults and restores omission after acknowledgement', async () => {
  const env = await fixture()
  env.draft.change('原问题', [])
  env.draft.selectSkills([])
  expect(env.draft.capture().skills).toEqual([])
  await env.draft.leave()
  expect((await env.open()).capture().skills).toEqual([])
  env.draft.selectSkills()
  expect(env.draft.capture()).not.toHaveProperty('skills')
  env.draft.selectSkills([pin()])
  expect(env.draft.acknowledge(env.draft.capture().token)).toBe(true)
  expect(env.draft.capture()).not.toHaveProperty('skills')
})
