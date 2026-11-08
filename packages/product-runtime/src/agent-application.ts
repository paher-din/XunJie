import { join } from 'node:path';
import { StorageError, type OwnedStorage, type StorageBinding } from '@xunjie/storage';
import { createTeachingAgent, createTeachingAgentService, createTeachingDependencyClient,
  createLearningModelClient, teachingAgentMigrations, createTeachingDependencyBinding, createChunkChannel, collectTeachingBoundary, collectTeachingReceiverBoundary } from '@xunjie/learning-space';
import type { TeachingDispatchAuthority } from '@xunjie/learning-space';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { RuntimeEnvironment } from '@xunjie/contracts/product-runtime';
import type { InstalledConfiguration } from './runtime.js';
import { createStorageRecoveryOwner } from './storage-recovery.js';
import { createAgentConnection } from './agent-connections.js';
import { readJson } from './io.js';
import type { CapabilityHandler } from './connections.js';
import { RuntimeConnectionError } from './connections.js';
import { isRecoverySuccessor } from './recovery-successions.js';
import { teachingAgentCallSchema, teachingDependencyCallSchema } from '@xunjie/contracts/teaching-agent';

/** The standalone composition owns Agent facts only; dependencies stay with their actual owners. */
export function createStandaloneAgentApplication(options: {
  root: string; environment: RuntimeEnvironment; configuration: InstalledConfiguration; readOnly(): Promise<boolean>;
  storage: OwnedStorage; binding: StorageBinding;
}) {
  const { root, environment, configuration, storage, binding } = options;
  const authority = new AsyncLocalStorage<TeachingDispatchAuthority>();
  const activityContext = new AsyncLocalStorage<string | undefined>();
  const bindDependency = createTeachingDependencyBinding(storage);
  const dependencyConnectionId = configuration.agent?.dependencyConnectionId;
  const connection = dependencyConnectionId ? createAgentConnection(root, dependencyConnectionId, 'teaching.dependencies') : undefined;
  const invoke = async (payload: unknown) => {
    const config = await readJson<InstalledConfiguration>(join(root, 'installation.json'));
    const descriptor = config.connections.find(item => item.connectionId === dependencyConnectionId);
    if (!connection || !descriptor) throw new StorageError('unavailable');
    await bindDependency(descriptor);
    const input = teachingDependencyCallSchema.parse(payload);
    const dispatch = input.authority ?? authority.getStore();
    const activityId = dispatch?.activityId ?? activityContext.getStore() ?? input.activityId;
    return connection({ ...input, ...(dispatch ? { authority: dispatch } : {}), ...(activityId ? { activityId } : {}) });
  };
  const dependencies = createTeachingDependencyClient(invoke);
  const models = createLearningModelClient(request => invoke({ version: 1, operation: 'model', identity: request.identity,
    ...(authority.getStore() ? { authority: authority.getStore() } : {}), args: [request] }));
  const teaching = createTeachingAgent(storage, { ...dependencies, models, start: false,
    withAuthority: (value, work) => authority.run(value, work) });
  const service = createTeachingAgentService(teaching, async (identity, activityId) => {
    if (activityId) await dependencies.authorizeActivity(identity, activityId);
    else await dependencies.authorize(identity);
  });
  const chunks = createChunkChannel(storage);
  const chunked = chunks.wrap(async value => {
    try {
      const input = teachingAgentCallSchema.parse(value);
      return await activityContext.run(input.activityId, () => service(input));
    }
    catch (error) { return { error: error instanceof StorageError ? error.code : 'invalid' }; }
  }, { readOnly: value => teachingAgentCallSchema.parse(value).operation === 'conversation',
  successor: async (from, to) => !!from.sourceInstallationId && !!to.sourceInstallationId
    && isRecoverySuccessor(root, { ...from, sourceInstallationId: from.sourceInstallationId }, to.sourceInstallationId),
  authorize: async (value, source) => {
    try { await source.assertAuthorized?.(); }
    catch (error) { throw new StorageError(error instanceof RuntimeConnectionError && error.code === 'unauthorized' ? 'forbidden' : 'unavailable'); }
    const input = teachingAgentCallSchema.parse(value);
    if (input.activityId) await dependencies.authorizeActivity(input.identity, input.activityId);
    else await dependencies.authorize(input.identity);
  } });
  const handler: CapabilityHandler = async (value, source) => {
    try {
      const config = await readJson<InstalledConfiguration>(join(root, 'installation.json'));
      const dependency = config.connections.find(connection => connection.connectionId === config.agent?.dependencyConnectionId);
      if (!dependency || dependency.target.environmentId !== source.sourceEnvironmentId || dependency.target.serviceId !== source.sourceServiceId)
        throw new StorageError('forbidden');
      return await chunked(value, source);
    } catch (error) { return { error: error instanceof StorageError ? error.code : 'invalid' }; }
  };
  const owner = createStorageRecoveryOwner({ storage, binding, migrations: teachingAgentMigrations,
    resources: configuration.resources, resourceRoots: [join(root, 'learning-resources', 'teaching-agent')],
    installationId: environment.installationId, validateService: teaching.validate, boundary: collectTeachingBoundary, receiverBoundary: collectTeachingReceiverBoundary });
  const participant = owner.participant;
  return {
    owners: [{ ...owner, participant: { ...participant,
      async closeWrites() { teaching.closeWrites(); await participant.closeWrites(); },
      async closeDispatch() { teaching.closeDispatch(); await participant.closeDispatch(); },
      async drain() { await teaching.drain(); await participant.drain(); },
      async resume() { await participant.resume(); teaching.resume(); },
    } }],
    serviceCapabilities: { [storage.owner.serviceId]: { 'teaching.agent': handler } },
    async facts() {
      const current = await readJson<InstalledConfiguration>(join(root, 'installation.json'));
      return current.connections.some(item => item.connectionId === dependencyConnectionId) ? [] : [{ name: 'agent-dependencies', required: false,
        state: 'unavailable' as const, detail: 'agent-dependencies-not-configured' }];
    },
    async handle() { return false; },
    async start() { if (!await options.readOnly()) teaching.resume(); },
  };
}
