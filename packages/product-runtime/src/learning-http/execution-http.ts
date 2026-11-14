import { StorageError } from '@xunjie/storage';
import { agentBrowserClaimInputSchema, agentBrowserAcceptanceInputSchema, type AgentExecutionAssociation } from '@xunjie/contracts/execution';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import type { createLearningData } from '@xunjie/learning-space/learning-data';

export type ExecutionCommandAuthorization = (identity: SpaceIdentity, activityId: string,
  association: AgentExecutionAssociation) => Promise<void>;

/** Routes commands at their actual execution owner; data synchronization is a separate operation. */
export async function routeExecutionHttp(executions: ReturnType<typeof createLearningData>['executions'],
  authorizeCommand: ExecutionCommandAuthorization | undefined, identity: SpaceIdentity, route: string, body?: unknown) {
  if (authorizeCommand !== undefined && typeof authorizeCommand !== 'function') throw new StorageError('incompatible');
  const parts = route.split('/'), activityId = parts[1]!, requestId = parts[2]!, method = body === undefined ? 'GET' : 'POST';
  const guard = async (association: AgentExecutionAssociation) => {
    if (!authorizeCommand) throw new StorageError('unavailable');
    return authorizeCommand(identity, activityId, association);
  };
  if (parts.length === 3 && requestId === 'agent-pending' && method === 'GET') return executions.agent.pendingBrowser(identity, activityId);
  if (parts.length === 4 && requestId === 'agent-stops' && method === 'GET') return executions.agent.browserStops(identity, activityId, parts[3]!);
  if (parts.length === 5 && requestId === 'agent' && parts[4] === 'claim' && method === 'POST')
    return executions.agent.claimBrowser(identity, activityId, parts[3]!, agentBrowserClaimInputSchema.parse(body).browserId, guard);
  if (parts.length === 5 && requestId === 'agent' && parts[4] === 'accept' && method === 'POST') {
    const input = agentBrowserAcceptanceInputSchema.parse(body);
    return executions.agent.acceptBrowser(identity, activityId, parts[3]!, input.browserId, input.acceptance, guard);
  }
  if (parts.length === 2 && method === 'POST') return executions.accept(identity, activityId, body);
  if (requestId === 'history' && method === 'GET') return executions.history(identity, activityId, parts[3]);
  if (parts.length === 4 && parts[3] === 'artifact' && method === 'GET') return executions.artifact(identity, activityId, requestId);
  if (requestId === 'sessions' && method === 'GET') return executions.sessions(identity, activityId);
  if (requestId === 'checkpoints' && method === 'GET') return executions.checkpoints(identity, activityId, parts[3]);
  if (parts.length === 3 && method === 'GET') return executions.read(identity, activityId, requestId);
  if (parts.length === 5 && parts[3] === 'controls' && method === 'GET') return executions.controlReceipt(identity, activityId, requestId, parts[4]!);
  if (parts.length === 4 && method === 'POST') {
    if (parts[3] === 'control') return executions.control(identity, activityId, requestId, body);
    if (parts[3] === 'report') return executions.report(identity, activityId, requestId, body);
    if (parts[3] === 'stop') return executions.stop(identity, activityId, requestId, body);
    if (parts[3] === 'result') return executions.result(identity, activityId, requestId, body);
  }
  throw new StorageError('missing');
}
