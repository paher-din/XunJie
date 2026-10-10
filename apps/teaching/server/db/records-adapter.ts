import { z } from 'zod';
import type { Attempt } from '../../contracts/workspace/index.ts';
import type { Job, CommandIdentity, CommandReceipt, Records, AuditEvent } from '../../contracts/records/index.ts';
import { finishCommand, requestHash, resolveCommandReceipt, sameScope } from '../records/commands.ts';
import { enqueueJob, cancelByPurpose } from '../records/jobs.ts';
import type { Purpose } from '../../contracts/records/index.ts';
import { ApiError } from '../app/errors.ts';
import type { Transaction } from './transaction.ts';
import { randomUUID } from 'node:crypto';

const id = z.string().min(1);
const natural = z.number().int().nonnegative();
const scopeSchema = z.strictObject({ courseId: id, studentId: id.optional(), attemptId: id.optional(), blueprintId: id.nullable().optional() });
const identitySchema = z.strictObject({ actorId: id, command: id, target: id, scope: scopeSchema, idempotencyKey: id, recoveryGeneration: id,
  sync: z.strictObject({ clientId: id, clientSeq: natural }).optional() });
const time = id.refine(value => Number.isFinite(Date.parse(value)));
const purposeSchema = z.enum(['teacher_design', 'student_help', 'reminder', 'explicit_analysis', 'passive_analysis', 'student_run', 'teacher_sample']);
const jobSchema = z.strictObject({ jobId: id, kind: id, purpose: purposeSchema, scope: scopeSchema, requestReceiptId: id,
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelling', 'cancelled', 'stale', 'timed_out', 'outcome_unknown']),
  stopRequested: z.boolean(), expectedRevision: natural, decisionEpoch: natural, recoveryGeneration: id,
  acceptedAt: time, deadline: time, attemptCount: natural.max(3), leaseToken: id.optional(), leaseUntil: time.optional(),
  runId: id.optional(), resultRef: id.optional(), resultHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), failure: id.optional() });
const receiptSchema = z.strictObject({ receiptId: id, commandId: id, identity: identitySchema, requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  result: z.json(), serverSeq: z.number().int().positive(), committedAt: time });
const eventSchema = z.strictObject({ eventId: id, serverSeq: z.number().int().positive(), scope: scopeSchema, type: id,
  occurredAt: time, source: z.enum(['student_command', 'trusted_service']), payloadRef: id.optional() });
const objectRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('project'), attemptId: id, activityVersionId: id }),
  z.strictObject({ kind: z.literal('run'), attemptId: id, runId: id, snapshotId: id }),
  z.strictObject({ kind: z.literal('resource'), attemptId: id, resourceVersionId: id, paragraphId: id }),
  z.strictObject({ kind: z.literal('code'), attemptId: id, snapshotId: id, fileId: id, path: id, documentVersion: z.number().int().positive(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/), range: z.strictObject({ startLine: z.number().int().positive(), startColumn: z.number().int().positive(),
      endLine: z.number().int().positive(), endColumn: z.number().int().positive() }).optional(),
    source: z.strictObject({ system: z.literal('student-ide'), session: id, modelId: id, seq: natural.optional() }).optional() }),
]);
const attemptSchema = z.strictObject({ attemptId: id, courseId: id, studentId: id, assignmentId: id, activityVersionId: id,
  status: z.enum(['ready', 'active', 'paused', 'submitted', 'reviewed']), attemptRevision: z.number().int().positive(), workspaceRevision: natural,
  decisionEpoch: natural, captureRevision: natural, collecting: z.boolean(), reminders: z.boolean(),
  route: z.string().optional(), question: z.string().optional(), returnPosition: objectRefSchema.optional() });
function persisted<Schema extends z.ZodType>(schema: Schema, json: string): z.output<Schema> {
  const value = schema.safeParse(JSON.parse(json));
  if (!value.success) throw new Error('Invalid persisted shared record.');
  return value.data;
}

