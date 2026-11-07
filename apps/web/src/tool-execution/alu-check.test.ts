import { describe, expect, it } from 'vitest'
import { analyzeCheck, CHECK_ROUNDS, expectedAlu, indexInputs, type CheckRoundResult, type RoundPrecursor } from './adapters/alu-check'

type Dut = (inputs: ReturnType<typeof indexInputs>, precursor: RoundPrecursor, sampleTime: 1 | 2) => { f: string; cout: string }

function roundsOf(dut: Dut): CheckRoundResult[] {
  return CHECK_ROUNDS.map(spec => ({
    round: spec.round, precursor: spec.precursor, sampleTime: spec.sampleTime, status: 'completed',
    observationState: 'complete',
    rows: Array.from({ length: 4096 }, (_, index) => ({ index, ...dut(indexInputs(index), spec.precursor, spec.sampleTime) })),
    diagnostics: [], durationMs: 1, vcd: null,
  }))
}
const correct: Dut = inputs => expectedAlu(inputs)
const dropCarry: Dut = inputs => {
  const expected = expectedAlu(inputs)
  return inputs.M === 1 && inputs.S === 0 ? { f: expected.f, cout: '0' } : expected
}

describe('published ALU rule', () => {
  it('covers logical, arithmetic and reserved controls with the published index mapping', () => {
    expect(expectedAlu({ A: 10, B: 12, M: 0, S: 1, Cin: 1 })).toEqual({ f: '1000', cout: '0' })
    expect(expectedAlu({ A: 10, B: 12, M: 0, S: 3, Cin: 0 })).toEqual({ f: '0110', cout: '0' })
    expect(expectedAlu({ A: 15, B: 0, M: 1, S: 0, Cin: 1 })).toEqual({ f: '0000', cout: '1' })
    expect(expectedAlu({ A: 15, B: 15, M: 1, S: 1, Cin: 1 })).toEqual({ f: '0000', cout: '0' })
    expect(indexInputs(0)).toEqual({ A: 0, B: 0, M: 0, S: 0, Cin: 0 })
    expect(indexInputs(4095)).toEqual({ A: 15, B: 15, M: 1, S: 3, Cin: 1 })
  })
})

