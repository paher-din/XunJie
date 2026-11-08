import { probeEvidenceFile, writeEvidence, hasProbeEvidence } from './lib/probe-evidence.mjs';
import { readFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { parseArgs, digest, createLearningApi, expectOk as ok, loginMember, remoteDevice } from './remote-probe-helpers.mjs';
import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

/**
 * Runs on the school execution node after the native-session acceptance: it proves that losing
 * eligibility really refuses control and reads of a run that is already live, that the refusal is
 * the account/course projection and not a broken session, and that the execution owner can still
 * reclaim the process when nobody is allowed to drive it.
 */
const args = parseArgs();
const endpoint = args.endpoint, controlFile = args.control, payloadFile = args.payload, stateFile = args.state;
const out = probeEvidenceFile(args.out, 'remote-withdrawal-state.json');
if (!endpoint || !controlFile || !payloadFile || !stateFile)
  throw new Error('usage: --endpoint=URL --control=FILE --payload=FILE --state=FILE [--out=FILE] [--device-state=FILE | --platform=macos-arm64|windows-x64]');
const token = (await readFile(controlFile, 'utf8')).trim();
const payload = JSON.parse(await readFile(payloadFile, 'utf8'));
const previous = JSON.parse(await readFile(stateFile, 'utf8'));
const device = await remoteDevice(args, payload, previous);
const manifest = payload.component.manifest, session = manifest.session;

const exec = promisify(execFile);
const api = createLearningApi(endpoint, token);
/** The refusal must be the authorization decision itself, not a missing run or a broken route. */
const refused = (label, result) => {
  if (result.status !== 403) throw new Error(`${label} answered ${result.status} instead of refusing: `
    + JSON.stringify(result.value).slice(0, 200));
  return { label, status: result.status, error: result.value?.error ?? null };
};

const login = async () => (await loginMember(endpoint, payload)).headers;
const admin = input => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json', ...input });

const evidence = [];
const note = entry => { evidence.push(entry); return entry };

// The same member and the same course pack the session acceptance used.
let student = await login();
const activity = ok('activity-read', await api(`activities/${previous.activityId}`, undefined, student));
const instanceId = `${activity.activityId}:accumulator`;
// The digest the activity really carries, not one recomputed here.
const binding = activity.course?.components?.find(item => item.key === 'accumulator');
if (!binding) throw new Error('the activity lost the component binding');
const definitionDigest = binding.definition.digest;
const actionOf = requestId => ({
  protocolVersion: 2, kind: 'execution', requestId,
  scope: { environmentId: activity.identity.environmentId, spaceId: activity.identity.spaceId,
    principalId: activity.identity.principalId, activityId: activity.activityId },
  receiver: { receiverId: 'school-native-execution', location: 'remote', kind: 'execution' },
  execution: {
    ...(device ? { device } : {}),
    instance: { instanceId, key: 'accumulator', componentId: manifest.componentId,
      componentVersion: manifest.version, definitionDigest,
      hostApiVersion: manifest.hostApiVersion, stateVersion: manifest.stateVersion },
    operation: { operationId: session.operation.operationId, effect: 'input' },
    parameters: {},
    basis: { works: [], state: null, expected: { stateContentId: null }, resources: [] },
    limits: { timeMs: session.budgets.operationTimeoutMs, memoryPages: 1, inputBytes: session.budgets.inputBytes,
      outputBytes: session.budgets.outputBytes, concurrentJobs: session.budgets.concurrentSessions,
      queuedJobs: session.budgets.queuedSessions },
    plan: { planId: 'native-session', planVersion: 1, location: 'native', kind: 'session',
      planDigest: digest({ planId: 'native-session', planVersion: 1, componentId: manifest.componentId,
        componentVersion: manifest.version, operationId: session.operation.operationId }) },
    session: { adapterId: session.adapterId, adapterVersion: session.adapterVersion,
      limits: { operationTimeoutMs: session.budgets.operationTimeoutMs, idleMs: session.budgets.idleMs,
        maxMs: session.budgets.maxMs, memoryMiB: session.budgets.memoryMiB,
        concurrentSessions: session.budgets.concurrentSessions, queuedSessions: session.budgets.queuedSessions } },
    initiator: { kind: 'student', principalId: activity.identity.principalId },
  },
});
const controlOf = (value, seq) => ({ controlId: randomUUID(), operationId: session.operation.operationId,
  effect: 'input', expectedSeq: seq, parameters: { value } });
const path = `executions/${activity.activityId}`;
const membership = active => api('manage/membership',
  { requestId: randomUUID(), principalId: previous.principalId, active }, admin());
const access = active => api('manage/course-access',
  { requestId: randomUUID(), courseId: previous.courseId, principalId: previous.principalId, active }, admin());

const requestId = randomUUID();
const accepted = ok('accept', await api(path, { action: actionOf(requestId) }, student));
if (accepted.state !== 'running') throw new Error('the node did not start the session: '
  + JSON.stringify({ state: accepted.state, reason: accepted.reason }));
const unit = 'xj-session-' + accepted.session.executorInstanceId;
let final;
try {
const first = ok('control', await api(`${path}/${requestId}/control`, controlOf(1, 0), student));

// 1. The membership itself is withdrawn while the run is live.
ok('membership-off', await membership(false));
note({ step: 'membership-withdrawn', unit, appliedBefore: first.session.observation.applied });
note({ step: 'control-refused-after-withdrawal', ...refused('control', await api(`${path}/${requestId}/control`, controlOf(2, 1), student)) });
note({ step: 'read-refused-after-withdrawal', ...refused('read', await api(`${path}/${requestId}`, undefined, student)) });
note({ step: 'list-refused-after-withdrawal', ...refused('list', await api(path, undefined, student)) });
note({ step: 'login-refused-after-withdrawal',
  ...refused('login', await fetch(new URL('/api/learning/login', endpoint), { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ loginName: payload.loginName, password: payload.password }) })
    .then(async response => ({ status: response.status, value: await response.json().catch(() => null) }))) });

