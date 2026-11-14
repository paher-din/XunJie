import { createHash } from 'node:crypto';
import { z } from 'zod';
import { StorageError } from '@xunjie/storage';
import type { ModelTool } from '@xunjie/contracts/model-connections';
import { canonical, canonicalDigest } from '@xunjie/storage/identity';
import type { Facts } from '@xunjie/agent-runtime';
import type { ConversationToolContext, ConversationToolModule, ConversationToolOutcome } from '../../conversation/tools.js';

export const toolFeedbackBytes = 8192;
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

function resultBytes(result: Facts) { return Buffer.from(canonical(result), 'utf8'); }
function sha256(bytes: Uint8Array) { return createHash('sha256').update(bytes).digest('hex'); }
const json = (value: unknown): Facts => z.record(z.string(), z.json()).parse(JSON.parse(JSON.stringify(value)));

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

/** Preserve complete committed results; only the model-facing feedback is bounded. */
export function projectToolOutcome(outcome: ConversationToolOutcome, commandId: string): ConversationToolOutcome {
  z.uuid().parse(commandId);
  const bytes = resultBytes(outcome.result);
  if (bytes.length <= toolFeedbackBytes && Buffer.byteLength(outcome.feedback.text ?? '') <= toolFeedbackBytes) return outcome;
  const original = { commandId, sha256: sha256(bytes), byteLength: bytes.length, encoding: 'utf8', readTool: 'read_tool_result' };
  let feedback: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(outcome.feedback.text ?? '');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) feedback = parsed as Record<string, unknown>;
  } catch { /* A handler's partial/non-JSON feedback is replaced by a valid projection of the original result. */ }
  let text = JSON.stringify({ ...feedback, original, truncated: true });
  if (Buffer.byteLength(text) > toolFeedbackBytes) {
    const excerpt = preview(bytes, 2048);
    text = JSON.stringify({ state: outcome.state, preview: excerpt.text, original,
      byteRange: { offset: excerpt.start, end: excerpt.end }, truncated: true });
  }
  return { ...outcome, feedback: { ...outcome.feedback, text } };
}

const id = 'tool-results', version = 1;
const scopeOf = (context: ConversationToolContext) => ({ sessionId: context.snapshot.session.sessionId,
  runId: context.snapshot.run.runId, identityDigest: canonicalDigest(context.snapshot.session.identity) });
