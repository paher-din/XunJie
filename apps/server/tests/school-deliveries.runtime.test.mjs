import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { provisionStorage, openStorage, createFileBackend, StorageError } from '@xunjie/storage';
import { nativeFixture } from '../../../packages/storage/test/native-fixture.mjs';
import { activitySchema } from '@xunjie/contracts/learning-data';
import { schoolAcquisitionInputSchema, schoolSubmissionInputSchema } from '@xunjie/contracts/school-deliveries';
import { createSchoolDeliveries, schoolDeliveryMigration, validateSchoolDeliveries } from '../../../packages/learning-space/dist/learning-data/school-deliveries.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const textWork = (value = 'original\r\n中文\n') => ({ objectId: randomUUID(), contentId: randomUUID(), name: 'answer.txt',
  kind: 'text', encoding: 'utf8', mediaType: 'text/plain', value });
const artifact = () => ({ artifactId: randomUUID(), revisionId: randomUUID(), payload: { formatVersion: 1,
  title: 'Submitted interactive explanation', display: 'page', html: '<main id="answer">Original</main>',
  css: 'main { color: var(--ink); }', javascript: 'document.querySelector("main").textContent = "Original";',
  hostApiVersion: 1, stateVersion: 2, stateShape: { type: 'object', properties: { answer: { type: 'string', maxLength: 100 } } },
  initialState: { answer: 'my original answer' }, semanticFields: [{ key: 'answer', meaning: 'Student answer' }],
  semanticObjects: [{ id: 'answer', meaning: 'Answer panel', summary: 'Original answer' }], requiredCapabilities: ['workspace.read', 'workspace.change'] } });
const evidence = () => {
  const text = '原始实验依据\r\n';
  return { requestId: randomUUID(), executionRef: randomUUID(), mediaType: 'application/json', text: '{"observed":5}',
    resources: [{ contentId: randomUUID(), name: 'observation.txt', mediaType: 'text/plain', text,
      sha256: sha(text), byteLength: Buffer.byteLength(text) }] };
};