// 2. Restoring eligibility restores the same run: the refusal was the projection, not the process.
ok('membership-on', await membership(true));
student = await login();
const resumed = ok('control-after-restore', await api(`${path}/${requestId}/control`, controlOf(2, 1), student));
note({ step: 'control-restored', applied: resumed.session.observation.applied, value: resumed.session.observation.value });

// 3. Course eligibility is a second, independent axis: the account stays active, the course does not.
ok('access-off', await access(false));
note({ step: 'control-refused-without-course-access', ...refused('control', await api(`${path}/${requestId}/control`, controlOf(2, 2), student)) });

// 4. Nobody may drive the run, so the execution owner reclaims the process through its own
// maintenance route; no out-of-band root command stands in for the product.
const reclaimed = await api('manage/native-reclaim', { sessionRef: accepted.executionRef });
note({ step: 'owner-reclaim', unit, status: reclaimed.status,
  state: reclaimed.value?.state ?? null, statusKnowledge: reclaimed.value?.statusKnowledge ?? null });
if (reclaimed.status !== 200 || reclaimed.value?.state !== 'cancelled'
  || reclaimed.value?.statusKnowledge !== 'confirmed')
  throw new Error('the owner did not confirm the reclaimed process: ' + JSON.stringify({
    httpStatus: reclaimed.status, state: reclaimed.value?.state, statusKnowledge: reclaimed.value?.statusKnowledge,
    stopRequested: reclaimed.value?.stopRequested, reason: reclaimed.value?.reason }));
const deadline = Date.now() + 20000;
let state = null;
while (Date.now() < deadline) {
  const { stdout } = await exec('systemctl', ['show', unit + '.service', '--property=ActiveState', '--no-pager'],
    { timeout: 15000, windowsHide: true });
  state = Object.fromEntries(stdout.split('\n').map(line => line.split('=')).filter(pair => pair.length === 2));
  if (state.ActiveState === 'inactive' || state.ActiveState === 'failed') break;
  await new Promise(done => setTimeout(done, 500));
}
if (!state || !['inactive', 'failed'].includes(state.ActiveState)) throw new Error('the unit did not stop: ' + JSON.stringify(state));
note({ step: 'unit-stopped', activeState: state.ActiveState, unit });

// 5. The record survives: after the access returns, the owner's own stop is visible and confirmed.
ok('access-on', await access(true));
final = ok('read-after-owner-stop', await api(`${path}/${requestId}`, undefined, student));
if (final.statusKnowledge !== 'confirmed') throw new Error('the settled run is not confirmed: ' + JSON.stringify(final));
if (!['failed', 'cancelled'].includes(final.state)) throw new Error('the run kept an impossible state: ' + final.state);
note({ step: 'settled', state: final.state, statusKnowledge: final.statusKnowledge, reason: final.reason ?? null });
} finally {
  // 即使断言失败，也恢复验收账号资格，并通过产品所有者回收会话。
  const cleanup = await Promise.allSettled([
    membership(true).then(result => ok('cleanup-membership', result)),
    access(true).then(result => ok('cleanup-access', result)),
    api('manage/native-reclaim', { sessionRef: accepted.executionRef }).then(result => ok('cleanup-reclaim', result)),
  ]);
  const failures = cleanup.filter(result => result.status === 'rejected').map(result => result.reason);
  if (failures.length) throw new AggregateError(failures, 'withdrawal probe cleanup failed');
}

const result = { endpoint, device, activityId: activity.activityId, requestId, executionRef: accepted.executionRef,
  principalId: previous.principalId, unit, nodeId: accepted.session.nodeId, evidence };
await mkdir(dirname(out), { recursive: true });
await writeEvidence(out, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ out: hasProbeEvidence(out) ? out : null, requestId, unit, steps: evidence.map(item => item.step),
  settled: { state: final.state, statusKnowledge: final.statusKnowledge } }));
