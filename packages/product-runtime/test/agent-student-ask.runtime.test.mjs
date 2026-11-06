import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime';
import { createFileBackend, openStorage } from '@xunjie/storage';
import { teachingAgentMigrations } from '@xunjie/learning-space';
import { teachingAgentCapabilitiesSchema, teachingConversationSchema, teachingRunSchema,
  teachingStudentResponseReceiptSchema, teachingStudentPresentationReceiptSchema,
  teachingSnapshotSchema } from '@xunjie/contracts/teaching-agent';

const resources = { nodePath: process.execPath, nodeVersion: '24.21.0',
  postgresBin: process.env.XUNJIE_PRODUCT_POSTGRES_BIN, postgresVersion: '18.6',
  webRoot: fileURLToPath(new URL('../../../apps/web/dist-runtime', import.meta.url)),
  windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) };
if (!resources.postgresBin) throw new Error('Requires native PostgreSQL 18.6.');

const prompt = { question: '你预计状态 3 再输入 2 会变成几？', source: '当前四态累加活动的先验预测',
  options: [{ id: 'one', label: '1' }, { id: 'three', label: '3' }], allowText: true, skippable: true };
const finalText = '你选择了 1；原状态 3 加 2 后按 4 取余，结果是 1。';

async function until(check, description) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(description);
}

