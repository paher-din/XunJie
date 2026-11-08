import { createHash } from 'node:crypto';
import { z } from 'zod';
import { StorageError, type OwnedStorage } from '@xunjie/storage';
import type { ModelTool } from '@xunjie/contracts/model-connections';
import { teachingToolOutcomeSchema } from '@xunjie/contracts/teaching-agent';
import { canonical } from './identity.js';
import type { TeachingToolOutcome, TeachingToolScope } from './tool-types.js';

const feedbackBytes = 8192;
// Exact bytes are base64 encoded. Leave room for their JSON envelope and preview
// within the existing model feedback budget, even when the caller asks for 8192.
const sliceBytes = 4096;
const rangeInput = z.object({ commandId: z.uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  limit: z.number().int().min(1).max(8192) }).strict();

export const readToolResultDefinition: ModelTool = {
  name: 'read_tool_result',
  description: 'Read a bounded byte range of a retained tool result version from this original Run. Use original.commandId and original.sha256, never a resource URL. '
    + 'Offsets refer to canonical JSON UTF-8 bytes. The actual range may be shorter than limit; continue at nextOffset. '
    + 'base64 contains the exact bytes; preview is only a readable excerpt.',
  inputSchema: { type: 'object', properties: { commandId: { type: 'string', minLength: 36, maxLength: 36 },
    sha256: { type: 'string', minLength: 64, maxLength: 64, pattern: '^[a-f0-9]{64}$' },
    offset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, limit: { type: 'integer', minimum: 1, maximum: 8192 } },
    required: ['commandId', 'sha256', 'offset', 'limit'], additionalProperties: false },
};

function resultBytes(result: TeachingToolOutcome['result']) { return Buffer.from(canonical(result), 'utf8'); }
function sha256(bytes: Uint8Array) { return createHash('sha256').update(bytes).digest('hex'); }

/** An excerpt never claims that an arbitrary byte boundary is a UTF-8 character. */
function preview(bytes: Buffer, maximum: number) {
  let start = 0, end = Math.min(bytes.length, maximum);
  while (start < end && (bytes[start]! & 0xc0) === 0x80) start++;
  if (end < bytes.length) while (end > start && (bytes[end]! & 0xc0) === 0x80) end--;
  // A range can end in the middle of a codepoint even when it is shorter than maximum.
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let removed = 0; removed < 4 && end >= start; removed++, end--) {
    try { return { text: decoder.decode(bytes.subarray(start, end)), start, end }; }
    catch { /* Only discard an incomplete trailing codepoint, never the original bytes. */ }
  }
  throw new StorageError('corrupt');
}

/** Call before persisting/settling. Full result, source, images and execution stay intact. */
export function projectToolOutcome(outcome: TeachingToolOutcome, commandId: string): TeachingToolOutcome {
  if (!z.uuid().safeParse(commandId).success) throw new StorageError('invalid');
  const bytes = resultBytes(outcome.result);
  const original = { commandId, sha256: sha256(bytes), byteLength: bytes.length, encoding: 'utf8', readTool: 'read_tool_result' };
  // Existing handlers consume the tool's JSON feedback fields directly (file,
  // query, base64, entries, ...). Projection must not move them into a wrapper.
  let feedback: Record<string, unknown> = { state: outcome.state, result: outcome.result };
  try {
    const parsed: unknown = JSON.parse(outcome.feedback.text);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) feedback = parsed as Record<string, unknown>;
  } catch { /* Non-JSON feedback uses the explicit outcome/result envelope. */ }
  const fullRange = { offset: 0, end: bytes.length };
  let text = JSON.stringify({ ...feedback, original,
    // Range-reader feedback already describes its source byte range. Keep that
    // field intact; describe this projection separately when the names collide.
    ...('byteRange' in feedback ? { projectionByteRange: fullRange } : { byteRange: fullRange }), truncated: false });
  if (bytes.length > feedbackBytes || Buffer.byteLength(text, 'utf8') > feedbackBytes) {
    const excerpt = preview(bytes, 2048);
    // preview is a JSON string containing an excerpt, not an invalid partial JSON value.
    text = JSON.stringify({ state: outcome.state, preview: excerpt.text, original,
      byteRange: { offset: excerpt.start, end: excerpt.end }, truncated: true });
  }
  return { ...outcome, feedback: { ...outcome.feedback, text } };
}

