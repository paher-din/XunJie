import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID, createHash, createHmac } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat, symlink, rename, statfs, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sealRecovery, verifyRecovery, unsealRecovery, ensureRecoverySpace, checkIndependentDirectory } from '../dist/recovery-files.js';

function metadata() {
  const environmentId = randomUUID();
  const serviceId = randomUUID();
  return {
    formatVersion: 1, backupId: randomUUID(),
    source: { formatVersion: 1, environmentId, installationId: randomUUID(), clientNamespace: 'course', profile: 'local',
      services: [{ environmentId, serviceId, unit: 'learning-data', endpoint: 'https://localhost:3445/', protocolVersion: 1, capabilities: ['recovery'] }] },
    boundaryAt: '2026-10-30T00:00:00.000Z', completedAt: '2026-10-30T00:00:01.000Z', durationMs: 1000,
    services: [{ serviceId, schemaVersion: '1', engineVersion: '17.6' }], receiverIds: [`${randomUUID()}/${randomUUID()}`],
  };
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'xj-recovery-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const backup = join(root, 'backup');
  const destination = join(root, 'destination');
  await mkdir(join(backup, 'payload'), { recursive: true, mode: 0o700 });
  await mkdir(destination, { mode: 0o700 });
  return { root, backup, destination, key: randomBytes(48), metadata: metadata() };
}

test('public helpers round-trip nested owner data and resource bytes without publishing plaintext', async (t) => {
  const f = await fixture(t);
  const ownerPath = `${f.metadata.services[0].serviceId}/recovery.json`;
  const owner = JSON.stringify({ formatVersion: 1, schemaVersion: '1', data: { credential: 'private-owner-value' } });
  const resource = randomBytes(2 * 1024 * 1024 + 13);
  await mkdir(join(f.backup, 'payload', f.metadata.services[0].serviceId));
  await writeFile(join(f.backup, 'payload', ownerPath), owner);
  await mkdir(join(f.backup, 'payload', 'resources'));
  await writeFile(join(f.backup, 'payload', 'resources', 'bytes.bin'), resource);
  await writeFile(join(f.backup, 'payload', 'empty'), '');
  const manifest = await sealRecovery(f.backup, f.key, f.metadata);
  assert.deepEqual(manifest.artifacts.map((item) => item.path).sort(), [ownerPath, 'empty', 'resources/bytes.bin'].sort());
  assert.equal((await readFile(join(f.backup, 'manifest.json'), 'utf8')).includes('private-owner-value'), false);
  assert.equal((await readdir(f.backup)).includes('payload'), false);
  for (const artifact of manifest.artifacts) {
    const cipher = await readFile(join(f.backup, 'artifacts', artifact.path));
    assert.equal(artifact.byteLength, cipher.length);
    assert.equal(artifact.sha256, createHash('sha256').update(cipher).digest('hex'));
    assert.equal(cipher.includes(Buffer.from('private-owner-value')), false);
  }
  assert.deepEqual(await verifyRecovery(f.backup, f.key), manifest);
  assert.deepEqual(await unsealRecovery(f.backup, f.destination, f.key), manifest);
  assert.equal(await readFile(join(f.destination, ownerPath), 'utf8'), owner);
  assert.deepEqual(await readFile(join(f.destination, 'resources/bytes.bin')), resource);
  assert.equal((await stat(join(f.destination, 'empty'))).size, 0);
  assert.deepEqual(await verifyRecovery(f.backup, f.key), manifest);
});

