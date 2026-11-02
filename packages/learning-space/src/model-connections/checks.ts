import { createHash, randomUUID } from 'node:crypto';
import { StorageError, type OwnedStorage, type OwnedTransaction } from '@xunjie/storage';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import { modelAttemptSchema, modelCheckInputSchema } from '@xunjie/contracts/model-connections';
import type { ModelAttempt, ModelCheckInput, ModelConfiguration, ModelConnection } from '@xunjie/contracts/model-connections';
import { checkPayload, runChat } from './chat.js';

export const checkMigrations = [{ version: 2, name: 'durable-model-checks', sql: `
  CREATE TABLE model_attempts (id uuid PRIMARY KEY,scope text NOT NULL,body jsonb NOT NULL,input_digest text NOT NULL,
    credential_ref uuid,state text NOT NULL,physical_ended boolean NOT NULL,dispatcher_id text,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
  CREATE INDEX model_attempt_scope ON model_attempts(scope,created_at);
` }];
export interface CheckSnapshot { connection: ModelConnection; credentialRef: string; retain?(tx: OwnedTransaction): Promise<void> }
const scopeOf = (identity: SpaceIdentity) => [identity.environmentId, identity.spaceId, identity.principalId].join('.');
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function createChecks(storage: OwnedStorage, owner: {
  dispatcher?: { id: string; hasEnded(id: string): Promise<boolean> } | undefined;
  authorize(identity: SpaceIdentity): Promise<void>;
  snapshot(identity: SpaceIdentity, source: ModelCheckInput['source']): Promise<CheckSnapshot>;
  credential(identity: SpaceIdentity, ref: string): Promise<string>;
  assertDispatch(identity: SpaceIdentity, attempt: ModelAttempt, ref: string): Promise<void>;
  release(ref: string): Promise<void>;
}) {
  const active = new Map<string, { controller: AbortController; task: Promise<void> }>();
  let closed = false;
  let admissionClosed = false;
  let starting = 0;
  async function reconcileDispatchers() {
    if (admissionClosed) return;
    const { rows: expired } = await storage.read("SELECT id FROM model_attempts WHERE state='accepted' AND created_at < clock_timestamp()-interval '60 seconds'");
    for (const item of expired) {
      await storage.request({ requestId: 'model-grant-expired:' + item.id, fingerprint: 'model-check-grant-v1' }, async tx => {
        const { rows: [current] } = await tx.query('SELECT body,credential_ref FROM model_attempts WHERE id=$1 FOR UPDATE', [item.id]);
        const body = modelAttemptSchema.parse(current!.body);
        if (body.state !== 'accepted') return null;
        const next = { ...body, state: 'cancelled', reason: 'authorization-expired' };
        await tx.query('UPDATE model_attempts SET body=$2,state=$3 WHERE id=$1', [item.id, next, 'cancelled']);
        await tx.query('DELETE FROM model_credentials WHERE id=$1 AND temporary=true', [current!.credential_ref]);
        return { expired: true };
      });
    }
    if (!owner.dispatcher) return;
    const { rows } = await storage.read('SELECT id,dispatcher_id,credential_ref FROM model_attempts WHERE physical_ended=false');
    for (const row of rows) {
      const dispatcherId = row.dispatcher_id as string | null;
      if (!dispatcherId || dispatcherId === owner.dispatcher.id || !await owner.dispatcher.hasEnded(dispatcherId)) continue;
      // Confirm only the dead local client. Upstream compute and usage remain unknown and admission is not refunded.
      await storage.request({ requestId: 'model-dispatch-ended:' + row.id, fingerprint: dispatcherId }, async tx => {
        const { rows: [current] } = await tx.query('SELECT body FROM model_attempts WHERE id=$1 FOR UPDATE', [row.id]);
        if (!current) return null;
        const body = modelAttemptSchema.parse(current.body);
        if (body.physicalRequestEnded) return null;
        const next = { ...body, physicalRequestEnded: true, state: 'unknown', reason: 'dispatcher-ended' };
        await tx.query('UPDATE model_attempts SET body=$2,state=$3,physical_ended=true WHERE id=$1', [row.id, next, 'unknown']);
        return { reconciled: true };
      });
      await owner.release(row.credential_ref as string);
    }
  }
  async function row(identity: SpaceIdentity, attemptId: string) {
    await owner.authorize(identity);
    const { rows: [found] } = await storage.read('SELECT * FROM model_attempts WHERE id=$1 AND scope=$2', [attemptId, scopeOf(identity)]);
    if (!found) throw new StorageError('missing');
    return found;
  }
  const project = (body: unknown) => {
    const result = modelAttemptSchema.parse(body);
    return result.state === 'dispatched' && !active.has(result.attemptId) ? { ...result, state: 'unknown' as const, reason: 'dispatch-unconfirmed' } : result;
  };
  async function read(identity: SpaceIdentity, attemptId: string) {
    await owner.authorize(identity);
    await reconcileDispatchers();
    const result = project((await row(identity, attemptId)).body);
    if (result.resultRef) await storage.readResource(result.resultRef);
    return result;
  }
  async function list(identity: SpaceIdentity) {
    await owner.authorize(identity);
    await reconcileDispatchers();
    const { rows } = await storage.read('SELECT body FROM model_attempts WHERE scope=$1 ORDER BY created_at DESC LIMIT 50', [scopeOf(identity)]);
    return Promise.all(rows.map(async item => {
      const fact = project(item.body);
      if (fact.resultRef) await storage.readResource(fact.resultRef);
      return fact;
    }));
  }
  async function receive(identity: SpaceIdentity, value: unknown) {
    if (admissionClosed) throw new StorageError('maintenance');
    await owner.authorize(identity);
    const input = modelCheckInputSchema.parse(value), scope = scopeOf(identity), fingerprint = digest({ scope, input });
    const prior = await storage.receipt('model-check:' + input.attemptId, fingerprint);
    if (prior) return read(identity, input.attemptId);
    const snapshot = await owner.snapshot(identity, input.source);
      const payload = checkPayload(snapshot.connection, input.limits.maxOutputTokens);
      const request = await storage.stageResource({ uploadId: randomUUID(), scope: 'model-request:' + input.attemptId,
        bytes: Buffer.from(JSON.stringify(payload)), mediaType: 'application/json', contentVersion: 1 });
      const body: ModelAttempt = { attemptId: input.attemptId, purpose: input.purpose, connection: snapshot.connection,
        limits: input.limits, state: 'accepted', dispatched: false, cancelRequested: false, physicalRequestEnded: true,
        upstreamStopped: 'unknown', text: '', usage: { state: 'unknown' }, reason: '', requestRef: request.resourceId, resultRef: null,
        createdAt: new Date().toISOString() };
      await storage.request({ requestId: 'model-check:' + input.attemptId, fingerprint }, async tx => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['model-admission:' + scope]);
        const { rows: [count] } = await tx.query("SELECT count(*)::integer AS total FROM model_attempts WHERE scope=$1 AND created_at > clock_timestamp()-interval '1 hour'", [scope]);
        if (Number(count!.total) >= 6) throw new StorageError('resource-busy');
        await snapshot.retain?.(tx);
        await tx.query('INSERT INTO model_attempts(id,scope,body,input_digest,credential_ref,state,physical_ended) VALUES($1,$2,$3,$4,$5,$6,true)',
          [input.attemptId, scope, body, fingerprint, snapshot.credentialRef, 'accepted']);
        await tx.reference('model-request:' + input.attemptId, request.resourceId);
        return { attemptId: input.attemptId };
      });
      return read(identity, input.attemptId);
  }
  async function update(identity: SpaceIdentity, id: string, effect: (body: ModelAttempt) => ModelAttempt) {
    return storage.request({ requestId: randomUUID(), fingerprint: 'model-transition:' + id }, async tx => {
      const { rows: [found] } = await tx.query('SELECT body FROM model_attempts WHERE id=$1 AND scope=$2 FOR UPDATE', [id, scopeOf(identity)]);
      if (!found) throw new StorageError('missing');
      const body = effect(modelAttemptSchema.parse(found.body));
      await tx.query('UPDATE model_attempts SET body=$2,state=$3,physical_ended=$4 WHERE id=$1', [id, body, body.state, body.physicalRequestEnded]);
      return body;
    });
  }
  async function dispatch(identity: SpaceIdentity, attemptId: string) {
    if (closed) throw new StorageError('maintenance');
    starting++;
    try {
    await owner.authorize(identity);
    await reconcileDispatchers();
    const found = await row(identity, attemptId), original = modelAttemptSchema.parse(found.body);
    if (original.state !== 'accepted') return read(identity, attemptId);
    if (closed) throw new StorageError('maintenance');
    await storage.pendingIntents();
    await owner.assertDispatch(identity, original, found.credential_ref as string);
    const claimed = await storage.request({ requestId: randomUUID(), fingerprint: 'model-dispatch:' + attemptId }, async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['model-physical-slots']);
      const { rows: [current] } = await tx.query('SELECT body FROM model_attempts WHERE id=$1 FOR UPDATE', [attemptId]);
      const body = modelAttemptSchema.parse(current!.body);
      if (body.state !== 'accepted' || closed) return false;
      const { rows: [count] } = await tx.query('SELECT count(*)::integer AS total,count(*) FILTER (WHERE scope=$1)::integer AS personal FROM model_attempts WHERE physical_ended=false', [scopeOf(identity)]);
      if (Number(count!.total) >= 2 || Number(count!.personal) >= 1) throw new StorageError('resource-busy');
      const next = { ...body, state: 'dispatched', dispatched: true, physicalRequestEnded: false };
      await tx.query('UPDATE model_attempts SET body=$2,state=$3,physical_ended=false,dispatcher_id=$4 WHERE id=$1', [attemptId, next, 'dispatched', owner.dispatcher?.id ?? null]);
      return true;
    });
    if (!claimed.result) return read(identity, attemptId);
    const controller = new AbortController();
    const task = deliver(identity, original, found.credential_ref as string, controller);
    active.set(attemptId, { controller, task });
    void task.finally(() => active.delete(attemptId)).catch(() => {});
    return read(identity, attemptId);
    } finally { starting--; }
  }
  async function deliver(identity: SpaceIdentity, attempt: ModelAttempt, ref: string, controller: AbortController) {
    const timeout = setTimeout(() => controller.abort('timeout'), attempt.limits.timeoutMs);
    try {
      await owner.assertDispatch(identity, attempt, ref);
      await storage.pendingIntents();
      if (closed) throw new StorageError('maintenance');
      const current = await row(identity, attempt.attemptId);
      if ((current.body as ModelAttempt).cancelRequested) controller.abort('cancel');
      const credential = await owner.credential(identity, ref);
      const payload = JSON.parse(Buffer.from(await storage.readResource(attempt.requestRef)).toString('utf8')) as ReturnType<typeof checkPayload>;
      await owner.assertDispatch(identity, attempt, ref);
      await storage.pendingIntents();
      if (closed) throw new StorageError('maintenance');
      const result = controller.signal.aborted
        ? { state: 'cancelled' as const, reason: 'cancelled-before-send', text: '', usage: { state: 'unknown' as const }, native: { chunks: [] } }
        : await runChat(attempt.connection, credential, payload, controller.signal, attempt.limits.timeoutMs);
      if (controller.signal.reason === 'timeout') { result.state = 'unknown'; result.reason = 'timeout'; }
      const resource = await storage.stageResource({ uploadId: randomUUID(), scope: 'model-result:' + attempt.attemptId,
        bytes: Buffer.from(JSON.stringify(result.native)), mediaType: 'application/json', contentVersion: 1 });
      await storage.request({ requestId: randomUUID(), fingerprint: 'model-result:' + attempt.attemptId }, async tx => {
        const { rows: [current] } = await tx.query('SELECT body FROM model_attempts WHERE id=$1 FOR UPDATE', [attempt.attemptId]);
        const body = modelAttemptSchema.parse(current!.body);
        const next = { ...body, state: result.state, reason: result.reason, text: result.text, usage: result.usage,
          physicalRequestEnded: true, resultRef: resource.resourceId };
        await tx.reference('model-result:' + attempt.attemptId, resource.resourceId);
        await tx.query('UPDATE model_attempts SET body=$2,state=$3,physical_ended=true WHERE id=$1', [attempt.attemptId, next, next.state]);
        return { resultRef: resource.resourceId };
      });
    } catch {
      // No success without the resource and result transaction. Never replay a dispatched attempt.
      await update(identity, attempt.attemptId, body => ({ ...body, state: 'unknown', reason: 'result-unconfirmed', physicalRequestEnded: true })).catch(() => {});
    } finally { clearTimeout(timeout); await owner.release(ref).catch(() => {}); }
  }
  async function cancel(identity: SpaceIdentity, attemptId: string) {
    const original = await row(identity, attemptId);
    await update(identity, attemptId, body => ['accepted', 'dispatched', 'unknown'].includes(body.state)
      ? { ...body, cancelRequested: true, ...(body.state === 'accepted' ? { state: 'cancelled' as const, reason: 'not-started' } : {}) } : body);
    active.get(attemptId)?.controller.abort('cancel');
    if ((original.body as ModelAttempt).state === 'accepted') await owner.release(original.credential_ref as string);
    return read(identity, attemptId);
  }
  async function validate() {
    const { rows } = await storage.read('SELECT body FROM model_attempts');
    for (const row of rows) {
      const body = modelAttemptSchema.parse(row.body);
      await storage.readResource(body.requestRef);
      if (body.resultRef) await storage.readResource(body.resultRef);
      if (body.state === 'completed' && !body.resultRef) throw new StorageError('corrupt');
    }
  }
  return { receive, read, list, dispatch, cancel, validate,
    closeAdmission() { admissionClosed = true; },
    closeDispatch() { closed = true; },
    async drain() {
      while (starting || active.size) {
        await Promise.allSettled([...active.values()].map(value => value.task));
        if (starting) await new Promise(resolve => setTimeout(resolve, 5));
      }
    },
    resume() { closed = false; admissionClosed = false; } };
}
