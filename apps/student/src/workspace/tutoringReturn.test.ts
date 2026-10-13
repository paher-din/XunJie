import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TutoringExample } from '../components/workspace/TutoringExample'
import type { ActivityView, ResourceStudentView } from './contracts'
import type { WorkspaceContext } from './context'
import type { MaterialRead } from './init'
import { captureTutoringReturn, resolveTutoringResource, validateTutoringReturn, type TutoringReturnFile } from './tutoringReturn'

const id = 'prep-resource-adjacent-example-01'
const resource: ResourceStudentView = { status: 'available', resourceVersionId: id,
  title: '温度边界', text: '核查 29、30、31；这是合成材料。', contentHash: 'a'.repeat(64), paragraphs: [] }
const activity = { activityVersionId: 'activity', content: { audience: 'student', materials: [resource] } } as ActivityView
const materials = (): MaterialRead[] => [{ index: 0, projectedStatus: 'available', state: { kind: 'loaded', view: structuredClone(resource) } }]
const context: WorkspaceContext = { mode: 'preparation', userId: 'student', assignmentId: 'assignment',
  activityVersionId: 'activity', attemptId: 'attempt', loadEpoch: 3, trustedRecoveryGeneration: 'generation', preparationEpoch: 'prep' }
const file: TutoringReturnFile = { fileId: 'local-1', serverFileId: 'server-1', path: 'main.c', lifecycle: 'active',
  documentVersion: 4, contentHash: 'b'.repeat(64), draftText: '\ufeff// 😀\r\nint x;\r// tail\n' }
const view = { cursor: { line: 2, column: 4 }, scrollTop: 200, folds: [{ start: 2, end: 4 }] }

describe('only authorized public resources become passive reading content', () => {
  it('resolves the supplied preparation ID and states its actual synthetic source', () => {
    const reads = materials(), result = resolveTutoringResource(id, activity, reads, 'preparation')
    expect(result.kind).toBe('ready')
    if (result.kind !== 'ready') throw new Error('expected loaded material')
    expect(result.nature).toBe('synthetic-example')
    expect(result.sourceLabel).toContain('非教师真实批准材料')
    reads[0]!.state = { kind: 'not-readable', reason: 'redacted' }
    expect(result.resource.text).toBe(resource.text)
  })
  it('neither a generic material nor a matching real-mode ID implies teacher example approval', () => {
    const generic = { ...resource, resourceVersionId: 'course-brief' }
    const act = { ...activity, content: { ...activity.content, materials: [generic] } }
    expect(resolveTutoringResource('course-brief', act,
      [{ index: 0, projectedStatus: 'available', state: { kind: 'loaded', view: generic } }], 'real')).toMatchObject({
      kind: 'ready', nature: 'course-material', sourceLabel: expect.stringContaining('未核验为类似例子'),
    })
    expect(resolveTutoringResource(id, activity, materials(), 'real')).toMatchObject({ kind: 'ready', nature: 'course-material' })
  })
  it('rejects missing IDs, private/unavailable projections and text pretending to be a reference', () => {
    expect(resolveTutoringResource('', activity, materials(), 'preparation')).toMatchObject({ kind: 'unavailable', reason: 'missing-reference' })
    const hidden = { ...activity, content: { ...activity.content, materials: [{ status: 'redacted' as const }, { status: 'unavailable' as const }] } }
    for (const ref of [id, '<example id="private">body</example>']) {
      expect(resolveTutoringResource(ref, hidden, materials(), 'preparation')).toMatchObject({ kind: 'unavailable', reason: 'not-readable' })
    }
  })
  it('does not display a failed, missing, duplicate or nonstudent read', () => {
    const failed: MaterialRead = { index: 0, projectedStatus: 'available', state: { kind: 'failed', resourceVersionId: id,
      failure: { kind: 'transport', message: 'permission failure' } } }
    for (const reads of [[], [failed], [...materials(), ...materials()]]) {
      expect(resolveTutoringResource(id, activity, reads, 'preparation')).toMatchObject({ kind: 'unavailable', reason: 'load-failed' })
    }
    expect(resolveTutoringResource(id, { ...activity, content: { ...activity.content, audience: 'teacher-validator' } },
      materials(), 'preparation').kind).toBe('unavailable')
  })
  it.each([{ resourceVersionId: 'other' }, { contentHash: 'changed' }, { text: 'different body' }, { status: 'redacted' }])(
    'rejects a resource response that differs from the active projection: %j', over => {
      const reads = materials()
      reads[0]!.state = { kind: 'loaded', view: { ...resource, ...over } as ResourceStudentView }
      expect(resolveTutoringResource(id, activity, reads, 'preparation')).toMatchObject({ kind: 'unavailable', reason: 'projection-mismatch' })
    })
  it('renders HTML as escaped text without executable elements or automatic callbacks', () => {
    let returned = false
    const html = renderToStaticMarkup(createElement(TutoringExample, {
      resource: { kind: 'ready', resource: { ...resource, text: '<script>alert(1)</script>\n\n[bad](javascript:alert(1))' },
        nature: 'course-material', sourceLabel: '公开课程资料' }, onReturn: () => { returned = true },
    }))
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('href="javascript:')
    expect(html).toContain('返回原作品')
    expect(returned).toBe(false)
  })
})

