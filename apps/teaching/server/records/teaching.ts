import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { RunnerError, sha256 } from '../../runner/snapshot.ts';
import { canonical, finishCommand, requestHash, sameScope } from './commands.ts';
import { cancelByPurpose, enqueueJob, finishJob, invalidateInTransaction } from './jobs.ts';
import { readAttempt, readJobs, readRecords, saveAttempt, saveJob, saveRecordPlan, saveRecordPlanWithReference } from '../db/records-adapter.ts';
import { activityView, assignmentAvailability, readActivity } from '../design/activities.ts';
import { beginExplicitOperation, validateObjectRef } from '../workspace/snapshots.ts';
import { objectRef as objectRefSchema, snapshotSchema } from '../workspace/inputs.ts';
import type { Transaction } from '../db/transaction.ts';
import type { ArtifactSnapshot, Attempt, ObjectRef } from '../../contracts/workspace/index.ts';
import type { CommandIdentity, Job, Purpose, Scope, TeachingAction, TeachingActionReceipt, TeachingAttemptEpoch,
  TeachingBasis, TeachingDelivery, TeachingMessage, TeachingMessageEnvelope, TeachingQuestionEnvelope, TeachingScopeRef,
  TeachingUsage, TeachingVersions } from '../../contracts/records/index.ts';
import type { StudentHelpBody } from '../../contracts/tutoring/index.ts';
import { hdlHelpSelectionSchema,hdlHelpBasisSchema } from '../../contracts/workspace/hdl-help.ts';

export const teachingCommands = {question:'teaching.question',complete:'teaching.complete',stop:'teaching.stop',
  deliver:'teaching.deliver',receipt:'teaching.receipt',invalidate:'teaching.invalidate'} as const;

const id = z.string().min(1).max(128);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const natural = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positive = z.number().int().positive();
const versionsSchema = z.strictObject({ activityVersionId: id, policyVersionId: id, modelConfigVersion: id,
  promptVersion: id, schemaVersion: id, analysisVersion: id.optional() });
const usageSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('actual'), inputTokens: natural, outputTokens: natural }),
  z.strictObject({ status: z.literal('unknown'), reason: id.optional() })]);
const basisSchema = z.strictObject({ attemptRevision: positive, decisionEpoch: natural, captureRevision: natural,
  relatedStateRevision: natural, objectRef: objectRefSchema.optional(), hdl:hdlHelpBasisSchema.optional(), inputRefs: z.array(id), assistanceRefs: z.array(id), coverageRefs: z.array(id) });
const scopeSchema = z.strictObject({ courseId: id, studentId: id, attemptId: id });
const messageSchema = z.strictObject({ messageId: id, scope: scopeSchema, jobId: id, requestReceiptId: id.optional(),
  authorKind: z.enum(['student','model']), contentHash: hash, resultHash: hash.optional(),
  envelope: z.union([
    z.strictObject({ kind: z.literal('student_question'), question: z.string(), objectRef: objectRefSchema.optional(),
      hdlSelection:hdlHelpSelectionSchema.optional(),hdlBasis:hdlHelpBasisSchema.optional(),inputRefs: z.array(id), versions: versionsSchema }),
    z.strictObject({ kind: z.literal('student_help'), body: z.unknown(), bodyJsonText: z.string().optional(), versions: versionsSchema, usage: usageSchema,
      calls: natural, elapsedMs: natural, basis: basisSchema })]) });
const actionSchema = z.strictObject({ actionId: id, scope: scopeSchema, jobId: id, messageId: id, contentHash: hash,
  disposition: z.enum(['pending','cancelled','stale','failed']), targetVersions: versionsSchema, basis: basisSchema,
  generation: id, stopReason: id.optional(), causeRef: id.optional(), basisRevised: z.boolean(), createdAt: id });
const deliverySchema = z.strictObject({ deliveryId: id, actionId: id, recipientId: id, clientId: id, contentHash: hash,
  recoveryGeneration: id, serverSeq: positive, attemptedAt: id, control: z.strictObject({ attemptRevision: positive,
    decisionEpoch: natural, captureRevision: natural }), eventId: id.optional() });
const receiptSchema = z.strictObject({ receiptId: id, actionId: id, deliveryId: id.optional(), contentHash: hash,
  receiptKind: z.enum(['received','displayed','acknowledged','cancelled','stale','failed']), clientReceiptId: id, clientId: id,
  serverSeq: positive, clientDeclaredAt: id.optional(), serverReceivedAt: id, versions: versionsSchema, raceReason: id.optional() });

// Approved final bodies from B arrive as the exact UTF-8 JSON text that must stay retrievable byte for byte.
const studentHelpBodySchema = z.strictObject({ kind: z.literal('student_help'),
  actionType: z.enum(['plan','clarify','hint','explain','compare','verify_suggestion','reflect','extend','handoff_teacher','no_action']),
  content: z.string().min(1), rationale: z.string().min(1), expectedStudentAction: z.string().min(1),
  evidenceIds: z.array(id), resourceRefs: z.array(id), assistanceContext: z.string().min(1), unresolved: z.array(z.string()),
  policyChecks: z.strictObject({ containsWholeSolution: z.literal(false), writesStudentWork: z.literal(false),
    runsCode: z.literal(false), makesFormalEvaluation: z.literal(false) }) });

const validTime = (value: string) => Number.isFinite(Date.parse(value));
const checkedText = (value: unknown, label: string, max: number) => {
  if (typeof value !== 'string' || value.length === 0 || value.length > max
    || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value))
    throw new RunnerError('INVALID_REQUEST', `Valid ${label} text required`);
  return value;
};
const checkedHash = (value: unknown, label: string) => {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new RunnerError('INVALID_REFERENCE', `Trusted ${label} hash required`);
  return value;
};
const checkedNow = (value: string) => {
  if (!validTime(value)) throw new RunnerError('INVALID_REQUEST', 'Trusted time required');
  return value;
};
function persisted<Schema extends z.ZodType>(schema: Schema, json: string, label: string): z.output<Schema> {
  const value = schema.safeParse(JSON.parse(json));
  if (!value.success) throw new Error(`Invalid persisted ${label} record.`);
  return value.data;
}

