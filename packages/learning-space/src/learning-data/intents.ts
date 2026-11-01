import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { StorageError } from '@xunjie/storage';
import type { Migration, OwnedStorage } from '@xunjie/storage';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import type { LearningActivity } from '@xunjie/contracts/learning-data';
import { actionDependencies, actionInputSchema, actionViewSchema, actionReceiptSchema, actionReceiverSchema } from '@xunjie/contracts/action-intents';
import type { ActionInput, ActionView, ActionReceiver } from '@xunjie/contracts/action-intents';
import type { createWorks } from './works.js';
import type { createQuestionDrafts } from './drafts.js';
import { referenceTextSelection } from '../reference-text.js';

export const actionIntentMigration: Migration = { version: 5, name: 'durable-action-intents', sql: `
  CREATE TABLE action_intents(request_id uuid PRIMARY KEY,activity_id uuid NOT NULL REFERENCES activities(id),
    input_digest text NOT NULL,body jsonb NOT NULL,state text NOT NULL CHECK(state IN ('prepared','dispatched','accepted','cancelled','failed')),
    cancel_requested boolean NOT NULL DEFAULT false,receipt jsonb);
  CREATE INDEX action_intents_activity ON action_intents(activity_id);
` };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface ActionIntentOptions {
  receivers?: readonly ActionReceiver[];
  /** The evidence owner verifies scope/version and idempotently retains it for this action identity. */
  retainEvidence?(identity: SpaceIdentity, activityId: string, evidence: ActionInput['evidence'][number], requestId: string): Promise<void>;
}
const dispatchLifetimes = new WeakMap<OwnedStorage, { closed: boolean; active: Map<string, Promise<ActionView>> }>();
function lifetime(storage: OwnedStorage) {
  let value = dispatchLifetimes.get(storage);
  if (!value) { value = { closed: false, active: new Map() }; dispatchLifetimes.set(storage, value); }
  return value;
}
function view(row: Record<string, unknown>): ActionView {
  const input = actionInputSchema.parse(row.body);
  return actionViewSchema.parse({ input, inputDigest: row.input_digest, dependencies: actionDependencies(input),
    state: row.state, cancelRequested: row.cancel_requested, receipt: row.receipt ?? null });
}
export function createActionIntents(storage: OwnedStorage, options: {
  activity(identity: SpaceIdentity, activityId: string): Promise<LearningActivity>;
  works: ReturnType<typeof createWorks>; drafts: ReturnType<typeof createQuestionDrafts>;
} & ActionIntentOptions) {
  const { activity: authorize, works, drafts } = options;
  const dispatchLife = lifetime(storage);
  const receiverKey = (identity: ActionInput['receiver']) => JSON.stringify(actionReceiverSchema.parse(identity));
  const receivers = new Map((options.receivers ?? []).map(receiver => [receiverKey(receiver.identity), receiver]));
  if (receivers.size !== (options.receivers ?? []).length) throw new StorageError('identity-conflict');
  async function read(identity: SpaceIdentity, activityId: string, requestId: string) {
    await authorize(identity, activityId); z.uuid().parse(requestId);
    const { rows: [row] } = await storage.read('SELECT * FROM action_intents WHERE activity_id=$1 AND request_id=$2', [activityId, requestId]);
    return row ? view(row) : null;
  }
  async function list(identity: SpaceIdentity, activityId: string) {
    await authorize(identity, activityId);
    return (await storage.read('SELECT * FROM action_intents WHERE activity_id=$1 ORDER BY request_id', [activityId])).rows.map(view);
  }
  async function prepare(identity: SpaceIdentity, activityId: string, value: unknown) {
    await authorize(identity, activityId);
    const input = actionInputSchema.parse(value), inputDigest = digest(input);
    if (input.scope.activityId !== activityId || input.scope.environmentId !== identity.environmentId
      || input.scope.spaceId !== identity.spaceId || input.scope.principalId !== identity.principalId) throw new StorageError('forbidden');
    const previous = await read(identity, activityId, input.requestId);
    if (previous) {
      if (previous.inputDigest !== inputDigest) throw new StorageError('identity-conflict');
      return previous;
    }
    // Immutable bases are independent from mutable work/draft heads; later edits cannot starve this action.
    for (const file of input.works) await works.registerBasis(identity, activityId, file);
    await drafts.verifyReferences(identity, activityId, input.draft);
    for (const evidence of input.evidence) {
      if (!options.retainEvidence) throw new StorageError('unavailable');
      await options.retainEvidence(identity, activityId, evidence, input.requestId);
    }
    await storage.request({ requestId: 'action-prepare:' + input.requestId,
      fingerprint: digest({ identity, activityId, input }) }, async tx => {
      await tx.query('INSERT INTO action_intents(request_id,activity_id,input_digest,body,state) VALUES($1,$2,$3,$4,$5)',
        [input.requestId, activityId, inputDigest, JSON.stringify(input), 'prepared']);
      for (const file of input.works) await tx.reference(`action/${input.requestId}/work/${file.contentId}`, file.contentId);
      for (const reference of input.draft.references) if (reference.source.kind === 'work')
        await tx.reference(`action/${input.requestId}/reference/${reference.referenceId}`, reference.source.contentId);
      return { requestId: input.requestId, inputDigest };
    });
    return (await read(identity, activityId, input.requestId))!;
  }
  async function update(activityId: string, requestId: string, change: (current: ActionView) => ActionView) {
    const result = await storage.request({ requestId: 'action-state:' + randomUUID(), fingerprint: requestId }, async tx => {
      const { rows: [row] } = await tx.query('SELECT * FROM action_intents WHERE activity_id=$1 AND request_id=$2 FOR UPDATE', [activityId, requestId]);
      if (!row) throw new StorageError('missing');
      const next = actionViewSchema.parse(change(view(row)));
      await tx.query('UPDATE action_intents SET state=$2,cancel_requested=$3,receipt=$4 WHERE request_id=$1',
        [requestId, next.state, next.cancelRequested, next.receipt ? JSON.stringify(next.receipt) : null]);
      return next;
    });
    return actionViewSchema.parse(result.result);
  }
  async function applyReceipt(activityId: string, current: ActionView, value: unknown) {
    const receipt = actionReceiptSchema.parse(value);
    if (receipt.requestId !== current.input.requestId || receipt.inputDigest !== current.inputDigest
      || receiverKey(receipt.receiver) !== receiverKey(current.input.receiver)) throw new StorageError('corrupt');
    return update(activityId, current.input.requestId, saved => {
      if (saved.state !== 'dispatched') return saved;
      return { ...saved, state: receipt.state === 'rejected' ? 'failed' : receipt.state, receipt };
    });
  }
  async function dispatch(identity: SpaceIdentity, activityId: string, requestId: string): Promise<ActionView> {
    // Authorization is checked even when joining an already admitted request.
    await authorize(identity, activityId); z.uuid().parse(requestId);
    if (dispatchLife.closed) throw new StorageError('maintenance');
    if (!await read(identity, activityId, requestId)) throw new StorageError('missing');
    const active = dispatchLife.active.get(requestId);
    if (active) return active;
    const task = deliver();
    dispatchLife.active.set(requestId, task);
    try { return await task; } finally { dispatchLife.active.delete(requestId); }
    async function deliver() {
      let current = await read(identity, activityId, requestId);
      if (!current) throw new StorageError('missing');
      if (!['prepared', 'dispatched'].includes(current.state)) return current;
      const receiver = receivers.get(receiverKey(current.input.receiver));
      if (!receiver) throw new StorageError('unavailable');
      await storage.pendingIntents(); // checks the storage dispatch gate and generation
      if (dispatchLife.closed) throw new StorageError('maintenance');
      const wasDispatched = current.state === 'dispatched';
      current = await update(activityId, requestId, saved => saved.state === 'prepared' ? { ...saved, state: 'dispatched' } : saved);
      if (current.state !== 'dispatched') return current;
      try {
        if (wasDispatched) {
          const known = await receiver.query(requestId, current.inputDigest);
          if (known) return applyReceipt(activityId, current, known);
        }
        current = (await read(identity, activityId, requestId))!;
        if (current.state !== 'dispatched') return current;
        // The admitted invocation may have awaited I/O while maintenance closed dispatch.
        if (dispatchLife.closed) return current;
        if (current.cancelRequested) {
          const cancelled = await receiver.cancel(requestId, current.inputDigest);
          return cancelled ? await applyReceipt(activityId, current, cancelled) : current;
        }
        const receipt = await receiver.accept(current.input, current.inputDigest);
        return await applyReceipt(activityId, current, receipt);
      } catch (error) {
        if (error instanceof z.ZodError || error instanceof StorageError && error.code === 'corrupt') throw new StorageError('corrupt');
        // A network error is not a rejection. Preserve the original dispatched identity.
        return (await read(identity, activityId, requestId))!;
      }
    }
  }
  async function cancel(identity: SpaceIdentity, activityId: string, requestId: string) {
    await authorize(identity, activityId); z.uuid().parse(requestId);
    const current = await update(activityId, requestId, saved => saved.state === 'prepared'
      ? { ...saved, state: 'cancelled', cancelRequested: true }
      : saved.state === 'dispatched' ? { ...saved, cancelRequested: true } : saved);
    if (current.state !== 'dispatched' || dispatchLife.closed) return current;
    const receiver = receivers.get(receiverKey(current.input.receiver));
    if (!receiver) return current;
    const key = requestId + ':cancel';
    const previous = dispatchLife.active.get(key);
    if (previous) return previous;
    const task = reconcileCancel();
    dispatchLife.active.set(key, task);
    try { return await task; } finally { dispatchLife.active.delete(key); }
    async function reconcileCancel() {
      try {
        await storage.pendingIntents();
        const known = await receiver!.query(requestId, current.inputDigest);
        if (known) return await applyReceipt(activityId, current, known);
        if (dispatchLife.closed) return current;
        const receipt = await receiver!.cancel(requestId, current.inputDigest);
        return receipt ? await applyReceipt(activityId, current, receipt) : current;
      } catch (error) {
        if (error instanceof z.ZodError || error instanceof StorageError && error.code === 'corrupt') throw new StorageError('corrupt');
        return (await read(identity, activityId, requestId))!;
      }
    }
  }
  return { prepare, read, list, dispatch, cancel, capabilities: async (identity: SpaceIdentity, activityId: string) => {
    await authorize(identity, activityId); return [...receivers.values()].map(receiver => actionReceiverSchema.parse(receiver.identity));
  }, closeDispatch() { dispatchLife.closed = true; },
  async drain() {
    const deadline = Date.now() + 10000;
    while (dispatchLife.active.size) {
      if (Date.now() >= deadline) throw new StorageError('maintenance');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }, resume() { dispatchLife.closed = false; } };
}

export async function validateActionIntents(storage: OwnedStorage) {
  const { rows } = await storage.read('SELECT * FROM action_intents');
  for (const row of rows) {
    const intent = view(row);
    const { rows: [activity] } = await storage.read('SELECT body FROM activities WHERE id=$1', [row.activity_id]);
    const body = activity?.body as LearningActivity | undefined, scope = intent.input.scope;
    if (!body || scope.activityId !== row.activity_id || scope.environmentId !== body.identity.environmentId
      || scope.spaceId !== body.identity.spaceId || scope.principalId !== body.identity.principalId
      || intent.input.requestId !== row.request_id || digest(intent.input) !== intent.inputDigest) throw new StorageError('corrupt');
    for (const file of [...intent.input.works, ...intent.input.draft.bases]) {
      const { rows: [content] } = await storage.read(`SELECT c.activity_id,c.object_id,c.encoding,c.media_type,o.kind,o.activity_id AS object_activity
        FROM work_contents c JOIN work_objects o ON o.object_id=c.object_id WHERE content_id=$1`, [file.contentId]);
      if (!content || content.activity_id !== row.activity_id || content.object_id !== file.objectId
        || content.object_activity !== row.activity_id || content.kind !== file.kind || content.encoding !== file.encoding
        || content.media_type !== file.mediaType) throw new StorageError('corrupt');
      const bytes = Buffer.from(await storage.readResource(file.contentId));
      if (bytes.toString(file.encoding === 'base64' ? 'base64' : 'utf8') !== file.value) throw new StorageError('corrupt');
    }
    for (const reference of intent.input.draft.references) {
      const source = reference.source;
      if (source.kind === 'work') {
        const { rows: [content] } = await storage.read(`SELECT c.activity_id,c.object_id,c.encoding,o.kind FROM work_contents c
          JOIN work_objects o ON o.object_id=c.object_id WHERE content_id=$1`, [source.contentId]);
        if (!content || content.activity_id !== row.activity_id || content.object_id !== source.objectId || content.encoding !== 'utf8'
          || (reference.range.kind === 'code') !== (content.kind === 'code')) throw new StorageError('corrupt');
        const text = Buffer.from(await storage.readResource(source.contentId)).toString('utf8');
        if (referenceTextSelection(text, reference.range) !== reference.copy) throw new StorageError('corrupt');
      } else if (!body.course || source.courseId !== body.course.courseId || source.taskId !== body.course.taskId
        || source.releaseId !== body.course.releaseId || source.contentDigest !== body.course.contentDigest) throw new StorageError('corrupt');
    }
  }
}
