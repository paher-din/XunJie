/**
 * The published ALU rule and the full-check comparison live in the ALU family, not in the generic
 * executor. These functions are deliberately free of React, Worker and storage APIs so the same
 * rule can be tested against the real sampled rows the runtime produces.
 */
export type AluInputs = { A: number; B: number; M: number; S: number; Cin: number }
export type AluRow = { index: number; f: string; cout: string }
export type InvalidRow = { invalid: string }
export type RoundStatus = 'completed' | 'failed' | 'stopped' | 'budget-exceeded' | 'missing'
export type RoundPrecursor = 'P0' | 'P1'

export interface CheckRoundResult {
  /** 0 = P0/T1, 1 = P0/T2, 2 = P1/T1, 3 = P1/T2. */
  round: number
  precursor: RoundPrecursor
  sampleTime: 1 | 2
  status: RoundStatus
  observationState: string
  rows: Array<AluRow | InvalidRow>
  diagnostics: string[]
  durationMs: number
  vcd: string | null
}

export type CounterexampleReason = 'behaviour' | 'unknown' | 'inconsistent' | 'missing'

export interface CheckRoundReading {
  round: number
  precursor: RoundPrecursor
  sampleTime: 1 | 2
  f: string | null
  cout: string | null
  state: 'binary' | 'unknown' | 'missing' | 'invalid'
}

export interface CheckCounterexample {
  index: number
  inputs: AluInputs
  expected: { f: string; cout: string }
  rounds: CheckRoundReading[]
  reasons: CounterexampleReason[]
}

export interface CheckAnalysis {
  verdict: 'pass' | 'fail' | 'inconclusive'
  totalInputs: number
  plannedSamples: number
  sampledRows: number
  comparedRows: number
  fullySampledInputs: number
  fullyComparedInputs: number
  reservedInputs: number
  reservedCovered: number
  behaviorErrorInputs: number
  unknownInputs: number
  inconsistentInputs: number
  missingInputs: number
  formatErrors: number
  duplicateRows: number
  outOfRange: number
  roundsCompleted: number
  reasons: string[]
  counterexamples: CheckCounterexample[]
  counterexampleTotal: number
}

export const CHECK_ROUNDS: ReadonlyArray<{ round: number; precursor: RoundPrecursor; sampleTime: 1 | 2 }> = [
  { round: 0, precursor: 'P0', sampleTime: 1 },
  { round: 1, precursor: 'P0', sampleTime: 2 },
  { round: 2, precursor: 'P1', sampleTime: 1 },
  { round: 3, precursor: 'P1', sampleTime: 2 },
]
export const PRECURSORS: Record<RoundPrecursor, AluInputs> = {
  P0: { A: 0, B: 0, M: 1, S: 0, Cin: 0 },
  P1: { A: 15, B: 15, M: 1, S: 0, Cin: 1 },
}
export const ALU_TOTAL_INPUTS = 4096
export const ALU_RESERVED_INPUTS = 1536

const binary = (value: number, width: number) => value.toString(2).padStart(width, '0')

/** The published rule, implemented independently of the HDL scaffold and the host comparator. */
export function expectedAlu(input: AluInputs): { f: string; cout: string } {
  for (const [key, max] of Object.entries({ A: 15, B: 15, M: 1, S: 3, Cin: 1 })) {
    const value = input[key as keyof AluInputs]
    if (!Number.isInteger(value) || value < 0 || value > max) throw new Error(`invalid ALU input ${key}`)
  }
  if (input.M === 0) {
    const values = [15 - input.A, input.A & input.B, input.A | input.B, input.A ^ input.B]
    return { f: binary(values[input.S]!, 4), cout: '0' }
  }
  if (input.S !== 0) return { f: '0000', cout: '0' }
  const total = input.A + input.B + input.Cin
  return { f: binary(total & 15, 4), cout: String((total >> 4) & 1) }
}

export function indexInputs(index: number): AluInputs {
  if (!Number.isInteger(index) || index < 0 || index >= ALU_TOTAL_INPUTS) throw new Error('invalid ALU index')
  return { M: (index >> 11) & 1, S: (index >> 9) & 3, A: (index >> 5) & 15, B: (index >> 1) & 15, Cin: index & 1 }
}

