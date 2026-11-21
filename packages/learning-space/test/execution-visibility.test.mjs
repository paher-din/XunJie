import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { executionReveal, readFixedExperiment } from '../dist/learning-data/execution-visibility.js';
import { createLearningQuery } from '../dist/learning-data/learning-query.js';
import { aluReferenceFixture } from '../../contracts/test/fixtures/alu-reference.mjs';

function fixture() {
  const binding = { key: 'alu', definition: { digest: 'a'.repeat(64), manifest: {
    formatVersion: 3, runtime: { adapterId: 'icarus-alu' }, componentId: randomUUID(), version: 3,
    stateVersion: 3, hostApiVersion: 1, initialState: {},
  } } };
  const fixed = aluReferenceFixture({ binding });
  const activity = { activityId: fixed.activityId, identity: { ...fixed.identity, kind: 'personal', name: '学生' },
    target: { environmentId: randomUUID(), serviceId: randomUUID(), version: 1 }, goal: 'ALU', question: '',
    references: [], status: 'open', createdAt: new Date().toISOString(),
    course: { helpPolicy: { version: 1, questions: 'allowed', scope: 'course',
      predictionGate: { formatVersion: 1, hideResultsBeforePrediction: true } }, components: [binding] } };
  const record = { requestId: fixed.action.requestId, executionRef: randomUUID(), inputDigest: 'b'.repeat(64),
    actionText: JSON.stringify(fixed.action), query: { state: 'succeeded', statusKnowledge: 'confirmed',
      stopRequested: false, output: { output: { f: '0101', cout: '0' } } } };
  const state = (change = {}) => {
    const value = JSON.parse(fixed.stateFile.value);
    value.content = { ...value.content, ...change };
    return { ...fixed.stateFile, value: JSON.stringify(value) };
  };
  const current = (change = {}, code = fixed.codeFile) => ({ files: [state(change), code] });
  return { fixed, activity, record, current, state };
}

const read = record => async requestId => requestId === record.requestId ? record : null;

/** A full check-all record in the same held activity, distinct from the prediction submission record. */
function checkAllRecord(f) {
  const action = structuredClone(f.fixed.action);
  action.requestId = randomUUID();
  action.execution.operation.operationId = 'check-all';
  action.execution.parameters = {};
  const record = { ...f.record, requestId: action.requestId, executionRef: randomUUID(),
    actionText: JSON.stringify(action) };
  return { action, record, readRecord: async requestId => requestId === f.record.requestId ? f.record
    : requestId === record.requestId ? record : null };
}

test('同版本同输入的待提交预测只暴露曾展示状态，不暴露结果', async () => {
  const f = fixture();
  const view = await executionReveal({ activity: f.activity, record: f.record,
    current: f.current({ caseRequestId: '', caseDraft: '' }), readRecord: read(f.record), wasDisplayed: async () => true });
  assert.deepEqual(view, { reveal: false, phase: 'pending', previouslyShown: true, reason: 'prediction-required' });
});

test('执行完成但没有学生展示证据时不推断 previouslyShown', async () => {
  const f = fixture();
  const view = await executionReveal({ activity: f.activity, record: f.record,
    current: f.current({ caseRequestId: '', caseDraft: '' }), readRecord: read(f.record) });
  assert.equal(view.previouslyShown, undefined);
});

test('不同输入或不同作品版本的旧观察仍可按原来源展示', async () => {
  const f = fixture();
  const differentInput = await executionReveal({ activity: f.activity, record: f.record,
    current: f.current({ A: 3, caseRequestId: '', caseDraft: '' }), readRecord: read(f.record) });
  assert.equal(differentInput.reveal, true);
  const differentVersion = await executionReveal({ activity: f.activity, record: f.record,
    current: f.current({ caseRequestId: '', caseDraft: '' },
      { ...f.fixed.codeFile, contentId: randomUUID(), value: 'module alu; // v8\nendmodule\n' }), readRecord: read(f.record) });
  assert.equal(differentVersion.reveal, true);
});