function requireAttempt(tx: Transaction, attemptId: string) {
  const row = tx.get('SELECT attempt_id FROM attempts WHERE attempt_id=?', attemptId);
  if (!row) throw new RunnerError('INVALID_REFERENCE', 'Authorized attempt required');
  return readAttempt(tx, attemptId);
}
function requireScope(tx: Transaction, scope: TeachingScopeRef) {
  const attempt = requireAttempt(tx, scope.attemptId);
  if (attempt.courseId !== scope.courseId || attempt.studentId !== scope.studentId)
    throw new RunnerError('FORBIDDEN', 'Teaching scope mismatch');
  return attempt;
}
function jobOf(tx: Transaction, scope: TeachingScopeRef, jobId: string) {
  if (!jobId) throw new RunnerError('INVALID_REFERENCE', 'Original job required');
  const job = readJobs(tx, scope.courseId).find(row => row.jobId === jobId);
  if (!job || !sameScope(job.scope, scope)) throw new RunnerError('FORBIDDEN', 'Original job scope mismatch');
  return job;
}
function requireJobId(value: unknown) {
  const parsed = id.safeParse(value);
  if (!parsed.success) throw new RunnerError('INVALID_REQUEST', 'Trusted job ID required');
  return parsed.data;
}
function requireVersions(value: unknown, attempt: Attempt): TeachingVersions {
  const parsed = versionsSchema.safeParse(value);
  if (!parsed.success) throw new RunnerError('INVALID_REFERENCE', 'Trusted version envelope required');
  if (parsed.data.activityVersionId !== attempt.activityVersionId)
    throw new RunnerError('INVALID_REFERENCE', 'Fixed activity version mismatch');
  return { activityVersionId: parsed.data.activityVersionId, policyVersionId: parsed.data.policyVersionId,
    modelConfigVersion: parsed.data.modelConfigVersion, promptVersion: parsed.data.promptVersion,
    schemaVersion: parsed.data.schemaVersion,
    ...(parsed.data.analysisVersion === undefined ? {} : { analysisVersion: parsed.data.analysisVersion }) };
}
function requireBasis(value: unknown): TeachingBasis {
  const parsed = basisSchema.safeParse(value);
  if (!parsed.success) throw new RunnerError('INVALID_REFERENCE', 'Trusted basis envelope required');
  const basis: TeachingBasis = { attemptRevision: parsed.data.attemptRevision, decisionEpoch: parsed.data.decisionEpoch,
    captureRevision: parsed.data.captureRevision, relatedStateRevision: parsed.data.relatedStateRevision,
    inputRefs: [...parsed.data.inputRefs], assistanceRefs: [...parsed.data.assistanceRefs],
    coverageRefs: [...parsed.data.coverageRefs] };
  if (parsed.data.objectRef !== undefined) basis.objectRef = parsed.data.objectRef as NonNullable<TeachingBasis['objectRef']>;
  if (parsed.data.hdl !== undefined) basis.hdl = parsed.data.hdl;
  return basis;
}
function requireUsage(value: unknown): TeachingUsage {
  const parsed = usageSchema.safeParse(value);
  if (!parsed.success) throw new RunnerError('INVALID_REFERENCE', 'Trusted usage fact required');
  return parsed.data.status === 'actual'
    ? { status: 'actual', inputTokens: parsed.data.inputTokens, outputTokens: parsed.data.outputTokens }
    : { status: 'unknown', ...(parsed.data.reason === undefined ? {} : { reason: parsed.data.reason }) };
}

// The two hashes never substitute for each other: `resultHash` covers the persisted body JSON bytes,
// `contentHash` covers the exact displayable content bytes.
export function resultHashOf(bodyJsonText: string) {
  if (typeof bodyJsonText !== 'string' || !bodyJsonText) throw new RunnerError('INVALID_REQUEST', 'Persisted body JSON text required');
  return sha256(bodyJsonText);
}
export function contentHashOf(text: string) {
  if (typeof text !== 'string' || !text) throw new RunnerError('INVALID_REQUEST', 'Displayable content required');
  return sha256(text);
}

// A transport failure means we do not know whether the provider was ever contacted; the fact stays unknown
// and is never rewritten as zero usage or as a completed teaching action.
export function unknownUsage(reason = 'provider_status_unknown'): TeachingUsage { return { status: 'unknown', reason }; }

function readMessage(_tx: Transaction, row: Record<string, unknown>): TeachingMessage {
  const message = persisted(messageSchema, String(row.message_json), 'teaching message') as TeachingMessage;
  if (message.messageId !== row.message_id || message.scope.courseId !== row.course_id || message.scope.studentId !== row.student_id
    || message.scope.attemptId !== row.attempt_id || message.jobId !== row.job_id || message.authorKind !== row.author_kind
    || message.contentHash !== row.content_hash || (message.resultHash ?? null) !== row.result_hash
    || (message.requestReceiptId ?? null) !== row.request_receipt_id) throw new Error('Invalid persisted teaching message scope.');
  if (message.authorKind === 'student') {
    if (message.envelope.kind !== 'student_question' || contentHashOf(message.envelope.question) !== message.contentHash)
      throw new Error('Invalid persisted student question.');
  } else {
    if (message.envelope.kind !== 'student_help') throw new Error('Invalid persisted teaching body.');
    const body = studentHelpBodySchema.parse(message.envelope.body);
    if (contentHashOf(body.content) !== message.contentHash) throw new Error('Invalid persisted teaching content hash.');
    const raw = message.envelope.bodyJsonText;
    // Older C3 records lost these bytes; do not manufacture them by serializing the parsed body.
    if (raw !== undefined && (resultHashOf(raw) !== message.resultHash || canonical(JSON.parse(raw)) !== canonical(body)))
      throw new Error('Invalid persisted teaching result bytes.');
  }
  return message;
}
function saveMessage(tx: Transaction, message: TeachingMessage) {
  const value = persisted(messageSchema, JSON.stringify(message), 'teaching message') as TeachingMessage;
  tx.run(`INSERT INTO teaching_messages(message_id,course_id,student_id,attempt_id,job_id,request_receipt_id,author_kind,content_hash,result_hash,message_json)
    VALUES (?,?,?,?,?,?,?,?,?,?)`, value.messageId, value.scope.courseId, value.scope.studentId, value.scope.attemptId,
    value.jobId, value.requestReceiptId ?? null, value.authorKind, value.contentHash, value.resultHash ?? null, JSON.stringify(value));
}
function readActions(tx: Transaction, attemptId: string) {
  return tx.all('SELECT * FROM teaching_actions WHERE attempt_id=? ORDER BY action_id', attemptId).map(row => {
    const action = persisted(actionSchema, String(row.action_json), 'teaching action') as TeachingAction;
    if (action.actionId !== row.action_id || action.scope.courseId !== row.course_id || action.scope.studentId !== row.student_id
      || action.scope.attemptId !== row.attempt_id || action.jobId !== row.job_id || action.messageId !== row.message_id
      || action.contentHash !== row.content_hash || action.disposition !== row.disposition)
      throw new Error('Invalid persisted teaching action scope.');
    if (!tx.get('SELECT message_id FROM teaching_messages WHERE message_id=? AND job_id=? AND content_hash=?',
      action.messageId, action.jobId, action.contentHash)) throw new Error('Invalid persisted teaching action message.');
    return action;
  });
}
function readAction(tx: Transaction, actionId: string) {
  const row = tx.get('SELECT * FROM teaching_actions WHERE action_id=?', actionId);
  if (!row) throw new RunnerError('INVALID_REFERENCE', 'Authorized action required');
  return readActions(tx, String(row.attempt_id)).find(action => action.actionId === actionId)!;
}
function saveAction(tx: Transaction, action: TeachingAction) {
  const value = persisted(actionSchema, JSON.stringify(action), 'teaching action') as TeachingAction;
  const changed = tx.run(`INSERT INTO teaching_actions(action_id,course_id,student_id,attempt_id,job_id,message_id,content_hash,disposition,action_json)
    VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(action_id) DO UPDATE SET disposition=excluded.disposition,action_json=excluded.action_json
    WHERE teaching_actions.course_id=excluded.course_id AND teaching_actions.student_id=excluded.student_id
    AND teaching_actions.attempt_id=excluded.attempt_id AND teaching_actions.job_id=excluded.job_id
    AND teaching_actions.message_id=excluded.message_id AND teaching_actions.content_hash=excluded.content_hash`,
    value.actionId, value.scope.courseId, value.scope.studentId, value.scope.attemptId, value.jobId, value.messageId,
    value.contentHash, value.disposition, JSON.stringify(value));
  if (changed.changes !== 1) throw new RunnerError('IDEMPOTENCY_CONFLICT', 'Original action scope changed');
  return readAction(tx, value.actionId);
}
function readDeliveries(tx: Transaction, actionId: string) {
  return tx.all('SELECT * FROM teaching_deliveries WHERE action_id=? ORDER BY server_seq,delivery_id', actionId).map(row => {
    const delivery = persisted(deliverySchema, String(row.delivery_json), 'teaching delivery') as TeachingDelivery;
    if (delivery.deliveryId !== row.delivery_id || delivery.actionId !== row.action_id || delivery.recipientId !== row.recipient_id
      || delivery.clientId !== row.client_id || delivery.contentHash !== row.content_hash
      || delivery.recoveryGeneration !== row.recovery_generation || delivery.serverSeq !== row.server_seq)
      throw new Error('Invalid persisted teaching delivery scope.');
    return delivery;
  });
}
function readReceipts(tx: Transaction, actionId: string) {
  return tx.all('SELECT * FROM teaching_action_receipts WHERE action_id=? ORDER BY server_seq,receipt_id', actionId).map(row => {
    const receipt = persisted(receiptSchema, String(row.receipt_json), 'teaching receipt') as TeachingActionReceipt;
    if (receipt.receiptId !== row.receipt_id || receipt.actionId !== row.action_id
      || (receipt.deliveryId ?? null) !== row.delivery_id || receipt.contentHash !== row.content_hash
      || receipt.receiptKind !== row.receipt_kind || receipt.clientReceiptId !== row.client_receipt_id
      || receipt.clientId !== row.client_id || receipt.serverSeq !== row.server_seq)
      throw new Error('Invalid persisted teaching receipt scope.');
    return receipt;
  });
}

