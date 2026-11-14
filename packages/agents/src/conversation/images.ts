import { StorageError } from '@xunjie/storage';
import { canonicalDigest } from '@xunjie/storage/identity';
import { sameAgentSubject } from '@xunjie/contracts/agent-service';
import { modelImageRefSchema, type ModelImageRef } from '@xunjie/contracts/model-connections';
import type { AgentExecutionSnapshot, AgentStep, Facts } from '@xunjie/agent-runtime';
import type { LearningModelPort } from '@xunjie/model-gateway/service';
import type { ConversationToolBinding, ConversationPreparedTool, ConversationToolModule, ConversationToolContext, ConversationToolOutcome } from './tools.js';

type Image = Awaited<ReturnType<LearningModelPort['images']['read']>>;
interface ImageCommand { commandId: string; basisStepId: string; binding: ConversationToolBinding; command: ConversationPreparedTool; outcome?: ConversationToolOutcome; }
export interface ConversationImageSource {
  version: 1; id: string; segmentId: string; command: ConversationPreparedTool;
  moduleId: string; moduleVersion: number; resultDigest: string; provenance: Facts;
  images: Image[];
  /** Immutable source facts for a read-only original receipt lookup. Never a current dispatch permit. */
  origin: ConversationToolContext;
}
const equal = (a: unknown, b: unknown) => canonicalDigest(a) === canonicalDigest(b);
export const conversationImageSources = (state: Facts) => (state.imageSources ?? []) as unknown as ConversationImageSource[];
export function pendingConversationImages(state: Facts, segmentId: string) {
  const delivered = ((state.imageDeliveries ?? {}) as Facts)[segmentId] as string[] | undefined;
  return conversationImageSources(state).filter(source => source.segmentId !== segmentId && !delivered?.includes(source.id));
}
export async function captureConversationImages(snapshot: AgentExecutionSnapshot, commands: ImageCommand[], segmentId: string, models: LearningModelPort) {
  const sources: ConversationImageSource[] = [];
  for (const fixed of commands) {
    const refs = fixed.outcome?.feedback.images;
    if (!refs?.length) continue;
    const basis = snapshot.steps.find(step => step.stepId === fixed.basisStepId);
    const tool = snapshot.steps.find(step => step.operation.kind === 'tool.call' && step.operation.operationId === fixed.commandId);
    if (!basis || !tool) throw new StorageError('corrupt');
    const images = await Promise.all(refs.map(ref => models.images.read(snapshot.session.identity, modelImageRefSchema.parse(ref))));
    // Retain one original model basis, not a recursive Run/session history or another image source's context.
    const originalBasis: AgentStep = { ...basis, snapshot: {
      context: basis.snapshot.context!, model: basis.snapshot.model!, inputIds: basis.snapshot.inputIds!,
      authorityInputIds: basis.snapshot.authorityInputIds ?? basis.snapshot.inputIds!, bindings: basis.snapshot.bindings ?? [],
    } };
    const original = { ...snapshot, state: {}, sessionState: {}, steps: [originalBasis, tool], waits: [] };
    const origin: ConversationToolContext = { snapshot: original, basisStepId: basis.stepId, context: basis.snapshot.context as unknown as ConversationToolContext['context'],
      inputIds: (basis.snapshot.authorityInputIds ?? basis.snapshot.inputIds ?? []) as string[] };
    sources.push({ version: 1, id: fixed.commandId, segmentId, command: fixed.command, moduleId: fixed.binding.moduleId,
      moduleVersion: fixed.binding.moduleVersion, images, origin, provenance: fixed.outcome!.result, resultDigest: canonicalDigest(fixed.outcome!.result) });
  }
  return sources;
}
export async function reauthorizeConversationImages(snapshot: AgentExecutionSnapshot, sources: readonly ConversationImageSource[],
  modules: ReadonlyMap<string, ConversationToolModule>, models: LearningModelPort): Promise<ModelImageRef[]> {
  const images: ModelImageRef[] = [];
  for (const source of sources) {
    const module = modules.get(source.moduleId);
    if (!module || module.version !== source.moduleVersion || source.origin.snapshot.session.sessionId !== snapshot.session.sessionId
      || !sameAgentSubject(source.origin.snapshot.session.identity, snapshot.session.identity)) throw new StorageError('forbidden');
    // Reconcile only reads the fixed source/receipt; it never prepares, dispatches or uploads the old tool again.
    const tool = source.origin.snapshot.steps.find(step => step.operation.kind === 'tool.call' && step.operation.operationId === source.id);
    const basisStepId = tool?.operation.input.basisStepId;
    if (typeof basisStepId !== 'string' || source.origin.basisStepId != null && source.origin.basisStepId !== basisStepId)
      throw new StorageError('forbidden');
    // Earlier retained receipts already fixed this ID on their original tool operation.
    const original = await module.reconcile({ ...source.origin, basisStepId }, source.command);
    if (!original || !equal(original.feedback.images, source.images.map(({ imageId, version }) => ({ imageId, version })))
      || canonicalDigest(original.result) !== source.resultDigest) throw new StorageError('forbidden');
    for (const fixed of source.images) {
      const ref = modelImageRefSchema.parse({ imageId: fixed.imageId, version: fixed.version });
      const current = await models.images.read(snapshot.session.identity, ref);
      if (!equal(current, fixed)) throw new StorageError('identity-conflict');
      if (!images.some(image => equal(image, ref))) images.push(ref);
    }
  }
  return images;
}