export function readAttempt(tx: Transaction, attemptId: string): Attempt {
  const row = tx.get('SELECT * FROM attempts WHERE attempt_id=?', attemptId);
  if (!row) throw new ApiError('FORBIDDEN');
  const attempt = persisted(attemptSchema, String(row.attempt_json)) as Attempt;
  if (attempt.attemptId !== row.attempt_id || attempt.courseId !== row.course_id || attempt.studentId !== row.student_id
    || attempt.assignmentId !== row.assignment_id || attempt.activityVersionId !== row.activity_id
    || attempt.attemptRevision !== row.attempt_revision || attempt.decisionEpoch !== row.decision_epoch) throw new Error('Invalid persisted attempt scope.');
  return attempt;
}
export function saveAttempt(tx: Transaction, attempt: Attempt) {
  const checked = persisted(attemptSchema, JSON.stringify(attempt)) as Attempt;
  const old = tx.get('SELECT attempt_json FROM attempts WHERE attempt_id=?', checked.attemptId);
  if (old) {
    const current = readAttempt(tx, checked.attemptId);
    if (checked.attemptRevision === current.attemptRevision && JSON.stringify(checked) === JSON.stringify(current)) return;
    if (checked.attemptRevision !== current.attemptRevision + 1 || checked.decisionEpoch < current.decisionEpoch) throw new ApiError('VERSION_CONFLICT');
  }
  const assignment = tx.get('SELECT * FROM assignments WHERE id=? AND course_id=? AND student_id=? AND activity_id=?',
    checked.assignmentId, checked.courseId, checked.studentId, checked.activityVersionId);
  if (!assignment) throw new ApiError('FORBIDDEN');
  tx.run(`INSERT INTO attempts(attempt_id,course_id,student_id,assignment_id,activity_id,attempt_revision,decision_epoch,attempt_json)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(attempt_id) DO UPDATE SET attempt_revision=excluded.attempt_revision,
    decision_epoch=excluded.decision_epoch,attempt_json=excluded.attempt_json
    WHERE attempts.course_id=excluded.course_id AND attempts.student_id=excluded.student_id
    AND attempts.assignment_id=excluded.assignment_id AND attempts.activity_id=excluded.activity_id`, checked.attemptId,
    checked.courseId, checked.studentId, checked.assignmentId, checked.activityVersionId, checked.attemptRevision, checked.decisionEpoch, JSON.stringify(checked));
  const saved = readAttempt(tx, checked.attemptId);
  if (JSON.stringify(saved) !== JSON.stringify(checked)) throw new ApiError('FORBIDDEN');
}
export function readJobs(tx: Transaction, courseId: string): Job[] {
  return tx.all('SELECT * FROM jobs WHERE course_id=?', courseId).map(row => {
    const job = persisted(jobSchema, String(row.job_json)) as Job;
    if (job.jobId !== row.job_id || job.scope.courseId !== row.course_id || (job.scope.studentId ?? null) !== row.student_id
      || (job.scope.attemptId ?? null) !== row.attempt_id || job.requestReceiptId !== row.request_receipt_id
      || job.purpose !== row.purpose || job.status !== row.status || Number(job.stopRequested) !== row.stop_requested
      || job.recoveryGeneration !== row.recovery_generation) throw new Error('Invalid persisted job scope.');
    return job;
  });
}
export function saveJob(tx: Transaction, input: Job) {
  const job = persisted(jobSchema, JSON.stringify(input)) as Job;
  if (job.scope.attemptId) {
    const attempt = readAttempt(tx, job.scope.attemptId);
    if (attempt.courseId !== job.scope.courseId || attempt.studentId !== job.scope.studentId) throw new ApiError('FORBIDDEN');
  }
  const receipt = tx.get('SELECT course_id,result_json FROM command_receipts WHERE receipt_id=?', job.requestReceiptId);
  if (!receipt || receipt.course_id !== job.scope.courseId) throw new ApiError('INVALID_REFERENCE');
  const original = persisted(receiptSchema, String(receipt.result_json)) as CommandReceipt;
  if (!sameScope(original.identity.scope, job.scope) || original.receiptId !== job.requestReceiptId
    || original.identity.recoveryGeneration !== job.recoveryGeneration) throw new ApiError('INVALID_REFERENCE');
  const oldJob = tx.get('SELECT stop_requested FROM jobs WHERE job_id=?', job.jobId);
  if (oldJob?.stop_requested === 1 && !job.stopRequested) throw new ApiError('STATE_CONFLICT');
  tx.run(`INSERT INTO jobs(job_id,course_id,student_id,attempt_id,request_receipt_id,purpose,status,stop_requested,recovery_generation,job_json)
    VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET status=excluded.status,stop_requested=excluded.stop_requested,
    job_json=excluded.job_json WHERE jobs.course_id=excluded.course_id AND jobs.student_id IS excluded.student_id
    AND jobs.attempt_id IS excluded.attempt_id AND jobs.request_receipt_id=excluded.request_receipt_id
    AND jobs.purpose=excluded.purpose AND jobs.recovery_generation=excluded.recovery_generation`, job.jobId, job.scope.courseId,
    job.scope.studentId ?? null, job.scope.attemptId ?? null, job.requestReceiptId, job.purpose, job.status, Number(job.stopRequested), job.recoveryGeneration, JSON.stringify(job));
  const saved = readJobs(tx, job.scope.courseId).find(row => row.jobId === job.jobId);
  if (JSON.stringify(saved) !== JSON.stringify(job)) throw new ApiError('FORBIDDEN');
}
function readRecords(tx: Transaction, courseId: string): Records {
  const receipts = tx.all("SELECT * FROM command_receipts WHERE course_id=? AND command LIKE 'shared.%'", courseId).map(row => {
    const receipt = persisted(receiptSchema, String(row.result_json)) as CommandReceipt;
    if (receipt.receiptId !== row.receipt_id || receipt.commandId !== row.command_id || receipt.identity.actorId !== row.actor_id
      || receipt.identity.scope.courseId !== courseId || 'shared.' + receipt.identity.command !== row.command
      || receipt.identity.target !== row.target || receipt.identity.idempotencyKey !== row.idempotency_key
      || receipt.identity.recoveryGeneration !== row.recovery_generation || receipt.requestHash !== row.request_hash
      || receipt.serverSeq !== row.server_seq) throw new Error('Invalid persisted receipt scope.');
    return receipt;
  });
  const events = tx.all("SELECT * FROM audit_events WHERE course_id=? AND command LIKE 'shared.%'", courseId)
    .map(row => {
      const event = persisted(eventSchema, String(row.object_ref_json)) as AuditEvent;
      if (event.eventId !== row.event_id || event.serverSeq !== row.server_seq || event.scope.courseId !== row.course_id
        || 'shared.' + event.type !== row.command || Date.parse(event.occurredAt) !== row.committed_at_ms) throw new Error('Invalid persisted event scope.');
      const receipt = receipts.find(item => item.receiptId === event.payloadRef);
      if (!receipt || !sameScope(receipt.identity.scope, event.scope) || receipt.identity.actorId !== row.actor_id
        || receipt.commandId !== row.command_id || receipt.identity.target !== row.target
        || receipt.identity.recoveryGeneration !== row.recovery_generation || receipt.serverSeq !== event.serverSeq
        || receipt.committedAt !== event.occurredAt) throw new Error('Invalid persisted receipt/event association.');
      return event;
    });
  return { receipts, events, jobs: readJobs(tx, courseId), commandAliases: [],
    serverSeq: Number(tx.get('SELECT COALESCE(MAX(server_seq),0) AS seq FROM audit_events')!.seq) };
}
export function finishRecordCommand<T>(tx: Transaction, identity: CommandIdentity, fields: unknown,
  generation: string, now: number, work: (receiptId: string) => T, validateResult: (value: unknown) => T): CommandReceipt<T> {
  if (work.constructor.name === 'AsyncFunction' || validateResult.constructor.name === 'AsyncFunction') throw new ApiError('PERSISTENCE_UNAVAILABLE');
  const validatedResult = (value: unknown) => {
    const result = validateResult(value);
    if (result && (typeof result === 'object' || typeof result === 'function') && 'then' in result && typeof result.then === 'function') throw new ApiError('PERSISTENCE_UNAVAILABLE');
    return result;
  };
  if (identity.sync) throw new ApiError('INVALID_REQUEST'); // C2 owns sync-alias persistence, outside this approved seven-table batch.
  if (identity.recoveryGeneration !== generation) throw new ApiError('RECOVERY_REQUIRED');
  const records = readRecords(tx, identity.scope.courseId);
  const original = records.receipts.find(receipt => receipt.identity.actorId === identity.actorId && receipt.identity.command === identity.command
    && receipt.identity.target === identity.target && receipt.identity.idempotencyKey === identity.idempotencyKey);
  if (original && original.identity.recoveryGeneration !== generation) throw new ApiError('RECOVERY_REQUIRED');
  const hash = requestHash(identity.target, fields);
  const previous = resolveCommandReceipt(records, identity, hash, generation);
  if (previous) {
    if (previous.identity.recoveryGeneration !== generation) throw new ApiError('RECOVERY_REQUIRED');
    return { ...previous, result: validatedResult(previous.result) };
  }
  const receiptId = randomUUID(), commandId = randomUUID();
  const candidate = work(receiptId);
  if (candidate && typeof candidate === 'object' && 'then' in candidate && typeof candidate.then === 'function') throw new ApiError('PERSISTENCE_UNAVAILABLE');
  const result = validatedResult(candidate);

  const timestamp = new Date(now).toISOString();
  const plan = finishCommand(records, { receiptId, commandId, identity, requestHash: hash, result, committedAt: timestamp },
    { eventId: randomUUID(), scope: identity.scope, type: identity.command, occurredAt: timestamp, source: identity.scope.studentId === identity.actorId ? 'student_command' : 'trusted_service', payloadRef: receiptId }, generation);
  const receipt = plan.receipt as CommandReceipt<T>;
  const event = plan.records.events[plan.records.events.length - 1]!;
  tx.run(`INSERT INTO audit_events(server_seq,event_id,actor_id,course_id,command_id,command,target,object_ref_json,recovery_generation,committed_at_ms)
    VALUES (?,?,?,?,?,?,?,?,?,?)`, receipt.serverSeq, event.eventId, identity.actorId, identity.scope.courseId, commandId,
    'shared.' + identity.command, identity.target, JSON.stringify(event), generation, now);
  tx.run(`INSERT INTO command_receipts(receipt_id,command_id,actor_id,course_id,command,target,idempotency_key,request_hash,recovery_generation,server_seq,result_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, receiptId, commandId, identity.actorId, identity.scope.courseId, 'shared.' + identity.command,
    identity.target, identity.idempotencyKey, hash, generation, receipt.serverSeq, JSON.stringify(receipt));
  return receipt;
}
export function enqueueStoredJob(tx: Transaction, job: Job) {
  if (job.scope.attemptId) {
    const attempt = readAttempt(tx, job.scope.attemptId);
    if (attempt.courseId !== job.scope.courseId || attempt.studentId !== job.scope.studentId) throw new ApiError('FORBIDDEN');
    if (attempt.attemptRevision !== job.expectedRevision || attempt.decisionEpoch !== job.decisionEpoch) throw new ApiError('VERSION_CONFLICT');
  }
  const jobs = enqueueJob(readJobs(tx, job.scope.courseId), job);
  saveJob(tx, jobs[jobs.length - 1]!);
}
export function stopAttemptJobs(tx: Transaction, attempt: Attempt, purposes: Purpose[]) {
  const existing = readJobs(tx, attempt.courseId);
  const result = cancelByPurpose(existing, { courseId: attempt.courseId, studentId: attempt.studentId, attemptId: attempt.attemptId }, purposes);
  for (const job of result.jobs) if (result.jobIds.includes(job.jobId)) {
    // C2 requires a node tombstone even for a queued business run before confirming its termination.
    const previous = existing.find(row => row.jobId === job.jobId)!;
    saveJob(tx, job.purpose === 'student_run' && previous.status === 'queued' && job.status === 'cancelled'
      ? { ...job, status: 'cancelling' } : job);
  }
  return result.jobIds;
}