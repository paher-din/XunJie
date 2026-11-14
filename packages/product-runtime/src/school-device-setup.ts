import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { StorageError } from '@xunjie/storage';
import { runtimeServiceSchema } from '@xunjie/contracts/product-runtime';
import type { RuntimeService } from '@xunjie/contracts/product-runtime';
import { spaceIdentitySchema } from '@xunjie/contracts/spaces';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import { agentSessionsCapability, sameAgentSubject } from '@xunjie/contracts/agent-service';
import { agentDependenciesCapability } from '@xunjie/contracts/agent-dependencies';
import type { createSpaces, createMemberAgentBindings, createLearningData } from '@xunjie/learning-space';
import { executionRecordEventSchema, type ExecutionRecordEvent } from '@xunjie/contracts/execution-records';
import type { ChunkConnectionSource } from '@xunjie/storage/chunk-channel';
import { isRecoverySuccessor } from './recovery-successions.js';
import { isInstallationRetired } from './retired-installations.js';
import { acquireLock, atomicJson, exists, readJson } from './io.js';
import type { createConnectionAuthority } from './connections.js';

export const schoolDeviceSetupInputSchema = z.object({ version: z.literal(2), connectionId: z.uuid(), installationId: z.uuid(),
  deviceModules: z.array(runtimeServiceSchema).min(4).max(5),
}).strict();
const credentialSchema = z.object({ grantId: z.uuid(), token: z.string() }).strict();
export const schoolDeviceSetupResultSchema = z.object({ version: z.literal(2), connectionId: z.uuid(),
  identity: spaceIdentitySchema, target: runtimeServiceSchema,
  agent: credentialSchema, execution: credentialSchema,
}).strict();
const sameIdentity = sameAgentSubject;
const freshCredential = () => { const grantId = randomUUID(); return { grantId, token: grantId+'.'+randomBytes(32).toString('hex') }; };

export function parseSchoolDeviceSetupInput(value: unknown) {
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 2) throw new StorageError('incompatible');
  const parsed = schoolDeviceSetupInputSchema.safeParse(value);
  if (!parsed.success) throw new StorageError('invalid');
  const agent = parsed.data.deviceModules.find(item => item.unit === 'teaching-agent');
  if (!agent?.capabilities.includes(agentSessionsCapability)) throw new StorageError('incompatible');
  return parsed.data;
}

/** Only an authenticated, approved member connection can provision its own outbound device services. */
export function createSchoolDeviceSetup(options: { root: string; target: RuntimeService;
  spaces: ReturnType<typeof createSpaces>; bindings: ReturnType<typeof createMemberAgentBindings>;
  authority: ReturnType<typeof createConnectionAuthority>; assertWritable(): Promise<void>;
}) {
  const { root, spaces, bindings, authority, target } = options;
  return async (identity: SpaceIdentity, value: unknown) => {
    const input = parseSchoolDeviceSetupInput(value);
    if (!target.capabilities.includes(agentDependenciesCapability)) throw new StorageError('incompatible');
    const modules = input.deviceModules;
    const agent = modules.find(item => item.unit === 'teaching-agent'), execution = modules.find(item => item.unit === 'tool-execution');
    if (!agent || !execution || !modules.some(item => item.unit === 'space-course') || !modules.some(item => item.unit === 'model-connection')
      || new Set(modules.map(item => item.unit)).size !== modules.length || new Set(modules.map(item => item.serviceId)).size !== modules.length
      || modules.some(item => item.unit === 'client' || item.environmentId !== agent.environmentId)
      || agent.environmentId === target.environmentId) throw new StorageError('invalid');
    await options.assertWritable();
    await spaces.authorizeConnection(identity, input.connectionId);
    const actual = await spaces.resolveBinding(identity);
    if (actual.environmentId !== target.environmentId || actual.serviceId !== target.serviceId) throw new StorageError('forbidden');
    const release = await acquireLock(root, 'school-device-'+identity.principalId);
    try {
      await options.assertWritable();
      await spaces.authorizeConnection(identity, input.connectionId);
      const previous = await bindings.read(identity);
      if (previous && (previous.connectionId !== input.connectionId || previous.installationId !== input.installationId
        || previous.target.environmentId !== agent.environmentId || previous.target.serviceId !== agent.serviceId)) {
        let stillApproved = true;
        try { await spaces.authorizeConnection(identity, previous.connectionId); }
        catch (error) {
          if (!(error instanceof StorageError) || error.code !== 'forbidden') throw error;
          // An explicitly disconnected device no longer blocks a new pairing. Activities retain their pinned owners.
          stillApproved = false;
        }
        if (stillApproved) throw new StorageError('identity-conflict');
      }
      const { name: _name, ...subject } = identity;
      const fingerprint = createHash('sha256').update(JSON.stringify({ identity: subject, input })).digest('hex');
      const path = join(root, 'credentials', 'school-device-setup-'+input.connectionId);
      type Journal = { fingerprint: string; bindingRequestId: string; result: z.infer<typeof schoolDeviceSetupResultSchema> };
      let journal: Journal;
      if (await exists(path)) {
        journal = await readJson<Journal>(path);
        if (journal.result.version !== 2 || !journal.result.target.capabilities.includes(agentDependenciesCapability)) throw new StorageError('incompatible');
        if (journal.fingerprint !== fingerprint || !sameIdentity(journal.result.identity, identity)) throw new StorageError('identity-conflict');
        schoolDeviceSetupResultSchema.parse(journal.result);
      } else {
        journal = { fingerprint, bindingRequestId: randomUUID(), result: { version: 2, connectionId: input.connectionId, identity,
          target, agent: freshCredential(), execution: freshCredential() } };
        // Reserve both credentials before issuing either grant, so all crash/retry windows use the same identities.
        await atomicJson(path, journal);
      }
      for (const [source, credential] of [[agent, journal.result.agent], [execution, journal.result.execution]] as const) {
        await authority.authorize({ sourceEnvironmentId: source.environmentId, sourceServiceId: source.serviceId,
          sourceInstallationId: input.installationId, capabilities: [agentDependenciesCapability] }, credential);
        await atomicJson(join(root, 'credentials', 'school-device-grant-'+credential.grantId), { identity, connectionId: input.connectionId });
      }
      await options.assertWritable();
      await spaces.authorizeConnection(identity, input.connectionId);
      await bindings.bind({ requestId: journal.bindingRequestId, identity: journal.result.identity, connectionId: input.connectionId,
        target: agent, installationId: input.installationId,
        delivery: 'client', grantId: journal.result.agent.grantId, executionGrantId: journal.result.execution.grantId, deviceModules: modules });
      return journal.result;
    } finally { await release(); }
  };
}