// Trusted-service audit: only necessary type/ID/reference facts, never the teaching body itself.
// `payloadRef` names the object this event is about (a delivery, a client receipt or the stop request), which is
// what the authorized event page resolves back to a teaching action.
function appendTeachingEvent(tx: Transaction, scope: Scope, actorId: string, type: string, now: string,
  generation: string, causeRef?: string, payloadRef?: string) {
  const identity: CommandIdentity = { actorId, command: type, target: type, scope, idempotencyKey: randomUUID(), recoveryGeneration: generation };
  const result = { type, ...(causeRef ? { causeRef } : {}) };
  const plan = finishCommand({ receipts: [], commandAliases: [], events: [], jobs: [], serverSeq: readServerSeq(tx) },
    { receiptId: randomUUID(), commandId: randomUUID(), identity, requestHash: requestHash(type, result), result, committedAt: now },
    { eventId: randomUUID(), scope, type, occurredAt: now, source: 'trusted_service' }, generation);
  const receipt = plan.receipt as { receiptId: string };
  const event = plan.records.events[plan.records.events.length - 1]!;
  if (payloadRef) saveRecordPlanWithReference(tx, { ...plan.receipt, result } as Parameters<typeof saveRecordPlan>[1], event, payloadRef);
  else saveRecordPlan(tx, { ...plan.receipt, result } as Parameters<typeof saveRecordPlan>[1], { ...event, payloadRef: receipt.receiptId });
  return { receiptId: receipt.receiptId, serverSeq: event.serverSeq, eventId: event.eventId };
}
function readServerSeq(tx: Transaction) {
  return Number(tx.get('SELECT COALESCE(MAX(server_seq),0) AS seq FROM audit_events')!.seq);
}

function dispositionsFor(job: Job, attempt: Attempt, now: string): {disposition:'pending'|'cancelled'|'stale'|'failed';stopReason?:string} {
  if (job.stopRequested) return { disposition: 'cancelled', stopReason: job.failure ?? 'stop_requested' };
  if (job.status === 'failed') return { disposition: 'failed', stopReason: job.failure ?? 'job_failed' };
  if (job.status === 'stale' || job.decisionEpoch !== attempt.decisionEpoch) return { disposition: 'stale', stopReason: 'decision_epoch_changed' };
  if (Date.parse(job.deadline) <= Date.parse(now)) return { disposition: 'stale', stopReason: 'deadline_exceeded' };
  return { disposition: 'pending' };
}

function assertTeachingContext(tx: Transaction, attempt: Attempt, versions: TeachingVersions, reference?: ObjectRef) {
  if (!['ready','active'].includes(attempt.status)
    || !assignmentAvailability(tx, attempt.courseId, attempt.assignmentId, attempt.studentId).active)
    throw new RunnerError('STATE_CONFLICT', 'Teaching is paused or read-only');
  const activity = readActivity(tx, attempt.courseId, attempt.activityVersionId);
  if (versions.activityVersionId !== attempt.activityVersionId || versions.policyVersionId !== activity.helpPolicy.versionId
    || !activity.helpPolicy.helpAllowed || (activity.checkRule.limitedHelp
      && tx.get("SELECT run_id FROM workspace_runs WHERE attempt_id=? AND check_state='active'", attempt.attemptId)))
    throw new RunnerError('STATE_CONFLICT', 'Current help policy forbids teaching');
  if (!reference) return;
  const snapshotRow = 'snapshotId' in reference
    ? tx.get('SELECT snapshot_json FROM artifact_snapshots WHERE snapshot_id=? AND attempt_id=?', reference.snapshotId, attempt.attemptId) : undefined;
  const snapshots: ArtifactSnapshot[] = snapshotRow ? [snapshotSchema.parse(JSON.parse(String(snapshotRow.snapshot_json)))] : [];
  const run = reference.kind === 'run'
    ? tx.get('SELECT run_id,snapshot_id,attempt_id FROM workspace_runs WHERE run_id=? AND attempt_id=?', reference.runId, attempt.attemptId) : undefined;
  const materials = activityView(tx, { userId: attempt.studentId, courseId: attempt.courseId, role: 'student' }, attempt.activityVersionId, 'tutor').content.materials;
  validateObjectRef(attempt, reference, { snapshots, runs: run ? [{ runId: String(run.run_id), snapshotId: String(run.snapshot_id), attemptId: String(run.attempt_id) }] : [],
    resources: materials.flatMap(material => material.status === 'available'
      ? material.paragraphs.flatMap(paragraph => paragraph.paragraphId ? [{ resourceVersionId: material.resourceVersionId, paragraphId: paragraph.paragraphId }] : []) : []) });
  if (reference.kind === 'code') {
    const file = tx.get("SELECT path,document_version,content_hash FROM workspace_files WHERE file_id=? AND attempt_id=? AND lifecycle='active'", reference.fileId, attempt.attemptId);
    if (!file || file.path !== reference.path || file.document_version !== reference.documentVersion || file.content_hash !== reference.contentHash)
      throw new RunnerError('STATE_CONFLICT', 'Teaching target changed');
  }
}