test('提交后只开放被核验的对应用例，自由实验保持普通观察', async () => {
  const f = fixture();
  const submitted = await executionReveal({ activity: f.activity, record: f.record,
    current: f.current(), readRecord: read(f.record) });
  assert.deepEqual(submitted, { reveal: true, phase: 'submitted' });
  const free = await executionReveal({ activity: f.activity, record: f.record,
    current: f.current({ feedbackPolicy: 'live', caseRequestId: '', caseDraft: '' }), readRecord: read(f.record) });
  assert.deepEqual(free, { reveal: true, phase: 'free-observation' });
});

test('提交后其他同版本同输入的旧记录仍标记为已展示但不冒充本次结果', async () => {
  const f = fixture();
  const action = structuredClone(f.fixed.action);
  action.requestId = randomUUID();
  action.execution.operation.operationId = 'run-single';
  const state = action.execution.basis.works.find(file => file.kind === 'state');
  const value = JSON.parse(state.value);
  value.content.feedbackPolicy = 'live';
  state.value = JSON.stringify(value);
  const other = { ...f.record, requestId: action.requestId, actionText: JSON.stringify(action), executionRef: randomUUID() };
  const view = await executionReveal({ activity: f.activity, record: other,
    current: f.current(), readRecord: read(f.record), wasDisplayed: async () => true });
  assert.deepEqual(view, { reveal: true, phase: 'submitted', previouslyShown: true });
});

test('hold 的 check-all 在预测提交前隐藏，提交后按已核验预测显示，自由观察始终开放', async () => {
  const f = fixture(), check = checkAllRecord(f);
  const pending = await executionReveal({ activity: f.activity, record: check.record,
    current: f.current({ caseRequestId: '', caseDraft: '' }), readRecord: check.readRecord });
  assert.deepEqual(pending, { reveal: false, phase: 'pending', reason: 'prediction-required' });
  const submitted = await executionReveal({ activity: f.activity, record: check.record,
    current: f.current(), readRecord: check.readRecord });
  assert.deepEqual(submitted, { reveal: true, phase: 'submitted' });
  const free = await executionReveal({ activity: f.activity, record: check.record,
    current: f.current({ feedbackPolicy: 'live', caseRequestId: '', caseDraft: '' }), readRecord: check.readRecord });
  assert.deepEqual(free, { reveal: true, phase: 'free-observation' });
});

test('提交后 check-all 的主页固定引用与工作区 visibility 返回一致结果', async () => {
  const f = fixture(), check = checkAllRecord(f);
  Object.assign(f.activity.course, { courseId: randomUUID(), taskId: randomUUID(), releaseId: randomUUID(),
    courseName: '数字逻辑', taskTitle: 'ALU', contentDigest: 'a'.repeat(64) });
  const contentId = randomUUID();
  check.record.query.output.contentId = contentId;
  const instance = check.action.execution.instance;
  const reference = { activityId: f.activity.activityId, requestId: check.record.requestId,
    executionRef: check.record.executionRef, inputDigest: check.record.inputDigest,
    source: { kind: 'component', formatVersion: 1, ...check.action.scope, instanceId: instance.instanceId,
      componentId: instance.componentId, componentVersion: instance.componentVersion,
      definitionDigest: instance.definitionDigest, bindingKey: instance.key,
      objectId: check.record.requestId, contentId, origin: 'execution-result',
      requestId: check.record.requestId, executionRef: check.record.executionRef } };
  const works = { read: async () => f.current() };
  const workspace = await executionReveal({ activity: f.activity, record: check.record,
    current: f.current(), readRecord: check.readRecord });
  const fixed = await readFixedExperiment({ activity: f.activity, reference, works, readRecord: check.readRecord });
  assert.equal(workspace.reveal, true);
  assert.equal(workspace.phase, 'submitted');
  assert.equal(fixed.reveal, true);
  assert.equal(fixed.facts.resultWithheld, undefined);
  assert.equal(fixed.facts.result.f, '0101');
});

