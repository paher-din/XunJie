#!/usr/bin/env node
// Standalone distribution consumer. No workspace implementation/pg imports.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rm, statfs, writeFile } from 'node:fs/promises';
import { arch, platform, release } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { acceptanceService, migrations } from './recovery-acceptance-owner.mjs';

const script = fileURLToPath(import.meta.url);
const repository = resolve(dirname(script), '..');
const MiB = 1024 * 1024;
const resourceSize = 128 * MiB;
// Independent oracle: SHA-256 of ASCII "data" repeated 33,554,432 times.
const expectedResourceHash = '8c9bc739874c93cabbe422b97536924fd9303a91771eec226dc3bb915e497ddf';
const usage = `XunJie #145 actual resource-copy capacity failure and independent rebuild.
Usage: node scripts/probe-recovery-disk-space.mjs --package DIR --root NEW_PRIVATE_OUTSIDE --out JSON

macOS arm64 only. Re-executes with the distribution's bundled Node. Imports only
app/product-runtime.js and recovery-acceptance-owner.mjs. --root must not exist;
its parent must exist. All paths are canonicalized (including /tmp aliases).
--out must be a new file outside the repository/package, with an existing parent
or directly under the new root. No credentials, keys or resource bodies in JSON.

Creates ONE new 256 MiB RAM device with hdiutil attach -nomount ram://524288.
Formats ONLY the exact new /dev/diskN returned by that command, with a unique
HFS+ label. No sudo, authorization workaround, guessed device, existing volume,
forced detach, capacity mocking, or injected backend failure. An unsupported or
authorization-required mount stops this probe immediately.

Own source PostgreSQL/storage and backup live on normal disk. A deterministic
128 MiB resource makes the RAM target run out of space after pg_restore, during
object copy. minimumFreeBytes:0 bypasses only the top-level preflight. Read-only
psql proves restored schema/data/gates while the real file backend is reached.
The SAME held backup then rebuilds on normal disk. The target stays isolated;
domain bodies/receipts/unknown IDs and all raw/opaque bytes must match.

finally stops every owned host/pool/PG through product APIs and detaches ONLY
this run's device. Disposable data/key/backup/temporary files are removed after
confirmed stop; JSON is retained. Failed cleanup is reported and never passed.
No package is run by --help or node --check.
`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const exists = async path => { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const inside = (parent, child) => { const path = relative(parent, child); return !path || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)); };
function fail(code) { throw Object.assign(new Error(code), { code }); }
function safeCode(error) {
  if (error instanceof AggregateError && error.errors.length) return safeCode(error.errors[0]);
  return typeof error?.code === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(error.code) ? error.code : 'probe-operation-failed';
}
async function fileHash(path) { const digest = createHash('sha256'); for await (const chunk of createReadStream(path)) digest.update(chunk); return digest.digest('hex'); }
async function capacity(path) {
  const value = await statfs(path, { bigint: true });
  return { at: new Date().toISOString(), totalBytes: Number(value.blocks * value.bsize),
    availableBytes: Number(value.bavail * value.bsize), freeBytes: Number(value.bfree * value.bsize), blockSize: Number(value.bsize) };
}
async function inventory(root, prefix = '') {
  const result = [];
  for (const entry of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await inventory(root, path));
    else {
      assert.ok(entry.isFile(), 'inventory accepts plain files only');
      result.push({ path, byteLength: (await lstat(join(root, path))).size, sha256: await fileHash(join(root, path)) });
    }
  }
  return result;
}
function cleanEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PG/.test(key) && !['NODE_OPTIONS', 'NODE_PATH'].includes(key)));
}
function command(file, args, input) {
  return spawnSync(file, args, { shell: false, encoding: 'utf8', timeout: 30_000,
    maxBuffer: 4 * MiB, input, env: { ...cleanEnv(), LC_ALL: 'C' }, stdio: ['pipe', 'pipe', 'pipe'] });
}
function checkedCommand(file, args, code, input) {
  const value = command(file, args, input);
  if (value.error || value.status !== 0) fail(code);
  return value.stdout;
}
function plist(file, args) {
  return JSON.parse(checkedCommand('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'],
    'invalid-device-plist', checkedCommand(file, args, 'ram-volume-unavailable-or-authorization-required')));
}
function options(argv) {
  const value = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!['--package', '--root', '--out'].includes(flag) || value[flag.slice(2)] || !argv[i + 1] || argv[i + 1].startsWith('--')) fail('invalid-arguments');
    value[flag.slice(2)] = resolve(argv[++i]);
  }
  if (!value.package || !value.root || !value.out) fail('required-arguments-missing');
  return value;
}
async function packageInfo(directory, importApi = false) {
  const root = await realpath(directory), raw = await json(join(root, 'resources.json'));
  const resources = { ...raw };
  for (const key of ['nodePath', 'postgresBin', 'webRoot', 'windowsPrerequisitePath']) if (raw[key]) {
    resources[key] = await realpath(resolve(root, raw[key]));
    if (!inside(root, resources[key])) fail('package-resource-outside-distribution');
  }
  if (!resources.nodePath || !resources.postgresBin || !resources.postgresVersion) fail('full-native-package-required');
  const entry = await realpath(join(root, 'app/product-runtime.js'));
  if (!inside(root, entry)) fail('package-entry-outside-distribution');
  const value = { root, resources, entry };
  if (importApi) {
    value.api = await import(pathToFileURL(entry).href);
    for (const name of ['openProductRuntime', 'createProductRuntimeHost', 'createStorageRecoveryOwner',
      'createStorageRecoveryTarget', 'restoreProductRecovery', 'recoveryDatabase', 'openRecoveredStorage', 'resolveCredential']) {
      if (typeof value.api[name] !== 'function') fail('package-recovery-api-missing');
    }
    for (const name of ['provisionStorage', 'openStorage', 'createFileBackend']) if (typeof value.api.storage?.[name] !== 'function') fail('package-storage-api-missing');
  }
  return value;
}