test('school deliveries retain only acquired versions and explicit immutable submissions in their real storage owner', { timeout: 120000 }, async t => {
  const pg = await nativeFixture(); t.after(() => pg.close());
  async function fixture(t) {
    const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
    const identity = { environmentId: owner.environmentId, spaceId: randomUUID(), principalId: randomUUID(), kind: 'school', name: 'Student' };
    const makeActivity = (actor = identity) => activitySchema.parse({ activityId: randomUUID(), identity: actor,
      target: { ...owner, version: 1 }, goal: 'Complete the course', question: '', references: [], status: 'open', createdAt: new Date().toISOString(),
      course: { associationId: randomUUID(), courseId: randomUUID(), courseName: 'Course', taskId: randomUUID(), taskTitle: 'Task',
        releaseId: randomUUID(), contentDigest: 'a'.repeat(64), objectives: ['Submit own work'], requirements: 'Complete the task',
        starterWorks: [], capabilities: [], materials: [], helpPolicy: { version: 1, questions: 'allowed', scope: 'course' } } });
    const activity = makeActivity(), other = makeActivity(), foreign = makeActivity({ ...identity, principalId: randomUUID() });
    const migrations = [{ version: 1, name: 'test-activities', sql: `CREATE TABLE activities(id uuid PRIMARY KEY,
      space_environment_id uuid NOT NULL,space_id uuid NOT NULL,principal_id uuid NOT NULL,body jsonb NOT NULL);` },
      { ...schoolDeliveryMigration, version: 2 }];
    const binding = await provisionStorage({ admin: pg.admin, owner, password: randomUUID(), migrations });
    const root = join(pg.root, owner.serviceId), backend = createFileBackend({ id: 'originals', root });
    const options = { binding, migrations, backend };
    let storage = await openStorage(options), authorized = true;
    t.after(() => storage.close());
    const mutate = effect => storage.request({ requestId: randomUUID(), fingerprint: randomUUID() }, effect);
    for (const value of [activity, other, foreign]) await mutate(async tx => {
      await tx.query('INSERT INTO activities VALUES($1,$2,$3,$4,$5)', [value.activityId, value.identity.environmentId,
        value.identity.spaceId, value.identity.principalId, JSON.stringify(value)]); return null;
    });
    const authorize = async (actor, id) => {
      if (!authorized) throw new StorageError('forbidden');
      const { rows: [row] } = await storage.read('SELECT * FROM activities WHERE id=$1', [id]);
      if (!row || row.space_environment_id !== actor.environmentId || row.space_id !== actor.spaceId || row.principal_id !== actor.principalId)
        throw new StorageError('missing');
      return activitySchema.parse(row.body);
    };
    let service = createSchoolDeliveries(storage, { activity: authorize });
    return { identity, activity, other, foreign, root, storage: () => storage, service: () => service, mutate,
      revoke: () => { authorized = false; },
      async reopen() { await storage.close(); storage = await openStorage(options); service = createSchoolDeliveries(storage, { activity: authorize }); },
      async updateActivity(value) { await mutate(async tx => {
        await tx.query('UPDATE activities SET body=$2 WHERE id=$1', [value.activityId, JSON.stringify(value)]); return null;
      }); },
    };
  }

  await t.test('acquisition is a minimal release-bound idempotent acknowledgement with no process resources', async t => {
    const f = await fixture(t), input = { requestId: randomUUID(), releaseId: f.activity.course.releaseId, contentDigest: f.activity.course.contentDigest };
    assert.equal(await f.service().acquisitionReceipt(f.identity, f.activity.activityId, input.requestId), null);
    const saved = await f.service().acquire(f.identity, f.activity.activityId, input);
    assert.deepEqual(Object.keys(saved).sort(), ['course', 'receivedAt', 'requestId', 'scope', 'state', 'version']);
    assert.equal(saved.scope.principalId, f.identity.principalId); assert.equal(saved.course.releaseId, input.releaseId);
    await f.reopen();
    assert.deepEqual(await f.service().acquire({ ...f.identity, name: 'Renamed student' }, f.activity.activityId, input), saved);
    assert.deepEqual(await f.service().acquisitionReceipt(f.identity, f.activity.activityId, input.requestId), saved);
    await assert.rejects(f.service().acquire(f.identity, f.activity.activityId, { ...input, releaseId: randomUUID() }), { code: 'identity-conflict' });
    assert.equal((await f.storage().read('SELECT * FROM _storage_resources')).rows.length, 0);
    await validateSchoolDeliveries(f.storage());
  });

  await t.test('a lost response is recovered after restart; later edits and new submissions never change the old version', async t => {
    const f = await fixture(t), input = { requestId: randomUUID(), works: [textWork()] };
    assert.equal(await f.service().receipt(f.identity, f.activity.activityId, input.requestId), null);
    const accepted = await f.service().submit(f.identity, f.activity.activityId, input);
    assert.equal(accepted.state, 'accepted'); assert.equal(accepted.scope.activityId, f.activity.activityId);
    assert.equal(accepted.course.contentDigest, f.activity.course.contentDigest); assert.match(accepted.contentDigest, /^[a-f0-9]{64}$/);
    const initial = structuredClone(input);
    input.works[0].value = 'edited after submit'; input.works[0].contentId = randomUUID();
    await f.reopen();
    assert.deepEqual(await f.service().receipt(f.identity, f.activity.activityId, initial.requestId), accepted);
    assert.deepEqual(await f.service().submit(f.identity, f.activity.activityId, initial), accepted);
    await assert.rejects(f.service().submit(f.identity, f.activity.activityId, input), { code: 'identity-conflict' });
    const next = await f.service().submit(f.identity, f.activity.activityId, { ...input, requestId: randomUUID() });
    assert.notEqual(next.submissionId, accepted.submissionId); assert.notEqual(next.contentDigest, accepted.contentDigest);
    assert.deepEqual((await f.service().read(f.identity, f.activity.activityId, accepted.submissionId)).works, initial.works);
    assert.deepEqual((await f.service().read(f.identity, f.activity.activityId, next.submissionId)).works, input.works);
    assert.equal((await f.service().list(f.identity, f.activity.activityId)).submissions.length, 2);
    await validateSchoolDeliveries(f.storage());
  });

  await t.test('binary WorkFiles, full artifact payloads and explicitly selected evidence roundtrip with pinned original bytes', async t => {
    const f = await fixture(t), input = { requestId: randomUUID(), works: [textWork(), { ...textWork(), name: 'image.bin', kind: 'resource',
      encoding: 'base64', mediaType: 'application/octet-stream', value: Buffer.from([0, 255, 1, 128]).toString('base64') }], artifacts: [artifact()], evidence: [evidence()] };
    const saved = await f.service().submit(f.identity, f.activity.activityId, input);
    await f.reopen();
    const fixed = await f.service().read(f.identity, f.activity.activityId, saved.submissionId);
    for (const key of ['works', 'artifacts', 'evidence']) assert.deepEqual(fixed[key], input[key]);
    assert.deepEqual(await f.service().receipt(f.identity, f.activity.activityId, input.requestId), saved);
    await validateSchoolDeliveries(f.storage());
    const backupId = randomUUID();
    const participant = f.storage().participant();
    await participant.closeWrites(); await participant.closeDispatch(); await participant.drain();
    await f.storage().snapshot(backupId, async ({ manifest }) => {
      assert.deepEqual(manifest.owner, f.storage().owner); assert.equal(manifest.schemaVersion, 2);
      assert.equal(manifest.resources.length, 5);
      const contents = await Promise.all(manifest.resources.map(resource => f.storage().readResource(resource.resourceId)));
      assert.ok(contents.some(value => Buffer.from(value).equals(Buffer.from([0, 255, 1, 128]))));
    });
    await f.storage().releaseBackup(backupId);
    await participant.resume();
  });

  await t.test('all reads are scoped; repeats reauthorize and personal or preview activities cannot submit', async t => {
    const f = await fixture(t), input = { requestId: randomUUID(), works: [textWork()], artifacts: [], evidence: [] };
    const saved = await f.service().submit(f.identity, f.activity.activityId, input);
    assert.equal(await f.service().receipt(f.identity, f.other.activityId, input.requestId), null);
    assert.deepEqual(await f.service().list(f.identity, f.other.activityId), { submissions: [] });
    await assert.rejects(f.service().read(f.identity, f.other.activityId, saved.submissionId), { code: 'missing' });
    for (const identity of [{ ...f.identity, principalId: randomUUID() }, { ...f.identity, spaceId: randomUUID() },
      { ...f.identity, environmentId: randomUUID() }]) {
      await assert.rejects(f.service().read(identity, f.activity.activityId, saved.submissionId), { code: 'missing' });
      await assert.rejects(f.service().submit(identity, f.activity.activityId, input), { code: 'missing' });
    }
    await assert.rejects(f.service().read(f.identity, f.foreign.activityId, saved.submissionId), { code: 'missing' });
    await assert.rejects(f.service().submit({ ...f.identity, kind: 'personal' }, f.activity.activityId, input), { code: 'forbidden' });
    const { course: _course, ...personal } = f.other;
    await f.updateActivity(personal);
    await assert.rejects(f.service().submit(f.identity, personal.activityId, { ...input, requestId: randomUUID() }), { code: 'forbidden' });
    await f.updateActivity({ ...f.other, purpose: 'preview' });
    await assert.rejects(f.service().submit(f.identity, f.other.activityId, { ...input, requestId: randomUUID() }), { code: 'forbidden' });
    await f.updateActivity({ ...f.activity, status: 'closed' });
    await assert.rejects(f.service().submit(f.identity, f.activity.activityId, input), { code: 'forbidden' });
    assert.deepEqual((await f.service().read(f.identity, f.activity.activityId, saved.submissionId)).works, input.works);
    f.revoke();
    await assert.rejects(f.service().submit(f.identity, f.activity.activityId, input), { code: 'forbidden' });
    await assert.rejects(f.service().receipt(f.identity, f.activity.activityId, input.requestId), { code: 'forbidden' });
    await assert.rejects(f.service().list(f.identity, f.activity.activityId), { code: 'forbidden' });
  });

  await t.test('invalid originals never get accepted; missing pins and corrupt bytes invalidate retained deliveries', async t => {
    const f = await fixture(t), selected = evidence();
    const invalid = { requestId: randomUUID(), works: [textWork()], artifacts: [], evidence: [{ ...selected,
      resources: [{ ...selected.resources[0], sha256: '0'.repeat(64) }] }] };
    await assert.rejects(f.service().submit(f.identity, f.activity.activityId, invalid), { code: 'invalid' });
    assert.equal(await f.service().receipt(f.identity, f.activity.activityId, invalid.requestId), null);
    assert.equal((await f.storage().read('SELECT * FROM _storage_resources')).rows.length, 0);
    for (const file of [{ ...textWork(), value: '\ud800' }, { ...textWork(), encoding: 'base64', value: 'not!base64' },
      { ...textWork(), encoding: 'json', value: '{bad' }])
      await assert.rejects(f.service().submit(f.identity, f.activity.activityId, { requestId: randomUUID(), works: [file] }), { code: 'invalid' });
    const input = { requestId: randomUUID(), works: [textWork()] }, saved = await f.service().submit(f.identity, f.activity.activityId, input);
    const { rows: [row] } = await f.storage().read('SELECT resource_id,reference FROM _storage_resources');
    const path = join(f.root, row.reference.locator.key), original = await readFile(path), corrupt = Buffer.from(original);
    corrupt[corrupt.length - 1] ^= 1; await writeFile(path, corrupt);
    await assert.rejects(f.service().read(f.identity, f.activity.activityId, saved.submissionId), { code: 'corrupt' });
    await assert.rejects(validateSchoolDeliveries(f.storage()), { code: 'corrupt' });
    await writeFile(path, original);
    await validateSchoolDeliveries(f.storage());
    await f.mutate(async tx => { await tx.unreference(`school-submission/${input.requestId}/work/${input.works[0].objectId}`); return null; });
    await assert.rejects(f.service().receipt(f.identity, f.activity.activityId, input.requestId), { code: 'corrupt' });
    await assert.rejects(validateSchoolDeliveries(f.storage()), { code: 'corrupt' });
  });

  await t.test('concurrent retries keep one immutable request and reject reused IDs across activities or delivery kinds', async t => {
    const f = await fixture(t), input = { requestId: randomUUID(), works: [textWork()], artifacts: [artifact()], evidence: [] };
    const receipts = await Promise.all(Array.from({ length: 4 }, () => f.service().submit(f.identity, f.activity.activityId, input)));
    receipts.forEach(value => assert.deepEqual(value, receipts[0]));
    assert.equal((await f.service().list(f.identity, f.activity.activityId)).submissions.length, 1);
    await assert.rejects(f.service().submit(f.identity, f.other.activityId, input), { code: 'identity-conflict' });
    await assert.rejects(f.service().acquire(f.identity, f.activity.activityId, { requestId: input.requestId,
      releaseId: f.activity.course.releaseId, contentDigest: f.activity.course.contentDigest }), { code: 'identity-conflict' });
    await validateSchoolDeliveries(f.storage());
  });
});

test('school delivery wire contracts reject question, conversation, model and caller-controlled receipt fields', () => {
  const input = { requestId: randomUUID(), works: [textWork()] };
  assert.deepEqual(schoolSubmissionInputSchema.parse(input), { ...input, artifacts: [], evidence: [] });
  for (const field of ['question', 'conversation', 'model', 'scope', 'course', 'receivedAt', 'submissionId', 'contentDigest'])
    assert.equal(schoolSubmissionInputSchema.safeParse({ ...input, [field]: 'unexpected' }).success, false);
  assert.equal(schoolSubmissionInputSchema.safeParse({ ...input, works: [{ ...input.works[0], question: 'unexpected' }] }).success, false);
  assert.equal(schoolSubmissionInputSchema.safeParse({ ...input, artifacts: [{ ...artifact(), model: 'unexpected' }] }).success, false);
  assert.equal(schoolSubmissionInputSchema.safeParse({ ...input, evidence: [{ ...evidence(), question: 'unexpected' }] }).success, false);
  assert.equal(schoolAcquisitionInputSchema.safeParse({ requestId: randomUUID(), releaseId: randomUUID(), contentDigest: 'a'.repeat(64), question: 'unexpected' }).success, false);
});
