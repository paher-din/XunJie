import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { aluReferenceCopy, normalizeAluReferenceTarget } from '@xunjie/contracts/alu-references';
import { newAluCaseDraft } from '@xunjie/contracts/alu-learning';
import { normalizeSemanticRange, semanticReferenceCopy } from '@xunjie/contracts/question-drafts';
import { aluReferenceFixture, aluReferenceTrace } from './fixtures/alu-reference.mjs';

const inputs = { A: 2, B: 3, M: 0, S: 0, Cin: 0 };
const draft = { ...newAluCaseDraft(randomUUID(), randomUUID()), purpose: 'operation',
  predictedF: '0101', predictedCout: '0', reason: '区分按位逻辑与加法', helpReported: true };
const range = (typeId: string, target: Record<string, unknown> = {}) =>
  ({ kind: 'semantic' as const, formatVersion: 1 as const, typeId, version: 1, target, start: 0 as const, end: 1 });

test('case references contain original student inputs and prediction only, through the public semantic seam', () => {
  const content = { ...inputs, caseDraft: JSON.stringify(draft), enabledBasis: '', f: '1111', cout: '1', other: 'not selected' };
  const copy = aluReferenceCopy('alu-case', {}, content);
  assert.equal(copy, semanticReferenceCopy(range('alu-case'), content));
  assert.equal(copy, 'ALU 用例\n输入：A=2，B=3，M=0，S=0，Cin=0\n目的：操作区别\n预测：F=0101，Cout=0\n理由：区分按位逻辑与加法\n帮助自报：已获得帮助\n记录来源：未记录');
  assert.equal(copy.includes('1111'), false);
  assert.equal(copy.includes('not selected'), false);
  assert.deepEqual(normalizeSemanticRange(range('alu-case')).target, {});
  assert.match(aluReferenceCopy('alu-case', {}, { ...inputs, caseDraft: '' }), /预测：F 未填写，Cout 未填写/);
  assert.equal(copy.includes(draft.caseId), false);
  assert.throws(() => aluReferenceCopy('alu-case', {}, { ...inputs, caseDraft: '{broken' }));
  assert.throws(() => normalizeAluReferenceTarget('alu-case', { summary: 'self reported' }));
});

test('observations use the frozen action case and only confirmed successful owner output, including four-state facts', () => {
  const f = aluReferenceFixture();
  const content = { action: f.action, output: { f: 'xx01', cout: 'z', observationState: 'complete-with-unknown' },
    state: 'succeeded', resources: [], inputDigest: 'a'.repeat(64), executionRef: randomUUID() };
  const copy = semanticReferenceCopy(range('alu-observation'), content);
  for (const fact of ['输入：A=2，B=3，M=0，S=0，Cin=0', '作品：alu.sv', '执行来源：学生执行',
    '原预测：F=0101，Cout=0', '理由：Frozen student reason', '实际：F=XX01，Cout=Z']) assert.ok(copy.includes(fact), fact);
  assert.equal(copy.includes(f.action.requestId), false);
  assert.equal(copy.includes(f.enabledBy.inputDigest), false);
  for (const state of ['failed', 'unknown', 'queued', 'cancelled']) {
    const missing = aluReferenceCopy('alu-observation', {}, { ...content, state });
    assert.equal(missing.includes('实际：F='), false, state);
    assert.match(missing, /实际：未/);
  }
  for (const output of [null, { f: '101', cout: '0', observationState: 'complete' },
    { f: '0001', cout: '0', observationState: 'incomplete' }]) {
    assert.match(aluReferenceCopy('alu-observation', {}, { ...content, output }), /实际：缺失或不完整/);
  }
  const ordinary = structuredClone(f.action);
  ordinary.execution.operation.operationId = 'run-single';
  assert.match(aluReferenceCopy('alu-observation', {}, { ...content, action: ordinary }), /原预测：F 未填写，Cout 未填写/);
  const free = structuredClone(f.action);
  const stateFile = free.execution.basis.works.find(file => file.kind === 'state');
  const state = JSON.parse(stateFile.value); state.content.caseDraft = ''; stateFile.value = JSON.stringify(state);
  assert.match(aluReferenceCopy('alu-observation', {}, { ...content, action: free }), /原预测：F 未填写，Cout 未填写/);
  const check = structuredClone(f.action); check.execution.initiator.kind = 'self-check';
  assert.match(aluReferenceCopy('alu-observation', {}, { ...content, action: check }), /执行来源：自检执行/);
  const agent = structuredClone(f.action); agent.execution.initiator.kind = 'agent';
  assert.match(aluReferenceCopy('alu-observation', {}, { ...content, action: agent }), /执行来源：Agent 验证/);
});

