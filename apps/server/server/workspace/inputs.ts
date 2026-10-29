import { z } from 'zod';
import type { ReopenGrant, Submission, SyncBatch } from '../../contracts/workspace/index.ts';
import type { SubmitRun } from '../../contracts/runner/index.ts';
import type { Control } from './controls.ts';
import type { RunRequest } from './commands.ts';
import type { SubmissionRequest } from './submissions.ts';

export const id = z.string().min(1).max(128);
const natural = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const revision = natural.min(1), hash = z.string().regex(/^[a-f0-9]{64}$/);
export const generationInput = z.strictObject({ recoveryGeneration: id });
// C3: a teaching stop carries an optional reason; an ordinary C2 run cancel keeps its original shape.
export const cancelInput = generationInput.extend({ reason: z.string().min(1).max(512).optional() });
export const params = z.strictObject({ id });
export const key = id.regex(/^[\x21-\x7e]+$/);
const range = z.strictObject({ startLine: revision, startColumn: revision, endLine: revision, endColumn: revision });
export const objectRef = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('project'), attemptId: id, activityVersionId: id }),
  z.strictObject({ kind: z.literal('run'), attemptId: id, runId: id, snapshotId: id }),
  z.strictObject({ kind: z.literal('resource'), attemptId: id, resourceVersionId: id, paragraphId: id }),
  z.strictObject({ kind: z.literal('code'), attemptId: id, snapshotId: id, fileId: id, path: z.string(), documentVersion: revision,
    contentHash: hash, range: range.optional(), source: z.strictObject({ system: z.literal('student-ide'), session: id, modelId: id, seq: natural.optional() }).optional() }),
]);
export const fileOperationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('create'), clientFileKey: id, path: z.string(), text: z.string() }),
  z.strictObject({ kind: z.literal('update'), fileId: id, baseVersion: revision, text: z.string().optional(),
    changes: z.array(z.strictObject({ range, text: z.string() })).min(1).optional() })
    .refine(value => (value.text === undefined) !== (value.changes === undefined)),
  z.strictObject({ kind: z.literal('recycle'), fileId: id, baseVersion: revision }),
  z.strictObject({ kind: z.literal('restore'), fileId: id, baseVersion: revision }),
]);
export const syncInput = generationInput.extend({ expectedWorkspaceRevision: natural, clientId: id, clientSeq: natural,
  operations: z.array(fileOperationSchema).min(1).max(100), process: z.strictObject({ captureRevision: natural }).optional() });
export const snapshotInput = generationInput.extend({ expectedWorkspaceRevision: natural });
const control = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('start') }), z.strictObject({ kind: z.literal('pause') }), z.strictObject({ kind: z.literal('resume') }),
  z.strictObject({ kind: z.literal('resume_revision') }),
  z.strictObject({ kind: z.literal('capture'), value: z.boolean() }), z.strictObject({ kind: z.literal('reminders'), value: z.boolean() }),
  z.strictObject({ kind: z.literal('position'), route: z.string().max(4096).optional(), question: z.string().max(16384).optional(), returnPosition: objectRef.optional() }),
]);
export const controlInput = generationInput.extend({ expectedAttemptRevision: revision, control });
const input = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('stats'), fileIds: z.array(id).min(1).max(50) }),
  z.strictObject({ operation: z.literal('find'), fileIds: z.array(id).min(1).max(50), word: z.string() }),
  z.strictObject({ operation: z.literal('top'), fileIds: z.array(id).min(1).max(50), count: z.string() }),
  z.strictObject({ operation: z.literal('report'), fileIds: z.array(id).min(1).max(50), resultFile: z.string() }),
]);
export const runInput = generationInput.extend({ expectedAttemptRevision: revision, snapshotId: id, runtimeProfileVersion: id,
  entryFileId: id, input, mode: z.enum(['run','course_check']) });
// C4: the student's fixed submission. `checkRunIds` name the trusted course checks that must match the submitted
// snapshot; `reflection` is the student's own short text. Neither is a correctness gate (see the task record §6).
export const artifactSubmissionInput = generationInput.extend({ expectedAttemptRevision: revision, snapshotId: id,
  reflection: z.string().max(4096).optional(), checkRunIds: z.array(id).max(16).optional() });
