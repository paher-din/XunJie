import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { RunFact, SubmitRun } from '../../contracts/runner/index.ts';
import { sha256 } from '../../runner/snapshot.ts';
import type { RunnerTransport } from '../records/runner.ts';
import { createTutoringApp } from '../tutoring/application.ts';
import { fixture, assigned, opened, view, files, snapshot, command, origin, syntheticProfile } from './test-support.ts';
import type { Fixture, Headers } from './test-support.ts';

/** In-memory authenticated runner protocol only: no process, node or model is contacted. */
function syntheticRunner() {
  let submission: SubmitRun | null = null, fact: RunFact | null = null, result: object | null = null;
  let lose = false, confirmedStop = false;
  const transport: RunnerTransport = async input => {
    if (input.op === 'readiness') {
      const fingerprint = { profile: syntheticProfile, sourceHash: 'd'.repeat(64) };
      return { data: { ready: true, ...syntheticProfile, recoveryGeneration: 'generation', fingerprint,
        validation: { passed: true, fingerprintHash: createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex'),
          validatedAt: new Date().toISOString() } } };
    }
    if (input.op === 'submit') {
      submission = input.submission;
      fact = { identity: submission.identity, state: 'running', reserved: true, stopRequested: false,
        units: ['synthetic-unit'], pending: [] };
      if (lose) { lose = false; throw new Error('Synthetic transport loss after acceptance'); }
    }
    if (input.op === 'cancel') {
      fact = { identity: input.identity, state: confirmedStop ? 'cancelled' : 'cancelling',
        reserved: !confirmedStop, stopRequested: true, units: confirmedStop ? [] : ['synthetic-unit'], pending: [] };
    }
    return { data: input.op === 'readResult' ? result : fact };
  };
  return { transport, loseNext: () => { lose = true; }, confirmStop: () => { confirmedStop = true; },
    finish() {
      assert.ok(submission); assert.ok(fact);
      result = { ...submission.identity, unitTerminated: true, verdict: 'failed',
        phases: [{ stdout: 'PRIVATE_CHECK_OUTPUT', stderr: '' }], checkResults: [{ expected: 'PRIVATE_CHECK_OUTPUT' }] };
      fact = { ...fact, state: 'succeeded', reserved: false, units: [], resultRef: 'synthetic-result', resultHash: sha256(JSON.stringify(result)) };
    } };
}

async function setup(limitedHelp: boolean) {
  const node = syntheticRunner(), f = await fixture(node.transport, { teaching: true });
  const teacher = await f.login('teacher'), student = await f.login();
  const allocation = await assigned(f, teacher, limitedHelp), id = await opened(f, student, allocation.assignmentId);
  return { node, f, teacher, student, allocation, id };
}
async function startCheck(f: Fixture, student: Headers, id: string) {
  const ids = await files(f, student, id), snapshotId = await snapshot(f, student, id), head = await view(f, student, id);
  const response = await command(f, student, `/api/attempts/${id}/runs`, { expectedAttemptRevision: head.attempt.attemptRevision,
    snapshotId, runtimeProfileVersion: f.profile.runtimeProfileVersion, entryFileId: ids.source,
    input: { operation: 'stats', fileIds: [ids.input] }, mode: 'course_check' });
  assert.equal(response.statusCode, 200, response.body);
  return String(response.json().data.result.jobId);
}
async function tutoring(f: Fixture, node: ReturnType<typeof syntheticRunner>) {
  return createTutoringApp({ db: f.db, origin, signingSecret: f.signingSecret, currentGeneration: f.generation,
    now: f.timestamp, runner: node.transport,
    studentHelp: { versions: { modelConfig: 'deepseek-flash-v1', prompt: 'student-help-v1', schema: 'student-help-v1', policy: 'help-v1' },
      budgetAvailable: () => true } });
}

for (const limitedHelp of [true, false]) {
  test(`public Attempt uses the fixed limitedHelp=${limitedHelp} rule for an active check`, async () => {
    const { f, node, student, id } = await setup(limitedHelp);
    try {
      const before = await view(f, student, id);
      assert.equal(before.limitedCheck, false); assert.equal(before.attempt.status, 'ready'); assert.equal(before.jobs.length, 0);
      const again = await view(f, student, id);
      assert.deepEqual(again.attempt, before.attempt); assert.equal(again.jobs.length, 0);
      await startCheck(f, student, id);
      const head = await view(f, student, id);
      assert.equal(head.checks[0].state, 'active'); assert.equal(head.limitedCheck, limitedHelp);
      const service = await tutoring(f, node);
      try {
        // The real help route still checks the persisted restriction; the projection grants no authority.
        const response = await service.app.inject({ method: 'POST', url: `/api/attempts/${id}/help`,
          headers: { ...student, 'idempotency-key': randomUUID() }, payload: { recoveryGeneration: f.generation(),
            expectedAttemptRevision: head.attempt.attemptRevision, question: 'Explain this step' } });
        assert.equal(response.statusCode, limitedHelp ? 409 : 200, response.body);
        const current = await view(f, student, id);
        assert.equal(current.jobs.filter((job: { purpose: string }) => job.purpose === 'student_help').length, limitedHelp ? 0 : 1);
      } finally { await service.app.close(); }
    } finally { await f.close(); }
  });
}

