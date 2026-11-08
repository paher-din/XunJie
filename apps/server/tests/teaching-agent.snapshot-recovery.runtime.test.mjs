import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { StorageError } from '@xunjie/storage';
import { executionActionSchema } from '@xunjie/contracts/execution';
import { fixture, reply, until } from './support/teaching-input-control.mjs';
import { runPublishedAggregation } from './support/teaching-recovery.mjs';

test('a lost snapshot upload acknowledgement retains its original context when an earlier operation completes before recovery',
  { timeout: 180000 }, async t => {
    const f = await fixture((_payload, response, index) => index === 1
      ? reply(response, { calls: [{ id: 'snapshot-original-aggregation', name: 'course_operation', arguments: {
        componentKey: 'table', operationId: 'aggregate', parameters: { groupColumn: '小组', valueColumn: '得分', aggregate: 'mean' } } }] })
      : reply(response, { text: index === 2 ? '先回答已固定的补充，原计算当时尚未完成。' : '现在根据原计算的新结果继续解释。' }));
    let cleanup = async () => {};
    try {
      const activity = await f.browserCourse(), c = await f.controlled(activity);
      const { identity, learning } = c, manifest = activity.course.components[0].definition.manifest;
      const work = { objectId: randomUUID(), contentId: randomUUID(), name: 'components/table.json', kind: 'state', encoding: 'json',
        mediaType: 'application/vnd.xunjie.component-state+json', value: JSON.stringify({ formatVersion: 1,
          instanceId: activity.activityId + ':table', componentId: manifest.componentId, version: manifest.version,
          definitionDigest: activity.course.components[0].definition.digest, stateVersion: 1,
          operationId: randomUUID(), content: manifest.initialState }) };
      await learning.works.sync(identity, activity.activityId, { requestId: randomUUID(), baseRevision: 0, files: [work] });
      let armed = false, lostSnapshot, lostBytes;
      const uploadAttempts = [];
      // The only injected fault is at the agreed resource owner boundary, after the real durable upload.
      const storage = { ...c.storage, async stageResource(input) {
        const snapshot = input.scope.startsWith('teaching-snapshot:') ? JSON.parse(Buffer.from(input.bytes).toString()) : null;
        if (snapshot && (armed || snapshot.snapshotId === lostSnapshot?.snapshotId))
          uploadAttempts.push({ uploadId: input.uploadId, sha256: createHash('sha256').update(input.bytes).digest('hex'),
            waits: snapshot.contextManifest.items.filter(item => item.kind === 'wait').map(item => item.content.state),
            effects: snapshot.contextManifest.items.filter(item => item.kind === 'effect').map(item => item.content.outcome.state) });
        const result = await c.storage.stageResource(input);
        if (snapshot && armed) {
          armed = false; lostSnapshot = snapshot; lostBytes = Buffer.from(input.bytes);
          throw new StorageError('resource-busy');
        }
        return result;
      } };
      let agent = c.makeAgent({}, storage); agent.resume();
      const original = await c.send('运行真实分组计算，保留原对象。', undefined, [work], agent);
      const waiting = await until(async () => {
        const value = await agent.conversation(identity, activity.activityId);
        return value.waits[0]?.state === 'pending' && value.runs[0]?.state === 'waiting' ? value : null;
      }, 'The original production course command is accepted and waiting.');
      const commandId = waiting.tools[0].commandId, browserId = randomUUID();
      const { action } = await learning.executions.agent.claimBrowser(identity, activity.activityId, commandId, browserId,
        association => agent.assertCommandDispatch(identity, activity.activityId, association));
      const accepted = await learning.executions.agent.acceptBrowser(identity, activity.activityId, commandId, browserId, {
        receipt: { requestId: commandId, receiver: action.receiver, state: 'accepted',
          inputDigest: createHash('sha256').update(JSON.stringify(executionActionSchema.parse(action))).digest('hex'),
          receiptId: 'snapshot-recovery:' + commandId, detail: '' },
        execution: { executionRef: randomUUID(), acceptedSeq: 1 },
      }, association => agent.assertCommandDispatch(identity, activity.activityId, association));
      // Execute the published Wasm once; hold only delivery of the real result to its owner.
      const { computed, resultInput } = await runPublishedAggregation(action, manifest);
      assert.equal(computed.result.value, 83.33333333333333);
      let delivered = false;
      const deliverResult = async () => {
        if (delivered) return;
        const result = await learning.executions.result(identity, activity.activityId, commandId, resultInput);
        await learning.executions.report(identity, activity.activityId, commandId, { ...result, state: 'succeeded', confirmedSeq: 3 });
        delivered = true;
      };
      cleanup = deliverResult;
      armed = true;
      const steering = await c.send('计算仍在等待时，先解释这个固定问题。', undefined, [work], agent);
      assert.equal(steering.runId, original.runId);
      const paused = await until(async () => {
        const run = await agent.run(identity, activity.activityId, original.runId);
        return lostSnapshot && run.state === 'paused' ? run : null;
      }, 'The snapshot bytes commit but the acknowledgement is lost before model dispatch.');
      assert.equal(paused.reason, 'resource-busy'); assert.equal(paused.attemptId, lostSnapshot.attemptId);
      assert.equal(f.payloads.length, 1, 'The interrupted next step has not dispatched a model request.');
      const received = await c.models.checks.read(identity, lostSnapshot.attemptId);
      assert.equal(received.state, 'accepted'); assert.equal(received.dispatched, false);
      assert.ok(lostSnapshot.contextManifest.items.some(item => item.kind === 'wait' && item.content.state === 'pending'));
      assert.ok(lostSnapshot.contextManifest.items.some(item => item.kind === 'effect' && item.content.outcome.state === 'accepted'));
      await deliverResult();
      const settled = await until(async () => {
        const value = await agent.conversation(identity, activity.activityId);
        return value.waits[0]?.state === 'consumed' && value.tools[0]?.outcome === 'completed' ? value : null;
      }, 'The original execution completes and its Wait changes before snapshot recovery.');
      assert.equal(settled.runs[0].state, 'paused'); assert.equal(settled.tools[0].commandId, commandId);
      agent.close(); await agent.drain();
      agent = c.makeAgent({}, storage);
      const continued = await agent.continueRun(identity, activity.activityId, original.runId, {
        version: 2, requestId: randomUUID(), inputs: [],
      });
      assert.equal(continued.runId, original.runId);
      agent.resume();
      const final = await until(async () => {
        const run = await agent.run(identity, activity.activityId, original.runId);
        return ['completed', 'paused', 'failed', 'stopped'].includes(run.state) ? run : null;
      }, 'The original attempt must recover without changing its fixed snapshot.');
      t.diagnostic('Snapshot resource boundary attempts: ' + JSON.stringify(uploadAttempts));
      assert.equal(final.state, 'completed', 'Original snapshot recovery paused with: ' + final.reason);
      const restored = await agent.snapshot(identity, activity.activityId, lostSnapshot.snapshotId);
      assert.deepEqual(restored, lostSnapshot, 'The public snapshot keeps the content accepted before the late result.');
      assert.ok(uploadAttempts.length >= 2, 'The original snapshot upload must be retried after its acknowledgement is lost.');
      const originalUpload = uploadAttempts[0], originalSha256 = createHash('sha256').update(lostBytes).digest('hex');
      for (const upload of uploadAttempts) {
        assert.equal(upload.uploadId, originalUpload.uploadId, 'Recovery reuses the original upload identity.');
        assert.equal(upload.sha256, originalSha256, 'Every upload retry preserves the original bytes.');
      }
      assert.equal(restored.attemptId, paused.attemptId);
      assert.deepEqual(restored.payload, f.payloads[1]);
      assert.ok(!JSON.stringify(restored.payload).includes('83.33333333333333'), 'The old request cannot retroactively consume the late result.');
      const conversation = await agent.conversation(identity, activity.activityId);
      assert.equal(conversation.tools.length, 1); assert.equal(conversation.tools[0].commandId, commandId);
      assert.equal(conversation.tools[0].outcome, 'completed');
      assert.equal(conversation.waits[0].waitId, waiting.waits[0].waitId);
      assert.equal((await learning.executions.read(identity, activity.activityId, commandId)).executionRef, accepted.executionRef);
      assert.equal(f.payloads.length, 3, 'Only the original call, the recovered attempt and the later result observation run.');
      assert.ok(JSON.stringify(f.payloads[2]).includes('83.33333333333333'));
      const events = await agent.events(identity, activity.activityId);
      assert.equal(events.filter(event => event.kind === 'context-assembled' && event.body.attemptId === paused.attemptId).length, 1);
      assert.deepEqual(final.usage, { state: 'final', inputTokens: 60, outputTokens: 30, totalTokens: 90 });
      assert.deepEqual(f.failures, []);
    } finally { try { await cleanup(); } finally { await f.close(); } }
  });
