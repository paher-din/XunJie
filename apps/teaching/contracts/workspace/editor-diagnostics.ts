import { z } from 'zod';
import type { Snapshot } from '../../runner/snapshot.ts';

const id = z.string().min(1).max(128), hash = z.string().regex(/^[a-f0-9]{64}$/);
const natural = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), positive = natural.min(1);
export const editorDiagnosticsInput = z.strictObject({
  recoveryGeneration: id, workspaceRevision: natural, captureRevision: natural, fileId: id,
  files: z.array(z.strictObject({ fileId: id, documentVersion: positive, contentHash: hash,
    text: z.string().max(1048576) })).min(1).max(50),
});
export const diagnosticSchema = z.strictObject({
  fileId: id.optional(), path: z.string().max(1024).optional(), contentHash: hash.optional(),
  severity: z.enum(['error', 'warning', 'info']), message: z.string().min(1).max(4000),
  line: positive.optional(),
  range: z.strictObject({ startLine: positive, startColumn: positive, endLine: positive, endColumn: positive }).optional(),
});
export const editorDiagnosticsResult = z.strictObject({
  status: z.enum(['ready', 'unsupported', 'paused', 'busy', 'stale', 'timeout', 'unavailable']),
  sourceHash: hash, provider: z.enum(['gcc', 'iverilog']).optional(),
  diagnostics: z.array(diagnosticSchema).max(100),
});
export type EditorDiagnosticsResult = z.infer<typeof editorDiagnosticsResult>;
export type EditorDiagnostic = z.infer<typeof diagnosticSchema>;
export type EditorDiagnosticsPacket = {
  recoveryGeneration: string; scope: { userId: string; courseId: string; attemptId: string };
  fileId: string; language: 'c' | 'hdl'; snapshot: Snapshot;
};
