import { z } from 'zod';
import type { SyncBatch } from '../../contracts/workspace/index.ts';
import type { SubmitRun } from '../../contracts/runner/index.ts';
import type { Control } from './controls.ts';
import type { RunRequest } from './commands.ts';

export const id = z.string().min(1).max(128);
const natural = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const revision = natural.min(1), hash = z.string().regex(/^[a-f0-9]{64}$/);
export const generationInput = z.strictObject({ recoveryGeneration: id });
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
