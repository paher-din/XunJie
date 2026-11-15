import { StorageError } from '@xunjie/storage';
import { teachingArtifactReceiptSchema } from '@xunjie/contracts/teaching-artifacts';
import type { AgentSession } from '@xunjie/contracts/agent-sessions';
import type { AgentSessionPort } from '@xunjie/contracts/agent-service';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import type { LearningActivity } from '@xunjie/contracts/learning-data';
import type { AgentExecutionAssociation } from '@xunjie/contracts/execution';
import type { createLearningData } from '@xunjie/learning-space/learning-data';

export interface WorkspaceAgentAuthorityOptions {
  sessions(identity: SpaceIdentity): Promise<AgentSession[]>;
  agent(session: AgentSession): Promise<AgentSessionPort>;
  activity(identity: SpaceIdentity, activityId: string): Promise<LearningActivity>;
}

/** Browser execution and adoption resolve the retained command, never the current member binding. */
export function createWorkspaceAgentAuthority(options: WorkspaceAgentAuthorityOptions) {
  async function command(identity: SpaceIdentity, activityId: string, association: AgentExecutionAssociation) {
    const activity = await options.activity(identity, activityId);
    if (activity.status !== 'open') throw new StorageError('forbidden');
    const session = (await options.sessions(identity)).find(item => item.workspace?.activityId === activityId);
    if (!session || session.deleted || session.archived) throw new StorageError('forbidden');
    const port = await options.agent(session), snapshot = await port.sessionSnapshot(identity, session.sessionId);
    const turn = snapshot.turns.find(item => item.turnId === association.runId);
    const step = snapshot.steps.find(item => item.stepId === association.stepId);
    const call = snapshot.toolCalls.find(item => item.toolCallId === association.commandId);
    // A retained command only belongs to this Turn's real Step and ToolCall; no later Turn can adopt it.
    if (!turn || ['stopped', 'failed', 'interrupted'].includes(turn.state)
      || !step || step.turnId !== turn.turnId || !call || call.stepId !== step.stepId) throw new StorageError('forbidden');
    return { port, snapshot, step, call, turn, session };
  }
  async function assertDispatch(identity: SpaceIdentity, activityId: string, association: AgentExecutionAssociation) {
    const { port, session } = await command(identity, activityId, association);
    await port.assertDispatch(identity, { sessionId: session.sessionId, runId: association.runId,
      stepId: association.stepId, operationId: association.commandId, generation: 1 });
  }
  /** A browser job accepted before its original Step closed may start later; the durable task is the fence. */
  async function assertTaskDispatch(identity: SpaceIdentity, activityId: string, association: AgentExecutionAssociation) {
    const { call, turn } = await command(identity, activityId, association);
    if (turn.state !== 'active' && turn.state !== 'completed') throw new StorageError('forbidden');
    if (call.executionMode !== 'background' || call.state !== 'closed'
      || !call.result || call.result.kind !== 'accepted') throw new StorageError('forbidden');
  }
  const assertArtifactAdoption: NonNullable<Parameters<typeof createLearningData>[6]> = async (identity, activityId, origin, candidate) => {
    const { call, turn } = await command(identity, activityId, origin);
    if (['stopped', 'failed', 'interrupted'].includes(turn.state) || call.state !== 'closed'
      || call.result?.kind !== 'completed' || call.result.outcome !== 'success') throw new StorageError('conflict');
    const data = call.result.data as { artifact?: unknown } | null | undefined;
    const published = teachingArtifactReceiptSchema.safeParse(data?.artifact);
    if (!published.success || published.data.kind !== 'publish'
      || published.data.requestId !== origin.commandId || published.data.artifactId !== candidate.artifactId
      || published.data.revisionId !== candidate.revisionId || published.data.candidateId !== candidate.candidateId)
      throw new StorageError('forbidden');
  };
  return { assertDispatch, assertTaskDispatch, assertArtifactAdoption };
}