export function teachingActionIsCurrent(tx: Transaction, action: TeachingAction, generation: string, isBasisCurrent?: TeachingBasisCurrent) {
  const attempt = requireScope(tx, action.scope), job = jobOf(tx, action.scope, action.jobId);
  if (action.disposition !== 'pending' || job.stopRequested || job.status !== 'succeeded'
    || action.generation !== generation || job.recoveryGeneration !== generation
    || action.basis.decisionEpoch !== attempt.decisionEpoch || job.decisionEpoch !== attempt.decisionEpoch
    || (job.purpose === 'reminder' && !attempt.reminders)) return false;
  try { assertTeachingContext(tx, attempt, action.targetVersions, action.basis.objectRef); }
  catch (error) { if (error instanceof RunnerError) return false; throw error; }
  return isBasisCurrent?.(tx,action.scope,action.basis) ?? true;
}

/** The same transaction that prepares delivery reconciles an A basis change without erasing displayed facts. */
export function reconcileTeachingBasisInTransaction(tx: Transaction,input: {scope: TeachingScopeRef;actionId: string;actorId: string;generation: string;now: string},
  isBasisCurrent: TeachingBasisCurrent) {
  requireScope(tx,input.scope);const action = readAction(tx,input.actionId);
  if (!sameScope(action.scope,input.scope)) throw new RunnerError('FORBIDDEN','Action scope mismatch');
  if (action.basisRevised || isBasisCurrent(tx,input.scope,action.basis)) return action;
  const job = jobOf(tx,input.scope,action.jobId);
  saveAction(tx,{...action,basisRevised: true,
    ...(action.disposition === 'pending' ? {disposition: 'stale',stopReason: 'learner_state_revised'} : {})});
  saveJob(tx,{...job,stopRequested: true});
  appendTeachingEvent(tx,{...input.scope},input.actorId,'teaching.invalidated',checkedNow(input.now),input.generation,'learner_state_revised');
  return readAction(tx,input.actionId);
}

export function readTeachingVersions(envelope: TeachingQuestionEnvelope | TeachingMessageEnvelope): TeachingVersions {
  return envelope.versions;
}

/**
 * C3-V01 seam: plans the original student question in A's current transaction. The caller creates the command
 * receipt in the same transaction and then calls `saveTeachingJobInTransaction`, because both the message and the
 * job reference that receipt row and the database refuses them without it. The caller (B2 help entry) owns
 * policy/context/authorization; C only stores the exact accepted input.
 */
export function acceptStudentQuestionInTransaction(tx: Transaction, input: {scope: TeachingScopeRef; receiptId?: string;
  now: string; generation: string; question: string; objectRef?: unknown;hdlSelection?:unknown;hdlBasis?:unknown;
  inputRefs?: string[]; versions: TeachingVersions; expectedRevision: number}) {
  let attempt = requireScope(tx, input.scope);
  const question = checkedText(input.question, 'question', 16384), now = checkedNow(input.now);
  const versions = requireVersions(input.versions, attempt);
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision !== attempt.attemptRevision)
    throw new RunnerError('VERSION_CONFLICT', 'Attempt version conflict');
  const objectRef = input.objectRef === undefined ? undefined : JSON.parse(JSON.stringify(objectRefSchema.parse(input.objectRef))) as ObjectRef;
  assertTeachingContext(tx, attempt, versions, objectRef);
  const hadHelp = readJobs(tx, attempt.courseId).some(job => sameScope(job.scope, input.scope) && job.purpose === 'student_help');
  attempt = beginExplicitOperation(attempt, input.expectedRevision, true);
  if (hadHelp) attempt = { ...attempt, decisionEpoch: attempt.decisionEpoch + 1,
    attemptRevision: attempt.attemptRevision + (attempt.attemptRevision === input.expectedRevision ? 1 : 0) };
  saveAttempt(tx, attempt);
  const envelope: TeachingQuestionEnvelope = { kind: 'student_question', question,
    ...(objectRef === undefined ? {} : { objectRef }),
    ...(input.hdlSelection===undefined?{}:{hdlSelection:hdlHelpSelectionSchema.parse(input.hdlSelection)}),
    ...(input.hdlBasis===undefined?{}:{hdlBasis:hdlHelpBasisSchema.parse(input.hdlBasis)}),inputRefs: [...(input.inputRefs ?? [])], versions };
  const message: TeachingMessage = { messageId: randomUUID(), scope: structuredClone(input.scope), jobId: '',
    ...(input.receiptId ? { requestReceiptId: input.receiptId } : {}), authorKind: 'student',
    contentHash: contentHashOf(question), envelope };
  // A superseding question stops only this purpose; unrelated reminder/analysis purposes stay independent.
  const stopped = stopTeachingJobsInTransaction(tx, { actorId: input.scope.studentId, scope: input.scope,
    purposes: ['student_help'], reason: 'replaced_by_new_question', ...(input.receiptId ? { causeRef: input.receiptId } : {}),
    generation: input.generation, now });
  return { message, stoppedJobIds: stopped.jobIds };
}