/** Driver-owned read: args cannot name storage resources or widen the accepted Run. */
export async function readToolResult(storage: Pick<OwnedStorage, 'read' | 'readResource'>,
  scope: TeachingToolScope, args: unknown): Promise<TeachingToolOutcome> {
  const parsed = rangeInput.safeParse(args);
  if (!parsed.success) throw new StorageError('invalid');
  if (!scope.assertDispatch || canonical(scope.activity.identity) !== canonical(scope.identity)
    || canonical(scope.input.scope) !== canonical({ environmentId: scope.identity.environmentId, spaceId: scope.identity.spaceId,
      principalId: scope.identity.principalId, activityId: scope.activity.activityId })) throw new StorageError('forbidden');
  await scope.assertDispatch();
  const { commandId, sha256: version, offset, limit } = parsed.data;
  const { rows: [row] } = await storage.read(`SELECT c.command,c.step_id,r.identity
    FROM teaching_commands c JOIN teaching_runs r ON r.run_id=c.run_id
    JOIN teaching_steps s ON s.step_id=c.step_id AND s.run_id=c.run_id
    WHERE c.command_id=$1 AND r.run_id=$2 AND r.activity_id=$3
      AND r.identity->>'environmentId'=$4 AND r.identity->>'spaceId'=$5 AND r.identity->>'principalId'=$6`,
  [commandId, scope.runId, scope.activity.activityId, scope.identity.environmentId, scope.identity.spaceId, scope.identity.principalId]);
  // Absence deliberately does not disclose whether a command exists outside this scope.
  if (!row || canonical(row.identity) !== canonical(scope.identity)) throw new StorageError('forbidden');
  const command = row.command as { commandId?: string; basis?: { scope?: { identity?: unknown; activityId?: string; runId?: string } } };
  const originalScope = command.basis?.scope;
  if (command.commandId !== commandId || !originalScope || canonical(originalScope.identity) !== canonical(scope.identity)
    || originalScope.activityId !== scope.activity.activityId || originalScope.runId !== scope.runId) throw new StorageError('corrupt');
  // The command's latest outcome/resource can change after reconciliation or
  // cleanup. Every retained tool-result event fixes an independently readable
  // version, including accepted/unknown observations of an unfinished effect.
  const { rows: events } = await storage.read(`SELECT body FROM teaching_events
    WHERE activity_id=$1 AND kind='tool-result' AND body->>'commandId'=$2
      AND body->>'runId'=$3 AND body->>'stepId'=$4 ORDER BY seq`,
  [scope.activity.activityId, commandId, scope.runId, String(row.step_id)]);
  let selected: { resourceId: string; outcome: TeachingToolOutcome } | undefined;
  for (const event of events) {
    const body = event.body as { resourceId?: unknown; outcome?: unknown };
    const fact = teachingToolOutcomeSchema.safeParse(body.outcome);
    if (!fact.success) throw new StorageError('corrupt');
    if (sha256(resultBytes(fact.data.result)) !== version) continue;
    if (!z.uuid().safeParse(body.resourceId).success) throw new StorageError('corrupt');
    selected = { resourceId: body.resourceId as string, outcome: fact.data };
    break;
  }
  if (!selected) throw new StorageError('missing');
  let retained: TeachingToolOutcome;
  try {
    retained = teachingToolOutcomeSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true })
      .decode(await storage.readResource(selected.resourceId))));
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError('corrupt');
  }
  if (canonical(retained) !== canonical(selected.outcome)) throw new StorageError('corrupt');
  const bytes = resultBytes(retained.result);
  if (sha256(bytes) !== version) throw new StorageError('corrupt');
  if (offset > bytes.length) throw new StorageError('invalid');
  const end = Math.min(bytes.length, offset + Math.min(limit, sliceBytes));
  const chunk = bytes.subarray(offset, end), excerpt = preview(chunk, 256);
  // Qualification/stop can change during resource IO. The original Driver permit
  // must still be valid before bytes are returned to the model.
  await scope.assertDispatch();
  const result = { source: { commandId }, formatVersion: 1, version, sha256: version,
    outcomeState: retained.state, byteLength: bytes.length, encoding: 'utf8',
    base64: chunk.toString('base64'), preview: excerpt.text,
    previewByteRange: { offset: offset + excerpt.start, end: offset + excerpt.end },
    byteRange: { offset, end }, nextOffset: end < bytes.length ? end : null };
  return { state: 'completed', feedback: { outcome: 'success', text: JSON.stringify(result), images: [] }, result,
    source: { label: '原工具结果的固定字节范围' } };
}
