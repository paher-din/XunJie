import { join } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import { StorageError, type OwnedStorage, type StorageBinding } from '@xunjie/storage';
import { createChunkChannel } from '@xunjie/storage/chunk-channel';
import { agentSessionCallSchema, agentSessionsCapability, sameAgentSubject } from '@xunjie/contracts/agent-service';
import type { AgentSession } from '@xunjie/contracts/agent-sessions';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import { agentDependenciesCapability } from '@xunjie/contracts/agent-dependencies';
import { agentExecutionAssociationSchema } from '@xunjie/contracts/execution';
import { createAgentDependencyClient, type AgentDependencyClient } from '@xunjie/agents/transport/session-dependencies';
import type { LearningModelPort } from '@xunjie/model-gateway/service';
import { createAgentSessionService } from '@xunjie/agents/transport/session-service';
import { agentServiceMigrations, collectAgentServiceSources, isAgentSessionRead,
  validateAgentServiceStorage } from '@xunjie/agents/transport/session-storage';
import type { RuntimeEnvironment } from '@xunjie/contracts/product-runtime';
import type { InstalledConfiguration } from './runtime.js';
import { createStorageRecoveryOwner } from './storage-recovery.js';
import { createAgentConnection } from './agent-connections.js';
import { createProductAgent } from './product-agent.js';
import { readWorkspaceAgentWait } from './workspace-agent-waits.js';
import { collectAgentRuntimeBoundary, collectAgentRuntimeReceiverBoundary } from '@xunjie/agent-runtime/maintenance';
import { readJson } from './io.js';
import type { CapabilityHandler } from './connections.js';
import { RuntimeConnectionError } from './connections.js';
import { isRecoverySuccessor } from './recovery-successions.js';

