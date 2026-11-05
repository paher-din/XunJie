import { actionInputSchema } from '@xunjie/contracts/action-intents'
import { sameDraftContent } from '../../../reliable-workspace/draft-store'
import { describe, expect, it } from 'vitest'
import { questionReferenceInputSchema, questionReferenceKey, questionDraftViewSchema, semanticReferenceCopy } from '@xunjie/contracts/question-drafts'
import { snapshotReference, submissionReference } from './model'
const objectId = crypto.randomUUID()
const source = { kind: 'component' as const, formatVersion: 1 as const, environmentId: crypto.randomUUID(), spaceId: crypto.randomUUID(), principalId: crypto.randomUUID(),
  activityId: crypto.randomUUID(), instanceId: 'activity:annotation', componentId: crypto.randomUUID(), componentVersion: 4, definitionDigest: 'a'.repeat(64),
  bindingKey: 'annotation', objectId: crypto.randomUUID(), contentId: crypto.randomUUID(), origin: 'state' as const, requestId: null, executionRef: null }
const range = { kind: 'semantic' as const, formatVersion: 1 as const, typeId: 'annotation-objects', version: 1, target: { objectIds: [objectId] }, start: 0 as const, end: 1 }
const content = { annotations: [{ id: objectId, quote: '真实依据', note: '我的疑问' }] }
const copy = semanticReferenceCopy(range, content)
const reference = questionReferenceInputSchema.parse({ referenceId: crypto.randomUUID(), source, range: { ...range, end: copy.length }, copy, sourceName: '标注' })
describe('versioned semantic references', () => {
  it('selects by stable object membership, rejects missing objects and foreign shapes', () => {
    expect(copy).toBe('真实依据\n标注：我的疑问')
    expect(() => semanticReferenceCopy({ ...range, target: { objectIds: [crypto.randomUUID()] } }, content)).toThrow()
    expect(() => semanticReferenceCopy({ ...range, target: { arbitrary: true } }, content)).toThrow()
  })
  it('canonicalizes set ranges and includes scope/content version in deduplication', () => {
    const second = crypto.randomUUID()
    const a = { ...reference, range: { ...range, target: { objectIds: [objectId, second] } } }
    const b = { ...reference, range: { ...range, target: { objectIds: [second, objectId, objectId] } } }
    expect(questionReferenceKey(a)).toBe(questionReferenceKey(b))
    expect(questionReferenceKey({ ...a, source: { ...source, contentId: crypto.randomUUID() } })).not.toBe(questionReferenceKey(a))
    expect(questionReferenceKey({ ...a, source: { ...source, principalId: crypto.randomUUID() } })).not.toBe(questionReferenceKey(a))
  })
  it('fixed snapshot and submission preserve semantic identity and original copy', () => {
    const snapshot = snapshotReference({ workspaceKey: 'scope', sourceId: 'state', sourceName: '标注', kind: 'semantic', source, sourceText: copy, range: reference.range })!
    content.annotations[0]!.note = '后来的修改'
    expect(snapshot.text).toBe(copy)
    expect(submissionReference({ ...snapshot, id: reference.referenceId }).range).toEqual(reference.range)
  })
  it('restores an unavailable adapter envelope without executing it or losing the draft', () => {
    const future = { ...reference, range: { ...range, typeId: 'future-adapter', version: 9, end: copy.length } }
    const draft = questionDraftViewSchema.parse({ draftId: crypto.randomUUID(), revision: 1, revisionId: crypto.randomUUID(), question: '保留问题', references: [{ ...future, copyDigest: 'b'.repeat(64) }] })
    expect(draft.references[0]!.copy).toBe(copy)
    expect(() => questionReferenceKey(future)).not.toThrow()
    expect(() => semanticReferenceCopy(future.range, content)).toThrow('unsupported-version')
  })
  it('selects real aggregation groups and fields, rather than trusting screen coordinates', () => {
    const aggregation = { ...range, typeId: 'aggregation-groups', target: { groupKeys: ['A'], fields: ['value','count'] } }
    const output = { groups: [{ key: 'A', count: 4, value: 83, sum: 332, mean: 83, min: 73, max: 92 }] }
    expect(semanticReferenceCopy(aggregation, output)).toBe('分组：A\n计数：4\n结果：83')
    expect(() => semanticReferenceCopy({ ...aggregation, target: { groupKeys: ['B'], fields: ['count'] } }, output)).toThrow()
  })
})

it('semantic draft acknowledgement ignores jsonb target key order but detects changed fields', () => {
  const a = { ...reference, range: { ...range, typeId: 'aggregation-groups', target: { groupKeys: ['A'], fields: ['count', 'value'] } } }
  const b = { ...a, range: { ...a.range, target: { fields: ['value', 'count'], groupKeys: ['A'] } } }
  expect(sameDraftContent({ question: 'Q', references: [a] }, { question: 'Q', references: [b] })).toBe(true)
  expect(sameDraftContent({ question: 'Q', references: [a] }, { question: 'Q', references: [{ ...b, copy: 'different' }] })).toBe(false)
})

it('parsed fixed action inputs have identical JSON before and after jsonb reorders semantic object keys', () => {
  const range = { kind: 'semantic', formatVersion: 1, typeId: 'aggregation-groups', version: 1, target: { groupKeys: ['A'], fields: ['count', 'value'] }, start: 0, end: copy.length }
  const input = { requestId: crypto.randomUUID(), scope: { environmentId: source.environmentId, spaceId: source.spaceId, principalId: source.principalId, activityId: source.activityId },
    receiver: { receiverId: 'test', kind: 'question', location: 'remote' }, draft: { token: 'fixed', question: 'Q', references: [{ ...reference, range }], bases: [] }, works: [], evidence: [] }
  const reordered = structuredClone(input)
  reordered.draft.references[0]!.range.target = { fields: ['count', 'value'], groupKeys: ['A'] }
  expect(JSON.stringify(actionInputSchema.parse(input))).toBe(JSON.stringify(actionInputSchema.parse(reordered)))
})
