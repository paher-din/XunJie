import { z } from 'zod';
import { StorageError } from '@xunjie/storage';
import { modelAttemptSchema } from '@xunjie/contracts/model-connections';

type ModelAttempt = z.infer<typeof modelAttemptSchema>;

/** A school model service is optional; its unavailable check history must not break local checks. */
export async function mergeOptionalSchoolChecks(
  own: ModelAttempt[],
  readRemote: () => Promise<unknown>,
): Promise<ModelAttempt[]> {
  let remote: ModelAttempt[] = [];
  try { remote = z.array(modelAttemptSchema).parse(await readRemote()); }
  catch (error) {
    if (!(error instanceof StorageError) || error.code !== 'unavailable') throw error;
  }
  return [...own, ...remote].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50);
}