/** Saves the accepted question and its bounded job once the caller's command receipt exists in the same transaction. */
export function saveTeachingJobInTransaction(tx: Transaction, input: {message: TeachingMessage; jobId: string; receiptId: string;
  now: string; generation: string; deadline: string; kind?: string;inactivityTimeoutMs?:number}) {
  const attempt = requireScope(tx, input.message.scope);
  if (!input.jobId || !input.receiptId) throw new RunnerError('INVALID_REQUEST', 'Trusted message/job/receipt identity required');
  const now = checkedNow(input.now);
  if (!validTime(input.deadline) || Date.parse(input.deadline) <= Date.parse(now))
    throw new RunnerError('INVALID_REQUEST', 'Bounded teaching deadline required');
  const message: TeachingMessage = { ...structuredClone(input.message), jobId: input.jobId };
  const job: Job = { jobId: input.jobId, kind: input.kind ?? 'help', purpose: 'student_help', scope: structuredClone(message.scope),
    requestReceiptId: input.receiptId, status: 'queued', stopRequested: false, expectedRevision: attempt.attemptRevision,
    decisionEpoch: attempt.decisionEpoch, recoveryGeneration: input.generation, acceptedAt: now, deadline: input.deadline, attemptCount: 0,
    ...(input.inactivityTimeoutMs?{inactivityTimeoutMs:input.inactivityTimeoutMs}:{}) };
  enqueueTeachingJob(tx, job);
  saveMessage(tx, message);
  return { messageId: message.messageId, jobId: job.jobId, contentHash: message.contentHash };
}
/** Binds the bounded teaching job to the original question; the caller's receipt row must already exist. */
export function enqueueTeachingJob(tx: Transaction, job: Job) {
  const existing = readJobs(tx, job.scope.courseId);
  if (existing.some(row => row.jobId === job.jobId)) throw new RunnerError('IDEMPOTENCY_CONFLICT', 'Job ID already exists');
  const attempt = readAttempt(tx, job.scope.attemptId!);
  if (attempt.attemptRevision !== job.expectedRevision || attempt.decisionEpoch !== job.decisionEpoch)
    throw new RunnerError('VERSION_CONFLICT', 'Teaching job scope is not current');
  if (!tx.get('SELECT receipt_id FROM command_receipts WHERE receipt_id=?', job.requestReceiptId))
    throw new RunnerError('PENDING_RECEIPT', 'Original command receipt required');
  // Same bounded-job invariants as C2's pure enqueue plan, applied inside the caller's transaction.
  const planned = enqueueJob(existing, job);
  saveJob(tx, planned[planned.length - 1]!);
  return { jobId: job.jobId, status: job.status };
}

export type TeachingBasisCurrent = (tx: Transaction,scope: TeachingScopeRef,basis: TeachingBasis) => boolean;

/**
 * C3-V01/V05 seam: persists the approved final body with its trusted envelope, or archives a late body as a
 * non-deliverable generated fact when the stop already committed. Existing Action/Message IDs are replayed.
 */
export function completeTeachingInTransaction(tx: Transaction, input: {scope: TeachingScopeRef; jobId: string; leaseToken: string;
  generation: string; now: string; bodyJsonText: string; resultRef?: string; versions: TeachingVersions; usage: TeachingUsage;
  calls: number; elapsedMs: number; basis: unknown; messageId: string; actionId: string; isBasisCurrent?: TeachingBasisCurrent}) {
  const attempt = requireScope(tx, input.scope);
  const job = jobOf(tx, input.scope, requireJobId(input.jobId));
  if (!sameScope(job.scope, input.scope) || job.jobId !== input.jobId) throw new RunnerError('FORBIDDEN', 'Original job scope mismatch');
  if (job.purpose !== 'student_help') throw new RunnerError('INVALID_REFERENCE', 'Teaching job required');
  if (job.recoveryGeneration !== input.generation) throw new RunnerError('RECOVERY_REQUIRED', 'Stale teaching generation');
  const now = checkedNow(input.now);
  const versions = requireVersions(input.versions, attempt);
  const usage = requireUsage(input.usage);
  if (!Number.isSafeInteger(input.calls) || input.calls < 0 || input.calls > 3) throw new RunnerError('INVALID_REQUEST', 'Bounded call count required');
  if (!Number.isSafeInteger(input.elapsedMs) || input.elapsedMs < 0) throw new RunnerError('INVALID_REQUEST', 'Measured elapsed time required');
  const resultHash = resultHashOf(input.bodyJsonText);
  const parsed = studentHelpBodySchema.safeParse(JSON.parse(input.bodyJsonText));
  if (!parsed.success) throw new RunnerError('INVALID_REFERENCE', 'Validated final teaching body required');
  const body = JSON.parse(JSON.stringify(parsed.data)) as StudentHelpBody;
  const existing = tx.get('SELECT * FROM teaching_messages WHERE job_id=? AND author_kind=?', job.jobId, 'model');
  if (existing) {
    const message = readMessage(tx, existing as Record<string, unknown>);
    if (message.resultHash !== resultHash) throw new RunnerError('IDEMPOTENCY_CONFLICT', 'Original teaching result mismatch');
    const action = readActions(tx, message.scope.attemptId).find(row => row.messageId === message.messageId);
    if (!action) throw new RunnerError('IDEMPOTENCY_CONFLICT', 'Original teaching action missing');
    return { messageId: message.messageId, actionId: action.actionId, disposition: action.disposition, replayed: true, contentHash: message.contentHash };
  }
  const basis = requireBasis(input.basis);
  const questionRow = tx.get("SELECT * FROM teaching_messages WHERE job_id=? AND author_kind='student'", job.jobId);
  if (!questionRow) throw new RunnerError('INVALID_REFERENCE', 'Original question required');
  const question = readMessage(tx, questionRow).envelope;
  if (question.kind !== 'student_question' || canonical(question.versions) !== canonical(versions)
    || basis.decisionEpoch !== job.decisionEpoch) throw new RunnerError('INVALID_REFERENCE', 'Original teaching basis required');
  if (question.objectRef) {
    if (basis.objectRef && canonical(basis.objectRef) !== canonical(question.objectRef)) throw new RunnerError('INVALID_REFERENCE', 'Original target required');
    basis.objectRef = question.objectRef;
  }
  if(question.hdlSelection&&(!basis.hdl||basis.hdl.snapshotId!==question.hdlSelection.snapshotId
    ||basis.hdl.buildId!==question.hdlSelection.buildId||basis.hdl.sessionId!==question.hdlSelection.sessionId
    ||basis.hdl.operationId!==question.hdlSelection.operationId))throw new RunnerError('INVALID_REFERENCE','Original HDL target required');
  if(!question.hdlSelection&&basis.hdl)throw new RunnerError('INVALID_REFERENCE','Unselected HDL target');
  if(question.hdlBasis&&canonical(question.hdlBasis)!==canonical(basis.hdl))throw new RunnerError('INVALID_REFERENCE','Original frozen HDL basis required');
  const basisRevised = input.isBasisCurrent ? !input.isBasisCurrent(tx,input.scope,basis) : false;
  let { disposition, stopReason } = dispositionsFor(job, attempt, now);
  if (basisRevised && disposition === 'pending') { disposition = 'stale';stopReason = 'learner_state_revised'; }
  if (disposition === 'pending') {
    try { assertTeachingContext(tx, attempt, versions, basis.objectRef); }
    catch (error) { if (!(error instanceof RunnerError)) throw error; disposition = 'stale'; stopReason = error.code; }
  }
  if (job.leaseToken !== input.leaseToken || !job.leaseUntil || Date.parse(job.leaseUntil) <= Date.parse(now))
    throw new RunnerError('STATE_CONFLICT', 'Current teaching lease required');
  const message: TeachingMessage = { messageId: input.messageId, scope: structuredClone(input.scope), jobId: job.jobId,
    requestReceiptId: job.requestReceiptId, authorKind: 'model', contentHash: contentHashOf(body.content), resultHash,
    envelope: { kind: 'student_help', body, bodyJsonText: input.bodyJsonText, versions, usage, calls: input.calls, elapsedMs: input.elapsedMs, basis } };
  // Same-job same-result replay returns the original IDs; an incomplete stop still records the real generation fact.
  const completion = { leaseToken: input.leaseToken, generation: input.generation, now,
    resultRef: input.resultRef ?? `teaching:${message.messageId}`, resultHash };
  const finished = disposition === 'pending'
    ? finishJob(job, completion, { expectedRevision: job.expectedRevision, decisionEpoch: attempt.decisionEpoch })
    : { ...job, resultRef: completion.resultRef, resultHash, stopRequested: true,
      status: ['succeeded','failed','cancelled','stale','timed_out'].includes(job.status) ? job.status : disposition === 'cancelled' ? 'cancelled' as const : 'stale' as const };
  const action: TeachingAction = { actionId: input.actionId, scope: structuredClone(input.scope), jobId: job.jobId, messageId: message.messageId,
    contentHash: message.contentHash, disposition, ...(stopReason ? { stopReason } : {}), targetVersions: versions, basis,
    generation: input.generation, basisRevised, createdAt: now };
  saveMessage(tx, message);
  saveAction(tx, action);
  // Reconciliation, not accounting: `input.calls` covers this execution only, while `attemptCount` is the
  // cumulative ledger the executing side keeps through `recordModelCall`. Summing here would double-count.
  saveJob(tx, { ...finished, attemptCount: Math.max(job.attemptCount, input.calls) });
  appendTeachingEvent(tx, { ...input.scope }, input.scope.studentId, 'teaching.completed', now, input.generation, message.messageId);
  return { messageId: message.messageId, actionId: action.actionId, disposition: action.disposition, replayed: false, contentHash: message.contentHash };
}

