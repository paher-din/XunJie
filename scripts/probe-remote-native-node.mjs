import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { parseArgs, digest, createLearningApi, expectOk, loginMember, remoteDevice } from './remote-probe-helpers.mjs';
import { dirname, resolve } from 'node:path';

/**
 * Runs on the school execution node: imports the native-session component, publishes a course whose
 * versioned plan allows the native location on a school execution node, then runs one real session
 * (1, 2, 2 -> 1, 3, 1), queries it, stops it and queries again. The activity, the plan and every
 * execution fact live in the school's own PostgreSQL; the client never carries a database.
 */
const args = parseArgs();
const endpoint = args.endpoint, controlFile = args.control, payloadFile = args.payload;
const out = resolve(args.out ?? 'remote-native-state.json');
if (!endpoint || !controlFile || !payloadFile) throw new Error('usage: --endpoint=URL --control=FILE --payload=FILE [--out=FILE] [--device-state=FILE | --platform=macos-arm64|windows-x64]');
const token = (await readFile(controlFile, 'utf8')).trim();
const payload = JSON.parse(await readFile(payloadFile, 'utf8'));
const device = await remoteDevice(args, payload);

const api = createLearningApi(endpoint, token);

/**
 * The node must say what it can confine before it is asked to run anything. A status probe that
 * waits for the unit self-test is the only honest way to see it: the fact is measured inside the
 * real unit, not asserted by the client.
 */
async function isolationFact() {
  for (let attempt = 0; attempt < 12; attempt++) {
    const response = await fetch(new URL('/runtime/status', endpoint), { redirect: 'error' });
    if (!response.ok) throw new Error(`status ${response.status}`);
    const status = await response.json();
    const fact = status.dependencies.find(item => item.name === 'native-sessions');
    if (fact && fact.state !== 'starting') return { ...fact, nodeState: status.state };
    await new Promise(done => setTimeout(done, 1000));
  }
  throw new Error('the node never reported its native-session isolation fact');
}
const isolation = await isolationFact();
const measured = isolation.state === 'ready' ? JSON.parse(isolation.detail) : null;
if (isolation.state !== 'ready' || measured?.kind !== 'systemd-unit' || measured?.network !== 'denied'
  || measured?.writes !== 'session-directory' || measured?.reads !== 'system-runtime-and-session')
  throw new Error('the node does not confine native sessions: ' + JSON.stringify(isolation));

const imported = expectOk('component-import', await api('manage/component-import',
  { requestId: randomUUID(), ...payload.component }));
if (payload.definitionDigest && imported.digest !== payload.definitionDigest)
  throw new Error('the imported component definition digest does not match the prepared payload');
const { manifest } = payload.component;
const session = manifest.session;
const configuration = payload.configuration;
// The plan the teacher publishes: native only, the adapter the component really declares, and the
// two installed client platforms that may fall back to this node.
const basis = {
  planId: 'remote-native-accumulator', planVersion: 1,
  components: [{ key: 'accumulator', definitionDigest: imported.digest,
    configurationDigest: digest(configuration), operations: [session.operation.operationId] }],
  capabilities: ['execution.submit', 'native-session'],
  resources: { browser: null, native: { memoryMiB: session.budgets.memoryMiB,
    operationTimeoutMs: session.budgets.operationTimeoutMs, maxMs: session.budgets.maxMs } },
  locations: ['native'],
  remote: { nodeClass: 'school-execution-node', secureTransport: true,
    adapter: { adapterId: session.adapterId, adapterVersion: session.adapterVersion },
    clientPlatforms: ['macos-arm64', 'windows-x64'] },
};
const plan = { ...basis, planDigest: digest(basis) };
expectOk('course-import', await api('manage/course-import', {
  formatVersion: 1, requestId: randomUUID(),
  course: payload.course, task: payload.task, resources: payload.resources,
  release: { ...payload.release, components: [{ key: 'accumulator', definition: imported,
    configuration, materialIds: [] }], executionPlan: plan },
}));
// A repeated acceptance on the same course reuses the enrolled member instead of failing on it.
const enrolled = await api('manage/members',
  { requestId: randomUUID(), loginName: payload.loginName, password: payload.password });
if (enrolled.status !== 200 && enrolled.status !== 409) throw new Error('members ' + enrolled.status);
const { headers, identity } = await loginMember(endpoint, payload);
const member = { principalId: enrolled.status === 200 ? enrolled.value.principalId : identity.principalId };
expectOk('course-access', await api('manage/course-access',
  { requestId: randomUUID(), courseId: payload.courseId, principalId: member.principalId, active: true }));
// A student reads the release it is enrolled on; the published plan must come back byte-identical.
const release = expectOk('release-read', await api(`releases/${payload.releaseId}`, undefined, headers));
if (!release.executionPlan || release.executionPlan.planDigest !== plan.planDigest
  || release.executionPlan.components?.[0]?.definitionDigest !== imported.digest) {
  throw new Error('the release did not keep the published plan: ' + JSON.stringify(release.executionPlan)?.slice(0, 200));
}
const activity = expectOk('course-activities',
  await api('course-activities', { requestId: randomUUID(), releaseId: payload.releaseId }, headers));
