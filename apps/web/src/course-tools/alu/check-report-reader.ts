import type { ExecutionRetainedResource } from '@xunjie/contracts/execution'
import type { ResultRecord } from '../../tool-execution/store'
import { CHECK_ROUNDS, expectedAlu, indexInputs } from '../../tool-execution/adapters/alu-check'
import type { AluCheckObservations, AluCheckReport } from './CheckReport'

const size = (text: string) => new TextEncoder().encode(text).length
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const natural = (value: unknown, max = 65536): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max
const boundedText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max
const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const strings = (value: unknown, count: number, length: number): value is string[] => Array.isArray(value)
  && value.length <= count && value.every(item => boundedText(item, length))
const values = (value: unknown, names: string[]) => names.includes(String(value))
const controls = (value: unknown) => object(value) && Object.entries({ A: 15, B: 15, M: 1, S: 3, Cin: 1 })
  .every(([key, max]) => natural(value[key], max))
const bits = (value: unknown, width: number) => value === null || typeof value === 'string' && new RegExp(`^[01xz]{${width}}$`).test(value)

function counterexamples(value: unknown, max: number) {
  return Array.isArray(value) && value.length <= max && value.every(item => object(item) && natural(item.index, 4095)
    && controls(item.inputs) && object(item.expected) && bits(item.expected.f, 4) && bits(item.expected.cout, 1)
    && Array.isArray(item.reasons) && item.reasons.length <= 4 && item.reasons.every(reason => values(reason, ['behaviour', 'unknown', 'inconsistent', 'missing']))
    && Array.isArray(item.rounds) && item.rounds.length <= 4 && item.rounds.every(round => object(round)
      && natural(round.round, 3) && values(round.precursor, ['P0', 'P1']) && values(round.sampleTime, ['1', '2'])
      && bits(round.f, 4) && bits(round.cout, 1) && values(round.state, ['binary', 'unknown', 'missing', 'invalid'])))
}

function reportShape(value: unknown): value is AluCheckReport {
  if (!object(value) || value.kind !== 'alu-check' || value.formatVersion !== 1
    || !values(value.verdict, ['pass', 'fail', 'inconclusive'])
    || !['totalInputs', 'plannedSamples', 'sampledRows', 'comparedRows', 'fullySampledInputs', 'fullyComparedInputs',
      'reservedInputs', 'reservedCovered', 'behaviorErrorInputs', 'unknownInputs', 'inconsistentInputs', 'missingInputs',
      'formatErrors', 'duplicateRows', 'outOfRange', 'roundsCompleted', 'counterexampleTotal'].every(key => natural(value[key]))
    || !strings(value.reasons, 32, 1000) || !boundedText(value.createdAt, 80) || !counterexamples(value.counterexamples, 20)
    || !Array.isArray(value.rounds) || value.rounds.length > 4 || !value.rounds.every(round => object(round)
      && natural(round.round, 3) && values(round.precursor, ['P0', 'P1']) && values(round.sampleTime, ['1', '2'])
      && boundedText(round.status, 40) && boundedText(round.observationState, 40) && natural(round.rows)
      && natural(round.invalidRows) && natural(round.durationMs, 40000) && (round.vcdBytes === null || natural(round.vcdBytes, 8388608)))) return false
  const source = value.source
  return object(source) && boundedText(source.adapterId, 100) && natural(source.adapterVersion)
    && digest(source.bundleIdentity) && digest(source.dependencyId) && natural(source.suiteVersion)
    && object(source.scaffold) && boundedText(source.scaffold.path, 200) && digest(source.scaffold.sha256) && natural(source.scaffold.version)
    && object(source.rule) && natural(source.rule.version) && digest(source.rule.digest)
    && Array.isArray(source.works) && source.works.length <= 64 && source.works.every(work => object(work)
      && boundedText(work.name, 200) && boundedText(work.contentId, 64) && digest(work.sha256))
}