/**
 * C3-V05 seam: persistent stop intent plus cancellation/staleness of the related, not yet displayed actions.
 * A succeeded job keeps its terminal status and generated facts; already-displayed help stays a real history fact.
 */
export function stopTeachingJobsInTransaction(tx: Transaction, input: {actorId: string; scope: TeachingScopeRef;
  jobIds?: string[]; purposes?: Purpose[]; reason: string; causeRef?: string; generation: string; now: string;
  /** `false` when the initiating command writes its own receipt/event in the same transaction. */
  audit?: boolean}) {
  requireScope(tx, input.scope);
  const now = checkedNow(input.now), reason = checkedText(input.reason, 'reason', 512);
  if (!input.actorId) throw new RunnerError('INVALID_REQUEST', 'Trusted actor required');
  if (!input.generation) throw new RunnerError('RECOVERY_REQUIRED', 'Trusted generation required');
  const byIds = input.jobIds !== undefined, byPurposes = input.purposes !== undefined;
  if (byIds === byPurposes) throw new RunnerError('INVALID_REQUEST', 'One stop selector required');
  if (byIds && (input.jobIds!.length === 0 || input.jobIds!.some(value => typeof value !== 'string' || !value)))
    throw new RunnerError('INVALID_REQUEST', 'Concrete job IDs required');
  if (byPurposes && (input.purposes!.length === 0 || input.purposes!.some(value => !['teacher_design','student_help','reminder',
    'explicit_analysis','passive_analysis','student_run','teacher_sample'].includes(value))))
    throw new RunnerError('INVALID_REQUEST', 'Known purposes required');
  const jobs = readJobs(tx, input.scope.courseId);
  const selected = jobs.filter(job => sameScope(job.scope, { ...input.scope }) && (byIds ? input.jobIds!.includes(job.jobId) : input.purposes!.includes(job.purpose)));
  if (byIds && selected.length !== new Set(input.jobIds!).size) throw new RunnerError('FORBIDDEN', 'Original job scope mismatch');
  const stoppedIds: string[] = [], actionIds: string[] = [];
  for (const job of selected) {
    const cancelled = cancelByPurpose([job], { ...input.scope }, [job.purpose]);
    const next = cancelled.jobs[0]!;
    saveJob(tx, next);
    if (jobIdsChanged(job, next)) stoppedIds.push(job.jobId);
    const attempt = requireAttempt(tx, String(next.scope.attemptId));
    actionIds.push(...stopActionsForJob(tx, attempt, next, reason, input.causeRef, 'cancelled'));
  }
  if (stoppedIds.length && input.audit !== false) appendTeachingEvent(tx, { ...input.scope }, input.actorId, 'teaching.stopped', now,
    input.generation, input.causeRef ?? reason);
  return { jobIds: stoppedIds, actionIds: [...new Set(actionIds)],
    jobs: selected.map(job => readStoredJob(tx, job.jobId)) };
}
function readStoredJob(tx: Transaction, jobId: string) {
  const row = tx.get('SELECT status,stop_requested FROM jobs WHERE job_id=?', jobId);
  if (!row) throw new RunnerError('INVALID_REFERENCE', 'Original job required');
  return { jobId, status: String(row.status) as Job['status'], stopRequested: Number(row.stop_requested) === 1 };
}
function jobIdsChanged(before: Job, after: Job) { return !before.stopRequested && after.stopRequested; }
function stopActionsForJob(tx: Transaction, attempt: Attempt, job: Job, reason: string, causeRef: string | undefined,
  disposition: 'cancelled'|'stale'): string[] {
  const affected: string[] = [];
  for (const action of readActions(tx, attempt.attemptId)) {
    if (action.jobId !== job.jobId || (action.disposition !== 'pending' && (disposition !== 'stale' || action.basisRevised))) continue;
    // Disposition is permission to send again; the separate receipts keep every actual display fact.
    saveAction(tx, { ...action, ...(action.disposition === 'pending' ? { disposition, stopReason: reason, ...(causeRef ? { causeRef } : {}) } : {}),
      basisRevised: action.basisRevised || disposition === 'stale' });
    affected.push(action.actionId);
  }
  return affected;
}

/**
 * C3-V06 seam: A4 supplies the teacher decision in the same transaction. C applies the scope/epoch CAS through
 * the existing pure plan and persists the new attempts/epochs, related jobs and non-current actions with reasons.
 */
