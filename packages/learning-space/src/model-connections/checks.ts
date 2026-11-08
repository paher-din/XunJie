import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { StorageError, type OwnedStorage, type OwnedTransaction } from '@xunjie/storage';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import { modelAttemptSchema, modelAttemptInputSchema, modelProgressSchema } from '@xunjie/contracts/model-connections';
import type { ModelAttempt, ModelCheckInput, ModelConnection, ModelCheckPolicy, ModelChatInput, ModelLearningInput, ModelTool, ModelProgress, ModelToolProgress } from '@xunjie/contracts/model-connections';
import { connectionCheckPayload, limitPayload, runModel, type NativePayload } from './transport.js';
import { validateResponsesNative } from './responses.js';
import { createLearningAdmission, learningReservationUnits, lockLearningAdmission, type LearningAdmissionPolicy } from './learning-admission.js';
import { validateMessagesNative, type MessagesPayload } from './messages.js';

export const checkMigrations = [{ version: 2, name: 'durable-model-checks', sql: `
  CREATE TABLE model_attempts (id uuid PRIMARY KEY,scope text NOT NULL,body jsonb NOT NULL,input_digest text NOT NULL,
    credential_ref uuid,state text NOT NULL,physical_ended boolean NOT NULL,dispatcher_id text,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
  CREATE INDEX model_attempt_scope ON model_attempts(scope,created_at);
` }];
export interface CheckSnapshot { connection: ModelConnection; credentialRef: string; source?: ModelAttempt['source'];
  policy?: ModelCheckPolicy; payload?: NativePayload; tools?: ModelTool[]; applicationSchema?: Record<string, unknown>; segment?: ModelAttempt['segment']; retain?(tx: OwnedTransaction): Promise<void> }
