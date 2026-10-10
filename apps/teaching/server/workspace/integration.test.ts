import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../../runner/snapshot.ts';
import { fixture, command, assigned, opened, files, snapshot, view, origin, syntheticProfile } from './test-support.ts';
import type { RunnerTransport } from '../records/runner.ts';
import type { SubmitRun, RunFact } from '../../contracts/runner/index.ts';
import { createHash } from 'node:crypto';
import { sshRunner } from '../records/runner.ts';
import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import { readActivity } from '../design/activities.ts';

test('real A1/A2 transactions persist double-key ACKs, whole files and original revisions', async () => {
  const f = await fixture();
  try {
    const teacher = await f.login('teacher'), student = await f.login(), allocation = await assigned(f,teacher);
    const id = await opened(f,student,allocation.assignmentId);
    const counts = f.db.withTransaction(tx => tx.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"));
    assert.equal(counts.length,22);
    assert.equal((await view(f,student,id)).attempt.status,'ready');
    assert.equal((await opened(f,student,allocation.assignmentId)),id);
    const body = { expectedWorkspaceRevision: 0,clientId: 'page',clientSeq: 91,
      operations: [{ kind: 'create',clientFileKey: '__proto__',path: 'main.c',text: '中文😀\r\n' }],process: { captureRevision: 0 } };
    const initial = await command(f,student,`/api/attempts/${id}/sync`,body,'first');
    assert.equal(initial.statusCode,200,initial.body);
    const result = initial.json().data;
    const state = await view(f,student,id);
    assert.equal(state.attempt.status,'active'); assert.equal(state.attempt.attemptRevision,2);
    assert.equal(state.files[0].contentHash,sha256('中文😀\r\n'));
    for (const key of ['first','alias']) {
      const repeated = await command(f,student,`/api/attempts/${id}/sync`,body,key);
      assert.equal(repeated.statusCode,200,repeated.body); assert.equal(repeated.json().data.replayed,true);
      for (const field of ['receiptId','commandId','serverSeq','committedAt','result']) assert.deepEqual(repeated.json().data[field],result[field]);
    }
    assert.equal(f.db.withTransaction(tx => tx.get("SELECT COUNT(*) AS n FROM workspace_process_records WHERE kind='sync'")!.n),1);
    const conflict = await command(f,student,`/api/attempts/${id}/sync`,{ ...body,operations: [{ ...body.operations[0],text: 'different' }] },'alias');
    assert.equal(conflict.json().error.code,'IDEMPOTENCY_CONFLICT');
    const snap = await snapshot(f,student,id), file = state.files[0];
    const delta = await command(f,student,`/api/attempts/${id}/sync`,{ expectedWorkspaceRevision: 1,clientId: 'page',clientSeq: 93,
      operations: [{ kind: 'update',fileId: file.fileId,baseVersion: 1,changes: [{ range: { startLine: 1,startColumn: 3,endLine: 1,endColumn: 5 },text: '标志' }] }] });
    assert.equal(delta.statusCode,200,delta.body); assert.equal((await view(f,student,id)).files[0].text,'中文标志\r\n');
    const recycled = await command(f,student,`/api/attempts/${id}/sync`,{ expectedWorkspaceRevision: 2,clientId: 'page',clientSeq: 95,
      operations: [{ kind: 'recycle',fileId: file.fileId,baseVersion: 2 },{ kind: 'create',clientFileKey: 'replacement',path: 'main.c',text: 'new' }] });
    assert.equal(recycled.statusCode,200,recycled.body);
    assert.notEqual(recycled.json().data.result.created.replacement,file.fileId);
    const historical = await f.app.inject({ url: `/api/attempts/${id}/snapshots/${snap}`,headers: student });
    assert.equal(historical.json().data.files[0].text,'中文😀\r\n');
    const blockedRestore = await command(f,student,`/api/attempts/${id}/sync`,{ expectedWorkspaceRevision: 3,clientId: 'page',clientSeq: 96,
      operations: [{ kind: 'restore',fileId: file.fileId,baseVersion: 3 }] });
    assert.equal(blockedRestore.json().error.code,'STATE_CONFLICT');
    const restoredFile = await command(f,student,`/api/attempts/${id}/sync`,{ expectedWorkspaceRevision: 3,clientId: 'page',clientSeq: 96,
      operations: [{ kind: 'recycle',fileId: recycled.json().data.result.created.replacement,baseVersion: 1 },{ kind: 'restore',fileId: file.fileId,baseVersion: 3 }] });
    assert.equal(restoredFile.statusCode,200,restoredFile.body);
    const position = await command(f,student,`/api/attempts/${id}/controls`,{ expectedAttemptRevision: 5,
      control: { kind: 'position',route: 'array',question: 'Explain this',returnPosition: { kind: 'code',attemptId: id,snapshotId: snap,
        fileId: file.fileId,path: 'main.c',documentVersion: 1,contentHash: file.contentHash,range: { startLine: 1,startColumn: 3,endLine: 1,endColumn: 5 } } } });
    assert.equal(position.statusCode,200,position.body);
    await f.reopen();
    const restored = await view(f,student,id);
    assert.equal(restored.attempt.returnPosition.snapshotId,snap); assert.equal(restored.attempt.question,'Explain this');
    const replay = await command(f,student,`/api/attempts/${id}/sync`,body,'alias');
    assert.equal(replay.json().data.receiptId,result.receiptId);
    f.restoreGeneration();
    const staleGeneration = await command(f,student,`/api/attempts/${id}/sync`,body,'fresh-public-key');
    assert.equal(staleGeneration.json().error.code,'RECOVERY_REQUIRED');
  } finally { await f.close(); }
});

test('late SQL failure rolls back files, Job, Event, Receipt and session activity; CAS and limits reject whole batches', async () => {
  const f = await fixture();
  try {
    const teacher = await f.login('teacher'), student = await f.login(), allocation = await assigned(f,teacher), id = await opened(f,student,allocation.assignmentId);
    const before = f.db.withTransaction(tx => ({ receipts: tx.get('SELECT COUNT(*) AS n FROM command_receipts')!.n,
      events: tx.get('SELECT COUNT(*) AS n FROM audit_events')!.n,activity: tx.all('SELECT last_active_at_ms FROM sessions') }));
    const body = { expectedWorkspaceRevision: 0,clientId: 'page',clientSeq: 1,operations: [{ kind: 'create',clientFileKey: 'a',path: 'main.c',text: 'draft' }],process: { captureRevision: 0 } };
    f.advance(1000); f.injectFailure('INSERT INTO workspace_process_records');
    const failed = await command(f,student,`/api/attempts/${id}/sync`,body,'retry');
    assert.equal(failed.statusCode,503,failed.body); assert.equal(failed.json().error.code,'PERSISTENCE_UNAVAILABLE');
    const after = f.db.withTransaction(tx => ({ receipts: tx.get('SELECT COUNT(*) AS n FROM command_receipts')!.n,
      events: tx.get('SELECT COUNT(*) AS n FROM audit_events')!.n,activity: tx.all('SELECT last_active_at_ms FROM sessions') }));
    assert.deepEqual(after,before); assert.equal(f.db.withTransaction(tx => tx.get('SELECT COUNT(*) AS n FROM workspace_files')!.n),0);
    f.injectFailure('');
    const success = await command(f,student,`/api/attempts/${id}/sync`,body,'retry');
    assert.equal(success.statusCode,200,success.body);
    const fileId = success.json().data.result.created.a;
    for (const [operations,expected] of [
      [[{ kind: 'update',fileId,baseVersion: 1,text: 'valid first' },{ kind: 'create',clientFileKey: 'bad',path: '../escape',text: 'bad' }],'INVALID_REFERENCE'],
      [[{ kind: 'update',fileId,baseVersion: 0,text: 'old' }],'INVALID_REQUEST'],
      [[{ kind: 'create',clientFileKey: 'large',path: 'large.c',text: 'a'.repeat(1048577) }],'CONTENT_LIMIT'],
      [Array.from({ length: 50 },(_,i) => ({ kind: 'create',clientFileKey: 'f'+i,path: 'f'+i,text: '' })),'CONTENT_LIMIT'],
    ] as const) {
      const rejected = await command(f,student,`/api/attempts/${id}/sync`,{ expectedWorkspaceRevision: 1,clientId: 'page',clientSeq: 2,operations });
      assert.equal(rejected.json().error.code,expected,rejected.body);
    }
    assert.equal((await view(f,student,id)).files[0].text,'draft');
    const stale = await command(f,student,`/api/attempts/${id}/sync`,{ ...body,clientSeq: 3 });
    assert.equal(stale.json().error.code,'VERSION_CONFLICT');
    const snap = await snapshot(f,student,id), state = await view(f,student,id);
    f.injectFailure('INSERT INTO workspace_runs');
    const run = await command(f,student,`/api/attempts/${id}/runs`,{ expectedAttemptRevision: state.attempt.attemptRevision,snapshotId: snap,
      runtimeProfileVersion: f.profile.runtimeProfileVersion,entryFileId: fileId,input: { operation: 'stats',fileIds: [fileId] },mode: 'course_check' });
    assert.equal(run.statusCode,503,run.body);
    f.injectFailure('');
    const untouched = await view(f,student,id);
    assert.equal(untouched.jobs.length,0); assert.equal(untouched.checks.length,0); assert.deepEqual(untouched.attempt,state.attempt);
  } finally { await f.close(); }
});

test('current ownership and A2 controls guard replay; paused work and capture gaps keep only functional data', async () => {
  const f = await fixture();
  try {
    const teacher = await f.login('teacher'), student = await f.login(), other = await f.login('other'), foreign = await f.login('foreign');
    const allocation = await assigned(f,teacher), id = await opened(f,student,allocation.assignmentId), ids = await files(f,student,id);
    for (const headers of [other,foreign]) assert.equal((await f.app.inject({ url: `/api/attempts/${id}`,headers })).statusCode,403);
    assert.equal((await command(f,teacher,`/api/attempts/${id}/controls`,{ expectedAttemptRevision: 2,control: { kind: 'pause' } })).statusCode,403);
    assert.equal((await command(f,{ ...student,'x-csrf-token': 'invalid' },`/api/attempts/${id}/sync`,{})).statusCode,403);
    const pauseCapture = await command(f,student,`/api/attempts/${id}/controls`,{ expectedAttemptRevision: 2,control: { kind: 'capture',value: false } });
    assert.equal(pauseCapture.statusCode,200,pauseCapture.body);
    const update = (version: number,seq: number,captureRevision: number) => ({ expectedWorkspaceRevision: version,clientId: 'page',clientSeq: seq,
      operations: [{ kind: 'update',fileId: ids.source,baseVersion: version,text: 'new draft '+seq }],process: { captureRevision } });
    const paused = await command(f,student,`/api/attempts/${id}/sync`,update(1,10,0));
    assert.equal(paused.statusCode,200,paused.body); assert.equal(paused.json().data.result.process.reason,'capture_paused');
    const resumeCapture = await command(f,student,`/api/attempts/${id}/controls`,{ expectedAttemptRevision: 4,control: { kind: 'capture',value: true } });
    assert.equal(resumeCapture.statusCode,200,resumeCapture.body);
    const late = await command(f,student,`/api/attempts/${id}/sync`,update(2,11,0));
    assert.equal(late.json().data.result.process.reason,'stale_capture_revision');
    assert.equal(f.db.withTransaction(tx => tx.get("SELECT COUNT(*) AS n FROM workspace_process_records WHERE kind='sync'")!.n),1);
    assert.equal(f.db.withTransaction(tx => tx.get("SELECT COUNT(*) AS n FROM workspace_process_records WHERE kind='coverage'")!.n),2);
    const history = await f.app.inject({ url: `/fixture/process/${id}`,headers: student });
    assert.equal(history.statusCode,200,history.body); assert.equal(history.json().data.length,3);
    assert.deepEqual(history.json().data.filter((record: { kind: string }) => record.kind === 'coverage').map((item: { record: { collecting: boolean } }) => item.record.collecting),[false,true]);
    assert.equal((await f.app.inject({ url: `/fixture/process/${id}`,headers: other })).statusCode,403);
    const pause = await command(f,teacher,`/api/activities/${allocation.activityId}/controls`,{ expectedActivityControlRevision: 1,action: 'pause',reason: 'Synthetic pause' });
    assert.equal(pause.statusCode,200,pause.body);
    const saved = await command(f,student,`/api/attempts/${id}/sync`,update(3,12,2));
    assert.equal(saved.statusCode,200,saved.body);
    const blocked = await command(f,student,`/api/attempts/${id}/sync`,{ expectedWorkspaceRevision: 4,clientId: 'page',clientSeq: 13,operations: [{ kind: 'create',clientFileKey: 'x',path: 'x',text: '' }] });
    assert.equal(blocked.json().error.code,'STATE_CONFLICT');
    f.db.withTransaction(tx => tx.run("UPDATE course_memberships SET active=0 WHERE user_id='student'"));
    const replay = await command(f,student,`/api/attempts/${id}/sync`,update(3,12,2));
    assert.equal(replay.statusCode,403,replay.body);
  } finally { await f.close(); }
});

test('two real processes share the original ACK, and acknowledged state survives process restart', async () => {
  const f = await fixture(); const children: ReturnType<typeof fork>[] = [];
  try {
    const teacher = await f.login('teacher'), student = await f.login(), allocation = await assigned(f,teacher), id = await opened(f,student,allocation.assignmentId);
    async function child() {
      const process = fork(fileURLToPath(new URL('./test-child.ts',import.meta.url)),[],{ stdio: ['ignore','ignore','ignore','ipc'] }); children.push(process);
      const ready = once(process,'message'); process.send({ kind: 'init',file: f.db.file,origin,signingSecret: f.signingSecret,generation: f.generation(),timestamp: f.timestamp() });
      assert.equal((await ready)[0].kind,'ready'); return process;
    }
    const peers = await Promise.all([child(),child()]);
    const payload = { recoveryGeneration: f.generation(),expectedWorkspaceRevision: 0,clientId: 'page',clientSeq: 77,
      operations: [{ kind: 'create',clientFileKey: 'a',path: 'a.c',text: 'acknowledged' }] };
    const responses = await Promise.all(peers.map(async (peer,i) => {
      const message = once(peer,'message'); peer.send({ kind: 'request',url: `/api/attempts/${id}/sync`,headers: { ...student,'idempotency-key': 'peer-'+i },payload });
      const result = (await message)[0]; assert.equal(result.status,200,result.body); return JSON.parse(result.body).data;
    }));
    assert.equal(responses[0].receiptId,responses[1].receiptId); assert.equal(responses[0].serverSeq,responses[1].serverSeq);
    for (const peer of peers) { const exited = once(peer,'exit'); peer.send({ kind: 'stop' }); await exited; }
    await f.reopen();
    assert.equal((await view(f,student,id)).files[0].text,'acknowledged');
    const restarted = await child();
    const message = once(restarted,'message'); restarted.send({ kind: 'request',url: `/api/attempts/${id}/sync`,headers: { ...student,'idempotency-key': 'peer-1' },payload });
    const result = (await message)[0]; assert.equal(result.status,200,result.body); assert.equal(JSON.parse(result.body).data.receiptId,responses[0].receiptId);
    const exited = once(restarted,'exit'); restarted.send({ kind: 'stop' }); await exited;
  } finally { for (const child of children) if (child.exitCode === null) child.kill('SIGKILL'); await f.close(); }
});

function controlledRunner() {
  const accepted = new Map<string,SubmitRun>(), facts = new Map<string,RunFact>();
  const results = new Map<string,object>(); let submits = 0, queries = 0, lose = false, loseQuery = false;
  const transport: RunnerTransport = async command => {
    if (command.op === 'readiness') {
      const fingerprint = { profile: syntheticProfile,sourceHash: 'd'.repeat(64) };
      return { data: { ready: true,...syntheticProfile,recoveryGeneration: 'generation',fingerprint,
        validation: { passed: true,fingerprintHash: createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex'),validatedAt: new Date().toISOString() } } };
    }
    const id = command.op === 'submit' ? command.submission.identity.runId : command.identity.runId;
    if (command.op === 'submit') {
      submits++; accepted.set(id,command.submission); facts.set(id,{ identity: command.submission.identity,state: 'running',reserved: true,stopRequested: false,units: ['synthetic-unit'],pending: [] });
      if (lose) { lose = false; throw new Error('Synthetic link lost after node acceptance.'); }
    }
    if (command.op === 'query') { queries++; if (loseQuery) { loseQuery = false; throw new Error('Synthetic query lost.'); } }
    if (command.op === 'cancel') {
      const old = facts.get(id);
      facts.set(id,old?.resultRef ? { ...old,stopRequested: true } : { identity: command.identity,state: 'cancelled',reserved: false,stopRequested: true,units: [],pending: [] });
    }
    return { data: command.op === 'readResult' ? results.get(id) : facts.get(id) ?? null };
  };
  return { transport,loseNext() { lose = true; },loseNextQuery() { loseQuery = true; },counts: () => ({ submits,queries }),
    finish(id: string) {
      const submission = accepted.get(id)!;
      const record = { ...submission.identity,unitTerminated: true,phases: [{ stdout: submission.mode === 'check' ? 'PRIVATE_CHECK_OUTPUT' : 'old snapshot',stderr: '' }],
        ...(submission.mode === 'check' ? { verdict: 'failed',checkResults: [{ expected: 'PRIVATE_CHECK_OUTPUT' }] } : {}) };
      results.set(id,record); facts.set(id,{ ...facts.get(id)!,state: 'succeeded',reserved: false,resultRef: 'synthetic-result-'+id,resultHash: sha256(JSON.stringify(record)) });
    } };
}

test('persistent worker reconciles unknown original IDs after reopen and keeps limited-check diagnostics private', async () => {
  const node = controlledRunner(), f = await fixture(node.transport);
  try {
    const teacher = await f.login('teacher'), student = await f.login(), allocation = await assigned(f,teacher), id = await opened(f,student,allocation.assignmentId);
    const ids = await files(f,student,id), snap = await snapshot(f,student,id), state = await view(f,student,id);
    const input = { expectedAttemptRevision: state.attempt.attemptRevision,snapshotId: snap,runtimeProfileVersion: f.profile.runtimeProfileVersion,
      entryFileId: ids.source,input: { operation: 'stats',fileIds: [ids.input] },mode: 'course_check' };
    const response = await command(f,student,`/api/attempts/${id}/runs`,input,'run'); assert.equal(response.statusCode,200,response.body);
    const { runId,jobId } = response.json().data.result;
    assert.equal((await f.app.inject({ url: `/fixture/tutor/${id}`,headers: student })).json().data.helpAllowed,false);
    node.loseNext(); await f.workspace.processJob(jobId);
    assert.equal((await view(f,student,id)).jobs[0].status,'outcome_unknown'); assert.equal((await view(f,student,id)).checks[0].state,'active');
    await f.reopen(); node.finish(runId); await f.workspace.processJob(jobId);
    const finished = await view(f,student,id);
    assert.equal(finished.jobs[0].status,'succeeded'); assert.equal(finished.checks[0].state,'ended');
    assert.equal(finished.runs[0].diagnostics.verdict,'failed'); assert.equal(node.counts().submits,1);
    assert.equal(JSON.stringify(finished).includes('PRIVATE_CHECK_OUTPUT'),false);
    assert.equal((await f.app.inject({ url: `/fixture/tutor/${id}`,headers: student })).json().data.helpAllowed,true);
    f.unavailable(); const replay = await command(f,student,`/api/attempts/${id}/runs`,input,'run');
    assert.equal(replay.statusCode,200,replay.body); assert.equal(replay.json().data.result.runId,runId);
    await command(f,student,`/api/jobs/${jobId}/cancel`,{});
    assert.equal((await view(f,student,id)).jobs[0].status,'succeeded');
    f.restoreGeneration(); const old = await command(f,student,`/api/attempts/${id}/runs`,input,'run');
    assert.equal(old.json().error.code,'RECOVERY_REQUIRED');
  } finally { await f.close(); }
});

test('unknown with no node fact never resubmits; failed result commit recovers the same immutable fact', async () => {
  const node = controlledRunner(), f = await fixture(node.transport);
  try {
    const teacher = await f.login('teacher'), student = await f.login(), allocation = await assigned(f,teacher), id = await opened(f,student,allocation.assignmentId);
    const ids = await files(f,student,id), snap = await snapshot(f,student,id), state = await view(f,student,id);
    const input = { expectedAttemptRevision: state.attempt.attemptRevision,snapshotId: snap,runtimeProfileVersion: f.profile.runtimeProfileVersion,
      entryFileId: ids.source,input: { operation: 'stats',fileIds: [ids.input] },mode: 'run' };
    const accepted = await command(f,student,`/api/attempts/${id}/runs`,input);
    assert.equal(accepted.statusCode,200,accepted.body);
    const first = accepted.json().data.result;
    node.loseNextQuery(); await f.workspace.processJob(first.jobId); await f.reopen(); await f.workspace.processJob(first.jobId);
    assert.equal((await view(f,student,id)).jobs[0].status,'outcome_unknown'); assert.equal(node.counts().submits,0);
    const explicitStop = await command(f,student,`/api/jobs/${first.jobId}/cancel`,{});
    assert.equal(explicitStop.statusCode,200,explicitStop.body); await f.workspace.processJob(first.jobId);
    const second = await command(f,student,`/api/attempts/${id}/runs`,input);
    assert.equal(second.statusCode,200,second.body);
    const original = second.json().data.result;
    await f.workspace.processJob(original.jobId); node.finish(original.runId);
    f.injectFailure('UPDATE workspace_runs');
    await assert.rejects(f.workspace.processJob(original.jobId),(error: { code?: string }) => error.code === 'PERSISTENCE_UNAVAILABLE');
    const unsaved = await view(f,student,id);
    assert.equal(unsaved.runs.find((run: { runId: string }) => run.runId === original.runId).diagnostics.status,'unavailable');
    f.injectFailure(''); await f.reopen(); f.advance(150001); await f.workspace.processJob(original.jobId);
    const recovered = await view(f,student,id);
    assert.equal(recovered.runs.find((run: { runId: string }) => run.runId === original.runId).diagnostics.status,'available');
    assert.equal(node.counts().submits,1); assert.equal(recovered.runs.length,2);
  } finally { await f.close(); }
});

test('A2 pause stops a queued check through the original node cancellation; resume never resurrects it', async () => {
  const node = controlledRunner(), f = await fixture(node.transport);
  try {
    const teacher = await f.login('teacher'), student = await f.login(), allocation = await assigned(f,teacher), id = await opened(f,student,allocation.assignmentId);
    const ids = await files(f,student,id), snap = await snapshot(f,student,id), state = await view(f,student,id);
    const input = { expectedAttemptRevision: state.attempt.attemptRevision,snapshotId: snap,runtimeProfileVersion: f.profile.runtimeProfileVersion,
      entryFileId: ids.source,input: { operation: 'stats',fileIds: [ids.input] },mode: 'course_check' };
    const response = await command(f,student,`/api/attempts/${id}/runs`,input); assert.equal(response.statusCode,200,response.body);
    const { jobId } = response.json().data.result;
    const pause = await command(f,teacher,`/api/assignments/${allocation.assignmentId}/controls`,{ expectedAssignmentRevision: 1,action: 'pause',reason: 'Synthetic pause' });
    assert.equal(pause.statusCode,200,pause.body);
    assert.equal((await view(f,student,id)).jobs[0].status,'cancelling'); assert.equal((await view(f,student,id)).checks[0].state,'active');
    const resume = await command(f,teacher,`/api/assignments/${allocation.assignmentId}/controls`,{ expectedAssignmentRevision: 2,action: 'resume',reason: 'Synthetic resume' });
    assert.equal(resume.statusCode,200,resume.body);
    const tooEarly = await command(f,student,`/api/attempts/${id}/runs`,{ ...input,expectedAttemptRevision: (await view(f,student,id)).attempt.attemptRevision });
    assert.equal(tooEarly.json().error.code,'STATE_CONFLICT');
    await f.workspace.processJob(jobId);
    assert.equal((await view(f,student,id)).jobs[0].status,'cancelled'); assert.equal((await view(f,student,id)).checks[0].state,'ended');
    assert.equal(node.counts().submits,0);
    const repeated = await command(f,student,`/api/jobs/${jobId}/cancel`,{}); assert.equal(repeated.statusCode,200,repeated.body);
    assert.equal((await view(f,student,id)).jobs[0].status,'cancelled');
  } finally { await f.close(); }
});

test('real A1/A2/C1 student chain retains old snapshots, trusted checks, cancellation and ACKs after reopen',
  { skip: process.env.XUNJIE_C2_RUNTIME !== '1',timeout: 180000 },async t => {
    const configuration = z.strictObject({ binary: z.string(),host: z.string(),port: z.number().int(),keyFile: z.string(),knownHostsFile: z.string() })
      .parse(JSON.parse(process.env.XUNJIE_C2_SSH_CONFIG ?? 'null'));
    const calls = { submits: 0,queries: 0,cancels: 0 };
    const real = sshRunner(configuration), transport: RunnerTransport = async request => {
      if (request.op === 'submit') calls.submits++;
      if (request.op === 'query') calls.queries++;
      if (request.op === 'cancel') calls.cancels++;
      return real(request);
    };
    const f = await fixture(transport);
    try {
      const teacher = await f.login('teacher'), student = await f.login(), allocation = await assigned(f,teacher), id = await opened(f,student,allocation.assignmentId);
      const ids = await files(f,student,id), snap = await snapshot(f,student,id);
      const initial = await view(f,student,id);
      const ordinary = { expectedAttemptRevision: initial.attempt.attemptRevision,snapshotId: snap,runtimeProfileVersion: f.profile.runtimeProfileVersion,
        entryFileId: ids.source,input: { operation: 'stats',fileIds: [ids.input] },mode: 'run' };
      const response = await command(f,student,`/api/attempts/${id}/runs`,ordinary,'ordinary');
      assert.equal(response.statusCode,200,response.body);
      const first = response.json().data.result;
      const edited = await command(f,student,`/api/attempts/${id}/sync`,{ expectedWorkspaceRevision: 1,clientId: 'page',clientSeq: 6,
        operations: [{ kind: 'update',fileId: ids.source,baseVersion: 1,text: '#include <stdio.h>\nint main(void){puts("new snapshot");}\n' }] });
      assert.equal(edited.statusCode,200,edited.body);
      async function settle(jobId: string) {
        for (let i = 0;i < 70;i++) {
          await f.workspace.processJob(jobId);
          const job = (await view(f,student,id)).jobs.find((item: { jobId: string }) => item.jobId === jobId);
          if (['succeeded','cancelled','failed','timed_out'].includes(job.status)) return job;
          await setTimeout(300);
        }
        assert.fail('Original job did not settle within the bounded test window.');
      }
      assert.equal((await settle(first.jobId)).status,'succeeded');
      let state = await view(f,student,id);
      assert.match(state.runs.find((run: { runId: string }) => run.runId === first.runId).diagnostics.stdout,/old snapshot/);
      assert.equal(state.files.find((file: { fileId: string }) => file.fileId === ids.source).text.includes('new snapshot'),true);
      await f.reopen();
      const replay = await command(f,student,`/api/attempts/${id}/runs`,ordinary,'ordinary');
      assert.equal(replay.json().data.result.runId,first.runId); assert.equal(calls.submits,1);
      state = await view(f,student,id);
      const check = await command(f,student,`/api/attempts/${id}/runs`,{ ...ordinary,expectedAttemptRevision: state.attempt.attemptRevision,mode: 'course_check' });
      assert.equal(check.statusCode,200,check.body);
      const checkJob = check.json().data.result;
      assert.equal((await f.app.inject({ url: `/fixture/tutor/${id}`,headers: student })).json().data.helpAllowed,false);
      assert.equal((await settle(checkJob.jobId)).status,'succeeded');
      state = await view(f,student,id);
      assert.equal(state.runs.find((run: { runId: string }) => run.runId === checkJob.runId).diagnostics.verdict,'failed');
      const publicFiles = await f.app.inject({ url: `/api/attempts/${id}/runs/${checkJob.runId}/files`,headers: student });
      assert.equal(publicFiles.json().data.status,'redacted');
      const toCancel = await command(f,student,`/api/attempts/${id}/runs`,{ ...ordinary,expectedAttemptRevision: state.attempt.attemptRevision });
      assert.equal(toCancel.statusCode,200,toCancel.body);
      const cancelJob = toCancel.json().data.result;
      const stopped = await command(f,student,`/api/jobs/${cancelJob.jobId}/cancel`,{});
      assert.equal(stopped.statusCode,200,stopped.body); assert.equal(stopped.json().data.result.status,'cancelling');
      await f.workspace.processJob(cancelJob.jobId);
      assert.equal((await view(f,student,id)).jobs.find((job: { jobId: string }) => job.jobId === cancelJob.jobId).status,'cancelled');
      assert.equal(calls.submits,2); assert.equal(calls.cancels,1);
      await f.reopen();
      assert.equal((await view(f,student,id)).runs.length,3);
      state = await view(f,student,id);
      const reportSource = '#include <stdio.h>\nint main(int argc,char**argv){if(argc<4)return 2;FILE*f=fopen(argv[3],"w");if(!f)return 1;fputs("student-owned report\\n",f);return fclose(f)!=0;}\n';
      const reportEdit = await command(f,student,`/api/attempts/${id}/sync`,{ expectedWorkspaceRevision: state.attempt.workspaceRevision,clientId: 'page',clientSeq: 9,
        operations: [{ kind: 'update',fileId: ids.source,baseVersion: 2,text: reportSource }] });
      assert.equal(reportEdit.statusCode,200,reportEdit.body);
      const reportSnapshot = await snapshot(f,student,id); state = await view(f,student,id);
      const reportRun = await command(f,student,`/api/attempts/${id}/runs`,{ ...ordinary,expectedAttemptRevision: state.attempt.attemptRevision,
        snapshotId: reportSnapshot,input: { operation: 'report',fileIds: [ids.input],resultFile: 'report.txt' } });
      assert.equal(reportRun.statusCode,200,reportRun.body);
      const reportJob = reportRun.json().data.result;
      assert.equal((await settle(reportJob.jobId)).status,'succeeded');
      const artifacts = await f.app.inject({ url: `/api/attempts/${id}/runs/${reportJob.runId}/files`,headers: student });
      assert.equal(artifacts.statusCode,200,artifacts.body);
      assert.equal(artifacts.json().data.files[0].text,'student-owned report\n');
      assert.equal(artifacts.json().data.files[0].contentHash,sha256('student-owned report\n'));
      assert.equal((await view(f,student,id)).files.length,2);
      assert.equal(calls.submits,3);
      const activity = f.db.withTransaction(tx => readActivity(tx,'course',allocation.activityId));
      t.diagnostic(JSON.stringify({ layers: ['A1-real-session-sql','A2-fixed-activity-assignment','C1-authenticated-ssh-container'],
        sqlite: f.db.diagnostics, tables: f.db.withTransaction(tx => tx.get("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")!.n),
        recoveryGeneration: f.generation(),runtimeProfileVersion: f.profile.runtimeProfileVersion,imageDigest: f.profile.imageDigest,
        fingerprintHash: activity.runtimeReadiness.fingerprintHash,runnerSourceHash: activity.runtimeReadiness.sourceHash,
        originalRunId: first.runId,oldSnapshotId: snap,courseVerdict: 'failed',checkFiles: 'redacted',cancelledBeforeDispatch: true,
        durableReopen: true,readOnlyReport: true, transportCalls: calls }));
    } finally { await f.close(); }
  });