export function invalidateTeachingInTransaction(tx: Transaction, input: {actorId: string; courseId: string; studentId: string;
  attemptIds: string[]; expectedEpochs: Record<string, number>; reason: string; causeRef?: string; generation: string; now: string}) {
  if (!input.actorId || !input.courseId || !input.studentId) throw new RunnerError('INVALID_REQUEST', 'Trusted teaching scope required');
  const now = checkedNow(input.now), reason = checkedText(input.reason, 'reason', 512);
  const jobs = readJobs(tx, input.courseId);
  const currentEpochs: Record<string, number> = {};
  for (const attemptId of input.attemptIds) {
    const attempt = requireAttempt(tx, attemptId);
    if (attempt.courseId !== input.courseId || attempt.studentId !== input.studentId)
      throw new RunnerError('FORBIDDEN', 'Teaching invalidation scope mismatch');
    currentEpochs[attemptId] = attempt.decisionEpoch;
  }
  const plan = invalidateInTransaction(jobs, { courseId: input.courseId, studentId: input.studentId, attemptIds: input.attemptIds,
    expectedEpochs: input.expectedEpochs }, currentEpochs);
  const actionIds: string[] = [];
  for (const jobId of plan.jobIds) {
    const next = plan.jobs.find(job => job.jobId === jobId)!;
    saveJob(tx, next);
    const row = tx.get('SELECT attempt_id FROM jobs WHERE job_id=?', jobId);
    const attempt = readAttempt(tx, String(row!.attempt_id));
    actionIds.push(...stopActionsForJob(tx, attempt, next, reason, input.causeRef, 'stale'));
  }
  for (const attemptId of input.attemptIds) {
    const current = readAttempt(tx, attemptId);
    saveAttempt(tx, { ...current, decisionEpoch: plan.epochs[attemptId]!, attemptRevision: current.attemptRevision + 1 });
    const saved = readAttempt(tx, attemptId);
    if (saved.decisionEpoch !== plan.epochs[attemptId]) throw new RunnerError('STATE_CONFLICT', 'Attempt epoch was not persisted');
    appendTeachingEvent(tx, { courseId: input.courseId, studentId: input.studentId, attemptId },
      input.actorId, 'teaching.invalidated', now, input.generation, input.causeRef ?? reason);
  }
  return { epochs: plan.epochs, jobIds: plan.jobIds, actionIds: [...new Set(actionIds)] };
}

/** C3-V05 seam: records one real send attempt. A network failure can never be reported as received. */
export function deliverTeachingActionInTransaction(tx: Transaction, input: {scope: TeachingScopeRef; actionId: string; clientId: string;
  recoveryGeneration: string; now: string; generation: string; control: TeachingAttemptEpoch & {captureRevision: number}; isBasisCurrent?: TeachingBasisCurrent}) {
  const attempt = requireScope(tx, input.scope), action = readAction(tx, input.actionId);
  if (!sameScope(action.scope, input.scope)) throw new RunnerError('FORBIDDEN', 'Action scope mismatch');
  if (action.disposition !== 'pending') throw new RunnerError('STATE_CONFLICT', 'Action is not deliverable');
  if (!input.clientId) throw new RunnerError('INVALID_REQUEST', 'Authenticated target channel required');
  const now = checkedNow(input.now);
  if (input.recoveryGeneration !== input.generation || !teachingActionIsCurrent(tx, action, input.generation,input.isBasisCurrent)
    || input.control.decisionEpoch !== attempt.decisionEpoch)
    throw new RunnerError('STATE_CONFLICT', 'Teaching basis is no longer current');
  // One send attempt: the delivery ID is allocated first because it is the audit event's payload reference.
  const deliveryId = randomUUID();
  const event = appendTeachingEvent(tx, { ...input.scope }, input.scope.studentId, 'teaching.delivered', now, input.generation,
    deliveryId, deliveryId);
  const delivery: TeachingDelivery = { deliveryId, actionId: action.actionId, recipientId: input.scope.studentId,
    clientId: input.clientId, contentHash: action.contentHash, recoveryGeneration: input.recoveryGeneration || input.generation,
    serverSeq: event.serverSeq, attemptedAt: now, control: input.control, eventId: event.eventId };
  const value = persisted(deliverySchema, JSON.stringify(delivery), 'teaching delivery') as TeachingDelivery;
  tx.run(`INSERT INTO teaching_deliveries(delivery_id,action_id,recipient_id,client_id,content_hash,recovery_generation,server_seq,delivery_json)
    VALUES (?,?,?,?,?,?,?,?)`, value.deliveryId, value.actionId, value.recipientId, value.clientId, value.contentHash,
    value.recoveryGeneration, value.serverSeq, JSON.stringify(value));
  return value;
}

export function appendTeachingEventWithReceipt(tx: Transaction, scope: Scope, actorId: string, type: string, now: string,
  generation: string, causeRef?: string, payloadRef?: string) {
  return appendTeachingEvent(tx, scope, actorId, type, now, generation, causeRef, payloadRef);
}

/** C3-V02 seam: idempotent client receipts. Declared times are preserved but never used to back-date display.
 * The receipt ID is chosen first because the audit event references it as the object it is about. */
export function recordTeachingReceiptInTransaction(tx: Transaction, input: {scope: TeachingScopeRef; actionId: string;
  clientReceiptId: string; clientId: string; deliveryId?: string; contentHash: string; receiptKind: TeachingActionReceipt['receiptKind'];
  clientDeclaredAt?: string; now: string; generation: string; versions?: TeachingVersions; receiptId?: string}) {
  const attempt = requireScope(tx, input.scope), action = readAction(tx, input.actionId);
  if (!sameScope(action.scope, input.scope)) throw new RunnerError('FORBIDDEN', 'Action scope mismatch');
  const now = checkedNow(input.now);
  const contentHash = checkedHash(input.contentHash, 'content');
  if (contentHash !== action.contentHash) throw new RunnerError('VERSION_CONFLICT', 'Original action content version required');
  if (!input.clientReceiptId || !input.clientId) throw new RunnerError('INVALID_REQUEST', 'Client receipt identity required');
  if (input.clientDeclaredAt !== undefined && !validTime(input.clientDeclaredAt)) throw new RunnerError('INVALID_REQUEST', 'Declared client time is not a timestamp');
  if (input.versions !== undefined && canonical(requireVersions(input.versions, attempt)) !== canonical(action.targetVersions))
    throw new RunnerError('VERSION_CONFLICT', 'Original action versions required');
  const deliveries = readDeliveries(tx, action.actionId);
  const delivery = input.deliveryId === undefined ? undefined : deliveries.find(row => row.deliveryId === input.deliveryId);
  if (input.deliveryId !== undefined && (!delivery || delivery.recipientId !== input.scope.studentId
    || delivery.contentHash !== contentHash)) throw new RunnerError('INVALID_REFERENCE', 'Original delivery required');
  if (delivery && (delivery.clientId !== input.clientId || delivery.contentHash !== action.contentHash))
    throw new RunnerError('VERSION_CONFLICT', 'Original delivery client required');
  if (!delivery && ['received','displayed','acknowledged'].includes(input.receiptKind))
    throw new RunnerError('INVALID_REFERENCE', 'A display report needs the original delivery');
  const duplicate = readReceipts(tx, action.actionId).find(row => row.contentHash === contentHash
    && row.receiptKind === input.receiptKind && row.clientReceiptId === input.clientReceiptId);
  if (duplicate) {
    if (duplicate.clientId !== input.clientId || (duplicate.deliveryId ?? undefined) !== input.deliveryId)
      throw new RunnerError('IDEMPOTENCY_CONFLICT', 'Original receipt mismatch');
    if (canonical(duplicate.versions) !== canonical(input.versions ?? action.targetVersions))
      throw new RunnerError('IDEMPOTENCY_CONFLICT', 'Original receipt report mismatch');
    return { receipt: duplicate, replayed: true };
  }
  const race: string[] = [];
  if (delivery && delivery.recoveryGeneration !== input.generation) race.push('recovery_generation_changed');
  if (action.disposition !== 'pending') race.push(`action_${action.disposition}`);
  if (action.basis.decisionEpoch !== attempt.decisionEpoch) race.push('decision_epoch_changed');
  const versions = input.versions ?? action.targetVersions;
  const receiptId = input.receiptId ?? randomUUID();
  const receipt: TeachingActionReceipt = { receiptId, actionId: action.actionId,
    ...(delivery ? { deliveryId: delivery.deliveryId } : {}), contentHash, receiptKind: input.receiptKind,
    clientReceiptId: input.clientReceiptId, clientId: input.clientId, serverSeq: 0,
    ...(input.clientDeclaredAt === undefined ? {} : { clientDeclaredAt: input.clientDeclaredAt }),
    serverReceivedAt: now, versions, ...(race.length ? { raceReason: race.join(',') } : {}) };
  const event = appendTeachingEvent(tx, { ...input.scope }, input.scope.studentId, 'teaching.receipt', now, input.generation,
    action.actionId, receiptId);
  const linked = { ...receipt, serverSeq: event.serverSeq };
  const value = persisted(receiptSchema, JSON.stringify(linked), 'teaching receipt') as TeachingActionReceipt;
  tx.run(`INSERT INTO teaching_action_receipts(receipt_id,action_id,delivery_id,content_hash,receipt_kind,client_receipt_id,client_id,server_seq,receipt_json)
    VALUES (?,?,?,?,?,?,?,?,?)`, value.receiptId, value.actionId, value.deliveryId ?? null, value.contentHash,
    value.receiptKind, value.clientReceiptId, value.clientId, value.serverSeq, JSON.stringify(value));
  // Later facts append without erasing earlier ones; a stop receipt never rolls back current control.
  return { receipt: value, replayed: false };
}

