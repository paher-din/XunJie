import { describe, expect, it } from 'vitest'
import { referenceKey, snapshotReference, submissionReference } from './model'
import { codeReferenceSelection } from './CodeReferenceSource'

describe('original reference boundaries', () => {
  const sourceText = '\uFEFF甲\r\n🧩乙\n末尾未选中'
  const base = { workspaceKey: 'student:task:attempt', sourceId: 'instance-1', sourceName: 'same.txt', kind: 'text' as const, sourceText }
  it('keeps CRLF and emoji intact and rejects half characters/separators', () => {
    expect(snapshotReference({ ...base, range: { start: 1, end: 7 } })?.text).toBe('甲\r\n🧩乙')
    for (const range of [{ start: 1, end: 3 }, { start: 5, end: 7 }, { start: -1, end: 2 }, { start: 1, end: 100 }])
      expect(snapshotReference({ ...base, range })).toBeNull()
  })
  it('maps real editor LF offsets to the exact original, without leaking unselected text to submission', () => {
    const selection = codeReferenceSelection({ ok: true, selection: { workspaceKey: base.workspaceKey,
      fileId: base.sourceId, originalText: sourceText, modelStart: 0, modelEnd: 5 } }, base.sourceName, () => null)
    expect(selection?.snapshot.text).toBe('甲\r\n🧩乙')
    const reference = Object.freeze({ ...selection!.snapshot, id: '1' })
    const sent = submissionReference(reference)
    expect(sent.range).toEqual({ start: 1, end: 7 })
    expect(JSON.stringify(sent)).not.toContain('末尾未选中')
    expect(sent).not.toHaveProperty('sourceText')
    expect(Object.isFrozen(sent)).toBe(true)
    expect(Object.isFrozen(sent.range)).toBe(true)
  })
  it('deduplicates exact instance/range/content but isolates workspace and replacement instances', () => {
    const first = snapshotReference({ ...base, range: { start: 1, end: 7 } })!
    expect(referenceKey({ ...first, sourceName: 'renamed.txt' })).toBe(referenceKey(first))
    expect(referenceKey({ ...first, sourceId: 'instance-2' })).not.toBe(referenceKey(first))
    expect(referenceKey({ ...first, workspaceKey: 'other-student' })).not.toBe(referenceKey(first))
    expect(referenceKey({ ...first, text: '新内容' })).not.toBe(referenceKey(first))
  })
})
