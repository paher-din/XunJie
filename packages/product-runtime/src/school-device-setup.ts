import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { StorageError } from '@xunjie/storage';
import { runtimeServiceSchema } from '@xunjie/contracts/product-runtime';
import type { RuntimeService } from '@xunjie/contracts/product-runtime';
import { spaceIdentitySchema } from '@xunjie/contracts/spaces';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import type { createSpaces, createMemberAgentBindings } from '@xunjie/learning-space';
import { acquireLock, atomicJson, exists, readJson } from './io.js';
import type { createConnectionAuthority } from './connections.js';

export const schoolDeviceSetupInputSchema = z.object({ connectionId: z.uuid(), installationId: z.uuid(),
  deviceModules: z.array(runtimeServiceSchema).min(4).max(5),
}).strict();
const credentialSchema = z.object({ grantId: z.uuid(), token: z.string() }).strict();
export const schoolDeviceSetupResultSchema = z.object({ version: z.literal(1), connectionId: z.uuid(),
  identity: spaceIdentitySchema, target: runtimeServiceSchema,
  agent: credentialSchema, execution: credentialSchema,
}).strict();
const sameIdentity = (a: SpaceIdentity, b: SpaceIdentity) => a.environmentId === b.environmentId
  && a.spaceId === b.spaceId && a.principalId === b.principalId;
const freshCredential = () => { const grantId = randomUUID(); return { grantId, token: grantId+'.'+randomBytes(32).toString('hex') }; };

/** Only an authenticated, approved member connection can provision its own outbound device services. */
export function createSchoolDeviceSetup(options: { root: string; target: RuntimeService;
  spaces: ReturnType<typeof createSpaces>; bindings: ReturnType<typeof createMemberAgentBindings>;
  authority: ReturnType<typeof createConnectionAuthority>; assertWritable(): Promise<void>;
}) {
  const { root, spaces, bindings, authority, target } = options;
  return async (identity: SpaceIdentity, value: unknown) => {
    const input = schoolDeviceSetupInputSchema.parse(value);
    await options.assertWritable();
    await spaces.authorizeConnection(identity, input.connectionId);
    const modules = input.deviceModules;
    const agent = modules.find(item => item.unit === 'teaching-agent'), execution = modules.find(item => item.unit === 'tool-execution');
    if (!agent || !execution || !modules.some(item => item.unit === 'space-course') || !modules.some(item => item.unit === 'model-connection')
      || new Set(modules.map(item => item.unit)).size !== modules.length || new Set(modules.map(item => item.serviceId)).size !== modules.length
      || modules.some(item => item.unit === 'client' || item.environmentId !== agent.environmentId)
      || agent.environmentId === target.environmentId) throw new StorageError('invalid');
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
      const fingerprint = createHash('sha256').update(JSON.stringify({ identity, input })).digest('hex');
      const path = join(root, 'credentials', 'school-device-setup-'+input.connectionId);
      type Journal = { fingerprint: string; bindingRequestId: string; result: z.infer<typeof schoolDeviceSetupResultSchema> };
      let journal: Journal;
      if (await exists(path)) {
        journal = await readJson<Journal>(path);
        if (journal.fingerprint !== fingerprint || !sameIdentity(journal.result.identity, identity)) throw new StorageError('identity-conflict');
        schoolDeviceSetupResultSchema.parse(journal.result);
      } else {
        journal = { fingerprint, bindingRequestId: randomUUID(), result: { version: 1, connectionId: input.connectionId, identity,
          target, agent: freshCredential(), execution: freshCredential() } };
        // Reserve both credentials before issuing either grant, so all crash/retry windows use the same identities.
        await atomicJson(path, journal);
      }
      for (const [source, credential] of [[agent, journal.result.agent], [execution, journal.result.execution]] as const) {
        await authority.authorize({ sourceEnvironmentId: source.environmentId, sourceServiceId: source.serviceId,
          sourceInstallationId: input.installationId, capabilities: ['teaching.dependencies'] }, credential);
        await atomicJson(join(root, 'credentials', 'school-device-grant-'+credential.grantId), { identity, connectionId: input.connectionId });
      }
      await options.assertWritable();
      await spaces.authorizeConnection(identity, input.connectionId);
      await bindings.bind({ requestId: journal.bindingRequestId, identity, connectionId: input.connectionId,
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
