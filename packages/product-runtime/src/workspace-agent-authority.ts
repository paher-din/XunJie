import { StorageError } from '@xunjie/storage';
import { teachingArtifactReceiptSchema } from '@xunjie/contracts/teaching-artifacts';
import type { AgentSession } from '@xunjie/contracts/agent-sessions';
import type { AgentSessionPort } from '@xunjie/contracts/agent-service';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import type { LearningActivity } from '@xunjie/contracts/learning-data';
import type { AgentExecutionAssociation } from '@xunjie/contracts/execution';
import { agentDependencyPreparedToolSchema } from '@xunjie/contracts/agent-dependencies';
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
    const port = await options.agent(session), snapshot = await port.snapshot(identity, session.sessionId, association.runId);
    const step = snapshot.steps.find(item => item.operation.kind === 'tool.call' && item.operation.operationId === association.commandId);
    const fixed = step?.operation.input;
    const parsed = agentDependencyPreparedToolSchema.safeParse(fixed?.command);
    if (!parsed.success) throw new StorageError('forbidden');
    let prepared = parsed.data;
    // Discovery and dependency transport retain the original command, including its model-step basis.
    for (let depth = 0; depth < 3 && prepared; depth++) {
      if (prepared.commandId !== association.commandId) throw new StorageError('forbidden');
      const input = prepared.input;
      if (input.moduleId === 'tool-discovery' && input.moduleVersion === 1 && input.kind === 'delegate')
        prepared = agentDependencyPreparedToolSchema.parse(input.command);
      else if (input.version === 2 && input.module && input.prepared) prepared = agentDependencyPreparedToolSchema.parse(input.prepared);
      else break;
    }
    const basis = prepared.input;
    if (!step || fixed?.basisStepId !== association.stepId || association.snapshotId !== association.stepId
      || basis?.modelStepId !== association.stepId) throw new StorageError('forbidden');
    return { port, snapshot, step, session };
  }
  async function assertDispatch(identity: SpaceIdentity, activityId: string, association: AgentExecutionAssociation) {
    const { port, snapshot, step, session } = await command(identity, activityId, association);
    await port.assertDispatch(identity, { sessionId: session.sessionId, runId: association.runId,
      stepId: step.stepId, operationId: association.commandId, generation: snapshot.run.generation });
  }
  const assertArtifactAdoption: NonNullable<Parameters<typeof createLearningData>[6]> = async (identity, activityId, origin, candidate) => {
    const { snapshot, step } = await command(identity, activityId, origin);
    if (snapshot.run.stopRequested || ['failed', 'stopped'].includes(snapshot.run.state) || step.result?.state !== 'completed')
      throw new StorageError('conflict');
    const value = step.result.value as unknown as { outcome?: { state?: string; result?: { artifact?: unknown } } };
    const published = teachingArtifactReceiptSchema.safeParse(value.outcome?.result?.artifact);
    const modelStep = snapshot.steps.find(item => item.stepId === origin.stepId);
    if (value.outcome?.state !== 'completed' || !published.success || published.data.kind !== 'publish'
      || published.data.requestId !== origin.commandId || published.data.artifactId !== candidate.artifactId
      || published.data.revisionId !== candidate.revisionId || published.data.candidateId !== candidate.candidateId
      || origin.attemptId && modelStep?.operation.operationId !== origin.attemptId) throw new StorageError('forbidden');
  };
  return { assertDispatch, assertArtifactAdoption };
}