function observationsShape(value: unknown): value is AluCheckObservations {
  return object(value) && value.kind === 'alu-check-observations' && value.formatVersion === 1
    && natural(value.totalInputs) && natural(value.plannedSamples) && values(value.verdict, ['pass', 'fail', 'inconclusive'])
    && counterexamples(value.counterexamples, 4096) && Array.isArray(value.rounds) && value.rounds.length <= 4
    && value.rounds.every(round => object(round) && natural(round.round, 3) && values(round.precursor, ['P0', 'P1'])
      && values(round.sampleTime, ['1', '2']) && boundedText(round.status, 40) && boundedText(round.observationState, 40)
      && natural(round.durationMs, 40000) && strings(round.invalid, 65536, 8192)
      && Array.isArray(round.rows) && round.rows.length <= 65536 && round.rows.every(row => Array.isArray(row) && row.length === 3
        && natural(row[0], 4095) && typeof row[1] === 'string' && typeof row[2] === 'string' && bits(row[1], 4) && bits(row[2], 1)))
}

interface Traces { formatVersion: number; kind: string; rounds: Array<{
  round: number; precursor: string; sampleTime: number; vcd: string | null; vcdBytes: number | null
}> }
function tracesShape(value: unknown): value is Traces {
  return object(value) && value.kind === 'alu-check-traces' && value.formatVersion === 1
    && Array.isArray(value.rounds) && value.rounds.length <= 4 && value.rounds.every(round => object(round)
      && natural(round.round, 3) && values(round.precursor, ['P0', 'P1']) && values(round.sampleTime, ['1', '2'])
      && (round.vcd === null || boundedText(round.vcd, 8388608)) && (round.vcdBytes === null || natural(round.vcdBytes, 8388608)))
}

function parse<T>(text: string, name: string, max: number, accepts: (value: unknown) => value is T): T {
  if (size(text) > max) throw new Error(`${name} 超过读取预算`)
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { throw new Error(`${name} 的 JSON 已损坏`) }
  if (!accepts(parsed)) throw new Error(`${name} 格式或版本不兼容`)
  return parsed
}