export type ModelCleanupScope = Pick<SpaceIdentity, 'environmentId' | 'spaceId' | 'principalId'>;
export type ModelCleanupStatus = Pick<ModelAttempt, 'attemptId' | 'state' | 'dispatched' | 'cancelRequested' | 'physicalRequestEnded'>;
const cleanupScopeSchema = z.object({ environmentId: z.uuid(), spaceId: z.uuid(), principalId: z.uuid() }).strict();
const scopeOf = (identity: ModelCleanupScope) => [identity.environmentId, identity.spaceId, identity.principalId].join('.');
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function createChecks(storage: OwnedStorage, owner: {
  dispatcher?: { id: string; hasEnded(id: string): Promise<boolean> } | undefined;
  authorize(identity: SpaceIdentity): Promise<void>;
  snapshot(identity: SpaceIdentity, source: ModelCheckInput['source']): Promise<CheckSnapshot>;
  prepareChat(identity: SpaceIdentity, input: ModelChatInput | ModelLearningInput): Promise<CheckSnapshot>;
  publishChat(tx: OwnedTransaction, attempt: ModelAttempt): Promise<void>;
  credential(identity: SpaceIdentity, ref: string): Promise<string>;
  assertDispatch(identity: SpaceIdentity, attempt: ModelAttempt, ref: string): Promise<void>;
  assertActive?(identity: SpaceIdentity, attempt: ModelAttempt, ref: string): Promise<void>;
  authorizationPollMs?: number | undefined;
  learningAdmissionPolicy?: LearningAdmissionPolicy | undefined;
  requestFetch?(identity: SpaceIdentity, attempt: ModelAttempt): Promise<typeof fetch>;
}) {
  const learningAdmission = createLearningAdmission(storage, owner.learningAdmissionPolicy);
  const active = new Map<string, { controller: AbortController; task: Promise<void>; scope: string }>();
  const unsentClaims = new Map<string, { attemptId: string; identity: SpaceIdentity; requestId: string; fingerprint: string }>();
  const ticketWithdrawals = new Map<string, { attemptId: string; identity: SpaceIdentity }>();
  const revocations = new Map<string, { scope: ModelCleanupScope; reason: string }>();
  const authorizationPollMs = owner.authorizationPollMs ?? 1000;
  if (!Number.isSafeInteger(authorizationPollMs) || authorizationPollMs < 10) throw new StorageError('invalid');
  let closed = false;
  let admissionClosed = false;
  let starting = 0;
  async function withdrawTicket(identity: SpaceIdentity, attemptId: string, ticketId: string) {
    ticketWithdrawals.set(ticketId, { identity, attemptId });
    await storage.request({ requestId: randomUUID(), fingerprint: 'model-learning-withdraw:' + ticketId }, async tx => {
      await lockLearningAdmission(tx);
      await learningAdmission.withdraw(tx, identity, attemptId, ticketId);
      return null;
    });
    ticketWithdrawals.delete(ticketId);
  }
  async function settleTicketWithdrawals() {
    for (const [ticketId, { identity, attemptId }] of ticketWithdrawals) await withdrawTicket(identity, attemptId, ticketId);
  }
  async function settleUnsentClaims() {
    for (const [requestId, claim] of unsentClaims) {
      const id = claim.attemptId;
      const receipt = await storage.receipt(claim.requestId, claim.fingerprint);
      if (!receipt) continue;
      if (receipt.result === true) await update(claim.identity, id, body => body.state === 'dispatched' && !active.has(id)
        ? { ...body, state: 'failed', reason: 'dispatch-not-started', physicalRequestEnded: true, dispatched: false } : body, { notSent: true });
      unsentClaims.delete(requestId);
    }
  }
  async function reconcileDispatchers() {
    if (admissionClosed) return;
    await settleTicketWithdrawals();
    await settleUnsentClaims();
    const { rows: expired } = await storage.read("SELECT id FROM model_attempts WHERE state='accepted' AND body->>'purpose'<>'learning' AND created_at < clock_timestamp()-interval '60 seconds'");
    for (const item of expired) {
      await storage.request({ requestId: 'model-grant-expired:' + item.id, fingerprint: 'model-check-grant-v1' }, async tx => {
        const { rows: [current] } = await tx.query('SELECT body,credential_ref FROM model_attempts WHERE id=$1 FOR UPDATE', [item.id]);
        const body = modelAttemptSchema.parse(current!.body);
        if (body.state !== 'accepted') return null;
        const next = { ...body, state: 'cancelled', reason: 'authorization-expired' };
        await tx.query('UPDATE model_attempts SET body=$2,state=$3 WHERE id=$1', [item.id, next, 'cancelled']);
        await tx.query('DELETE FROM model_credentials WHERE id=$1 AND temporary=true', [current!.credential_ref]);
        if (body.segment) await owner.publishChat(tx, modelAttemptSchema.parse(next));
        return { expired: true };
      });
    }
    await reconcileEndedDispatchers();
  }
  async function reconcileEndedDispatchers() {
    if (!owner.dispatcher) return;
    const { rows } = await storage.read('SELECT id,dispatcher_id,credential_ref FROM model_attempts WHERE physical_ended=false');
    for (const row of rows) {
      const dispatcherId = row.dispatcher_id as string | null;
      if (!dispatcherId || dispatcherId === owner.dispatcher.id || !await owner.dispatcher.hasEnded(dispatcherId)) continue;
      // Confirm only the dead local client. Upstream compute and usage remain unknown and admission is not refunded.
      await storage.request({ requestId: 'model-dispatch-ended:' + row.id, fingerprint: dispatcherId }, async tx => {
        await lockLearningAdmission(tx);
        const { rows: [current] } = await tx.query('SELECT body FROM model_attempts WHERE id=$1 FOR UPDATE', [row.id]);
        if (!current) return null;
        const body = modelAttemptSchema.parse(current.body);
        if (body.physicalRequestEnded) return null;
        const next = { ...body, physicalRequestEnded: true, state: 'unknown' as const, reason: 'dispatcher-ended' };
        await learningAdmission.settle(tx, next);
        await tx.query('UPDATE model_attempts SET body=$2,state=$3,physical_ended=$4 WHERE id=$1', [row.id, next, 'unknown', next.physicalRequestEnded]);
        await tx.query('DELETE FROM model_credentials WHERE id=$1 AND temporary=true', [row.credential_ref]);
        if (body.segment) await owner.publishChat(tx, modelAttemptSchema.parse(next));
        return { reconciled: true };
      });
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
  async function responsesResult(body: ModelAttempt, bytes: Uint8Array) {
    const request = JSON.parse(Buffer.from(await storage.readResource(body.requestRef)).toString('utf8')) as NativePayload;
    if (!('input' in request)) throw new StorageError('corrupt');
    const tools = request.tools?.map(tool => {
      if (tool.type !== 'function') throw new StorageError('corrupt');
      return { name: tool.name, description: tool.description ?? '', inputSchema: tool.parameters ?? {} };
    }) ?? [];
    const native: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
    validateResponsesNative(native, tools);
    return native as { output: unknown[] };
  }
  /** Only the model's explicit Responses summary is public; reasoning/thinking stays native. */
  async function summary(identity: SpaceIdentity, attemptId: string): Promise<{ source: 'model-native'; text: string; truncated: boolean } | null> {
    const body = await read(identity, attemptId);
    if (body.state !== 'completed' || !body.physicalRequestEnded || body.connection.protocol !== 'responses' || !body.resultRef) return null;
    const native = await responsesResult(body, await storage.readResource(body.resultRef));
    const limit = 16_000;
    let text = '';
    let truncated = false;
    for (const item of native.output) {
      if (!item || typeof item !== 'object' || !('type' in item) || item.type !== 'reasoning'
        || !('summary' in item) || !Array.isArray(item.summary)) continue;
      for (const part of item.summary) {
        if (!part || typeof part !== 'object' || part.type !== 'summary_text' || typeof part.text !== 'string' || !part.text.trim()) continue;
        const fragment = (text ? '\n\n' : '') + part.text;
        const remaining = limit - text.length;
        if (fragment.length > remaining) truncated = true;
        text += fragment.slice(0, remaining);
      }
    }
    // A bounded prefix must not split a Unicode surrogate pair or invent an ellipsis.
    if (/[\uD800-\uDBFF]$/.test(text)) { text = text.slice(0, -1); truncated = true; }
    return text ? { source: 'model-native', text, truncated } : null;
  }
  const progressBodySchema = modelProgressSchema;
  async function progress(identity: SpaceIdentity, attemptId: string) {
    await owner.authorize(identity);
    const { rows: [row] } = await storage.read('SELECT body FROM model_attempt_progress WHERE attempt_id=$1 AND scope=$2',
      [attemptId, scopeOf(identity)]);
    return row ? progressBodySchema.parse(row.body) : null;
  }
  async function saveProgress(identity: SpaceIdentity, attemptId: string, snapshot: Omit<ModelProgress, 'revision'>) {
    if (!snapshot.text && !snapshot.tools?.length) return;
    await storage.request({ requestId: 'model-progress:' + attemptId + ':' + randomUUID(),
      fingerprint: 'model-progress:' + attemptId }, async tx => {
      const { rows: [row] } = await tx.query('SELECT body FROM model_attempt_progress WHERE attempt_id=$1 AND scope=$2 FOR UPDATE',
        [attemptId, scopeOf(identity)]);
      const previous = row ? progressBodySchema.safeParse(row.body) : null;
      const prior = previous?.success ? previous.data : { text: '', revision: 0 };
      const text = snapshot.text.length > prior.text.length && snapshot.text.startsWith(prior.text) ? snapshot.text : prior.text;
      const tools = new Map((prior.tools ?? []).map(item => [item.callId, item]));
      for (const item of snapshot.tools ?? []) {
        const before = tools.get(item.callId);
        if (before ? item.name === before.name && item.text.length > before.text.length && item.text.startsWith(before.text) : tools.size < 8)
          tools.set(item.callId, item);
      }
      const nextTools = [...tools.values()];
      if (text === prior.text && JSON.stringify(nextTools) === JSON.stringify(prior.tools ?? [])) return null;
      const body = progressBodySchema.parse({ text, revision: prior.revision + 1, ...(nextTools.length ? { tools: nextTools } : {}) });
      await tx.query(`INSERT INTO model_attempt_progress(attempt_id,scope,body) VALUES($1,$2,$3)
        ON CONFLICT(attempt_id) DO UPDATE SET body=$3,updated_at=clock_timestamp()`,
        [attemptId, scopeOf(identity), JSON.stringify(body)]);
      return body;
    });
  }
  /** Native request reconstruction stays at the model owner; callers never read its resources directly. */
  async function requestPayload(identity: SpaceIdentity, attemptId: string) {
    await owner.authorize(identity);
    const found = await row(identity, attemptId);
    const body = modelAttemptSchema.parse(found.body);
    const bytes = Buffer.from(await storage.readResource(body.requestRef));
    return JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
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
    const input = modelAttemptInputSchema.parse(value), scope = scopeOf(identity), fingerprint = digest({ scope, input });
    const prior = await storage.receipt('model-check:' + input.attemptId, fingerprint);
    if (prior) return read(identity, input.attemptId);
    const learning = input.purpose === 'learning';
    const snapshot = input.purpose === 'connection-check' ? await owner.snapshot(identity, input.source) : await owner.prepareChat(identity, input);
      const limits = learning ? input.limits : snapshot.policy ? { maxOutputTokens: Math.min(input.limits.maxOutputTokens, snapshot.policy.maxOutputTokens),
        timeoutMs: Math.min(input.limits.timeoutMs!, snapshot.policy.timeoutMs) } : input.limits;
      const payload = snapshot.payload ? limitPayload(snapshot.connection, snapshot.payload, limits.maxOutputTokens)
        : connectionCheckPayload(snapshot.connection, limits.maxOutputTokens);
      const request = await storage.stageResource({ uploadId: randomUUID(), scope: 'model-request:' + input.attemptId,
        bytes: Buffer.from(JSON.stringify(payload)), mediaType: 'application/json', contentVersion: 1 });
      const body: ModelAttempt = { attemptId: input.attemptId, purpose: input.purpose, connection: snapshot.connection,
        limits, ...(snapshot.source ? { source: snapshot.source } : {}), ...(snapshot.segment ? { segment: snapshot.segment } : {}),
        state: 'accepted', dispatched: false, cancelRequested: false, physicalRequestEnded: true,
        upstreamStopped: 'unknown', text: '', usage: { state: 'unknown' }, reason: '', requestRef: request.resourceId, resultRef: null,
        createdAt: new Date().toISOString() };
      await storage.request({ requestId: 'model-check:' + input.attemptId, fingerprint }, async tx => {
        if (learning) await lockLearningAdmission(tx);
        if (!learning) {
          await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['model-admission:' + scope]);
          if (snapshot.source) {
            await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['model-budget:' + snapshot.source.feeSource]);
            const { rows: [billed] } = await tx.query("SELECT count(*)::integer AS total FROM model_attempts WHERE (body->'source'->>'feeSource'=$1 OR (body->'source' IS NULL AND scope=$1)) AND created_at > clock_timestamp()-interval '1 hour'", [snapshot.source.feeSource]);
            if (Number(billed!.total) >= (snapshot.policy?.maxChecksPerHour ?? 6)) throw new StorageError('resource-busy');
          }
          const { rows: [count] } = await tx.query("SELECT count(*)::integer AS total FROM model_attempts WHERE scope=$1 AND created_at > clock_timestamp()-interval '1 hour'", [scope]);
          if (Number(count!.total) >= 6) throw new StorageError('resource-busy');
        }
        await snapshot.retain?.(tx);
        await tx.query('INSERT INTO model_attempts(id,scope,body,input_digest,credential_ref,state,physical_ended,input_metadata) VALUES($1,$2,$3,$4,$5,$6,true,$7)',
          [input.attemptId, scope, body, fingerprint, snapshot.credentialRef, 'accepted', input.purpose !== 'connection-check'
            ? { input: input.input, ...(snapshot.tools ? { tools: snapshot.tools } : {}), ...(snapshot.applicationSchema ? { applicationSchema: snapshot.applicationSchema } : {}) } : null]);
        await learningAdmission.enqueue(tx, identity, body, payload);
        await tx.reference('model-request:' + input.attemptId, request.resourceId);
        return { attemptId: input.attemptId };
      });
      return read(identity, input.attemptId);
  }
  async function update(identity: ModelCleanupScope, id: string, effect: (body: ModelAttempt) => ModelAttempt, evidence: { notSent?: boolean; upstreamEnded?: boolean } = {}) {
    return storage.request({ requestId: randomUUID(), fingerprint: 'model-transition:' + id }, async tx => {
      await lockLearningAdmission(tx);
      const { rows: [found] } = await tx.query('SELECT body,credential_ref FROM model_attempts WHERE id=$1 AND scope=$2 FOR UPDATE', [id, scopeOf(identity)]);
      if (!found) throw new StorageError('missing');
      const body = effect(modelAttemptSchema.parse(found.body));
      await learningAdmission.settle(tx, body, evidence);
      await tx.query('UPDATE model_attempts SET body=$2,state=$3,physical_ended=$4 WHERE id=$1', [id, body, body.state, body.physicalRequestEnded]);
      if (body.physicalRequestEnded && body.state !== 'accepted')
        await tx.query('DELETE FROM model_credentials WHERE id=$1 AND temporary=true', [found.credential_ref]);
      if (body.segment && body.physicalRequestEnded && body.state !== 'accepted') await owner.publishChat(tx, body);
      return body;
    });
  }
  /** Trusted Node cleanup, scoped to an already owned attempt. No member authorization,
   * body projection, admission or SDK dispatch is available through this interface.
   */
  async function cleanupStatus(value: ModelCleanupScope, attemptId: string): Promise<ModelCleanupStatus> {
    const scope = cleanupScopeSchema.parse(value); z.uuid().parse(attemptId);
    const { rows: [row] } = await storage.read('SELECT body FROM model_attempts WHERE id=$1 AND scope=$2', [attemptId, scopeOf(scope)]);
    if (!row) throw new StorageError('missing');
    const body = modelAttemptSchema.parse(row.body);
    return { attemptId: body.attemptId, state: body.state, dispatched: body.dispatched,
      cancelRequested: body.cancelRequested, physicalRequestEnded: body.physicalRequestEnded };
  }
  async function cancelCleanup(value: ModelCleanupScope, attemptId: string, reason = 'authorization-lost'): Promise<ModelCleanupStatus> {
    const scope = cleanupScopeSchema.parse(value); z.uuid().parse(attemptId);
    let verified = active.get(attemptId)?.scope === scopeOf(scope);
    if (verified) revocations.set(attemptId, { scope, reason });
    try {
      await update(scope, attemptId, body => ({ ...body, cancelRequested: true,
        ...(body.state === 'accepted' ? { state: 'cancelled' as const, reason }
          : !body.physicalRequestEnded ? { reason } : {}) }));
      verified = true;
      revocations.delete(attemptId);
    } finally {
      // If persistence is temporarily unknown, stop this owner's proven local SDK anyway.
      // The pending revocation remains a drain blocker until its durable flag is confirmed.
      if (verified) active.get(attemptId)?.controller.abort('authorization-lost');
    }
    return cleanupStatus(scope, attemptId);
  }
  async function settleRevocations() {
    for (const [id, pending] of revocations) {
      await cancelCleanup(pending.scope, id, pending.reason);
      revocations.delete(id);
    }
  }
  async function dispatch(identity: SpaceIdentity, attemptId: string) {
    if (closed) throw new StorageError('maintenance');
    starting++;
    let withdrawalTicket: string | null = null;
    try {
    withdrawalTicket = await learningAdmission.currentTicket(identity, attemptId);
    await owner.authorize(identity);
    await reconcileDispatchers();
    const found = await row(identity, attemptId), original = modelAttemptSchema.parse(found.body);
    if (original.state !== 'accepted') return await read(identity, attemptId);
    if (closed) throw new StorageError('maintenance');
    if (original.purpose === 'learning') {
      withdrawalTicket = randomUUID();
      const ticketId = withdrawalTicket;
      const marked = await storage.request({ requestId: 'model-learning-ready:' + ticketId,
        fingerprint: digest({ scope: scopeOf(identity), attemptId, ticketId }) }, async tx => {
        await lockLearningAdmission(tx);
        return learningAdmission.ready(tx, identity, attemptId, ticketId);
      });
      if (!marked.result) return await read(identity, attemptId);
    }
    await storage.pendingIntents();
    await owner.assertDispatch(identity, original, found.credential_ref as string);
    const reservationUnits = original.purpose === 'learning' ? learningReservationUnits(
      JSON.parse(Buffer.from(await storage.readResource(original.requestRef)).toString('utf8')), original.limits.maxOutputTokens) : undefined;
    const claim = { requestId: randomUUID(), fingerprint: 'model-dispatch:' + attemptId };
    let claimed;
    try { claimed = await storage.request(claim, async tx => {
      await lockLearningAdmission(tx);
      const { rows: [current] } = await tx.query('SELECT body FROM model_attempts WHERE id=$1 FOR UPDATE', [attemptId]);
      const body = modelAttemptSchema.parse(current!.body);
      if (body.state !== 'accepted' || closed) return false;
      if (body.purpose === 'learning') {
        if (!withdrawalTicket) throw new StorageError('corrupt');
        const reason = await learningAdmission.claim(tx, body, withdrawalTicket, reservationUnits);
        if (reason) {
          await tx.query('UPDATE model_attempts SET body=$2 WHERE id=$1', [attemptId, { ...body, reason }]);
          return false;
        }
      } else {
        const { rows: [count] } = await tx.query('SELECT count(*)::integer AS total,count(*) FILTER (WHERE scope=$1)::integer AS personal FROM model_attempts WHERE physical_ended=false AND (body->>\'purpose\')<>\'learning\'', [scopeOf(identity)]);
        if (Number(count!.total) >= 2 || Number(count!.personal) >= 1) throw new StorageError('resource-busy');
      }
      const next = { ...body, reason: '', state: 'dispatched', dispatched: true, physicalRequestEnded: false };
      await tx.query('UPDATE model_attempts SET body=$2,state=$3,physical_ended=false,dispatcher_id=$4 WHERE id=$1', [attemptId, next, 'dispatched', owner.dispatcher?.id ?? null]);
      return true;
    }); } catch (error) {
      if (!(error instanceof StorageError) || error.code !== 'commit-unknown') throw error;
      // This invocation has not started an SDK request. Confirm its own claim receipt, never replay it.
      unsentClaims.set(claim.requestId, { attemptId, identity, ...claim });
      await settleUnsentClaims();
      return await read(identity, attemptId);
    }
    if (!claimed.result) return await read(identity, attemptId);
    const controller = new AbortController();
    const task = deliver(identity, original, found.credential_ref as string, controller, found.input_metadata as { applicationSchema?: Record<string, unknown>; tools?: ModelTool[] } | null);
    active.set(attemptId, { controller, task, scope: scopeOf(identity) });
    void task.finally(() => active.delete(attemptId)).catch(() => {});
    return await read(identity, attemptId);
    } catch (error) {
      // A rejected preflight is not cancellation and cannot refund a charged call.
      // Conditional withdrawal also protects a newer concurrent invocation's ticket.
      // A storage failure must stay retryable at the Run owner. Reporting a
      // permanent authorization error before withdrawal is confirmed could leave
      // a paused Run's durable ticket blocking everyone after this process exits.
      if (withdrawalTicket) await withdrawTicket(identity, attemptId, withdrawalTicket);
      throw error;
    } finally { starting--; }
  }
  async function deliver(identity: SpaceIdentity, attempt: ModelAttempt, ref: string, controller: AbortController, metadata: { applicationSchema?: Record<string, unknown>; tools?: ModelTool[] } | null) {
    // Learning calls use no product-level generation deadline; the transport still needs a finite client bound.
    const timeout = setTimeout(() => controller.abort('timeout'), attempt.limits.timeoutMs ?? 2_147_483_647);
    let openedUpstream = false, upstreamEnded = false;
    let finishProgress: () => Promise<void> = async () => {};
    let watch: ReturnType<typeof setInterval> | undefined;
    let authorizationCheck: Promise<void> | undefined;
    let watching = false, checking = false;
    const stopWatch = () => { watching = false; clearInterval(watch); };
    const checkAuthorization = async () => {
      if (!watching || checking) return;
      checking = true;
      try {
        const pending = revocations.get(attempt.attemptId);
        if (pending) {
          await cancelCleanup(pending.scope, attempt.attemptId, pending.reason);
          revocations.delete(attempt.attemptId);
        } else await owner.assertActive?.(identity, attempt, ref);
      } catch (error) {
        if (!watching) return;
        const scope = { environmentId: identity.environmentId, spaceId: identity.spaceId, principalId: identity.principalId };
        const reason = error instanceof StorageError && ['forbidden', 'missing', 'stale-generation', 'identity-conflict'].includes(error.code)
          ? 'authorization-lost' : 'authorization-unconfirmed';
        revocations.set(attempt.attemptId, { scope, reason });
        try { await cancelCleanup(scope, attempt.attemptId, reason); revocations.delete(attempt.attemptId); }
        catch { /* Keep the pending durable cleanup as a maintenance blocker. */ }
      } finally { checking = false; }
    };
    try {
      await owner.assertDispatch(identity, attempt, ref);
      await storage.pendingIntents();
      if (closed) throw new StorageError('maintenance');
      const current = await row(identity, attempt.attemptId);
      if ((current.body as ModelAttempt).cancelRequested) controller.abort('cancel');
      const credential = await owner.credential(identity, ref);
      const payload = JSON.parse(Buffer.from(await storage.readResource(attempt.requestRef)).toString('utf8')) as NativePayload;
      await owner.assertDispatch(identity, attempt, ref);
      await storage.pendingIntents();
      if (closed) throw new StorageError('maintenance');
      const requestFetch = await owner.requestFetch?.(identity, attempt) ?? fetch;
      const trackedFetch: typeof fetch = (input, init) => { openedUpstream = true; return requestFetch(input, init); };
      // Only learning runs publish an incremental, credential-safe preview. Probe/check
      // attempts keep their single settled result and do not add progress rows.
      let latest: Omit<ModelProgress, 'revision'> = { text: '' }, pending = false, lastSavedAt = 0;
      let progressTimer: ReturnType<typeof setTimeout> | undefined;
      let saves = Promise.resolve(), saveFailed = false, saveError: unknown;
      const enqueueProgress = () => {
        clearTimeout(progressTimer); progressTimer = undefined;
        if (!pending || saveFailed) return;
        pending = false; lastSavedAt = Date.now();
        const snapshot = structuredClone(latest);
        // Always attach a rejection handler immediately. The final result awaits this chain.
        saves = saves.then(async () => {
          if (!saveFailed) await saveProgress(identity, attempt.attemptId, snapshot);
        }).catch(error => { saveFailed = true; saveError = error; });
      };
      const scheduleProgress = () => {
        pending = true;
        const remaining = 500 - (Date.now() - lastSavedAt);
        if (remaining <= 0) enqueueProgress();
        else if (!progressTimer) { progressTimer = setTimeout(enqueueProgress, remaining); progressTimer.unref(); }
      };
      finishProgress = async () => {
        enqueueProgress(); await saves;
        if (saveFailed) throw saveError;
      };
      const onText = attempt.purpose === 'learning' ? (text: string) => {
        text = text.slice(0, 1_000_000).replace(/[\uD800-\uDBFF]$/, '');
        if (text.length <= latest.text.length || !text.startsWith(latest.text)) return;
        latest = { ...latest, text }; scheduleProgress();
      } : undefined;
      const onTools = attempt.purpose === 'learning' ? (tools: ModelToolProgress[]) => {
        latest = { ...latest, tools }; scheduleProgress();
      } : undefined;
      if (owner.assertActive && !controller.signal.aborted) {
        watching = true;
        watch = setInterval(() => { if (!checking) authorizationCheck = checkAuthorization(); }, authorizationPollMs);
        watch.unref();
      }
      const result = controller.signal.aborted
        ? { state: 'cancelled' as const, reason: 'cancelled-before-send', text: '', usage: { state: 'unknown' as const }, toolIntents: [], native: { chunks: [] } }
        : await runModel(attempt.connection, credential, payload, controller.signal, attempt.limits.timeoutMs ?? 2_147_483_647,
          !!attempt.segment, metadata?.applicationSchema, trackedFetch, onText, metadata?.tools, onTools);
      // A local abort, EOF without a terminal, or dispatcher death proves no upstream end.
      // A validated terminal or final usage does. HTTP rejection proves the call was refused.
      upstreamEnded = !openedUpstream || result.state === 'completed' || result.usage.state === 'final'
        || ('upstream' in result && !!result.upstream?.httpStatus && result.upstream.httpStatus >= 400);
      await finishProgress();
      // A check already started while the SDK was active still owns its verdict.
      // Settle it before publishing a completed result, even if the SDK won the race.
      clearInterval(watch);
      await authorizationCheck;
      // Short requests can finish before the first timer tick. Their original permit
      // must still be current when a consumable result is archived.
      if (!controller.signal.aborted) await checkAuthorization();
      stopWatch();
      const interruption = controller.signal.reason;
      if ((interruption === 'timeout' || interruption === 'maintenance') && !['completed', 'failed'].includes(result.state)) {
        result.state = 'unknown';
        result.reason = interruption === 'maintenance' ? 'maintenance-interrupted' : 'timeout';
        result.toolIntents = [];
      }
      const resource = await storage.stageResource({ uploadId: randomUUID(), scope: 'model-result:' + attempt.attemptId,
        bytes: Buffer.from(JSON.stringify(result.native)), mediaType: 'application/json', contentVersion: 1 });
      await storage.request({ requestId: randomUUID(), fingerprint: 'model-result:' + attempt.attemptId }, async tx => {
        await lockLearningAdmission(tx);
        const { rows: [current] } = await tx.query('SELECT body FROM model_attempts WHERE id=$1 FOR UPDATE', [attempt.attemptId]);
        const body = modelAttemptSchema.parse(current!.body);
        if (body.resultRef) return { resultRef: body.resultRef };
        const pending = revocations.get(attempt.attemptId);
        const revoked = pending !== undefined || body.cancelRequested && ['authorization-lost', 'authorization-unconfirmed'].includes(body.reason);
        const next = { ...body, state: revoked ? 'cancelled' as const : result.state, reason: revoked ? pending?.reason ?? body.reason : result.reason,
          cancelRequested: body.cancelRequested || revoked, dispatched: body.dispatched && openedUpstream, text: result.text, usage: result.usage,
          ...('upstream' in result && result.upstream ? { upstream: result.upstream } : {}),
          ...(attempt.segment ? { toolIntents: revoked ? [] : result.toolIntents } : {}),
          physicalRequestEnded: true, resultRef: resource.resourceId };
        await learningAdmission.settle(tx, next, { notSent: !openedUpstream, upstreamEnded });
        await tx.reference('model-result:' + attempt.attemptId, resource.resourceId);
        await tx.query('UPDATE model_attempts SET body=$2,state=$3,physical_ended=$4 WHERE id=$1', [attempt.attemptId, next, next.state, next.physicalRequestEnded]);
        await tx.query('DELETE FROM model_credentials WHERE id=$1 AND temporary=true', [ref]);
        if (next.segment && next.physicalRequestEnded) await owner.publishChat(tx, next);
        return { resultRef: resource.resourceId };
      });
    } catch {
      await finishProgress().catch(() => {});
      // No success without the resource and result transaction. Never replay a dispatched attempt.
      await update(identity, attempt.attemptId, body => body.resultRef || body.physicalRequestEnded ? body
        : { ...body, state: 'unknown', reason: body.cancelRequested ? body.reason : 'result-unconfirmed', physicalRequestEnded: true,
          ...(!openedUpstream ? { dispatched: false } : {}) }, { notSent: !openedUpstream, upstreamEnded }).catch(() => {});
    } finally { stopWatch(); clearTimeout(timeout); }
  }
  async function cancel(identity: SpaceIdentity, attemptId: string) {
    await row(identity, attemptId);
    await update(identity, attemptId, body => ['accepted', 'dispatched', 'unknown'].includes(body.state)
      ? { ...body, cancelRequested: true, ...(body.state === 'accepted' ? { state: 'cancelled' as const, reason: 'not-started' } : {}) } : body);
    active.get(attemptId)?.controller.abort('cancel');
    return read(identity, attemptId);
  }
  async function validate() {
    await learningAdmission.validate();
    const { rows } = await storage.read('SELECT body FROM model_attempts');
    for (const row of rows) {
      const body = modelAttemptSchema.parse(row.body);
      await storage.readResource(body.requestRef);
      if (body.resultRef) {
        const bytes = await storage.readResource(body.resultRef);
        if (body.state === 'completed' && body.connection.protocol === 'responses') {
          await responsesResult(body, bytes);
        }
        if (body.state === 'completed' && body.connection.protocol === 'messages') {
          const request = JSON.parse(Buffer.from(await storage.readResource(body.requestRef)).toString('utf8')) as MessagesPayload;
          const tools = request.tools?.map(tool => {
            if (!('input_schema' in tool)) throw new StorageError('corrupt');
            return { name: tool.name, description: tool.description ?? '', inputSchema: tool.input_schema };
          }) ?? [];
          validateMessagesNative(JSON.parse(Buffer.from(bytes).toString('utf8')), tools);
        }
      }
      if (body.state === 'completed' && !body.resultRef) throw new StorageError('corrupt');
    }
  }
  return { receive, read, list, requestPayload, progress, summary, dispatch, cancel, validate,
    cleanup: { status: cleanupStatus, cancel: (scope: ModelCleanupScope, id: string) => cancelCleanup(scope, id) },
    closeAdmission() { admissionClosed = true; },
    closeDispatch() { closed = true; },
    async drain() {
      // Leave time in the runtime's 30-second maintenance window for durable result publication.
      const interrupt = setTimeout(() => {
        for (const { controller } of active.values()) controller.abort('maintenance');
      }, 20_000);
      try {
        await settleTicketWithdrawals();
        await settleUnsentClaims();
        await settleRevocations();
        while (starting || active.size) {
          await Promise.allSettled([...active.values()].map(value => value.task));
          if (starting) await new Promise(resolve => setTimeout(resolve, 5));
        }
        await settleUnsentClaims();
        await settleRevocations();
        await settleTicketWithdrawals();
        if (unsentClaims.size || revocations.size || ticketWithdrawals.size) throw new StorageError('resource-busy');
        await reconcileEndedDispatchers();
        // The local task map cannot account for abandoned claims or another host's dispatcher.
        const { rows } = await storage.read('SELECT id FROM model_attempts WHERE physical_ended=false LIMIT 1');
        if (rows.length) throw new StorageError('resource-busy');
      } finally { clearTimeout(interrupt); }
    },
    resume() { closed = false; admissionClosed = false; } };
}
