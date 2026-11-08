import { probeEvidenceFile, writeEvidence, hasProbeEvidence } from './lib/probe-evidence.mjs';
import { readFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { parseArgs, digest, createLearningApi, expectOk as ok, loginMember, remoteDevice } from './remote-probe-helpers.mjs';
import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

/**
 * start/read 验证真实重启后的旧会话；generation 通过产品备份维护边界与 resume
 * 验证同一 supervisor 内 storage generation 的变化，不直接修改数据库。
 */
const args = parseArgs();
const endpoint = args.endpoint, controlFile = args.control, payloadFile = args.payload, stateFile = args.state;
const phase = args.phase;
// The start file is an input to the read phase; generation/read only emit optional diagnostics.
const out = phase === 'start' ? resolve(args.out ?? 'remote-stale-start.json') : probeEvidenceFile(args.out, 'remote-stale-state.json');
if (!endpoint || !controlFile || !payloadFile || !stateFile || !['start', 'read', 'generation'].includes(phase))
  throw new Error('usage: --phase=start|read|generation --endpoint=URL --control=FILE --payload=FILE --state=FILE [--out=FILE] [--device-state=FILE | --platform=macos-arm64|windows-x64]; generation also requires --control-endpoint=URL --backup-directory=DIR --recovery-key-ref=REF');
if (phase === 'generation' && (!args['control-endpoint'] || !args['backup-directory'] || !args['recovery-key-ref']))
  throw new Error('generation requires --control-endpoint=URL --backup-directory=DIR --recovery-key-ref=REF');
const token = (await readFile(controlFile, 'utf8')).trim();
const payload = JSON.parse(await readFile(payloadFile, 'utf8'));
const previous = JSON.parse(await readFile(stateFile, 'utf8'));
const device = await remoteDevice(args, payload, previous);
const manifest = payload.component.manifest, session = manifest.session;
const exec = promisify(execFile);

const api = createLearningApi(endpoint, token);
const { headers: student } = await loginMember(endpoint, payload);
const activity = ok('activity-read', await api(`activities/${previous.activityId}`, undefined, student));
const binding = activity.course?.components?.find(item => item.key === 'accumulator');
if (!binding) throw new Error('the activity lost the component binding');
const path = `executions/${activity.activityId}`;

async function startSession() {
  const requestId = randomUUID();
  const accepted = ok('accept', await api(path, { action: {
    protocolVersion: 2, kind: 'execution', requestId,
    scope: { environmentId: activity.identity.environmentId, spaceId: activity.identity.spaceId,
      principalId: activity.identity.principalId, activityId: activity.activityId },
    receiver: { receiverId: 'school-native-execution', location: 'remote', kind: 'execution' },
    execution: {
      ...(device ? { device } : {}),
      instance: { instanceId: `${activity.activityId}:accumulator`, key: 'accumulator', componentId: manifest.componentId,
        componentVersion: manifest.version, definitionDigest: binding.definition.digest,
        hostApiVersion: manifest.hostApiVersion, stateVersion: manifest.stateVersion },
      operation: { operationId: session.operation.operationId, effect: 'input' },
      parameters: {}, basis: { works: [], state: null, expected: { stateContentId: null }, resources: [] },
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
  } }, student));
  if (accepted.state !== 'running') throw new Error('the node did not start the session: '
    + JSON.stringify({ state: accepted.state, reason: accepted.reason }));
  return { endpoint, device, activityId: activity.activityId, requestId, executionRef: accepted.executionRef,
    nodeId: accepted.session.nodeId,
    installGeneration: accepted.session.installGeneration, supervisorEpoch: accepted.session.supervisorEpoch,
    executorInstanceId: accepted.session.executorInstanceId,
    unit: 'xj-session-' + accepted.session.executorInstanceId,
    observation: accepted.session.observation };
}

if (phase === 'start') {
  const state = await startSession();
  const { requestId } = state;
  await mkdir(dirname(out), { recursive: true });
  await writeEvidence(out, JSON.stringify(state, null, 2) + '\n');
  console.log(JSON.stringify({ phase, out: hasProbeEvidence(out) ? out : null, requestId, nodeId: state.nodeId, unit: state.unit,
    installGeneration: state.installGeneration, supervisorEpoch: state.supervisorEpoch }));
} else if (phase === 'generation') {
  const recovery = async (action, input) => {
    const response = await fetch(new URL('/runtime/control/recovery', args['control-endpoint']), {
      method: 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action, input }),
    });
    return ok(`recovery-${action}`, { status: response.status, value: await response.json() });
  };
  const started = await startSession();
  // Print the live execution identity; persist it only for an explicit report consumer.
  console.log(JSON.stringify({ phase, started }));
  await mkdir(dirname(out), { recursive: true });
  await writeEvidence(out, JSON.stringify({ phase, started }, null, 2) + '\n');
  const controlled = ok('control-before-maintenance', await api(`${path}/${started.requestId}/control`, {
    controlId: randomUUID(), operationId: session.operation.operationId,
    effect: 'input', expectedSeq: started.observation.applied, parameters: { value: 1 },
  }, student));
  if (controlled.session.observation.applied !== started.observation.applied + 1)
    throw new Error('the current-generation run did not apply its input before maintenance');
  started.observation = controlled.session.observation;
  await writeEvidence(out, JSON.stringify({ phase, started }, null, 2) + '\n');
  const backup = await recovery('backup', { directory: args['backup-directory'],
    recoveryKeyRef: args['recovery-key-ref'], leaveClosed: true });
  await recovery('resume');
  let successor;
  try {
    successor = await startSession();
    await writeEvidence(out, JSON.stringify({ phase, started, successor, backupId: backup.backupId }, null, 2) + '\n');
    if (successor.nodeId !== started.nodeId) throw new Error('maintenance changed the node identity');
    if (successor.supervisorEpoch !== started.supervisorEpoch)
      throw new Error('the generation probe unexpectedly crossed a supervisor restart');
    if (successor.installGeneration === started.installGeneration)
      throw new Error('maintenance resume did not change the actual storage generation');
    const rejected = await api(`${path}/${started.requestId}/control`, {
      controlId: randomUUID(), operationId: session.operation.operationId,
      effect: 'input', expectedSeq: started.observation.applied, parameters: { value: 1 },
    }, student);
    if (rejected.status !== 403) throw new Error('old-generation control was not forbidden: ' + rejected.status);
    const queried = ok('old-generation-query', await api(`${path}/${started.requestId}`, undefined, student));
    if (queried.session.installGeneration !== started.installGeneration
      || queried.session.executorInstanceId !== started.executorInstanceId
      || queried.session.supervisorEpoch !== started.supervisorEpoch)
      throw new Error('maintenance rewrote the stored execution ownership');
    if (queried.statusKnowledge !== 'unknown' || queried.session.observation.applied !== started.observation.applied)
      throw new Error('the stale run advanced or claimed a confirmed outcome');
    const reclaimed = ok('old-generation-reclaim', await api('manage/native-reclaim', { sessionRef: started.executionRef }));
    if (reclaimed.statusKnowledge !== 'confirmed' || reclaimed.state !== 'cancelled')
      throw new Error('the owner did not confirm old-generation reclamation');
    const evidence = { step: 'storage-generation-changed', backupId: backup.backupId,
      generationBefore: started.installGeneration, generationAfter: successor.installGeneration,
      nodeId: successor.nodeId, supervisorEpoch: successor.supervisorEpoch,
      oldControlStatus: rejected.status, oldStatusKnowledge: queried.statusKnowledge,
      appliedBefore: started.observation.applied, appliedAfter: queried.session.observation.applied,
      reclaimed: { state: reclaimed.state, statusKnowledge: reclaimed.statusKnowledge } };
    await writeEvidence(out, JSON.stringify({ endpoint, phase, started, successor, evidence }, null, 2) + '\n');
    console.log(JSON.stringify({ phase, out: hasProbeEvidence(out) ? out : null, ...evidence }));
  } finally {
    const cleanup = await Promise.allSettled([started, successor].filter(Boolean).map(async run => {
      const reclaimed = ok('generation-cleanup', await api('manage/native-reclaim', { sessionRef: run.executionRef }));
      if (reclaimed.state !== 'cancelled' || reclaimed.statusKnowledge !== 'confirmed')
        throw new Error('generation cleanup could not confirm reclamation: ' + run.executionRef);
    }));
    const failures = cleanup.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, 'generation probe cleanup failed');
  }
} else {
  const started = JSON.parse(await readFile(resolve(args.started ?? 'remote-stale-start.json'), 'utf8'));
  const queried = ok('query', await api(`${path}/${started.requestId}`, undefined, student));
  const unit = await exec('sudo', ['-n', '/usr/local/lib/xunjie/native-session-entry', 'state', started.unit, started.executorInstanceId],
    { timeout: 15000, windowsHide: true }).then(({ stdout }) => Object.fromEntries(stdout.split('\n')
      .map(line => line.split('=')).filter(pair => pair.length === 2))).catch(() => ({ ActiveState: 'unknown' }));
  const successor = await startSession();
  ok('successor-reclaim', await api('manage/native-reclaim', { sessionRef: successor.executionRef }));
  if (successor.supervisorEpoch === started.supervisorEpoch)
    throw new Error('the restart probe did not cross a supervisor restart');
  if (successor.nodeId !== started.nodeId) throw new Error('the restart changed the current node identity');
  const evidence = {
    step: 'restarted-under-a-new-supervisor',
    currentGeneration: successor.installGeneration,
    currentSupervisorEpoch: successor.supervisorEpoch,
    nodeIdUnchanged: queried.session.nodeId === started.nodeId,
    nodeId: queried.session.nodeId,
    generationOfRunBefore: started.installGeneration, generationOfRunAfter: queried.session.installGeneration,
    // The stored run keeps citing the supervisor that started it; the new process never rewrites
    // that field. What must change is the answer: the new owner does not claim to know the outcome.
    supervisorEpochOfRun: queried.session.supervisorEpoch,
    executorInstanceBefore: started.executorInstanceId, executorInstanceAfter: queried.session.executorInstanceId,
    unitActiveState: unit.ActiveState,
    state: queried.state, statusKnowledge: queried.statusKnowledge,
    confirmedSeq: queried.confirmedSeq, appliedSeq: queried.appliedSeq, reason: queried.reason ?? null,
  };
  if (!evidence.nodeIdUnchanged) throw new Error('the restart reassigned the run to another node');
  if (queried.session.installGeneration !== started.installGeneration
    || queried.session.supervisorEpoch !== started.supervisorEpoch
    || queried.session.executorInstanceId !== started.executorInstanceId)
    throw new Error('the restart rewrote the stored execution ownership');
  if (unit.ActiveState !== 'inactive' && unit.ActiveState !== 'failed')
    throw new Error('the previous supervisor left its unit running: ' + unit.ActiveState);
  if (queried.statusKnowledge !== 'unknown')
    throw new Error('the new generation claimed to know the previous run: ' + queried.statusKnowledge);
  await mkdir(dirname(out), { recursive: true });
  await writeEvidence(out, JSON.stringify({ endpoint, requestId: started.requestId, unit: started.unit, evidence }, null, 2) + '\n');
  console.log(JSON.stringify({ phase, out: hasProbeEvidence(out) ? out : null, ...evidence }));
}
