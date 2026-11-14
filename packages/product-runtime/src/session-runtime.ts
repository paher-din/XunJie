import { StorageError, type OwnedStorage } from '@xunjie/storage';
import { canonicalDigest, operationId } from '@xunjie/storage/identity';
import { createAgentRuntime, type AgentScenario, type TaskFactsPort, type TaskCancellationPort } from '@xunjie/agent-runtime';
import type { LearningModelPort } from '@xunjie/model-gateway/service';
import type { AgentSession } from '@xunjie/contracts/agent-sessions';
import type { AgentSessionPort } from '@xunjie/contracts/agent-service';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import { createAgentSessionApplication, type AgentSessionApplicationHost, type AgentSessionDirectory } from './agent-sessions.js';
import { createAgentConversationProjection } from './agent-conversation.js';

export interface SessionRuntimeHostOptions {
  storage: OwnedStorage;
  directory: AgentSessionDirectory;
  authorize(identity: SpaceIdentity): Promise<void>;
  /** One scene dispatcher; it selects student/workspace per session and injects concrete tools. */
  scenario: AgentScenario;
  gateway: LearningModelPort;
  taskFacts?: TaskFactsPort;
  taskCancellation?: TaskCancellationPort;
  remote?(session: AgentSession): Promise<AgentSessionPort>;
  deleted?(session: AgentSession): Promise<void>;
  readOnly?: boolean;
  workspaceRequest?: AgentSessionApplicationHost['workspaceRequest'];
}

/** One kernel owns local sessions. The directory alone selects an original remote owner. */
export function createSessionRuntimeHost(options: SessionRuntimeHostOptions) {
  function local(session: AgentSession) {
    return session.owner.target.environmentId === options.storage.owner.environmentId
      && session.owner.target.serviceId === options.storage.owner.serviceId;
  }
  async function saved(identity: SpaceIdentity, sessionId: string, dispatch = false, retired = false) {
    const session = await options.directory.read(identity, sessionId);
    if (!local(session)) throw new StorageError('forbidden');
    if (session.deleted && !retired) throw new StorageError('missing');
    if (dispatch && session.archived) throw new StorageError('conflict');
    return session;
  }
  const runtime = createAgentRuntime(options.storage, { authorize: options.authorize, scenario: options.scenario,
    gateway: options.gateway, ...(options.taskFacts ? { taskFacts: options.taskFacts } : {}),
    ...(options.taskCancellation ? { taskCancellation: options.taskCancellation } : {}),
    ...(options.readOnly ? { readOnly: options.readOnly } : {}) });
  const projection = createAgentConversationProjection(runtime);
  const localPort: AgentSessionPort = { ...runtime, conversation: projection.conversation,
    async initialize(input) {
      const session = await saved(input.identity, input.sessionId, true);
      const expected = { sessionId: session.sessionId, identity: session.identity, scenario: session.scenario, createdAt: session.createdAt };
      if (canonicalDigest(input) !== canonicalDigest(expected)) throw new StorageError('identity-conflict');
      return runtime.initialize(input);
    },
    async submit(identity, input) { await saved(identity, input.sessionId, true); return runtime.submit(identity, input); },
    async answerQuestion(identity, sessionId, response) {
      await saved(identity, sessionId, true); return runtime.answerQuestion(identity, sessionId, response);
    },
    async stop(identity, sessionId, turnId, requestId) {
      await saved(identity, sessionId, true); return runtime.stop(identity, sessionId, turnId, requestId);
    },
    async continueSession(identity, sessionId, requestId) {
      await saved(identity, sessionId, true); return runtime.continueSession(identity, sessionId, requestId);
    },
    async inputControl(identity, sessionId, inputId, control) {
      await saved(identity, sessionId, true); return runtime.inputControl(identity, sessionId, inputId, control);
    },
    async registerNotification(identity, sessionId, originTurnId, fact) {
      await saved(identity, sessionId, true); return runtime.registerNotification(identity, sessionId, originTurnId, fact);
    } };
  async function endpoint(session: AgentSession): Promise<AgentSessionPort> {
    if (local(session)) return localPort;
    if (!options.remote) throw new StorageError('unavailable');
    return options.remote(session);
  }
  const sessions = createAgentSessionApplication({ directory: options.directory, runtime: endpoint,
    workspaceRequest: options.workspaceRequest,
    async deleted(session) {
      // A removed session stops its active Turn first; the kernel never resumes a deleted session.
      if (local(session) && session.state === 'ready') {
        const state = await runtime.sessionSnapshot(session.identity, session.sessionId);
        for (const turn of state.turns) if (turn.state === 'active')
          await runtime.stop(session.identity, session.sessionId, turn.turnId, operationId(`delete-session:${session.sessionId}:${turn.turnId}`));
      }
      await options.deleted?.(session);
    } });
  return { sessions, runtime, local: localPort,
    async agent(identity: SpaceIdentity, sessionId: string) {
      const session = await options.directory.read(identity, sessionId);
      if (session.deleted) throw new StorageError('missing');
      if (session.state !== 'ready') throw new StorageError('unavailable');
      return endpoint(session);
    },
    closeWrites: () => runtime.closeWrites(), closeDispatch: () => runtime.closeDispatch(),
    async resume() { await runtime.resume(); },
    drain: () => runtime.drain(), close: () => runtime.close() };
}