/** The same gate guards the UI even when a typed caller supplies an unverified pass summary. */
export function checkPassEvidence(report: AluCheckReport, observations: AluCheckObservations | null,
  diagnostics: string | null, resources: ExecutionRetainedResource[]): string {
  if (diagnostics === null || resources.filter(resource => resource.name === 'diagnostics.txt').length !== 1)
    return '缺少或重复的 diagnostics.txt，不能确认检查通过'
  if (size(diagnostics) > 2097152) return 'diagnostics.txt 超过读取预算'
  if (!observations || resources.filter(resource => resource.name === 'check-observations.json').length !== 1)
    return '缺少或无法解析 check-observations.json，不能确认检查通过'
  const traceResources = resources.filter(resource => resource.name === 'check-traces.json')
  if (traceResources.length !== 1) return '缺少或重复的 check-traces.json，不能确认检查通过'
  let traces: Traces
  try { traces = parse(traceResources[0]!.text, 'check-traces.json', 8388608, tracesShape) }
  catch (error) { return error instanceof Error ? error.message : String(error) }
  if (!reportShape(report) || !observationsShape(observations)) return '原报告或采样数据结构不完整，不能确认检查通过'
  if (report.totalInputs !== 4096 || report.plannedSamples !== 16384 || report.sampledRows !== 16384 || report.comparedRows !== 16384
    || report.fullySampledInputs !== 4096 || report.fullyComparedInputs !== 4096 || report.reservedInputs !== 1536 || report.reservedCovered !== 1536
    || report.roundsCompleted !== 4 || report.counterexampleTotal !== 0 || report.counterexamples.length !== 0
    || [report.behaviorErrorInputs, report.unknownInputs, report.inconsistentInputs, report.missingInputs, report.formatErrors,
      report.duplicateRows, report.outOfRange].some(value => value !== 0) || report.source.suiteVersion !== 1
    || observations.totalInputs !== 4096 || observations.plannedSamples !== 16384 || observations.verdict !== 'pass'
    || observations.counterexamples.length !== 0 || report.rounds.length !== 4 || observations.rounds.length !== 4 || traces.rounds.length !== 4)
    return '报告计数或完整性与 4096 组四轮采样不一致，不能确认检查通过'
  for (const spec of CHECK_ROUNDS) {
    const metadata = report.rounds.filter(round => round.round === spec.round)
    const samples = observations.rounds.filter(round => round.round === spec.round)
    const trace = traces.rounds.filter(round => round.round === spec.round)
    if (metadata.length !== 1 || samples.length !== 1 || trace.length !== 1) return `第 ${spec.round + 1} 轮缺失或重复，不能确认检查通过`
    const meta = metadata[0]!, sampled = samples[0]!, traced = trace[0]!
    if ([meta, sampled, traced].some(round => round.precursor !== spec.precursor || round.sampleTime !== spec.sampleTime)
      || meta.status !== 'completed' || sampled.status !== 'completed' || meta.observationState !== 'complete'
      || sampled.observationState !== 'complete' || meta.rows !== 4096 || meta.invalidRows !== 0 || sampled.invalid.length !== 0
      || sampled.rows.length !== 4096) return `第 ${spec.round + 1} 轮采样不完整，不能确认检查通过`
    for (let index = 0; index < 4096; index++) {
      const row = sampled.rows[index]!, expected = expectedAlu(indexInputs(index))
      if (row[0] !== index || row[1] !== expected.f || row[2] !== expected.cout)
        return `第 ${spec.round + 1} 轮原始采样与通过报告不一致，不能确认检查通过`
    }
    if (traced.vcd === null || !traced.vcd.includes('$enddefinitions') || !traced.vcd.includes('$var')
      || traced.vcdBytes !== size(traced.vcd) || meta.vcdBytes !== traced.vcdBytes)
      return `第 ${spec.round + 1} 轮 VCD 缺失、不完整或长度不符，不能确认检查通过`
  }
  return ''
}

/** Read the bounded original resources; a partial failure report stays useful, a partial pass cannot pass. */
export function readCheckArtifact(artifact: Pick<ResultRecord, 'name' | 'text' | 'resources'>) {
  const errors: string[] = []
  let report: AluCheckReport | null = null, observations: AluCheckObservations | null = null, diagnostics: string | null = null
  const resources = artifact.resources ?? []
  const find = (name: string) => {
    const matches = resources.filter(resource => resource.name === name)
    if (matches.length !== 1) { errors.push(`缺少或重复的 ${name}`); return null }
    return matches[0]!.text
  }
  try {
    if (artifact.name !== 'check-report.json') throw new Error('主结果不是 check-report.json')
    report = parse(artifact.text, 'check-report.json', 1048576, reportShape)
  } catch (error) { errors.push(error instanceof Error ? error.message : String(error)) }
  const observationText = find('check-observations.json')
  if (observationText !== null) try { observations = parse(observationText, 'check-observations.json', 8388608, observationsShape) }
  catch (error) { errors.push(error instanceof Error ? error.message : String(error)) }
  diagnostics = find('diagnostics.txt')
  if (diagnostics !== null && size(diagnostics) > 2097152) { errors.push('diagnostics.txt 超过读取预算'); diagnostics = null }
  const traceText = find('check-traces.json')
  if (traceText !== null) try { parse(traceText, 'check-traces.json', 8388608, tracesShape) }
  catch (error) { errors.push(error instanceof Error ? error.message : String(error)) }
  if (report?.verdict === 'pass') {
    const failure = checkPassEvidence(report, observations, diagnostics, resources)
    if (failure) errors.push(failure)
  }
  return { report, observations, diagnostics, resources, error: [...new Set(errors)].join('；') }
}
