import { describe, expect, it } from 'vitest'
import { diagnosticNodeTarget, diagnosticSources, verifyEditorDiagnostics } from './editorDiagnostics'
import type { ExecutionNodesState } from './executionNodes'

const file = { fileId: 'main', path: 'main.c', documentVersion: 1, contentHash: 'a'.repeat(64), text: '/* 😀 */ int n = ;\r\n' }
const response = { status: 'ready', sourceHash: 'b'.repeat(64), provider: 'gcc', diagnostics: [{
  fileId: file.fileId, path: file.path, contentHash: file.contentHash, severity: 'error', message: 'expected expression', line: 1,
  range: { startLine: 1, startColumn: 18, endLine: 1, endColumn: 19 },
}] }
describe('editor diagnostic trust and source binding', () => {
  it('uses only an explicit current-account node with the relevant course capability, preserving legacy hosts', () => {
    const context = { mode: 'real' as const, userId: 'student' }
    const nodes: ExecutionNodesState = { status: 'ready', userId: 'student', selectedNodeId: '', notice: '',
      nodes: [{ nodeId: 'robert', label: 'Robert 的电脑', cReady: false, hdlReady: true }] }
    expect(diagnosticNodeTarget(context, 'main.c', nodes)).toEqual({ ready: false })
    nodes.selectedNodeId = 'robert'
    expect(diagnosticNodeTarget(context, 'main.c', nodes)).toEqual({ ready: false, nodeId: 'robert' })
    expect(diagnosticNodeTarget(context, 'top.sv', nodes)).toEqual({ ready: true, nodeId: 'robert' })
    expect(diagnosticNodeTarget({ ...context, userId: 'another-account' }, 'top.sv', nodes)).toEqual({ ready: false })
    expect(diagnosticNodeTarget(context, 'main.c', { ...nodes, status: 'unavailable' })).toEqual({ ready: false })
    expect(diagnosticNodeTarget(context, 'main.c', { ...nodes, status: 'unsupported', nodes: [] })).toEqual({ ready: true })
  })
  it('accepts matching source and UTF-16 ranges, rejects foreign instances/hashes', () => {
    expect(verifyEditorDiagnostics(response, response.sourceHash, [file]).diagnostics).toHaveLength(1)
    expect(() => verifyEditorDiagnostics(response, 'c'.repeat(64), [file])).toThrow()
    expect(() => verifyEditorDiagnostics(response, response.sourceHash, [{ ...file, fileId: 'replacement' }])).toThrow()
    expect(() => verifyEditorDiagnostics(response, response.sourceHash, [{ ...file, contentHash: 'd'.repeat(64) }])).toThrow()
  })
  it('rejects partial surrogate locations and non-ready fake diagnostics', () => {
    expect(() => verifyEditorDiagnostics({ ...response, diagnostics: [{ ...response.diagnostics[0],
      range: { startLine: 1, startColumn: 5, endLine: 1, endColumn: 6 } }] }, response.sourceHash, [file])).toThrow()
    expect(() => verifyEditorDiagnostics({ ...response, status: 'unavailable' }, response.sourceHash, [file])).toThrow()
    expect(verifyEditorDiagnostics({ ...response, status: 'paused', sourceHash: '0'.repeat(64), diagnostics: [] }, response.sourceHash, [file]).status).toBe('paused')
  })
  it('includes dependent draft content and file identity in source hashes', async () => {
    const header = { ...file, fileId: 'header', path: 'types.h', text: 'typedef int Word;' }
    const initial = await diagnosticSources([file, header])
    expect((await diagnosticSources([header, file])).hash).toBe(initial.hash)
    expect((await diagnosticSources([file, { ...header, text: 'typedef float Word;' }])).hash).not.toBe(initial.hash)
    expect((await diagnosticSources([{ ...file, fileId: 'new-instance' }, header])).hash).not.toBe(initial.hash)
  })
  it('accepts backend wire and rejects extra or malformed fields before contextual source checks', () => {
    expect(verifyEditorDiagnostics(response, response.sourceHash, [file])).toEqual(response)
    const unbound = { severity: 'warning', message: 'compiler warning outside the snapshot' }
    for (const payload of [
      { ...response, injected: true },
      { ...response, diagnostics: [{ ...unbound, contentHash: 'not-a-hash' }] },
      { ...response, diagnostics: [{ ...unbound, path: 'x'.repeat(1025) }] },
      { ...response, diagnostics: [{ ...response.diagnostics[0], range: {
        startLine: 1, startColumn: 18, endLine: 1, endColumn: 19, injected: true,
      } }] },
    ]) {
      expect(() => verifyEditorDiagnostics(payload, response.sourceHash, [file])).toThrow()
    }
  })
})
