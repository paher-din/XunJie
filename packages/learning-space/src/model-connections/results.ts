import { createHash } from 'node:crypto';
import { StorageError, type OwnedStorage } from '@xunjie/storage';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import { modelAttemptSchema, modelPortableResultSchema } from '@xunjie/contracts/model-connections';
import { modelScopeOf } from './selection.js';

/** Only completed, readable, settled public facts are portable. Native reasoning stays at its owner. */
export function createModelResults(storage: OwnedStorage, authorize: (identity: SpaceIdentity) => Promise<void>) {
  async function read(identity: SpaceIdentity, resultRef: string) {
    await authorize(identity); modelPortableResultSchema.shape.resultRef.parse(resultRef);
    const { rows: [row] } = await storage.read("SELECT body FROM model_attempts WHERE scope=$1 AND body->>'resultRef'=$2", [modelScopeOf(identity), resultRef]);
    if (!row) throw new StorageError('missing');
    const fact = modelAttemptSchema.parse(row.body);
    if (fact.state !== 'completed' || !fact.physicalRequestEnded) throw new StorageError('conflict');
    if (fact.toolIntents?.length) {
      const { rows } = await storage.read('SELECT attempt_id FROM model_tool_results WHERE attempt_id=$1 AND scope=$2', [fact.attemptId, modelScopeOf(identity)]);
      if (!rows.length) throw new StorageError('conflict');
    }
    await storage.readResource(resultRef);
    return modelPortableResultSchema.parse({ owner: storage.owner, resultRef, attemptId: fact.attemptId, routeId: fact.connection.routeId,
      configurationVersion: fact.connection.version, text: fact.text, visibleTextSha256: createHash('sha256').update(fact.text).digest('hex') });
  }
  return { read };
}
