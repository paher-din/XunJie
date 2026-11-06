import type { OwnedTransaction } from '@xunjie/storage';
import { spaceIdentitySchema } from '@xunjie/contracts/spaces';

/** Every new logical Run fixes its initial state and budget in the same intake transaction. */
export async function insertTeachingRun(tx: OwnedTransaction, seed: {
  runId: string; activityId: string; requestId: string; inputId: string; identity: unknown; previousRunId: string | null;
}, freezeBudget: (tx: OwnedTransaction, runId: string) => Promise<void>) {
  const identity = spaceIdentitySchema.parse(seed.identity);
  await tx.query(`INSERT INTO teaching_runs(run_id,activity_id,request_id,input_id,identity,state,previous_run_id,usage)
    VALUES($1,$2,$3,$4,$5,'received',$6,$7)`, [seed.runId, seed.activityId, seed.requestId, seed.inputId,
    JSON.stringify(identity), seed.previousRunId, JSON.stringify({ state: 'unknown' })]);
  await freezeBudget(tx, seed.runId);
}
