import type { AgentAttempt, AgentStep, AgentTurnBudget } from '@xunjie/contracts/agent-runtime';

export interface TurnUsage { inputTokens: number; outputTokens: number; inputReserved: number; outputReserved: number; }
/** Provider-final usage is exact; an unsettled attempt bills its reservation. Retries bill within the same Step. */
export function attemptUsage(attempts: readonly AgentAttempt[]): TurnUsage {
  let inputTokens = 0, outputTokens = 0;
  for (const attempt of attempts) {
    const exact = attempt.usage.state === 'final';
    inputTokens += exact && attempt.usage.inputTokens !== undefined ? attempt.usage.inputTokens : Math.max(attempt.reserved.inputTokens, attempt.usage.inputTokens ?? 0);
    outputTokens += exact && attempt.usage.outputTokens !== undefined ? attempt.usage.outputTokens : Math.max(attempt.reserved.outputTokens, attempt.usage.outputTokens ?? 0);
  }
  return { inputTokens, outputTokens, inputReserved: 0, outputReserved: 0 };
}
export function budgetExhausted(budget: AgentTurnBudget, usage: TurnUsage, counts: { steps: number; toolCalls: number }, now: number): string | null {
  if (now >= Date.parse(budget.deadline)) return 'deadline-exceeded';
  if (counts.steps >= budget.maxSteps) return 'step-budget-exhausted';
  if (counts.toolCalls >= budget.maxToolCalls) return 'tool-budget-exhausted';
  if (usage.inputTokens + usage.inputReserved >= budget.maxInputTokens) return 'input-budget-exhausted';
  if (usage.outputTokens + usage.outputReserved >= budget.maxOutputTokens) return 'output-budget-exhausted';
  return null;
}
export type { AgentStep };
