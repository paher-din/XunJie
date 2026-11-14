import { createHash } from 'node:crypto';
import { StorageError, type Migration, type OwnedStorage } from '@xunjie/storage';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import { teachingAgentBindingInputSchema, teachingAgentBindingSchema, type TeachingAgentBinding } from '@xunjie/contracts/teaching-agent';
import { agentSessionsCapability } from '@xunjie/contracts/agent-service';

export const memberAgentBindingMigration: Migration = { version: 10, name: 'member-agent-service-bindings', sql: `
  CREATE TABLE member_agent_bindings(space_id uuid NOT NULL,principal_id uuid NOT NULL,body jsonb NOT NULL,
    PRIMARY KEY(space_id,principal_id),FOREIGN KEY(space_id,principal_id) REFERENCES memberships(space_id,principal_id));
` };

export function createMemberAgentBindings(storage: OwnedStorage, authorize: (identity: SpaceIdentity) => Promise<void>) {
  async function read(identity: SpaceIdentity): Promise<TeachingAgentBinding | null> {
    await authorize(identity);
    const { rows: [row] } = await storage.read('SELECT body FROM member_agent_bindings WHERE space_id=$1 AND principal_id=$2',
      [identity.spaceId, identity.principalId]);
    return row ? teachingAgentBindingSchema.parse(row.body) : null;
  }
  return { read,
    async bind(value: unknown) {
      const input = teachingAgentBindingInputSchema.parse(value);
      if (!input.target.capabilities.includes(agentSessionsCapability)) throw new StorageError('incompatible');
      await authorize(input.identity);
      const binding = teachingAgentBindingSchema.parse({ version: 1, connectionId: input.connectionId,
        target: input.target, installationId: input.installationId,
        ...(input.delivery ? { delivery: input.delivery } : {}), ...(input.grantId ? { grantId: input.grantId } : {}),
        ...(input.executionGrantId ? { executionGrantId: input.executionGrantId } : {}),
        ...(input.deviceModules ? { deviceModules: input.deviceModules } : {}) });
      const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      const receipt = await storage.request({ requestId: 'member-agent-binding:'+input.requestId, fingerprint }, async tx => {
        await tx.query(`INSERT INTO member_agent_bindings VALUES($1,$2,$3)
          ON CONFLICT(space_id,principal_id) DO UPDATE SET body=EXCLUDED.body`, [input.identity.spaceId, input.identity.principalId, binding]);
        return binding;
      });
      return teachingAgentBindingSchema.parse(receipt.result);
    },
    async authorizeSource(identity: SpaceIdentity, source: { sourceEnvironmentId: string; sourceServiceId: string; sourceInstallationId?: string }) {
      const binding = await read(identity);
      if (!binding || binding.target.environmentId !== source.sourceEnvironmentId || binding.target.serviceId !== source.sourceServiceId
        || binding.installationId !== source.sourceInstallationId) throw new StorageError('forbidden');
    },
    async validate() {
      const { rows } = await storage.read('SELECT body FROM member_agent_bindings');
      rows.forEach(row => teachingAgentBindingSchema.parse(row.body));
    },
  };
}
