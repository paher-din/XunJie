import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { StorageError } from '@xunjie/storage';
import { actionInputSchema } from '@xunjie/contracts/action-intents';
import { fixture, until } from './support/teaching-input-control.mjs';

// Production configuration seam: the Gateway commits the real segment; only its reply is lost.
// Acceptance and assertions use public owner methods, actual model payloads and immutable snapshots.
test('first-step segment receipt recovery refreshes Skills eligibility after disable without reinjecting the received body',
  { timeout: 180000 }, async () => {
    const guidance = 'DISABLED_GUIDANCE_MUST_NOT_BE_REINJECTED_217';
    const f = await fixture();
    try {
      const activity = await f.activity('首次段回执丢失后的 Skill 停用'), c = await f.controlled(activity);
      const creates = [];
      let lose = true;
      const models = { ...c.models, segments: { ...c.models.segments, async create(identity, input) {
        const created = await c.models.segments.create(identity, input);
        creates.push(structuredClone(input));
        if (lose) { lose = false; throw new StorageError('resource-busy'); }
        return created;
      } } };
      const first = c.makeAgent({ models });
      const imported = await first.skills.import(c.identity, { requestId: randomUUID(),
        source: 'acceptance:217-initial-receipt', packageVersion: '1.0.0', files: [{
          path: 'SKILL.md', encoding: 'utf8', content: ['---', 'name: initial-receipt-guidance',
            'description: 首次段恢复资格验收', '---', guidance].join('\n'),
        }] });
      const references = [{ skillId: imported.skillId, version: imported.version }];
      const input = actionInputSchema.parse({ requestId: randomUUID(), scope: { environmentId: c.identity.environmentId,
        spaceId: c.identity.spaceId, principalId: c.identity.principalId, activityId: activity.activityId },
        receiver: first.receiver.identity, draft: { token: randomUUID(), question: '保留我的原问题，说明水位从12到37增加多少。',
          references: [], bases: [], skills: references }, works: [], evidence: [] });
      first.resume();
      const receipt = await first.accept(input, createHash('sha256').update(JSON.stringify(input)).digest('hex'));
      assert.equal(receipt.state, 'accepted');
      const { runId } = JSON.parse(receipt.detail);
      const paused = await until(async () => {
        const run = await first.run(c.identity, activity.activityId, runId);
        return run.state === 'paused' ? run : null;
      }, 'The actual initial segment commits before its create acknowledgement is lost.');
      assert.equal(paused.reason, 'resource-busy'); assert.equal(creates.length, 1); assert.equal(f.payloads.length, 0);
      assert.equal((await first.events(c.identity, activity.activityId)).filter(event => event.kind === 'context-assembled').length, 0,
        'This is first-step recovery, before any model step snapshot or provider request.');
      const native = await c.models.segments.read(c.identity, creates[0].segmentId);
      assert.equal(native.segmentId, creates[0].segmentId);
      const disabled = await first.skills.disable(c.identity, { requestId: randomUUID(), skillId: imported.skillId, disabled: true });
      assert.equal(disabled.disabled, true);
      first.closeDispatch(); first.close(); await first.drain();

      const restarted = c.makeAgent({ models }); restarted.resume();
      const continued = await restarted.continueRun(c.identity, activity.activityId, runId,
        { version: 2, requestId: randomUUID(), inputs: [] });
      assert.equal(continued.runId, runId);
      const completed = await until(async () => {
        const run = await restarted.run(c.identity, activity.activityId, runId);
        if (['paused', 'failed', 'stopped'].includes(run.state)) throw new Error('The optional disabled Skill prevented recovery: ' + run.reason);
        return run.state === 'completed' ? run : null;
      }, 'The same original Run recovers without injecting optional disabled guidance.');
      assert.equal(completed.segmentId, creates[0].segmentId); assert.equal(creates.length, 1);
      assert.equal(f.payloads.length, 1);
      assert.doesNotMatch(JSON.stringify(f.payloads[0]), new RegExp(guidance), 'A received assembly is not current permission to inject a disabled body.');
      assert.match(JSON.stringify(f.payloads[0]), /水位从12到37/);
      const events = await restarted.events(c.identity, activity.activityId);
      const assembled = events.filter(event => event.kind === 'context-assembled'); assert.equal(assembled.length, 1);
      const snapshot = await restarted.snapshot(c.identity, activity.activityId, assembled[0].body.snapshotId);
      assert.deepEqual(snapshot.payload, f.payloads[0]);
      assert.doesNotMatch(JSON.stringify(snapshot.contextManifest), new RegExp(guidance), 'The actual manifest cannot claim disabled guidance was included.');
      const original = snapshot.resolvedAgent.skills.catalog.find(entry => entry.skillId === imported.skillId && entry.version === imported.version);
      assert.equal(original.digest, imported.digest, 'The received immutable assembly remains inspectable.');
      assert.deepEqual(original.attachments, imported.attachments);
      const conversation = await restarted.conversation(c.identity, activity.activityId);
      assert.equal(conversation.runs.length, 1); assert.equal(conversation.runs[0].runId, runId);
      assert.deepEqual(conversation.inputs[0].input.draft, input.draft);
      assert.equal(conversation.tools.length, 0); assert.equal(conversation.waits.length, 0);
      assert.deepEqual(await restarted.snapshot(c.identity, activity.activityId, snapshot.snapshotId), snapshot);
      assert.equal(f.payloads.length, 1, 'Reading retained evidence never causes another model request.');
      assert.deepEqual(f.failures, []);
    } finally { await f.close(); }
  });
