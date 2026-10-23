import { z } from 'zod';
import type { Transaction } from '../db/transaction.ts';
import { readAttempt, saveAttempt, readRecords, saveRecordPlan, saveJob, readCommandIdentity } from '../db/records-adapter.ts';
import { canonical, sameScope } from '../records/commands.ts';
import { readTeachingRecordsInTransaction, readCoverageIntervals } from '../records/teaching.ts';
import type { CommandIdentity, Records, TeachingActionRecord, TeachingCoverage, TeachingMessage } from '../../contracts/records/index.ts';import type { WorkspaceState } from './commands.ts';
import { validateFiles } from './files.ts';
import { validateSnapshot } from '../../runner/snapshot.ts';
import { validateRunResult } from '../records/runner.ts';
import { fileSchema, snapshotSchema, submissionSchema, domainSubmission, fileOperationSchema } from './inputs.ts';
import { readGrants, readSubmissions } from './submissions.ts';
import { ApiError } from '../app/errors.ts';

function checked<Schema extends z.ZodType>(schema: Schema, json: string): z.output<Schema> {
  const result = schema.safeParse(JSON.parse(json));
  if (!result.success) throw new Error('Invalid persisted workspace record.');
  return result.data;
}
export function bindingKeys(identity: CommandIdentity) {
  return [{ kind: 'public', key: canonical([identity.actorId,identity.command,identity.target,identity.idempotencyKey]) },
    ...(identity.sync ? [{ kind: 'sync', key: canonical([identity.actorId,identity.scope.attemptId,identity.sync.clientId,identity.sync.clientSeq]) }] : [])];
}
export function readWorkspaceRecords(tx: Transaction, courseId: string, identity?: CommandIdentity): Records {
  const records = readRecords(tx, courseId);
  const receiptById = new Map(records.receipts.map(receipt => [receipt.receiptId, receipt]));
  if (identity) {
    const original = tx.get('SELECT course_id,recovery_generation FROM command_receipts WHERE actor_id=? AND command=? AND target=? AND idempotency_key=?',
      identity.actorId, 'shared.' + identity.command, identity.target, identity.idempotencyKey);
    if (original && original.recovery_generation !== identity.recoveryGeneration) throw new ApiError('RECOVERY_REQUIRED');
    if (original && original.course_id !== courseId) throw new ApiError('IDEMPOTENCY_CONFLICT');
    for (const item of bindingKeys(identity)) {
      const row = tx.get('SELECT receipt_id FROM workspace_command_bindings WHERE kind=? AND key_json=?', item.kind, item.key);
      const original = row ? receiptById.get(String(row.receipt_id)) : undefined;
      if (row && !original) throw new ApiError('IDEMPOTENCY_CONFLICT');
      if (original && original.identity.recoveryGeneration !== identity.recoveryGeneration) throw new ApiError('RECOVERY_REQUIRED');
    }
  }
  for (const row of tx.all("SELECT * FROM workspace_command_bindings WHERE kind='public'")) {
    const original = receiptById.get(String(row.receipt_id));
    if (!original) continue;
    const alias: unknown = JSON.parse(String(row.identity_json));
    // A binding cannot change the original account, command, scope, generation or sync key.
    const value = readCommandIdentity(alias);
    if (!value || !sameScope(value.scope, original.identity.scope) || value.actorId !== original.identity.actorId
      || value.command !== original.identity.command || value.target !== original.identity.target
      || value.recoveryGeneration !== original.identity.recoveryGeneration || canonical(value.sync ?? null) !== canonical(original.identity.sync ?? null)
      || bindingKeys(value)[0]!.key !== row.key_json) throw new Error('Invalid persisted command binding.');
    records.commandAliases.push({ identity: value, receiptId: original.receiptId });
  }
  return records;
}
export function loadWorkspace(tx: Transaction, attemptId: string, identity?: CommandIdentity): WorkspaceState {
  const attempt = readAttempt(tx, attemptId), records = readWorkspaceRecords(tx, attempt.courseId, identity);
  return hydrateWorkspace(tx, attempt, records);
}
/** Read-only composition for one authorized, synchronous course transaction. No state survives this call. */
export function loadCourseWorkspaces(tx: Transaction, courseId: string): WorkspaceState[] {
  const attempts = tx.all('SELECT attempt_id FROM attempts WHERE course_id=? ORDER BY attempt_id', courseId)
    .map(row => readAttempt(tx, String(row.attempt_id)));
  if (!attempts.length) return [];
  const records = readWorkspaceRecords(tx, courseId);
  return attempts.map(attempt => {
    if (attempt.courseId !== courseId) throw new Error('Invalid persisted attempt scope.');
    return hydrateWorkspace(tx, attempt, records);
  });
}
function hydrateWorkspace(tx: Transaction, attempt: WorkspaceState['attempt'], records: Records): WorkspaceState {
  const attemptId = attempt.attemptId;
  const files = tx.all('SELECT * FROM workspace_files WHERE attempt_id=? ORDER BY file_id', attemptId).map(row => {
    const file = checked(fileSchema, String(row.file_json));
    if (file.fileId !== row.file_id || file.attemptId !== row.attempt_id || file.path !== row.path
      || file.documentVersion !== row.document_version || file.lifecycle !== row.lifecycle || file.contentHash !== row.content_hash) throw new Error('Invalid persisted file scope.');
    return file;
  });
  validateFiles(attempt, files);
  const snapshots = tx.all('SELECT * FROM artifact_snapshots WHERE attempt_id=? ORDER BY snapshot_id', attemptId).map(row => {
    const snapshot = checked(snapshotSchema, String(row.snapshot_json));
    if (snapshot.snapshotId !== row.snapshot_id || snapshot.attemptId !== attemptId || snapshot.activityVersionId !== attempt.activityVersionId
      || snapshot.workspaceRevision !== row.workspace_revision || snapshot.hash !== row.content_hash) throw new Error('Invalid persisted snapshot scope.');
    validateSnapshot(snapshot); return snapshot;
  });
  const state: WorkspaceState = { attempt, files, snapshots, records, runs: [], checks: [],
    submissions: readSubmissions(tx, attemptId, attempt), grants: readGrants(tx, attemptId, attempt) };
  for (const row of tx.all('SELECT * FROM workspace_runs WHERE attempt_id=? ORDER BY run_id', attemptId)) {
    const submission = domainSubmission(checked(submissionSchema, String(row.submission_json)));
    const job = records.jobs.find(item => item.jobId === row.job_id), scope = submission.identity.authorizedScope;
    const snapshot = snapshots.find(item => item.snapshotId === row.snapshot_id);
    if (!job || job.runId !== row.run_id || job.scope.attemptId !== attemptId || scope.attemptId !== attemptId
      || scope.userId !== attempt.studentId || scope.courseId !== attempt.courseId || scope.activityVersionId !== attempt.activityVersionId
      || submission.identity.runId !== row.run_id || !snapshot || canonical(submission.snapshot) !== canonical(snapshot)
      || (job.execution?.nodeGeneration??job.recoveryGeneration) !== submission.identity.recoveryGeneration) throw new Error('Invalid persisted run scope.');
    const run: WorkspaceState['runs'][number] = { runId: String(row.run_id), jobId: job.jobId, submission };
    if (row.result_json !== null) {
      const result = validateRunResult(submission, JSON.parse(String(row.result_json)));
      if (result.contentHash !== row.result_hash || job.resultHash !== row.result_hash) throw new Error('Invalid persisted result hash.');
      run.result = result.record; run.resultHash = result.contentHash;
    }
    state.runs.push(run);
    if (row.check_state !== null) {
      if (submission.mode !== 'check' || !row.check_policy_version || !['active','ended'].includes(String(row.check_state))) throw new Error('Invalid persisted check stage.');
      state.checks.push({ jobId: job.jobId, runId: run.runId, policyVersion: String(row.check_policy_version), state: row.check_state as 'active'|'ended' });
    } else if (submission.mode === 'check') throw new Error('Missing persisted check stage.');
  }
  // C4: a fixed submission keeps pointing at the snapshot and the trusted checks it named, so the matching
  // reference invariant is re-checked on load rather than trusted from the persisted JSON alone. A reference
  // recorded before its run produced a result stays verdict-free instead of being backfilled here.
  for (const submission of state.submissions) {
    if (!snapshots.some(row => row.snapshotId === submission.snapshotId)) throw new Error('Invalid persisted submission snapshot.');
    for (const ref of submission.checkRefs) {
      const run = state.runs.find(row => row.runId === ref.runId);
      if (!run || run.submission.mode !== 'check' || run.submission.identity.snapshotId !== submission.snapshotId
        || ref.snapshotId !== submission.snapshotId || (ref.resultHash !== undefined && run.resultHash !== ref.resultHash))
        throw new Error('Invalid persisted submission check reference.');
    }
  }
  for (const grant of state.grants) if (!state.submissions.some(row => row.submissionId === grant.submissionId))
    throw new Error('Invalid persisted reopen grant reference.');
  return state;
}
export function persistWorkspace(tx: Transaction, before: WorkspaceState, after: WorkspaceState) {
  saveAttempt(tx, after.attempt);
  for (const event of after.records.events.filter(item => !before.records.events.some(old => old.eventId === item.eventId))) {
    const receipt = after.records.receipts.find(item => item.receiptId === event.payloadRef);
    if (!receipt) throw new ApiError('INVALID_REFERENCE');
    // The initiating command owns this audit row, so a dependent stop never adds a second one.
    saveRecordPlan(tx, receipt, event);
  }
  for (const receipt of after.records.receipts.filter(item => !before.records.receipts.some(old => old.receiptId === item.receiptId))) bind(tx, receipt.identity, receipt.receiptId);
  for (const alias of after.records.commandAliases) bind(tx, alias.identity, alias.receiptId);
  const changedFiles = after.files.filter(file => canonical(file) !== canonical(before.files.find(old => old.fileId === file.fileId) ?? null));
  // Free recycled paths before inserting a replacement instance in the same atomic batch.
  for (const file of changedFiles.filter(item => item.lifecycle === 'recycled')) tx.run("UPDATE workspace_files SET lifecycle='recycled' WHERE file_id=? AND attempt_id=?", file.fileId, after.attempt.attemptId);
  for (const file of changedFiles) {
    const saved = tx.run(`INSERT INTO workspace_files(file_id,attempt_id,path,document_version,lifecycle,content_hash,file_json)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(file_id) DO UPDATE SET document_version=excluded.document_version,lifecycle=excluded.lifecycle,
    content_hash=excluded.content_hash,file_json=excluded.file_json WHERE workspace_files.attempt_id=excluded.attempt_id AND workspace_files.path=excluded.path`,
    file.fileId, file.attemptId, file.path, file.documentVersion, file.lifecycle, file.contentHash, JSON.stringify(file));
    if (saved.changes !== 1) throw new ApiError('INVALID_REFERENCE');
  }
  for (const snapshot of after.snapshots.filter(item => !before.snapshots.some(old => old.snapshotId === item.snapshotId))) {
    tx.run('INSERT INTO artifact_snapshots(snapshot_id,attempt_id,workspace_revision,content_hash,snapshot_json) VALUES (?,?,?,?,?)',
      snapshot.snapshotId, snapshot.attemptId, snapshot.workspaceRevision, snapshot.hash, JSON.stringify(snapshot));
  }
  for (const job of after.records.jobs.filter(item => canonical(item) !== canonical(before.records.jobs.find(old => old.jobId === item.jobId) ?? null))) saveJob(tx, job);
  for (const run of after.runs) {
    const old = before.runs.find(item => item.runId === run.runId), check = after.checks.find(item => item.jobId === run.jobId);
    if (!old) tx.run('INSERT INTO workspace_runs(run_id,attempt_id,job_id,snapshot_id,submission_json,check_policy_version,check_state) VALUES (?,?,?,?,?,?,?)',
      run.runId, after.attempt.attemptId, run.jobId, run.submission.snapshot.snapshotId, JSON.stringify(run.submission), check?.policyVersion ?? null, check?.state ?? null);
    else {
      const previousCheck = before.checks.find(item => item.jobId === run.jobId);
      if (old.jobId !== run.jobId || canonical(old.submission) !== canonical(run.submission) || (old.resultHash && old.resultHash !== run.resultHash)
        || previousCheck?.policyVersion !== check?.policyVersion || (previousCheck?.state === 'ended' && check?.state !== 'ended')) throw new ApiError('IDEMPOTENCY_CONFLICT');
      if (canonical(old) !== canonical(run) || before.checks.find(item => item.jobId === run.jobId)?.state !== check?.state)
        tx.run('UPDATE workspace_runs SET result_json=?,result_hash=?,check_state=? WHERE run_id=? AND job_id=?',
          run.result === undefined ? null : JSON.stringify(run.result), run.resultHash ?? null, check?.state ?? null, run.runId, run.jobId);
    }
  }
  // C4: submissions and grant consumption are written last, after the receipt/audit pair that owns them exists, so
  // their foreign keys resolve and any failure still rolls the whole command back.
  for (const submission of after.submissions.filter(item => !before.submissions.some(old => old.submissionId === item.submissionId))) {
    const receipt = after.records.receipts.find(item => item.receiptId === submission.receiptId);
    if (!receipt) throw new ApiError('INVALID_REFERENCE');
    const saved = tx.run(`INSERT INTO workspace_submissions(submission_id,attempt_id,course_id,student_id,snapshot_id,workspace_revision,
      attempt_revision,receipt_id,server_seq,recovery_generation,submitted_at_ms,submission_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      submission.submissionId, submission.attemptId, submission.courseId, submission.studentId, submission.snapshotId,
      submission.workspaceRevision, submission.attemptRevision, submission.receiptId, receipt.serverSeq,
      submission.recoveryGeneration, Date.parse(submission.submittedAt), JSON.stringify(submission));
    if (saved.changes !== 1) throw new ApiError('IDEMPOTENCY_CONFLICT');
  }
  for (const grant of after.grants) {
    const old = before.grants.find(item => item.grantId === grant.grantId);
    // Only the student's own resume_revision changes a grant through this plan diff, and only forward to consumed.
    // A5 writes and supersedes grants through `grantReopenInTransaction`, never here.
    if (!old) throw new ApiError('INVALID_REFERENCE');
    if (canonical(old) === canonical(grant)) continue;
    if (old.state !== 'valid' || grant.state !== 'consumed' || old.submissionId !== grant.submissionId
      || old.attemptRevision !== grant.attemptRevision || old.grantedBy !== grant.grantedBy || old.reason !== grant.reason
      || old.grantedAt !== grant.grantedAt || old.consumedReceiptId !== undefined || !grant.consumedReceiptId || !grant.consumedAt)
      throw new ApiError('IDEMPOTENCY_CONFLICT');
    const consumed = tx.run('UPDATE workspace_reopen_grants SET state=?,consumed_receipt_id=?,consumed_at_ms=?,grant_json=? WHERE grant_id=? AND state=?',
      grant.state, grant.consumedReceiptId, Date.parse(grant.consumedAt), JSON.stringify(grant), grant.grantId, old.state);
    if (consumed.changes !== 1) throw new ApiError('IDEMPOTENCY_CONFLICT');
  }
}
function bind(tx: Transaction, identity: CommandIdentity, receiptId: string) {  for (const item of bindingKeys(identity)) {
    const old = tx.get('SELECT receipt_id FROM workspace_command_bindings WHERE kind=? AND key_json=?', item.kind, item.key);
    if (old && old.receipt_id !== receiptId) throw new ApiError('IDEMPOTENCY_CONFLICT');
    if (!old) tx.run('INSERT INTO workspace_command_bindings(kind,key_json,receipt_id,identity_json) VALUES (?,?,?,?)', item.kind, item.key, receiptId, JSON.stringify(identity));
  }
}
const syncRecordSchema = z.strictObject({ operations: z.array(fileOperationSchema).min(1).max(100), confirmedBasis: z.array(fileSchema),
  workspaceRevision: z.number().int().nonnegative(), occurredAt: z.iso.datetime() });
const coverageRecordSchema = z.strictObject({ collecting: z.boolean(), occurredAt: z.iso.datetime() });
export function readProcessRecords(tx: Transaction, attemptId: string) {
  const attempt = readAttempt(tx,attemptId), records = readRecords(tx,attempt.courseId);
  return tx.all(`SELECT p.* FROM workspace_process_records p JOIN command_receipts r ON p.receipt_id=r.receipt_id
    WHERE p.attempt_id=? ORDER BY r.server_seq`,attemptId).map(row => {
    const receipt = records.receipts.find(item => item.receiptId === row.receipt_id);
    if (!receipt || receipt.identity.scope.attemptId !== attemptId || receipt.identity.scope.studentId !== attempt.studentId
      || receipt.identity.actorId !== attempt.studentId) throw new Error('Invalid persisted process scope.');
    const kind = row.kind;
    const record = kind === 'sync' ? checked(syncRecordSchema,String(row.record_json)) : checked(coverageRecordSchema,String(row.record_json));
    if (!['sync','coverage'].includes(String(kind)) || record.occurredAt !== receipt.committedAt
      || receipt.identity.command !== (kind === 'sync' ? 'workspace.sync' : 'attempt.control')) throw new Error('Invalid persisted process association.');
    if ('confirmedBasis' in record) validateFiles(attempt,record.confirmedBasis);
    return { kind,receiptId: receipt.receiptId,serverSeq: receipt.serverSeq,captureRevision: Number(row.capture_revision),
      source: 'student_command' as const,record,ack: receipt.result };
  });
}
// C3 read projection: exact retrievable teaching text and the exact references/versions, already authorized by the caller.
export function readTeachingRecords(tx: Transaction, attemptId: string, audience: 'student'|'teacher'): {messages: TeachingMessage[]; actions: TeachingActionRecord[]} {
  const attempt = readAttempt(tx, attemptId);
  const records = readTeachingRecordsInTransaction(tx, { courseId: attempt.courseId, attemptId, studentId: attempt.studentId }, audience);
  return { messages: records.messages, actions: records.actions };
}
// C3 coverage projection: server-side boundaries only; a client clock never back-dates or refills a gap.
export function readCoverage(tx: Transaction, attemptId: string): TeachingCoverage {
  readAttempt(tx, attemptId);
  return readCoverageIntervals(tx, attemptId);
}
