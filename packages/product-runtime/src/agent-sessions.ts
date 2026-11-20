import { StorageError } from '@xunjie/storage';
import { canonicalDigest, operationId } from '@xunjie/storage/identity';
import { agentInputSchema, agentRuntimeSessionSchema, type AgentInput, type AgentQuestionResponse } from '@xunjie/contracts/agent-runtime';
import type { AgentSessionPort, AgentInputControl } from '@xunjie/contracts/agent-service';
import { createAgentSessionSchema, updateAgentSessionSchema, type AgentSession, type CreateAgentSession,
  type MarkAgentSessionReady, type UpdateAgentSession } from '@xunjie/contracts/agent-sessions';
import type { SpaceIdentity, LearningTarget } from '@xunjie/contracts/spaces';

/** The directory is a data-owner interface; the host never writes its tables. */
export interface AgentSessionDirectory {
  create(identity: SpaceIdentity, input: CreateAgentSession): Promise<AgentSession>;
  read(identity: SpaceIdentity, sessionId: string): Promise<AgentSession>;
  list(identity: SpaceIdentity): Promise<AgentSession[]>;
  update(identity: SpaceIdentity, input: UpdateAgentSession): Promise<AgentSession>;
  markReady(identity: SpaceIdentity, input: MarkAgentSessionReady): Promise<AgentSession>;
  /** Host-only metadata read used by the inspection port; never forwarded to a student session route. */
  readForInspection?(sessionId: string): Promise<AgentSession>;
}
export interface AgentSessionApplicationHost {
  directory: AgentSessionDirectory;
  /** Resolves exactly this saved owner; implementations must not choose a fallback. */
  runtime(session: AgentSession): Promise<AgentSessionPort>;
  deleted?(session: AgentSession): Promise<void>;
  /** Client delivery initializes at its owning Node host, after the directory is durable. */
  deferInitialization?(session: AgentSession): boolean;
  workspaceRequest?(identity: SpaceIdentity, activityId: string, target: LearningTarget): Promise<CreateAgentSession | undefined>;
}

