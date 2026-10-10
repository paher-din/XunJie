import { randomUUID } from 'node:crypto';
import type { DesignAppOptions } from '../design/application.ts';
import type { Transaction } from '../db/transaction.ts';
import { assignmentAvailability } from '../design/activities.ts';
import { finishCommand, requestHash } from '../records/commands.ts';
import { cancelJob } from '../records/jobs.ts';
import { dispatchOriginalRun, queryOriginalRun, stopOriginalRun, readOriginalResult } from '../records/runner.ts';
import { loadWorkspace, persistWorkspace } from './storage.ts';
import { claimRun, claimRunReconciliation, markRunUnknown, reconcileRun, confirmNodeCancellation } from './commands.ts';
import type { WorkspaceState } from './commands.ts';
import type { Job } from '../../contracts/records/index.ts';
import { ApiError, domainError } from '../app/errors.ts';

const terminal = new Set(['succeeded','failed','cancelled','stale','timed_out']);
export function createWorkspaceWorker(options: DesignAppOptions) {
  const now = options.now ?? Date.now;
  const timestamp = () => new Date(now()).toISOString();
  const persisted = <T>(work: (tx: Transaction) => T) => {
    try { return options.db.withTransaction(work); } catch (error) { throw domainError(error, 'PERSISTENCE_UNAVAILABLE'); }
  };
  function original(tx: Transaction, jobId: string) {
    const row = tx.get('SELECT attempt_id FROM jobs WHERE job_id=?', jobId);
    if (!row?.attempt_id) throw new ApiError('FORBIDDEN');
    const state = loadWorkspace(tx, String(row.attempt_id));
    const job = state.records.jobs.find(item => item.jobId === jobId), run = state.runs.find(item => item.jobId === jobId);
    if (!job || !run || job.purpose !== 'student_run') throw new ApiError('FORBIDDEN');
    if (job.recoveryGeneration !== options.currentGeneration()) throw new ApiError('RECOVERY_REQUIRED');
    return { state, job, run };
  }
  function permitted(tx: Transaction, state: WorkspaceState, job: Job) {
    const member = tx.get("SELECT user_id FROM course_memberships WHERE course_id=? AND user_id=? AND role='student' AND active=1", state.attempt.courseId, state.attempt.studentId);
    const user = tx.get('SELECT disabled_at_ms FROM users WHERE id=?', state.attempt.studentId);
    if (!member || !user || user.disabled_at_ms !== null) return false;
    const availability = assignmentAvailability(tx, state.attempt.courseId, state.attempt.assignmentId, state.attempt.studentId);
    return availability.active && state.attempt.status === 'active' && state.attempt.decisionEpoch === job.decisionEpoch && !job.stopRequested;
  }
  function save(tx: Transaction, before: WorkspaceState, after: WorkspaceState, jobId: string) {
    const job = after.records.jobs.find(item => item.jobId === jobId)!;
    const identity = { actorId: before.attempt.studentId, command: 'run.progress', target: jobId,
      scope: job.scope, idempotencyKey: randomUUID(), recoveryGeneration: options.currentGeneration() };
    const receiptId = randomUUID(), at = timestamp();
    const result = { jobId, runId: job.runId!, status: job.status, stopRequested: job.stopRequested };
    const plan = finishCommand(after.records, { receiptId, commandId: randomUUID(), identity,
      requestHash: requestHash(jobId, result), result, committedAt: at }, { eventId: randomUUID(), scope: job.scope,
      type: 'run.progress', occurredAt: at, source: 'trusted_service', payloadRef: receiptId }, identity.recoveryGeneration);
    persistWorkspace(tx, before, { ...after, records: plan.records });
  }
  async function processJob(jobId: string) {
    if (!options.runner) throw new ApiError('DEPENDENCY_UNAVAILABLE');
    const runner = options.runner;
    const work = persisted(tx => {
      const originalWork = original(tx, jobId), { state, job } = originalWork;
      if (terminal.has(job.status)) return undefined;
      if (!job.stopRequested && job.leaseUntil && Date.parse(job.leaseUntil) > now()) return undefined;
      let next = state, dispatch = false;
      if (!permitted(tx, state, job) || Date.parse(job.deadline) <= now())
        next = { ...next, records: { ...next.records, jobs: next.records.jobs.map(item => item.jobId === jobId ? cancelJob(item) : item) } };
      const current = next.records.jobs.find(item => item.jobId === jobId)!;
      if (current.status === 'queued') {
        const busy = tx.get("SELECT COUNT(*) AS count FROM jobs WHERE purpose IN ('student_run','teacher_sample') AND status IN ('running','outcome_unknown','cancelling')");
        if (Number(busy?.count) >= 2) return undefined;
        next = claimRun(next, jobId, randomUUID(), new Date(Math.min(now() + 150000, Date.parse(job.deadline))).toISOString(), options.currentGeneration(), timestamp());
        dispatch = next.records.jobs.find(item => item.jobId === jobId)!.status === 'running';
      } else {
        next = claimRunReconciliation(next,jobId,randomUUID(),new Date(now()+150000).toISOString(),options.currentGeneration(),timestamp());
      }
      save(tx, state, next, jobId);
      return { ...originalWork, job: next.records.jobs.find(item => item.jobId === jobId)!, dispatch };
    });
    if (!work) return;
    const generation = work.job.recoveryGeneration, lease = work.job.leaseToken!;
    const current = (requirePermission = false) => persisted(tx => {
      const item = original(tx, jobId);
      return item.job.leaseToken === lease && !!item.job.leaseUntil && Date.parse(item.job.leaseUntil) > now()
        && item.job.recoveryGeneration === generation && (!requirePermission || permitted(tx, item.state, item.job));
    });
    try {
      const fact = work.job.stopRequested
        ? await stopOriginalRun(work.run.submission, runner, () => current())
        : work.dispatch
          ? await dispatchOriginalRun(work.run.submission, runner, () => current(true))
          : await queryOriginalRun(work.run.submission, runner, () => current());
      const result = fact?.resultRef ? await readOriginalResult(work.run.submission, runner, () => current()) : undefined;
      persisted(tx => {
        const { state, job } = original(tx, jobId);
        if (job.leaseToken !== lease || !job.leaseUntil || Date.parse(job.leaseUntil) <= now()) throw new ApiError('STATE_CONFLICT');
        let next = state;
        if (!permitted(tx, state, job)) next = { ...next, records: { ...next.records, jobs: next.records.jobs.map(item => item.jobId === jobId ? cancelJob(item) : item) } };
        if (result) next = reconcileRun(next, jobId, result, lease, generation, timestamp());
        else if (fact?.state === 'cancelled' && fact.stopRequested && !fact.reserved && !fact.pending.length)
          next = confirmNodeCancellation(next, jobId, fact, generation);
        else if (!fact || fact.state === 'outcome_unknown') next = markRunUnknown(next, jobId, generation);
        else if (!next.records.jobs.find(item => item.jobId === jobId)!.stopRequested && fact.state === 'running') next = { ...next, records: { ...next.records,
          jobs: next.records.jobs.map(item => item.jobId === jobId ? { ...item, status: 'running' as const } : item) } };
        next = { ...next, records: { ...next.records, jobs: next.records.jobs.map(item => item.jobId === jobId ? { ...item, leaseUntil: timestamp() } : item) } };
        save(tx, state, next, jobId);
      });
    } catch (error) {
      // SQL failures remain failures; only a lost/rejected transport produces an unknown original outcome.
      const failure = domainError(error, 'DEPENDENCY_UNAVAILABLE');
      if (['PERSISTENCE_UNAVAILABLE','RECOVERY_REQUIRED'].includes(failure.code)) throw failure;
      persisted(tx => {
        const { state, job } = original(tx, jobId);
        if (job.leaseToken !== lease || terminal.has(job.status)) throw new ApiError('STATE_CONFLICT');
        let next = state;
        if (!permitted(tx, state, job)) next = { ...next, records: { ...next.records, jobs: next.records.jobs.map(item => item.jobId === jobId ? cancelJob(item) : item) } };
        next = markRunUnknown(next, jobId, generation);
        next = { ...next, records: { ...next.records, jobs: next.records.jobs.map(item => item.jobId === jobId ? { ...item, leaseUntil: timestamp() } : item) } };
        save(tx, state, next, jobId);
      });
    }
  }
  return {
    processJob,
    pendingJobs() {
      return persisted(tx => tx.all("SELECT job_id FROM jobs WHERE purpose='student_run' AND status IN ('queued','running','outcome_unknown','cancelling') ORDER BY job_id").map(row => String(row.job_id)));
    },
  };
}
