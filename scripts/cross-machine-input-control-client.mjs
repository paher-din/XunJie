import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { hostname, platform, arch, release } from 'node:os';
import { request as httpsRequest } from 'node:https';

const args = Object.fromEntries(process.argv.slice(2).map(item => {
  const [key, ...rest] = item.replace(/^--/, '').split('=');
  return [key, rest.join('=')];
}));
for (const required of ['phase', 'config', 'state', 'out']) assert.ok(args[required], `missing --${required}`);
const config = JSON.parse(await readFile(args.config, 'utf8'));
const endpoint = config.endpoint;
const report = { kind: 'cross-machine-input-control-client', phase: args.phase,
  measuredAt: new Date().toISOString(),
  host: { hostname: hostname(), platform: platform(), arch: arch(), os: release(), node: process.version },
  endpoint, checks: [], facts: {}, status: 'running' };
const pass = (name, detail) => { report.checks.push({ name, detail }); console.log('PASS ' + name); };
let cookie = '';
let apiVersion = 0;
async function request(route, body) {
  const response = await fetch(new URL('/api/learning/' + route, endpoint), {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error',
    headers: { 'content-type': 'application/json', 'x-xj-space': 'school', ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let value; try { value = text ? JSON.parse(text) : null; } catch { value = text; }
  return { status: response.status, value, headers: response.headers };
}
async function api(route, body) {
  const result = await request(route, body);
  assert.equal(result.status, 200, route + ': ' + result.status + ':' + JSON.stringify(result.value).slice(0, 300));
  return result.value;
}
async function login() {
  const response = await fetch(new URL('/api/learning/login', endpoint), { method: 'POST', redirect: 'error',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginName: config.loginName, password: config.password }) });
  assert.equal(response.status, 200, 'login: ' + response.status);
  const value = await response.json();
  cookie = response.headers.get('set-cookie')?.split(';')[0] ?? '';
  assert.ok(cookie, 'login must return a session cookie');
  assert.equal(value.identity.principalId, config.identity.principalId);
  apiVersion++;
  return value.identity;
}
const until = async (check, description, timeout = 30000) => {
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
function lostStop(activityId, runId, requestId) {
  return new Promise(done => {
    const body = JSON.stringify({ requestId });
    const url = new URL(`/api/learning/agent/${activityId}/runs/${runId}/stop`, endpoint);
    const request = httpsRequest(url, { method: 'POST', headers: { 'content-type': 'application/json',
      'content-length': Buffer.byteLength(body), 'x-xj-space': 'school', cookie } }, response => {
      response.destroy();
      done({ responseStatus: response.statusCode, dropped: true, bodyRead: false });
    });
    request.on('error', error => done({ error: error.code ?? 'request-error', dropped: true, bodyRead: false }));
    request.write(body);
    setTimeout(() => request.destroy(), 120);
  });
}
try {
  await login();
  pass('the Windows host authenticated to the Mac school over LAN HTTPS',
    JSON.stringify({ endpoint, host: report.host.hostname }));

  if (args.phase === 'A') {
    const first = await send('跨机原问题：先保留这条请求的事实。');
    const runId = first.runId;
    await until(async () => {
      const value = await conversation();
      return value.runs.find(run => run.runId === runId && ['received', 'running', 'dispatching', 'waiting'].includes(run.state));
    }, 'the original Run starts.');
    const steering = await send('跨机补充：保留原问题，不重写已发请求。',
      { version: 1, mode: 'steering', basis: { source: 'explicit', preferenceVersion: 0 } });
    const queued = await send('跨机排队：本轮结束后处理。',
      { version: 1, mode: 'queue', basis: { source: 'explicit', preferenceVersion: 0 } });
    assert.equal(steering.runId, runId); assert.equal(queued.runId, runId);
    const received = await conversation();
    const steeringRecord = received.inputs.find(input => input.inputId === steering.inputId);
    const queuedRecord = received.inputs.find(input => input.inputId === queued.inputId);
    assert.equal(steeringRecord?.mode, 'steering'); assert.equal(queuedRecord?.mode, 'queue');
    report.facts.received = { runId, steering: { inputId: steering.inputId, state: steeringRecord?.state, mode: steeringRecord?.mode },
      queue: { inputId: queued.inputId, state: queuedRecord?.state, mode: queuedRecord?.mode }, runState: received.runs.find(run => run.runId === runId)?.state };
    pass('the Mac Agent received steering and queue inputs over the cross-machine connection',
      JSON.stringify(report.facts.received));

    const stopRequestId = randomUUID();
    const lost = await lostStop(config.activityId, runId, stopRequestId);
    assert.equal(lost.dropped, true, 'the client must not receive the stop reply');
    let stopReceipt, retriedStop = false;
    try {
      stopReceipt = await until(async () => {
        const result = await request(`agent/${config.activityId}/controls/${stopRequestId}`);
        return result.status === 200 ? result.value : null;
      }, 'the original stop receipt is queryable by identity.', 8000);
    } catch {
      retriedStop = true;
      await api(`agent/${config.activityId}/runs/${runId}/stop`, { requestId: stopRequestId });
      stopReceipt = await until(async () => {
        const result = await request(`agent/${config.activityId}/controls/${stopRequestId}`);
        return result.status === 200 ? result.value : null;
      }, 'the retried stop receipt is queryable by identity.');
    }
    assert.equal(stopReceipt.operation, 'stop'); assert.equal(stopReceipt.runId, runId);
    const stopped = await until(async () => {
      const value = await conversation();
      const run = value.runs.find(run => run.runId === runId);
      return ['stopped', 'paused'].includes(run?.state) ? value : null;
    }, 'the original Run stops after the lost control reply.');
    const paused = stopped.inputs.filter(input => input.state === 'paused' || input.state === 'pending');
    assert.ok(paused.length > 0, 'stopping must leave unconsumed inputs visible');
    report.facts.stop = { stopRequestId, lost, retriedStop, receipt: { operation: stopReceipt.operation, status: stopReceipt.status },
      runState: stopped.runs.find(run => run.runId === runId)?.state,
      paused: paused.map(input => ({ inputId: input.inputId, state: input.state, mode: input.mode })) };
    pass('a stop whose reply was lost is queryable by the original identity and pauses unconsumed inputs',
      JSON.stringify(report.facts.stop));

    const selected = paused.find(input => input.mode === 'queue') ?? paused[0];
    const continueRequestId = randomUUID();
    await api(`agent/${config.activityId}/runs/${runId}/continue`,
      { version: 2, requestId: continueRequestId, inputs: [{ inputId: selected.inputId, expectedVersion: selected.version }] });
    const completed = await until(async () => {
      const value = await conversation();
      const successor = value.runs.find(run => run.previousRunId === runId);
      return successor?.state === 'completed' ? value : null;
    }, 'the explicitly selected input creates a linked successor that completes.', 40000);
    const successor = completed.runs.find(run => run.previousRunId === runId);
    assert.equal(completed.inputs.find(input => input.inputId === selected.inputId)?.state, 'adopted');
    report.facts.continue = { continueRequestId, selectedInputId: selected.inputId, successorRunId: successor.runId,
      successorState: successor.state, successorPreviousRunId: successor.previousRunId };
    report.facts.state = { runId, stopRequestId, continueRequestId, selectedInputId: selected.inputId, selectedVersion: selected.version,
      successorRunId: successor.runId, steeringInputId: steering.inputId, queuedInputId: queued.inputId };
    pass('the original Run stops and only the explicitly selected input continues in a linked Run',
      JSON.stringify(report.facts.continue));
    await writeFile(args.state, JSON.stringify(report.facts.state, null, 2) + '\n');
  } else if (args.phase === 'B') {
    const state = JSON.parse(await readFile(args.state, 'utf8'));
    const control = await api(`agent/${config.activityId}/controls/${state.stopRequestId}`);
    assert.equal(control.operation, 'stop'); assert.equal(control.runId, state.runId);
    const run = await api(`agent/${config.activityId}/runs/${state.runId}`);
    assert.equal(run.runId, state.runId);
    const value = await conversation();
    const original = value.runs.find(item => item.runId === state.runId);
    const successor = value.runs.find(item => item.runId === state.successorRunId);
    const selected = value.inputs.find(item => item.inputId === state.selectedInputId);
    assert.ok(original); assert.ok(successor); assert.equal(successor.previousRunId, state.runId);
    assert.equal(selected?.state, 'adopted');
    report.facts.afterRestart = { control: { requestId: control.requestId, operation: control.operation, status: control.status, runId: control.runId },
      originalRun: { runId: original.runId, state: original.state },
      successorRun: { runId: successor.runId, state: successor.state, previousRunId: successor.previousRunId },
      selectedInput: { inputId: selected.inputId, state: selected.state } };
    pass('after the school restart the original control, Run and successor are still queryable by their original identities',
      JSON.stringify(report.facts.afterRestart));
    await writeFile(args.state, JSON.stringify({ ...state, verifiedAfterRestart: true }, null, 2) + '\n');
  } else throw new Error('invalid phase');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error?.message ?? String(error);
  console.error('FAIL', report.error);
  process.exitCode = 1;
} finally {
  await writeFile(args.out, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, phase: report.phase, checks: report.checks.length, error: report.error ?? null }));
}
