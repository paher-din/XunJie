import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pgDriver from 'pg';
import { createFileBackend, openStorage, provisionStorage } from '@xunjie/storage';
import { createChunkChannel, createChunkClient } from '@xunjie/storage/chunk-channel';
import { nativeFixture } from '../packages/storage/test/native-fixture.mjs';
import { createLearningData, learningMigrations, validateLearningData } from '@xunjie/learning-space/learning-data';
import { createSkills, teachingSkillsMigration, teachingSkillsRemovalMigration } from '@xunjie/learning-space/learning-data/skills';
import { collectLearningSources, validateLearningSources } from '@xunjie/learning-space/learning-data/source-closure';
import { createModelGateway, modelMigrations } from '@xunjie/model-gateway';
import { createAgentRuntime } from '@xunjie/agent-runtime';
import { agentServiceMigrations, collectAgentServiceSources, validateAgentServiceSources } from '@xunjie/agents/transport/session-storage';
import { packageInput } from '../packages/learning-space/test/support/session-skills.mjs';
import { resetAgentDevelopmentData } from './agent-development-data.mjs';
import { parseResetArguments } from './reset-agent-development-data.mjs';
import { acquireLock } from '../packages/product-runtime/dist/io.js';
import { createStorageRecoveryOwner, createStorageRecoveryTarget } from '../packages/product-runtime/dist/storage-recovery.js';
import { createMaintenanceCoordinator } from '../packages/product-runtime/dist/maintenance.js';
import { createRecoveryManager, restoreRecoverySet } from '../packages/product-runtime/dist/recovery.js';
import { collectAgentRuntimeBoundary, validateAgentRuntimeBoundary } from '@xunjie/agent-runtime/maintenance';
import { inspectDatabase } from '../packages/product-runtime/dist/postgres.js';

test('reset requires an explicit root and an exact apply flag', () => {
  assert.equal(parseResetArguments(['--root', '/development']).apply, false);
  assert.equal(parseResetArguments(['--root', '/development', '--dry-run']).apply, false);
  assert.equal(parseResetArguments(['--root', '/development', '--apply']).apply, true);
  for (const args of [[], ['--apply'], ['--root', '/development', '--apply', '--dry-run'], ['--root', '/development', '--aply']])
    assert.throws(() => parseResetArguments(args), /invalid-reset-arguments/);
});

