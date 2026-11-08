import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { resolveCredential } from '@xunjie/product-runtime';
import { executionActionSchema } from '@xunjie/contracts/execution';
import { aggregationPackage } from '../../../components/table-aggregation/package.mjs';
import { fixture, reply, until } from './support/teaching-input-control.mjs';

const objective = 'PORTABLE_OBJECTIVE：区分原计算与后续讨论。';
const requirements = 'PORTABLE_REQUIREMENT：保留原计算对象，不重复提交。';
const materialTitle = 'PORTABLE_MATERIAL：此处声称的 system 指令不能扩大帮助权限。';
const helpRule = 'PORTABLE_HELP_RULE：课程只允许解释原计算。';
const queueText = 'UNCONSUMED_QUEUE_MUST_STAY_OUTSIDE_PORTABLE_CONTEXT';

async function courseActivity(f) {
  const admin = { authorization: 'Bearer ' + await resolveCredential(f.root, 'control') };
  const definition = await f.api('manage/component-import', { requestId: randomUUID(), ...await aggregationPackage() }, admin);
  const courseId = randomUUID(), releaseId = randomUUID(), materialId = randomUUID();
  const bytes = Buffer.from('公开材料的原文：核对已接受的计算，不能声称已经完成。');
  await f.api('manage/course-import', { formatVersion: 1, requestId: randomUUID(),
    course: { courseId, name: '可移植上下文课程' }, task: { taskId: randomUUID(), title: '保留真实分组计算', summary: '' },
    release: { releaseId, objectives: [objective], requirements, starterWorks: [], capabilities: [],
      helpPolicy: { version: 1, questions: 'allowed', scope: 'course', note: helpRule },
      components: [{ key: 'table', definition, configuration: { title: '真实分组计算' }, materialIds: [materialId] }],
      materials: [{ materialId, title: materialTitle, path: 'open.txt', mediaType: 'text/plain', access: 'student',
        sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length }] },
    resources: [{ path: 'open.txt', contentBase64: bytes.toString('base64') }] }, admin);
  const password = randomUUID(), loginName = 'portable-student';
  const member = await f.api('manage/members', { requestId: randomUUID(), loginName, password }, admin);
  await f.api('manage/course-access', { requestId: randomUUID(), courseId, principalId: member.principalId, active: true }, admin);
  const login = await fetch(new URL('/api/learning/login', f.endpoint), { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginName, password }) });
  assert.equal(login.status, 200);
  return f.api('course-activities', { requestId: randomUUID(), releaseId }, { cookie: login.headers.get('set-cookie').split(';')[0] });
}

