import { describe, expect, it } from 'vitest'
import { hdlDiagnosticTarget } from './hdlDiagnostic'
import type { HdlBuildView, HdlDiagnostic } from './hdlContracts'
import type { CodeDraft } from './tutoringObject'

const text = 'module top;\r\n  wire led;\r\n  assign led = ;\r\nendmodule\r\n'
const source = { fileId: 'source-instance', path: 'top.sv', documentVersion: 3, contentHash: 'a'.repeat(64), text }
const build = { request: { snapshot: { snapshotId: 'frozen-snapshot', files: [source] } } } as HdlBuildView
const diagnostic: HdlDiagnostic = { severity: 'error', message: 'syntax error', fileId: source.fileId,
  path: source.path, line: 3, location: 'line-only' }
const draft: CodeDraft = { workspaceKey: 'same-workspace', fileId: 'local-instance', serverFileId: source.fileId,
  path: source.path, lifecycle: 'active', text, confirmed: { text, version: 3, lifecycle: 'active' } }

describe('real HDL diagnostic source line', () => {
  it('only selects the full original line, preserving CRLF without inventing compiler columns', () => {
    const target = hdlDiagnosticTarget(diagnostic, build, [draft])
    expect(target.kind).toBe('current')
    if (target.kind === 'current') {
      expect(target.draft).toBe(draft)
      expect(target.range).toEqual({ startLine: 3, startColumn: 1, endLine: 3, endColumn: 17 })
    }
    expect(draft.text).toBe(text)
  })

  it.each([
    { ...draft, text: text.replace('= ;', '= 1;') },
    { ...draft, confirmed: { ...draft.confirmed!, version: 4 } },
    { ...draft, lifecycle: 'recycled' as const },
    { ...draft, path: 'renamed.sv' },
    { ...draft, serverFileId: 'replacement-instance' },
  ])('new draft/version, recycled, renamed or same-path replacement cannot receive old diagnostics', candidate => {
    const target = hdlDiagnosticTarget(diagnostic, build, [candidate])
    expect(target.kind).toBe('historical')
    expect('notice' in target && target.notice).toContain('frozen-snapshot')
    expect('notice' in target && target.notice).toContain('第 3 行')
  })

  it('requires a uniquely identified file in the selected snapshot rather than guessing from one open file', () => {
    expect(hdlDiagnosticTarget({ ...diagnostic, fileId: undefined, path: undefined }, build, [draft]).kind).toBe('unavailable')
    expect(hdlDiagnosticTarget({ ...diagnostic, fileId: 'another-instance' }, build, [draft]).kind).toBe('unavailable')
    const ambiguous = { request: { snapshot: { snapshotId: 'frozen', files: [source, { ...source, fileId: 'other', path: 'other.sv' }] } } } as HdlBuildView
    expect(hdlDiagnosticTarget({ ...diagnostic, fileId: undefined, path: undefined }, ambiguous, [draft]).kind).toBe('unavailable')
  })

  it.each([0, -1, Number.NaN, 100, 5])('invalid, empty or absent source line %s cannot invent a selection', line => {
    expect(hdlDiagnosticTarget({ ...diagnostic, line }, build, [draft]).kind).toBe('unavailable')
  })

  it('unavailable location stays unavailable even when the diagnostic carries a line number', () => {
    const target = hdlDiagnosticTarget({ ...diagnostic, location: 'unavailable' }, build, [draft])
    expect(target.kind).toBe('unavailable')
    expect('notice' in target && target.notice).toContain('不推断文件或列')
  })
})
