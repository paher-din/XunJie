import { describe, expect, it } from 'vitest'
import { manifestRows, textHash } from './confirmation'
import { codeRangeModelOffsets, codeRangeOffsets, codeSelectionRange, createCodeObjectRef,
  verifyCodeTarget, type CodeDraft, type VerifiedCodeTarget } from './tutoringObject'
import type { SnapshotView } from './workspaceContracts'

const context = { workspaceKey: 'prep\0student\0attempt', attemptId: 'attempt', activityVersionId: 'activity' }
async function snapshotOf(text: string): Promise<SnapshotView> {
  const file = { fileId: 'server-file', path: 'main.c', documentVersion: 2, contentHash: await textHash(text), text }
  return { snapshotId: 'snapshot', attemptId: 'attempt', activityVersionId: 'activity', workspaceRevision: 3,
    createdAt: '2026-10-13T00:00:00.000Z', hashFormat: 'sha256-manifest-v1',
    hash: await textHash(JSON.stringify(manifestRows([file]))), files: [file] }
}
async function setup(text = '\uFEFF中🙂\r\n尾\r行\n') {
  const snapshot = await snapshotOf(text), target = await verifyCodeTarget(snapshot, context, 'server-file')
  const draft: CodeDraft = { workspaceKey: context.workspaceKey, fileId: 'local-stable', serverFileId: 'server-file',
    path: 'main.c', lifecycle: 'active', text, confirmed: { text, version: 2, lifecycle: 'active' } }
  const selection = { workspaceKey: context.workspaceKey, fileId: draft.fileId, originalText: text, modelStart: 0, modelEnd: 3 }
  return { snapshot, target, draft, selection, workspaceKey: context.workspaceKey, intent: 'selection' as const }
}

describe('已核快照 → 明确文件/选区对象', () => {
  it('冻结完整身份与原文坐标，不把本机映射或编辑器版本发到 wire', async () => {
    const input = await setup(), result = createCodeObjectRef(input)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    expect(result.objectRef).toEqual({ kind: 'code', attemptId: 'attempt', snapshotId: 'snapshot',
      fileId: 'server-file', path: 'main.c', documentVersion: 2, contentHash: await textHash(input.draft.text),
      range: { startLine: 1, startColumn: 2, endLine: 1, endColumn: 5 } })
    expect(Object.isFrozen(result.objectRef)).toBe(true)
    expect(Object.isFrozen(result.objectRef.range)).toBe(true)
    input.snapshot.files[0].text = 'later text'
    expect(result.objectRef.contentHash).toBe(await textHash(input.draft.text))
  })

  it('核验前复制输入，调用后修改原快照/上下文不改变固定引用', async () => {
    const snapshot = await snapshotOf('old'), mutableContext = { ...context }
    const pending = verifyCodeTarget(snapshot, mutableContext, 'server-file')
    snapshot.files[0].text = 'late'
    mutableContext.attemptId = 'other'
    const target = await pending
    expect(target.file.text).toBe('old')
    expect(target.attemptId).toBe('attempt')
    expect(Object.isFrozen(target.file)).toBe(true)
  })

  it('整个文件必须显式选择；不因无选区静默扩大引用', async () => {
    const input = await setup(''), result = createCodeObjectRef({ ...input, intent: 'file', selection: null })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.objectRef).not.toHaveProperty('range')
    const empty = createCodeObjectRef({ ...input, selection: { ...input.selection, modelStart: 0, modelEnd: 0 } })
    expect(empty).toMatchObject({ ok: false, reason: expect.stringContaining('请先选择') })
  })

  it.each([
    ['没有快照', (i: Awaited<ReturnType<typeof setup>>) => ({ ...i, target: null })],
    ['没有草稿', (i: Awaited<ReturnType<typeof setup>>) => ({ ...i, draft: null })],
    ['同名新实例', (i: Awaited<ReturnType<typeof setup>>) => ({ ...i, draft: { ...i.draft, serverFileId: 'another-file' } })],
    ['无确认映射', (i: Awaited<ReturnType<typeof setup>>) => ({ ...i, draft: { ...i.draft, serverFileId: null, confirmed: null } })],
    ['脏草稿', (i: Awaited<ReturnType<typeof setup>>) => ({ ...i, draft: { ...i.draft, text: 'unsaved' } })],
    ['回收', (i: Awaited<ReturnType<typeof setup>>) => ({ ...i, draft: { ...i.draft, lifecycle: 'recycled' as const } })],
    ['另一模式/账号/Attempt', (i: Awaited<ReturnType<typeof setup>>) => ({ ...i, workspaceKey: 'another-workspace' })],
    ['原选区已失效', (i: Awaited<ReturnType<typeof setup>>) => ({ ...i, selection: { ...i.selection, originalText: 'old selection' } })],
    ['选区属于同名其他本机实例', (i: Awaited<ReturnType<typeof setup>>) => ({ ...i, selection: { ...i.selection, fileId: 'another-local' } })],
    ['确认版本不同', (i: Awaited<ReturnType<typeof setup>>) => ({ ...i, draft: { ...i.draft, confirmed: { ...i.draft.confirmed!, version: 3 } } })],
    ['确认正文不同', (i: Awaited<ReturnType<typeof setup>>) => ({ ...i, draft: { ...i.draft, confirmed: { ...i.draft.confirmed!, text: 'different' } } })],
  ])('%s 不构造引用，也不改变原文/快照', async (_name, change) => {
    const input = await setup(), before = structuredClone(input.snapshot)
    const draftBefore = structuredClone(input.draft)
    expect(createCodeObjectRef(change(input)).ok).toBe(false)
    expect(input.snapshot).toEqual(before)
    expect(input.draft).toEqual(draftBefore)
  })

  it('未走快照核验的形状不能混入纯构造器', async () => {
    const input = await setup()
    const target = { workspaceKey: context.workspaceKey, attemptId: 'attempt', snapshotId: 'guess', file: input.snapshot.files[0] }
    expect(createCodeObjectRef({ ...input, target: target as unknown as VerifiedCodeTarget }).ok).toBe(false)
  })

  it('缺文件、错误hash、跨Attempt或activity快照不能成为核验来源', async () => {
    const snapshot = await snapshotOf('x')
    await expect(verifyCodeTarget(snapshot, context, 'missing')).rejects.toThrow('不在')
    await expect(verifyCodeTarget({ ...snapshot, files: [{ ...snapshot.files[0], text: 'changed' }] }, context, 'server-file')).rejects.toThrow('摘要')
    await expect(verifyCodeTarget({ ...snapshot, attemptId: 'other' }, context, 'server-file')).rejects.toThrow('归属')
    await expect(verifyCodeTarget({ ...snapshot, activityVersionId: 'other' }, context, 'server-file')).rejects.toThrow('归属')
  })
})

