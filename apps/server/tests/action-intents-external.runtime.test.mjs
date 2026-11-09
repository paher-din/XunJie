import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { provisionStorage, openStorage, createFileBackend, StorageError } from '@xunjie/storage';
import { actionInputSchema, actionReceiptSchema, actionViewSchema } from '@xunjie/contracts/action-intents';
import { activitySchema } from '@xunjie/contracts/learning-data';
import { nativeFixture } from '../../../packages/storage/test/native-fixture.mjs';
import { controlledActionReceiver } from './support/action-receiver.mjs';

// A standalone bundle can exercise these public methods without rebuilding shared dist.
const implementation = process.env.XUNJIE_ACTION_INTENTS_TEST_MODULE;
const { createActionIntents, actionIntentMigration, validateActionIntents } = await import(implementation
  ? pathToFileURL(implementation).href : '../../../packages/learning-space/dist/learning-data/intents.js');

test('school action intents record externally dispatched effects without calling a receiver', { timeout: 90000 }, async t => {
  const postgres = await nativeFixture(); t.after(() => postgres.close());
  async function fixture(t, extraOptions = {}) {
    const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
    const migrations = [{ version: 1, name: 'isolated-action-activity', sql: 'CREATE TABLE activities(id uuid PRIMARY KEY,body jsonb NOT NULL);' },
      { version: 2, name: 'isolated-action-intents', sql: actionIntentMigration.sql }];
    const binding = await provisionStorage({ admin: postgres.admin, owner, password: randomUUID(), migrations });
    const backend = createFileBackend({ id: 'files', root: join(postgres.root, owner.serviceId) });
    let storage = await openStorage({ binding, migrations, backend });
    t.after(() => storage.close());
    const identity = { environmentId: owner.environmentId, spaceId: randomUUID(), principalId: randomUUID(), kind: 'school', name: 'Student' };
    const activity = activitySchema.parse({ activityId: randomUUID(), identity, target: { ...owner, version: 1 }, goal: 'External dispatch',
      question: '', references: [], status: 'open', createdAt: new Date().toISOString() });
    await storage.request({ requestId: randomUUID(), fingerprint: 'activity' }, async tx => {
      await tx.query('INSERT INTO activities VALUES($1,$2)', [activity.activityId, JSON.stringify(activity)]); return null;
    });
    let actorActive = true, sourceActive = true, receiverCalls = 0;
    const receiver = { identity: { receiverId: 'local-agent-owner', location: 'local', kind: 'question' },
      accept() { receiverCalls++; throw new Error('School must not accept'); },
      query() { receiverCalls++; throw new Error('School must not query'); },
      cancel() { receiverCalls++; throw new Error('School must not cancel'); } };
    const authorized = [];
    const options = {
      async activity(actor, id) {
        if (!actorActive) throw new StorageError('forbidden');
        if (id !== activity.activityId || ['environmentId', 'spaceId', 'principalId'].some(key => actor[key] !== identity[key])) throw new StorageError('missing');
        return activity;
      },
      works: { registerBasis() { throw new Error('Unexpected works'); } },
      drafts: { async verifyReferences(_identity, _activityId, draft) { assert.deepEqual(draft.references, []); assert.deepEqual(draft.bases, []); } },
      receivers: [receiver],
      async receiversFor() { throw new Error('External dispatch must not resolve a server receiver'); },
      async authorizeExternal(actor, id, action, operation) {
        assert.deepEqual(actor, identity); assert.equal(id, activity.activityId);
        assert.deepEqual(action.input.receiver, receiver.identity);
        if (!sourceActive) throw new StorageError('forbidden');
        authorized.push(operation);
      },
      ...extraOptions,
    };
    let intents = createActionIntents(storage, options);
    const action = () => actionInputSchema.parse({ requestId: randomUUID(), scope: { environmentId: identity.environmentId,
      spaceId: identity.spaceId, principalId: identity.principalId, activityId: activity.activityId }, receiver: receiver.identity,
      draft: { token: randomUUID(), question: 'Run locally', references: [], bases: [] }, works: [], evidence: [] });
    async function prepare() { const input = action(); return intents.prepare(identity, activity.activityId, input); }
    const args = view => [identity, activity.activityId, view.input.requestId];
    const receipt = (view, state = 'accepted') => actionReceiptSchema.parse({ requestId: view.input.requestId, receiver: view.input.receiver,
      inputDigest: view.inputDigest, state, receiptId: randomUUID(), detail: '' });
    return { identity, activity, action, prepare, args, receipt, options, authorized,
      intents: () => intents, storage: () => storage, receiverCalls: () => receiverCalls,
      revokeActor() { actorActive = false; }, revokeSource() { sourceActive = false; }, restoreSource() { sourceActive = true; },
      async reopen() { await storage.close(); storage = await openStorage({ binding, migrations, backend }); intents = createActionIntents(storage, options); } };
  }

  await t.test('begin returns the canonical fixed ActionView and keeps the same dispatched identity after a real restart', async t => {
    const f = await fixture(t), prepared = await f.prepare(), args = f.args(prepared);
    const admitted = await f.intents().beginExternalDispatch(...args);
    assert.deepEqual(admitted, { ...prepared, state: 'dispatched' });
    assert.deepEqual(actionViewSchema.parse(admitted), admitted);
    assert.deepEqual(await f.intents().beginExternalDispatch(...args), admitted);
    await f.reopen();
    assert.deepEqual(await f.intents().beginExternalDispatch(...args), admitted);
    assert.deepEqual(await f.intents().read(...args), admitted);
    assert.equal(f.receiverCalls(), 0);
    await validateActionIntents(f.storage());
  });

  await t.test('only the original receipt can settle a dispatched action; duplicates are stable and confirmed facts cannot regress', async t => {
    const f = await fixture(t), prepared = await f.prepare(), args = f.args(prepared), receipt = f.receipt(prepared);
    await assert.rejects(f.intents().recordExternalReceipt(...args, receipt), { code: 'conflict' });
    await f.intents().beginExternalDispatch(...args);
    for (const change of [{ requestId: randomUUID() }, { inputDigest: 'f'.repeat(64) },
      { receiver: { ...receipt.receiver, receiverId: 'another-agent' } },
      { receiver: { ...receipt.receiver, location: 'remote' } }, { receiver: { ...receipt.receiver, kind: 'execution' } }]) {
      await assert.rejects(f.intents().recordExternalReceipt(...args, { ...receipt, ...change }), { code: 'identity-conflict' });
    }
    const accepted = await f.intents().recordExternalReceipt(...args, receipt);
    assert.equal(accepted.state, 'accepted'); assert.deepEqual(accepted.receipt, receipt);
    await f.reopen();
    assert.deepEqual(await f.intents().recordExternalReceipt(...args, receipt), accepted);
    assert.deepEqual(await f.intents().beginExternalDispatch(...args), accepted);
    assert.deepEqual(await f.intents().requestExternalCancellation(...args), accepted);
    for (const change of [{ receiptId: randomUUID() }, { state: 'cancelled' }, { state: 'rejected' }, { detail: 'changed' }]) {
      await assert.rejects(f.intents().recordExternalReceipt(...args, { ...receipt, ...change }), { code: 'identity-conflict' });
    }
    assert.deepEqual(await f.intents().read(...args), accepted);
    assert.equal(f.receiverCalls(), 0); await validateActionIntents(f.storage());
  });

  await t.test('pre-admission cancellation prevents accept and can attach only the original cancellation tombstone', async t => {
    const f = await fixture(t), prepared = await f.prepare(), args = f.args(prepared);
    const cancelled = await f.intents().requestExternalCancellation(...args);
    assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.cancelRequested, true); assert.equal(cancelled.receipt, null);
    assert.deepEqual(await f.intents().requestExternalCancellation(...args), cancelled);
    assert.deepEqual(await f.intents().beginExternalDispatch(...args), cancelled);
    await assert.rejects(f.intents().recordExternalReceipt(...args, f.receipt(prepared)), { code: 'conflict' });
    const receipt = f.receipt(prepared, 'cancelled');
    const settled = await f.intents().recordExternalReceipt(...args, receipt);
    assert.equal(settled.state, 'cancelled'); assert.equal(settled.cancelRequested, true);
    assert.deepEqual(await f.intents().recordExternalReceipt(...args, receipt), settled);
    assert.equal(f.receiverCalls(), 0); await validateActionIntents(f.storage());
  });

  await t.test('cancellation after admission remains unconfirmed until the original receiver settles it, including late acceptance', async t => {
    const f = await fixture(t);
    for (const state of ['accepted', 'cancelled', 'rejected']) {
      const prepared = await f.prepare(), args = f.args(prepared);
      await f.intents().beginExternalDispatch(...args);
      const requested = await f.intents().requestExternalCancellation(...args);
      assert.equal(requested.state, 'dispatched'); assert.equal(requested.cancelRequested, true); assert.equal(requested.receipt, null);
      assert.deepEqual(await f.intents().beginExternalDispatch(...args), requested);
      await f.reopen();
      const receipt = f.receipt(prepared, state);
      const settled = await f.intents().recordExternalReceipt(...args, receipt);
      assert.equal(settled.state, state === 'rejected' ? 'failed' : state);
      assert.equal(settled.cancelRequested, true);
      assert.deepEqual(await f.intents().recordExternalReceipt(...args, receipt), settled);
      assert.deepEqual(await f.intents().beginExternalDispatch(...args), settled);
    }
    assert.equal(f.receiverCalls(), 0); await validateActionIntents(f.storage());
  });

  await t.test('concurrent begin/cancel and record/cancel updates serialize without losing a receipt or cancellation', async t => {
    const f = await fixture(t);
    for (let n = 0; n < 8; n++) {
      const prepared = await f.prepare(), args = f.args(prepared);
      await Promise.all([f.intents().beginExternalDispatch(...args), f.intents().requestExternalCancellation(...args)]);
      const current = await f.intents().read(...args);
      assert.equal(current.cancelRequested, true); assert.ok(['dispatched', 'cancelled'].includes(current.state));
      assert.deepEqual(await f.intents().beginExternalDispatch(...args), current);
      const pending = await f.prepare(), pendingArgs = f.args(pending), receipt = f.receipt(pending);
      await f.intents().beginExternalDispatch(...pendingArgs);
      await Promise.all([f.intents().recordExternalReceipt(...pendingArgs, receipt), f.intents().requestExternalCancellation(...pendingArgs)]);
      const settled = await f.intents().read(...pendingArgs);
      assert.equal(settled.state, 'accepted'); assert.deepEqual(settled.receipt, receipt);
      assert.deepEqual(await f.intents().recordExternalReceipt(...pendingArgs, receipt), settled);
    }
    assert.equal(f.receiverCalls(), 0); await validateActionIntents(f.storage());
  });

  await t.test('lost local accept responses recover by querying the same local receiver; the school never redispatches', async t => {
    const local = controlledActionReceiver('local-agent-owner'); local.identity.location = 'local';
    const f = await fixture(t), prepared = await f.prepare(), args = f.args(prepared);
    const original = await f.intents().beginExternalDispatch(...args);
    local.loseNextReply();
    await assert.rejects(local.accept(original.input, original.inputDigest));
    await f.reopen();
    const retry = await f.intents().beginExternalDispatch(...args);
    assert.equal(retry.state, 'dispatched'); assert.deepEqual(retry.input, original.input); assert.equal(retry.receipt, null);
    const receipt = await local.query(retry.input.requestId, retry.inputDigest);
    const settled = await f.intents().recordExternalReceipt(...args, receipt);
    assert.equal(settled.state, 'accepted'); assert.deepEqual(local.acceptedIds(), [original.input.requestId]);
    assert.equal(f.receiverCalls(), 0);
  });

  await t.test('actor, activity and trusted external-source authorization run on every operation, including duplicates', async t => {
    const f = await fixture(t), prepared = await f.prepare(), args = f.args(prepared), receipt = f.receipt(prepared);
    await f.intents().beginExternalDispatch(...args);
    const calls = [() => f.intents().beginExternalDispatch(...args), () => f.intents().recordExternalReceipt(...args, receipt),
      () => f.intents().requestExternalCancellation(...args)];
    f.revokeSource();
    for (const operation of calls) await assert.rejects(operation(), { code: 'forbidden' });
    f.restoreSource();
    const accepted = await f.intents().recordExternalReceipt(...args, receipt);
    assert.equal(accepted.state, 'accepted');
    f.revokeSource();
    for (const operation of calls) await assert.rejects(operation(), { code: 'forbidden' });
    f.restoreSource();
    for (const name of ['beginExternalDispatch', 'recordExternalReceipt', 'requestExternalCancellation']) {
      const extra = name === 'recordExternalReceipt' ? [receipt] : [];
      await assert.rejects(f.intents()[name]({ ...f.identity, principalId: randomUUID() }, args[1], args[2], ...extra), { code: 'missing' });
      await assert.rejects(f.intents()[name](args[0], randomUUID(), args[2], ...extra), { code: 'missing' });
      await assert.rejects(f.intents()[name](args[0], args[1], randomUUID(), ...extra), { code: 'missing' });
    }
    f.revokeActor();
    for (const operation of calls) await assert.rejects(operation(), { code: 'forbidden' });
    assert.equal(f.receiverCalls(), 0);
  });

  await t.test('dispatch gates prohibit admission but permit cancellation and already received receipts to settle', async t => {
    const f = await fixture(t), prepared = await f.prepare(), args = f.args(prepared);
    await f.intents().beginExternalDispatch(...args);
    f.intents().closeDispatch();
    await assert.rejects(f.intents().beginExternalDispatch(...args), { code: 'maintenance' });
    await f.intents().requestExternalCancellation(...args);
    const settled = await f.intents().recordExternalReceipt(...args, f.receipt(prepared));
    assert.equal(settled.state, 'accepted'); assert.equal(settled.cancelRequested, true);
    f.intents().resume();
    await f.storage().participant().closeDispatch();
    const pending = await f.prepare();
    await assert.rejects(f.intents().beginExternalDispatch(...f.args(pending)), { code: 'maintenance' });
    await f.storage().participant().resume();
    assert.equal((await f.intents().beginExternalDispatch(...f.args(pending))).state, 'dispatched');
    assert.equal(f.receiverCalls(), 0);
  });

  await t.test('existing server dispatch/cancel still calls its registered receiver and recovers a lost reply', async t => {
    const local = controlledActionReceiver('local-agent-owner'); local.identity.location = 'local';
    const f = await fixture(t, { receivers: [local], receiversFor: undefined });
    const prepared = await f.prepare(), args = f.args(prepared);
    local.loseNextReply();
    assert.equal((await f.intents().dispatch(...args)).state, 'dispatched');
    const settled = await f.intents().dispatch(...args);
    assert.equal(settled.state, 'accepted'); assert.deepEqual(local.acceptedIds(), [prepared.input.requestId]);
    const cancelled = await f.prepare(), cancelledArgs = f.args(cancelled);
    await f.intents().cancel(...cancelledArgs);
    assert.equal((await f.intents().dispatch(...cancelledArgs)).state, 'cancelled');
    assert.equal(local.acceptedInput(cancelled.input.requestId), undefined);
    await validateActionIntents(f.storage());
  });
});