test('waveform references read only retained trace.vcd, normalize exact closed ranges and refuse incomplete selections', () => {
  const f = aluReferenceFixture();
  const trace = { contentId: randomUUID(), name: 'trace.vcd', mediaType: 'text/plain', text: aluReferenceTrace,
    byteLength: Buffer.byteLength(aluReferenceTrace), sha256: createHash('sha256').update(aluReferenceTrace).digest('hex') };
  const target = { signalIds: ['tb.mirror[3:0]', 'tb.mirror[3:0]'], fromTick: '0004', toTick: '9007199254740997' };
  const content = { action: f.action, output: null, state: 'unknown', resources: [trace], text: 'external text is never selected' };
  const normalized = { signalIds: ['tb.mirror[3:0]'], fromTick: '4', toTick: '9007199254740997' };
  assert.deepEqual(normalizeSemanticRange(range('alu-waveform', target)).target, normalized);
  const copy = semanticReferenceCopy(range('alu-waveform', target), content);
  for (const fact of ['原始 tick 闭区间：4 至 9007199254740997', '时间单位：1 ps/tick',
    '信号 tb.mirror[3:0]（4 位）', '起点：ZZ10（记录于 tick 3）', 'tick 9007199254740996：0001',
    'tick 9007199254740997：1000', '状态：执行状态未知']) assert.ok(copy.includes(fact), fact);
  assert.equal(copy.includes('external text'), false);
  assert.equal(copy.includes(f.action.requestId), false);
  for (const patch of [{ signalIds: ['missing'] }, { toTick: '9007199254740999' }, { fromTick: '-1' }, { fromTick: '1e3' }])
    assert.throws(() => aluReferenceCopy('alu-waveform', { ...target, ...patch }, content));
  assert.throws(() => aluReferenceCopy('alu-waveform', target, { ...content, resources: [], text: aluReferenceTrace }));
  assert.throws(() => aluReferenceCopy('alu-waveform', target, { ...content, resources: [trace, { ...trace, contentId: randomUUID() }] }));
  assert.throws(() => aluReferenceCopy('alu-waveform', target, { ...content, resources: [{ ...trace, text: aluReferenceTrace + 'damaged' }] }));
});

test('reflection copies retain original note text and the linked fixed case, and reject links to another case', () => {
  const f = aluReferenceFixture();
  const note = { formatVersion: 1, kind: 'alu-reflection', noteId: randomUUID(), activityId: f.activityId,
    bindingKey: 'alu', instanceId: f.action.execution.instance.instanceId, definitionDigest: f.binding.definition.digest,
    requestId: f.action.requestId, inputDigest: 'a'.repeat(64), executionRef: randomUUID(), parentNoteId: null,
    text: '我把逻辑模式误当成加法；保留这次解释。' };
  const copy = semanticReferenceCopy(range('alu-reflection'), { note, action: f.action });
  assert.ok(copy.includes('解释：我把逻辑模式误当成加法；保留这次解释。'));
  assert.ok(copy.includes(`原用例：${f.draft.caseId.slice(0, 8)}；预测修订：${f.draft.revisionId.slice(0, 8)}`));
  assert.equal(copy.includes('实际：'), false);
  assert.equal(copy.includes(note.inputDigest), false);
  for (const patch of [{ requestId: randomUUID() }, { activityId: randomUUID() }, { bindingKey: 'other' },
    { instanceId: 'other' }, { definitionDigest: 'b'.repeat(64) }])
    assert.throws(() => aluReferenceCopy('alu-reflection', {}, { note: { ...note, ...patch }, action: f.action }));
  const ordinary = structuredClone(f.action);
  const state = ordinary.execution.basis.works.find(file => file.kind === 'state')!;
  const envelope = JSON.parse(state.value); envelope.content.caseRequestId = ''; envelope.content.feedbackPolicy = 'live';
  state.value = JSON.stringify(envelope);
  const laterExplanation = aluReferenceCopy('alu-reflection', {}, { note, action: ordinary });
  assert.ok(laterExplanation.includes('原观察未固定预测；缺项保留。'));
  assert.ok(laterExplanation.includes(note.text));
  assert.equal(laterExplanation.includes(`原用例：${f.draft.caseId.slice(0, 8)}`), false);
});

test('new object targets leave legacy annotation and aggregation array normalization unchanged', () => {
  const id = randomUUID(), other = randomUUID();
  assert.deepEqual(normalizeSemanticRange(range('annotation-objects', { objectIds: [id, other, id] })).target,
    { objectIds: [id, other].sort() });
  assert.deepEqual(normalizeSemanticRange(range('aggregation-groups', { groupKeys: ['B', 'A', 'B'], fields: ['sum', 'count', 'sum'] })).target,
    { fields: ['count', 'sum'], groupKeys: ['A', 'B'] });
  assert.equal(semanticReferenceCopy(range('annotation-objects', { objectIds: [id] }),
    { annotations: [{ id, quote: '原文', note: '注释' }] }), '原文\n标注：注释');
  for (const typeId of ['missing', '__proto__', 'constructor']) assert.throws(() => normalizeAluReferenceTarget(typeId, {}));
  assert.throws(() => semanticReferenceCopy({ ...range('alu-case'), version: 99 }, inputs));
});

test('readable copies retain source categories and refuse excessive waveform facts rather than shortening them', () => {
  const priorSources = ['same-input-observation', 'work-check'].map(kind => ({ kind, requestId: randomUUID(), inputDigest: 'a'.repeat(64), executionRef: randomUUID() }));
  const copy = aluReferenceCopy('alu-case', {}, { ...inputs, caseDraft: JSON.stringify({ ...draft, priorSources }) });
  assert.match(copy, /记录来源：同输入观察 ×1；作品全量检查 ×1/);
  const f = aluReferenceFixture();
  const text = '$scope module tb $end\n$var wire 1 ! clock $end\n$upscope $end\n$enddefinitions $end\n'
    + Array.from({ length: 10000 }, (_, index) => `#${index}\n1!\n`).join('');
  assert.throws(() => aluReferenceCopy('alu-waveform', { signalIds: ['tb.clock'], fromTick: '0', toTick: '9999' },
    { action: f.action, state: 'succeeded', output: null, resources: [{ name: 'trace.vcd', text }] }), { code: 'range-too-large' });
});