describe('four-round full check', () => {
  it('passes only a complete, all-binary, stable and rule-conforming run', () => {
    const analysis = analyzeCheck(roundsOf(correct))
    expect(analysis.verdict).toBe('pass')
    expect(analysis).toMatchObject({ totalInputs: 4096, plannedSamples: 16384, sampledRows: 16384,
      comparedRows: 16384, fullySampledInputs: 4096, fullyComparedInputs: 4096,
      reservedInputs: 1536, reservedCovered: 1536, behaviorErrorInputs: 0, unknownInputs: 0,
      inconsistentInputs: 0, missingInputs: 0, formatErrors: 0, duplicateRows: 0, outOfRange: 0, roundsCompleted: 4 })
  })

  it('detects exactly the 256 unique inputs that lose the arithmetic carry, without counting four rounds as extra inputs', () => {
    const analysis = analyzeCheck(roundsOf(dropCarry))
    expect(analysis.verdict).toBe('fail')
    expect(analysis.behaviorErrorInputs).toBe(256)
    expect(analysis.counterexampleTotal).toBe(256)
    expect(analysis.counterexamples.find(item => item.inputs.A === 15
      && item.inputs.B === 0 && item.inputs.M === 1 && item.inputs.S === 0 && item.inputs.Cin === 1)?.index)
      .toBe((1 << 11) | (0 << 9) | (15 << 5) | (0 << 1) | 1)
  })

  it('retains X and Z as distinct unknown values for all 1536 reserved controls', () => {
    for (const value of ['xxxx', 'zzzz']) {
      const analysis = analyzeCheck(roundsOf(inputs => inputs.M === 1 && inputs.S !== 0
        ? { f: value, cout: value[0]! } : expectedAlu(inputs)))
      expect(analysis.verdict).toBe('fail')
      expect(analysis.unknownInputs).toBe(1536)
      expect(analysis.fullyComparedInputs).toBe(2560)
      expect(analysis.counterexampleTotal).toBe(1536)
    }
  })

  it('does not treat a wrong but binary reserved output as a pass', () => {
    const analysis = analyzeCheck(roundsOf(inputs => inputs.M === 1 && inputs.S !== 0
      ? { f: '0001', cout: '0' } : expectedAlu(inputs)))
    expect(analysis.verdict).toBe('fail')
    expect(analysis.behaviorErrorInputs).toBe(1536)
    expect(analysis.reservedCovered).toBe(1536)
    expect(analysis.unknownInputs).toBe(0)
  })

  it('catches a value that depends on the precursor even when the P0 sequence looks correct', () => {
    const index = (1 << 9) // M=0, S=1, A=0, B=0, Cin=0; expected AND = 0000
    const analysis = analyzeCheck(roundsOf((inputs, precursor) => {
      if (inputs.A === 0 && inputs.B === 0 && inputs.M === 0 && inputs.S === 1 && inputs.Cin === 0)
        return { f: precursor === 'P0' ? '0000' : '1111', cout: '0' }
      return expectedAlu(inputs)
    }))
    expect(analysis.verdict).toBe('fail')
    expect(analysis.inconsistentInputs).toBe(1)
    expect(analysis.counterexamples.find(item => item.index === index)?.reasons).toEqual(['behaviour', 'inconsistent'])
  })

  it('catches a result that is only wrong at the second sampling time', () => {
    const index = (1 << 9) | (1 << 1) // M=0, S=1, A=0, B=1, Cin=0; expected 0000
    const analysis = analyzeCheck(roundsOf((inputs, _precursor, sampleTime) => {
      if (inputs.B === 1 && inputs.M === 0 && inputs.S === 1 && inputs.A === 0 && inputs.Cin === 0)
        return { f: sampleTime === 1 ? '0000' : '0001', cout: '0' }
      return expectedAlu(inputs)
    }))
    expect(analysis.verdict).toBe('fail')
    expect(analysis.inconsistentInputs).toBe(1)
    expect(analysis.counterexamples.map(item => item.index)).toEqual([index])
  })

  it('does not pass missing, duplicate, malformed or out-of-range observations', () => {
    const missing = roundsOf(correct)
    missing[1]!.rows = missing[1]!.rows.filter(row => 'index' in row && row.index !== 7)
    const missingAnalysis = analyzeCheck(missing)
    expect(missingAnalysis.verdict).toBe('inconclusive')
    expect(missingAnalysis.missingInputs).toBe(1)

    const duplicate = roundsOf(correct)
    const duplicateRow = duplicate[0]!.rows[0]!
    duplicate[0]!.rows.push({ ...duplicateRow })
    const duplicateAnalysis = analyzeCheck(duplicate)
    expect(duplicateAnalysis.verdict).toBe('inconclusive')
    expect(duplicateAnalysis.duplicateRows).toBe(1)

    const malformed = roundsOf(correct)
    malformed[2]!.rows[3] = { invalid: 'ROW 3 nope' }
    expect(analyzeCheck(malformed).verdict).toBe('inconclusive')
    expect(analyzeCheck(malformed).formatErrors).toBe(1)

    const malformedValue = roundsOf(correct)
    malformedValue[1]!.rows[7] = { index: 7, f: '00', cout: '0' }
    const malformedValueAnalysis = analyzeCheck(malformedValue)
    expect(malformedValueAnalysis.verdict).toBe('inconclusive')
    expect(malformedValueAnalysis.formatErrors).toBe(1)
    expect(malformedValueAnalysis.missingInputs).toBe(1)

    const outOfRange = roundsOf(correct)
    outOfRange[3]!.rows.push({ index: 4096, f: '0000', cout: '0' })
    const rangeAnalysis = analyzeCheck(outOfRange)
    expect(rangeAnalysis.verdict).toBe('inconclusive')
    expect(rangeAnalysis.outOfRange).toBe(1)
  })

  it('treats a stopped or missing round as inconclusive rather than a pass', () => {
    const stopped = roundsOf(correct)
    stopped[2] = { ...stopped[2]!, status: 'stopped' }
    expect(analyzeCheck(stopped).verdict).toBe('inconclusive')
    expect(analyzeCheck(roundsOf(correct).slice(0, 3)).verdict).toBe('inconclusive')
  })
})
