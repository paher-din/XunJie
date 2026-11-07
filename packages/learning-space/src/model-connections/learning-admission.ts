import { z } from 'zod';
import { StorageError, type Migration, type OwnedTransaction, type OwnedStorage } from '@xunjie/storage';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import type { ModelAttempt, ModelUsage } from '@xunjie/contracts/model-connections';

/** Budget units are input + output tokens, not currency. Cache/reasoning
 * detail is already included in the provider's input/output totals; never add it twice.
 * Reservations use UTF-8 request bytes + framing allowance + max output, so an
 * unavailable tokenizer does not silently reserve zero input. Unknown charges never age out.
 */
export const learningAdmissionPolicySchema = z.object({
  version: z.string().min(1).max(100),
  feeBudgetTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  feeWindowMs: z.number().int().min(1000).max(31 * 86400000),
  maxPhysical: z.number().int().min(1).max(1024),
  maxFeeSourcePhysical: z.number().int().min(1).max(1024),
  maxPrincipalPhysical: z.number().int().min(1).max(1024),
}).strict();
export type LearningAdmissionPolicy = z.infer<typeof learningAdmissionPolicySchema>;
/** Explicit finite baseline for production learning, independent of probe and Run limits. */
export const defaultLearningAdmissionPolicy: Readonly<LearningAdmissionPolicy> = Object.freeze({
  version: 'learning-token-budget-v1', feeBudgetTokens: 10_000_000, feeWindowMs: 86400000,
  maxPhysical: 8, maxFeeSourcePhysical: 4, maxPrincipalPhysical: 1,
});
export const learningAdmissionMigration: Migration = { version: 19, name: 'learning-shared-admission', sql: `
  CREATE TABLE model_learning_policies(version text PRIMARY KEY,body jsonb NOT NULL);
  CREATE TABLE model_learning_admissions(
    attempt_id uuid PRIMARY KEY REFERENCES model_attempts(id),queue_sequence bigserial UNIQUE NOT NULL,
    fee_source text NOT NULL,principal text NOT NULL,policy jsonb NOT NULL,
    reserved_units bigint NOT NULL CHECK(reserved_units>0),ready boolean NOT NULL DEFAULT false,ticket_id uuid,
    charged_at timestamptz,settled_units bigint CHECK(settled_units>=0),physical_held boolean NOT NULL DEFAULT false,
    upstream_ended boolean NOT NULL DEFAULT false,
    settlement text NOT NULL DEFAULT 'queued' CHECK(settlement IN ('queued','reserved','unknown','final','not-sent')),
    wait_reason text,settled_at timestamptz,
    CHECK((settlement='final')=(settled_units IS NOT NULL)));
  CREATE INDEX model_learning_fee_charges ON model_learning_admissions(fee_source,charged_at);
  CREATE INDEX model_learning_held ON model_learning_admissions(principal,fee_source) WHERE physical_held;
  INSERT INTO model_learning_policies VALUES('learning-token-budget-v1','${JSON.stringify(defaultLearningAdmissionPolicy)}'::jsonb);
  -- Existing attempts retain original identity and conservative reservations. A legacy
  -- local-ended flag alone cannot establish upstream end after abort/crash.
  INSERT INTO model_learning_admissions(attempt_id,fee_source,principal,policy,reserved_units,ready,
    charged_at,settled_units,physical_held,upstream_ended,settlement,settled_at)
  SELECT id,COALESCE(body->'source'->>'feeSource',scope),split_part(scope,'.',1)||'.'||split_part(scope,'.',3),
    '${JSON.stringify(defaultLearningAdmissionPolicy)}'::jsonb,
    GREATEST(COALESCE((body->'connection'->>'contextWindow')::bigint,1048576),1048576)
      +COALESCE((body->'limits'->>'maxOutputTokens')::bigint,1048576)+4096,
    false,CASE WHEN (body->>'dispatched')::boolean THEN created_at END,
    CASE WHEN body->'usage'->>'state'='final' AND body->'usage' ? 'inputTokens' AND body->'usage' ? 'outputTokens'
      THEN GREATEST((body->'usage'->>'inputTokens')::bigint+(body->'usage'->>'outputTokens')::bigint,
        COALESCE((body->'usage'->>'totalTokens')::bigint,0)) END,
    (body->>'dispatched')::boolean AND NOT (state='completed' OR body->'usage'->>'state'='final'),
    state='completed' OR body->'usage'->>'state'='final',
    CASE WHEN NOT (body->>'dispatched')::boolean THEN 'queued'
      WHEN body->'usage'->>'state'='final' AND body->'usage' ? 'inputTokens' AND body->'usage' ? 'outputTokens' THEN 'final'
      ELSE 'unknown' END,
    CASE WHEN (body->>'dispatched')::boolean THEN created_at END
  FROM model_attempts WHERE body->>'purpose'='learning' ORDER BY created_at,id;

` };
const principalOf = (identity: SpaceIdentity) => identity.environmentId + '.' + identity.principalId;
export const lockLearningAdmission = (tx: OwnedTransaction) =>
  tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['model-physical-slots']);