describe('原文本UTF-16边界的精确往返', () => {
  it.each([
    ['BOM/CRLF/非BMP', '\uFEFF中🙂\r\n尾', 0, 5, [1, 7], [1, 2, 2, 2]],
    ['裸CR跨显示行', 'a\rb', 2, 3, [2, 3], [1, 3, 1, 4]],
    ['空文档位置', '', 0, 0, [0, 0], [1, 1, 1, 1]],
    ['末尾空行', 'x\n\n', 2, 3, [2, 3], [2, 1, 3, 1]],
    ['混合EOL跨行', 'x\r\ny\nz\rw', 2, 7, [3, 8], [2, 1, 3, 4]],
  ] as const)('%s', (_name, text, start, end, offsets, coordinates) => {
    const range = codeSelectionRange(text, start, end)
    expect(range).toEqual({ startLine: coordinates[0], startColumn: coordinates[1],
      endLine: coordinates[2], endColumn: coordinates[3] })
    expect(codeRangeOffsets(text, range!)).toEqual(offsets)
    expect(codeRangeModelOffsets(text, range!)).toEqual([start, end])
  })

  it.each([
    ['代理项内部', '🙂', 1, 2], ['负边界', 'a', -1, 1], ['反向offset', 'a', 1, 0],
    ['超末尾', 'a', 0, 2], ['非整数', 'a', 0.5, 1], ['NaN', 'a', NaN, 1],
    // 服务端把最后一行的尾CR也裁列，显示末尾不能无损还原；不规范化正文绕过。
    ['尾裸CR', 'a\r', 0, 2],
  ] as const)('%s 保持不可用', (_name, text, start, end) => {
    expect(codeSelectionRange(text, start, end)).toBeNull()
  })

  it('隐藏BOM与CRLF内部不吸附到邻字', () => {
    expect(codeRangeModelOffsets('\uFEFFa', { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 })).toBeNull()
    expect(codeRangeModelOffsets('a\r\nb', { startLine: 1, startColumn: 3, endLine: 2, endColumn: 1 })).toBeNull()
    expect(codeRangeOffsets('🙂', { startLine: 1, startColumn: 2, endLine: 1, endColumn: 3 })).toBeNull()
    expect(codeRangeOffsets('a', { startLine: 0, startColumn: 1, endLine: 1, endColumn: 1 })).toBeNull()
  })
})