describe('return validates the exact original local instance and view', () => {
  it('keeps raw BOM/mixed EOL/nonBMP draft and clones cursor/scroll/folds without touching the caller', () => {
    const inputView = structuredClone(view), inputFile = structuredClone(file)
    const anchor = captureTutoringReturn(context, inputFile, inputView)
    inputView.cursor.column = 99; inputFile.draftText = 'newer local draft'
    expect(anchor.file.draftText).toBe(file.draftText)
    expect(anchor.view).toEqual(view)
    const result = validateTutoringReturn(anchor, context, [file])
    expect(result).toEqual({ kind: 'ready', fileId: 'local-1', view })
    expect(result.kind === 'ready' && result.view).not.toBe(anchor.view)
  })
  it.each([
    { mode: 'real' as const }, { userId: 'other' }, { assignmentId: 'other' }, { activityVersionId: 'other' },
    { attemptId: 'other' }, { preparationEpoch: 'new' }, { loadEpoch: 4 }, { trustedRecoveryGeneration: 'new' },
  ])('does not restore old coordinates after an identity, generation or reload change: %j', change => {
    const anchor = captureTutoringReturn(context, file, view)
    expect(validateTutoringReturn(anchor, { ...context, ...change }, [file])).toMatchObject({ kind: 'unavailable', reason: 'context-changed' })
  })
  it('refuses a same-path rebuilt instance or recycled original', () => {
    const anchor = captureTutoringReturn(context, file, view)
    expect(validateTutoringReturn(anchor, context, [{ ...file, fileId: 'new-local' }])).toMatchObject({ kind: 'unavailable', reason: 'file-missing' })
    expect(validateTutoringReturn(anchor, context, [{ ...file, lifecycle: 'recycled' }])).toMatchObject({ kind: 'unavailable', reason: 'file-recycled' })
  })
  it.each([{ documentVersion: 5 }, { contentHash: 'new-hash' }, { serverFileId: 'new-server' }, { path: 'renamed.c' }])(
    'refuses changed object versions/mappings without returning a location: %j', change => {
      const result = validateTutoringReturn(captureTutoringReturn(context, file, view), context, [{ ...file, ...change }])
      expect(result).toMatchObject({ kind: 'unavailable', reason: 'version-changed' })
      expect('view' in result).toBe(false)
    })
  it('preserves a changed draft and reports a missing local view rather than guessing', () => {
    expect(validateTutoringReturn(captureTutoringReturn(context, file, view), context, [{ ...file, draftText: 'new' }]))
      .toMatchObject({ kind: 'unavailable', reason: 'draft-changed' })
    expect(validateTutoringReturn(captureTutoringReturn(context, file, null), context, [file]))
      .toMatchObject({ kind: 'unavailable', reason: 'view-missing' })
    expect(file.draftText).toContain('\r\n')
  })
  it('allows an unchanged local-only instance without inventing a server version', () => {
    const local = { ...file, serverFileId: undefined, documentVersion: null, contentHash: null }
    expect(validateTutoringReturn(captureTutoringReturn(context, local, view), context, [local]).kind).toBe('ready')
  })
})
