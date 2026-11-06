import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { openProductRuntime, restoreProductRecovery, resolveCredential } from '@xunjie/product-runtime';
import { openStorage, provisionStorage, createFileBackend } from '@xunjie/storage';
import { createTeachingAgent, createModelGateway, createSpaces, createCourses, createLearningData,
  teachingAgentMigrations, spaceCourseMigrations, learningMigrations, modelMigrations } from '@xunjie/learning-space';
import { actionInputSchema } from '@xunjie/contracts/action-intents';

const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN;
if (!postgresBin) throw new Error('Requires native PostgreSQL 18.6.');
const prompt = { question: '你预计状态 3 再输入 2 会变成几？', source: '当前四态累加活动的先验预测',
  options: [{ id: 'one', label: '1' }, { id: 'three', label: '3' }], allowText: true, skippable: true };

async function until(check, description, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  throw new Error(description);
}
function reply(response, { ask = false, text = '', calls } = {}) {
  const questions = calls ?? (ask ? [{ id: 'ask-prediction', input: prompt }] : []);
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const value of [
    { id: 'student-ask-fixture', choices: [{ index: 0, delta: { role: 'assistant', content: text,
      ...(questions.length ? { tool_calls: questions.map((question, index) => ({ index, id: question.id, type: 'function',
        function: { name: 'student_ask', arguments: JSON.stringify(question.input) } })) } : {}) }, finish_reason: null }] },
    { id: 'student-ask-fixture', choices: [{ index: 0, delta: {}, finish_reason: questions.length ? 'tool_calls' : 'stop' }] },
    { choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } },
  ]) response.write('data: ' + JSON.stringify(value) + '\n\n');
  response.end('data: [DONE]\n\n');
}
async function fixture(answer) {
  const payloads = [], failures = [];
  const controlledAgents = [], controlledStorages = [], controlledServices = [];
  const upstream = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks));
      payloads.push(payload);
      await answer(payload, response, payloads.length);
    } catch (error) { failures.push(error); response.destroy(error); }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const root = await mkdtemp(join(tmpdir(), 'xj-student-ask-'));
  const resources = { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin, postgresVersion: '18.6',
    webRoot: fileURLToPath(new URL('../../web/dist-runtime', import.meta.url)),
    windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) };
  const runtime = openProductRuntime({ root, resources });
  await runtime.install({ profile: 'local' });
  let endpoint = (await runtime.start()).endpoint;
  const raw = async (route, body) => {
    const response = await fetch(new URL('/api/learning/' + route, endpoint), {
      headers: { 'content-type': 'application/json', 'x-xj-space': 'personal' },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const api = async (route, body) => {
    const result = await raw(route, body);
    assert.equal(result.status, 200, route + ': ' + JSON.stringify(result.body));
    return result.body;
  };
  const connectionId = randomUUID(), grantId = randomUUID();
  await api('models/connections', { requestId: randomUUID(), connectionId, expectedVersion: 0,
    name: '明确回应验收', protocol: 'chat-completions', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
    path: '/chat/completions', modelId: 'fixture-student-ask', dialect: 'standard', parameterMode: 'plain', enabled: true,
    contextWindow: 262144, maxOutputTokens: 1024, credential: { action: 'replace', value: 'synthetic-student-ask-key' } });
  await api('models/grants', { requestId: randomUUID(), grantId, connectionId, owner: 'self' });
  await api('models/selection', { requestId: randomUUID(), expectedVersion: 0, source: { kind: 'personal', connectionId, grantId } });
  const activity = await api('activities', { requestId: randomUUID(), goal: '解释四态累加的预测', question: '', references: [] });
  const receiver = (await api(`agent/${activity.activityId}/capabilities`)).receiver;
  const scope = { environmentId: activity.identity.environmentId, spaceId: activity.identity.spaceId,
    principalId: activity.identity.principalId, activityId: activity.activityId };
  return { api, raw, payloads, activity, runtime, resources, root, failures, connectionId,
    modelBaseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
    // The already published Agent options are the host configuration seam for deadlines/budgets.
    // A separate owned schema avoids racing the product's default Agent worker.
    async controlled(options) {
      const environment = JSON.parse(await readFile(join(root, 'environment.json'), 'utf8'));
      const reopen = async (unit, migrations) => {
        const service = environment.services.find(service => service.unit === unit);
        const binding = JSON.parse(await resolveCredential(root, 'storage-' + service.serviceId));
        const storage = await openStorage({ binding, migrations,
          backend: createFileBackend({ id: unit, root: join(root, 'learning-resources', unit) }) });
        controlledStorages.push(storage); return storage;
      };
      const spaces = createSpaces(await reopen('space-course', spaceCourseMigrations)), courses = createCourses(controlledStorages.at(-1), spaces);
      const learning = createLearningData(await reopen('learning-data', learningMigrations), spaces, courses, {});
      const models = await createModelGateway(await reopen('model-connection', modelMigrations),
        { authorize: who => spaces.authorize(who), holder: 'device' });
      controlledServices.push({ learning, models });
      const { credentialRef, ...connection } = await runtime.database();
      const binding = await provisionStorage({ admin: { ...connection, password: await resolveCredential(root, credentialRef) },
        owner: { environmentId: environment.environmentId, serviceId: randomUUID() }, password: randomUUID(), migrations: teachingAgentMigrations });
      const storage = await openStorage({ binding, migrations: teachingAgentMigrations,
        backend: createFileBackend({ id: 'student-question-agent', root: join(root, 'controlled-agent-resources') }) });
      controlledStorages.push(storage);
      const makeAgent = overrides => {
        const agent = createTeachingAgent(storage, { models, authorize: who => spaces.authorize(who),
          identityFor: scope => spaces.lookup(scope.spaceId, scope.principalId), activity: (who, id) => learning.open(who, id),
          start: false, driverId: randomUUID(), scanIntervalMs: 40, ...options, ...overrides });
        controlledAgents.push(agent); return agent;
      };
      const agent = makeAgent();
      return { agent, makeAgent, async send(target = agent) {
        const input = actionInputSchema.parse({ requestId: randomUUID(), scope, receiver: target.receiver.identity,
          draft: { token: randomUUID(), question: '请先问我的预测，再结合回应解释。', references: [], bases: [] }, works: [], evidence: [] });
        const accepted = await target.accept(input, createHash('sha256').update(JSON.stringify(input)).digest('hex'));
        return JSON.parse(accepted.detail).runId;
      } };
    },
    async send(question = '先问我的预测，再结合我的回答解释。') {
      const input = { requestId: randomUUID(), scope, receiver,
        draft: { token: randomUUID(), question, references: [], bases: [] }, works: [], evidence: [] };
      await api(`intents/${activity.activityId}`, input);
      const accepted = await api(`intents/${activity.activityId}/${input.requestId}/dispatch`, {});
      return JSON.parse(accepted.receipt.detail).runId;
    },
    async question(runId) {
      return until(async () => {
        const conversation = await api(`agent/${activity.activityId}/conversation`);
        const question = conversation.questions?.find(question => question.runId === runId);
        if (question && conversation.runs.find(run => run.runId === runId)?.state === 'waiting') return question;
        const run = conversation.runs.find(run => run.runId === runId);
        if (run && ['completed', 'failed', 'paused', 'stopped'].includes(run.state))
          throw new Error('Agent did not persist a student question: ' + JSON.stringify(conversation));
        return null;
      }, 'Agent must present its original durable question and release the Run worker.');
    },
    async restart() { await runtime.stop(); endpoint = (await runtime.start()).endpoint; },
    async close() {
      for (const agent of controlledAgents) { agent.closeDispatch(); agent.close(); }
      await Promise.all(controlledAgents.map(agent => agent.drain()));
      for (const { learning, models } of controlledServices) { models.closeWrites(); await models.checks.drain(); await learning.executions.shutdown(); }
      await Promise.all(controlledStorages.map(storage => storage.close()));
      await runtime.stop(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } };
}

test('student.ask persists an unanswered question across restart and consumes an explicit choice only once', { timeout: 180000 }, async () => {
  const f = await fixture((payload, response, index) => index === 1 ? reply(response, { ask: true })
    : reply(response, { text: '你选择了 1；原状态 3 加 2 后按 4 取余，结果是 1。' }));
  try {
    const runId = await f.send();
    const question = await f.question(runId);
    assert.equal(question.capability, 'student.ask');
    assert.equal(question.state, 'pending');
    assert.equal(question.presentedAt, null, 'Receiving and history reads do not claim display or a student answer.');
    assert.deepEqual(question.options, prompt.options);
    assert.equal(f.payloads.length, 1, 'Waiting holds no second model request.');
    await f.restart();
    assert.deepEqual(await f.question(runId), question);
    assert.equal(f.payloads.length, 1, 'Restart and history reads never generate an answer.');
    const response = { requestId: randomUUID(), questionVersion: question.version, waitVersion: question.waitVersion,
      answer: { kind: 'choice', optionId: 'one' } };
    const route = `agent/${f.activity.activityId}/questions/${question.questionId}/responses`;
    const accepted = await f.api(route, response);
    assert.equal(accepted.status, 'accepted');
    assert.deepEqual(await f.api(route, response), accepted);
    assert.deepEqual(await f.api(`agent/${f.activity.activityId}/responses/${response.requestId}`), accepted,
      'A lost response reply is recovered by the original identity.');
    const conversation = await until(async () => {
      const value = await f.api(`agent/${f.activity.activityId}/conversation`);
      return value.runs.find(run => run.runId === runId)?.state === 'completed' ? value : null;
    }, 'The original Run should resume after the explicit choice.');
    assert.equal(conversation.runs.length, 1);
    assert.equal(conversation.questions[0].state, 'answered');
    assert.equal(conversation.messages.filter(message => message.kind === 'student-response').length, 1);
    assert.match(JSON.stringify(f.payloads[1]), /student-response/);
    assert.match(JSON.stringify(f.payloads[1]), /你预计状态 3 再输入 2/);
    assert.match(JSON.stringify(f.payloads[1]), /one/);
    assert.equal(f.payloads.length, 2);
    const events = await f.api(`agent/${f.activity.activityId}/events`);
    assert.equal(events.filter(event => event.kind === 'question-created').length, 1);
    assert.equal(events.filter(event => event.kind === 'student-response' && event.body.status === 'accepted').length, 1);
    assert.equal(events.filter(event => event.kind === 'wait-consumed' && event.body.waitId === question.waitId).length, 1);
    await f.restart();
    assert.deepEqual(await f.api(`agent/${f.activity.activityId}/responses/${response.requestId}`), accepted);
    assert.equal(f.payloads.length, 2);
    assert.deepEqual(f.failures, []);
  } finally { await f.close(); }
});

test('display acknowledgement never answers a question and response identities keep their original version and content', { timeout: 180000 }, async () => {
  const f = await fixture((_payload, response, index) => index === 1 ? reply(response, { ask: true })
    : reply(response, { text: '已根据你明确选择的 1 继续。' }));
  try {
    const runId = await f.send(), question = await f.question(runId);
    const base = `agent/${f.activity.activityId}`;
    const shown = { requestId: randomUUID(), questionVersion: question.version, waitVersion: question.waitVersion };
    const presentation = await f.api(`${base}/questions/${question.questionId}/presentations`, shown);
    assert.equal(presentation.status, 'presented');
    assert.deepEqual(await f.api(`${base}/questions/${question.questionId}/presentations`, shown), presentation);
    const stillWaiting = await f.question(runId);
    assert.equal(stillWaiting.state, 'pending');
    assert.equal(stillWaiting.response, null);
    assert.ok(stillWaiting.presentedAt);
    assert.equal(f.payloads.length, 1, 'Showing or reading a question is not a model continuation.');
    const input = { requestId: randomUUID(), questionVersion: question.version, waitVersion: question.waitVersion,
      answer: { kind: 'choice', optionId: 'one' } };
    const route = `${base}/questions/${question.questionId}/responses`;
    const stale = await f.api(route, { ...input, requestId: randomUUID(), questionVersion: 2 });
    assert.equal(stale.status, 'rejected');
    assert.equal(stale.reason, 'version-mismatch');
    assert.deepEqual(await f.api(`${base}/responses/${stale.requestId}`), stale);
    const wrong = await f.api(route, { ...input, requestId: randomUUID(), answer: { kind: 'choice', optionId: 'not-an-option' } });
    assert.equal(wrong.reason, 'invalid-answer');
    const accepted = await f.api(route, input);
    assert.equal(accepted.status, 'accepted');
    const changed = await f.raw(route, { ...input, answer: { kind: 'choice', optionId: 'three' } });
    assert.equal(changed.status, 409, 'A stable response identity cannot silently change its answer.');
    const duplicate = await f.api(route, { ...input, requestId: randomUUID() });
    assert.equal(duplicate.status, 'rejected');
    assert.equal(duplicate.reason, 'already-answered');
    await until(async () => (await f.api(`${base}/conversation`)).runs.find(run => run.runId === runId)?.state === 'completed', 'Original Run should finish.');
    const events = await f.api(`${base}/events`);
    assert.equal(events.filter(event => event.kind === 'question-presented' && event.body.status === 'presented').length, 1);
    assert.equal(events.filter(event => event.kind === 'student-response' && event.body.status === 'accepted').length, 1);
    assert.equal(f.payloads.length, 2);
  } finally { await f.close(); }
});

test('stopping a waiting Run retires its question and records a late response without reviving it', { timeout: 180000 }, async () => {
  const f = await fixture((_payload, response, index) => index === 1 ? reply(response, { ask: true })
    : reply(response, { text: 'This continuation must not be dispatched after stop.' }));
  try {
    const runId = await f.send(), question = await f.question(runId), base = `agent/${f.activity.activityId}`;
    await f.api(`${base}/runs/${runId}/stop`, { requestId: randomUUID() });
    const stopped = await until(async () => {
      const value = await f.api(`${base}/conversation`);
      return value.runs.find(run => run.runId === runId)?.state === 'stopped' ? value : null;
    }, 'Stopping must finish without waiting for a student answer.');
    assert.equal(stopped.questions[0].state, 'cancelled');
    assert.equal(stopped.questions[0].response, null);
    const input = { requestId: randomUUID(), questionVersion: question.version, waitVersion: question.waitVersion,
      answer: { kind: 'text', text: '我现在才看到问题，预计为 1。' } };
    const late = await f.api(`${base}/questions/${question.questionId}/responses`, input);
    assert.equal(late.status, 'rejected');
    assert.equal(late.reason, 'cancelled');
    await f.restart();
    assert.deepEqual(await f.api(`${base}/responses/${input.requestId}`), late);
    const after = await f.api(`${base}/conversation`);
    assert.equal(after.runs[0].state, 'stopped');
    assert.equal(after.questions[0].state, 'cancelled');
    assert.equal(f.payloads.length, 1);
    const events = await f.api(`${base}/events`);
    assert.equal(events.filter(event => event.kind === 'question-cancelled').length, 1);
    assert.equal(events.filter(event => event.kind === 'student-response' && event.body.status === 'accepted').length, 0);
  } finally { await f.close(); }
});

test('student waiting expires independently of generation and a late text response cannot restart it', { timeout: 180000 }, async () => {
  const f = await fixture((_payload, response) => reply(response, { ask: true }));
  try {
    const controlled = await f.controlled({ limits: { waitMs: 1000 } }), { agent } = controlled;
    const runId = await controlled.send();
    const question = await until(async () => (await agent.conversation(f.activity.identity, f.activity.activityId)).questions[0], 'A durable question is required.');
    assert.equal(question.state, 'pending');
    agent.resume();
    const expired = await until(async () => {
      const value = await agent.conversation(f.activity.identity, f.activity.activityId);
      return value.runs[0].state === 'paused' ? value : null;
    }, 'The question deadline must close a student Wait without another generation.', 6000);
    assert.equal(expired.questions[0].state, 'expired');
    assert.equal(expired.runs[0].reason, 'student-response-expired');
    assert.equal(expired.questions[0].response, null);
    const late = await agent.respond(f.activity.identity, f.activity.activityId, question.questionId,
      { requestId: randomUUID(), questionVersion: question.version, waitVersion: question.waitVersion,
        answer: { kind: 'text', text: '晚到的中文回答。' } });
    assert.equal(late.status, 'rejected');
    assert.equal(late.reason, 'expired');
    agent.closeDispatch(); await agent.drain(); agent.close();
    const recovered = controlled.makeAgent({ limits: { waitMs: 60000 } }); recovered.resume();
    assert.deepEqual(await recovered.response(f.activity.identity, f.activity.activityId, late.requestId), late);
    const history = await recovered.conversation(f.activity.identity, f.activity.activityId);
    assert.equal(history.runs[0].runId, runId);
    assert.equal(history.runs[0].state, 'paused');
    assert.equal(history.questions[0].deadline, question.deadline, 'Host changes do not extend an existing Wait.');
    assert.equal(f.payloads.length, 1);
  } finally { await f.close(); }
});

test('free text preserves the exact Chinese input and skip is a distinct explicit response', { timeout: 180000 }, async () => {
  const f = await fixture((_payload, response, index) => index % 2 ? reply(response, { ask: true })
    : reply(response, { text: '依据你的明确回应继续；跳过不等于已有预测。' }));
  try {
    const text = '  我预计是 1。\n先把 3 加 2，再对 4 取余。  ';
    const runId = await f.send(), question = await f.question(runId), base = `agent/${f.activity.activityId}`;
    const accepted = await f.api(`${base}/questions/${question.questionId}/responses`, { requestId: randomUUID(),
      questionVersion: 1, waitVersion: 1, answer: { kind: 'text', text } });
    assert.equal(accepted.status, 'accepted');
    const after = await f.api(`${base}/conversation`);
    assert.equal(after.questions[0].response.answer.text, text);
    assert.equal(after.messages.find(message => message.kind === 'student-response').text, text);
    await until(async () => (await f.api(`${base}/conversation`)).runs.find(run => run.runId === runId)?.state === 'completed', 'Text must resume the original Run.');
    const nextRunId = await f.send('请再问一次；这次我会明确跳过。'), next = await f.question(nextRunId);
    const skipped = await f.api(`${base}/questions/${next.questionId}/responses`, { requestId: randomUUID(),
      questionVersion: next.version, waitVersion: next.waitVersion, answer: { kind: 'skip' } });
    assert.equal(skipped.status, 'accepted');
    assert.equal(skipped.reason, 'skipped');
    const finished = await until(async () => {
      const value = await f.api(`${base}/conversation`);
      return value.runs.find(run => run.runId === nextRunId)?.state === 'completed' ? value : null;
    }, 'Explicit skip should continue with its actual meaning.');
    assert.equal(finished.questions.find(question => question.runId === nextRunId).state, 'skipped');
    assert.equal(finished.messages.filter(message => message.kind === 'student-response').length, 2);
    assert.equal(f.payloads.length, 4);
  } finally { await f.close(); }
});

test('a response addressed to another activity keeps its rejection without consuming the original question', { timeout: 180000 }, async () => {
  const f = await fixture((_payload, response, index) => index === 1 ? reply(response, { ask: true }) : reply(response, { text: '按原问题继续。' }));
  try {
    const runId = await f.send(), question = await f.question(runId);
    const other = await f.api('activities', { requestId: randomUUID(), goal: '另一个学习目标', question: '', references: [] });
    const input = { requestId: randomUUID(), questionVersion: question.version, waitVersion: question.waitVersion,
      answer: { kind: 'choice', optionId: 'one' } };
    const rejected = await f.api(`agent/${other.activityId}/questions/${question.questionId}/responses`, input);
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.reason, 'question-missing');
    assert.equal(rejected.runId, null);
    assert.deepEqual(await f.api(`agent/${other.activityId}/responses/${input.requestId}`), rejected);
    assert.equal(await f.api(`agent/${f.activity.activityId}/responses/${input.requestId}`), null);
    assert.equal((await f.question(runId)).state, 'pending');
    assert.equal(f.payloads.length, 1);
    await f.api(`agent/${f.activity.activityId}/runs/${runId}/stop`, { requestId: randomUUID() });
  } finally { await f.close(); }
});

test('an explicit response retains the remaining computation budget and reports its actual exhaustion', { timeout: 180000 }, async () => {
  const f = await fixture((_payload, response) => reply(response, { ask: true }));
  try {
    const controlled = await f.controlled({ limits: { maxModelSteps: 1, waitMs: 60000 } }), { agent } = controlled;
    agent.resume()
    const runId = await controlled.send();
    const question = await until(async () => (await agent.conversation(f.activity.identity, f.activity.activityId)).questions[0], 'Question should be saved.');
    const receipt = await agent.respond(f.activity.identity, f.activity.activityId, question.questionId,
      { requestId: randomUUID(), questionVersion: 1, waitVersion: 1, answer: { kind: 'text', text: '我预计为 1。' } });
    assert.equal(receipt.status, 'accepted');
    const paused = await until(async () => {
      const value = await agent.conversation(f.activity.identity, f.activity.activityId);
      return value.runs[0].state === 'paused' ? value : null;
    }, 'A response does not reset the model-step budget.');
    assert.equal(paused.runs[0].reason, 'model-step-budget-exhausted');
    assert.ok(paused.messages.some(message => message.role === 'system' && /预算/.test(message.text)),
      'Budget exhaustion must not be presented as a missing model.');
    assert.equal(paused.questions[0].state, 'answered');
    assert.deepEqual(paused.runs[0].usage, { state: 'final', inputTokens: 20, outputTokens: 10, totalTokens: 30 });
    agent.closeDispatch(); await agent.drain(); agent.close();
    const recovered = controlled.makeAgent({ limits: { maxModelSteps: 100 } }); recovered.resume();
    assert.equal((await recovered.run(f.activity.identity, f.activity.activityId, runId)).state, 'paused');
    assert.equal(f.payloads.length, 1);
    const events = await recovered.events(f.activity.identity, f.activity.activityId);
    assert.equal(events.filter(event => event.kind === 'budget-reserved').length, 1);
    assert.equal(events.filter(event => event.kind === 'context-assembled').length, 1, 'No model request adopted the response after budget exhaustion.');
  } finally { await f.close(); }
});

test('a Run admits questions serially and competing explicit responses consume each Wait once', { timeout: 180000 }, async () => {
  const f = await fixture((_payload, response, index) => index === 1 ? reply(response, { calls: [
    { id: 'first-prediction', input: { ...prompt, question: '先给出你的预测。' } },
    { id: 'second-reason', input: { ...prompt, question: '再给出一个核对方向。' } },
  ] }) : reply(response, { text: '已核对两份明确回应的原身份。' }));
  try {
    const runId = await f.send(), first = await f.question(runId), base = `agent/${f.activity.activityId}`;
    await new Promise(resolve => setTimeout(resolve, 250));
    const initial = await f.api(`${base}/conversation`);
    assert.equal(initial.questions.filter(question => question.state === 'pending').length, 1,
      'The configured serial tool lane also applies to student questions.');
    const answer = optionId => ({ requestId: randomUUID(), questionVersion: 1, waitVersion: 1, answer: { kind: 'choice', optionId } });
    const competing = await Promise.all([f.api(`${base}/questions/${first.questionId}/responses`, answer('one')),
      f.api(`${base}/questions/${first.questionId}/responses`, answer('three'))]);
    assert.deepEqual(competing.map(receipt => receipt.status).sort(), ['accepted', 'rejected']);
    const next = await until(async () => (await f.api(`${base}/conversation`)).questions.find(question => question.questionId !== first.questionId && question.state === 'pending'),
      'The same Run should admit the next question after the first response.');
    assert.equal(f.payloads.length, 1);
    const input = answer('one'), accepted = await f.api(`${base}/questions/${next.questionId}/responses`, input);
    assert.deepEqual(await f.api(`${base}/questions/${next.questionId}/responses`, input), accepted);
    await until(async () => (await f.api(`${base}/conversation`)).runs.find(run => run.runId === runId)?.state === 'completed', 'Both answers must continue the original native call pair.');
    const events = await f.api(`${base}/events`);
    assert.equal(events.filter(event => event.kind === 'wait-consumed').length, 2);
    assert.equal(events.filter(event => event.kind === 'student-response' && event.body.status === 'accepted').length, 2);
    assert.match(JSON.stringify(f.payloads[1]), new RegExp(competing.find(receipt => receipt.status === 'accepted').requestId));
    assert.match(JSON.stringify(f.payloads[1]), new RegExp(accepted.requestId));
    assert.equal(f.payloads.length, 2);
  } finally { await f.close(); }
});

test('a pending question survives real backup, isolated read-only restore and takeover without regenerating', { timeout: 240000 }, async () => {
  const f = await fixture((_payload, response, index) => index === 1 ? reply(response, { ask: true })
    : reply(response, { text: '接管后按原问题和你的明确回应继续，没有重新提问。' }));
  const directory = await mkdtemp(join(tmpdir(), 'xj-student-question-recovery-'));
  let target;
  try {
    const runId = await f.send(), question = await f.question(runId), context = await f.api('context');
    const key = randomBytes(32);
    await f.runtime.setCredential('student-question-recovery', key.toString('base64'));
    const backup = await f.runtime.recovery.backup({ directory, recoveryKeyRef: 'student-question-recovery', leaveClosed: true });
    const targetRoot = join(directory, 'target');
    const restored = await restoreProductRecovery({ root: targetRoot, resources: f.resources,
      backupDirectory: join(directory, backup.backupId), key });
    for (const owner of restored.owners) await owner.close?.();
    target = openProductRuntime({ root: targetRoot, resources: f.resources });
    let state = await target.start();
    const api = async (route, body, headers = {}) => {
      const response = await fetch(state.endpoint + '/api/learning/' + route, { headers: { 'content-type': 'application/json', 'x-xj-space': 'personal', ...headers },
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    };
    const base = `agent/${f.activity.activityId}`, responseInput = { requestId: randomUUID(), questionVersion: 1,
      waitVersion: 1, answer: { kind: 'choice', optionId: 'one' } };
    assert.equal(state.state, 'maintenance');
    const read = await api(`${base}/conversation`);
    assert.equal(read.status, 200);
    assert.deepEqual(read.body.questions, [question]);
    const readOnlyResponse = await api(`${base}/questions/${question.questionId}/responses`, responseInput);
    assert.equal(readOnlyResponse.status, 503);
    assert.equal(readOnlyResponse.body.error, 'maintenance');
    assert.equal(f.payloads.length, 1, 'Isolated history does not call a model.');
    assert.equal((await target.recovery.takeover({ sourceRoot: f.root, receivers: [] })).phase, 'active');
    const current = await api('context');
    assert.notEqual(current.body.clientNamespace, context.clientNamespace);
    assert.equal((await api(`${base}/questions/${question.questionId}/responses`, responseInput,
      { 'x-xj-namespace': context.clientNamespace })).status, 403, 'The source browser namespace cannot answer after takeover.');
    const accepted = await api(`${base}/questions/${question.questionId}/responses`, responseInput,
      { 'x-xj-namespace': current.body.clientNamespace });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.status, 'accepted');
    await until(async () => (await api(`${base}/conversation`)).body.runs.find(run => run.runId === runId)?.state === 'completed',
      'The restored original Run should continue with the original question.');
    await target.stop(); state = await target.start();
    assert.deepEqual((await api(`${base}/responses/${responseInput.requestId}`)).body, accepted.body);
    assert.equal(f.payloads.length, 2);
  } finally {
    await target?.stop(); await f.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('a new model configuration reconstructs the question behind a prior explicit answer', { timeout: 180000 }, async () => {
  const f = await fixture(async (_payload, response, index) => {
    if (index === 1) reply(response, { ask: true });
    else if (index === 2) await new Promise(resolve => response.once('close', resolve));
    else reply(response, { text: '继续核对原预测及其明确来源。' });
  });
  try {
    const runId = await f.send(), question = await f.question(runId), base = `agent/${f.activity.activityId}`;
    const receipt = await f.api(`${base}/questions/${question.questionId}/responses`, { requestId: randomUUID(),
      questionVersion: 1, waitVersion: 1, answer: { kind: 'choice', optionId: 'one' } });
    await until(() => f.payloads.length === 2, 'The original continuation should be dispatched.');
    await f.api(`${base}/runs/${runId}/stop`, { requestId: randomUUID() });
    await until(async () => (await f.api(`${base}/runs/${runId}`)).state === 'stopped', 'The original request must stop.');
    await f.api('models/connections', { requestId: randomUUID(), connectionId: f.connectionId, expectedVersion: 1,
      name: '明确回应验收', protocol: 'chat-completions', baseUrl: f.modelBaseUrl, path: '/chat/completions',
      modelId: 'fixture-student-ask', dialect: 'standard', parameterMode: 'plain', enabled: true,
      contextWindow: 262144, maxOutputTokens: 2048, credential: { action: 'keep' } });
    const next = await f.send('请基于先前那份明确回应继续解释。');
    await until(async () => (await f.api(`${base}/runs/${next}`)).state === 'completed', 'The new model configuration should use the portable history.');
    assert.ok(JSON.stringify(f.payloads[2]).includes(question.question), 'The response must retain which question it answered.');
    const events = await f.api(`${base}/events`), context = events.find(event => event.kind === 'context-assembled' && event.body.runId === next);
    const snapshot = await f.api(`${base}/snapshots/${context.body.snapshotId}`);
    assert.ok(snapshot.sources.some(source => source.kind === 'student-response' && source.id === receipt.requestId));
    assert.equal(f.payloads.length, 3);
  } finally { await f.close(); }
});