test('非当前绑定预测、错误身份和损坏的 check-all 仍然保守隐藏', async () => {
  const f = fixture(), check = checkAllRecord(f);
  const otherPrediction = await executionReveal({ activity: f.activity, record: check.record,
    current: f.current({ caseRequestId: randomUUID(), caseDraft: '{}' }), readRecord: check.readRecord });
  assert.deepEqual(otherPrediction, { reveal: false, phase: 'pending', reason: 'prediction-required' });
  const wrongIdentity = structuredClone(check.action);
  wrongIdentity.scope.principalId = randomUUID();
  const wrongRecord = { ...check.record, actionText: JSON.stringify(wrongIdentity) };
  const wrong = await executionReveal({ activity: f.activity, record: wrongRecord,
    current: f.current(), readRecord: async () => wrongRecord });
  assert.deepEqual(wrong, { reveal: false, phase: 'pending', reason: 'course-policy' });
  const corrupt = await executionReveal({ activity: f.activity, record: { ...check.record, actionText: '{' },
    current: f.current(), readRecord: async () => ({ ...check.record, actionText: '{' }) });
  assert.deepEqual(corrupt, { reveal: false, phase: 'pending', reason: 'course-policy' });
});

test('主页普通查询和固定引用在当前预测阶段返回一致的状态，不带波形或附件', async () => {
  const f = fixture(), instance = f.fixed.action.execution.instance;
  Object.assign(f.activity.course, { courseId: randomUUID(), taskId: randomUUID(), releaseId: randomUUID(),
    courseName: '数字逻辑', taskTitle: 'ALU', contentDigest: 'a'.repeat(64) });
  const contentId = randomUUID();
  f.record.query.output.contentId = contentId;
  f.record.query.output.artifacts = [{ text: 'PRIVATE_TRACE_MARKER' }];
  f.record.result = { attachment: 'PRIVATE_ATTACHMENT_MARKER' };
  let current = f.current({ caseRequestId: '', caseDraft: '' });
  const works = { read: async () => current };
  const readRecord = read(f.record);
  let displayed = false;
  const wasDisplayed = async () => displayed;
  const reference = { activityId: f.activity.activityId, requestId: f.record.requestId, executionRef: f.record.executionRef,
    inputDigest: f.record.inputDigest, source: { kind: 'component', formatVersion: 1,
      ...f.fixed.action.scope, instanceId: instance.instanceId, componentId: instance.componentId,
      componentVersion: instance.componentVersion, definitionDigest: instance.definitionDigest, bindingKey: instance.key,
      objectId: f.record.requestId, contentId, origin: 'execution-result',
      requestId: f.record.requestId, executionRef: f.record.executionRef } };
  const query = createLearningQuery({ sources: async () => [{ sourceId: 'school-alu', identity: f.activity.identity,
    target: f.activity.target, learning: { open: async () => f.activity, list: async () => [f.activity], works,
      executionRecords: { read: async (_identity, _activity, requestId) => readRecord(requestId),
        history: async () => ({ entries: [f.record], nextCursor: null }), wasDisplayed } } }] });
  const page = await query.searchLearning({ query: 'ALU', kinds: ['record'] });
  assert.equal(page.items.length, 1);
  const material = await query.readLearning({ reference: page.items[0].reference, range: { offset: 0, length: 16000 } });
  const fixed = await readFixedExperiment({ activity: f.activity, reference, works, readRecord, wasDisplayed });
  assert.equal(JSON.parse(material.text).resultWithheld, 'prediction-required');
  assert.equal(fixed.facts.resultWithheld, 'prediction-required');
  assert.equal(fixed.facts.previouslyShown, undefined);
  assert.equal(JSON.parse(material.text).previouslyShown, undefined);
  assert.doesNotMatch(JSON.stringify([page.items[0].excerpt, material.text, fixed.facts]), /0101|PRIVATE_TRACE_MARKER|PRIVATE_ATTACHMENT_MARKER/);
  displayed = true;
  const previously = await readFixedExperiment({ activity: f.activity, reference, works, readRecord, wasDisplayed });
  assert.equal(previously.facts.previouslyShown, true);
  assert.equal(JSON.parse((await query.readLearning({ reference: page.items[0].reference })).text).previouslyShown, true);
  assert.equal(previously.facts.result, undefined);
  current = f.current();
  const submitted = await readFixedExperiment({ activity: f.activity, reference, works, readRecord });
  assert.equal(submitted.facts.result.f, '0101');
  assert.ok(submitted.facts.studentPrediction);
  assert.match((await query.readLearning({ reference: page.items[0].reference, range: { offset: 0, length: 16000 } })).text, /0101/);
  await assert.rejects(readFixedExperiment({ activity: f.activity, reference: { ...reference, inputDigest: 'c'.repeat(64) },
    works, readRecord }), { code: 'missing' });
});
