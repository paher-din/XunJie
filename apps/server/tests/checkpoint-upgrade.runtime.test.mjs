import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFileBackend, openStorage, provisionStorage } from '@xunjie/storage';
import { createLearningData, learningMigrations, validateLearningData } from '@xunjie/learning-space';
import { canonicalValue, executionActionSchema } from '@xunjie/contracts/execution';
import { createSessionCheckpoints, readSessionCheckpointPage } from '../../../packages/learning-space/dist/learning-data/session-checkpoints.js';
import { nativeFixture } from '../../../packages/storage/test/native-fixture.mjs';

const publishedCommit = '80c8ed49db6c3483ef8a48734f8cea250994acce';
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const jsonHash = value => hash(JSON.stringify(value));
const canonicalHash = value => jsonHash(canonicalValue(value));
const migrationChecksum = migration => hash(`${migration.version}\n${migration.name}\n${migration.sql}`);
// Frozen from the published commit, independently of the current module's migration list.
const publishedChecksums = [
  'c795d8e14a7489c34c84874c3604a8c0e8a40b88400572ac0087274f9ea6f3f6',
  '4726234aa3db044346f2190069729447530b326cdc46eebfeefd54379e0d6dd1',
  '510d7ab1e0bfb60c6cc43406ec4c35843a384e58d338c619e57c91b2446a86c8',
  '8f6cc3ce5b4bd66b1e189dfa9d0ad05ace3910347591e13f1ab738b33d67e335',
  'ddae3569de216fc0eb0a9bf284360980fda575403fbd67c8cdf2ff8c181cd366',
  '2b8c2f5f058ec52f44c85449a01b404ccf335c5fbcb7518bbfea39a615dfafb7',
  'd4300053e167ffdff6b3358fdcb0e80c53119e51b11ef53cc9982abbdf911158',
  '7c9208bd843e449fa053beb018ba4ee12a95aea97ecb2214b9be74f351f0dd9b',
];
function publishedSource(name) {
  return execFileSync('git', ['show', `${publishedCommit}:packages/learning-space/src/learning-data/${name}.ts`],
    { cwd: repository, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
}
function publishedMigrations() {
  const modules = ['index', 'works', 'drafts', 'intents', 'executions', 'native-sessions', 'session-checkpoints'];
  const migrations = modules.flatMap(name => [...publishedSource(name)
    .matchAll(/version:\s*(\d+),\s*name:\s*'([^']+)',\s*sql:\s*`([^`]+)`/g)]
    .map(([, version, name, sql]) => {
      assert.ok(!sql.includes('${'), 'Published migration SQL must be a literal, not an unevaluated template.');
      return { version: Number(version), name, sql };
    })).sort((left, right) => left.version - right.version);
  assert.deepEqual(migrations.map(item => item.version), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(migrations.map(migrationChecksum), publishedChecksums);
  return migrations;
}
async function publishedCheckpointOwner() {
  // Run the published checkpoint writer, not the new writer, to produce legacy resource bytes.
  // It has only bare value imports; its relative NativeObservation import is type-only.
  const source = stripTypeScriptTypes(publishedSource('session-checkpoints'))
    .replace(/from\s+(['"])([^'"]+)\1/g, (_match, _quote, specifier) => {
      assert.ok(!specifier.startsWith('.'), 'Unexpected runtime-relative dependency in the published checkpoint writer.');
      return `from ${JSON.stringify(import.meta.resolve(specifier))}`;
    });
  return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}
async function originalRows(storage, tables) {
  const result = {};
  for (const table of tables) {
    // v10 adds nullable command text. Preserve every column that existed in the published DB.
    const row = ['native_sessions', 'execution_commands'].includes(table) ? "to_jsonb(t)-'action_text'" : 'to_jsonb(t)';
    result[table] = (await storage.read(`SELECT ${row} AS body FROM ${table} t ORDER BY (${row})::text`)).rows;
  }
  return result;
}

test('published #174 schema 1..8 upgrades to 1..16 without rewriting checkpoints, data or receipts', { timeout: 120000 }, async () => {
  const previousMigrations = publishedMigrations();
  assert.equal(learningMigrations.length, 16);
  assert.deepEqual(learningMigrations.slice(0, 8), previousMigrations, 'The published SQL and migration identity must remain unchanged.');
  const { createSessionCheckpoints: createPublishedCheckpoints } = await publishedCheckpointOwner();
  const fixture = await nativeFixture();
  let previous, upgraded;
  try {
    const owner = { environmentId: randomUUID(), serviceId: randomUUID() }, password = randomUUID();
    const backend = createFileBackend({ id: 'checkpoint-upgrade', root: join(fixture.root, 'objects') });
    const provision = migrations => provisionStorage({ admin: fixture.admin, owner, password, migrations });
    const binding = await provision(previousMigrations);
    previous = await openStorage({ binding, migrations: previousMigrations, backend });
    const identity = { environmentId: owner.environmentId, spaceId: randomUUID(), principalId: randomUUID(), kind: 'school', name: '升级验收学生' };
    const authority = { resolveBinding: async () => ({ ...owner, version: 1 }) };
    const legacy = createLearningData(previous, authority);
    const createInput = { requestId: randomUUID(), goal: '保留旧活动、作品、问题和检查点', question: '', references: [] };
    const activity = await legacy.create(identity, createInput), activityId = activity.activityId;
    const firstFile = { objectId: randomUUID(), contentId: randomUUID(), name: '实验记录.txt', kind: 'text',
      encoding: 'utf8', mediaType: 'text/plain', value: '原作品：依次输入 1、2、2。' };
    const firstWorkInput = { requestId: randomUUID(), baseRevision: 0, files: [firstFile] };
    const firstWork = await legacy.works.sync(identity, activityId, firstWorkInput);
    const nextFile = { ...firstFile, contentId: randomUUID(), value: '当前作品：检查点之后继续观察。' };
    const secondWorkInput = { requestId: randomUUID(), baseRevision: 1, files: [nextFile] };
    const secondWork = await legacy.works.sync(identity, activityId, secondWorkInput);
    const emptyDraft = await legacy.drafts.read(identity, activityId);
    const firstDraftInput = { requestId: randomUUID(), draftId: emptyDraft.draftId, baseRevision: 0,
      question: '为什么状态发生变化？', references: [], bases: [] };
    const firstDraft = await legacy.drafts.sync(identity, activityId, firstDraftInput);
    const secondDraftInput = { ...firstDraftInput, requestId: randomUUID(), baseRevision: 1, question: '如何从已保存的检查点继续？' };
    const secondDraft = await legacy.drafts.sync(identity, activityId, secondDraftInput);

    const sessionRef = randomUUID(), executorInstanceId = randomUUID(), supervisorEpoch = randomUUID();
    const configuration = { title: '旧检查点' }, componentId = randomUUID();
    const action = executionActionSchema.parse({ protocolVersion: 2, kind: 'execution', requestId: randomUUID(),
      scope: { environmentId: identity.environmentId, spaceId: identity.spaceId, principalId: identity.principalId, activityId },
      receiver: { receiverId: 'native-execution', location: 'local', kind: 'execution' },
      execution: { instance: { instanceId: `${activityId}:accumulator`, key: 'accumulator', componentId,
        componentVersion: 2, definitionDigest: 'a'.repeat(64), hostApiVersion: 1, stateVersion: 1 },
      operation: { operationId: 'advance', effect: 'input' }, parameters: {},
      basis: { works: [], state: null, expected: { stateContentId: null }, resources: [] },
      limits: { timeMs: 5000, memoryPages: 1, inputBytes: 1024, outputBytes: 65536, concurrentJobs: 2, queuedJobs: 0 },
      plan: { planId: 'native-session', planVersion: 1, location: 'native', kind: 'session', planDigest: canonicalHash({
        planId: 'native-session', planVersion: 1, componentId, componentVersion: 2, operationId: 'advance' }) },
      session: { adapterId: 'four-state-accumulator', adapterVersion: 2, limits: { operationTimeoutMs: 5000, idleMs: 60000,
        maxMs: 120000, memoryMiB: 64, concurrentSessions: 2, queuedSessions: 0 } },
      initiator: { kind: 'student', principalId: identity.principalId } } });
    const controls = ['input', 'input', 'pause', 'checkpoint'].map((effect, index) => ({
      controlId: randomUUID(), operationId: effect === 'input' ? 'advance' : effect, effect, expectedSeq: index,
      parameters: effect === 'input' ? { value: index + 1 } : {},
    }));
    const observations = controls.map((control, index) => ({ seq: index + 1, controlId: control.controlId,
      state: index === 0 ? { value: 1, total: 1, applied: 1 } : { value: 3, total: 3, applied: 2 },
      at: `2026-11-03T10:00:0${index}.000Z` }));
    const checkpointControl = controls.at(-1), checkpointId = checkpointControl.controlId;
    const snapshot = { formatVersion: 1, value: 3, total: 3, applied: 2, mode: 'paused' };
    const observation = { ...observations.at(-1), sessionState: 'paused', checkpoint: snapshot };
    const stopId = randomUUID();
    // Seed historical executor facts without starting a process: this test verifies schema/data upgrade only.
    await previous.request({ requestId: 'legacy-native-fixture', fingerprint: jsonHash(action) }, async tx => {
      await tx.query(`INSERT INTO native_sessions(session_ref,activity_id,request_id,input_digest,action,adapter_id,
        adapter_version,node_id,install_generation,supervisor_epoch,executor_instance_id,state,status_knowledge,
        stop_requested,confirmed_seq,applied_seq,last_control_id,observation,observations)
        VALUES($1,$2,$3,$4,$5,'four-state-accumulator',2,'legacy-native',$6,$7,$8,'cancelled','confirmed',true,7,4,$9,$10,$11)`,
      [sessionRef, activityId, action.requestId, jsonHash(action), JSON.stringify(action), previous.generation,
        supervisorEpoch, executorInstanceId, checkpointId, JSON.stringify(observation.state), JSON.stringify(observations)]);
      for (const [index, control] of controls.entries()) await tx.query(`INSERT INTO native_session_operations
        (control_id,session_ref,seq,operation_id,input_digest,parameters,status,observation,effect)
        VALUES($1,$2,$3,$4,$5,$6,'applied',$7,$8)`, [control.controlId, sessionRef, index + 1, control.operationId,
        canonicalHash(control), JSON.stringify(control.parameters), JSON.stringify(observations[index]), control.effect]);
      await tx.query('INSERT INTO native_session_stops(stop_id,session_ref,request_id,reason) VALUES($1,$2,$3,$4)',
        [stopId, sessionRef, action.requestId, '旧版本已确认停止']);
      return { requestId: action.requestId, sessionRef, executorInstanceId, checkpointId, stopId };
    });
    const publishedCheckpoints = createPublishedCheckpoints(previous);
    await publishedCheckpoints.capture({ action, session_ref: sessionRef, executor_instance_id: executorInstanceId },
      checkpointId, observation, configuration, 1);
    const checkpointBytes = Buffer.from(await previous.readResource(checkpointId));
    const { rows: [legacyCheckpoint] } = await previous.read('SELECT * FROM native_session_checkpoints WHERE checkpoint_id=$1', [checkpointId]);
    const resumeFromCheckpoint = { checkpointId, sessionRef, sha256: hash(checkpointBytes) };
    const recoveryAction = { ...structuredClone(action), requestId: randomUUID(),
      execution: { ...structuredClone(action.execution), resumeFromCheckpoint } };
    assert.deepEqual((await publishedCheckpoints.restore(recoveryAction, configuration, 1)).snapshot, snapshot);
    const tables = [...new Set(previousMigrations.flatMap(item => [...item.sql.matchAll(/CREATE TABLE (\w+)/g)].map(match => match[1]))),
      '_storage_requests', '_storage_resources', '_storage_references', '_storage_outbox', '_storage_pins', '_storage_backups'];
    const before = await originalRows(previous, tables);
    const oldMigrationRows = (await previous.read('SELECT * FROM _storage_migrations ORDER BY version')).rows;
    assert.deepEqual(oldMigrationRows.map(row => row.checksum), publishedChecksums);
    const oldReceipt = await previous.receipt('legacy-native-fixture');

    await assert.rejects(provision(learningMigrations), { code: 'maintenance' });
    const participant = previous.participant();
    await participant.closeDispatch();
    await participant.closeWrites();
    await participant.drain();
    const alteredHistory = learningMigrations.map(item => item.version === 8 ? { ...item, sql: item.sql + '\nSELECT 1;' } : item);
    await assert.rejects(provision(alteredHistory), { code: 'incompatible' }, 'A changed published v8 must be rejected, not rewritten.');
    const upgradedBinding = await provision(learningMigrations);
    assert.deepEqual(upgradedBinding, binding, 'Upgrade retains the original owner, schema and restricted binding.');
    upgraded = await openStorage({ binding: upgradedBinding, migrations: learningMigrations, backend });
    const migrationRows = (await upgraded.read('SELECT * FROM _storage_migrations ORDER BY version')).rows;
    assert.deepEqual(migrationRows.map(row => row.version), Array.from({ length: 16 }, (_, index) => index + 1));
    assert.deepEqual(migrationRows.slice(0, 8), oldMigrationRows, 'Published checksums and original applied_at values survive.');
    assert.deepEqual(migrationRows.map(row => row.checksum), learningMigrations.map(migrationChecksum));
    assert.deepEqual(await originalRows(upgraded, tables), before, 'Every original domain row, receipt and resource reference survives.');
    assert.deepEqual(Buffer.from(await upgraded.readResource(checkpointId)), checkpointBytes);
    assert.deepEqual(await upgraded.receipt('legacy-native-fixture'), oldReceipt);
    await validateLearningData(upgraded);
    const page = await readSessionCheckpointPage(upgraded, identity, activityId);
    assert.equal(page.items.length, 1);
    assert.equal(page.nextCursor, null);
    assert.deepEqual(page.items[0], { ...resumeFromCheckpoint, contentId: checkpointId, appliedSeq: 4,
      byteLength: checkpointBytes.length, createdAt: legacyCheckpoint.created_at.toISOString(),
      requestId: action.requestId, instanceId: action.execution.instance.instanceId, scope: action.scope });
    assert.deepEqual(await createSessionCheckpoints(upgraded).restore(recoveryAction, configuration, 1),
      { snapshot, contentId: checkpointId, environment: JSON.parse(checkpointBytes.toString('utf8')).environment });

    await upgraded.participant().resume();
    const current = createLearningData(upgraded, authority);
    assert.deepEqual(await current.open(identity, activityId), activity);
    assert.deepEqual(await current.create(identity, createInput), activity, 'Old activity request still returns its original receipt.');
    assert.deepEqual(await current.works.read(identity, activityId), secondWork);
    assert.deepEqual(await current.works.receipt(identity, activityId, firstWorkInput.requestId), firstWork);
    assert.equal((await current.works.content(identity, activityId, firstFile.contentId)).value, firstFile.value);
    assert.deepEqual(await current.drafts.read(identity, activityId), secondDraft);
    assert.deepEqual(await current.drafts.revision(identity, activityId, firstDraft.revisionId), firstDraft);
    assert.deepEqual(await current.drafts.receipt(identity, activityId, firstDraftInput.requestId), firstDraft);
    assert.deepEqual(await current.drafts.sync(identity, activityId, secondDraftInput), secondDraft);
    await assert.rejects(previous.request({ requestId: 'stale-old-writer', fingerprint: 'old' }, async () => null), { code: 'stale-generation' });
    assert.deepEqual(await upgraded.collect({ olderThan: new Date(Date.now() + 60000) }), [], 'Original work history and checkpoints remain pinned.');
    assert.deepEqual(Buffer.from(await upgraded.readResource(checkpointId)), checkpointBytes);
    await validateLearningData(upgraded);
  } finally {
    await Promise.allSettled([previous?.close(), upgraded?.close()]);
    await fixture.close();
  }
});