const scopeSchema = z.object({ sessionId: z.uuid(), runId: z.uuid(), identityDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const preparedSchema = z.object({ moduleId: z.literal(id), moduleVersion: z.literal(version), scope: scopeSchema,
  arguments: rangeInput, stepId: z.uuid(), bindingDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

/** Reads only the current authorized Run's committed generic facts, never legacy tables or resource IDs. */
export function createToolResults(installed: ReadonlyMap<string, ConversationToolModule>): ConversationToolModule {
  async function select(context: ConversationToolContext, args: z.infer<typeof rangeInput>) {
    const step = context.snapshot.steps.find(candidate => candidate.operation.kind === 'tool.call'
      && candidate.operation.operationId === args.commandId);
    const fixed = step?.operation.input;
    if (!step || !fixed || fixed.commandId !== args.commandId || !fixed.binding || typeof fixed.binding !== 'object'
      || Array.isArray(fixed.binding) || !fixed.command || typeof fixed.command !== 'object' || Array.isArray(fixed.command)
      || fixed.command.commandId !== args.commandId) throw new StorageError('forbidden');
    const binding = fixed.binding, module = installed.get(String(binding.moduleId));
    if (!module || module.version !== binding.moduleVersion || module.id === id) throw new StorageError('incompatible');
    const basis = context.snapshot.steps.find(candidate => candidate.stepId === fixed.basisStepId && candidate.operation.kind === 'model.call');
    if (!basis) throw new StorageError('corrupt');
    const originalContext: ConversationToolContext = { snapshot: context.snapshot, basisStepId: basis.stepId,
      context: basis.snapshot.context as unknown as ConversationToolContext['context'],
      inputIds: (basis.snapshot.authorityInputIds ?? basis.snapshot.inputIds) as string[] };
    const offers = await module.list(originalContext);
    if (!offers.some(offer => canonicalDigest({ moduleId: module.id, version: module.version, offer }) === binding.bindingId))
      throw new StorageError('forbidden');
    const outcomes: unknown[] = [step.result?.value.outcome];
    // Pair settlement fixes each observation before the model can use its continuation handle.
    for (const settled of context.snapshot.steps) if (settled.operation.kind === 'model.tools.settle'
      && settled.state === 'completed' && settled.result?.state === 'completed' && Array.isArray(settled.snapshot.commands)) {
      for (const command of settled.snapshot.commands) if (command && typeof command === 'object' && !Array.isArray(command)
        && command.commandId === args.commandId && canonicalDigest(command.binding) === canonicalDigest(binding)) outcomes.push(command.outcome);
    }
    const outcome = outcomes.find(value => value && typeof value === 'object' && !Array.isArray(value)
      && 'result' in value && value.result && typeof value.result === 'object' && !Array.isArray(value.result)
      && sha256(resultBytes(value.result as Facts)) === args.sha256) as ConversationToolOutcome | undefined;
    if (!outcome) throw new StorageError('missing');
    // A stable catalogue entry does not retain permission to its individual source.
    // Reconciliation is a read-only owner proof for this exact retained version.
    const authorized = await module.reconcile(originalContext, fixed.command as unknown as Parameters<ConversationToolModule['reconcile']>[1]);
    if (!authorized || sha256(resultBytes(authorized.result)) !== args.sha256) throw new StorageError('forbidden');
    return { stepId: step.stepId, bindingDigest: canonicalDigest(binding), outcome, bytes: resultBytes(outcome.result) };
  }
  function offer(context: ConversationToolContext) { return { definition: readToolResultDefinition, effect: 'read' as const, scope: scopeOf(context) }; }
  async function evaluate(context: ConversationToolContext, command: Parameters<ConversationToolModule['dispatch']>[1]) {
    const input = preparedSchema.parse(command.input);
    if (command.name !== readToolResultDefinition.name || command.effect !== 'read'
      || canonicalDigest(input.scope) !== canonicalDigest(scopeOf(context))) throw new StorageError('forbidden');
    const original = await select(context, input.arguments);
    if (original.stepId !== input.stepId || original.bindingDigest !== input.bindingDigest) throw new StorageError('identity-conflict');
    const { offset, limit, commandId, sha256: digest } = input.arguments, bytes = original.bytes;
    if (offset > bytes.length) throw new StorageError('invalid');
    const end = Math.min(bytes.length, offset + Math.min(limit, sliceBytes));
    const chunk = bytes.subarray(offset, end), excerpt = preview(chunk, 256);
    const result = json({ source: { commandId }, formatVersion: 1, sha256: digest, version: digest, outcomeState: original.outcome.state,
      byteLength: bytes.length, encoding: 'utf8', base64: chunk.toString('base64'), preview: excerpt.text,
      previewByteRange: { offset: offset + excerpt.start, end: offset + excerpt.end }, byteRange: { offset, end },
      nextOffset: end < bytes.length ? end : null });
    return { state: 'completed' as const, feedback: { outcome: 'success' as const, text: JSON.stringify(result), images: [] }, result };
  }
  return { id, version, async list(context) {
    const retained = context.snapshot.steps.some(step => {
      const outcome = step.operation.kind === 'tool.call' ? step.result?.value.outcome : undefined;
      if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome) || !outcome.feedback
        || typeof outcome.feedback !== 'object' || Array.isArray(outcome.feedback) || typeof outcome.feedback.text !== 'string') return false;
      try { const feedback = JSON.parse(outcome.feedback.text); return feedback.original?.readTool === 'read_tool_result'; }
      catch { return false; }
    });
    return retained ? [offer(context)] : [];
  },
    async prepare(context, offered, intent, commandId) {
      if (intent.name !== readToolResultDefinition.name || canonicalDigest({ definition: offered.definition, effect: offered.effect, scope: offered.scope })
        !== canonicalDigest(offer(context))) throw new StorageError('invalid');
      const args = rangeInput.parse(intent.arguments), original = await select(context, args);
      return { commandId, name: intent.name, effect: 'read', input: json({ moduleId: id, moduleVersion: version,
        scope: scopeOf(context), arguments: args, stepId: original.stepId, bindingDigest: original.bindingDigest }) };
    },
    async dispatch(context, command, _permit, assertDispatch) {
      await assertDispatch(); const outcome = await evaluate(context, command); await assertDispatch(); return outcome;
    },
    reconcile: evaluate,
  };
}