// Only the SDK upstream is synthetic. Both installations use their real PostgreSQL,
// production child processes, authenticated service connections and browser HTTP routes.
test('independent Agent student.ask preserves explicit responses, expiry and original Run identities', { timeout: 240000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xj-agent-student-ask-'));
  const schoolRoot = join(directory, 'school'), agentRoot = join(directory, 'agent');
  const school = openProductRuntime({ root: schoolRoot, resources });
  const agent = openProductRuntime({ root: agentRoot, resources });
  const dependencyConnectionId = randomUUID(), agentConnectionId = randomUUID();
  const payloads = [], upstreamFailures = [];
  let askNext = false, clockStorage;
  const upstream = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      payloads.push(JSON.parse(Buffer.concat(chunks)));
      const asking = payloads.length === 1 || askNext;
      askNext = false;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const value of [
        { id: 'standalone-student-ask', choices: [{ index: 0, delta: { role: 'assistant', content: asking ? '' : finalText,
          ...(asking ? { tool_calls: [{ index: 0, id: 'ask-prediction-' + payloads.length, type: 'function',
            function: { name: 'student_ask', arguments: JSON.stringify(prompt) } }] } : {}) }, finish_reason: null }] },
        { id: 'standalone-student-ask', choices: [{ index: 0, delta: {}, finish_reason: asking ? 'tool_calls' : 'stop' }] },
        { choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } },
      ]) response.write('data: ' + JSON.stringify(value) + '\n\n');
      response.end('data: [DONE]\n\n');
    } catch (error) { upstreamFailures.push(error); response.destroy(error); }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  try {
    await school.install({ profile: 'local' });
    let schoolState = await school.start();
    await agent.install({ profile: 'agent', agent: { dependencyConnectionId } });
    const agentState = await agent.start();
    const agentService = agentState.environment.services.find(service => service.unit === 'teaching-agent');
    const dataService = schoolState.environment.services.find(service => service.unit === 'learning-data');
    assert.ok(agentService); assert.ok(dataService);
    assert.deepEqual(agentState.environment.services.map(service => service.unit).sort(), ['client', 'teaching-agent']);
    const schoolProcess = JSON.parse(await readFile(join(schoolRoot, 'instance.json'), 'utf8'));
    const agentProcess = JSON.parse(await readFile(join(agentRoot, 'instance.json'), 'utf8'));
    assert.notEqual(schoolProcess.pid, agentProcess.pid);
    assert.notEqual(schoolProcess.pid, process.pid); assert.notEqual(agentProcess.pid, process.pid);

    const raw = async (route, body, headers = {}) => {
      const response = await fetch(new URL('/api/learning/' + route, schoolState.endpoint), {
        headers: { 'content-type': 'application/json', 'x-xj-space': 'personal', ...headers },
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    };
    const api = async (route, body, headers) => {
      const result = await raw(route, body, headers);
      assert.equal(result.status, 200, route + ': ' + JSON.stringify(result.body));
      return result.body;
    };
    const activity = await api('activities', { requestId: randomUUID(), goal: '独立 Agent 的明确提问', question: '', references: [] });
    const grant = await agent.authorize({ sourceEnvironmentId: dataService.environmentId, sourceServiceId: dataService.serviceId,
      sourceInstallationId: schoolState.environment.installationId, capabilities: ['teaching.agent'] }, agentService.serviceId);
    await school.connect({ connectionId: agentConnectionId, sourceEnvironmentId: dataService.environmentId, sourceServiceId: dataService.serviceId,
      target: agentService, requiredCapabilities: ['teaching.agent'], optionalCapabilities: [], credentialRef: 'student-ask-agent' }, grant.token);
    await api('manage/agent-binding', { requestId: randomUUID(), identity: activity.identity,
      connectionId: agentConnectionId, target: agentService, installationId: agentState.environment.installationId },
    { authorization: 'Bearer ' + await resolveCredential(schoolRoot, 'control') });
    const dependencyGrant = await school.authorize({ sourceEnvironmentId: agentService.environmentId, sourceServiceId: agentService.serviceId,
      sourceInstallationId: agentState.environment.installationId, capabilities: ['teaching.dependencies'] }, dataService.serviceId);
    await agent.connect({ connectionId: dependencyConnectionId, sourceEnvironmentId: agentService.environmentId, sourceServiceId: agentService.serviceId,
      target: { ...dataService, capabilities: ['teaching.dependencies'] }, requiredCapabilities: ['teaching.dependencies'], optionalCapabilities: [],
      credentialRef: 'student-ask-dependencies' }, dependencyGrant.token);

    const connectionId = randomUUID(), grantId = randomUUID();
    await api('models/connections', { requestId: randomUUID(), connectionId, expectedVersion: 0, name: '独立 Agent 提问回归',
      protocol: 'chat-completions', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, path: '/chat/completions',
      modelId: 'standalone-student-ask-fixture', dialect: 'standard', parameterMode: 'plain', enabled: true,
      contextWindow: 262144, maxOutputTokens: 1024, credential: { action: 'replace', value: 'synthetic-student-ask-key' } });
    await api('models/grants', { requestId: randomUUID(), connectionId, grantId, owner: 'self' });
    await api('models/selection', { requestId: randomUUID(), expectedVersion: 0, source: { kind: 'personal', connectionId, grantId } });
    const base = `agent/${activity.activityId}`;
    const { receiver } = teachingAgentCapabilitiesSchema.parse(await api(`${base}/capabilities`));
    assert.equal(receiver.receiverId, 'teaching-agent:' + agentService.serviceId);
    const other = await api('activities', { requestId: randomUUID(), goal: '另一活动', question: '', references: [] });
    const otherBase = `agent/${other.activityId}`;
    assert.equal(teachingAgentCapabilitiesSchema.parse(await api(`${otherBase}/capabilities`)).receiver.receiverId, receiver.receiverId);
    const requestId = randomUUID();
    await api(`intents/${activity.activityId}`, { requestId, receiver,
      scope: { environmentId: activity.identity.environmentId, spaceId: activity.identity.spaceId,
        principalId: activity.identity.principalId, activityId: activity.activityId },
      draft: { token: randomUUID(), question: '先问我的预测，再根据明确回应解释。', references: [], bases: [] }, works: [], evidence: [] });
    const dispatched = await api(`intents/${activity.activityId}/${requestId}/dispatch`, {});
    assert.equal(dispatched.state, 'accepted');
    const runId = JSON.parse(dispatched.receipt.detail).runId;
    const conversation = () => api(`${base}/conversation`).then(value => teachingConversationSchema.parse(value));
    const pending = await until(async () => {
      const value = await conversation(), run = value.runs.find(run => run.runId === runId);
      if (['completed', 'failed', 'stopped', 'paused'].includes(run?.state))
        assert.fail('The Agent did not wait for a student: ' + JSON.stringify(value));
      return run?.state === 'waiting' && value.questions.length === 1 ? value : null;
    }, 'The browser conversation must expose the independently owned pending question.');
    const [question] = pending.questions;
    assert.equal(pending.runs.length, 1);
    assert.equal(question.state, 'pending'); assert.equal(question.response, null); assert.equal(question.presentedAt, null);
    assert.equal(question.runId, runId); assert.equal(question.capability, 'student.ask');
    assert.equal(question.question, prompt.question); assert.deepEqual(question.options, prompt.options);
    assert.ok(payloads[0].tools.some(tool => tool.function?.name === 'student_ask'));
    assert.equal(payloads.length, 1);

    await agent.stop(); await agent.start();
    assert.deepEqual((await conversation()).questions[0], question, 'An Agent restart preserves the original unanswered question.');
    const shown = { requestId: randomUUID(), questionVersion: question.version, waitVersion: question.waitVersion };
    const presentationRoute = `${base}/questions/${question.questionId}/presentations`;
    const presentation = teachingStudentPresentationReceiptSchema.parse(await api(presentationRoute, shown));
    assert.equal(presentation.status, 'presented');
    assert.deepEqual(teachingStudentPresentationReceiptSchema.parse(await api(presentationRoute, shown)), presentation);
    const stillWaiting = await conversation();
    assert.equal(stillWaiting.questions[0].state, 'pending'); assert.equal(stillWaiting.questions[0].response, null);
    assert.ok(stillWaiting.questions[0].presentedAt);
    assert.equal(stillWaiting.runs[0].state, 'waiting'); assert.equal(payloads.length, 1, 'Presentation is not an explicit answer.');

    const answer = { requestId: randomUUID(), questionVersion: question.version, waitVersion: question.waitVersion,
      answer: { kind: 'choice', optionId: 'one' } };
    const crossed = teachingStudentResponseReceiptSchema.parse(await api(`${otherBase}/questions/${question.questionId}/responses`,
      { ...answer, requestId: randomUUID() }));
    assert.equal(crossed.status, 'rejected'); assert.equal(crossed.reason, 'question-missing'); assert.equal(crossed.runId, null);
    assert.equal(await api(`${base}/responses/${crossed.requestId}`), null, 'Cross-activity receipts are not disclosed.');
    const crossedPresentation = teachingStudentPresentationReceiptSchema.parse(await api(`${otherBase}/questions/${question.questionId}/presentations`,
      { ...shown, requestId: randomUUID() }));
    assert.equal(crossedPresentation.status, 'ignored'); assert.equal(crossedPresentation.reason, 'question-missing');
    assert.equal((await conversation()).questions[0].state, 'pending'); assert.equal(payloads.length, 1);
    assert.deepEqual(teachingConversationSchema.parse(await api(`${otherBase}/conversation`)).questions, []);

    const responseRoute = `${base}/questions/${question.questionId}/responses`;
    assert.equal(await api(`${base}/responses/${answer.requestId}`), null);
    const accepted = teachingStudentResponseReceiptSchema.parse(await api(responseRoute, answer));
    assert.equal(accepted.status, 'accepted'); assert.equal(accepted.runId, runId);
    const receiptRoute = `${base}/responses/${answer.requestId}`;
    assert.deepEqual(teachingStudentResponseReceiptSchema.parse(await api(responseRoute, answer)), accepted);
    assert.deepEqual(teachingStudentResponseReceiptSchema.parse(await api(receiptRoute)), accepted,
      'A lost browser reply is recovered through the original response receipt.');
    assert.equal(await api(`${otherBase}/responses/${answer.requestId}`), null);
    assert.equal((await raw(responseRoute, { ...answer, answer: { kind: 'choice', optionId: 'three' } })).status, 409,
      'A response identity cannot be reused with different content.');
    assert.equal((await raw(`${otherBase}/questions/${question.questionId}/responses`, answer)).status, 409,
      'An accepted response identity cannot be reused under another activity.');

    const completed = await until(async () => {
      const value = await conversation();
      return value.runs.find(run => run.runId === runId)?.state === 'completed' ? value : null;
    }, 'The explicit response must resume and complete the same Run over the independent Agent connection.');
    assert.equal(completed.runs.length, 1); assert.equal(completed.runs[0].runId, runId);
    assert.equal(teachingRunSchema.parse(await api(`${base}/runs/${runId}`)).state, 'completed');
    assert.equal(completed.questions[0].state, 'answered'); assert.equal(completed.questions[0].response.requestId, answer.requestId);
    assert.deepEqual(completed.questions[0].response.answer, answer.answer);
    assert.equal(completed.messages.filter(message => message.kind === 'student-response').length, 1);
    assert.equal(completed.messages.at(-1).text, finalText);
    const wait = completed.waits.find(wait => wait.waitId === question.waitId);
    assert.equal(wait.state, 'consumed');
    const tool = completed.tools.find(tool => tool.commandId === question.commandId);
    assert.equal(tool.effect, 'ask'); assert.equal(tool.state, 'settled'); assert.equal(tool.outcome, 'completed');
    assert.equal(payloads.length, 2);
    assert.match(JSON.stringify(payloads[1]), /student-response/);
    assert.ok(JSON.stringify(payloads[1]).includes(prompt.question));
    assert.ok(JSON.stringify(payloads[1]).includes(answer.requestId));
    assert.ok(JSON.stringify(payloads[1]).includes('one'));
    const events = await api(`${base}/events`);
    assert.equal(events.filter(event => event.kind === 'question-created').length, 1);
    assert.equal(events.filter(event => event.kind === 'question-presented' && event.body.status === 'presented').length, 1);
    assert.equal(events.filter(event => event.kind === 'student-response' && event.body.status === 'accepted').length, 1);
    assert.equal(events.filter(event => event.kind === 'wait-consumed' && event.body.waitId === question.waitId).length, 1);
    const lastContext = events.filter(event => event.kind === 'context-assembled').at(-1);
    const snapshot = teachingSnapshotSchema.parse(await api(`${base}/snapshots/${lastContext.body.snapshotId}`));
    assert.ok(snapshot.sources.some(source => source.kind === 'student-response' && source.id === answer.requestId));

    await agent.stop(); await agent.start();
    await school.stop(); schoolState = await school.start();
    assert.deepEqual(teachingStudentResponseReceiptSchema.parse(await api(receiptRoute)), accepted);
    assert.deepEqual(teachingStudentResponseReceiptSchema.parse(await api(responseRoute, answer)), accepted);
    assert.deepEqual(await conversation(), completed, 'Both product processes retain the same completed Run and question after restart.');
    assert.equal(payloads.length, 2, 'Receipt recovery and retries must not dispatch another SDK request.');

    askNext = true;
    const expiringRequest = randomUUID();
    await api(`intents/${activity.activityId}`, { requestId: expiringRequest, receiver,
      scope: { environmentId: activity.identity.environmentId, spaceId: activity.identity.spaceId,
        principalId: activity.identity.principalId, activityId: activity.activityId },
      draft: { token: randomUUID(), question: '这次等待超过期限后保留原提问。', references: [], bases: [] }, works: [], evidence: [] });
    const expiringReceipt = await api(`intents/${activity.activityId}/${expiringRequest}/dispatch`, {});
    const expiringRunId = JSON.parse(expiringReceipt.receipt.detail).runId;
    const expiringQuestion = await until(async () => (await conversation()).questions.find(question =>
      question.runId === expiringRunId && question.state === 'pending'), 'The independent Agent must save the next question.');
    assert.equal(payloads.length, 3);
    // Advance only this fixture's durable deadline. The production Agent must
    // perform expiry, native call pairing and terminal transitions itself.
    const binding = JSON.parse(await resolveCredential(agentRoot, 'storage-' + agentService.serviceId));
    clockStorage = await openStorage({ binding, migrations: teachingAgentMigrations,
      backend: createFileBackend({ id: 'teaching-agent', root: join(agentRoot, 'learning-resources/teaching-agent') }) });
    await clockStorage.request({ requestId: randomUUID(), fingerprint: 'advance-student-question-deadline' }, async tx => {
      await tx.query('UPDATE teaching_waits SET deadline=clock_timestamp()-interval \'1 second\' WHERE wait_id=$1', [expiringQuestion.waitId]);
      return null;
    });
    await clockStorage.close(); clockStorage = undefined;
    const lateAnswer = { requestId: randomUUID(), questionVersion: expiringQuestion.version,
      waitVersion: expiringQuestion.waitVersion, answer: { kind: 'text', text: '这是超期后的迟到回应。' } };
    const lateRoute = `${base}/questions/${expiringQuestion.questionId}/responses`;
    const rejected = teachingStudentResponseReceiptSchema.parse(await api(lateRoute, lateAnswer));
    assert.equal(rejected.status, 'rejected'); assert.equal(rejected.reason, 'expired');
    const expired = await until(async () => {
      const value = await conversation(), run = value.runs.find(run => run.runId === expiringRunId);
      return run?.state === 'paused' && run.reason === 'student-response-expired' ? value : null;
    }, 'The independent Agent must pair its expired call and pause the original Run.');
    assert.equal(expired.questions.find(question => question.questionId === expiringQuestion.questionId).state, 'expired');
    assert.equal(expired.tools.find(tool => tool.commandId === expiringQuestion.commandId).state, 'settled');
    assert.equal(payloads.length, 3, 'Expiry and a late response do not generate a continuation.');
    await agent.stop(); await agent.start();
    assert.deepEqual(teachingStudentResponseReceiptSchema.parse(await api(`${base}/responses/${lateAnswer.requestId}`)), rejected);
    assert.deepEqual(teachingStudentResponseReceiptSchema.parse(await api(lateRoute, lateAnswer)), rejected);

    const followup = randomUUID();
    await api(`intents/${activity.activityId}`, { requestId: followup, receiver,
      scope: { environmentId: activity.identity.environmentId, spaceId: activity.identity.spaceId,
        principalId: activity.identity.principalId, activityId: activity.activityId },
      draft: { token: randomUUID(), question: '超期后显式开启下一个问题。', references: [], bases: [] }, works: [], evidence: [] });
    const followupReceipt = await api(`intents/${activity.activityId}/${followup}/dispatch`, {});
    const followupRunId = JSON.parse(followupReceipt.receipt.detail).runId;
    await until(async () => (await conversation()).runs.find(run => run.runId === followupRunId)?.state === 'completed',
      'An expired native call must not block a subsequent explicit request.');
    assert.equal(payloads.length, 4);
    assert.deepEqual(upstreamFailures, []);
  } finally {
    await clockStorage?.close();
    await Promise.allSettled([agent.stop(), school.stop()]);
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