/** Setup-issued grants stay tied to one member and the connection's current approval. */
export async function authorizeSchoolDeviceGrant(root: string, spaces: ReturnType<typeof createSpaces>, identity: SpaceIdentity, grantId: string) {
  z.uuid().parse(grantId);
  const path = join(root, 'credentials', 'school-device-grant-'+grantId);
  if (!await exists(path)) return; // Explicit administrator grants retain their existing contracts.
  const binding = await readJson<{ identity: SpaceIdentity; connectionId: string }>(path);
  if (!sameIdentity(binding.identity, identity)) throw new StorageError('forbidden');
  await spaces.authorizeConnection(identity, binding.connectionId);
}

/** Original executor facts may outlive an Agent permit and the installation that produced them. */
export type SchoolExecutionRecordSource = (identity: SpaceIdentity, activityId: string, event: Readonly<ExecutionRecordEvent>,
  source: Readonly<ChunkConnectionSource>) => Promise<Parameters<ReturnType<typeof createLearningData>['executionRecords']['sync']>[3]>;
export function createSchoolExecutionRecordSource(options: { root: string;
  spaces: ReturnType<typeof createSpaces>; bindings: ReturnType<typeof createMemberAgentBindings>;
}): SchoolExecutionRecordSource {
  type Trusted = Parameters<ReturnType<typeof createLearningData>['executionRecords']['sync']>[3];
  return async (identity: SpaceIdentity, activityId: string, value: Readonly<ExecutionRecordEvent>,
    source: Readonly<ChunkConnectionSource>): Promise<Trusted> => {
    z.uuid().parse(activityId);
    const event = executionRecordEventSchema.parse(value);
    const assertAuthorized = async () => {
      if (!source.assertAuthorized || !source.sourceInstallationId) throw new StorageError('forbidden');
      await source.assertAuthorized(); await options.spaces.authorize(identity);
      await authorizeSchoolDeviceGrant(options.root, options.spaces, identity, source.grantId);
      const binding = await options.bindings.read(identity);
      const executors = binding?.deviceModules?.filter(item => item.unit === 'tool-execution') ?? [];
      const executor = executors[0];
      if (!binding || binding.delivery !== 'client' || executors.length !== 1 || !executor || !binding.executionGrantId
        || executor.environmentId !== binding.target.environmentId
        || executor.environmentId !== source.sourceEnvironmentId || executor.serviceId !== source.sourceServiceId
        || event.sourceOwner.environmentId !== executor.environmentId || event.sourceOwner.serviceId !== executor.serviceId)
        throw new StorageError('forbidden');
      await options.spaces.authorizeConnection(identity, binding.connectionId);
      if (await isInstallationRetired(options.root, source.sourceInstallationId)) throw new StorageError('forbidden');
      const original = { sourceEnvironmentId: executor.environmentId, sourceServiceId: executor.serviceId,
        sourceInstallationId: binding.installationId };
      if (source.sourceInstallationId === binding.installationId && source.grantId !== binding.executionGrantId
        || !await isRecoverySuccessor(options.root, original, event.installationId)
        || !await isRecoverySuccessor(options.root, { ...original, sourceInstallationId: event.installationId }, source.sourceInstallationId))
        throw new StorageError('forbidden');
    };
    await assertAuthorized();
    return { sourceOwner: event.sourceOwner, installationId: event.installationId,
      role: 'tool-execution', nodeClass: 'device', assertAuthorized };
  };
}
