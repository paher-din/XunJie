import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { RunControl } from '../../runner/control.ts';
import type { RunIdentity } from '../../runner/control.ts';
import type { RunnerTransport } from '../records/runner.ts';
import { fixture, command, assigned, opened, files, snapshot, view, syntheticProfile } from './test-support.ts';
import type { Fixture, Headers } from './test-support.ts';

function readyResponse() {
  const fingerprint = { profile: syntheticProfile,sourceHash: 'd'.repeat(64) };
  return { data: { ready: true,...syntheticProfile,recoveryGeneration: 'generation',fingerprint,
    validation: { passed: true,fingerprintHash: createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex'),validatedAt: new Date().toISOString() } } };
}
function readinessProbe() {
  let blocked: Promise<void> | undefined, release: (() => void) | undefined, entered: (() => void) | undefined, calls = 0;
  const transport: RunnerTransport = async request => {
    assert.equal(request.op,'readiness'); calls++; entered?.();
    await blocked; return readyResponse();
  };
  return { transport,calls: () => calls,
    block() {
      blocked = new Promise(done => { release = done; });
      return new Promise<void>(done => { entered = done; });
    },
    release() { release?.(); blocked = undefined; entered = undefined; },
  };
}
async function runInput(f: Fixture, student: Headers, id: string) {
  const ids = await files(f,student,id), snapshotId = await snapshot(f,student,id), state = await view(f,student,id);
  return { expectedAttemptRevision: state.attempt.attemptRevision,snapshotId,runtimeProfileVersion: f.profile.runtimeProfileVersion,
    entryFileId: ids.source,input: { operation: 'stats',fileIds: [ids.input] },mode: 'course_check' };
}

test('review: late runs failure rolls back student session activity with Job, receipt and event', async () => {
  const f = await fixture();
  try {
    const teacher = await f.login('teacher'), student = await f.login(), allocation = await assigned(f,teacher), id = await opened(f,student,allocation.assignmentId);
    const input = await runInput(f,student,id);
    const persisted = () => f.db.withTransaction(tx => ({ activity: tx.get("SELECT last_active_at_ms AS value FROM sessions WHERE user_id='student'")!.value,
      jobs: tx.get('SELECT COUNT(*) AS n FROM jobs')!.n,receipts: tx.get('SELECT COUNT(*) AS n FROM command_receipts')!.n,events: tx.get('SELECT COUNT(*) AS n FROM audit_events')!.n }));
    const before = persisted(); f.advance(1000); f.injectFailure('INSERT INTO workspace_runs');
    const failed = await command(f,student,`/api/attempts/${id}/runs`,input,'atomic-run');
    assert.equal(failed.statusCode,503,failed.body); assert.equal(failed.json().error.code,'PERSISTENCE_UNAVAILABLE');
    assert.deepEqual(persisted(),before);
    f.injectFailure('');
    const accepted = await command(f,student,`/api/attempts/${id}/runs`,input,'atomic-run');
    assert.equal(accepted.statusCode,200,accepted.body); assert.equal(persisted().activity,f.timestamp());
  } finally { await f.close(); }
});

test('review: original run ACK and conflicts return before pending readiness; authorization still applies', async () => {
  const probe = readinessProbe(), f = await fixture(probe.transport);
  try {
    const teacher = await f.login('teacher'), student = await f.login(), allocation = await assigned(f,teacher), id = await opened(f,student,allocation.assignmentId);
    const input = await runInput(f,student,id), accepted = await command(f,student,`/api/attempts/${id}/runs`,input,'replay');
    assert.equal(accepted.statusCode,200,accepted.body);
    const before = probe.calls(), entered = probe.block();
    const replay = command(f,student,`/api/attempts/${id}/runs`,input,'replay');
    try {
      const first = await Promise.race([replay.then(response => ({ kind: 'ack' as const,response })),entered.then(() => ({ kind: 'readiness' as const }))]);
      assert.equal(first.kind,'ack','A committed ACK must not consult readiness.');
      if (first.kind === 'ack') {
        assert.equal(first.response.statusCode,200,first.response.body);
        assert.equal(first.response.json().data.receiptId,accepted.json().data.receiptId);
        assert.deepEqual(first.response.json().data.result,accepted.json().data.result);
      }
      assert.equal(probe.calls(),before);
      const conflict = await command(f,student,`/api/attempts/${id}/runs`,{ ...input,mode: 'run' },'replay');
      assert.equal(conflict.json().error.code,'IDEMPOTENCY_CONFLICT'); assert.equal(probe.calls(),before);
      f.db.withTransaction(tx => tx.run("UPDATE course_memberships SET active=0 WHERE user_id='student'"));
      assert.equal((await command(f,student,`/api/attempts/${id}/runs`,input,'replay')).statusCode,403);
      assert.equal(probe.calls(),before);
    } finally { probe.release(); await replay; }
  } finally { await f.close(); }
});

test('review: concurrent new runs recheck the original receipt after readiness', async () => {
  const probe = readinessProbe(), f = await fixture(probe.transport);
  try {
    const teacher = await f.login('teacher'), student = await f.login(), allocation = await assigned(f,teacher), id = await opened(f,student,allocation.assignmentId);
    const input = await runInput(f,student,id), entered = probe.block();
    const pending = [command(f,student,`/api/attempts/${id}/runs`,input,'race'),command(f,student,`/api/attempts/${id}/runs`,input,'race')];
    await entered; probe.release();
    const responses = await Promise.all(pending);
    for (const response of responses) assert.equal(response.statusCode,200,response.body);
    assert.equal(responses[0]!.json().data.receiptId,responses[1]!.json().data.receiptId);
    assert.equal(f.db.withTransaction(tx => tx.get('SELECT COUNT(*) AS n FROM jobs')!.n),1);
  } finally { probe.release(); await f.close(); }
});

test('review: current teacher reads retained workspace, snapshot and run after student withdrawal', async () => {
  const f = await fixture();
  try {
    const teacher = await f.login('teacher'), student = await f.login(), foreign = await f.login('foreign');
    const allocation = await assigned(f,teacher), id = await opened(f,student,allocation.assignmentId), input = await runInput(f,student,id);
    const accepted = await command(f,student,`/api/attempts/${id}/runs`,input);
    assert.equal(accepted.statusCode,200,accepted.body);
    const { runId,jobId } = accepted.json().data.result;
    const urls = [`/api/attempts/${id}`,`/api/attempts/${id}/snapshots/${input.snapshotId}`,`/api/attempts/${id}/runs/${runId}`,
      `/api/attempts/${id}/runs/${runId}/files`,`/api/jobs/${jobId}`];
    for (const url of urls) assert.equal((await f.app.inject({ url,headers: teacher })).statusCode,200);
    f.db.withTransaction(tx => tx.run("UPDATE course_memberships SET active=0 WHERE user_id='student'"));
    for (const url of urls) {
      const retained = await f.app.inject({ url,headers: teacher }); assert.equal(retained.statusCode,200,retained.body);
      assert.equal((await f.app.inject({ url,headers: student })).statusCode,403);
      assert.equal((await f.app.inject({ url,headers: foreign })).statusCode,403);
    }
    f.db.withTransaction(tx => tx.run("UPDATE course_memberships SET active=0 WHERE user_id='teacher'"));
    assert.equal((await f.app.inject({ url: urls[0]!,headers: teacher })).statusCode,403);
  } finally { await f.close(); }
});

test('review: real RunControl preparation failure ends check without fabricating a RunRecord', async () => {
  const root = mkdtempSync(join(tmpdir(),'xunjie-c2-review-control-'));
  const control = new RunControl(root,'generation',actor => actor === 'synthetic-application',async () => true);
  let identity: RunIdentity | undefined;
  const transport: RunnerTransport = async request => {
    if (request.op === 'readiness') return readyResponse();
    if (request.op === 'submit') {
      identity = request.submission.identity;
      return { data: await control.submitRun('synthetic-application',identity,async () => { throw new Error('Synthetic preparation failure.'); }) };
    }
    if (request.op === 'cancel') return { data: await control.cancelRun('synthetic-application',request.identity) };
    if (request.op === 'readResult') return { data: await control.readResult('synthetic-application',request.identity) ?? null };
    return { data: await control.queryRun('synthetic-application',request.identity) ?? null };
  };
  const f = await fixture(transport);
  try {
    const teacher = await f.login('teacher'), student = await f.login(), allocation = await assigned(f,teacher), id = await opened(f,student,allocation.assignmentId);
    const input = await runInput(f,student,id), accepted = await command(f,student,`/api/attempts/${id}/runs`,input);
    assert.equal(accepted.statusCode,200,accepted.body);
    const { jobId } = accepted.json().data.result;
    await f.workspace.processJob(jobId); assert.ok(identity);
    for (let i = 0;i < 100 && (await control.queryRun('synthetic-application',identity))?.state !== 'failed';i++) await setTimeout(5);
    const fact = await control.queryRun('synthetic-application',identity);
    assert.ok(fact); assert.equal(fact.state,'failed'); assert.equal(fact.reserved,false); assert.equal(fact.resultRef,undefined);
    await f.workspace.processJob(jobId);
    const state = await view(f,student,id);
    assert.equal(state.jobs[0].status,'failed'); assert.equal(state.checks[0].state,'ended');
    assert.equal(state.runs[0].diagnostics.status,'unavailable');
    const persisted = f.db.withTransaction(tx => ({ job: tx.get('SELECT job_json FROM jobs WHERE job_id=?',jobId)!,run: tx.get('SELECT result_json,result_hash FROM workspace_runs WHERE job_id=?',jobId)! }));
    assert.equal(JSON.parse(String(persisted.job.job_json)).failure,'original_runner_failed_without_result');
    assert.equal(persisted.run.result_json,null); assert.equal(persisted.run.result_hash,null);
    assert.equal((await f.app.inject({ url: `/fixture/tutor/${id}`,headers: student })).json().data.helpAllowed,true);
    const stop = await command(f,student,`/api/jobs/${jobId}/cancel`,{});
    assert.equal(stop.statusCode,200,stop.body); assert.equal((await view(f,student,id)).jobs[0].status,'failed');
    await f.reopen();
    assert.equal((await view(f,student,id)).checks[0].state,'ended');
    const next = await command(f,student,`/api/attempts/${id}/runs`,{ ...input,expectedAttemptRevision: (await view(f,student,id)).attempt.attemptRevision });
    assert.equal(next.statusCode,200,next.body);
  } finally { await f.close(); control.close(); }
});