export type CoverageInterval = {attemptId: string;captureRevision: number;state: 'collecting'|'paused';fromServerSeq: number;
  from: string;to?: string;toServerSeq?: number;open: boolean;rejections: {receiptId: string;reason: string}[]};

/** C5/§5 seam: coverage gap projection from the persisted process/coverage records, never from client clocks. */
export function readCoverageIntervals(tx: Transaction, attemptId: string): {attemptId: string;captureRevision: number;collecting: boolean;
  cutoffServerSeq: number;intervals: CoverageInterval[]} {
  const attempt = requireAttempt(tx, attemptId);
  const receipts = readRecords(tx, attempt.courseId).receipts.filter(receipt => receipt.identity.actorId === attempt.studentId)
    .sort((left, right) => left.serverSeq - right.serverSeq);
  const controls = new Map(tx.all("SELECT * FROM workspace_process_records WHERE attempt_id=? AND kind='coverage'", attemptId)
    .map(row => [String(row.receipt_id), { revision: Number(row.capture_revision),
      record: persisted(z.strictObject({ collecting: z.boolean(), occurredAt: z.iso.datetime() }), String(row.record_json), 'coverage') }]));
  const intervals: CoverageInterval[] = [];
  for (const receipt of receipts) {
    const ack = receipt.result as { attemptId?: string; captureChanged?: boolean; captureRevision?: number;
      process?: { status?: string; reason?: string } };
    const initial = !intervals.length && receipt.identity.command === 'attempt.create' && ack.attemptId === attemptId;
    const inScope = sameScope(receipt.identity.scope, { courseId: attempt.courseId, studentId: attempt.studentId, attemptId });
    if (!initial && !inScope) continue;
    const control = controls.get(receipt.receiptId);
    if (initial || (receipt.identity.command === 'attempt.control' && ack.captureChanged)) {
      if (!initial && (!control || control.revision !== ack.captureRevision || control.record.occurredAt !== receipt.committedAt))
        throw new Error('Invalid persisted coverage boundary.');
      const previous = intervals.at(-1);
      if (previous) { previous.to = receipt.committedAt; previous.toServerSeq = receipt.serverSeq; previous.open = false; }
      // createAttempt's confirmed initial state is collecting/captureRevision=0; later boundaries are actual control records.
      intervals.push({ attemptId, captureRevision: initial ? 0 : control!.revision,
        state: initial || control!.record.collecting ? 'collecting' : 'paused',
        fromServerSeq: receipt.serverSeq, from: receipt.committedAt, open: true, rejections: [] });
    }
    if (receipt.identity.command === 'workspace.sync' && ack.process?.status === 'not_collected' && ack.process.reason) {
      intervals.at(-1)?.rejections.push({ receiptId: receipt.receiptId, reason: ack.process.reason });
    }
  }
  return { attemptId, captureRevision: attempt.captureRevision, collecting: attempt.collecting,
    cutoffServerSeq: readServerSeq(tx), intervals };
}

/** Teaching records that authorization already narrowed to this attempt or course. */
export function readTeachingRecordsInTransaction(tx: Transaction, scope: {courseId: string; attemptId?: string; studentId?: string},
  audience: 'student'|'teacher'|'trusted' = 'trusted') {
  const messages: TeachingMessage[] = tx.all('SELECT * FROM teaching_messages WHERE course_id=? ORDER BY message_id', scope.courseId)
    .filter(row => scope.attemptId === undefined || row.attempt_id === scope.attemptId)
    .filter(row => scope.studentId === undefined || row.student_id === scope.studentId)
    .map(row => readMessage(tx, row as Record<string, unknown>));
  const actions = messages.flatMap(message => readActions(tx, message.scope.attemptId).filter(action => action.messageId === message.messageId))
    .sort((left, right) => left.actionId.localeCompare(right.actionId));
  const records = { messages, actions: actions.map(action => ({ ...action, deliveries: readDeliveries(tx, action.actionId),
    receipts: readReceipts(tx, action.actionId) })) };
  if (audience !== 'student') return records;
  const shown = records.actions.filter(action => action.receipts.some(receipt => ['displayed','acknowledged'].includes(receipt.receiptKind)));
  return { messages: messages.filter(message => message.authorKind === 'student' || shown.some(action => action.messageId === message.messageId)), actions: shown };
}
export function readTeachingJob(tx: Transaction, courseId: string, jobId: string) {
  return readJobs(tx, courseId).find(job => job.jobId === jobId);
}
export function readTeachingMessageByJob(tx: Transaction, courseId: string, jobId: string) {
  const row = tx.get('SELECT m.* FROM teaching_messages m JOIN jobs j ON m.job_id=j.job_id WHERE m.job_id=? AND j.course_id=?', jobId, courseId);
  return row ? readMessage(tx, row as Record<string, unknown>) : undefined;
}
export function readTeachingActionForMessage(tx: Transaction, attemptId: string, messageId: string) {
  return readActions(tx, attemptId).find(action => action.messageId === messageId);
}
export { readActions as readTeachingActionsForAttempt, readDeliveries as readTeachingDeliveries, readReceipts as readTeachingReceipts };
