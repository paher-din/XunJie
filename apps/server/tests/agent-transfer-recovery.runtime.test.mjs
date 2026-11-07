import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { provisionStorage, openStorage, createFileBackend, StorageError } from '@xunjie/storage';
import { nativeFixture } from '../../../packages/storage/test/native-fixture.mjs';
import { createChunkChannel, chunkChannelMigrationSql } from '../../../packages/learning-space/dist/teaching-agent/chunk-channel.js';
import { createAgentConnection } from '../../../packages/product-runtime/dist/agent-connections.js';
import { agentTransferEntries } from '../../../packages/product-runtime/dist/agent-transfer-journal.js';
import { createConnectionAuthority, createOutboundConnection } from '@xunjie/product-runtime/connections';
import { recordRecoverySuccession, isRecoverySuccessor } from '../../../packages/product-runtime/dist/recovery-successions.js';
import { createRuntimeRecoveryOwner, createRuntimeRecoveryTarget } from '../../../packages/product-runtime/dist/runtime-recovery.js';

const exec = promisify(execFile);
const checksum = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t, effect = input => ({ accepted: input.args })) {
  const pg = await nativeFixture(), root = await mkdtemp(join(tmpdir(), 'xj-transfer-client-'));
  const serverRoot = join(pg.root, 'receiver'); await mkdir(serverRoot);
  const migrations = [{ version: 1, name: 'chunks', sql: chunkChannelMigrationSql }];
  const binding = await provisionStorage({ admin: pg.admin, owner: { environmentId: randomUUID(), serviceId: randomUUID() },
    password: randomUUID(), migrations });
  const storage = await openStorage({ binding, migrations, backend: createFileBackend({ id: 'objects', root: join(pg.root, 'objects') }) });
  let faults = () => false, before = () => false, effects = 0, authorizedDriver, guard = async () => {};
  const channel = createChunkChannel(storage);
  const wrapped = channel.wrap(input => { effects++; return effect(input); }, {
    authorize: async input => {
      if (authorizedDriver && input.authority?.driverId !== authorizedDriver) throw new StorageError('forbidden');
      await guard(input);
    },
    successor: (from, to) => isRecoverySuccessor(serverRoot, from, to.sourceInstallationId),
  });
  let authority;
  const server = createServer((request, response) => {
    void authority.handle(request, response).then(handled => { if (!handled) { response.writeHead(404); response.end(); } })
      .catch(() => response.destroy());
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const target = { ...binding.owner, unit: 'learning-data', protocolVersion: 1,
    endpoint: `http://127.0.0.1:${server.address().port}`, capabilities: ['teaching.dependencies'] };
  authority = createConnectionAuthority({ root: serverRoot, service: target, handlers: {
    'teaching.dependencies': async (value, source) => {
      try {
        if (before(value)) throw new Error('lost before receiver acceptance');
        const result = await wrapped(value, source);
        if (faults(value)) throw new Error('lost response after durable receiver commit');
        return result;
      } catch (error) { if (error instanceof StorageError) return { error: error.code }; throw error; }
    },
  } });
  const identity = { sourceEnvironmentId: randomUUID(), sourceServiceId: randomUUID(), sourceInstallationId: randomUUID() };
  const connection = { connectionId: randomUUID(), sourceEnvironmentId: identity.sourceEnvironmentId, sourceServiceId: identity.sourceServiceId,
    target, requiredCapabilities: ['teaching.dependencies'], optionalCapabilities: [], credentialRef: 'original-grant' };
  await mkdir(join(root, 'credentials'));
  const save = async () => {
    await writeFile(join(root, 'installation.json'), JSON.stringify({ connections: [connection], database: { mode: 'none' } }));
    await writeFile(join(root, 'environment.json'), JSON.stringify({ formatVersion: 1, environmentId: identity.sourceEnvironmentId,
      installationId: identity.sourceInstallationId, clientNamespace: 'transfer-test', profile: 'remote', services: [{
        environmentId: identity.sourceEnvironmentId, serviceId: identity.sourceServiceId, unit: 'client', protocolVersion: 1,
        endpoint: 'http://127.0.0.1:19232', capabilities: [] }] }));
  };
  let grant = await authority.authorize({ ...identity, capabilities: ['teaching.dependencies'] });
  await writeFile(join(root, 'credentials', connection.credentialRef), grant.token, { mode: 0o600 }); await save();
  const wire = payload => createOutboundConnection({ connection, credential: async () => grant.token,
    allowInsecureLoopback: true, timeoutMs: 3000 }).request('teaching.dependencies', payload);
  t.after(async () => {
    server.closeAllConnections(); await new Promise(done => server.close(done));
    await storage.close(); await pg.close(); await rm(root, { recursive: true, force: true });
  });
  return { root, storage, connection, identity, wire, channel, get effects() { return effects; },
    get grant() { return grant; }, set faults(value) { faults = value; }, set driver(value) { authorizedDriver = value; },
    set before(value) { before = value; },
    set guard(value) { guard = value; },
    client: () => createAgentConnection(root, connection.connectionId, 'teaching.dependencies'),
    async rotate(successor = false) {
      const from = { ...identity };
      if (successor) {
        await authority.fenceSource(from); identity.sourceInstallationId = randomUUID();
        await recordRecoverySuccession(serverRoot, { formatVersion: 1, backupId: randomUUID(), ...from,
          targetInstallationId: identity.sourceInstallationId });
      }
      grant = await authority.authorize({ ...identity, capabilities: ['teaching.dependencies'] });
      connection.credentialRef = 'renewed-' + randomUUID();
      await writeFile(join(root, 'credentials', connection.credentialRef), grant.token, { mode: 0o600 }); await save();
    },
  };
}
function payload(text = 'fixed request') {
  return { version: 1, operation: 'model', identity: { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), kind: 'personal', name: 'Fixture' },
    authority: { runId: randomUUID(), activityId: randomUUID(), driverId: 'driver-1', generation: 1 },
    args: [{ operation: 'checks.receive', args: [{ attemptId: randomUUID(), text }] }] };
}

test('formal Agent connection reuses one large transfer through 20 lost begin replies and a new Run lease', { timeout: 60000 }, async t => {
  const f = await fixture(t), input = payload('中文🙂'.repeat(160000));
  f.faults = value => value.operation === 'begin';
  for (let n = 0; n < 20; n++) await assert.rejects(f.client()(input), { code: 'unavailable' });
  const { rows } = await f.storage.read('SELECT * FROM agent_chunk_transfers');
  assert.equal(rows.length, 1); assert.equal(rows[0].state, 'receiving'); assert.equal(f.effects, 0);
  const [before] = await agentTransferEntries(f.root);
  await f.rotate(); f.faults = () => false; f.driver = 'driver-2';
  const renewed = { ...input, authority: { ...input.authority, driverId: 'driver-2', generation: 2 } };
  assert.deepEqual(await f.client()(renewed), { accepted: input.args });
  const [after] = await agentTransferEntries(f.root);
  assert.equal(after.transferId, before.transferId); assert.equal(after.origin.grantId, before.origin.grantId);
  assert.equal(after.state, 'consumed'); assert.equal(f.effects, 1);
  assert.equal((await f.storage.read('SELECT reserved_bytes FROM agent_chunk_transfers')).rows[0].reserved_bytes, 0);
  await assert.rejects(f.client()({ ...renewed, args: [{ ...input.args[0], args: [{ ...input.args[0].args[0], text: 'different fixed input' }] }] }), { code: 'identity-conflict' });
});

test('small request with large reply survives lost ack, real process restart and runtime journal restore', { timeout: 60000 }, async t => {
  const large = { text: '回复🙂'.repeat(160000) }, f = await fixture(t, () => large), input = payload();
  let lost = false;
  f.faults = value => value.operation === 'ack' && !lost && (lost = true);
  await assert.rejects(f.client()(input), { code: 'unavailable' });
  const entries = await agentTransferEntries(f.root);
  assert.equal(entries[0].state, 'received'); assert.deepEqual(entries[0].result, large); assert.equal(f.effects, 1);
  const copied = join(f.root, 'restored'); await mkdir(copied);
  const owner = createRuntimeRecoveryOwner({ root: f.root, participant: { descriptor: {
    serviceId: f.identity.sourceServiceId, schemaVersion: '2', resourceRoots: [], configurationRefs: ['installation'] } } });
  const recovery = await owner.export({ directory: f.root, backupId: randomUUID(), signal: new AbortController().signal });
  assert.equal(recovery.schemaVersion, '2', 'old runtime readers must reject backups containing required transfer facts');
  assert.ok(JSON.stringify(recovery.data).length < 50000, 'large reply bytes belong to separate authenticated artifacts');
  const resources = { nodePath: process.execPath, nodeVersion: '24.21.0',
    webRoot: fileURLToPath(new URL('../../web/dist-runtime', import.meta.url)) };
  const restore = (root, data) => createRuntimeRecoveryTarget({ root, resources, serviceId: f.identity.sourceServiceId })
    .restore({ directory: f.root, recovery: data, signal: new AbortController().signal });
  await restore(copied, recovery);
  assert.deepEqual(await agentTransferEntries(copied), entries);
  const { agentTransfers: _newFacts, ...oldData } = recovery.data;
  const legacy = await restore(join(f.root, 'legacy'), { ...recovery, schemaVersion: '1', data: oldData });
  assert.equal(legacy.participant.descriptor.schemaVersion, '1', 'legacy isolation keeps the original owner boundary');
  assert.deepEqual(await agentTransferEntries(join(f.root, 'legacy')), []);
  await assert.rejects(restore(join(f.root, 'invalid'), { ...recovery, data: oldData }), { code: 'incompatible-runtime-format' });
  await assert.rejects(restore(join(f.root, 'null'), { ...recovery, data: { ...oldData, agentTransfers: null } }), { code: 'incompatible-runtime-format' });
  const inputFile = join(f.root, 'input.json'), outputFile = join(f.root, 'reply.json');
  await writeFile(inputFile, JSON.stringify({ root: f.root, connectionId: f.connection.connectionId, payload: input, outputFile }));
  await exec(process.execPath, [fileURLToPath(new URL('./support/agent-transfer-client.mjs', import.meta.url)), inputFile]);
  assert.deepEqual(JSON.parse(await readFile(outputFile, 'utf8')), large); assert.equal(f.effects, 1);
  assert.equal((await agentTransferEntries(f.root))[0].state, 'consumed');
  await f.channel.validate();
});

test('unknown effects remain unknown through grant renewal and legitimate installation succession', { timeout: 60000 }, async t => {
  const f = await fixture(t, () => { throw new Error('external effect committed, receipt unknown'); }), input = payload();
  await assert.rejects(f.client()(input), { code: 'commit-unknown' });
  const [entry] = await agentTransferEntries(f.root);
  await f.rotate(true);
  await assert.rejects(f.client()(input), { code: 'commit-unknown' });
  assert.equal((await agentTransferEntries(f.root))[0].transferId, entry.transferId); assert.equal(f.effects, 1);
  const result = await f.wire({ chunkChannel: 1, transferId: randomUUID(), operation: 'recover', origin: entry.origin });
  assert.equal(result.transfers[0].transferId, entry.transferId); assert.equal(result.transfers[0].state, 'unknown');
  assert.deepEqual(await f.wire({ chunkChannel: 1, transferId: entry.transferId, operation: 'ack', origin: entry.origin }), { error: 'conflict' });
  assert.deepEqual(await f.wire({ chunkChannel: 1, transferId: entry.transferId, operation: 'metadata',
    origin: { ...entry.origin, sourceInstallationId: randomUUID() } }), { error: 'forbidden' });
});

test('legacy orphans can be located and only unexecuted records released under a renewed grant', { timeout: 60000 }, async t => {
  const f = await fixture(t), bytes = Buffer.from('{}'), ids = Array.from({ length: 16 }, () => randomUUID());
  const origin = { ...f.identity, grantId: f.grant.grantId };
  for (const transferId of ids) await f.wire({ chunkChannel: 1, transferId, operation: 'begin', byteLength: bytes.length, sha256: checksum(bytes) });
  assert.deepEqual(await f.wire({ chunkChannel: 1, transferId: randomUUID(), operation: 'begin', byteLength: 2, sha256: checksum(bytes) }), { error: 'conflict' });
  await f.rotate();
  const list = await f.wire({ chunkChannel: 1, transferId: randomUUID(), operation: 'recover', origin });
  assert.equal(list.transfers.length, 16);
  for (const entry of list.transfers) {
    assert.equal(entry.state, 'receiving'); assert.deepEqual(entry.input, { byteLength: 2, sha256: checksum(bytes) });
    await f.wire({ chunkChannel: 1, transferId: entry.transferId, operation: 'ack', origin });
  }
  assert.equal(f.effects, 0);
  assert.deepEqual(await f.wire({ chunkChannel: 1, transferId: randomUUID(), operation: 'begin', origin,
    byteLength: 2, sha256: checksum(bytes) }), { error: 'forbidden' }, 'historical grant namespaces cannot create new quota');
  assert.equal((await f.wire({ chunkChannel: 1, transferId: randomUUID(), operation: 'begin', byteLength: 2, sha256: checksum(bytes) })).state, 'receiving');
});

test('two real client processes share one effect identity and the same complete result', { timeout: 60000 }, async t => {
  const f = await fixture(t), input = payload(), inputFile = join(f.root, 'input.json');
  await writeFile(inputFile, JSON.stringify({ root: f.root, connectionId: f.connection.connectionId, payload: input }));
  const script = fileURLToPath(new URL('./support/agent-transfer-client.mjs', import.meta.url));
  await Promise.all([exec(process.execPath, [script, inputFile]), exec(process.execPath, [script, inputFile])]);
  assert.equal(f.effects, 1); assert.equal((await agentTransferEntries(f.root)).length, 1);
});

test('a lost bounded authorization reply is checked again without retaining an old permit', { timeout: 60000 }, async t => {
  const f = await fixture(t), input = { version: 1, operation: 'assertModelDispatch', args: [{ runId: randomUUID(),
    activityId: randomUUID(), driverId: 'driver-1', generation: 1, attemptId: randomUUID(), dispatch: true }] };
  let lost = false, allowed = true;
  f.faults = value => value.operation === 'assertModelDispatch' && !lost && (lost = true);
  f.guard = async () => { if (!allowed) throw new StorageError('forbidden'); };
  await assert.rejects(f.client()(input), { code: 'unavailable' });
  assert.equal((await agentTransferEntries(f.root)).length, 0);
  allowed = false;
  await assert.rejects(f.client()(input), { code: 'forbidden' });
  assert.equal(f.effects, 1, 'a new current check denies the expired permit');
  allowed = true;
  f.guard = async value => { assert.equal(value.args[0].driverId, 'driver-2'); assert.equal(value.args[0].generation, 2); };
  const renewed = { ...input, args: [{ ...input.args[0], driverId: 'driver-2', generation: 2 }] };
  assert.deepEqual(await f.client()(renewed), { accepted: renewed.args });
  assert.equal(f.effects, 2, 'only current authorized queries reach the handler');
});

for (const operation of ['authorize', 'identityFor', 'assertCommandDispatch']) test(`a lost bounded ${operation} reply never caches current authority`, { timeout: 60000 }, async t => {
  const f = await fixture(t), input = { version: 1, operation, args: [{ runId: randomUUID(),
    activityId: randomUUID(), driverId: 'old-driver', generation: 1, attemptId: randomUUID(), dispatch: true }] };
  let lost = false, allowed = true;
  f.faults = value => value.operation === operation && !lost && (lost = true);
  f.guard = async () => { if (!allowed) throw new StorageError('forbidden'); };
  await assert.rejects(f.client()(input), { code: 'unavailable' });
  assert.equal((await agentTransferEntries(f.root)).length, 0);
  allowed = false;
  await assert.rejects(f.client()(input), { code: 'forbidden' });
  assert.equal(f.effects, 1);
});

for (const model of [false, true]) test(`a recovered ${model ? 'model pin' : 'model switch'} receipt rechecks the original domain after revocation`, { timeout: 60000 }, async t => {
  let allowed = true, mutations = 0, saved;
  const f = await fixture(t, input => {
    if (!allowed) return { error: 'forbidden' };
    if (!saved) { mutations++; saved = { accepted: input.args }; }
    return saved;
  });
  const request = { requestId: randomUUID(), selectionVersion: 1 };
  const input = model ? { ...payload(), args: [{ operation: 'selection.pin', args: [request.requestId, 1] }] }
    : { version: 1, operation: 'switchModel', identity: randomUUID(), activityId: randomUUID(), args: [request] };
  let lost = false;
  f.faults = value => value.operation === 'ack' && !lost && (lost = true);
  await assert.rejects(f.client()(input), { code: 'unavailable' });
  assert.equal((await agentTransferEntries(f.root))[0].state, 'received');
  allowed = false;
  await assert.rejects(f.client()(input), { code: 'forbidden' });
  assert.equal(mutations, 1);
  allowed = true;
  assert.deepEqual(await f.client()(input), saved);
  assert.equal(mutations, 1, 'domain request identity preserves the original switch/pin');
});

test('field reordering preserves an effect identity and a consumed temporary rejection can be explicitly retried', { timeout: 60000 }, async t => {
  let accepted = false;
  const f = await fixture(t, input => accepted ? { accepted: input.args } : { error: 'unavailable' }), input = payload();
  await assert.rejects(f.client()(input), { code: 'unavailable' });
  assert.equal((await agentTransferEntries(f.root))[0].state, 'consumed');
  accepted = true;
  const reordered = Object.fromEntries(Object.entries(input).reverse());
  reordered.args = [{ args: [{ text: input.args[0].args[0].text, attemptId: input.args[0].args[0].attemptId }], operation: 'checks.receive' }];
  assert.deepEqual(await f.client()(reordered), { accepted: input.args });
  assert.deepEqual(await f.client()(input), { accepted: input.args });
  assert.equal(f.effects, 2); assert.equal((await agentTransferEntries(f.root)).length, 1);
});

test('a transfer confirmed absent at its original owner keeps its ID when a successor first delivers it', { timeout: 60000 }, async t => {
  const f = await fixture(t), input = payload();
  f.before = value => value.operation === 'invoke';
  await assert.rejects(f.client()(input), { code: 'unavailable' });
  const [before] = await agentTransferEntries(f.root);
  assert.equal((await f.storage.read('SELECT * FROM agent_chunk_transfers')).rows.length, 0);
  await f.rotate(true); f.before = () => false;
  assert.deepEqual(await f.client()(input), { accepted: input.args });
  const [after] = await agentTransferEntries(f.root);
  assert.equal(after.transferId, before.transferId); assert.notEqual(after.origin.grantId, before.origin.grantId);
  assert.equal(f.effects, 1);
});