export function isReserved(input: AluInputs) {
  return input.M === 1 && input.S !== 0
}

export function aluInputsEqual(left: AluInputs, right: AluInputs) {
  return left.A === right.A && left.B === right.B && left.M === right.M && left.S === right.S && left.Cin === right.Cin
}

/** A complete four-state row is still a row; only a non-binary value makes it unknown. */
export function isFourState(value: string, width: number) {
  return new RegExp(`^[01xz]{${width}}$`).test(value)
}

export function isBinary(value: string, width: number) {
  return new RegExp(`^[01]{${width}}$`).test(value)
}

interface ParsedRound {
  spec: (typeof CHECK_ROUNDS)[number]
  result: CheckRoundResult | undefined
  byIndex: Map<number, AluRow>
  invalid: InvalidRow[]
}

function parseRound(spec: (typeof CHECK_ROUNDS)[number], result: CheckRoundResult | undefined): ParsedRound {
  const byIndex = new Map<number, AluRow>()
  const invalid: InvalidRow[] = []
  if (result) {
    for (const row of result.rows) {
      if ('invalid' in row) { invalid.push(row); continue }
      if (!Number.isInteger(row.index) || row.index < 0 || row.index >= ALU_TOTAL_INPUTS) continue
      // A malformed four-state value is not a usable sample, even if its index is plausible.
      if (!isFourState(row.f, 4) || !isFourState(row.cout, 1)) continue
      if (!byIndex.has(row.index)) byIndex.set(row.index, row)
    }
  }
  return { spec, result, byIndex, invalid }
}

/**
 * Compare all four independently sampled rounds with the public rule. Repeated rounds are never
 * counted as extra covered inputs, and a complete run with a wrong, unknown or unstable value is
 * a failure rather than a pass.
 */
