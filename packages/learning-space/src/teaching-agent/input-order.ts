import type { OwnedStorage } from '@xunjie/storage';

/** Short owner metadata commits share one order; no external operation runs while this lock is held. */
export function orderTeachingWrites(storage: OwnedStorage): OwnedStorage {
  const key = 'teaching-input-order:' + storage.owner.environmentId + ':' + storage.owner.serviceId;
  return { ...storage,
    get owner() { return storage.owner; }, get generation() { return storage.generation; },
    get resourceLocation() { return storage.resourceLocation; },
    request: (input, effect) => storage.request(input, async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
      return effect(tx);
    }),
  };
}