test('unknown execution and restart keep the restriction until the original result is confirmed', async () => {
  const { f, node, student, id } = await setup(true);
  try {
    const jobId = await startCheck(f, student, id);
    node.loseNext(); await f.workspace.processJob(jobId);
    const unknown = await view(f, student, id);
    assert.equal(unknown.jobs[0].status, 'outcome_unknown'); assert.equal(unknown.checks[0].state, 'active'); assert.equal(unknown.limitedCheck, true);
    await f.reopen();
    assert.equal((await view(f, student, id)).limitedCheck, true);
    node.finish(); await f.workspace.processJob(jobId);
    const ended = await view(f, student, id);
    assert.equal(ended.checks[0].state, 'ended'); assert.equal(ended.limitedCheck, false);
    assert.equal(ended.attempt.attemptRevision, unknown.attempt.attemptRevision);
    assert.equal(ended.attempt.decisionEpoch, unknown.attempt.decisionEpoch);
    assert.equal(JSON.stringify(ended).includes('PRIVATE_CHECK_OUTPUT'), false);
  } finally { await f.close(); }
});

test('a cancel ACK and an unconfirmed runner stop do not clear the persisted restriction', async () => {
  const { f, node, student, id } = await setup(true);
  try {
    const jobId = await startCheck(f, student, id);
    await f.workspace.processJob(jobId);
    const response = await command(f, student, `/api/jobs/${jobId}/cancel`, {});
    assert.equal(response.statusCode, 200, response.body);
    assert.equal((await view(f, student, id)).limitedCheck, true);
    await f.workspace.processJob(jobId);
    const pending = await view(f, student, id);
    assert.equal(pending.jobs[0].status, 'cancelling'); assert.equal(pending.checks[0].state, 'active'); assert.equal(pending.limitedCheck, true);
    node.confirmStop(); await f.workspace.processJob(jobId);
    const ended = await view(f, student, id);
    assert.equal(ended.jobs[0].status, 'cancelled'); assert.equal(ended.checks[0].state, 'ended'); assert.equal(ended.limitedCheck, false);
  } finally { await f.close(); }
});

test('paused Attempt and assignment remain readable without releasing an active limited check', async () => {
  const { f, student, teacher, allocation, id } = await setup(true);
  try {
    await startCheck(f, student, id);
    const head = await view(f, student, id);
    const pause = await command(f, student, `/api/attempts/${id}/controls`, { expectedAttemptRevision: head.attempt.attemptRevision, control: { kind: 'pause' } });
    assert.equal(pause.statusCode, 200, pause.body);
    const paused = await view(f, student, id);
    assert.equal(paused.attempt.status, 'paused'); assert.equal(paused.limitedCheck, true);
    const platform = await command(f, teacher, `/api/activities/${allocation.activityId}/controls`, {
      expectedActivityControlRevision: 1, action: 'pause', reason: 'Synthetic check pause' });
    assert.equal(platform.statusCode, 200, platform.body);
    const platformPaused = await view(f, student, id);
    assert.equal(platformPaused.limitedCheck, true); assert.equal(platformPaused.attempt.status, 'paused');
    const denied = await f.app.inject({ url: `/api/attempts/${id}`, headers: await f.login('other') });
    assert.equal(denied.statusCode, 403); assert.equal(denied.json().data, undefined);
  } finally { await f.close(); }
});

test('limitedCheck=false does not allow help on a paused Attempt', async () => {
  const { f, node, student, id } = await setup(true);
  try {
    await files(f, student, id);
    const head = await view(f, student, id);
    const pause = await command(f, student, `/api/attempts/${id}/controls`, { expectedAttemptRevision: head.attempt.attemptRevision, control: { kind: 'pause' } });
    assert.equal(pause.statusCode, 200, pause.body);
    const paused = await view(f, student, id);
    assert.equal(paused.limitedCheck, false);
    const service = await tutoring(f, node);
    try {
      const response = await service.app.inject({ method: 'POST', url: `/api/attempts/${id}/help`,
        headers: { ...student, 'idempotency-key': randomUUID() }, payload: { recoveryGeneration: f.generation(),
          expectedAttemptRevision: paused.attempt.attemptRevision, question: 'Explain this step' } });
      assert.equal(response.statusCode, 409, response.body);
      assert.equal((await view(f, student, id)).jobs.length, 0);
    } finally { await service.app.close(); }
  } finally { await f.close(); }
});