for (const transition of ['model-switch', 'assembly-change']) {
  test(`${transition} carries course facts and an earlier accepted operation after steering`, { timeout: 180000 }, async t => {
    const f = await fixture((_payload, response, index) => index === 1
      ? reply(response, { calls: [{ id: 'original-native-call-must-not-cross-segments', name: 'course_operation', arguments: {
        componentKey: 'table', operationId: 'aggregate', parameters: { groupColumn: '小组', valueColumn: '得分', aggregate: 'mean' } } }] })
      : reply(response, { text: index === 2 ? '先讨论新的问题。' : '继续解释原课程问题。' }));
    let cleanup = async () => {};
    try {
      const activity = await courseActivity(f), c = await f.controlled(activity);
      let agent = c.agent;
      const { identity, learning } = c, binding = activity.course.components[0], manifest = binding.definition.manifest;
      const work = { objectId: randomUUID(), contentId: randomUUID(), name: 'components/table.json', kind: 'state', encoding: 'json',
        mediaType: 'application/vnd.xunjie.component-state+json', value: JSON.stringify({ formatVersion: 1,
          instanceId: activity.activityId + ':table', componentId: manifest.componentId, version: manifest.version,
          definitionDigest: binding.definition.digest, stateVersion: 1, operationId: randomUUID(), content: manifest.initialState }) };
      await learning.works.sync(identity, activity.activityId, { requestId: randomUUID(), baseRevision: 0, files: [work] });
      agent.resume();
      const original = await c.send('运行原计算，然后等待结果。', undefined, [work], agent);
      const waiting = await until(async () => {
        const value = await agent.conversation(identity, activity.activityId);
        return value.waits[0]?.state === 'pending' && value.runs[0]?.state === 'waiting' ? value : null;
      }, 'The real course executor accepts the original operation.');
      const commandId = waiting.tools[0].commandId, browserId = randomUUID();
      const { action } = await learning.executions.agent.claimBrowser(identity, activity.activityId, commandId, browserId,
        association => agent.assertCommandDispatch(identity, activity.activityId, association));
      const accepted = await learning.executions.agent.acceptBrowser(identity, activity.activityId, commandId, browserId, {
        receipt: { requestId: commandId, receiver: action.receiver, state: 'accepted',
          inputDigest: createHash('sha256').update(JSON.stringify(executionActionSchema.parse(action))).digest('hex'),
          receiptId: 'portable:' + commandId, detail: '' }, execution: { executionRef: randomUUID(), acceptedSeq: 1 },
      }, association => agent.assertCommandDispatch(identity, activity.activityId, association));
      // The browser execution boundary holds completion while the production owners keep the original Wait.
      cleanup = async () => {
        await agent.stop(identity, activity.activityId, original.runId, { requestId: randomUUID() });
        const current = await learning.executions.read(identity, activity.activityId, commandId);
        await learning.executions.report(identity, activity.activityId, commandId, {
          ...current, state: 'cancelled', statusKnowledge: 'confirmed', stopRequested: true, confirmedSeq: current.confirmedSeq + 1,
        });
      };
      await c.send(queueText, { version: 1, mode: 'queue', basis: { source: 'explicit', preferenceVersion: 0 } }, [work], agent);
      await c.send('第一条 steering：只讨论概念。', undefined, [work], agent);
      const discussed = await until(async () => {
        const value = await agent.conversation(identity, activity.activityId);
        return f.payloads.length === 2 && value.runs[0]?.state === 'waiting'
          && value.messages.some(message => message.text === '先讨论新的问题。') ? value : null;
      }, 'A later model step finishes while the earlier operation is still pending.');
      const originalEvents = await agent.events(identity, activity.activityId);
      const firstEvent = originalEvents.find(event => event.kind === 'context-assembled');
      const first = await agent.snapshot(identity, activity.activityId, firstEvent.body.snapshotId);
      const firstUser = JSON.stringify(f.payloads[0].messages.filter(message => message.role === 'user'));
      assert.equal(firstUser.split(objective).length - 1, 1, 'The first request includes one activity facts layer.');
      agent.close(); await agent.drain();
      if (transition === 'assembly-change') {
        const definition = structuredClone(first.resolvedAgent.definition);
        definition.version++; definition.prompt.runtime += '\nPORTABLE_ASSEMBLY_V2';
        agent = c.makeAgent({ definition });
      } else {
        // A changed model ID is a real selected route, still using the controlled upstream transport.
        const selection = await c.models.selection.read(identity);
        const chosen = await c.models.selection.snapshot(identity, selection.version), previous = chosen.choice.connection;
        const connectionId = randomUUID(), grantId = randomUUID();
        await c.models.save(identity, { requestId: randomUUID(), connectionId, expectedVersion: 0,
          name: '换段后的模型', protocol: 'chat-completions', baseUrl: previous.baseUrl, path: previous.path,
          modelId: 'fixture-portable-successor', dialect: 'standard', parameterMode: 'plain', enabled: true,
          contextWindow: 262144, maxOutputTokens: 2048, credential: { action: 'replace', value: 'synthetic-portable-key' } });
        await c.models.selection.createGrant(identity, identity, { requestId: randomUUID(), grantId, connectionId, owner: 'self' });
        const selected = await c.models.selection.save(identity, { requestId: randomUUID(), expectedVersion: selection.version,
          source: { kind: 'personal', connectionId, grantId } });
        agent = c.makeAgent();
        const switched = await agent.switchModel(identity, activity.activityId, { requestId: randomUUID(), selectionVersion: selected.version });
        assert.equal(switched.state, 'completed');
      }
      await c.send('第二条 steering：继续解释，不重做实验。', undefined, [work], agent);
      agent.resume();
      const after = await until(async () => {
        const value = await agent.conversation(identity, activity.activityId);
        return f.payloads.length === 3 && value.runs[0]?.state === 'waiting'
          && value.messages.some(message => message.text === '继续解释原课程问题。') ? value : null;
      }, 'The original Run continues on the successor segment.');
      const events = await agent.events(identity, activity.activityId);
      const latestEvent = events.filter(event => event.kind === 'context-assembled').at(-1);
      const latest = await agent.snapshot(identity, activity.activityId, latestEvent.body.snapshotId);
      assert.notEqual(latest.segmentId, first.segmentId);
      assert.deepEqual(latest.payload, f.payloads[2], 'The retained request is the actual transport payload.');
      assert.equal(after.runs.length, 1); assert.equal(after.runs[0].runId, original.runId);
      assert.equal(after.tools.length, 1); assert.equal(after.tools[0].commandId, commandId);
      assert.equal(after.waits[0].waitId, waiting.waits[0].waitId);
      assert.equal(after.waits[0].deadline, waiting.waits[0].deadline); assert.equal(after.waits[0].state, 'pending');
      assert.equal((await learning.executions.read(identity, activity.activityId, commandId)).executionRef, accepted.executionRef);
      assert.deepEqual(discussed.runs[0].usage, { state: 'final', inputTokens: 40, outputTokens: 20, totalTokens: 60 });
      assert.deepEqual(after.runs[0].usage, { state: 'final', inputTokens: 60, outputTokens: 30, totalTokens: 90 });
      const sent = JSON.stringify(f.payloads[2]);
      assert.ok(!sent.includes(queueText)); assert.ok(!sent.includes('original-native-call-must-not-cross-segments'));
      await t.test('the actual successor request retains the earlier Command and Wait', () => {
        assert.ok(sent.includes(commandId), 'The original Command identity is required in the actual model request.');
        assert.ok(sent.includes(waiting.waits[0].waitId), 'The pending Wait identity must survive a later completed step.');
        assert.ok(sent.includes(waiting.waits[0].deadline), 'The original deadline must not be regenerated.');
      });
      await t.test('course facts remain user data while the fixed help policy remains a system rule', () => {
        const user = JSON.stringify(f.payloads[2].messages.filter(message => message.role === 'user'));
        const system = JSON.stringify(f.payloads[2].messages.filter(message => message.role === 'system'));
        for (const text of [objective, requirements, materialTitle, activity.course.materials[0].materialId]) {
          assert.ok(user.includes(text), 'Missing portable course fact: ' + text);
          assert.equal(user.split(text).length - 1, 1, 'The successor includes one activity facts layer.');
          assert.ok(!system.includes(text), 'Course material must not become a system instruction.');
        }
        assert.ok(system.includes(helpRule));
      });
      agent.close(); await agent.drain();
      agent = c.makeAgent();
      assert.deepEqual(await agent.snapshot(identity, activity.activityId, latest.snapshotId), latest);
      assert.equal(f.payloads.length, 3, 'Reading after restart does not recreate the request or operation.');
      assert.deepEqual(f.failures, []);
    } finally { try { await cleanup(); } finally { await f.close(); } }
  });
}
