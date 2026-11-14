import { z } from 'zod';
import { canonicalDigest, operationId } from '@xunjie/storage/identity';
import { agentDependencyPreparedToolSchema as prepared, agentDependencyToolOfferSchema as offer } from '@xunjie/contracts/agent-dependencies';
import { teachingStudentAskInputSchema } from '@xunjie/contracts/student-questions';
import type { AgentWait } from '@xunjie/contracts/agent-runtime';
import type { AgentExecutionSnapshot } from '@xunjie/agent-runtime';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const descriptor = z.object({ id: z.string(), version: z.number().int().positive() }).strict();
const dependency = z.object({ version: z.literal(2), module: descriptor, offer, prepared }).strict();
const binding = z.object({ bindingId: hash, moduleId: z.string(), moduleVersion: z.number().int().positive(),
  modelName: z.string(), offer }).strict();
const discovery = z.object({ moduleId: z.literal('tool-discovery'), moduleVersion: z.literal(1), kind: z.literal('delegate'),
  scope: z.object({ sessionId: z.uuid(), subjectDigest: hash }).strict(), binding, command: prepared }).strict();
const fixedQuestion = teachingStudentAskInputSchema.safeExtend({ sourceInputId: z.uuid(), deadline: z.iso.datetime() }).strict();
const same = (a: unknown, b: unknown) => canonicalDigest(a) === canonicalDigest(b);

/** Read-only provenance check against original kernel operations, never presentation routing claims. */
export function isOriginalUserQuestion(snapshot: AgentExecutionSnapshot, wait: AgentWait): boolean {
  try {
    const waiting = snapshot.steps.find(step => step.operation.kind === 'conversation.wait' && step.operation.operationId === wait.operationId);
    if (!waiting || waiting.state !== 'completed' || waiting.result?.state !== 'completed' || wait.runId !== snapshot.run.runId) return false;
    const queued = waiting.operation.input;
    const original = snapshot.steps.find(step => step.operation.kind === 'tool.call' && step.operation.operationId === queued.commandId);
    if (!original || original.state !== 'completed' || original.result?.state !== 'completed'
      || wait.operationId !== operationId('conversation-wait:' + original.operation.operationId)) return false;
    const fixed = original.operation.input, outer = fixed.binding as Record<string, unknown>;
    const command = prepared.parse(fixed.command);
    if (!outer || fixed.commandId !== original.operation.operationId || command.commandId !== fixed.commandId
      || fixed.basisStepId !== queued.basisStepId || outer.moduleId !== queued.moduleId || waiting.operation.bindingId !== queued.moduleId
      || original.operation.bindingId !== outer.bindingId) return false;
    const originalOffer = offer.parse({ definition: outer.definition, effect: outer.effect, scope: outer.scope });
    if (outer.bindingId !== canonicalDigest({ moduleId: outer.moduleId, version: outer.moduleVersion, offer: originalOffer })
      || command.name !== originalOffer.definition.name || command.effect !== originalOffer.effect) return false;
    const basis = snapshot.steps.find(step => step.stepId === fixed.basisStepId && step.operation.kind === 'model.call');
    if (!basis || !Array.isArray(basis.snapshot.bindings) || !basis.snapshot.bindings.some(item => same(item, outer))) return false;
    const outcome = original.result.value.outcome as Record<string, unknown> | undefined;
    if (outcome?.state !== 'accepted' || !same(outcome.wait, queued.wait)) return false;
    const originalWait = queued.wait as Record<string, unknown>;
    if (wait.kind !== originalWait.kind || wait.deadline !== originalWait.deadline
      || !same(wait.presentation, { ...(originalWait.presentation as object), moduleId: queued.moduleId })) return false;

    let module = descriptor.parse({ id: outer.moduleId, version: outer.moduleVersion }), current = command;
    let routing: Record<string, unknown> | null = null;
    for (let depth = 0; depth < 8; depth++) {
      const remote = dependency.safeParse(current.input);
      if (remote.success) {
        const value = remote.data;
        if (!same(value.module, module) || value.prepared.commandId !== current.commandId || value.prepared.name !== current.name
          || value.prepared.effect !== current.effect || value.offer.definition.name !== current.name || value.offer.effect !== current.effect) return false;
        current = value.prepared; continue;
      }
      if (module.id !== 'tool-discovery') break;
      const value = discovery.parse(current.input), pin = value.binding;
      const { environmentId, spaceId, principalId, kind } = snapshot.session.identity;
      if (module.version !== 1 || !same(value.scope, { sessionId: snapshot.session.sessionId,
        subjectDigest: canonicalDigest({ environmentId, spaceId, principalId, kind }) })
        || pin.bindingId !== canonicalDigest({ moduleId: pin.moduleId, version: pin.moduleVersion, offer: pin.offer })
        || current.name !== pin.modelName || current.effect !== pin.offer.effect || value.command.commandId !== current.commandId
        || value.command.name !== pin.offer.definition.name || value.command.effect !== current.effect) return false;
      routing = { commandId: current.commandId, bindingId: pin.bindingId, moduleId: pin.moduleId, moduleVersion: pin.moduleVersion };
      current = value.command; module = { id: pin.moduleId, version: pin.moduleVersion };
    }
    if (module.id !== 'user-questions' || module.version !== 1 || current.name !== 'student_ask' || current.effect !== 'ask') return false;
    const { sourceInputId, deadline, ...question } = fixedQuestion.parse(current.input);
    const inputIds = (basis.snapshot.authorityInputIds ?? basis.snapshot.inputIds ?? []) as string[];
    if (!inputIds.includes(sourceInputId) || !snapshot.inputs.some(input => input.inputId === sourceInputId
      && input.input.sessionId === snapshot.session.sessionId)) return false;
    return wait.deadline === deadline && same(wait.presentation, { ...question, sourceInputId,
      questionId: operationId('agent-user-question:' + current.commandId), commandId: current.commandId,
      ...(routing ? { toolDiscovery: routing } : {}), moduleId: outer.moduleId });
  } catch { return false; }
}
