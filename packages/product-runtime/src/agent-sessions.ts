import { StorageError } from '@xunjie/storage';
import { canonicalDigest, operationId } from '@xunjie/storage/identity';
import { agentInputSchema, agentRuntimeSessionSchema, type AgentRuntimePort } from '@xunjie/contracts/agent-runtime';
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
}
export interface AgentSessionApplicationHost {
  directory: AgentSessionDirectory;
  /** Resolves exactly this saved owner; implementations must not choose a fallback. */
  runtime(session: AgentSession): Promise<AgentRuntimePort>;
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
      scenario: session.scenario, restartPolicy: session.scenario === 'student-assistant' ? 'explicit' : 'automatic', createdAt: session.createdAt });
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
    async accept(identity: SpaceIdentity, value: unknown) {
      const input = agentInputSchema.parse(value);
      const { runtime } = await endpoint(identity, input.sessionId, true);
      return runtime.accept(identity, input);
    },
    async run(identity: SpaceIdentity, sessionId: string, runId: string) {
      return (await endpoint(identity, sessionId)).runtime.run(identity, sessionId, runId);
    },
    async events(identity: SpaceIdentity, sessionId: string, after = 0) {
      return (await endpoint(identity, sessionId)).runtime.events(identity, sessionId, after);
    },
    async stop(identity: SpaceIdentity, sessionId: string, runId: string, requestId: string) {
      return (await endpoint(identity, sessionId)).runtime.stop(identity, sessionId, runId, requestId);
    },
    async continueRun(identity: SpaceIdentity, sessionId: string, runId: string, requestId: string) {
      return (await endpoint(identity, sessionId, true)).runtime.continueRun(identity, sessionId, runId, requestId);
    },
  };
}
