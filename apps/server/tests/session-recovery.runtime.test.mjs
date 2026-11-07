import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime';
import { accumulatorPackage } from '../../../components/state-accumulator/package.mjs';

const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN;
if (!postgresBin) throw new Error('Set XUNJIE_PRODUCT_POSTGRES_BIN to native PostgreSQL 18.6.');
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, child]) => [key, canonical(child)]))
    : value;
const sha256Json = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

/** A real native session against real PostgreSQL: start, input, replay, query, stop and restart recovery. */
test('session controls persist real checkpoints and restore a new related executor', { timeout: 300000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'xj-native173-'));
  const windowsSessionHelper = process.env.XUNJIE_NATIVE_SESSION_HELPER;
  const windowsSessionHelperSha256 = windowsSessionHelper
    ? createHash('sha256').update(await readFile(windowsSessionHelper)).digest('hex') : undefined;
  const runtime = openProductRuntime({ root, resources: { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin,
    postgresVersion: '18.6', windowsSessionHelper, windowsSessionHelperSha256, webRoot: fileURLToPath(new URL('../../web/dist-runtime', import.meta.url)),
    windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) } });
  try {
    await runtime.install({ profile: 'local' });
    const started = await runtime.start(), endpoint = started.endpoint;
    const admin = { authorization: `Bearer ${await resolveCredential(root, 'control')}` };
    const api = async (route, body, headers = {}) => {
      const response = await fetch(new URL('/api/learning/' + route, endpoint), { method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, value: await response.json() };
    };
    const published = await accumulatorPackage();
    const imported = await api('manage/component-import', { requestId: randomUUID(), ...published }, admin);
    assert.equal(imported.status, 200, JSON.stringify(imported.value));
    const { manifest } = published, definition = imported.value;
    const session = manifest.session;
    const courseId = randomUUID(), taskId = randomUUID(), releaseId = randomUUID();
    const binding = { key: 'accumulator', definition, configuration: { title: '四态累加模拟' }, materialIds: [] };
    const course = { formatVersion: 1, requestId: randomUUID(), course: { courseId, name: '有状态会话验收样例' },
      task: { taskId, title: '观察四态累加', summary: '' },
      release: { helpPolicy: { version: 1, questions: 'allowed', scope: 'course' },  releaseId, objectives: ['连续输入并观察真实内部状态'], requirements: '依次输入 1、2、2，观察 1、3、1。',
        starterWorks: [], capabilities: [], components: [binding], materials: [] }, resources: [] };
    assert.equal((await api('manage/course-import', course, admin)).status, 200);
    const password = randomUUID();
    const member = await api('manage/members', { requestId: randomUUID(), loginName: 'native-student', password }, admin);
    const login = await fetch(new URL('/api/learning/login', endpoint), { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'native-student', password }) });
    assert.equal(login.status, 200);
    const headers = { cookie: login.headers.get('set-cookie').split(';')[0] };
    await api('manage/course-access', { requestId: randomUUID(), courseId, principalId: member.value.principalId, active: true }, admin);
    const created = await api('course-activities', { requestId: randomUUID(), releaseId }, headers);
    assert.equal(created.status, 200, JSON.stringify(created.value));
    const activity = created.value;
    const instanceId = `${activity.activityId}:accumulator`;
    const limits = { timeMs: session.budgets.operationTimeoutMs, memoryPages: 1, inputBytes: session.budgets.inputBytes,
      outputBytes: session.budgets.outputBytes, concurrentJobs: session.budgets.concurrentSessions,
      queuedJobs: session.budgets.queuedSessions };
    const actionOf = requestId => ({
      protocolVersion: 2, kind: 'execution', requestId,
      scope: { environmentId: activity.identity.environmentId, spaceId: activity.identity.spaceId,
        principalId: activity.identity.principalId, activityId: activity.activityId },
      receiver: { receiverId: 'native-execution', location: 'local', kind: 'execution' },
      execution: {
        instance: { instanceId, key: 'accumulator', componentId: manifest.componentId,
          componentVersion: manifest.version, definitionDigest: definition.digest, hostApiVersion: 1, stateVersion: 1 },
        operation: { operationId: session.operation.operationId, effect: 'input' },
        parameters: {},
        basis: { works: [], state: null, expected: { stateContentId: null }, resources: [] },
        limits,
        plan: { planId: 'native-session', planVersion: 1, location: 'native', kind: 'session',
          planDigest: sha256Json({ planId: 'native-session', planVersion: 1, componentId: manifest.componentId,
            componentVersion: manifest.version, operationId: session.operation.operationId }) },
        session: { adapterId: session.adapterId, adapterVersion: session.adapterVersion,
          limits: { operationTimeoutMs: session.budgets.operationTimeoutMs, idleMs: session.budgets.idleMs,
            maxMs: session.budgets.maxMs, memoryMiB: session.budgets.memoryMiB,
            concurrentSessions: session.budgets.concurrentSessions, queuedSessions: session.budgets.queuedSessions } },
        initiator: { kind: 'student', principalId: activity.identity.principalId } } });

    const path = `executions/${activity.activityId}`;
    const requestId=randomUUID(), originalAction=actionOf(requestId);
    let original=(await api(path,{action:originalAction},headers)).value;
    assert.equal(original.state,'running');
    const initialInstance=original.session.executorInstanceId;
    const send=async(effect,parameters={},target=original,id=randomUUID())=>api(`${path}/${target.requestId}/control`,{
      controlId:id,operationId:effect==='input'?'advance':effect,effect,expectedSeq:target.session.appliedSeq,parameters},headers);
    const perform=async(effect,parameters={})=>{const result=await send(effect,parameters);assert.equal(result.status,200,JSON.stringify(result.value));original=result.value;return result.value;};
    await perform('input',{value:1});await perform('pause');assert.equal(original.state,'paused');
    assert.equal((await send('input',{value:2})).status,400);
    const stepId=randomUUID(), stepBody={controlId:stepId,operationId:'step',effect:'step',expectedSeq:original.session.appliedSeq,parameters:{value:2}};
    const stepped=await api(`${path}/${requestId}/control`,stepBody,headers);assert.equal(stepped.status,200,JSON.stringify(stepped.value));original=stepped.value;
    assert.deepEqual(original.session.observation,{value:3,total:3,applied:2});
    const duplicate=await api(`${path}/${requestId}/control`,stepBody,headers);assert.equal(duplicate.value.session.appliedSeq,original.session.appliedSeq);
    const stepReceipt=await api(`${path}/${requestId}/controls/${stepId}`,undefined,headers);
    assert.equal(stepReceipt.status,200);assert.equal(stepReceipt.value.status,'applied');assert.equal(stepReceipt.value.effect,'step');
    assert.equal((await api(`${path}/${requestId}/control`,{...stepBody,parameters:{value:1}},headers)).status,409);
    const checkpointId=randomUUID(), checkpointBody={controlId:checkpointId,operationId:'checkpoint',effect:'checkpoint',expectedSeq:original.session.appliedSeq,parameters:{}};
    // Ignore the first successful response: query and replay must recover the same published checkpoint.
    assert.equal((await api(`${path}/${requestId}/control`,checkpointBody,headers)).status,200);
    original=(await api(`${path}/${requestId}`,undefined,headers)).value;
    await api('manage/component-status',{requestId:randomUUID(),componentId:manifest.componentId,version:manifest.version,enabled:false},admin);
    assert.notEqual((await send('reset')).status,200);
    assert.equal((await api(`${path}/${requestId}`,undefined,headers)).value.session.checkpoints.length,1);
    await api('manage/component-status',{requestId:randomUUID(),componentId:manifest.componentId,version:manifest.version,enabled:true},admin);
    assert.equal(original.session.checkpoints.length,1);
    const checkpoint=original.session.checkpoints[0];assert.equal(checkpoint.checkpointId,checkpointId);
    const repeated=await api(`${path}/${requestId}/control`,checkpointBody,headers);
    assert.deepEqual(repeated.value.session.checkpoints,[checkpoint]);
    assert.equal(repeated.value.session.appliedSeq,original.session.appliedSeq);
    await perform('step',{value:2});const baseline=original.session.observation;
    const recoveryAction=actionOf(randomUUID());recoveryAction.execution.resumeFromCheckpoint={checkpointId,sessionRef:original.executionRef,sha256:checkpoint.sha256};
    const recovery=await api(path,{action:recoveryAction},headers);assert.equal(recovery.status,200,JSON.stringify(recovery.value));
    assert.equal(recovery.value.state,'paused');assert.notEqual(recovery.value.executionRef,original.executionRef);
    assert.notEqual(recovery.value.session.executorInstanceId,initialInstance);
    assert.deepEqual(recovery.value.session.restoredFrom,recoveryAction.execution.resumeFromCheckpoint);
    assert.deepEqual(recovery.value.session.observation,{value:3,total:3,applied:2});
    const recoveredStep=await send('step',{value:2},recovery.value);assert.equal(recoveredStep.status,200,JSON.stringify(recoveredStep.value));
    assert.deepEqual(recoveredStep.value.session.observation,baseline);
    assert.equal((await api(path,{action:recoveryAction},headers)).value.executionRef,recovery.value.executionRef);
    const stoppedRecovery=await api(`${path}/${recoveryAction.requestId}/stop`,{stopId:randomUUID(),reason:'验收结束'},headers);assert.equal(stoppedRecovery.status,200);
    await perform('reset');assert.deepEqual(original.session.observation,{value:0,total:0,applied:0});
    assert.equal(original.session.executorInstanceId,initialInstance);
    await perform('resume');assert.equal(original.state,'running');assert.equal(original.session.executorInstanceId,initialInstance);
    const competition=await Promise.all([send('pause'),send('input',{value:1})]);
    assert.equal(competition.filter(item=>item.status===200).length,1);
    original=(await api(`${path}/${requestId}`,undefined,headers)).value;
    const stop=await api(`${path}/${requestId}/stop`,{stopId:randomUUID(),reason:'验收结束'},headers);assert.equal(stop.value.state,'cancelled');
    // Fault only this test's actual immutable checkpoint blob, then restore its original bytes.
    const resourceRoot=join(root,'learning-resources','learning-data');
    const entries=await readdir(resourceRoot,{recursive:true,withFileTypes:true});
    const blob=entries.find(entry=>entry.isFile()&&entry.name===checkpoint.contentId);assert.ok(blob);
    const blobPath=join(blob.parentPath,blob.name);assert.ok(blobPath.startsWith(resourceRoot));
    const originalBytes=await readFile(blobPath);
    const tryRestore=async()=>{const candidate=structuredClone(recoveryAction);candidate.requestId=randomUUID();return api(path,{action:candidate},headers);};
    try {await writeFile(blobPath,Buffer.from('corrupt checkpoint'));assert.equal((await tryRestore()).value.error,'corrupt');}
    finally {await writeFile(blobPath,originalBytes);}
    const missingPath=blobPath+'.missing';
    try {await rename(blobPath,missingPath);assert.equal((await tryRestore()).value.error,'missing');}
    finally {await rename(missingPath,blobPath);}
    await api('manage/course-access',{requestId:randomUUID(),courseId,principalId:member.value.principalId,active:false},admin);
    assert.equal((await tryRestore()).status,403);
    await api('manage/course-access',{requestId:randomUUID(),courseId,principalId:member.value.principalId,active:true},admin);
    for(const fault of ['missing','digest','version']){
      const invalid=structuredClone(recoveryAction);invalid.requestId=randomUUID();
      if(fault==='missing')invalid.execution.resumeFromCheckpoint.checkpointId=randomUUID();
      if(fault==='digest')invalid.execution.resumeFromCheckpoint.sha256='0'.repeat(64);
      if(fault==='version')invalid.execution.session.adapterVersion=1;
      assert.notEqual((await api(path,{action:invalid},headers)).status,200,fault);
    }
    const secondActivity=(await api('course-activities',{requestId:randomUUID(),releaseId},headers)).value;
    const foreign=structuredClone(recoveryAction);foreign.requestId=randomUUID();foreign.scope.activityId=secondActivity.activityId;
    foreign.execution.instance.instanceId=secondActivity.activityId+':accumulator';
    assert.equal((await api(`executions/${secondActivity.activityId}`,{action:foreign},headers)).status,403);
    await runtime.stop();await runtime.start();
    const resumedAfterRestart=structuredClone(recoveryAction);resumedAfterRestart.requestId=randomUUID();
    const afterRestart=await api(path,{action:resumedAfterRestart},headers);assert.equal(afterRestart.status,200,JSON.stringify(afterRestart.value));
    const afterStep=await send('step',{value:2},afterRestart.value);assert.deepEqual(afterStep.value.session.observation,baseline);
    const closed=await api('activity-status',{requestId:randomUUID(),activityId:activity.activityId,status:'closed'},headers);assert.equal(closed.status,200);
    const afterClose=await api(`${path}/${resumedAfterRestart.requestId}`,undefined,headers);assert.equal(afterClose.value.state,'cancelled');
    assert.notEqual((await send('step',{value:1},afterStep.value)).status,200);
    assert.notEqual((await api(path,{action:actionOf(randomUUID())},headers)).status,200);
  } catch(error) { console.error('PRIMARY FAILURE',error);throw error; } finally { await runtime.stop().catch(()=>{});await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100}).catch(error=>console.error('CLEANUP FAILURE',error.code)); }
});