async function main(opt, pkg) {
  if (platform() !== 'darwin' || arch() !== 'arm64') fail('macos-arm64-required');
  if (process.version !== `v${pkg.resources.nodeVersion}`) fail('package-node-version-mismatch');
  process.umask(0o077);
  const root = join(await realpath(dirname(opt.root)), basename(opt.root));
  const out = dirname(opt.out) === opt.root ? join(root, basename(opt.out)) : join(await realpath(dirname(opt.out)), basename(opt.out));
  const forbidden = [await realpath(repository), pkg.root];
  if (forbidden.some(parent => inside(parent, root) || inside(root, parent) || inside(parent, out))) fail('paths-must-be-outside-repository-and-package');
  if (out === root || inside(out, root)) fail('invalid-evidence-path');
  if (await exists(root) || await exists(out)) fail('root-and-evidence-must-be-new');
  await mkdir(root, { mode: 0o700 });
  const output = await open(out, 'wx', 0o600); await output.close();
  const evidence = { formatVersion: 1, issue: 145, kind: 'real-ramdisk-resource-copy-space-failure', status: 'running',
    startedAt: new Date().toISOString(), root,
    host: { platform: platform(), arch: arch(), release: release(), node: process.version, bundledNode: true },
    package: { root: pkg.root, apiSha256: await fileHash(pkg.entry), resourcesSha256: await fileHash(join(pkg.root, 'resources.json')),
      nodeSha256: await fileHash(pkg.resources.nodePath), postgresSha256: await fileHash(join(pkg.resources.postgresBin, 'postgres')),
      postgresVersion: pkg.resources.postgresVersion },
    probeSha256: await fileHash(script), ownerSha256: await fileHash(fileURLToPath(new URL('./recovery-acceptance-owner.mjs', import.meta.url))),
    stages: [], phases: [], cleanup: [],
    scope: 'Disposable owned installations only; physical capacity limit; no mocked ENOSPC; same held backup; isolated rebuild; no browser or teaching-effect acceptance.' };
  const actors = [], pools = new Set();
  const privateRoot = join(root, 'private'), backupRoot = join(root, 'backups');
  let device, mount, attachedInfo, mountedInfo, interrupted;
  const oldTmp = process.env.TMPDIR;
  const key = randomBytes(48);
  const persist = () => writeFile(out, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  function phase(name, detail = {}) { evidence.phases.push({ phase: name, at: new Date().toISOString(), ...detail }); }
  function checkSignal() { if (interrupted) fail(`interrupted-${interrupted}`); }
  const signalHandler = signal => { interrupted = signal; };
  const onInt = () => signalHandler('SIGINT'), onTerm = () => signalHandler('SIGTERM');
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
  async function stage(name, action) {
    checkSignal();
    const entry = { name, startedAt: new Date().toISOString(), status: 'running' }, started = performance.now();
    evidence.stages.push(entry); await persist(); console.error(`[probe-recovery-disk-space] ${name}`);
    try { entry.result = await action(); checkSignal(); entry.status = 'passed'; return entry.result; }
    catch (error) {
      entry.status = 'failed'; entry.error = safeCode(error);
      const site = /probe-recovery-disk-space\.mjs:(\d+):(\d+)/.exec(String(error?.stack ?? ''));
      if (site) entry.failureSite = { line: Number(site[1]), column: Number(site[2]) };
      throw error;
    } finally { entry.durationMs = Math.round(performance.now() - started); await persist(); }
  }
  function actor(name, actorRoot = join(root, name)) {
    const value = { name, root: actorRoot, runtime: pkg.api.openProductRuntime({ root: actorRoot, resources: pkg.resources }) };
    actors.push(value); return value;
  }
  function track(storage) {
    const close = storage.close.bind(storage); let closing;
    storage.close = () => closing ??= close(); pools.add(storage); return storage;
  }
  function service(storage) {
    return { ...acceptanceService(storage),
      // Inspection only: never opens dispatch or writes to the source/target.
      async unknownIntents() { return (await storage.read('SELECT intent_id AS "intentId",payload FROM _storage_outbox WHERE completed_at IS NULL ORDER BY intent_id')).rows; },
    };
  }
  async function verify(value) {
    const expected = value.expected;
    assert.deepEqual(await value.service.read(expected.record.id), expected.record);
    assert.deepEqual(await value.service.receipt(expected.receipt.requestId), expected.receipt);
    assert.deepEqual(await value.service.unknownIntents(), expected.pending);
    assert.deepEqual(await value.service.structure(), expected.structure);
    const resource = await value.service.resource(expected.reference.resourceId);
    assert.deepEqual(resource.reference, expected.reference);
    assert.equal(resource.bytes.length, resourceSize);
    assert.equal(hash(resource.bytes), expectedResourceHash);
    // Byte comparison against an independent known pattern, not just a source hash.
    for (let offset = 0; offset < resource.bytes.length; offset += MiB) assert.deepEqual(resource.bytes.subarray(offset, offset + MiB), Buffer.alloc(MiB, 'data'));
    const header = Buffer.from(`xunjie-resource/1 ${expected.reference.locator.writeId}\n`, 'ascii');
    assert.deepEqual(resource.opaque.subarray(0, header.length), header);
    assert.deepEqual(resource.opaque.subarray(header.length), resource.bytes);
    assert.equal(hash(resource.opaque), expected.opaqueSha256);
    return { body: true, receipt: true, unknownIntentIdentity: true, constraintsAndSequence: true,
      rawBytes: resource.bytes.length, rawSha256: hash(resource.bytes), opaqueBytes: resource.opaque.length, opaqueSha256: hash(resource.opaque) };
  }
  async function inspectDatabase(value) {
    // The incomplete target has no finalized storage credential. Ask its own
    // product lifecycle for its admin, then use bundled psql READ ONLY.
    const admin = await pkg.api.recoveryDatabase(value.root); assert.ok(admin);
    assert.equal(admin.host, '127.0.0.1');
    assert.ok(/^xjs_[a-f0-9]{32}$/.test(value.schema));
    const passfile = join(privateRoot, `inspect-${randomUUID()}.pgpass`);
    const escape = item => String(item).replaceAll('\\', '\\\\').replaceAll(':', '\\:');
    const schema = `"${value.schema}"`;
    const sql = `BEGIN READ ONLY; SET LOCAL search_path TO ${schema}, pg_catalog;
      SELECT jsonb_build_object('schema',current_schema(),
        'identity',(SELECT to_jsonb(t) FROM _storage_identity t),
        'records',(SELECT jsonb_agg(jsonb_build_object('id',id,'value',value,'seq',seq::text) ORDER BY id) FROM records),
        'receipts',(SELECT jsonb_agg(jsonb_build_object('requestId',request_id,'result',result,'committedAt',committed_at) ORDER BY request_id) FROM _storage_requests),
        'pending',(SELECT jsonb_agg(jsonb_build_object('intentId',intent_id,'payload',payload) ORDER BY intent_id) FROM _storage_outbox WHERE completed_at IS NULL),
        'migrations',(SELECT jsonb_agg(jsonb_build_object('version',version,'name',name) ORDER BY version) FROM _storage_migrations),
        'constraints',(SELECT jsonb_agg(jsonb_build_object('kind',contype::text) ORDER BY contype::text) FROM pg_constraint WHERE conrelid='records'::regclass AND contype IN ('c','p','u')),
        'sequence',(SELECT jsonb_build_object('last_value',last_value::text,'is_called',is_called) FROM records_seq_seq),
        'resources',(SELECT jsonb_agg(reference ORDER BY resource_id) FROM _storage_resources WHERE state='ready'),
        'pins',(SELECT count(*)::integer FROM _storage_pins)); ROLLBACK;`;
    try {
      await writeFile(passfile, [admin.host, admin.port, admin.database, admin.user, admin.password].map(escape).join(':') + '\n', { flag: 'wx', mode: 0o600 });
      const result = spawnSync(join(pkg.resources.postgresBin, 'psql'), ['-X', '-qAt', '--no-password', '-v', 'ON_ERROR_STOP=1',
        '-h', admin.host, '-p', String(admin.port), '-U', admin.user, '-d', admin.database],
      { input: sql, shell: false, encoding: 'utf8', timeout: 15_000, maxBuffer: MiB,
        env: { ...cleanEnv(), PGPASSFILE: passfile, PGCONNECT_TIMEOUT: '5', PGSSLMODE: 'disable', PGOPTIONS: '-c timezone=UTC' } });
      if (result.error || result.status !== 0) fail('readonly-target-inspection-failed');
      const actual = JSON.parse(result.stdout.trim());
      for (const receipt of actual.receipts) receipt.committedAt = new Date(receipt.committedAt).toISOString();
      assert.equal(actual.schema, value.schema);
      assert.equal(actual.identity.environment_id, value.owner.environmentId);
      assert.equal(actual.identity.service_id, value.owner.serviceId);
      assert.equal(actual.identity.writes_open, false); assert.equal(actual.identity.dispatch_open, false);
      assert.deepEqual(actual.records, [value.expected.record]);
      assert.deepEqual(actual.receipts, [value.expected.receipt]);
      assert.deepEqual(actual.pending, value.expected.pending);
      assert.deepEqual(actual.migrations, migrations.map(({ version, name }) => ({ version, name })));
      assert.deepEqual(actual.constraints, value.expected.structure.constraints);
      assert.deepEqual(actual.sequence, value.expected.structure.sequence);
      assert.deepEqual(actual.resources, [value.expected.reference]);
      assert.equal(actual.pins, 1);
      return { schema: value.schema, readOnly: true, restoredRecords: actual.records.length, restoredReceipts: actual.receipts.length,
        unknownIntentId: actual.pending[0].intentId, restoredMigrations: actual.migrations, constraints: actual.constraints,
        sequence: actual.sequence, resourceRows: actual.resources.length, heldBackupPins: actual.pins,
        writesOpen: false, dispatchOpen: false };
    } finally { await rm(passfile, { force: true }); }
  }
  try {
    await mkdir(privateRoot, { mode: 0o700 });
    await mkdir(join(privateRoot, 'tmp'), { mode: 0o700 });
    process.env.TMPDIR = join(privateRoot, 'tmp');
    await writeFile(join(privateRoot, 'recovery-key.base64'), key.toString('base64') + '\n', { flag: 'wx', mode: 0o600 });
    await stage('new-256MiB-ram-volume', async () => {
      const before = new Set(plist('/usr/sbin/diskutil', ['list', '-plist']).AllDisks);
      const result = command('/usr/bin/hdiutil', ['attach', '-nomount', 'ram://524288']);
      // Never infer an ID from a before/after diff, a label, or another volume.
      const returned = [...(result.stdout ?? '').matchAll(/^[\t ]*(\/dev\/disk\d+)[\t ]*\r?$/gm)].map(item => item[1]);
      if (!returned.length && (result.error || result.status !== 0)) fail('ram-volume-unavailable-or-authorization-required');
      if (returned.length !== 1 || before.has(basename(returned[0]))) fail('ram-attach-device-not-unambiguous');
      device = returned[0]; // cleanup ownership acquired solely from this attach
      phase('ram-device-attached', { device });
      if (result.error || result.status !== 0) fail('ram-volume-unavailable-or-authorization-required');
      attachedInfo = plist('/usr/sbin/diskutil', ['info', '-plist', device]);
      assert.equal(attachedInfo.DeviceNode, device); assert.equal(attachedInfo.WholeDisk, true);
      assert.equal(attachedInfo.TotalSize, 256 * MiB);
      assert.notEqual(attachedInfo.Internal, true);
      assert.ok(!attachedInfo.MountPoint);
      checkSignal();
      const label = `XJ145_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
      checkedCommand('/usr/sbin/diskutil', ['eraseVolume', 'HFS+', label, device], 'ram-volume-unavailable-or-authorization-required');
      const info = plist('/usr/sbin/diskutil', ['info', '-plist', device]);
      assert.equal(info.DeviceNode, device); assert.equal(info.VolumeName, label);
      assert.ok(info.MountPoint); assert.equal(info.FilesystemType, 'hfs');
      mountedInfo = info;
      mount = await realpath(info.MountPoint);
      evidence.volume = { device, label, mount, deviceBytes: attachedInfo.TotalSize, filesystem: info.FilesystemType,
        creation: 'hdiutil attach -nomount ram://524288', format: 'diskutil eraseVolume HFS+ <unique-label> <captured-new-device>',
        beforeRestore: await capacity(mount) };
      assert.ok(evidence.volume.beforeRestore.totalBytes <= 256 * MiB);
      assert.notEqual((await lstat(root)).dev, (await lstat(mount)).dev);
      return evidence.volume;
    });
    const source = actor('source'), sentinel = actor('independent-B');
    await stage('independent-B-sentinel', async () => {
      await sentinel.runtime.install({ profile: 'remote', host: '127.0.0.1', database: { mode: 'none' } });
      sentinel.host = await pkg.api.createProductRuntimeHost({ root: sentinel.root });
      assert.equal((await sentinel.host.status()).state, 'ready');
      sentinel.identity = structuredClone(sentinel.host.environment);
      sentinel.before = await inventory(sentinel.root);
      return { environmentId: sentinel.identity.environmentId, installationId: sentinel.identity.installationId, database: 'none', ready: true };
    });
    await stage('source-owner-real-PG-and-128MiB-resource', async () => {
      const serviceId = randomUUID();
      const installed = await source.runtime.install({ profile: 'local', host: '127.0.0.1', requiredServiceIds: [serviceId] });
      source.owner = { environmentId: installed.environment.environmentId, serviceId };
      source.backend = pkg.api.storage.createFileBackend({ id: 'disk-space-files', root: join(source.root, 'objects') });
      source.host = await pkg.api.createProductRuntimeHost({ root: source.root, async createRecoveryOwners() {
        const admin = await pkg.api.recoveryDatabase(source.root); assert.ok(admin);
        source.binding = await pkg.api.storage.provisionStorage({ admin, owner: source.owner, password: randomBytes(32).toString('base64url'), migrations });
        source.schema = source.binding.schema;
        source.storage = track(await pkg.api.storage.openStorage({ binding: source.binding, migrations, backend: source.backend }));
        source.service = service(source.storage);
        return [pkg.api.createStorageRecoveryOwner({ storage: source.storage, binding: source.binding, migrations, resources: pkg.resources,
          async validateService() { if (source.expected) await verify(source); } })];
      } });
      assert.equal((await source.host.status()).state, 'ready');
      const bytes = Buffer.alloc(resourceSize, 'data'); assert.equal(hash(bytes), expectedResourceHash);
      const reference = await source.service.stage(randomUUID(), bytes);
      const intentId = randomUUID(), requestId = randomUUID(), id = 'disk-space-kept';
      const body = { state: 'unknown', effectRequestId: intentId, text: '循阶实际容量故障后重建', fixture: 'public deterministic data' };
      const receipt = await source.service.save({ requestId, id, value: body, references: [reference], intentId });
      const opaque = await source.service.resource(reference.resourceId);
      const pending = [{ intentId, payload: { requestId, recordId: id, externalRequestId: intentId, state: 'unknown' } }];
      assert.deepEqual(await source.service.pending(), pending);
      source.expected = { reference, receipt, pending, record: { id, value: body, seq: '1' },
        structure: await source.service.structure(), opaqueSha256: hash(opaque.opaque) };
      assert.deepEqual(source.expected.structure, { sequence: { last_value: '1', is_called: true }, constraints: [{ kind: 'c' }, { kind: 'p' }, { kind: 'u' }] });
      await verify(source);
      return { ready: true, provisionedAfterPGReady: true, requestId, unknownIntentId: intentId, resourceId: reference.resourceId,
        byteLength: resourceSize, pattern: 'ASCII data repeated 33554432 times', expectedSha256: expectedResourceHash,
        opaqueByteLength: opaque.opaque.length, opaqueSha256: source.expected.opaqueSha256 };
    });
    let backup, backupDirectory, backupBefore, sourceBefore;
    async function sourceSnapshot() {
      await verify(source);
      assert.deepEqual(await json(join(source.root, 'recovery-boundary.json')), { backupId: backup.backupId, boundaryAt: backup.boundaryAt, held: true });
      await assert.rejects(source.service.pending(), error => error.code === 'maintenance');
      return { objects: await inventory(join(source.root, 'objects')),
        configuration: await Promise.all(['installation.json', 'environment.json', 'database.json', 'recovery-boundary.json'].map(async path => ({ path, sha256: await fileHash(join(source.root, path)) }))),
        database: await inspectDatabase(source) };
    }
    await stage('held-consistent-backup-and-source-snapshot', async () => {
      backup = await source.host.recovery.backup({ directory: backupRoot, key, leaveClosed: true });
      backupDirectory = join(backupRoot, backup.backupId);
      backupBefore = await inventory(backupDirectory);
      const snapshotStart = performance.now();
      sourceBefore = await sourceSnapshot();
      return { backupId: backup.backupId, boundaryAt: backup.boundaryAt, completedAt: backup.completedAt,
        durationMs: backup.durationMs, held: true, sourceSnapshotAt: new Date().toISOString(), snapshotDurationMs: Math.round(performance.now() - snapshotStart),
        sourceByteScope: 'All resource objects and immutable installation/environment/database/boundary metadata; live PGDATA is not byte-stable.',
        source: sourceBefore, backupFiles: backupBefore };
    });
    function target(value, observe = false) {
      value.owner = source.owner; value.schema = source.schema; value.expected = source.expected;
      const backend = pkg.api.storage.createFileBackend({ id: source.backend.id, root: join(value.root, 'objects') });
      value.getCalls = 0; value.putCalls = 0; value.restoredCalls = 0;
      value.backend = { id: backend.id, location: backend.location,
        async get(keyValue) {
          value.getCalls++;
          if (observe && value.getCalls === 1) {
            // This is the actual adapter's first per-object check, AFTER pg_restore.
            const db = await inspectDatabase(value);
            value.copyBoundary = { phase: 'resource-copy-after-database-restore', database: db,
              capacity: await capacity(value.root), requiredObjectBytes: value.expected.reference.byteLength +
                Buffer.byteLength(`xunjie-resource/1 ${value.expected.reference.locator.writeId}\n`, 'ascii') };
            phase('resource-copy-after-database-restore', value.copyBoundary);
            await persist();
          }
          return backend.get(keyValue);
        },
        async put(keyValue, bytes) { value.putCalls++; return backend.put(keyValue, bytes); },
        remove: keyValue => backend.remove(keyValue),
      };
      const actual = pkg.api.createStorageRecoveryTarget({ owner: value.owner,
        admin: async () => { const admin = await pkg.api.recoveryDatabase(value.root); assert.ok(admin); return admin; },
        resources: pkg.resources, backend: value.backend, migrations,
        onRestored(storage) { value.restoredCalls++; value.storage = track(storage); value.service = service(storage); },
        async validateService(storage) { await verify({ ...value, service: service(storage) }); },
      });
      return { serviceId: actual.serviceId, validate: owner => actual.validate(owner),
        async restore(input) {
          phase('storage-restore-started', { actor: value.name });
          const artifact = join(input.directory, `${source.expected.reference.resourceId}.blob`);
          value.stagedObject = { byteLength: (await lstat(artifact)).size, sha256: await fileHash(artifact) };
          assert.equal(value.stagedObject.sha256, source.expected.opaqueSha256);
          return actual.restore(input);
        },
      };
    }
    const failed = actor('ram-target', join(mount, 'target'));
    await stage('actual-resource-copy-insufficient-space-after-restored-DB', async () => {
      const adapter = target(failed, true);
      let error;
      try { await pkg.api.restoreProductRecovery({ root: failed.root, backupDirectory, resources: pkg.resources, key,
        targets: [adapter], minimumFreeBytes: 0 }); }
      catch (caught) { error = caught; }
      assert.ok(error); assert.equal(safeCode(error), 'insufficient-space');
      assert.ok(failed.copyBoundary, 'must reach real object copy after restoring owner schema');
      assert.ok(failed.copyBoundary.capacity.availableBytes < failed.copyBoundary.requiredObjectBytes);
      assert.equal(failed.getCalls, 1); assert.equal(failed.putCalls, 0); assert.equal(failed.restoredCalls, 0);
      assert.equal(await exists(join(failed.root, 'credentials', `storage-${source.owner.serviceId}`)), false);
      assert.equal(await exists(join(failed.root, 'instance.json')), false);
      const state = await json(join(failed.root, 'recovery-state.json'));
      assert.equal(state.phase, 'failed'); assert.equal(state.error, 'insufficient-space');
      const operations = await Promise.all((await readdir(join(failed.root, 'recovery-operations'))).map(path => json(join(failed.root, 'recovery-operations', path))));
      assert.equal(operations.length, 1); assert.equal(operations[0].kind, 'restore');
      assert.equal(operations[0].phase, 'failed'); assert.equal(operations[0].error, 'insufficient-space');
      const database = await inspectDatabase(failed);
      assert.deepEqual(await inventory(join(failed.root, 'objects')), []);
      const result = { error: safeCode(error), preflightMinimumFreeBytes: 0, stagedObject: failed.stagedObject,
        copyBoundary: failed.copyBoundary, afterFailureCapacity: await capacity(failed.root), database,
        neverActive: true, targetHostNeverStarted: true, onRestoredCalls: failed.restoredCalls,
        backendGetCalls: failed.getCalls, backendPutCalls: failed.putCalls, state: state.phase,
        operations: operations.map(({ kind, phase: operationPhase, error: operationError, startedAt, updatedAt }) =>
          ({ kind, phase: operationPhase, error: operationError, startedAt, updatedAt })) };
      phase('restore-failed-insufficient-space', { actor: failed.name });
      return result;
    });
    async function untouched() {
      const start = performance.now();
      assert.deepEqual(await sourceSnapshot(), sourceBefore);
      assert.deepEqual(await inventory(backupDirectory), backupBefore);
      assert.equal((await sentinel.host.status()).state, 'ready');
      const response = await fetch(new URL('/runtime/environment', sentinel.host.endpoint), { redirect: 'error', signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200); assert.deepEqual(await response.json(), sentinel.identity);
      assert.deepEqual(await inventory(sentinel.root), sentinel.before);
      return { sourceServiceAndObjectBytesUnchanged: true, sourceMetadataBytesUnchanged: true, backupAllBytesUnchanged: true,
        sourceSnapshotAt: new Date().toISOString(), snapshotDurationMs: Math.round(performance.now() - start),
        independentBReadyAndAllFilesUnchanged: true, sourceHeld: true };
    }
    await stage('source-backup-and-independent-B-unchanged-after-failure', untouched);
    const rebuilt = actor('normal-disk-rebuild');
    await stage('same-backup-independent-normal-disk-rebuild', async () => {
      assert.equal(await exists(rebuilt.root), false);
      assert.notEqual((await lstat(root)).dev, (await lstat(mount)).dev);
      const adapter = target(rebuilt);
      const restored = await pkg.api.restoreProductRecovery({ root: rebuilt.root, backupDirectory, resources: pkg.resources, key, targets: [adapter] });
      assert.equal(restored.manifest.backupId, backup.backupId);
      assert.equal((await json(join(rebuilt.root, 'recovery-state.json'))).phase, 'isolated');
      assert.equal(rebuilt.restoredCalls, 1); assert.equal(rebuilt.putCalls, 1);
      assert.equal(await exists(join(rebuilt.root, 'instance.json')), false);
      const result = await verify(rebuilt);
      assert.equal(rebuilt.expected.receipt.result.effectRequestId, source.expected.pending[0].intentId);
      assert.equal(rebuilt.expected.record.value.effectRequestId, source.expected.pending[0].intentId);
      await assert.rejects(rebuilt.service.pending(), error => error.code === 'maintenance');
      await assert.rejects(rebuilt.service.save({ requestId: randomUUID(), id: 'isolated-denied', value: {} }), error => error.code === 'maintenance');
      assert.equal(await rebuilt.service.read('isolated-denied'), null);
      const binding = JSON.parse(await pkg.api.resolveCredential(rebuilt.root, `storage-${source.owner.serviceId}`));
      assert.notEqual(binding.connection.password, source.binding.connection.password);
      assert.notEqual(binding.connection.port, source.binding.connection.port);
      assert.notEqual((await json(join(rebuilt.root, 'database.json'))).systemIdentifier, (await json(join(source.root, 'database.json'))).systemIdentifier);
      // Reopen only with the credential persisted by the product target.
      const reopened = track(await pkg.api.openRecoveredStorage({ root: rebuilt.root, serviceId: source.owner.serviceId,
        migrations, backend: pkg.api.storage.createFileBackend({ id: source.backend.id, root: join(rebuilt.root, 'objects') }) }));
      await verify({ ...rebuilt, service: service(reopened) });
      await reopened.close();
      phase('independent-rebuild-isolated', { actor: rebuilt.name, backupId: backup.backupId });
      return { backupId: backup.backupId, independentInstallation: true, independentPG: true, isolated: true,
        neverActivated: true, writesAndDispatchRejected: true, rotatedCredentialPersistedAndReopened: true, ...result };
    });
    await stage('source-backup-and-independent-B-unchanged-after-rebuild', untouched);
    evidence.status = 'passed';
  } catch (error) {
    evidence.status = 'failed'; evidence.error = safeCode(error);
    if (/ram-(volume|attach)/.test(evidence.error)) evidence.blocked = 'RAM volume unsupported or unavailable; no authorization bypass or alternative device attempted.';
  } finally {
    async function cleanup(name, action) {
      const entry = { name, startedAt: new Date().toISOString(), status: 'running' };
      evidence.cleanup.push(entry);
      try { entry.result = await action(); entry.status = 'passed'; return true; }
      catch (error) { entry.status = 'failed'; entry.error = safeCode(error); evidence.status = 'failed'; return false; }
      finally {
        // Losing the evidence destination must not skip the remaining stops or
        // the owned-device detach. Report it after all cleanup has been tried.
        try { await persist(); }
        catch (error) { evidence.status = 'failed'; evidence.evidenceWriteError = safeCode(error); }
      }
    }
    for (const value of [...actors].reverse()) {
      const hostStopped = await cleanup(`${value.name}:host-stop`, async () => { if (value.host) await value.host.stop(); return { hadHost: Boolean(value.host) }; });
      value.hostStopped = hostStopped;
    }
    await cleanup('all-owned-storage-pools-close', async () => {
      const results = await Promise.allSettled([...pools].map(storage => storage.close()));
      const failures = results.filter(result => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map(result => result.reason));
      return { count: results.length };
    });
    for (const value of [...actors].reverse()) {
      value.stopped = await cleanup(`${value.name}:product-PG-stop`, async () => {
        if (await exists(join(value.root, 'installation.json'))) {
          assert.equal((await value.runtime.stop()).state, 'stopped');
          assert.equal(await exists(join(value.root, 'pgdata/postmaster.pid')), false);
          assert.equal(await exists(join(value.root, 'instance.json')), false);
        }
        return { stopped: true };
      });
      if (value.stopped && value.hostStopped) await cleanup(`${value.name}:disposable-data-remove`, async () => {
        await rm(value.root, { recursive: true, force: true }); return { removed: true };
      });
    }
    if (device) await cleanup('detach-only-captured-new-RAM-device', async () => {
      // Revalidate the device identity; never use a mount path, guessed ID or -force.
      const current = plist('/usr/sbin/diskutil', ['info', '-plist', device]);
      assert.equal(current.DeviceNode, device); assert.equal(current.TotalSize, 256 * MiB);
      if (mountedInfo?.VolumeUUID) assert.equal(current.VolumeUUID, mountedInfo.VolumeUUID);
      if (attachedInfo?.DeviceTreePath) assert.equal(current.DeviceTreePath, attachedInfo.DeviceTreePath);
      checkedCommand('/usr/bin/hdiutil', ['detach', device], 'owned-RAM-device-detach-failed');
      const remaining = plist('/usr/sbin/diskutil', ['list', '-plist']).AllDisks;
      assert.equal(remaining.includes(basename(device)), false);
      return { device, detached: true, force: false };
    });
    await cleanup('private-key-backup-and-temporary-files-remove', async () => {
      await rm(backupRoot, { recursive: true, force: true });
      await rm(privateRoot, { recursive: true, force: true });
      key.fill(0);
      return { privateKeyRemoved: true, encryptedBackupRemoved: true, temporaryFilesRemoved: true };
    });
    if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp;
    process.off('SIGINT', onInt); process.off('SIGTERM', onTerm);
    if (interrupted) { evidence.status = 'failed'; evidence.error = `interrupted-${interrupted}`; }
    evidence.finishedAt = new Date().toISOString(); evidence.durationMs = Date.parse(evidence.finishedAt) - Date.parse(evidence.startedAt);
    evidence.disposableDataRemoved = evidence.cleanup.every(entry => entry.status === 'passed');
    await persist();
  }
  console.log(`Disk-space recovery ${evidence.status}; evidence: ${out}`);
  if (evidence.status !== 'passed') process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  if (process.argv.includes('--help')) console.log(usage);
  else {
    try {
      const opt = options(process.argv.slice(2)), pkg = await packageInfo(opt.package);
      if (await realpath(process.execPath) !== await realpath(pkg.resources.nodePath)) {
        const child = spawn(pkg.resources.nodePath, [script, ...process.argv.slice(2)], { shell: false, stdio: 'inherit', env: cleanEnv() });
        const forwardInt = () => child.kill('SIGINT'), forwardTerm = () => child.kill('SIGTERM');
        process.on('SIGINT', forwardInt); process.on('SIGTERM', forwardTerm);
        try { process.exitCode = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', (code, signal) => done(signal ? 1 : code ?? 1)); }); }
        finally { process.off('SIGINT', forwardInt); process.off('SIGTERM', forwardTerm); }
      } else await main(opt, await packageInfo(opt.package, true));
    } catch (error) { console.error(`Disk-space recovery failed: ${safeCode(error)}`); process.exitCode = 1; }
  }
}