// C4 seams A5 calls inside its own teacher-authorized transaction; the student never supplies either shape.
export const reopenGrantInput = generationInput.extend({ expectedAttemptRevision: revision, submissionId: id,
  reason: z.string().min(1).max(4096) });
export const reviewTransitionInput = generationInput.extend({ expectedAttemptRevision: revision, to: z.literal('reviewed') });
export const recoveryQuery = z.strictObject({ recoveryGeneration: id.optional(),
  decisionEpoch: z.coerce.number().int().nonnegative().optional() });
export const fileSchema = z.strictObject({ fileId: id, attemptId: id, path: z.string(), documentVersion: revision,
  contentHash: hash, text: z.string(), lifecycle: z.enum(['active','recycled']) });
export const snapshotSchema = z.strictObject({ snapshotId: id, hashFormat: z.literal('sha256-manifest-v1'), hash,
  files: z.array(fileSchema.omit({ attemptId: true, lifecycle: true })), attemptId: id, activityVersionId: id,
  workspaceRevision: natural, createdAt: z.iso.datetime() });
export const submissionSchema = z.strictObject({ identity: z.strictObject({ runId: id, commandId: id, requestHash: hash,
  recoveryGeneration: id, snapshotId: id, snapshotHash: hash, inputHash: hash, runtimeProfileVersion: id,
  imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/), authorizedScope: z.strictObject({ userId: id, courseId: id,
    purpose: z.literal('student_run'), attemptId: id, activityVersionId: id }) }),
  snapshot: snapshotSchema, entryFileId: id, input, mode: z.enum(['run','check']), checkRuleVersion: id.optional() });
// C4 persisted shapes. `serverSeq` is not part of the record: it belongs to the command receipt that owns the
// submission, so storage reads it from there instead of storing a second copy that could drift.
export const artifactSubmissionSchema = z.strictObject({ submissionId: id, attemptId: id, courseId: id, studentId: id,
  assignmentId: id, activityVersionId: id, snapshotId: id, snapshotHash: hash, workspaceRevision: natural,
  attemptRevision: revision, decisionEpoch: natural, recoveryGeneration: id, receiptId: id,
  submittedAt: z.iso.datetime(), reflection: z.string().max(4096).optional(),
  checkRefs: z.array(z.strictObject({ runId: id, snapshotId: id, resultHash: hash.optional(),
    verdict: z.string().min(1).max(64).optional() })).max(16) });
export const reopenGrantSchema = z.strictObject({ grantId: id, attemptId: id, courseId: id, studentId: id,
  submissionId: id, attemptRevision: revision, state: z.enum(['valid','consumed','superseded']),
  reason: z.string().min(1).max(4096), grantedBy: id, grantedAt: z.iso.datetime(), receiptId: id,
  consumedReceiptId: id.optional(), consumedAt: z.iso.datetime().optional() });

// Zod checks the boundary; omitted optional fields stay omitted for the domain's exact types.
export const syncBatch = (value: z.infer<typeof syncInput>) => {
  const { recoveryGeneration: _generation, ...batch } = value;
  return JSON.parse(JSON.stringify(batch)) as SyncBatch;
};
export const domainControl = (value: z.infer<typeof controlInput>['control']) => JSON.parse(JSON.stringify(value)) as Control;
export const domainRun = (value: z.infer<typeof runInput>): RunRequest => {
  const { recoveryGeneration: _generation, ...request } = value;
  return request;
};
export const domainSubmission = (value: z.infer<typeof submissionSchema>) => JSON.parse(JSON.stringify(value)) as SubmitRun;
// `canonical` rejects `undefined`, so an absent optional field is left out rather than spread as `undefined`.
export const domainArtifactSubmission = (value: z.infer<typeof artifactSubmissionInput>): SubmissionRequest => {
  const request: SubmissionRequest = { expectedAttemptRevision: value.expectedAttemptRevision, snapshotId: value.snapshotId,
    checkRunIds: value.checkRunIds ?? [] };
  if (value.reflection !== undefined) request.reflection = value.reflection;
  return request;
};
export const domainSubmissionRecord = (value: z.infer<typeof artifactSubmissionSchema>) => JSON.parse(JSON.stringify(value)) as Submission;
export const domainReopenGrant = (value: z.infer<typeof reopenGrantSchema>) => JSON.parse(JSON.stringify(value)) as ReopenGrant;