for (const scenario of ['superuser', 'non-superuser owner membership', 'frozen school study copy']) test(`development reset and backup preserve business and model data (${scenario})`, { timeout: 120000 }, async t => {
  const nonSuperuser = scenario !== 'superuser', protectedStudyCopy = scenario === 'frozen school study copy';
  const pg = await nativeFixture(), handles = [], gateways = [], targets = [];
  t.after(async () => { try {
    for (const gateway of gateways) { gateway.closeWrites(); await gateway.checks.drain(); }
    for (const handle of handles.reverse()) await handle.close();
  } finally { for (const target of targets) await target.close(); await pg.close(); } });
  const root = join(pg.root, 'product'), environmentId = randomUUID(), owners = {};
  const legacy = [{ version: 1, name: 'legacy-agent-fixture', sql: `
    CREATE TABLE teaching_sessions(activity_id uuid PRIMARY KEY);
    CREATE TABLE teaching_runs(run_id uuid PRIMARY KEY,activity_id uuid NOT NULL);
    CREATE TABLE teaching_segment_transitions(transition_id uuid PRIMARY KEY,create_body jsonb NOT NULL);
    ${teachingSkillsMigration.sql}${teachingSkillsRemovalMigration.sql}` }];
  async function open(kind, migrations) {
    const binding = await provisionStorage({ admin: pg.admin, owner: { environmentId, serviceId: randomUUID() }, password: randomUUID(), migrations });
    const unit = { agent: 'teaching-agent', learning: 'learning-data', model: 'model-connection' }[kind];
    const backend = createFileBackend({ id: unit, root: join(root, 'learning-resources', unit) });
    const storage = await openStorage({ binding, backend, migrations }); handles.push(storage);
    owners[kind] = { binding, backend }; return storage;
  }
  const agent = await open('agent', legacy), learning = await open('learning', learningMigrations), model = await open('model', modelMigrations);
  let resetAdmin = pg.admin;
  if (nonSuperuser) {
    const user = 'reset_' + randomUUID().replaceAll('-', ''), password = randomUUID();
    const adminClient = new pgDriver.Client(pg.admin); await adminClient.connect();
    try {
      const statement = (await adminClient.query("SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L',$1::text,$2::text) AS sql", [user, password])).rows[0].sql;
      await adminClient.query(statement);
      for (const owner of Object.values(owners)) await adminClient.query(`GRANT "${owner.binding.migratorRole}" TO "${user}"`);
      const role = (await adminClient.query('SELECT rolsuper,rolcreaterole,rolinherit FROM pg_roles WHERE rolname=$1', [user])).rows[0];
      assert.deepEqual(role, { rolsuper: false, rolcreaterole: false, rolinherit: false });
      assert.equal((await adminClient.query('SELECT has_table_privilege($1,$2,$3) AS allowed',
        [user, owners.agent.binding.schema + '._storage_identity', 'UPDATE'])).rows[0].allowed, false);
    } finally { await adminClient.end(); }
    resetAdmin = { ...pg.admin, user, password };
  }
  const identity = { environmentId, spaceId: randomUUID(), principalId: randomUUID(), kind: protectedStudyCopy ? 'school' : 'personal', name: '学生' };
  const data = createLearningData(learning, { resolveBinding: async () => ({ ...owners.learning.binding.owner, version: 1 }) });
  const activity = await data.create(identity, { requestId: randomUUID(), goal: '保留实际活动', question: '', references: [] });
  const file = { objectId: randomUUID(), contentId: randomUUID(), name: 'work.md', kind: 'text', encoding: 'utf8', mediaType: 'text/markdown', value: '保留作品' };
  await data.works.sync(identity, activity.activityId, { requestId: randomUUID(), baseRevision: 0, files: [file] });
  const material = await data.materials.receive(identity, activity.activityId, { requestId: randomUUID(), materialId: randomUUID(),
    name: 'kept.txt', mediaType: 'text/plain', dataBase64: Buffer.from('保留资料').toString('base64') });
  const caller = { grantId: randomUUID(), sourceEnvironmentId: environmentId, sourceServiceId: owners.agent.binding.owner.serviceId, sourceInstallationId: randomUUID() };
  const chunks = createChunkChannel(learning).wrap(async () => ({ retained: true })), send = createChunkClient(value => chunks(value, caller));
  const oldTransfer = randomUUID(), newTransfer = randomUUID(), oldAcknowledged = randomUUID(), newAcknowledged = randomUUID();
  const modernCall = { version: 2, operation: 'source.describe', identity, args: {} };
  await send({ version: 1, operation: 'activity', identity, activityId: activity.activityId, args: [] },
    { transferId: oldTransfer, durable: true, acknowledge: false });
  await send(modernCall, { transferId: newTransfer, durable: true, acknowledge: false });
  await send({ version: 1, operation: 'activity', identity, activityId: activity.activityId, args: [] },
    { transferId: oldAcknowledged, durable: true, acknowledge: true });
  await send(modernCall, { transferId: newAcknowledged, durable: true, acknowledge: true });
  // Historical channels pruned acknowledged part rows; the owner still retains the immutable request object.
  await learning.request({ requestId: randomUUID(), fingerprint: 'historical acknowledged channel' }, async tx => {
    await tx.query('DELETE FROM agent_chunk_parts WHERE transfer_id=ANY($1::uuid[])', [[oldAcknowledged, newAcknowledged]]); return null;
  });
  const skills = createSkills(agent, { authorize: async () => {}, activity: data.open, assertWritable() {} });
  const imported = await skills.import(identity, packageInput('retained-guidance'));
  const oldRun = randomUUID(), oldAttempt = randomUUID(), oldSegment = randomUUID();
  await agent.request({ requestId: randomUUID(), fingerprint: 'legacy' }, async tx => {
    await tx.query('INSERT INTO teaching_sessions VALUES($1)', [activity.activityId]);
    await tx.query('INSERT INTO teaching_runs VALUES($1,$2)', [oldRun, activity.activityId]); return null;
  });
  await data.conversationHistory.update(identity, { requestId: randomUUID(), activityId: activity.activityId, action: 'rename', title: '旧历史' });
  const gateway = await createModelGateway(model, { authorize: async () => {}, holder: 'device', supplierFetch: async () => { throw new Error('no supplier calls'); } }); gateways.push(gateway);
  const connectionId = randomUUID();
  const saved = await gateway.save(identity, { requestId: randomUUID(), connectionId, expectedVersion: 0, name: 'kept configuration',
    protocol: 'chat-completions', baseUrl: 'http://127.0.0.1:9/v1', path: '/chat/completions', modelId: 'kept-model',
    dialect: 'standard', parameterMode: 'plain', enabled: true, imageInput: false, contextWindow: 65536, maxOutputTokens: 2048,
    credential: { action: 'replace', value: 'synthetic-kept-credential' } });
  const grantId = randomUUID();
  await gateway.selection.createGrant(identity, identity, { requestId: randomUUID(), grantId, connectionId, owner: 'self' });
  const selection = await gateway.selection.save(identity, { requestId: randomUUID(), expectedVersion: 0,
    source: { kind: 'personal', connectionId, grantId } });
  const keptPin = randomUUID(), oldPin = randomUUID();
  await gateway.selection.pin(identity, keptPin, selection.version); await gateway.selection.pin(identity, oldPin, selection.version);
  const probe = await gateway.segments.create(identity, { requestId: randomUUID(), segmentId: randomUUID(), purpose: 'chat-probe',
    source: { connectionId, version: 1 }, prefix: { system: '', tools: [] }, portable: [] });
  const modernSegment = await gateway.segments.create(identity, { requestId: randomUUID(), segmentId: randomUUID(), sessionId: randomUUID(), purpose: 'learning',
    source: { selected: true, selectionVersion: selection.version, pinId: keptPin }, prefix: { system: '', tools: [] }, portable: [] });
  const checkId = randomUUID();
  await gateway.checks.receive(identity, { attemptId: checkId, purpose: 'connection-check', source: { connectionId, version: 1 },
    limits: { maxOutputTokens: 32, timeoutMs: 1000 } });
  await gateway.checks.cancel(identity, checkId);
  const keptCheck = await gateway.checks.read(identity, checkId);
  const image = await gateway.images.upload(identity, { requestId: randomUUID(), imageId: randomUUID(), mediaType: 'image/png',
    dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' });
  await agent.request({ requestId: randomUUID(), fingerprint: 'legacy pin' }, async tx => {
    await tx.query('INSERT INTO teaching_segment_transitions VALUES($1,$2)', [randomUUID(), { source: { pinId: oldPin } }]); return null;
  });
  await model.request({ requestId: 'legacy-agent-model', fingerprint: 'legacy' }, async tx => {
    // Historical learning records deliberately cannot pass the new validator until reset.
    await tx.query("INSERT INTO model_segments VALUES($1,$2,$3)", [oldSegment, [identity.environmentId, identity.spaceId, identity.principalId].join('.'),
      { segmentId: oldSegment, purpose: 'learning' }]);
    await tx.query('INSERT INTO model_attempts(id,scope,body,input_digest,credential_ref,state,physical_ended) VALUES($1,$2,$3,$4,$5,$6,true)',
      [oldAttempt, [identity.environmentId, identity.spaceId, identity.principalId].join('.'),
        { attemptId: oldAttempt, purpose: 'learning', segment: { segmentId: oldSegment } }, 'a'.repeat(64), randomUUID(), 'accepted']);
    await tx.reference('model-attempt-image:' + oldAttempt + ':' + image.imageId, image.resourceId); return null;
  });
  const transfers = join(root, 'private', 'agent-transfers'); await mkdir(transfers, { recursive: true });
  const oldPath = join(transfers, 'a'.repeat(64) + '.json'), newPath = join(transfers, 'b'.repeat(64) + '.json');
  await writeFile(oldPath, JSON.stringify({ capability: 'teaching.agent', payload: { version: 1 } }));
  const modern = JSON.stringify({ capability: 'agent.sessions.v2', payload: { version: 2 } }); await writeFile(newPath, modern);
  const credentials = join(root, 'credentials'); await mkdir(credentials);
  await writeFile(join(credentials, 'control'), 'retained-control');
  const configuration = JSON.stringify({ retained: 'installation', host: '127.0.0.1', resources: { postgresBin: process.env.XUNJIE_PRODUCT_POSTGRES_BIN },
    database: { mode: 'external', host: pg.admin.host, port: pg.admin.port, database: pg.admin.database, user: pg.admin.user, credentialRef: 'database-admin' } });
  await writeFile(join(root, 'installation.json'), configuration);
  await writeFile(join(credentials, 'database-admin'), pg.admin.password);
  await inspectDatabase(root, JSON.parse(configuration).database, true, true);
  const units = { agent: 'teaching-agent', learning: 'learning-data', model: 'model-connection' };
  await writeFile(join(root, 'environment.json'), JSON.stringify({ profile: 'school', environmentId, installationId: randomUUID(),
    services: Object.entries(owners).map(([kind, owner]) => ({ ...owner.binding.owner, unit: units[kind] })) }));
  for (const owner of Object.values(owners)) await writeFile(join(credentials, 'storage-' + owner.binding.owner.serviceId), JSON.stringify(owner.binding));
  const options = { root, admin: resetAdmin, owners };
  await assert.rejects(resetAgentDevelopmentData(options), { code: 'owner-connections-must-be-closed' });
  const studyCopy = protectedStudyCopy ? await data.studyCopies.exportScope(identity) : null;
  gateway.closeWrites(); await gateway.checks.drain(); gateways.splice(0);
  for (const storage of handles.splice(0)) await storage.close();
  const unlock = await acquireLock(root, 'daemon', 0);
  try { await assert.rejects(resetAgentDevelopmentData(options)); } finally { await unlock(); }
  const dry = await resetAgentDevelopmentData(options);
  assert.equal(dry.mode, 'dry-run'); assert.equal(dry.agent.rebuild, true); assert.equal(dry.skills.versions, 1);
  assert.deepEqual(dry.blocking, []);
  if (!protectedStudyCopy) assert.equal(dry.learning.agent_chunk_transfers, 2);
  const cli = await promisify(execFile)(process.execPath, ['scripts/reset-agent-development-data.mjs', '--root', root], { timeout: 30000 });
  assert.equal(JSON.parse(cli.stdout).mode, 'dry-run');
  assert.equal(await readFile(oldPath, 'utf8'), JSON.stringify({ capability: 'teaching.agent', payload: { version: 1 } }));
  const applied = await resetAgentDevelopmentData({ ...options, apply: true });
  assert.equal(applied.mode, 'applied');
  if (protectedStudyCopy) {
    assert.equal(applied.learning.agent_chunk_transfers, 1);
    assert.equal(applied.learningTransport.preservedStudyCopyV1, 1);
  }
  await assert.rejects(readFile(oldPath), { code: 'ENOENT' }); assert.equal(await readFile(newPath, 'utf8'), modern);
  assert.equal(await readFile(join(root, 'credentials', 'control'), 'utf8'), 'retained-control');
  assert.equal(await readFile(join(root, 'installation.json'), 'utf8'), configuration);
  async function reopened(kind, migrations) {
    const storage = await openStorage({ ...owners[kind], migrations }); handles.push(storage); return storage;
  }
  const restoredLearning = await reopened('learning', learningMigrations);
  const nextData = createLearningData(restoredLearning, { resolveBinding: async () => ({ ...owners.learning.binding.owner, version: 1 }) });
  await restoredLearning.participant().resume();
  const retainedTransport = createChunkChannel(restoredLearning).wrap(async () => { throw new Error('a retained v2 reply must not execute again'); });
  assert.equal((await retainedTransport({ chunkChannel: 1, operation: 'metadata', transferId: newAcknowledged }, caller)).state, 'acknowledged');
  await assert.rejects(retainedTransport({ chunkChannel: 1, operation: 'metadata', transferId: oldAcknowledged }, caller), { code: 'missing' });
  if (protectedStudyCopy) assert.equal((await retainedTransport({ chunkChannel: 1, operation: 'metadata', transferId: oldTransfer }, caller)).state, 'completed');
  assert.deepEqual(await createChunkClient(value => retainedTransport(value, caller))(modernCall,
    { transferId: newTransfer, durable: true, acknowledge: false }), { retained: true });
  if (studyCopy) assert.equal((await nextData.studyCopies.exportScope(identity)).digest, studyCopy.digest);
  await restoredLearning.participant().closeWrites(); await restoredLearning.participant().closeDispatch();
  assert.deepEqual(await nextData.open(identity, activity.activityId), activity);
  assert.equal((await nextData.works.read(identity, activity.activityId)).files[0].value, file.value);
  assert.equal((await nextData.materials.original(identity, activity.activityId, material.materialId, 1)).text, '保留资料');
  const migrated = createSkills(restoredLearning, { authorize: async () => {}, activity: nextData.open, assertWritable() {} });
  assert.equal((await migrated.document(identity, { skillId: imported.skillId, version: 1 })).content, packageInput('retained-guidance').files[0].content);
  await validateLearningData(restoredLearning);
  const closure = await collectLearningSources(restoredLearning); await validateLearningSources(restoredLearning, closure);
  const restoredModel = await reopened('model', modelMigrations);
  const nextModels = await createModelGateway(restoredModel, { authorize: async () => {} }); gateways.push(nextModels);
  assert.deepEqual((await nextModels.list(identity))[0], saved); await nextModels.validate();
  assert.equal((await nextModels.readCredential(identity, connectionId, 1)).value, 'synthetic-kept-credential');
  assert.deepEqual(await nextModels.checks.read(identity, checkId), keptCheck);
  assert.equal((await nextModels.images.read(identity, { imageId: image.imageId, version: 1 })).sha256, image.sha256);
  assert.deepEqual(await nextModels.segments.read(identity, probe.segmentId), probe);
  assert.deepEqual(await nextModels.segments.read(identity, modernSegment.segmentId), modernSegment);
  assert.equal((await nextModels.selection.pinned(identity, keptPin, selection.version)).choice.connection.connectionId, connectionId);
  await assert.rejects(nextModels.selection.pinned(identity, oldPin, selection.version), { code: 'forbidden' });
  const restoredAgent = await reopened('agent', agentServiceMigrations);
  await validateAgentServiceSources(restoredAgent, await collectAgentServiceSources(restoredAgent));
  const empty = createAgentRuntime(restoredAgent, { authorize: async () => {}, readOnly: true }); await empty.close();

  const installationId = randomUUID(), resources = { postgresBin: process.env.XUNJIE_PRODUCT_POSTGRES_BIN };
  const definitions = [
    { kind: 'agent', unit: 'teaching-agent', storage: restoredAgent, migrations: agentServiceMigrations,
      validate: async current => validateAgentServiceSources(current, await collectAgentServiceSources(current)),
      sources: collectAgentServiceSources, validateSources: validateAgentServiceSources,
      boundary: collectAgentRuntimeBoundary, validateMaterial: validateAgentRuntimeBoundary },
    { kind: 'learning', unit: 'learning-data', storage: restoredLearning, migrations: learningMigrations,
      validate: validateLearningData, sources: collectLearningSources, validateSources: validateLearningSources },
    { kind: 'model', unit: 'model-connection', storage: restoredModel, migrations: modelMigrations,
      validate: async current => { const service = await createModelGateway(current, { authorize: async () => {} }); gateways.push(service); await service.validate(); } },
  ];
  // Use the real storage owner export and independent pg_restore, including the new service closure validator.
  const recoveryOwners = definitions.map(def => createStorageRecoveryOwner({ ...def, binding: owners[def.kind].binding,
    resources, installationId, validateService: def.validate }));
  const serviceIds = definitions.map(def => owners[def.kind].binding.owner.serviceId);
  const environment = { formatVersion: 1, environmentId, installationId, clientNamespace: 'reset-fixture', profile: 'school',
    services: definitions.map(def => ({ ...owners[def.kind].binding.owner, unit: def.unit, endpoint: 'http://127.0.0.1:1', protocolVersion: 1, capabilities: [] })) };
  const maintenance = createMaintenanceCoordinator({ requiredServiceIds: serviceIds, record: async () => {} });
  for (const owner of recoveryOwners) maintenance.register(owner.participant);
  const manager = createRecoveryManager({ root, environment, maintenance, owners: recoveryOwners, requiredServiceIds: serviceIds });
  const key = randomBytes(32), backups = join(pg.root, 'backups');
  const manifest = await manager.backup({ directory: backups, key, leaveClosed: true });
  const targetPg = await nativeFixture(); targets.push(targetPg);
  const restored = {};
  await restoreRecoverySet({ backupDirectory: join(backups, manifest.backupId), targetRoot: join(targetPg.root, 'product'), key,
    targets: definitions.map(def => createStorageRecoveryTarget({ ...def, owner: owners[def.kind].binding.owner,
      admin: async () => targetPg.admin, resources, installationId: randomUUID(), validateService: def.validate,
      backend: createFileBackend({ id: owners[def.kind].backend.id, root: join(targetPg.root, 'objects', def.kind) }),
      onRestored(storage) { restored[def.kind] = storage; handles.push(storage); } })) });
  const restoredData = createLearningData(restored.learning, { resolveBinding: async () => ({ ...owners.learning.binding.owner, version: 1 }) });
  if (studyCopy) {
    await restored.learning.participant().resume();
    assert.equal((await restoredData.studyCopies.exportScope(identity)).digest, studyCopy.digest);
    await restored.learning.participant().closeWrites(); await restored.learning.participant().closeDispatch();
  }
  assert.equal((await restoredData.works.read(identity, activity.activityId)).files[0].value, file.value);
  assert.equal((await restoredData.materials.original(identity, activity.activityId, material.materialId, 1)).text, '保留资料');
  const restoredModels = await createModelGateway(restored.model, { authorize: async () => {} }); gateways.push(restoredModels);
  assert.deepEqual(await restoredModels.checks.read(identity, checkId), keptCheck);
  assert.equal((await restoredModels.images.read(identity, { imageId: image.imageId, version: 1 })).sha256, image.sha256);
  assert.equal((await restoredModels.readCredential(identity, connectionId, 1)).value, 'synthetic-kept-credential');
});
