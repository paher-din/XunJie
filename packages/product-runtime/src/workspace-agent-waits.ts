import { z } from 'zod';
import { canonicalDigest } from '@xunjie/storage/identity';
import { StorageError } from '@xunjie/storage';
import { AsyncWaits, type TimerScheduler } from '@xunjie/agents/execution/async-waits';
import { type AgentRuntimeSession, type AgentWait } from '@xunjie/contracts/agent-runtime';
import { agentExecutionAssociationSchema, executionControlReceiptSchema, type AgentExecutionAssociation,
  type ExecutionQuery, type ExecutionControlReceipt } from '@xunjie/contracts/execution';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import type { Facts } from '@xunjie/agent-runtime';

export interface ObservedAgentWaits { session: AgentRuntimeSession; runId: string; waits: AgentWait[]; }
export interface WorkspaceAgentWaitOptions {
  /** Read the original execution's owner and association; this port cannot dispatch execution. */
  read(session: AgentRuntimeSession, wait: AgentWait): Promise<(Facts & { state: string; statusKnowledge: string }) | null>;
  resolve(session: AgentRuntimeSession, wait: AgentWait, result: Facts): Promise<void>;
  timers?: TimerScheduler;
  retryMs?: number;
}
const presentation = z.object({ activityId: z.uuid(), requestId: z.uuid(), commandId: z.uuid(),
  association: agentExecutionAssociationSchema }).passthrough();
const terminal = new Set(['succeeded', 'failed', 'cancelled']);

interface ExecutionReadOwner {
  agent: { read(identity: SpaceIdentity, activityId: string, context: AgentExecutionAssociation & { assertDispatch(): Promise<void> },
    requestId: string): Promise<ExecutionQuery | null> };
  controlReceipt(identity: SpaceIdentity, activityId: string, requestId: string, controlId: string): Promise<ExecutionControlReceipt | null>;
}

/** A native input has its own receipt; its parent process can remain running. */
export async function readWorkspaceAgentWait(owner: ExecutionReadOwner, session: AgentRuntimeSession, wait: AgentWait) {
  const fixed = presentation.parse(wait.presentation);
  const query = await owner.agent.read(session.identity, fixed.activityId, { ...fixed.association,
    assertDispatch: async () => { throw new StorageError('forbidden'); } }, fixed.requestId);
  if (!query) return null;
  const expectedScope = { environmentId: session.identity.environmentId, spaceId: session.identity.spaceId,
    principalId: session.identity.principalId, activityId: fixed.activityId };
  if (query.requestId !== fixed.requestId || canonicalDigest(query.scope) !== canonicalDigest(expectedScope))
    throw new StorageError('identity-conflict');
  const receipt = fixed.commandId === fixed.requestId ? null
    : await owner.controlReceipt(session.identity, fixed.activityId, fixed.requestId, fixed.commandId);
  if (receipt && (receipt.controlId !== fixed.commandId || receipt.requestId !== fixed.requestId
    || receipt.executionRef !== query.executionRef || receipt.query.executionRef !== query.executionRef
    || receipt.query.requestId !== fixed.requestId || canonicalDigest(receipt.query.scope) !== canonicalDigest(query.scope)))
    throw new StorageError('identity-conflict');
  return JSON.parse(JSON.stringify({ ...(receipt?.query ?? query), ...(receipt ? { controlReceipt: receipt } : {}) })) as Facts & { state: string; statusKnowledge: string };
}

function operationSettled(wait: AgentWait, result: Facts) {
  const fixed = presentation.parse(wait.presentation);
  if (fixed.commandId === fixed.requestId && result.session && typeof result.session === 'object' && !Array.isArray(result.session)
    && result.state === 'running' && result.statusKnowledge === 'confirmed') return true;
  if (result.controlReceipt === undefined) return false;
  const receipt = executionControlReceiptSchema.parse(result.controlReceipt);
  if (receipt.controlId !== fixed.commandId || receipt.requestId !== fixed.requestId || receipt.executionRef !== result.executionRef
    || receipt.query.requestId !== fixed.requestId || receipt.query.executionRef !== result.executionRef)
    throw new StorageError('identity-conflict');
  return receipt.status === 'applied' || receipt.status === 'rejected';
}

/** Optional workspace assembly. Construction registers no timers and performs no storage scan. */
export function createWorkspaceAgentWaits(options: WorkspaceAgentWaitOptions) {
  const active = new Map<string, { session: AgentRuntimeSession; wait: AgentWait; digest: string; cancel(): void }>();
  let closed = false;
  const timers = new AsyncWaits({ ...(options.timers ? { timers: options.timers } : {}),
    minDelayMs: 1, maxDelayMs: 30_000,
    async wake(_runId, waitId) {
      const original = active.get(waitId);
      if (closed || !original) return;
      const retry = () => {
        if (closed || active.get(waitId) !== original) return;
        if (original.wait.deadline !== null && Date.now() >= Date.parse(original.wait.deadline)) return;
        original.cancel = timers.register({ waitId, runId: original.wait.runId, delayMs: options.retryMs ?? 1000 });
      };
      try {
        const result = await options.read(original.session, original.wait);
        if (closed || active.get(waitId) !== original) return;
        if (result && (operationSettled(original.wait, result) || result.statusKnowledge === 'confirmed' && terminal.has(result.state))) {
          await options.resolve(original.session, original.wait, result);
          if (active.get(waitId) === original) active.delete(waitId);
        } else retry();
      } catch (error) {
        if (!(error instanceof StorageError)) throw error;
        if (['unavailable', 'resource-busy', 'commit-unknown', 'maintenance'].includes(error.code)) retry();
        else if (['forbidden', 'missing', 'conflict'].includes(error.code)) active.delete(waitId);
        else throw error;
      }
    } });
  function observe(value: ObservedAgentWaits) {
    if (closed) return;
    const pending = value.waits.filter(wait => wait.kind === 'workspace-execution' && wait.state === 'pending');
    const ids = new Set(pending.map(wait => wait.waitId));
    for (const [id, entry] of active) if (entry.wait.runId === value.runId && !ids.has(id)) {
      entry.cancel(); active.delete(id);
    }
    for (const wait of pending) {
      const fixed = presentation.parse(wait.presentation);
      if (wait.runId !== value.runId || fixed.association.runId !== wait.runId || fixed.association.commandId !== fixed.commandId)
        throw new Error('Workspace wait does not match its original command.');
      const digest = canonicalDigest({ session: value.session, wait });
      const prior = active.get(wait.waitId);
      if (prior?.digest === digest) continue;
      prior?.cancel();
      active.set(wait.waitId, { session: structuredClone(value.session), wait: structuredClone(wait), digest,
        cancel: timers.register({ waitId: wait.waitId, runId: wait.runId, delayMs: options.retryMs ?? 1000 }) });
    }
  }
  return { observe,
    closeDispatch() { closed = true; timers.stop(); active.clear(); },
    drain: () => timers.drain(),
  };
}