async function sealed(t) {
  const f = await fixture(t);
  await writeFile(join(f.backup, 'payload', 'a'), 'first private owner');
  await writeFile(join(f.backup, 'payload', 'b'), 'second private owner');
  f.manifest = await sealRecovery(f.backup, f.key, f.metadata);
  return f;
}
function fixedError(error) {
  assert.ok(error instanceof Error);
  assert.equal(error.message, error.code);
  assert.match(error.code, /^(invalid-recovery(?:-key|-path|-destination)?|recovery-io-error|insufficient-space|invalid-space-requirement)$/);
  return true;
}
// A producer with the real recovery key can sign a malformed backup. Consumers must
// still enforce schema/path limits and complete every file's GCM authentication.
function canonicalFixture(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalFixture).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalFixture(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
async function publishFixture(f, manifest, sign = true) {
  if (sign) {
    const { authentication: _, ...fields } = manifest;
    const key = createHmac('sha256', f.key).update('xunjie/recovery/v1/authentication').digest();
    manifest.authentication = createHmac('sha256', key).update(canonicalFixture(fields)).digest('hex');
  }
  await writeFile(join(f.backup, 'manifest.json'), JSON.stringify(manifest));
}

test('wrong keys, metadata/path changes, ciphertext changes and missing/extra files fail closed', async (t) => {
  const f = await sealed(t);
  const original = await readFile(join(f.backup, 'manifest.json'));
  await assert.rejects(unsealRecovery(f.backup, f.destination, randomBytes(32)), fixedError);
  for (const mutate of [
    (m) => { m.receiverIds.push(`${randomUUID()}/${randomUUID()}`); },
    (m) => { m.artifacts[0].path = 'renamed'; },
    (m) => { m.durationMs += 1; },
    (m) => { m.services[0].schemaVersion = '2'; },
    (m) => { m.source.clientNamespace = 'other'; },
  ]) {
    const m = JSON.parse(original); mutate(m); await publishFixture(f, m, false);
    await assert.rejects(verifyRecovery(f.backup, f.key), fixedError);
  }
  await writeFile(join(f.backup, 'manifest.json'), original);
  const cipherPath = join(f.backup, 'artifacts', 'a');
  const cipher = await readFile(cipherPath);
  const altered = Buffer.from(cipher); altered[12] ^= 1;
  await writeFile(cipherPath, altered);
  await assert.rejects(unsealRecovery(f.backup, f.destination, f.key), fixedError);
  await writeFile(cipherPath, cipher.subarray(0, cipher.length - 1));
  await assert.rejects(verifyRecovery(f.backup, f.key), fixedError);
  await rm(cipherPath);
  await assert.rejects(verifyRecovery(f.backup, f.key), fixedError);
  await writeFile(cipherPath, cipher);
  await writeFile(join(f.backup, 'artifacts', 'extra'), 'extra');
  await assert.rejects(verifyRecovery(f.backup, f.key), fixedError);
  await rm(join(f.backup, 'artifacts', 'extra'));
  assert.deepEqual(await readdir(f.destination), []);
  assert.deepEqual(await verifyRecovery(f.backup, f.key), f.manifest);
});

test('even correctly signed invalid GCM never publishes earlier plaintext or leaves staging', async (t) => {
  const f = await sealed(t);
  const cipherPath = join(f.backup, 'artifacts', 'b');
  const cipher = await readFile(cipherPath); cipher[cipher.length - 1] ^= 1;
  await writeFile(cipherPath, cipher);
  const m = structuredClone(f.manifest);
  m.artifacts.find((a) => a.path === 'b').sha256 = createHash('sha256').update(cipher).digest('hex');
  await publishFixture(f, m);
  await verifyRecovery(f.backup, f.key);
  const entries = (await readdir(f.root)).sort();
  await assert.rejects(unsealRecovery(f.backup, f.destination, f.key), fixedError);
  assert.deepEqual(await readdir(f.destination), []);
  assert.deepEqual((await readdir(f.root)).sort(), entries);
  assert.deepEqual(await readFile(cipherPath), cipher);
});

test('schema and paths are validated even with a valid HMAC', async (t) => {
  const f = await sealed(t);
  for (const mutate of [
    (m) => { m.formatVersion = 2; },
    (m) => { m.backupId = 'private-not-a-uuid'; },
    (m) => { m.source.environmentId = randomUUID(); },
    (m) => { m.source.formatVersion = 2; },
    (m) => { m.source.services[0].protocolVersion = 2; },
    (m) => { m.source.services.push(structuredClone(m.source.services[0])); },
    (m) => { m.services.push(structuredClone(m.services[0])); },
    (m) => { m.services[0].schemaVersion = ''; },
    (m) => { m.services[0].engineVersion = 17; },
    (m) => { m.services[0].serviceId = 'not-a-uuid'; },
    (m) => { m.receiverIds.push(m.receiverIds[0]); },
    (m) => { m.completedAt = '2026-02-30T00:00:00.000Z'; },
    (m) => { m.durationMs = -1; },
    (m) => { m.artifacts.push(structuredClone(m.artifacts[0])); },
    (m) => { m.artifacts[1].path = 'A'; },
    (m) => { m.artifacts[1].path = 'a/child'; },
    (m) => { m.artifacts[0].byteLength = 1.5; },
    (m) => { m.artifacts[0].sha256 = 'untrusted'; },
    (m) => { m.secret = 'private-extra'; },
    (m) => { m.source.credential = 'private-extra'; },
    (m) => { m.source.services[0].endpoint = 'https://user:private@localhost/'; },
    (m) => { m.source.services[0].endpoint = 'https://localhost/?key=private'; },
    ...['../escape', '/absolute', 'a/../escape', 'a//b', 'a\\b', 'C:escape', 'con', 'name.', 'a\0b'].map((path) => (m) => { m.artifacts[0].path = path; }),
  ]) {
    const m = structuredClone(f.manifest); mutate(m); await publishFixture(f, m);
    await assert.rejects(unsealRecovery(f.backup, f.destination, f.key), fixedError);
    assert.deepEqual(await readdir(f.destination), []);
  }
});

test('manifest size and repeated JSON fields are rejected before reading artifacts', async (t) => {
  const f = await sealed(t);
  await writeFile(join(f.backup, 'manifest.json'), ' '.repeat(4 * 1024 * 1024 + 1));
  await assert.rejects(verifyRecovery(f.backup, f.key), fixedError);
  // JSON.parse alone silently overwrites this field, hiding data from the MAC.
  await writeFile(join(f.backup, 'manifest.json'), JSON.stringify(f.manifest).replace('{', '{"backupId":"private-hidden-value",'));
  await assert.rejects(verifyRecovery(f.backup, f.key), fixedError);
});

test('real owners need not have a public source endpoint, and receivers use environment/service authority IDs', async (t) => {
  const f = await fixture(t);
  f.metadata.services[0].serviceId = randomUUID();
  f.metadata.receiverIds.push(randomUUID());
  await writeFile(join(f.backup, 'payload', 'state'), 'private');
  const manifest = await sealRecovery(f.backup, f.key, f.metadata);
  assert.deepEqual((await verifyRecovery(f.backup, f.key)).services, f.metadata.services);
  assert.deepEqual((await unsealRecovery(f.backup, f.destination, f.key)).receiverIds, manifest.receiverIds);
  assert.equal(await readFile(join(f.destination, 'state'), 'utf8'), 'private');
  for (const receiver of ['not-a-uuid', `${randomUUID()}/not-a-uuid`, `../${randomUUID()}`, `${randomUUID()}/${randomUUID()}/extra`]) {
    const m = structuredClone(manifest); m.receiverIds = [receiver]; await publishFixture(f, m);
    await assert.rejects(verifyRecovery(f.backup, f.key), fixedError);
  }
});

const directoryLinkType = process.platform === 'win32' ? 'junction' : 'dir';

test('symlinks in payload, cipher files, cipher directories and the catalog are rejected without deleting their targets', async (t) => {
  const f = await fixture(t);
  const external = join(f.root, 'external');
  await mkdir(external);
  const secret = join(external, 'secret');
  await writeFile(secret, 'external-private-value');
  await symlink(secret, join(f.backup, 'payload', 'link'), 'file');
  await assert.rejects(sealRecovery(f.backup, f.key, f.metadata), fixedError);
  assert.equal(await readFile(secret, 'utf8'), 'external-private-value');
  assert.equal((await readdir(f.backup)).includes('payload'), false);
  await symlink(external, join(f.backup, 'payload'), directoryLinkType);
  await assert.rejects(sealRecovery(f.backup, f.key, f.metadata), fixedError);
  assert.equal(await readFile(secret, 'utf8'), 'external-private-value');

  const b = await sealed(t);
  const cipher = join(b.backup, 'artifacts', 'a');
  await rename(cipher, join(b.root, 'cipher'));
  await symlink(join(b.root, 'cipher'), cipher, 'file');
  await assert.rejects(verifyRecovery(b.backup, b.key), fixedError);
  await rm(cipher);
  await rename(join(b.root, 'cipher'), cipher);
  await rename(join(b.backup, 'artifacts'), join(b.root, 'cipher-directory'));
  await symlink(join(b.root, 'cipher-directory'), join(b.backup, 'artifacts'), directoryLinkType);
  await assert.rejects(unsealRecovery(b.backup, b.destination, b.key), fixedError);
  await rm(join(b.backup, 'artifacts'), { recursive: true, force: true });
  await rename(join(b.root, 'cipher-directory'), join(b.backup, 'artifacts'));
  await rename(join(b.backup, 'manifest.json'), join(b.root, 'catalog'));
  await symlink(join(b.root, 'catalog'), join(b.backup, 'manifest.json'), 'file');
  await assert.rejects(verifyRecovery(b.backup, b.key), fixedError);
  assert.deepEqual(await readdir(b.destination), []);
});

test('nested payload directory aliases are rejected and plaintext is cleaned on validation/key/reseal failures', async (t) => {
  const f = await fixture(t);
  const external = join(f.root, 'external'); await mkdir(external);
  await writeFile(join(external, 'state'), 'external value');
  await symlink(external, join(f.backup, 'payload', 'nested'), directoryLinkType);
  await assert.rejects(sealRecovery(f.backup, f.key, f.metadata), fixedError);
  assert.equal(await readFile(join(external, 'state'), 'utf8'), 'external value');
  for (const key of [randomBytes(31), 'private-bad-key']) {
    await mkdir(join(f.backup, 'payload'));
    await writeFile(join(f.backup, 'payload', 'private'), 'discard me');
    await assert.rejects(sealRecovery(f.backup, key, f.metadata), fixedError);
    assert.equal((await readdir(f.backup)).includes('payload'), false);
  }
  await mkdir(join(f.backup, 'payload'));
  await writeFile(join(f.backup, 'payload', 'private'), 'discard me');
  await assert.rejects(sealRecovery(f.backup, f.key, { ...f.metadata, secret: 'never public' }), fixedError);
  assert.equal((await readdir(f.backup)).includes('payload'), false);
  const b = await sealed(t);
  const cipher = await readFile(join(b.backup, 'artifacts', 'a'));
  await mkdir(join(b.backup, 'payload'));
  await writeFile(join(b.backup, 'payload', 'private'), 'discard me');
  await assert.rejects(sealRecovery(b.backup, b.key, b.metadata), fixedError);
  assert.deepEqual(await readFile(join(b.backup, 'artifacts', 'a')), cipher);
  assert.deepEqual(await verifyRecovery(b.backup, b.key), b.manifest);
  assert.equal((await readdir(b.backup)).includes('payload'), false);
});

test('unseal refuses occupied, shared, linked and overlapping destinations, preserving caller data', async (t) => {
  const f = await sealed(t);
  await writeFile(join(f.destination, 'caller-owned'), 'keep me');
  await assert.rejects(unsealRecovery(f.backup, f.destination, f.key), fixedError);
  assert.equal(await readFile(join(f.destination, 'caller-owned'), 'utf8'), 'keep me');
  await rm(join(f.destination, 'caller-owned'));
  if (process.platform !== 'win32') {
    await chmod(f.destination, 0o755);
    await assert.rejects(unsealRecovery(f.backup, f.destination, f.key), fixedError);
    await chmod(f.destination, 0o700);
  }
  const alias = join(f.root, 'destination-alias');
  await symlink(f.destination, alias, directoryLinkType);
  await assert.rejects(unsealRecovery(f.backup, alias, f.key), fixedError);
  await mkdir(join(f.backup, 'target'), { mode: 0o700 });
  await assert.rejects(unsealRecovery(f.backup, join(f.backup, 'target'), f.key), fixedError);
  assert.deepEqual(await readdir(f.destination), []);
  assert.deepEqual(await verifyRecovery(f.backup, f.key), f.manifest);
});

test('parent aliases resolve to a real root and per-file random IVs change otherwise identical backups', async (t) => {
  const f = await fixture(t);
  const alias = join(f.root, 'parent-alias');
  await symlink(f.root, alias, directoryLinkType);
  await writeFile(join(f.backup, 'payload', 'same'), 'identical content');
  await writeFile(join(f.backup, 'payload', 'same-again'), 'identical content');
  await sealRecovery(join(alias, 'backup'), f.key, f.metadata);
  const first = await readFile(join(f.backup, 'artifacts', 'same'));
  const second = await readFile(join(f.backup, 'artifacts', 'same-again'));
  assert.notDeepEqual(first.subarray(0, 12), second.subarray(0, 12));
  await unsealRecovery(join(alias, 'backup'), join(alias, 'destination'), f.key);
  assert.equal(await readFile(join(f.destination, 'same'), 'utf8'), 'identical content');
  if (process.platform !== 'win32') assert.equal((await stat(join(f.destination, 'same'))).mode & 0o777, 0o600);
});

test('independence preflight rejects both nesting directions, resource overlaps and aliases without mkdir', async (t) => {
  const f = await fixture(t);
  const data = join(f.root, 'data'); await mkdir(data);
  const resource = join(f.root, 'resources'); await mkdir(resource);
  const independent = join(f.root, 'new-parent', 'new-backup');
  await checkIndependentDirectory(data, independent, [resource]);
  assert.equal((await readdir(f.root)).includes('new-parent'), false);
  for (const backup of [data, join(data, 'nested'), f.root, resource, join(resource, 'nested')]) {
    await assert.rejects(checkIndependentDirectory(data, backup, [resource]), fixedError);
  }
  const alias = join(f.root, 'alias'); await symlink(data, alias, directoryLinkType);
  await assert.rejects(checkIndependentDirectory(data, join(alias, 'not-created')), fixedError);
  await assert.rejects(checkIndependentDirectory(join(alias, 'future'), data), fixedError);
  const missingTarget = join(f.root, 'restore-target');
  await checkIndependentDirectory(missingTarget, f.backup);
  assert.equal((await readdir(f.root)).includes('restore-target'), false);
  await mkdir(join(data, 'deep'));
  const deepAlias = join(f.root, 'deep-alias'); await symlink(join(data, 'deep'), deepAlias, directoryLinkType);
  // Resolving '..' lexically before following this symlink would miss the overlap.
  await assert.rejects(checkIndependentDirectory(data, `${deepAlias}/../hidden-backup`), fixedError);
});

test('space preflight is explicit, rejects noncanonical numeric input and reports actual insufficient capacity', async (t) => {
  const f = await fixture(t);
  const target = join(f.root, 'new', 'backup');
  for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1024', null, 1024n]) {
    await assert.rejects(ensureRecoverySpace(target, value), fixedError);
    assert.equal((await readdir(f.root)).includes('new'), false);
  }
  await ensureRecoverySpace(target, 0);
  assert.equal((await stat(target)).isDirectory(), true);
  await ensureRecoverySpace(target, 1024);
  const capacity = await statfs(target, { bigint: true });
  const unavailable = capacity.bavail * capacity.bsize + 1024n * 1024n * 1024n;
  assert.ok(unavailable < BigInt(Number.MAX_SAFE_INTEGER));
  await assert.rejects(ensureRecoverySpace(target, Number(unavailable)), (error) => {
    assert.equal(error.code, 'insufficient-space');
    assert.equal(error.message, 'insufficient-space');
    return true;
  });
});
