import assert from 'node:assert/strict';
import { test } from 'node:test';
import { componentStateName } from '@xunjie/contracts/components';
import { aluCaseFromAction, aluResultAllowedBeforeSubmission } from '@xunjie/contracts/alu-learning';
import { anyExecutionActionSchema } from '@xunjie/contracts/execution';
import { authorizedPredictionPhase, capturedPrediction, predictionPhase } from '../dist/teaching-stage.js';
import { cLanguageCase, digitalLogicCase } from './fixtures/context-engineering-cases.mjs';
import { createConversationCompaction } from '../dist/capabilities/context-compaction/conversation.js';

const identity = { kind: 'school', environmentId: 'e', spaceId: 's', principalId: 'p' };
const stateFile = (content) => ({ objectId: 'o', contentId: 'c', name: componentStateName('alu'), kind: 'state',
  encoding: 'json', mediaType: 'application/json', value: JSON.stringify({ content }) });
function activity(predictionGate = true) {
  return { identity, target: { environmentId: 'e', serviceId: 's', unit: 'learning-space' },
    goal: 'ALU', question: '', references: [], status: 'open', createdAt: new Date().toISOString(),
    course: { helpPolicy: { version: 1, questions: 'allowed', scope: 'course',
      ...(predictionGate ? { predictionGate: { formatVersion: 1, hideResultsBeforePrediction: true } } : {}) },
    components: [{ key: 'alu', definition: { manifest: { formatVersion: 3, runtime: { adapterId: 'icarus-alu' } } } }] } };
}
const action = (file, references = []) => ({ works: [file], draft: { bases: [], references, question: '' } });

test('预测门只隐藏未提交的实际结果，并保留自由实验与其他课程', () => {
  assert.equal(predictionPhase(activity(), action(stateFile({ feedbackPolicy: 'hold', caseRequestId: '' }))), 'pending');
  assert.equal(predictionPhase(activity(), action(stateFile({ feedbackPolicy: 'hold', caseRequestId: 'exec-1' }))), 'submitted');
  assert.equal(predictionPhase(activity(), action(stateFile({ feedbackPolicy: 'live' }))), 'free-observation');
  assert.equal(predictionPhase(activity(false), action(stateFile({ feedbackPolicy: 'hold', caseRequestId: '' }))), 'not-required');
});

test('课程预测门覆盖 run-single 与 check-all，不把运行状态当成观察结果', () => {
  const state = stateFile({ feedbackPolicy: 'hold', caseRequestId: '' });
  const execution = operationId => ({ protocolVersion: 3, kind: 'execution', requestId: '77777777-7777-4777-8777-777777777777',
    execution: { operation: { operationId }, basis: { runtime: { adapterId: 'icarus-alu' },
      works: [state], expected: { stateContentId: 'c' } } } });
  const policy = activity().course.helpPolicy;
  assert.equal(aluResultAllowedBeforeSubmission(execution('run-single'), policy), false);
  assert.equal(aluResultAllowedBeforeSubmission(execution('check-all'), policy), false);
  const live = stateFile({ feedbackPolicy: 'live' });
  assert.equal(aluResultAllowedBeforeSubmission({ ...execution('run-single'), execution: {
    ...execution('run-single').execution, basis: { ...execution('run-single').execution.basis, works: [live] } } }, policy), true);
});

