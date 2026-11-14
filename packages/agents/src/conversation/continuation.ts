import { operationId } from '@xunjie/storage/identity';
import type { AgentExecutionSnapshot, Facts } from '@xunjie/agent-runtime';

/** Original owner observations remain structural facts independently of summary prose. */
export function conversationWaitFacts(snapshot: AgentExecutionSnapshot, state: Facts = snapshot.sessionState): Facts[] {
  const facts = new Map(((state.waitFacts ?? []) as Facts[]).map(fact => [String(fact.waitId), fact]));
  const queue = (snapshot.state.waitQueue ?? []) as Facts[];
  for (const wait of snapshot.waits) {
    const original = queue.find(item => wait.operationId === operationId('conversation-wait:' + String(item.commandId)));
    if (!original) continue;
    const { continuationOperationId, interruptible, ...fixedWait } = wait;
    const current: Facts = { ...fixedWait, ...(continuationOperationId === undefined ? {} : { continuationOperationId }),
      ...(interruptible === undefined ? {} : { interruptible }),
      commandId: original.commandId!, moduleId: original.moduleId! };
    const saved = facts.get(wait.waitId);
    if (!saved || Number(saved.version) <= wait.version) facts.set(wait.waitId, current);
  }
  return [...facts.values()];
}
export function conversationContinuation(snapshot: AgentExecutionSnapshot) {
  const effects = (snapshot.sessionState.effects ?? []) as Facts[], waits = conversationWaitFacts(snapshot);
  return effects.length || waits.length ? { kind: 'continuation-facts', effects, waits } : null;
}