export function analyzeCheck(rounds: CheckRoundResult[]): CheckAnalysis {
  const parsed = CHECK_ROUNDS.map(spec => parseRound(spec, rounds.find(round => round.round === spec.round)))
  let sampledRows = 0, comparedRows = 0, formatErrors = 0, duplicateRows = 0, outOfRange = 0
  for (const round of parsed) {
    const seen = new Set<number>()
    formatErrors += round.invalid.length
    if (round.result) {
      for (const row of round.result.rows) {
        if ('invalid' in row) continue
        if (!Number.isInteger(row.index) || row.index < 0 || row.index >= ALU_TOTAL_INPUTS) { outOfRange++; continue }
        if (!isFourState(row.f, 4) || !isFourState(row.cout, 1)) { formatErrors++; continue }
        sampledRows++
        if (seen.has(row.index)) { duplicateRows++; continue }
        seen.add(row.index)
        if (isBinary(row.f, 4) && isBinary(row.cout, 1)) comparedRows++
      }
    }
  }
  let fullySampledInputs = 0, fullyComparedInputs = 0, reservedCovered = 0
  const behavior = new Set<number>(), unknown = new Set<number>(), inconsistent = new Set<number>(), missing = new Set<number>()
  const readings = new Map<number, CheckRoundReading[]>()
  for (let index = 0; index < ALU_TOTAL_INPUTS; index++) {
    const inputs = indexInputs(index)
    const readingsForIndex: CheckRoundReading[] = parsed.map(round => {
      const row = round.byIndex.get(index)
      if (!row) return { round: round.spec.round, precursor: round.spec.precursor, sampleTime: round.spec.sampleTime,
        f: null, cout: null, state: 'missing' }
      const state = isFourState(row.f, 4) && isFourState(row.cout, 1)
        ? (isBinary(row.f, 4) && isBinary(row.cout, 1) ? 'binary' : 'unknown') : 'invalid'
      return { round: round.spec.round, precursor: round.spec.precursor, sampleTime: round.spec.sampleTime,
        f: row.f, cout: row.cout, state }
    })
    readings.set(index, readingsForIndex)
    const present = readingsForIndex.every(reading => reading.state !== 'missing')
    if (!present) { missing.add(index); continue }
    fullySampledInputs++
    const values = readingsForIndex.map(reading => `${reading.f}/${reading.cout}`)
    const allEqual = values.every(value => value === values[0])
    const allBinary = readingsForIndex.every(reading => reading.state === 'binary')
    if (readingsForIndex.some(reading => reading.state === 'unknown')) unknown.add(index)
    if (!allEqual) inconsistent.add(index)
    if (allBinary) {
      fullyComparedInputs++
      const expected = expectedAlu(inputs)
      if (values.some(value => value !== `${expected.f}/${expected.cout}`)) behavior.add(index)
    }
    if (isReserved(inputs)) reservedCovered++
  }
  const complete = rounds.length === 4 && parsed.every(round => round.result?.status === 'completed'
      && (round.result.observationState === 'complete' || round.result.observationState === 'complete-with-unknown'))
    && parsed.every(round => round.byIndex.size === ALU_TOTAL_INPUTS && round.invalid.length === 0)
    && formatErrors === 0 && duplicateRows === 0 && outOfRange === 0 && missing.size === 0
  const verdict: CheckAnalysis['verdict'] = !complete ? 'inconclusive'
    : behavior.size + unknown.size + inconsistent.size > 0 ? 'fail' : 'pass'
  const reasons: string[] = []
  if (rounds.length !== 4) reasons.push(`只收到 ${rounds.length}/4 轮结果`)
  for (const round of parsed) {
    if (!round.result) reasons.push(`第 ${round.spec.round + 1} 轮没有结果`)
    else if (round.result.status !== 'completed') reasons.push(`第 ${round.spec.round + 1} 轮${round.result.status === 'budget-exceeded' ? '超出预算' : round.result.status === 'stopped' ? '已停止' : '未完成'}`)
    else if (round.byIndex.size !== ALU_TOTAL_INPUTS || round.invalid.length) reasons.push(`第 ${round.spec.round + 1} 轮采样不完整`)
  }
  if (behavior.size) reasons.push(`${behavior.size} 组二值输出不符合公开规则`)
  if (unknown.size) reasons.push(`${unknown.size} 组含 X/Z 未知值`)
  if (inconsistent.size) reasons.push(`${inconsistent.size} 组在四轮前驱/时刻下不一致`)
  if (missing.size) reasons.push(`${missing.size} 组未取得四轮完整记录`)
  if (formatErrors) reasons.push(`${formatErrors} 行格式错误`)
  if (duplicateRows) reasons.push(`${duplicateRows} 行重复`)
  if (outOfRange) reasons.push(`${outOfRange} 行索引越界`)
  if (verdict === 'pass') reasons.push('四轮完整、全部二值且符合公开规则')
  const affected = new Set<number>([...behavior, ...unknown, ...inconsistent, ...missing])
  const counterexamples = [...affected].sort((left, right) => left - right).map((index): CheckCounterexample => {
    const inputs = indexInputs(index)
    const itemReasons: CounterexampleReason[] = []
    if (behavior.has(index)) itemReasons.push('behaviour')
    if (unknown.has(index)) itemReasons.push('unknown')
    if (inconsistent.has(index)) itemReasons.push('inconsistent')
    if (missing.has(index)) itemReasons.push('missing')
    return { index, inputs, expected: expectedAlu(inputs), rounds: readings.get(index)!, reasons: itemReasons }
  })
  return { verdict, totalInputs: ALU_TOTAL_INPUTS, plannedSamples: CHECK_ROUNDS.length * ALU_TOTAL_INPUTS,
    sampledRows, comparedRows, fullySampledInputs, fullyComparedInputs, reservedInputs: ALU_RESERVED_INPUTS,
    reservedCovered, behaviorErrorInputs: behavior.size, unknownInputs: unknown.size, inconsistentInputs: inconsistent.size,
    missingInputs: missing.size, formatErrors, duplicateRows, outOfRange,
    roundsCompleted: parsed.filter(round => round.result?.status === 'completed').length,
    reasons, counterexamples, counterexampleTotal: counterexamples.length }
}