/** Cross-owner initialization has a durable directory phase and an idempotent original session. */
export function createAgentSessionApplication(host: AgentSessionApplicationHost) {
  async function initialize(session: AgentSession) {
    if (session.state === 'ready') return session;
    if (host.deferInitialization?.(session)) return session;
    const runtime = await host.runtime(session);
    const input = agentRuntimeSessionSchema.parse({ sessionId: session.sessionId, identity: session.identity,
      scenario: session.scenario, createdAt: session.createdAt });
    const initialized = agentRuntimeSessionSchema.parse(await runtime.initialize(input));
    if (canonicalDigest(input) !== canonicalDigest(initialized)) throw new StorageError('identity-conflict');
    return host.directory.markReady(session.identity, {
      sessionId: session.sessionId, requestId: operationId('agent-session-ready:' + session.sessionId),
    });
  }
  async function read(identity: SpaceIdentity, sessionId: string) { return host.directory.read(identity, sessionId); }
  async function active(identity: SpaceIdentity, sessionId: string) {
    const session = await read(identity, sessionId);
    if (session.deleted || session.archived) throw new StorageError('conflict');
    return initialize(session);
  }
  async function endpoint(identity: SpaceIdentity, sessionId: string, writable = false) {
    const session = writable ? await active(identity, sessionId) : await read(identity, sessionId);
    if (session.deleted) throw new StorageError('missing');
    if (session.state !== 'ready') throw new StorageError('unavailable');
    return { session, runtime: await host.runtime(session) };
  }
  async function create(identity: SpaceIdentity, value: CreateAgentSession) {
    const input = createAgentSessionSchema.parse(value);
    return initialize(await host.directory.create(identity, input));
  }
  async function update(identity: SpaceIdentity, value: UpdateAgentSession) {
    const input = updateAgentSessionSchema.parse(value);
    const session = await host.directory.update(identity, input);
    if (input.deleted) await host.deleted?.(session);
    return session;
  }
  return { create, read, update, list: (identity: SpaceIdentity) => host.directory.list(identity), endpoint,
    async workspace(identity: SpaceIdentity, activityId: string, target: LearningTarget) {
      const original = await host.workspaceRequest?.(identity, activityId, target);
      if (original && (original.scenario !== 'workspace-assistant' || original.workspace?.activityId !== activityId
        || canonicalDigest(original.workspace.target) !== canonicalDigest(target))) throw new StorageError('identity-conflict');
      const existing = (await host.directory.list(identity)).find(session => session.workspace?.activityId === activityId
        && canonicalDigest(session.workspace.target) === canonicalDigest(target));
      if (existing) {
        if (original && existing.sessionId !== original.sessionId) throw new StorageError('identity-conflict');
        return initialize(existing);
      }
      if (original) return create(identity, original);
      const identityKey = [identity.environmentId, identity.spaceId, identity.principalId, identity.kind];
      const sessionId = operationId('workspace-agent-session:' + canonicalDigest({ identity: identityKey, activityId, target }));
      return create(identity, { requestId: operationId('workspace-agent-session-create:' + sessionId), sessionId,
        scenario: 'workspace-assistant', workspace: { activityId, target } });
    },
    async submit(identity: SpaceIdentity, value: unknown) {
      const input = agentInputSchema.parse(value);
      const { runtime } = await endpoint(identity, input.sessionId, true);
      return runtime.submit(identity, input);
    },
    async answerQuestion(identity: SpaceIdentity, sessionId: string, response: AgentQuestionResponse) {
      const { runtime } = await endpoint(identity, sessionId, true);
      return runtime.answerQuestion(identity, sessionId, response);
    },
    async inputControl(identity: SpaceIdentity, sessionId: string, inputId: string, control: AgentInputControl) {
      const { runtime } = await endpoint(identity, sessionId, true);
      return runtime.inputControl(identity, sessionId, inputId, control);
    },
    async turn(identity: SpaceIdentity, sessionId: string, turnId: string) {
      return (await endpoint(identity, sessionId)).runtime.turn(identity, sessionId, turnId);
    },
    async events(identity: SpaceIdentity, sessionId: string, after = 0) {
      return (await endpoint(identity, sessionId)).runtime.events(identity, sessionId, after);
    },
    async sessionSnapshot(identity: SpaceIdentity, sessionId: string) {
      return (await endpoint(identity, sessionId)).runtime.sessionSnapshot(identity, sessionId);
    },
    async conversation(identity: SpaceIdentity, sessionId: string, after = 0) {
      return (await endpoint(identity, sessionId)).runtime.conversation(identity, sessionId, after);
    },
    async request(identity: SpaceIdentity, sessionId: string, requestId: string) {
      return (await endpoint(identity, sessionId)).runtime.request(identity, sessionId, requestId);
    },
    async registerNotification(identity: SpaceIdentity, sessionId: string, originTurnId: string, fact: Parameters<AgentSessionPort['registerNotification']>[3]) {
      const { runtime } = await endpoint(identity, sessionId, true);
      return runtime.registerNotification(identity, sessionId, originTurnId, fact);
    },
    async recordProgress(identity: SpaceIdentity, sessionId: string, attemptId: string, progress: Parameters<AgentSessionPort['recordProgress']>[3]) {
      return (await endpoint(identity, sessionId)).runtime.recordProgress(identity, sessionId, attemptId, progress);
    },
    async stop(identity: SpaceIdentity, sessionId: string, turnId: string, requestId: string) {
      const { runtime } = await endpoint(identity, sessionId, true);
      return runtime.stop(identity, sessionId, turnId, requestId);
    },
    async continueSession(identity: SpaceIdentity, sessionId: string, requestId: string) {
      const { runtime } = await endpoint(identity, sessionId, true);
      return runtime.continueSession(identity, sessionId, requestId);
    },
  };
}

export type { AgentInput };