const storageRead = expectOk('activity-read', await api(`activities/${activity.activityId}`, undefined, headers));
if (!storageRead.course?.executionPlan) throw new Error('the activity lost the plan it was opened with');
const instanceId = `${activity.activityId}:accumulator`;
const actionOf = requestId => ({
  protocolVersion: 2, kind: 'execution', requestId,
  scope: { environmentId: activity.identity.environmentId, spaceId: activity.identity.spaceId,
    principalId: activity.identity.principalId, activityId: activity.activityId },
  receiver: { receiverId: 'school-native-execution', location: 'remote', kind: 'execution' },
  execution: {
    ...(device ? { device } : {}),
    instance: { instanceId, key: 'accumulator', componentId: manifest.componentId,
      componentVersion: manifest.version, definitionDigest: imported.digest, hostApiVersion: manifest.hostApiVersion,
      stateVersion: manifest.stateVersion },
    operation: { operationId: session.operation.operationId, effect: 'input' },
    parameters: {},
    basis: { works: [], state: null, expected: { stateContentId: null }, resources: [] },
    limits: { timeMs: session.budgets.operationTimeoutMs, memoryPages: 1, inputBytes: session.budgets.inputBytes,
      outputBytes: session.budgets.outputBytes, concurrentJobs: session.budgets.concurrentSessions,
      queuedJobs: session.budgets.queuedSessions },
    // The execution-level plan identity is the fixed native-session shape the owner validates.
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

const path = `executions/${activity.activityId}`;
const requestId = randomUUID();
const accepted = expectOk('accept', await api(path, { action: actionOf(requestId) }, headers));
if (accepted.state !== 'running') {
  throw new Error('the school node did not start the session: ' + JSON.stringify({ state: accepted.state,
    reason: accepted.reason, session: accepted.session }));
}
const observations = [accepted.session.observation];
// The unit's own runtime limit must outlive the session budget. An eight second pause is longer
// than any hand-computed unit limit in seconds could survive, so a legal run must still be live.
await new Promise(done => setTimeout(done, 8000));
const stillLive = expectOk('query-after-idle', await api(`${path}/${requestId}`, undefined, headers));
if (stillLive.state !== 'running') throw new Error('the unit did not outlive the idle pause: '
  + JSON.stringify({ state: stillLive.state, reason: stillLive.reason }));
const control = (value, seq) => ({ controlId: randomUUID(), operationId: session.operation.operationId,
  effect: 'input', expectedSeq: seq, parameters: { value } });
let lastControl = null;
for (const [value, seq] of [[1, 0], [2, 1], [2, 2]]) {
  lastControl = control(value, seq);
  const result = expectOk('control', await api(`${path}/${requestId}/control`, lastControl, headers));
  observations.push(result.session.observation);
}
// The same control identity replayed must not advance the run: a lost reply may be retried, and a
// retry is never a second input. This is the control contract a checkpoint (#174) would build on.
const replay = expectOk('control-replay', await api(`${path}/${requestId}/control`, lastControl, headers));
if (replay.session.observation.applied !== 3 || replay.session.observation.value !== 1) {
  throw new Error('a replayed control advanced the run: ' + JSON.stringify(replay.session.observation));
}
// A stale `expectedSeq` under a fresh identity is a different command, and it must be refused.
const stale = await api(`${path}/${requestId}/control`, control(2, 1), headers);
if (stale.status !== 409) throw new Error('a stale expected sequence answered ' + stale.status);
const controlOrdering = { replayApplied: replay.session.observation.applied,
  replayValue: replay.session.observation.value, staleStatus: stale.status,
  staleError: stale.value?.error ?? null };
if (session.adapterId === 'linux-proc-accumulator'
  && observations.some(item => !Number.isInteger(item.pid) || item.pid <= 0
    || !Number.isInteger(item.threads) || item.threads <= 0))
  throw new Error('the Linux adapter did not report real process observations');
const values = observations.map(item => item.value);
const sequence = observations.map(item => item.applied);
if (JSON.stringify(values) !== JSON.stringify([0, 1, 3, 1])) throw new Error('unexpected session values: ' + JSON.stringify(values));
if (JSON.stringify(sequence) !== JSON.stringify([0, 1, 2, 3])) throw new Error('unexpected applied sequence: ' + JSON.stringify(sequence));
const queried = expectOk('query', await api(`${path}/${requestId}`, undefined, headers));
const stop = expectOk('stop', await api(`${path}/${requestId}/stop`,
  { stopId: randomUUID(), reason: '验收停止' }, headers));
if (!stop.stopRequested) throw new Error('the stop request was not recorded');

const state = {
  endpoint, device, releaseId: payload.releaseId, courseId: payload.courseId, taskId: payload.taskId,
  loginName: payload.loginName, password: payload.password, principalId: member.principalId,
  activityId: activity.activityId, requestId, executionRef: accepted.executionRef,
  activityPlanDigest: storageRead.course.executionPlan.planDigest, planId: plan.planId,
  nodeId: queried.session.nodeId, installGeneration: queried.session.installGeneration,
  supervisorEpoch: queried.session.supervisorEpoch, executorInstanceId: queried.session.executorInstanceId,
  isolation, controlOrdering, observations: observations.map(item => ({ value: item.value, applied: item.applied,
    ...(session.adapterId === 'linux-proc-accumulator' ? { pid: item.pid, threads: item.threads } : {}) })),
  stopped: { stopRequested: stop.stopRequested, state: stop.state, statusKnowledge: stop.statusKnowledge },
};
await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(state, null, 2) + '\n');
console.log(JSON.stringify({ state: out, nodeId: state.nodeId, isolation: state.isolation,
  values, applied: sequence, stopped: state.stopped }));