/** The independent host owns kernel facts; directory, tools and model routing stay at their real owners. */
export function createStandaloneAgentApplication(options: {
  root: string; environment: RuntimeEnvironment; configuration: InstalledConfiguration;
  storage: OwnedStorage; binding: StorageBinding;
  enabled?: boolean;
  /** A device host routes each identity to its authenticated school data owner. */
  dependencies?: AgentDependencyClient;
  /** A colocated model owner stays local; an independent host uses the dependency port. */
  models?: LearningModelPort;
}) {
  const { root, environment, configuration, storage, binding } = options;
  const declared = configuration.deployment?.dependencies['learning-data'];
  const dependencyConnectionId = declared?.kind === 'connection' ? declared.connectionId : configuration.agent?.dependencyConnectionId;
  const connection = dependencyConnectionId ? createAgentConnection(root, dependencyConnectionId, agentDependenciesCapability) : undefined;
  const dependencies = options.dependencies ?? createAgentDependencyClient(async call => {
    if (!connection) throw new StorageError('unavailable');
    return connection(call);
  });
  // Admission belongs to one incoming call, never to a run or a background wake.
  const admissions = new AsyncLocalStorage<{ active: boolean; reusable: boolean; session?: AgentSession }>();
  const canReuseAdmission = (operation: string) => ['initialize', 'assertDispatch', 'run', 'events', 'conversation', 'snapshot', 'request'].includes(operation);
  function admitted(identity: SpaceIdentity, sessionId?: string) {
    const scope = admissions.getStore(), session = scope?.session;
    return scope?.active && scope.reusable && session && sameAgentSubject(session.identity, identity)
      && (sessionId === undefined || session.sessionId === sessionId) ? session : undefined;
  }
  async function authorizeSession(identity: SpaceIdentity, sessionId: string) {
    if (admitted(identity, sessionId)) return;
    // sessions.read checks current membership and this installation's fixed owner.
    const session = await dependencies.sessions.read(identity, sessionId);
    const scope = admissions.getStore();
    if (scope?.active && scope.reusable) scope.session = session;
  }
  const directory = { ...dependencies.sessions,
    async read(identity: SpaceIdentity, sessionId: string) {
      const session = admitted(identity, sessionId);
      return session ? structuredClone(session) : dependencies.sessions.read(identity, sessionId);
    },
  };
  const agent = createProductAgent({ storage, directory, readOnly: true,
    withAuthority: dependencies.withAuthority,
    async authorize(identity) { if (!admitted(identity)) await dependencies.source.describe(identity); },
    async modelsForSession(session) { return options.models ?? dependencies.forSession(session.identity, session.sessionId).models; },
    async tools(session) { return dependencies.forSession(session.identity, session.sessionId).tools(); },
    async workspace(session) {
      if (!session.workspace) throw new StorageError('forbidden');
      const ports = dependencies.forSession(session.identity, session.sessionId);
      return { workspace: ports.workspace, learning: ports.learning, courses: ports.courses };
    },
    waits: { async read(session, wait) {
      const fixed = z.object({ activityId: z.uuid(), requestId: z.uuid(), association: agentExecutionAssociationSchema }).passthrough().parse(wait.presentation);
      const directory = await dependencies.sessions.read(session.identity, session.sessionId);
      if (fixed.activityId !== directory.workspace?.activityId) throw new StorageError('forbidden');
      return readWorkspaceAgentWait(dependencies.forSession(session.identity, session.sessionId).learning.executions, session, wait);
    } },
  });
  const service = createAgentSessionService(agent.local, { audience: 'service',
    async authorize(identity, sessionId, operation) {
      const scope = admissions.getStore();
      if (scope) scope.reusable = canReuseAdmission(operation);
      await authorizeSession(identity, sessionId);
    },
    // The common authorize above admits these service-only operations. The local
    // backend still checks the fixed directory owner and original core permit.
    async authorizeInitialize() {},
    async authorizeResolveWait() {},
    async authorizeDispatchPermit() {},
  });
  const authorizeSource: CapabilityHandler = async (_value, source) => {
    if (!source.assertAuthorized || !z.uuid().safeParse(source.sourceInstallationId).success) throw new StorageError('forbidden');
    try { await source.assertAuthorized(); }
    catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError(error instanceof RuntimeConnectionError && error.code === 'unauthorized' ? 'forbidden' : 'unavailable');
    }
    const config = await readJson<InstalledConfiguration>(join(root, 'installation.json'));
    const dependency = config.connections.find(item => options.dependencies
      ? item.sourceEnvironmentId === storage.owner.environmentId && item.sourceServiceId === storage.owner.serviceId
        && item.target.environmentId === source.sourceEnvironmentId && item.target.serviceId === source.sourceServiceId
        && item.requiredCapabilities.includes(agentDependenciesCapability)
      : item.connectionId === dependencyConnectionId);
    if (!dependency || !dependency.requiredCapabilities.includes(agentDependenciesCapability)
      || dependency.target.environmentId !== source.sourceEnvironmentId || dependency.target.serviceId !== source.sourceServiceId)
      throw new StorageError('forbidden');
  };
  const chunks = createChunkChannel(storage);
  const chunked = chunks.wrap(async value => {
    try {
      if ((value as { version?: unknown })?.version !== 2) throw new StorageError('incompatible');
      return await service(value);
    } catch (error) { return { error: error instanceof StorageError ? error.code : 'invalid' }; }
  }, { readOnly: isAgentSessionRead,
    successor: async (from, to) => !!from.sourceInstallationId && !!to.sourceInstallationId
      && isRecoverySuccessor(root, { ...from, sourceInstallationId: from.sourceInstallationId }, to.sourceInstallationId),
    async authorize(value, source) {
      if ((value as { version?: unknown })?.version !== 2) throw new StorageError('incompatible');
      const call = agentSessionCallSchema.safeParse(value);
      if (!call.success) throw new StorageError('invalid');
      await authorizeSource(value, source);
      if (options.dependencies) {
        // Multiple connected schools never grant authority over one another's sessions.
        const described = await dependencies.source.describe(call.data.identity);
        if (described.learningTarget.environmentId !== source.sourceEnvironmentId
          || described.learningTarget.serviceId !== source.sourceServiceId) throw new StorageError('forbidden');
      }
      const scope = admissions.getStore();
      if (scope) scope.reusable = canReuseAdmission(call.data.operation);
      await authorizeSession(call.data.identity, call.data.sessionId);
    },
  });
  const handler: CapabilityHandler = async (value, source) => {
    // Only operations that cannot wake execution may reuse admission. In particular,
    // accept/continue/respond cannot lend their authorization to a child task even
    // before their response has finished. Actual dispatch callbacks enter afresh.
    const scope = { active: true, reusable: false };
    return admissions.run(scope, async () => {
      try { await authorizeSource(value, source); return await chunked(value, source); }
      catch (error) { return { error: error instanceof StorageError ? error.code : 'invalid' }; }
      finally { scope.active = false; }
    });
  };
  const owner = createStorageRecoveryOwner({ storage, binding, migrations: agentServiceMigrations,
    resources: configuration.resources, resourceRoots: [join(root, 'learning-resources', 'teaching-agent')],
    installationId: environment.installationId, validateService: validateAgentServiceStorage, sources: collectAgentServiceSources,
    boundary: collectAgentRuntimeBoundary, receiverBoundary: collectAgentRuntimeReceiverBoundary });
  const participant = owner.participant;
  // Only the host's maintenance coordinator resumes this lifecycle. During a
  // successful takeover its durable phase is still `activating`; consulting the
  // request read gate here would leave the Agent closed after activation.
  async function resume() { if (options.enabled !== false) await agent.resume(); }
  return {
    agent,
    owners: [{ ...owner, participant: { ...participant,
      async closeWrites() { agent.closeWrites(); await participant.closeWrites(); },
      async closeDispatch() { agent.closeDispatch(); await participant.closeDispatch(); },
      async drain() { await agent.drain(); await participant.drain(); },
      async resume() { await participant.resume(); await resume(); },
    } }],
    lifecycle: { async pause() { agent.closeDispatch(); }, resume, async close() { await agent.close(); } },
    serviceCapabilities: (options.enabled === false ? {} : { [storage.owner.serviceId]: { [agentSessionsCapability]: handler } }) as Record<string, Record<string, CapabilityHandler>>,
    async facts() {
      if (options.enabled === false || options.dependencies) return [];
      const current = await readJson<InstalledConfiguration>(join(root, 'installation.json'));
      return current.connections.some(item => item.connectionId === dependencyConnectionId && item.requiredCapabilities.includes(agentDependenciesCapability)) ? []
        : [{ name: 'agent-dependencies', required: false, state: 'unavailable' as const, detail: 'agent-dependencies-not-configured' }];
    },
    async handle() { return false; },
    // The product host calls lifecycle.resume only after reopening storage participants.
    async start() {},
  };
}
