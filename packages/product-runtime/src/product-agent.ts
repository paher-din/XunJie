import type { OwnedStorage } from '@xunjie/storage';
import { StorageError } from '@xunjie/storage';
import type { AgentSession } from '@xunjie/contracts/agent-sessions';
import type { AgentSessionPort } from '@xunjie/contracts/agent-service';
import type { LearningTarget, SpaceIdentity } from '@xunjie/contracts/spaces';
import type { SessionMaterialPort } from '@xunjie/contracts/session-materials';
import type { LearningModelPort } from '@xunjie/model-gateway/service';
import { createStudentAssistant } from '@xunjie/agents/student-assistant/index';
import { createWorkspaceAssistant, createWorkspaceToolModule, type WorkspaceToolOptions } from '@xunjie/agents/workspace-assistant/index';
import { createDocumentTools, type DocumentMaterialsPort } from '@xunjie/agents/capabilities/documents/index';
import type { ConversationOptions } from '@xunjie/agents/conversation/index';
import type { ConversationToolModule } from '@xunjie/agents/conversation/tools';
import { createLearningTools, type LearningToolsHost } from '@xunjie/agents/student-assistant/tools/learning-tools';
import { createUserQuestions } from '@xunjie/agents/capabilities/user-questions/index';
import { createToolDiscovery } from '@xunjie/agents/capabilities/tool-discovery/index';
import type { AgentSessionApplicationHost, AgentSessionDirectory } from './agent-sessions.js';
import { createSessionRuntimeHost } from './session-runtime.js';
import { operationId, canonicalDigest } from '@xunjie/storage/identity';
import { createWorkspaceAgentWaits, type WorkspaceAgentWaitOptions, type ObservedAgentWaits } from './workspace-agent-waits.js';

export interface ProductAgentOptions {
  storage: OwnedStorage;
  directory: AgentSessionDirectory;
  models?: LearningModelPort;
  modelsForSession?(session: AgentSession): Promise<LearningModelPort>;
  authorize(identity: SpaceIdentity): Promise<void>;
  student?(session: AgentSession): Promise<LearningToolsHost>;
  workspace(session: AgentSession): Promise<WorkspaceToolOptions>;
  materials?(session: AgentSession): Promise<DocumentMaterialsPort>;
  materialSource?(session: AgentSession): Promise<{ sourceId: string; owner: LearningTarget }>;
  skills?(session: AgentSession, companions: readonly ConversationToolModule[]): Promise<ConversationToolModule>;
  tools?(session: AgentSession): Promise<readonly ConversationToolModule[] | undefined>;
  remote?(session: AgentSession): Promise<AgentSessionPort>;
  deleted?(session: AgentSession): Promise<void>;
  withAuthority?: ConversationOptions['withAuthority'];
  readOnly?: boolean;
  waits?: Omit<WorkspaceAgentWaitOptions, 'resolve'>;
  workspaceRequest?: AgentSessionApplicationHost['workspaceRequest'];
}

/** Both product and independent Agent hosts use these exact scene assemblies. */
export function createProductAgent(options: ProductAgentOptions) {
  let observer: ReturnType<typeof createWorkspaceAgentWaits> | undefined;
  let waitsClosed = !!options.readOnly;
  const waiting = new Map<string, ObservedAgentWaits>();
  function observeWaits(value: ObservedAgentWaits) {
    if (value.waits.some(wait => wait.kind === 'workspace-execution')) waiting.set(value.runId, value);
    else waiting.delete(value.runId);
    if (!options.waits || waitsClosed) return;
    if (!observer && value.waits.some(wait => wait.kind === 'workspace-execution')) observer = createWorkspaceAgentWaits({ ...options.waits,
      async resolve(session, wait, result) {
        await host.runtime.resolveWait(session.identity, session.sessionId, { waitId: wait.waitId, expectedVersion: wait.version,
          requestId: operationId(`workspace-wait-result:${wait.waitId}:${wait.version}:${canonicalDigest(result)}`), result });
      } });
    observer?.observe(value);
  }
  const host = createSessionRuntimeHost({ storage: options.storage, directory: options.directory,
    authorize: options.authorize, readOnly: options.readOnly, remote: options.remote, deleted: options.deleted,
    workspaceRequest: options.workspaceRequest,
    observeWaits,
    async pipeline(session) {
      const models = await options.modelsForSession?.(session) ?? options.models;
      if (!models) throw new StorageError('unavailable');
      const provided = await options.tools?.(session);
      const materials = provided ? undefined : await options.materials?.(session);
      if (!provided && !materials) throw new StorageError('unavailable');
      const source = materials ? await options.materialSource?.(session) : undefined;
      const documents = materials ? createDocumentTools({ materials, models, ...(source ? { source } : {}) }) : undefined;
      const learning = !provided && session.scenario === 'student-assistant' ? await options.student?.(session) : undefined;
      const workspace = session.scenario === 'workspace-assistant' ? { ...await options.workspace(session), models } : undefined;
      if (!provided && session.scenario === 'student-assistant' && !learning) throw new StorageError('unavailable');
      const companions = provided ? [...provided] : [learning ? createLearningTools(learning) : createWorkspaceToolModule(workspace!), createUserQuestions(), documents!];
      const skills = provided ? undefined : await options.skills?.(session, companions);
      const tools = [createToolDiscovery({ modules: [...companions, ...(skills ? [skills] : [])],
        // Keep the scene's working tools available; optional Skill content is discovered before use.
        initiallyVisible: binding => !['skill_load', 'skill_read'].includes(binding.offer.definition.name) })];
      const common = { models, ...(documents ? { documents } : {}), ...(skills ? { skills } : {}),
        ...(options.withAuthority ? { withAuthority: options.withAuthority } : {}),
        progress: async (_snapshot: Parameters<NonNullable<ConversationOptions['progress']>>[0],
          _step: Parameters<NonNullable<ConversationOptions['progress']>>[1],
          permit: Parameters<NonNullable<ConversationOptions['progress']>>[2],
          value: Parameters<NonNullable<ConversationOptions['progress']>>[3]) => {
          if (_step.operation.kind === 'model.call') await host.runtime.recordProgress(session.identity, permit, value);
        } };
      if (session.scenario === 'student-assistant') return createStudentAssistant({ ...common, tools });
      return createWorkspaceAssistant({ ...common, ...workspace!, tools });
    } });
  function closeWaits() { waitsClosed = true; observer?.closeDispatch(); }
  return { ...host,
    async materials(identity: SpaceIdentity, sessionId: string) {
      const session = await options.directory.read(identity, sessionId);
      if (!options.materials) throw new StorageError('unavailable');
      return options.materials(session);
    },
    closeWrites() { closeWaits(); host.closeWrites(); },
    closeDispatch() { closeWaits(); host.closeDispatch(); },
    async drain() { await Promise.all([host.drain(), observer?.drain()]); },
    async resume() {
      await observer?.drain(); observer = undefined; waitsClosed = false;
      await host.resume();
      for (const facts of waiting.values()) observeWaits(facts);
    },
    async close() { closeWaits(); await observer?.drain(); waiting.clear(); await host.close(); },
  };
}
