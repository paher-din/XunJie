import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { hostname, platform, arch, release } from 'node:os';

// #212 cross-machine recovery: Windows student client over direct LAN HTTPS.
// Phases drive the original operations, the isolated read-only checks and the post-takeover continuation.
const args = Object.fromEntries(process.argv.slice(2).map(item => {
  const [key, ...rest] = item.replace(/^--/, '').split('=');
  return [key, rest.join('=')];
}));
for (const required of ['phase', 'config', 'out']) assert.ok(args[required], `missing --${required}`);
const config = JSON.parse(await readFile(args.config, 'utf8'));
const state = args.state ? await readFile(args.state, 'utf8').then(content => JSON.parse(content), () => ({})) : {};
const report = { kind: 'cross-machine-recovery-client', phase: args.phase, measuredAt: new Date().toISOString(),
  host: { hostname: hostname(), platform: platform(), arch: arch(), os: release(), node: process.version },
  checks: [], facts: {}, status: 'running' };
const pass = (name, detail) => { report.checks.push({ name, detail }); console.log('PASS ' + name); };
let endpoint = config.sourceEndpoint, cookie = '', namespace = '';
async function request(route, body, extra = {}) {
  const response = await fetch(new URL('/api/learning/' + route, endpoint), {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error',
    headers: { 'content-type': 'application/json', 'x-xj-space': 'school', ...(cookie ? { cookie } : {}),
      ...(namespace ? { 'x-xj-namespace': namespace } : {}), ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let value; try { value = text ? JSON.parse(text) : null; } catch { value = text; }
  return { status: response.status, value, headers: response.headers };
}
async function api(route, body, extra) {
  const result = await request(route, body, extra);
  assert.equal(result.status, 200, route + ': ' + result.status + ':' + JSON.stringify(result.value).slice(0, 300));
  return result.value;
}
async function login(target) {
  endpoint = target;
  const response = await fetch(new URL('/api/learning/login', endpoint), { method: 'POST', redirect: 'error',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginName: config.loginName, password: config.password }) });
  assert.equal(response.status, 200, 'login: ' + response.status);
  const value = await response.json();
  cookie = response.headers.get('set-cookie')?.split(';')[0] ?? ''; assert.ok(cookie);
  assert.equal(value.identity.principalId, config.identity.principalId);
  const context = await api('context'); namespace = context.clientNamespace;
  return { identity: value.identity, context };
}
const until = async (check, description, timeout = 60000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(done => setTimeout(done, 100)); }
  throw new Error(description);
};
const conversation = () => api(`agent/${config.activityId}/conversation`);
async function send(question, delivery) {
  const capabilities = await api(`agent/${config.activityId}/capabilities`);
  const input = { requestId: randomUUID(), scope: { environmentId: config.identity.environmentId, spaceId: config.identity.spaceId,
    principalId: config.identity.principalId, activityId: config.activityId },
    receiver: capabilities.receiver, draft: { token: randomUUID(), question, references: [], bases: [] }, works: [], evidence: [],
    ...(delivery ? { delivery } : {}) };
  await api(`intents/${config.activityId}`, input);
  const accepted = await api(`intents/${config.activityId}/${input.requestId}/dispatch`, {});
  assert.equal(accepted.state, 'accepted');
  return { input, receipt: accepted.receipt, ...JSON.parse(accepted.receipt.detail) };
}
async function respond(text) {
  const value = await conversation(); const question = value.questions[0];
  assert.equal(question.state, 'pending');
  const body = { requestId: randomUUID(), questionVersion: question.version, waitVersion: question.waitVersion,
    answer: { kind: 'text', text } };
  const result = await request(`agent/${config.activityId}/questions/${question.questionId}/responses`, body);
  return { result, body, question };
}
try {
  if (args.phase === 'before') {
    const { context } = await login(config.sourceEndpoint);
    pass('the Windows host authenticated to the Mac school over LAN HTTPS', { endpoint: config.sourceEndpoint, host: hostname() });
    const first = await send('请先提问，并保留这次跨机依据。');
    await until(async () => (await conversation()).questions[0]?.state === 'pending', 'The source school saves the original student Wait.');
    const queued = await send('跨机排队原文。', { version: 1, mode: 'queue', basis: { source: 'explicit', preferenceVersion: 0 } });
    const edit = { version: 1, requestId: randomUUID(), expectedVersion: 1, operation: 'revise', text: '跨机恢复时保留的排队修订。' };
    await api(`agent/${config.activityId}/inputs/${queued.inputId}/control`, edit);
    const original = await conversation();
    Object.assign(state, { runId: first.runId, inputId: queued.inputId, editRequestId: edit.requestId,
      sourceNamespace: context.clientNamespace, sourceCookie: cookie, original });
    report.facts = { runId: first.runId, inputId: queued.inputId, questions: original.questions.length,
      inputs: original.inputs.length, sourceNamespace: context.clientNamespace };
    pass('the original question, queued input and revision are durable before backup', report.facts);
  } else if (args.phase === 'readonly') {
    // The isolated target issues its own session; re-login reads history but cannot advance business.
    await login(config.targetEndpoint);
    const restored = await conversation();
    for (const name of ['messages', 'inputs', 'questions', 'tools']) assert.deepEqual(restored[name], state.original[name], name);
    pass('the isolated target serves the identical original conversation over cross-machine HTTPS', { runId: state.runId });
    const { result } = await respond('隔离副本不应接受回应。');
    assert.equal(result.status, 503, 'isolated write must be refused: ' + result.status);
    pass('the isolated target refuses the student response over HTTPS', { status: result.status });
    report.facts = { isolatedWriteStatus: result.status, identical: true };
  } else if (args.phase === 'after') {
    endpoint = config.targetEndpoint; await login(config.targetEndpoint);
    const oldNamespace = state.sourceNamespace;
    const value = await conversation(); const question = value.questions[0];
    const rejected = await fetch(new URL(`/api/learning/agent/${config.activityId}/questions/${question.questionId}/responses`, endpoint), {
      method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', 'x-xj-space': 'school', cookie, 'x-xj-namespace': oldNamespace },
      body: JSON.stringify({ requestId: randomUUID(), questionVersion: question.version, waitVersion: question.waitVersion, answer: { kind: 'text', text: '旧命名空间不应推进。' } }) });
    assert.equal(rejected.status, 403, 'old namespace must be rejected: ' + rejected.status);
    pass('the retired source client namespace is rejected over cross-machine HTTPS', { status: rejected.status });
    let responseRequestId = state.responseRequestId;
    if (question.state === 'pending') {
      const { result, body } = await respond('这是跨机接管后对原问题的明确回应。');
      assert.equal(result.status, 200); assert.equal(result.value.status, 'accepted');
      responseRequestId = body.requestId;
    }
    const final = await until(async () => { const v = await conversation();
      return v.runs.length === 2 && v.runs.every(run => run.state === 'completed') ? v : null;
    }, 'The original Run and the revised FIFO successor complete after cross-machine takeover.');
    assert.equal(final.runs[0].runId, state.runId);
    const adopted = final.inputs.find(input => input.inputId === state.inputId);
    assert.equal(adopted.state, 'adopted');
    assert.ok(JSON.stringify(final.inputs).includes('跨机恢复时保留的排队修订'));
    report.facts = { runs: final.runs.map(run => ({ runId: run.runId, state: run.state })), adoptedInputId: adopted.inputId,
      responseRequestId, newNamespace: namespace };
    pass('the original response and revised FIFO input continue through the restored school', report.facts);
    Object.assign(state, { finalRuns: report.facts.runs, responseRequestId });
  } else if (args.phase === 'agent-after') {
    // The school authority stays in place; only the independent Agent was restored and re-bound.
    await login(config.sourceEndpoint);
    const { result, body } = await respond('这是跨机独立 Agent 接管后对原问题的明确回应。');
    assert.equal(result.status, 200); assert.equal(result.value.status, 'accepted');
    const final = await until(async () => { const v = await conversation();
      return v.runs.length === 2 && v.runs.every(run => run.state === 'completed') ? v : null;
    }, 'The original Run and the revised FIFO successor complete through the restored independent Agent.');
    assert.equal(final.runs[0].runId, state.runId);
    const adopted = final.inputs.find(input => input.inputId === state.inputId);
    assert.equal(adopted.state, 'adopted');
    assert.ok(JSON.stringify(final.inputs).includes('跨机恢复时保留的排队修订'));
    report.facts = { runs: final.runs.map(run => ({ runId: run.runId, state: run.state })), adoptedInputId: adopted.inputId,
      responseRequestId: body.requestId };
    pass('the original response and revised FIFO input continue through the restored independent Agent', report.facts);
    Object.assign(state, { finalRuns: report.facts.runs, responseRequestId: body.requestId });
  } else throw new Error('unknown phase ' + args.phase);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.failure = error.message; process.exitCode = 1; }
await writeFile(args.out, JSON.stringify(report, null, 2) + '\n');
if (args.state) await writeFile(args.state, JSON.stringify(state, null, 2) + '\n');
console.log(JSON.stringify({ phase: args.phase, status: report.status }));