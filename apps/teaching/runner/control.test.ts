import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { test } from 'node:test';
import { RunControl } from './control.ts';
import type { RunIdentity } from './control.ts';
import { sha256 } from './snapshot.ts';

const identity = (id: string, attemptId = id): RunIdentity => ({ runId: id, commandId: `command-${id}`,
  requestHash: sha256(id), recoveryGeneration: 'generation-1',
  snapshotId: 'synthetic-snapshot', snapshotHash: sha256('snapshot'), inputHash: sha256('input'),
  runtimeProfileVersion: 'synthetic-profile', imageDigest: `sha256:${sha256('image')}`,
  authorizedScope: { userId: 'student-1', courseId: 'course-1', attemptId, purpose: 'student_run' } });
const authorize = (actor: unknown) => actor === 'owner';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function eventually(condition: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (await condition()) return;
    await setTimeout(5);
  }
  assert.fail('Control did not reach expected state');
}

test('node-local control synthetic checks', { skip: process.platform !== 'linux' }, async t => {
  await t.test('parallel identical submit starts once and asynchronous ACL cannot create a race', async () => {
    const root = mkdtempSync(join(tmpdir(), 'xunjie-c1-control-'));
    const control = new RunControl(root, 'generation-1', async actor => { await setTimeout(1); return authorize(actor); }, async () => true);
    let starts = 0;
    const work = async () => { starts++; await setTimeout(10); return { unitTerminated: true, source: 'synthetic' }; };
    await Promise.all(Array.from({ length: 10 }, () => control.submitRun('owner', identity('repeat'), work)));
    await eventually(async () => (await control.queryRun('owner', identity('repeat')))?.state === 'succeeded');
    assert.equal(starts, 1);
    await assert.rejects(control.submitRun('owner', { ...identity('repeat'), requestHash: sha256('different') }, work), /mismatch/);
    await assert.rejects(control.queryRun('other', identity('repeat')), /denied/);
    await assert.rejects(control.queryRun('owner', { ...identity('repeat'), recoveryGeneration: 'old' }), /generation/);
    control.close();
    const restored = new RunControl(root, 'generation-1', authorize, async () => true);
    await restored.submitRun('owner', identity('repeat'), work);
    assert.equal(starts, 1);
    assert((await restored.queryRun('owner', identity('repeat')))?.resultRef);
    assert.deepEqual(await restored.readResult('owner', identity('repeat')), { unitTerminated: true, source: 'synthetic' });
    await assert.rejects(restored.readResult('other', identity('repeat')), /denied/);
    restored.close();
  });
  await t.test('cancel-before-submit is durable and never creates a new unit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'xunjie-c1-pre-cancel-'));
    let starts = 0;
    let control = new RunControl(root, 'generation-1', authorize, async () => true);
    await control.cancelRun('owner', identity('pre-cancel'));
    control.close();
    control = new RunControl(root, 'generation-1', authorize, async () => true);
    await control.submitRun('owner', identity('pre-cancel'), async () => { starts++; return { unitTerminated: true }; });
    assert.equal(starts, 0);
    assert.equal((await control.queryRun('owner', identity('pre-cancel')))?.state, 'cancelled');
    const before = readFileSync(join(root, 'ledger.jsonl'), 'utf8');
    await control.cancelRun('owner', identity('pre-cancel'));
    assert.equal(readFileSync(join(root, 'ledger.jsonl'), 'utf8'), before);
    control.close();
  });
  await t.test('two slots and one attempt guard include unresolved create operations', async () => {
    const root = mkdtempSync(join(tmpdir(), 'xunjie-c1-slots-'));
    const control = new RunControl(root, 'generation-1', authorize, async () => true);
    const pending = deferred<{ unitTerminated: boolean }>();
    let thirdStarted = false;
    await control.submitRun('owner', identity('one'), async (_signal, phase) => phase('xunjie-one', () => pending.promise));
    await control.submitRun('owner', identity('two'), async (_signal, phase) => phase('xunjie-two', () => pending.promise));
    await control.submitRun('owner', identity('three'), async () => { thirdStarted = true; return { unitTerminated: true }; });
    await eventually(async () => (await control.queryRun('owner', identity('two')))?.pending.length === 1);
    await assert.rejects(control.submitRun('owner', identity('duplicate-attempt', 'one'), async () => ({ unitTerminated: true })), /unsettled/);
    assert.equal((await control.queryRun('owner', identity('three')))?.state, 'queued');
    const stopped = await control.cancelRun('owner', identity('one'));
    assert.equal(stopped?.state, 'cancelling');
    assert.equal(stopped?.reserved, true);
    assert.equal(thirdStarted, false);
    pending.resolve({ unitTerminated: true });
    await eventually(async () => (await control.queryRun('owner', identity('one')))?.state === 'cancelled');
    await eventually(async () => (await control.queryRun('owner', identity('three')))?.state === 'succeeded');
    await eventually(async () => (await control.queryRun('owner', identity('two')))?.state === 'succeeded');
    control.close();
  });
  await t.test('ACL revoked while queued is checked again before dispatch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'xunjie-c1-dispatch-'));
    const control = new RunControl(root, 'generation-1', (() => {
      let calls = 0;
      return (_actor, _identity, action) => action !== 'submit' || ++calls === 1;
    })(), async () => true);
    let started = false;
    await control.submitRun('owner', identity('revoked'), async () => { started = true; return { unitTerminated: true }; });
    await eventually(async () => (await control.queryRun('owner', identity('revoked')))?.state === 'failed');
    assert.equal(started, false);
    control.close();
  });
  await t.test('process crash keeps pending creation unknown and never releases its slot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'xunjie-c1-crash-'));
    const moduleUrl = new URL('./control.ts', import.meta.url).href;
    const script = `
      const { RunControl } = await import(process.argv[1]);
      const identity = JSON.parse(process.argv[3]);
      const control = new RunControl(process.argv[2], 'generation-1', () => true, async () => true);
      await control.submitRun('owner', identity, async (_signal, phase) => {
        await phase('xunjie-pending', async () => { process.exit(0); });
        return { unitTerminated: true };
      });
    `;
    execFileSync(process.execPath, ['--input-type=module', '-e', script, moduleUrl, root, JSON.stringify(identity('crash'))]);
    const control = new RunControl(root, 'generation-1', authorize, async () => true);
    assert.equal((await control.queryRun('owner', identity('crash')))?.state, 'outcome_unknown');
    const cancelled = await control.cancelRun('owner', identity('crash'));
    assert.equal(cancelled?.state, 'cancelling');
    assert.equal(cancelled?.reserved, true);
    assert.equal(cancelled?.pending.length, 1);
    assert.throws(() => control.close(), /Unsettled/);
  });
  await t.test('corrupt/partial journal and different node generation stop admission', () => {
    const root = mkdtempSync(join(tmpdir(), 'xunjie-c1-corrupt-'));
    const control = new RunControl(root, 'generation-1', authorize, async () => true);
    control.close();
    assert.throws(() => new RunControl(root, 'generation-2', authorize, async () => true), /generation reconciliation/);
    appendFileSync(join(root, 'ledger.jsonl'), '{partial');
    assert.throws(() => new RunControl(root, 'generation-1', authorize, async () => true), /Incomplete execution ledger/);
  });
  await t.test('credentials or source bodies cannot be copied into control metadata', async () => {
    const root = mkdtempSync(join(tmpdir(), 'xunjie-c1-metadata-'));
    const control = new RunControl(root, 'generation-1', authorize, async () => true);
    const poisoned = { ...identity('poisoned'), token: 'synthetic-placeholder' };
    await assert.rejects(control.submitRun('owner', poisoned, async () => ({ unitTerminated: true })), /approved control metadata/);
    assert(!readFileSync(join(root, 'ledger.jsonl'), 'utf8').includes('synthetic-placeholder'));
    control.close();
  });
  await t.test('generation advance needs trusted registration, refuses rollback and survives ordinary restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'xunjie-c1-generation-'));
    const control = new RunControl(root, 'generation-1', authorize, async () => true, actor => actor === 'recovery-owner');
    await control.cancelRun('owner', identity('old-run'));
    await assert.rejects(control.advanceGeneration('owner', 'generation-2'), /Trusted recovery/);
    await control.advanceGeneration('recovery-owner', 'generation-2');
    await assert.rejects(control.queryRun('owner', identity('old-run')), /Stale control generation/);
    assert.equal((await control.queryRun('owner', { ...identity('old-run'), recoveryGeneration: 'generation-2' }))?.state, 'cancelled');
    await assert.rejects(control.advanceGeneration('recovery-owner', 'generation-1'), /older generation/);
    control.close();
    const restarted = new RunControl(root, 'generation-2', authorize, async () => true);
    assert.equal((await restarted.queryRun('owner', { ...identity('old-run'), recoveryGeneration: 'generation-2' }))?.state, 'cancelled');
    restarted.close();
  });
  await t.test('preparation failure before any unit intent does not occupy a phantom slot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'xunjie-c1-prepare-failure-'));
    const control = new RunControl(root, 'generation-1', authorize, async () => false);
    await control.submitRun('owner', identity('prepare-error'), async () => { throw new Error('synthetic preparation failure'); });
    await eventually(async () => (await control.queryRun('owner', identity('prepare-error')))?.state === 'failed');
    assert.equal((await control.queryRun('owner', identity('prepare-error')))?.reserved, false);
    control.close();
  });
  await t.test('confirmed recovery wins completion race and cancelled result remains readable', async () => {
    const root=mkdtempSync(join(tmpdir(),'xunjie-c1-reconcile-'));
    const control=new RunControl(root,'generation-1',authorize,async()=>false);
    const pending=deferred<{unitTerminated:boolean;source:string}>();
    const id=identity('reconcile');
    await control.submitRun('owner',id,async(_signal,phase)=>phase('xunjie-reconcile',()=>pending.promise));
    await eventually(async()=>(await control.queryRun('owner',id))?.pending.length===1);
    await control.cancelRun('owner',id);
    assert.equal((await control.reconcileRun('owner',id,async()=>({unitTerminated:false})))?.reserved,true);
    const outcome={unitTerminated:true,source:'synthetic-independent-worker'};
    assert.equal((await control.reconcileRun('owner',id,async()=>outcome))?.state,'cancelled');
    pending.resolve(outcome);
    await setTimeout(20);
    assert.equal((await control.queryRun('owner',id))?.reserved,false);
    assert.deepEqual(await control.readResult('owner',id),outcome);
    control.close();
  });
  await t.test('old queued work becomes stale after trusted generation registration',async()=>{
    const root=mkdtempSync(join(tmpdir(),'xunjie-c1-stale-'));
    const control=new RunControl(root,'generation-1',authorize,async()=>true,actor=>actor==='recovery-owner');
    control.setDispatchPaused(true);let starts=0;
    await control.submitRun('owner',identity('queued'),async()=>{starts++;return {unitTerminated:true};});
    assert.equal(control.queuedIdentities().length,1);
    await control.advanceGeneration('recovery-owner','generation-2');
    control.setDispatchPaused(false);
    const id={...identity('queued'),recoveryGeneration:'generation-2'};
    assert.equal((await control.queryRun('owner',id))?.state,'stale');
    assert.equal(starts,0);control.close();
  });
});
