import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { semanticReferenceCopy, normalizeSemanticRange } from '@xunjie/contracts/question-drafts';
import { aluCounterexampleFixture, aluCheckObservations } from './fixtures/alu-counterexample.mjs';
import { aluReferenceFixture, aluReferenceTrace } from './fixtures/alu-reference.mjs';

const range = (index = 2559) => ({ kind: 'semantic' as const, formatVersion: 1 as const,
  typeId: 'alu-counterexample', version: 1, target: { index }, start: 0 as const, end: 1 });
const material = (f = aluCounterexampleFixture()) => ({ action: f.action, output: f.output, state: 'succeeded',
  name: 'check-report.json', mediaType: 'application/json', text: f.text, resources: [] });

test('a check counterexample fixes the real input index, original four rounds and code/initiator source', () => {
  const f = aluCounterexampleFixture();
  const copy = semanticReferenceCopy(range(), material(f));
  assert.deepEqual(normalizeSemanticRange(range()).target, { index: 2559 });
  assert.equal(copy, ['ALU 检查反例 #2559', `原执行：${f.action.requestId}`, '执行来源：学生执行',
    `固定作品：alu.sv（${f.codeFile.contentId}）`, '状态：执行成功', '检查结论：fail',
    '输入：A=15，B=15，M=1，S=0，Cin=1', '预期：F=1111，Cout=1', '反例原因：行为错误',
    '第 1 轮（P0/T1）：实际 F=1111，Cout=0；binary', '第 2 轮（P0/T2）：实际 F=1111，Cout=0；binary',
    '第 3 轮（P1/T1）：实际 F=1111，Cout=0；binary', '第 4 轮（P1/T2）：实际 F=1111，Cout=0；binary'].join('\n'));
  assert.equal(copy.includes('预测'), false);
});

