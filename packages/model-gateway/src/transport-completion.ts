import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import type { ModelAttempt } from '@xunjie/contracts/model-connections';

type Update = (identity: SpaceIdentity, attemptId: string, change: (body: ModelAttempt) => ModelAttempt) => Promise<unknown>;

export function createTransportCompletion(update: Update, hasEnded: (identity: SpaceIdentity, attemptId: string) => Promise<boolean>) {
  const pending = new Map<string, SpaceIdentity>();
  return {
    ended(identity: SpaceIdentity, attemptId: string) { pending.set(attemptId, identity); },
    async reconcile() {
      for (const [attemptId, identity] of pending) {
        if (!await hasEnded(identity, attemptId)) await update(identity, attemptId, body => body.physicalRequestEnded ? body : {
          ...body, physicalRequestEnded: true, state: body.cancelRequested ? 'cancelled' : 'unknown',
          reason: 'transport-ended-without-result',
        });
        pending.delete(attemptId);
      }
    },
  };
}
