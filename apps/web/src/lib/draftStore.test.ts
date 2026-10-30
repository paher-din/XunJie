import { describe, expect, it } from 'vitest'
import {
  clientFileKey,
  decideSave,
  memoryDraftRepository,
  scopeKey,
  type DraftScope,
} from './draftStore'

const scope: DraftScope = { mode: 'demo', account: 'local', attemptKey: 'task:wordfreq' }

describe('draftRevision 事务 CAS', () => {
  it('新记录只能以 null 期望写入，修订从 1 起', () => {
    expect(decideSave(null, null)).toEqual({ ok: true, draftRevision: 1 })
    expect(decideSave(null, 1)).toEqual({ ok: false, reason: 'conflict' })
  })

  it('已有记录只接受当前修订的写入', () => {
    expect(decideSave(3, 3)).toEqual({ ok: true, draftRevision: 4 })
    expect(decideSave(3, 2)).toEqual({ ok: false, reason: 'conflict' })
    expect(decideSave(3, null)).toEqual({ ok: false, reason: 'conflict' })
  })

  it('存储层拒绝旧修订写入，败方正文进冲突候选', async () => {
    const repo = memoryDraftRepository()
    const key = clientFileKey(scope, 'f1')
    const first = await repo.saveDraft({ clientFileKey: key, fileId: 'f1', text: 'v1', draftRevision: 1, updatedAt: 1 }, null)
    expect(first).toEqual({ ok: true, draftRevision: 1 })

    // 另一处写入先落地
    const newer = await repo.saveDraft({ clientFileKey: key, fileId: 'f1', text: 'v2', draftRevision: 2, updatedAt: 2 }, 1)
    expect(newer).toEqual({ ok: true, draftRevision: 2 })

    // 旧修订的写入被拒绝，库中正文不被覆盖
    const stale = await repo.saveDraft({ clientFileKey: key, fileId: 'f1', text: 'v1-late', draftRevision: 2, updatedAt: 3 }, 1)
    expect(stale).toEqual({ ok: false, reason: 'conflict' })
    expect((await repo.loadDraft(key))?.text).toBe('v2')

    await repo.keepCandidate(key, 'v1-late', 'draftRevision 冲突')
    expect((await repo.loadDraft(key))?.text).toBe('v2')
  })

  it('身份键带模式 / 账号 / Attempt / 实例四段', () => {
    expect(scopeKey(scope)).toBe('demo\u0000local\u0000task:wordfreq')
    expect(clientFileKey(scope, 'f1')).toBe('demo\u0000local\u0000task:wordfreq\u0000f1')
    expect(clientFileKey({ ...scope, mode: 'prep' }, 'f1')).not.toBe(clientFileKey(scope, 'f1'))
  })
})