test('the full observations resource can select an index outside the primary report preview', () => {
  const f = aluCounterexampleFixture();
  const preview = Array.from({ length: 20 }, (_, index) => ({ ...structuredClone(f.example), index,
    inputs: { A: 0, B: index >> 1, M: 0, S: 0, Cin: index & 1 }, expected: { f: '1111', cout: '0' } }));
  f.report.counterexamples = preview; f.report.counterexampleTotal = 21;
  const observations = aluCheckObservations(f.report, [...preview, f.example]);
  const content = { ...material(f), text: JSON.stringify(f.report), resources: [
    { name: 'check-observations.json', text: JSON.stringify(observations) }] };
  assert.match(semanticReferenceCopy(range(), content), /ALU 检查反例 #2559/);
  assert.throws(() => semanticReferenceCopy(range(20), content)); // A valid index is not necessarily a counterexample.
});

test('counterexample targets and original report facts reject invented indexes and malformed or conflicting rounds', () => {
  const f = aluCounterexampleFixture(), content = material(f);
  for (const index of [-1, 4096, 1.5, '2559', 0])
    assert.throws(() => semanticReferenceCopy({ ...range(), target: { index } }, content), String(index));
  assert.throws(() => semanticReferenceCopy({ ...range(), target: { index: 2559, summary: 'claimed' } }, content));
  const faults: Array<[string, (report: typeof f.report) => void]> = [
    ['index does not encode inputs', report => { report.counterexamples[0].index = 1; }],
    ['duplicate index', report => { report.counterexamples.push(structuredClone(report.counterexamples[0])); }],
    ['duplicate round', report => { report.counterexamples[0].rounds[1].round = 0; }],
    ['wrong precursor', report => { report.counterexamples[0].rounds[0].precursor = 'P1'; }],
    ['wrong sample time', report => { report.counterexamples[0].rounds[0].sampleTime = 2; }],
    ['binary state with X', report => { report.counterexamples[0].rounds[0].f = 'xxxx'; }],
    ['missing state with values', report => { report.counterexamples[0].rounds[0].state = 'missing'; }],
    ['pass with a counterexample', report => { report.verdict = 'pass'; }],
    ['different runtime', report => { report.source.bundleIdentity = '0'.repeat(64); }],
    ['different code content', report => { report.source.works[0].contentId = '00000000-0000-4000-8000-000000000000'; }],
  ];
  for (const [name, change] of faults) {
    const report = structuredClone(f.report); change(report);
    assert.throws(() => semanticReferenceCopy(range(report.counterexamples[0].index),
      { ...content, text: JSON.stringify(report) }), name);
  }
  const observations = aluCheckObservations(f.report);
  observations.counterexamples[0].rounds[0].cout = '1';
  assert.throws(() => semanticReferenceCopy(range(), { ...content, resources: [
    { name: 'check-observations.json', text: JSON.stringify(observations) }] }));
});

test('unknown and missing round readings remain original facts even when the execution failed or knowledge is unknown', () => {
  const f = aluCounterexampleFixture();
  f.report.verdict = 'inconclusive';
  f.example.reasons = ['missing'];
  f.example.rounds[1] = { ...f.example.rounds[1], f: 'xx01', cout: 'z', state: 'unknown' };
  f.example.rounds[3] = { ...f.example.rounds[3], f: null, cout: null, state: 'missing' };
  f.report.rounds[3] = { ...f.report.rounds[3], status: 'missing', observationState: 'unavailable', rows: 0 };
  const content = { ...material(f), text: JSON.stringify(f.report), resources: [
    { name: 'check-observations.json', text: JSON.stringify(aluCheckObservations(f.report)) }] };
  for (const state of ['failed', 'cancelled', 'unknown']) {
    const copy = semanticReferenceCopy(range(), { ...content, state, output: { verdict: 'pass', summary: 'client claim' } });
    assert.match(copy, /检查结论：inconclusive/);
    assert.match(copy, /第 2 轮（P0\/T2）：实际 F=XX01，Cout=Z；unknown/);
    assert.match(copy, /第 4 轮（P1\/T2）：实际未取得；missing/);
    assert.equal(copy.includes('client claim'), false);
  }
});

test('a claimed counterexample summary cannot replace primary text, and original non-check operations are refused', () => {
  const f = aluCounterexampleFixture(), content = material(f);
  for (const patch of [{ text: undefined, output: f.report }, { text: 'broken json' }, { name: 'observation.json' },
    { mediaType: 'text/plain' }, { text: JSON.stringify({ ...f.report, kind: 'alu-observation' }) }])
    assert.throws(() => semanticReferenceCopy(range(), { ...content, ...patch }));
  for (const operationId of ['run-single', 'observe-enabled']) {
    const action = structuredClone(f.action); action.execution.operation.operationId = operationId;
    assert.throws(() => semanticReferenceCopy(range(), { ...content, action }));
  }
  assert.throws(() => semanticReferenceCopy(range(), { ...content, resources: [
    { name: 'check-observations.json', text: '{}' }, { name: 'check-observations.json', text: '{}' }] }));
});

test('counterexample copies enforce the existing UTF-8 copy budget including all fixed code filenames', () => {
  const f = aluCounterexampleFixture();
  f.action.execution.basis.works = Array.from({ length: 512 }, (_, index) => ({ ...f.codeFile,
    contentId: randomUUID(), name: '界'.repeat(230) + String(index).padStart(3, '0') + '.sv' }));
  f.report.source.works = f.action.execution.basis.works.map(file => ({ name: file.name, contentId: file.contentId, sha256: 'a'.repeat(64) }));
  assert.throws(() => semanticReferenceCopy(range(), { ...material(f), text: JSON.stringify(f.report) }), { code: 'range-too-large' });
});

test('report code provenance follows the existing HDL file selection when other code files are fixed in the action', () => {
  const f = aluCounterexampleFixture();
  f.action.execution.basis.works.push({ ...f.codeFile, objectId: randomUUID(), contentId: randomUUID(), name: 'unrelated.c', value: 'int x;' });
  const copy = semanticReferenceCopy(range(), material(f));
  assert.match(copy, /固定作品：alu.sv/);
  assert.equal(copy.includes('unrelated.c'), false);
});

test('the original four adapters keep their byte copies and closed VCD range unchanged', () => {
  const f = aluReferenceFixture();
  const prediction = ['目的：操作区别', '原预测：F=0101，Cout=0', '理由：Frozen student reason',
    '帮助自报：已获得帮助', '记录来源：未记录'];
  const context = ['输入：A=2，B=3，M=0，S=0，Cin=0', '作品：alu.sv', '执行来源：学生执行', ...prediction];
  const originalRange = (typeId: string, target = {}) => ({ ...range(), typeId, target });
  const observation = { action: f.action, output: { f: '1101', cout: '0', observationState: 'complete' },
    state: 'succeeded', resources: [{ name: 'trace.vcd', text: aluReferenceTrace }] };
  assert.equal(semanticReferenceCopy(originalRange('alu-case'), JSON.parse(f.stateFile.value).content),
    ['ALU 用例', context[0], ...prediction.map(line => line.replace('原预测', '预测'))].join('\n'));
  assert.equal(semanticReferenceCopy(originalRange('alu-observation'), observation),
    ['ALU 观察', ...context, '状态：执行成功', '实际：F=1101，Cout=0'].join('\n'));
  assert.equal(semanticReferenceCopy(originalRange('alu-waveform', {
    signalIds: ['tb.mirror[3:0]'], fromTick: '4', toTick: '9007199254740997' }), observation),
    ['ALU 波形', ...context, '状态：执行成功', '原始 tick 闭区间：4 至 9007199254740997', '时间单位：1 ps/tick',
      '信号 tb.mirror[3:0]（4 位）', '  起点：ZZ10（记录于 tick 3）',
      '  tick 9007199254740996：0001', '  tick 9007199254740997：1000'].join('\n'));
  const note = { formatVersion: 1, kind: 'alu-reflection', noteId: randomUUID(), activityId: f.activityId,
    bindingKey: f.binding.key, instanceId: f.action.execution.instance.instanceId, definitionDigest: f.binding.definition.digest,
    requestId: f.action.requestId, inputDigest: 'a'.repeat(64), executionRef: randomUUID(), parentNoteId: null, text: '固定解释' };
  assert.equal(semanticReferenceCopy(originalRange('alu-reflection'), { action: f.action, note }),
    ['ALU 解释修订', ...context, `原用例：${f.draft.caseId.slice(0, 8)}；预测修订：${f.draft.revisionId.slice(0, 8)}`,
      '修订：首次记录', '解释：固定解释'].join('\n'));
});
