import { z } from 'zod';
import type { WorkspaceState } from './commands.ts';
import { validateRunResult } from '../records/runner.ts';
import { sha256, validatePath } from '../../runner/snapshot.ts';
import { ApiError } from '../app/errors.ts';

const file = z.strictObject({ relativeName: z.string(),status: z.enum(['complete','incomplete','missing']),
  text: z.string().optional(),contentHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),bytes: z.number().int().nonnegative().max(65536).optional(),
  runId: z.string(),snapshotId: z.string(),resultFileId: z.string().regex(/^[a-f0-9]{64}$/),source: z.literal('runner_result_file'),caseIndex: z.number().int().nonnegative() });
export function readResultFiles(state: WorkspaceState, runId: string, approvedNames: string[]) {
  const run = state.runs.find(item => item.runId === runId);
  if (!run) throw new ApiError('FORBIDDEN');
  // Private course cases can encode their input/answer in generated files as well as stdout.
  if (run.submission.mode === 'check') return { status: 'redacted' as const };
  if (!run.result) return { status: 'unavailable' as const };
  const record = validateRunResult(run.submission,run.result).record;
  const parsed = z.array(file).safeParse(record.resultFiles ?? []);
  if (!parsed.success) throw new ApiError('INVALID_REFERENCE');
  const files = parsed.data.map(item => {
    validatePath(item.relativeName);
    if (!approvedNames.includes(item.relativeName) || item.runId !== runId || item.snapshotId !== run.submission.snapshot.snapshotId
      || (item.text !== undefined && (sha256(item.text) !== item.contentHash || Buffer.byteLength(item.text) !== item.bytes))
      || (item.status === 'complete' && item.text === undefined)
      || item.resultFileId !== sha256(JSON.stringify([runId,item.snapshotId,item.caseIndex,item.relativeName,item.contentHash]))) throw new ApiError('INVALID_REFERENCE');
    return item;
  });
  return { status: 'available' as const,files };
}
