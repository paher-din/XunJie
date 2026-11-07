import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ExecutionRetainedResource } from '@xunjie/contracts/execution'
import type { ExecutionRecord } from '../../tool-execution/ledger'
import { analyzeCheck, CHECK_ROUNDS, expectedAlu, indexInputs, type CheckRoundResult } from '../../tool-execution/adapters/alu-check'
import { CheckReportTool, type AluCheckObservations, type AluCheckReport } from './CheckReport'
import { readCheckArtifact } from './check-report-reader'

const vcd = '$var wire 4 ! F $end\n$enddefinitions $end\n#1000\nb0000 !\n'
const rounds: CheckRoundResult[] = CHECK_ROUNDS.map(spec => ({ ...spec, status: 'completed', observationState: 'complete',
  rows: Array.from({ length: 4096 }, (_, index) => ({ index, ...expectedAlu(indexInputs(index)) })), diagnostics: [], durationMs: 10, vcd }))
const analysis = analyzeCheck(rounds)
const source: AluCheckReport['source'] = { adapterId: 'icarus-alu', adapterVersion: 1, bundleIdentity: 'a'.repeat(64),
  dependencyId: 'b'.repeat(64), suiteVersion: 1, scaffold: { path: 'check.sv', sha256: 'c'.repeat(64), version: 1 },
  rule: { version: 1, digest: 'd'.repeat(64) }, works: [{ name: 'alu.sv', contentId: crypto.randomUUID(), sha256: 'e'.repeat(64) }] }
const report: AluCheckReport = { ...analysis, formatVersion: 1, kind: 'alu-check', createdAt: new Date().toISOString(), source,
  rounds: rounds.map(round => ({ ...round, rows: 4096, invalidRows: 0, vcdBytes: Buffer.byteLength(vcd) })) }
const observations: AluCheckObservations = { formatVersion: 1, kind: 'alu-check-observations', totalInputs: 4096,
  plannedSamples: 16384, verdict: 'pass', counterexamples: [], rounds: rounds.map(round => ({ ...round, invalid: [],
    rows: round.rows.flatMap(row => 'invalid' in row ? [] : [[row.index, row.f, row.cout] as [number, string, string]]) })) }
const resource = (name: string, text: string): ExecutionRetainedResource => ({ contentId: crypto.randomUUID(), name,
  text, mediaType: name.endsWith('.json') ? 'application/json' : 'text/plain', sha256: 'f'.repeat(64), byteLength: Buffer.byteLength(text) })
const artifact = () => ({ name: 'check-report.json', text: JSON.stringify(report), resources: [
  resource('check-observations.json', JSON.stringify(observations)), resource('diagnostics.txt', ''),
  resource('check-traces.json', JSON.stringify({ formatVersion: 1, kind: 'alu-check-traces',
    rounds: rounds.map(round => ({ round: round.round, precursor: round.precursor, sampleTime: round.sampleTime,
      vcd: round.vcd, vcdBytes: Buffer.byteLength(vcd) })) })),
] })
const record = { requestId: crypto.randomUUID(), executionRef: crypto.randomUUID(), createdAt: Date.now(),
  action: { protocolVersion: 3, execution: { operation: { operationId: 'check-all' }, basis: { works: [] } } },
  query: { state: 'succeeded', statusKnowledge: 'confirmed' } } as unknown as ExecutionRecord
const render = (value: ReturnType<typeof readCheckArtifact>) => renderToStaticMarkup(<CheckReportTool record={record}
  active={false} canStart report={value.report} observations={value.observations} diagnostics={value.diagnostics}
  resources={value.resources} error={value.error} loading={false} onUseInput={() => {}} onRecheck={() => {}}
  onStop={() => {}} onQuery={() => {}} />)

describe('retained ALU check reports require complete evidence before displaying pass', () => {
  it('reads all four complete sampled rounds and their retained traces', () => {
    const read = readCheckArtifact(artifact())
    expect(read.error).toBe('')
    expect(render(read)).toContain('4096 组检查通过')
  })
  it.each(['check-observations.json', 'diagnostics.txt', 'check-traces.json'])('keeps a missing %s from becoming a displayed pass', name => {
    const input = artifact(); input.resources = input.resources.filter(item => item.name !== name)
    const read = readCheckArtifact(input)
    expect(read.error).toContain(name)
    expect(read.report?.verdict).toBe('pass')
    expect(render(read)).not.toContain('4096 组检查通过')
    expect(render(read)).toContain('不能显示通过')
    expect(render(read)).not.toContain('alu-verdict-pass')
  })
  it.each(['check-report.json', 'check-observations.json', 'check-traces.json'])('rejects damaged JSON in %s without changing to an older report', name => {
    const input = artifact()
    if (name === input.name) input.text = '{invalid'
    else input.resources.find(item => item.name === name)!.text = '{invalid'
    const read = readCheckArtifact(input)
    expect(read.error).toContain(name)
    expect(render(read)).not.toContain('4096 组检查通过')
  })
  it('rejects a pass whose original rows repeat an index even when all summary counts claim complete coverage', () => {
    const input = artifact(), changed = structuredClone(observations)
    changed.rounds[0]!.rows[1] = changed.rounds[0]!.rows[0]!
    input.resources[0]!.text = JSON.stringify(changed)
    const read = readCheckArtifact(input)
    expect(read.error).toContain('原始采样与通过报告不一致')
    expect(render(read)).not.toContain('4096 组检查通过')
  })
  it('treats a missing per-round VCD as incomplete evidence', () => {
    const input = artifact(), trace = JSON.parse(input.resources[2]!.text)
    trace.rounds[2].vcd = null; trace.rounds[2].vcdBytes = null
    input.resources[2]!.text = JSON.stringify(trace)
    const read = readCheckArtifact(input)
    expect(read.error).toContain('第 3 轮 VCD 缺失')
    expect(render(read)).not.toContain('4096 组检查通过')
  })
  it('retains readable failure counterexamples when a secondary resource is missing', () => {
    const wrong = structuredClone(rounds)
    for (const round of wrong) round.rows[0] = { index: 0, f: '0000', cout: '0' }
    const failed = analyzeCheck(wrong), input = artifact()
    input.text = JSON.stringify({ ...report, ...failed, rounds: report.rounds })
    input.resources = input.resources.filter(item => item.name !== 'check-observations.json')
    const read = readCheckArtifact(input)
    expect(read.report?.verdict).toBe('fail')
    expect(read.report?.counterexamples).toHaveLength(1)
    expect(read.error).toContain('check-observations.json')
    expect(render(read)).toContain('index 0')
    expect(render(read)).toContain('发现行为错误')
    expect(render(read)).not.toContain('4096 组检查通过')
  })
})
