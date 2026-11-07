import { StorageError } from '@xunjie/storage';
import type { createModelGateway, createPairedLearningModels, PairedLearningOptions } from '@xunjie/learning-space';
import type { RuntimeService } from '@xunjie/contracts/product-runtime';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import { recoveryPredecessors } from './recovery-successions.js';
import { createConnectionAuthority, RuntimeConnectionError } from './connections.js';

/** Root's default host owns learning.authority grants; the Agent dependency authority is a
 * different service and cannot establish a model recipient's current WP01 qualification.
 */
export function createModelRecipientRecovery(root: string, service: RuntimeService,
  authorizeConnection: (identity: SpaceIdentity, connectionId: string) => Promise<void>): NonNullable<PairedLearningOptions['recipientSuccessions']> {
  const authority = createConnectionAuthority({ root, service: { ...service, capabilities: ['learning.authority'] } });
  return async (identity, original, current) => {
    if (original.owner.environmentId !== current.owner.environmentId || original.owner.serviceId !== current.owner.serviceId
      || original.installationId === current.installationId) return null;
    const predecessors = await recoveryPredecessors(root, current.owner, current.installationId);
    const start = predecessors.findIndex(fact => fact.sourceInstallationId === original.installationId);
    if (start < 0) return null;
    await authorizeConnection(identity, current.connectionId);
    try {
      await authority.assertSourceAuthorized({ sourceEnvironmentId: current.owner.environmentId, sourceServiceId: current.owner.serviceId,
        sourceInstallationId: current.installationId, grantId: current.grantId }, 'learning.authority');
    } catch (error) {
      if (error instanceof RuntimeConnectionError && error.code === 'unauthorized') throw new StorageError('forbidden');
      throw error;
    }
    return predecessors.slice(start);
  };
}

/** Add host-held recovery evidence only after the durable task and its current origin passed
 * the normal member/device/WP01/Agent route checks. The model owner retains this evidence.
 */
export function withModelOriginRecovery(root: string, paired: ReturnType<typeof createPairedLearningModels>,
  models: Awaited<ReturnType<typeof createModelGateway>>) {
  return { ...paired,
    async authorizeTask(...args: Parameters<typeof paired.authorizeTask>) {
      const permit = await paired.authorizeTask(...args);
      const { task } = await models.deviceTasks.read(...args);
      if (task.operation !== 'learning' || task.formatVersion !== 2) throw new StorageError('forbidden');
      return { ...permit, successions: await recoveryPredecessors(root, task.origin.service, task.origin.installationId) };
    },
  };
}
