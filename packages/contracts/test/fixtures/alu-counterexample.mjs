import { createHash } from 'node:crypto';
import { aluReferenceFixture } from './alu-reference.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
export function aluCheckObservations(report, examples = report.counterexamples) {
  return { formatVersion: 1, kind: 'alu-check-observations', totalInputs: 4096, plannedSamples: 16384,
    verdict: report.verdict, counterexamples: examples,
    rounds: report.rounds.map(round => ({ ...round, invalid: [], rows: examples.flatMap(item => {
      const reading = item.rounds.find(reading => reading.round === round.round);
      return reading?.f === null || reading?.cout === null ? [] : [[item.index, reading.f, reading.cout]];
    }) })) };
}
// Retained receiver facts for owner tests; this fixture does not run HDL.
export function aluCounterexampleFixture(options = {}) {
  const fixed = aluReferenceFixture(options), action = structuredClone(fixed.action);
  action.execution.operation.operationId = 'check-all';
  action.execution.parameters = {};
  const example = { index: 2559, inputs: { A: 15, B: 15, M: 1, S: 0, Cin: 1 },
    expected: { f: '1111', cout: '1' }, reasons: ['behaviour'],
    rounds: [0, 1, 2, 3].map(round => ({ round, precursor: round < 2 ? 'P0' : 'P1',
      sampleTime: round % 2 + 1, f: '1111', cout: '0', state: 'binary' })) };
  const report = { formatVersion: 1, kind: 'alu-check', createdAt: '2026-11-07T00:00:00.000Z',
    verdict: 'fail', totalInputs: 4096, plannedSamples: 16384, sampledRows: 16384, comparedRows: 16384,
    fullySampledInputs: 4096, fullyComparedInputs: 4096, reservedInputs: 1536, reservedCovered: 1536,
    behaviorErrorInputs: 1, unknownInputs: 0, inconsistentInputs: 0, missingInputs: 0,
    formatErrors: 0, duplicateRows: 0, outOfRange: 0, roundsCompleted: 4,
    reasons: ['1 组二值输出不符合公开规则'], counterexampleTotal: 1, counterexamples: [example],
    rounds: example.rounds.map(({ round, precursor, sampleTime }) => ({ round, precursor, sampleTime,
      status: 'completed', observationState: 'complete', rows: 4096, invalidRows: 0, durationMs: 10, vcdBytes: null })),
    source: { adapterId: 'icarus-alu', adapterVersion: 1, bundleIdentity: action.execution.basis.runtime.bundleIdentity,
      dependencyId: 'c'.repeat(64), suiteVersion: 1,
      scaffold: { path: 'tb.sv', sha256: 'd'.repeat(64), version: 1 },
      rule: { version: 1, digest: action.execution.basis.course.behaviorRuleDigest },
      works: action.execution.basis.works.filter(file => file.kind === 'code').map(file => ({ name: file.name,
        contentId: file.contentId, sha256: hash(file.value) })) } };
  const output = Object.fromEntries(['verdict', 'totalInputs', 'plannedSamples', 'sampledRows', 'comparedRows',
    'behaviorErrorInputs', 'unknownInputs', 'inconsistentInputs', 'missingInputs', 'roundsCompleted'].map(key => [key, report[key]]));
  return { ...fixed, action, report, example, output, text: JSON.stringify(report) };
}
