import { StorageError } from '@xunjie/storage';
import type { AgentExecutionSnapshot, Facts } from '@xunjie/agent-runtime';
import type { ModelAttempt } from '@xunjie/contracts/model-connections';

export interface ConversationLimits {
  maxModelSteps: number; maxToolCommands: number; maxInputTokens: number; maxOutputTokens: number; maxCallMs: number; hardDeadlineMs: number;
}
export const conversationLimits: Readonly<ConversationLimits> = Object.freeze({ maxModelSteps: 16, maxToolCommands: 64,
  maxInputTokens: 1_048_576, maxOutputTokens: 65_536, maxCallMs: 600_000, hardDeadlineMs: 86_400_000 });
export function budgetBasis(snapshot: AgentExecutionSnapshot, options: Partial<ConversationLimits> = {}) {
  const previous = snapshot.steps.find(step => step.snapshot.budgetBasis)?.snapshot.budgetBasis;
  if (previous) return previous as unknown as ConversationLimits & { deadline: string };
  const limits = { ...conversationLimits, ...options };
  if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 1)) throw new StorageError('invalid');
  return { ...limits, deadline: new Date(Date.parse(snapshot.run.createdAt) + limits.hardDeadlineMs).toISOString() };
}
export function runBudget(snapshot: AgentExecutionSnapshot) {
  let modelSteps = 0, tools = 0, inputTokens = 0, outputTokens = 0, inputReserved = 0, outputReserved = 0;
  for (const step of snapshot.steps) {
    if (step.operation.kind === 'tool.call' && !step.operation.input.preparationFailure
      && (step.result?.value.outcome as Facts | undefined)?.state !== 'not-dispatched') tools++;
    if (!['model.call', 'context.compaction.call', 'input.policy.call'].includes(step.operation.kind)) continue;
    modelSteps++;
    const fact = step.result?.value.attempt as unknown as ModelAttempt | undefined;
    const exact = fact?.usage.state === 'final';
    if (exact && fact.usage.inputTokens !== undefined) inputTokens += fact.usage.inputTokens;
    else inputReserved += Math.max(Number(step.snapshot.inputReserve ?? 1_048_576), fact?.usage.inputTokens ?? 0);
    if (exact && fact.usage.outputTokens !== undefined) outputTokens += fact.usage.outputTokens;
    else outputReserved += Math.max(Number((step.operation.input.limits as Facts).maxOutputTokens), fact?.usage.outputTokens ?? 0);
  }
  return { modelSteps, tools, inputTokens, outputTokens, inputReserved, outputReserved, counting: 'provider-final-or-reserved' };
}