test('只有原始执行命令、当前状态和预测修订一致时才认定预测已提交', async () => {
  const activityId = '11111111-1111-4111-8111-111111111111';
  const componentId = '22222222-2222-4222-8222-222222222222';
  const requestId = '33333333-3333-4333-8333-333333333333';
  const enabledRequestId = '44444444-4444-4444-8444-444444444444';
  const executionRef = '55555555-5555-4555-8555-555555555555';
  const stateContentId = '66666666-6666-4666-8666-666666666666';
  const draft = { formatVersion: 1, caseId: '77777777-7777-4777-8777-777777777777',
    revisionId: '88888888-8888-4888-8888-888888888888', purpose: 'custom',
    predictedF: '0000', predictedCout: '1', reason: 'A+B 溢出，低四位为 0',
    helpReported: false, priorSources: [] };
  const enabledBasis = JSON.stringify({ requestId: enabledRequestId, inputDigest: 'b'.repeat(64), executionRef,
    definitionDigest: 'a'.repeat(64) });
  const content = { A: 15, B: 1, M: 1, S: 0, Cin: 1, caseDraft: JSON.stringify(draft),
    caseRequestId: requestId, feedbackPolicy: 'hold', enabledBasis };
  const state = { objectId: '99999999-9999-4999-8999-999999999999', contentId: stateContentId,
    name: componentStateName('alu'), kind: 'state', encoding: 'json', mediaType: 'application/json',
    value: JSON.stringify({ formatVersion: 1, instanceId: 'alu-instance', componentId, version: 1,
      definitionDigest: 'a'.repeat(64), stateVersion: 3,
      operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', content }) };
  const code = { objectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', contentId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    name: 'alu.sv', kind: 'code', encoding: 'utf8', mediaType: 'text/plain', value: 'module alu; endmodule' };
  const control = { A: 15, B: 1, M: 1, S: 0, Cin: 1 };
  const action = { protocolVersion: 3, kind: 'execution', requestId,
    scope: { environmentId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      spaceId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', principalId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      activityId },
    receiver: { receiverId: 'alu-executor', location: 'local', kind: 'execution' },
    execution: { instance: { instanceId: 'alu-instance', key: 'alu', componentId, componentVersion: 1,
      definitionDigest: 'a'.repeat(64), hostApiVersion: 1, stateVersion: 3 },
      operation: { operationId: 'observe-enabled', effect: 'execute' }, parameters: control,
      basis: { enabledBy: { requestId: enabledRequestId, inputDigest: 'b'.repeat(64), executionRef },
        works: [code, state],
        runtime: { adapterId: 'icarus-alu', adapterVersion: 1, bundleIdentity: '1'.repeat(64),
          resources: [{ resourceId: '12121212-1212-4212-8212-121212121212', sha256: '2'.repeat(64),
            byteLength: 1, path: 'scaffold.v', role: 'scaffold', mediaType: 'text/plain' }] },
        compile: { top: 'alu', entryFiles: ['alu.sv'], includeDirs: [] },
        observation: { scaffoldResourceId: '12121212-1212-4212-8212-121212121212', scaffoldVersion: 1,
          ports: { result: 'F', carry: 'Cout' }, resultFormat: 'xunjie-observations-v1' },
        course: { releaseId: '13131313-1313-4313-8313-131313131313', behaviorRuleDigest: '3'.repeat(64),
          planDigest: '4'.repeat(64) }, expected: { stateContentId } },
      limits: { compileTimeoutMs: 1000, simulateTimeoutMs: 100, jobTimeoutMs: 1000, memoryMiB: 16,
        inputBytes: 1024, textBytes: 1024, vcdBytes: 1024, resultBytes: 1024, concurrentJobs: 1, queuedJobs: 0 },
      plan: { planId: 'alu-job', planVersion: 1, planDigest: '5'.repeat(64), location: 'browser', kind: 'job' },
      initiator: { kind: 'student', principalId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' } } };
  assert.doesNotThrow(() => anyExecutionActionSchema.parse(action));
  const course = { releaseId: '13131313-1313-4313-8313-131313131313', courseName: '数字逻辑',
    taskTitle: 'ALU', contentDigest: '6'.repeat(64), objectives: ['验证 ALU'], requirements: '先预测',
    materials: [], starterWorks: [], capabilities: [],
    components: [{ key: 'alu', definition: { manifest: { formatVersion: 3,
      runtime: { adapterId: 'icarus-alu', adapterVersion: 1 } }, digest: 'a'.repeat(64) },
      configuration: { title: 'ALU' }, materialIds: [] }],
    helpPolicy: { version: 1, questions: 'allowed', scope: 'course',
      predictionGate: { formatVersion: 1, hideResultsBeforePrediction: true } } };
  const activity = { activityId, identity: { kind: 'school', environmentId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    spaceId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', principalId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' },
    target: { environmentId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', serviceId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', unit: 'learning-data' },
    goal: 'ALU', question: '', references: [], status: 'open', createdAt: new Date().toISOString(), course };
  const input = { works: [state, code], draft: { bases: [], references: [], question: '核对预测' } };
  const record = { requestId, actionText: JSON.stringify(action) };
  assert.ok(aluCaseFromAction(action));
  const captured = await capturedPrediction(activity, input, async id => id === requestId ? record : null);
  assert.equal(captured?.capture.draft.revisionId, draft.revisionId);
  assert.equal(await authorizedPredictionPhase(activity, input, async () => record), 'submitted');
  const changed = { ...input, works: [{ ...state, value: JSON.stringify({ ...JSON.parse(state.value),
    content: { ...content, A: 14 } }) }, code] };
  assert.equal(await authorizedPredictionPhase(activity, changed, async () => record), 'pending');
});

test('第一批固定案例保留不同作品版本、学生预测和工具结果', () => {
  assert.notEqual(digitalLogicCase.workV7.contentId, digitalLogicCase.workV8.contentId);
  assert.equal(digitalLogicCase.prediction.predictedCout, '1');
  assert.equal(digitalLogicCase.execution.output.cout, '1');
  assert.notEqual(cLanguageCase.workV3.contentId, cLanguageCase.workV4.contentId);
  assert.match(cLanguageCase.testOutput, /observed 6/);
});

test('压缩源只选完整旧 Turn，C 语言新版本和测试反馈一起保留', () => {
  const { select } = createConversationCompaction({ policy: { recentTokens: 1 } });
  const history = [
    { id: 'v3-message', turnId: 'old-turn', role: 'user', version: 1, text: cLanguageCase.workV3.value },
    { id: 'v3-prediction', turnId: 'old-turn', role: 'user', version: 1, text: cLanguageCase.prediction },
    { id: 'v4-message', turnId: 'current-turn', role: 'user', version: 1, text: cLanguageCase.workV4.value },
    { id: 'v4-correction', turnId: 'current-turn', role: 'user', version: 1, text: cLanguageCase.correction },
    { id: 'v4-test', turnId: 'current-turn', role: 'assistant', version: 1, text: cLanguageCase.testOutput },
  ];
  const source = select(history, []);
  assert.deepEqual(source.messages, history.slice(0, 2));
  assert.deepEqual(source.remainder, history.slice(2));
});

test('压缩按 10% C-R 的 token 目标保留近期组，不按消息条数', () => {
  const compaction = createConversationCompaction({ policy: { recentTokens: 1 } });
  const history = Array.from({ length: 8 }, (_, index) => ({
    id: 'turn-' + index, turnId: 'turn-' + index, role: 'user', version: 1, text: 'x'.repeat(1200),
  }));
  const source = compaction.select(history, [], { currentInputTokens: 52_800, recentTokens: 1_500 });
  assert.ok(source);
  const recentTokens = source.remainder.reduce((sum, entry) =>
    sum + Math.ceil(Buffer.byteLength(JSON.stringify([entry]), 'utf8') / 3), 0);
  assert.ok(recentTokens >= 1_500, '近期部分至少达到 token 目标');
  assert.ok(source.remainder.length >= 1 && source.remainder.length < history.length);
  assert.deepEqual(source.remainder, history.slice(source.messages.length));
  assert.ok(source.remainder.some(entry => entry.turnId === 'turn-7'));
  const prompt = JSON.parse(compaction.provider.prompt(source).text);
  assert.equal(prompt.messages.some(message => message.turnId === 'turn-7'), false,
    '最近组只出现在 remainder，不进入摘要输入');
});

test('没有安全闭合旧区间时返回 null，保留原上下文', () => {
  const compaction = createConversationCompaction({ policy: { recentTokens: 5_600 } });
  const history = [
    { id: 'current-question', turnId: 'current', role: 'user', version: 1, text: '当前问题' },
    { id: 'current-tool', turnId: 'current', role: 'assistant', version: 1, text: '未闭合工具批次', toolName: 'read_work' },
  ];
  assert.equal(compaction.select(history, [], { recentTokens: 5_600 }), null);
});

test('同一 Turn 的工具调用与结果不会被压缩切点拆开', () => {
  const compaction = createConversationCompaction({ policy: { recentTokens: 1 } });
  const history = [
    { id: 'old-user', turnId: 'old', role: 'user', version: 1, text: '旧问题' },
    { id: 'call-1', turnId: 'pair', role: 'assistant', version: 1, text: '调用工具', toolName: 'read_work' },
    { id: 'result-1', turnId: 'pair', role: 'user', version: 1, text: '工具结果', kind: 'tool-result', attemptId: 'call-1', nativeCallId: 'native-1' },
    { id: 'call-2', turnId: 'pair', role: 'assistant', version: 1, text: '再次调用', toolName: 'read_work' },
    { id: 'result-2', turnId: 'pair', role: 'user', version: 1, text: '工具结果 2', kind: 'tool-result', attemptId: 'call-2', nativeCallId: 'native-2' },
  ];
  const source = compaction.select(history, [], { recentTokens: 1 });
  const summarized = new Set(source.messages.map(entry => entry.id));
  assert.equal(summarized.has('call-1'), summarized.has('result-1'), '调用与结果必须同进同出');
  assert.equal(summarized.has('call-2'), summarized.has('result-2'), '第二批也必须同进同出');
  assert.deepEqual(source.remainder.map(entry => entry.id), ['call-1', 'result-1', 'call-2', 'result-2'],
    '最新未闭合工具批次整体保留');
});
