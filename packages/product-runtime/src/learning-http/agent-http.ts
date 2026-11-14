import { StorageError } from '@xunjie/storage';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';

/** Retired product paths never translate into a call to the old execution engine. */
export function teachingAgentHttpCall(_identity: SpaceIdentity, _route: string, _method: string,
  _body?: unknown, _search = ''): never {
  throw new StorageError('incompatible');
}