export function learningReservationUnits(payload: unknown, maxOutputTokens: number) {
  const units = Buffer.byteLength(JSON.stringify(payload), 'utf8') + 4096 + maxOutputTokens;
  if (!Number.isSafeInteger(units) || units <= 0) throw new StorageError('invalid');
  return units;
}
export function learningFinalUnits(usage: ModelUsage): number | null {
  if (usage.state !== 'final') return null;
  // Partial counters, even carrying a mistaken final label, cannot authorize a refund.
  if (usage.inputTokens === undefined || usage.outputTokens === undefined) return null;
  const units = Math.max(usage.inputTokens + usage.outputTokens, usage.totalTokens ?? 0);
  return Number.isSafeInteger(units) && units >= 0 ? units : null;
}

type AdmissionRow = Record<string, unknown> & {
  attempt_id: string; fee_source: string; principal: string; policy: LearningAdmissionPolicy;
  reserved_units: string; charged_at: Date | null; settled_units: string | null;
  physical_held: boolean; upstream_ended: boolean; settlement: string; ready: boolean; ticket_id: string | null;
};
export function createLearningAdmission(storage: OwnedStorage, configured?: LearningAdmissionPolicy) {
  const policy = learningAdmissionPolicySchema.parse(configured ?? defaultLearningAdmissionPolicy);
  async function enqueue(tx: OwnedTransaction, identity: SpaceIdentity, body: ModelAttempt, payload: unknown) {
    if (body.purpose !== 'learning') return;
    if (!body.source?.feeSource) throw new StorageError('invalid');
    await tx.query('INSERT INTO model_learning_policies(version,body) VALUES($1,$2) ON CONFLICT DO NOTHING', [policy.version, policy]);
    const { rows: [saved] } = await tx.query('SELECT body FROM model_learning_policies WHERE version=$1', [policy.version]);
    if (JSON.stringify(learningAdmissionPolicySchema.parse(saved!.body)) !== JSON.stringify(policy)) throw new StorageError('conflict');
    await tx.query(`INSERT INTO model_learning_admissions(attempt_id,fee_source,principal,policy,reserved_units)
      VALUES($1,$2,$3,$4,$5)`, [body.attemptId, body.source.feeSource, principalOf(identity), policy,
      learningReservationUnits(payload, body.limits.maxOutputTokens)]);
  }
  const scopeOf = (identity: SpaceIdentity) => [identity.environmentId, identity.spaceId, identity.principalId].join('.');
  /** Metadata-only lookup before authorization: a failed retry must be able to
   * withdraw its previous waiting ticket without exposing the accepted input. */
  async function currentTicket(identity: SpaceIdentity, attemptId: string): Promise<string | null> {
    const { rows: [row] } = await storage.read(`SELECT a.ticket_id FROM model_learning_admissions a
      JOIN model_attempts m ON m.id=a.attempt_id WHERE m.id=$1 AND m.scope=$2 AND m.state='accepted'
      AND a.ready AND a.charged_at IS NULL`, [attemptId, scopeOf(identity)]);
    return row?.ticket_id as string | null ?? null;
  }
  /** Caller holds the common admission lock BEFORE locking the attempt row. A
   * ticket joins the original receipt order before the potentially slow preflight.
   * Its identity prevents an older failed invocation withdrawing a newer retry. */
  async function ready(tx: OwnedTransaction, identity: SpaceIdentity, attemptId: string, ticketId: string) {
    const { rows: [row] } = await tx.query(`SELECT state FROM model_attempts WHERE id=$1 AND scope=$2
      AND body->>'purpose'='learning' FOR UPDATE`, [attemptId, scopeOf(identity)]);
    if (!row || row.state !== 'accepted') return false;
    const result = await tx.query(`UPDATE model_learning_admissions SET ready=true,ticket_id=$2
      WHERE attempt_id=$1 AND charged_at IS NULL`, [attemptId, ticketId]);
    if (result.rowCount !== 1) throw new StorageError('corrupt');
    return true;
  }
  async function withdraw(tx: OwnedTransaction, identity: SpaceIdentity, attemptId: string, ticketId: string) {
    const { rows: [row] } = await tx.query(`SELECT state FROM model_attempts WHERE id=$1 AND scope=$2 FOR UPDATE`,
      [attemptId, scopeOf(identity)]);
    if (!row || row.state !== 'accepted') return;
    await tx.query(`UPDATE model_learning_admissions SET ready=false,ticket_id=NULL,wait_reason=NULL
      WHERE attempt_id=$1 AND charged_at IS NULL AND ticket_id=$2`, [attemptId, ticketId]);
  }
  async function claim(tx: OwnedTransaction, body: ModelAttempt, ticketId: string, reservationUnits?: number): Promise<string | null> {
    const { rows: [own] } = await tx.query<AdmissionRow>('SELECT * FROM model_learning_admissions WHERE attempt_id=$1', [body.attemptId]);
    // Old accepted attempts must not bypass newly introduced accounting. They have no reservation.
    if (!own) return 'learning-policy-migration-required';
    if (own.charged_at) throw new StorageError('corrupt');
    if (!own.ready || own.ticket_id !== ticketId) return 'learning-preflight-superseded';
    if (reservationUnits !== undefined) own.reserved_units = String(reservationUnits);
    await tx.query('UPDATE model_learning_admissions SET reserved_units=$2 WHERE attempt_id=$1', [body.attemptId, own.reserved_units]);
    const { rows: [clock] } = await tx.query('SELECT clock_timestamp() AS now');
    const now = new Date(clock!.now as string).getTime();
    const { rows: charges } = await tx.query<AdmissionRow>('SELECT * FROM model_learning_admissions WHERE charged_at IS NOT NULL');
    const { rows: waiting } = await tx.query<AdmissionRow>(`SELECT a.* FROM model_learning_admissions a
      JOIN model_attempts m ON m.id=a.attempt_id WHERE a.ready AND a.charged_at IS NULL AND m.state='accepted'
      ORDER BY a.queue_sequence`);
    function eligibility(item: AdmissionRow) {
      const rules = learningAdmissionPolicySchema.parse(item.policy);
      const physical = charges.filter(row => row.physical_held);
      if (physical.filter(row => row.principal === item.principal).length >= rules.maxPrincipalPhysical) return 'learning-principal-concurrency';
      if (physical.filter(row => row.fee_source === item.fee_source).length >= rules.maxFeeSourcePhysical) return 'learning-fee-source-concurrency';
      if (physical.length >= rules.maxPhysical) return 'learning-physical-capacity';
      const used = charges.filter(row => row.fee_source === item.fee_source && row.settlement !== 'not-sent'
        && (row.settled_units === null || new Date(row.charged_at!).getTime() >= now - rules.feeWindowMs))
        .reduce((sum, row) => sum + BigInt(row.settled_units ?? row.reserved_units), 0n);
      if (BigInt(item.reserved_units) > BigInt(rules.feeBudgetTokens)) return 'learning-request-exceeds-budget';
      return used + BigInt(item.reserved_units) > BigInt(rules.feeBudgetTokens) ? 'learning-fee-budget' : null;
    }
    const reason = eligibility(own);
    // All requested dispatches join before preflight, retaining original receipt
    // order. Unrequested/failed preflights and blocked principals cannot hide eligible work.
    const first = reason === null ? waiting.find(item => eligibility(item) === null) : undefined;
    const waitingReason = reason ?? (first?.attempt_id !== body.attemptId ? 'learning-fair-queue' : null);
    if (waitingReason) {
      await tx.query('UPDATE model_learning_admissions SET wait_reason=$2 WHERE attempt_id=$1', [body.attemptId, waitingReason]);
      return waitingReason;
    }
    await tx.query(`UPDATE model_learning_admissions SET charged_at=clock_timestamp(),physical_held=true,
      settlement='reserved',upstream_ended=false,wait_reason=NULL WHERE attempt_id=$1`, [body.attemptId]);
    return null;
  }
  /** Same transaction as the immutable attempt result. Logical cancellation alone never refunds/releases. */
  async function settle(tx: OwnedTransaction, body: ModelAttempt, evidence: { notSent?: boolean; upstreamEnded?: boolean } = {}) {
    if (body.purpose !== 'learning') return;
    const { rows: [row] } = await tx.query<AdmissionRow>('SELECT * FROM model_learning_admissions WHERE attempt_id=$1 FOR UPDATE', [body.attemptId]);
    if (!row) return; // Historical terminal attempts predate admission accounting.
    if (!row.charged_at) {
      if (body.state !== 'accepted') await tx.query('UPDATE model_learning_admissions SET ready=false,wait_reason=NULL WHERE attempt_id=$1', [body.attemptId]);
      return;
    }
    if (row.settlement === 'final' || row.settlement === 'not-sent') return;
    const units = learningFinalUnits(body.usage);
    const notSent = evidence.notSent === true && !body.dispatched;
    await tx.query(`UPDATE model_learning_admissions SET settlement=$2,settled_units=$3,
      physical_held=CASE WHEN $4 THEN false ELSE physical_held END,
      upstream_ended=upstream_ended OR $4,settled_at=clock_timestamp() WHERE attempt_id=$1`,
      [body.attemptId, notSent ? 'not-sent' : units === null ? 'unknown' : 'final', notSent ? null : units,
        notSent || evidence.upstreamEnded === true]);
  }
  async function validate() {
    const { rows } = await storage.read(`SELECT a.*,m.body FROM model_learning_admissions a JOIN model_attempts m ON m.id=a.attempt_id`);
    for (const row of rows) {
      learningAdmissionPolicySchema.parse(row.policy);
      const body = row.body as ModelAttempt;
      if (body.purpose !== 'learning' || body.source?.feeSource !== row.fee_source
        || (row.settlement === 'final' && learningFinalUnits(body.usage) !== Number(row.settled_units))
        || (row.physical_held && row.upstream_ended)
        || (row.charged_at && !row.physical_held && !row.upstream_ended)) throw new StorageError('corrupt');
    }
  }
  return { enqueue, currentTicket, ready, withdraw, claim, settle, validate };
}
