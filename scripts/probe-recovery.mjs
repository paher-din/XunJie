#!/usr/bin/env node
// Standalone distribution consumer: imports only Node builtins, this owner and
// <package>/app/product-runtime.js. No workspace code, fixtures or pg dependency.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, lstat, mkdir, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { arch, platform, release } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { acceptanceService, migrations, upgradedMigrations, validateAcceptanceService, portableExpected, restoreExpected } from './recovery-acceptance-owner.mjs';

const usage = `Standalone XunJie #145 distribution recovery acceptance.
Usage: node scripts/probe-recovery.mjs --package DIR --root NEW_OUTSIDE_DIR --out evidence.json
  [--s3-config PRIVATE_JSON] [--old-package DIR] [--minor-package DIR]
Import only (isolated, no source contact or takeover):
  node scripts/probe-recovery.mjs --package DIR --root NEW_OUTSIDE_DIR --out evidence.json
    --import-backup BACKUP_DIR --key-file PRIVATE_KEY_FILE --expect-file portability.private.json

Automatically re-executes with --package's bundled Node. Requires a full native
distribution exporting storage and the recovery APIs from app/product-runtime.js.
Uses new managed PostgreSQL installations and its own records service only.
The root must not exist and must be outside the repository and all packages.
All owned hosts/pools/clusters stop in finally. Data, encrypted backups and a
private recovery key are retained under root; no existing work is removed.
S3 config uses storage-s3-fixture.mjs fields. targetBucket is optional when its
credentials permit creating a new bucket. Source and target backend IDs match.
Without optional package/config flags the corresponding acceptance is skipped.
Normal runs export portability.private.json at root alongside the file backup.
Transfer that private file, private/recovery-key.base64, and file-backups/<backupId>/
(manifest.json and artifacts/) to another OS. Import always uses independent file
storage with the original backend ID. Expected opaque/raw bytes use explicit base64.
The crash case kills an owned restore subprocess after actual database/resource
restore, before the isolated marker commits, then rebuilds from the same backup.
`;
const script = fileURLToPath(import.meta.url);
const repository = resolve(dirname(script), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const exists = async path => { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const inside = (parent, child) => { const path = relative(parent, child); return !path || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)); };
function fail(code) { throw Object.assign(new Error(code), { code }); }
function errorCode(error) { return typeof error?.code === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(error.code) ? error.code : 'probe-operation-failed'; }
async function fileHash(path) { const value = createHash('sha256'); for await (const chunk of createReadStream(path)) value.update(chunk); return value.digest('hex'); }

function privateWindowsRoot(root) {
  if (process.platform !== 'win32') return;
  const literal = "'" + root.replaceAll("'", "''") + "'";
  const command = `$ErrorActionPreference='Stop'
$path=${literal}
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
if ((Get-Acl -LiteralPath $path).GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Root owner mismatch' }
$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true,$false)
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
Set-Acl -LiteralPath $path -AclObject $acl
`;
  const result = spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
    { shell: false, windowsHide: true, encoding: 'utf8', timeout: 15_000 });
  if (result.error || result.status !== 0) fail('private-root-acl-failed');
}

function options(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!['--package', '--out', '--root', '--s3-config', '--old-package', '--minor-package',
      '--import-backup', '--key-file', '--expect-file', '--crash-restore-state'].includes(flag)
      || !argv[i + 1] || argv[i + 1].startsWith('--') || result[flag.slice(2)]) fail('invalid-arguments');
    result[flag.slice(2)] = resolve(argv[++i]);
  }
  if (!result.package || (!result['crash-restore-state'] && (!result.out || !result.root))) fail('required-arguments-missing');
  if (result['import-backup'] || result['key-file'] || result['expect-file']) {
    if (!result['import-backup'] || !result['key-file'] || !result['expect-file']
      || result['s3-config'] || result['old-package'] || result['minor-package']) fail('invalid-import-arguments');
  }
  return result;
}

async function privateJson(path) {
  const info = await lstat(path);
  if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o077))) fail('private-input-file-required');
  return json(path);
}
async function keyFromFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o077))) fail('private-key-file-required');
  const content = await readFile(path);
  const encoded = content.toString('utf8').trim();
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.length >= 32 && decoded.toString('base64') === encoded) return decoded;
  if (content.length >= 32) return content;
  fail('invalid-recovery-key');
}

async function crashRestoreChild(opt, pkg) {
  const input = await privateJson(opt['crash-restore-state']);
  const expected = await privateJson(input.expectFile);
  const key = await keyFromFile(input.keyFile);
  let storage;
  try {
    const backend = pkg.api.storage.createFileBackend({ id: expected.backendId, root: join(input.root, 'objects') });
    const recoveryTarget = pkg.api.createStorageRecoveryTarget({ owner: expected.owner,
      admin: async () => pkg.api.recoveryDatabase(input.root), resources: pkg.resources,
      backend, migrations: expected.migrations,
      onRestored(value) { storage = value; },
      async validateService(value) {
        const service = acceptanceService(value);
        await validateAcceptanceService(service, restoreExpected(expected.expected));
        if (input.kind === 'schema') assert.deepEqual(await service.schemaUpgrade(), [{ upgrade_note: 'schema-v2' }]);
        // Pause inside a real restore, before restoreRecoverySet can publish an
        // isolated/active state. Only the parent can end this owned subprocess.
        process.send?.({ phase: 'restored-before-isolated-commit', ...(input.kind === 'schema' ? { schemaVersion: 2 } : {}) });
        await new Promise(() => {});
      },
    });
    const targetOptions = { root: input.root, backupDirectory: input.backupDirectory,
      resources: pkg.resources, key, targets: [recoveryTarget] };
    if (input.kind) await pkg.api.upgradeProductRecovery({ ...targetOptions, kind: input.kind,
      sourceRoot: input.sourceRoot, backupDirectory: dirname(input.backupDirectory), backup: async () => input.manifest });
    else await pkg.api.restoreProductRecovery(targetOptions);
    fail('crash-child-unexpectedly-completed');
  } catch (error) {
    process.send?.({ error: errorCode(error) });
    await storage?.close().catch(() => {});
    if (await exists(join(input.root, 'installation.json'))) await pkg.api.openProductRuntime({ root: input.root }).stop().catch(() => {});
    process.exitCode = 1;
    process.disconnect?.();
  }
}
async function packageInfo(directory, importApi = true) {
  const root = await realpath(directory);
  const raw = await json(join(root, 'resources.json'));
  const resources = { ...raw };
  for (const key of ['nodePath', 'postgresBin', 'webRoot', 'windowsPrerequisitePath']) {
    if (raw[key]) {
      resources[key] = await realpath(resolve(root, raw[key]));
      if (!inside(root, resources[key])) fail('package-resource-outside-distribution');
    }
  }
  if (!resources.postgresBin || !resources.postgresVersion) fail('full-native-package-required');
  const entry = join(root, 'app', 'product-runtime.js');
  const result = { root, resources, entry };
  if (importApi) {
    result.api = await import(pathToFileURL(entry).href);
    for (const name of ['openProductRuntime', 'createProductRuntimeHost', 'recoveryDatabase', 'createStorageRecoveryOwner',
      'createStorageRecoveryTarget', 'restoreProductRecovery', 'upgradeProductRecovery', 'openRecoveredStorage', 'resolveCredential']) {
      if (typeof result.api[name] !== 'function') fail('package-recovery-api-missing');
    }
    for (const name of ['provisionStorage', 'openStorage', 'createFileBackend', 'createS3Backend']) {
      if (typeof result.api.storage?.[name] !== 'function') fail('package-storage-api-missing');
    }
  }
  return result;
}

// Real fixture administrator protocol: SigV4 CreateBucket, with no credentials
// in argv, logs or evidence. The fixture grants Admin on its disposable account.
async function bucketRequest(config, bucket, method) {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) fail('invalid-s3-bucket');
  const url = new URL(`/${bucket}`, config.endpoint);
  if (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol)) fail('invalid-s3-endpoint');
  const timestamp = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = timestamp.slice(0, 8), payload = hash('');
  const headers = { host: url.host, 'x-amz-content-sha256': payload, 'x-amz-date': timestamp };
  const names = Object.keys(headers).sort();
  const canonical = [method, url.pathname, '', names.map(key => `${key}:${headers[key]}\n`).join(''), names.join(';'), payload].join('\n');
  const hmac = (key, text) => createHmac('sha256', key).update(text).digest();
  const scope = `${day}/${config.region}/s3/aws4_request`;
  const key = hmac(hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, day), config.region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', key).update(`AWS4-HMAC-SHA256\n${timestamp}\n${scope}\n${hash(canonical)}`).digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
  const response = await fetch(url, { method, headers, redirect: 'error', signal: AbortSignal.timeout(10_000) });
  await response.arrayBuffer(); return response.status;
}

async function main(opt, pkg) {
  process.umask(0o077);
  // Each real product host intentionally owns SIGTERM/SIGINT listeners. The full
  // matrix keeps more than ten hosts alive to test source retirement explicitly.
  process.setMaxListeners(Math.max(process.getMaxListeners(), 32));
  if (process.version !== `v${pkg.resources.nodeVersion}`) fail('package-node-version-mismatch');
  const root = join(await realpath(dirname(opt.root)), basename(opt.root));
  const packages = [pkg];
  for (const flag of ['old-package', 'minor-package']) if (opt[flag]) {
    const resourcePackage = await packageInfo(opt[flag], false);
    // Earlier resource packages need not contain today's application bundle.
    // All API execution still comes from the selected distributed product.
    resourcePackage.api = pkg.api; resourcePackage.flag = flag; packages.push(resourcePackage);
  }
  if ([await realpath(repository), ...packages.map(item => item.root)].some(parent => inside(parent, root))) fail('root-must-be-outside-repository-and-packages');
  await mkdir(root, { mode: 0o700 }); // exclusive: never adopt an existing root
  privateWindowsRoot(root);
  await mkdir(join(root, 'private'), { mode: 0o700 });
  await mkdir(dirname(opt.out), { recursive: true });
  const output = await open(opt.out, 'wx', 0o600); await output.close();
  const evidence = { formatVersion: 1, issue: 145, kind: 'standalone-distributed-product-recovery', status: 'running',
    startedAt: new Date().toISOString(), root,
    probeSha256: await fileHash(script), ownerSha256: await fileHash(fileURLToPath(new URL('./recovery-acceptance-owner.mjs', import.meta.url))),
    host: { platform: platform(), arch: arch(), release: release(), node: process.version, bundledNode: true },
    packages: [], stages: [], skipped: [], cleanup: [],
    mode: opt['import-backup'] ? 'isolated-portability-import' : 'complete-local-matrix',
    interruptionCoverage: 'Owned restore subprocess is terminated after real database/resource restore and before isolated state commit; no machine power loss.' };
  const contexts = [];
  const key = opt['key-file'] ? await keyFromFile(opt['key-file']) : randomBytes(48);
  const keyFile = join(root, 'private', 'recovery-key.base64');
  await writeFile(keyFile, key.toString('base64') + '\n', { flag: 'wx', mode: 0o600 });
  evidence.recoveryKey = { keyFile, generatedForThisRun: !opt['key-file'],
    ...(opt['key-file'] ? { inputKeyFile: await realpath(opt['key-file']) } : {}) };
  const persist = () => writeFile(opt.out, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  async function stage(name, operation) {
    const entry = { name, status: 'running', startedAt: new Date().toISOString() };
    evidence.stages.push(entry); await persist();
    console.error(`[probe-recovery] ${name}`);
    const started = performance.now();
    try { entry.result = await operation(); entry.status = 'passed'; return entry.result; }
    catch (error) {
      entry.status = 'failed'; entry.error = errorCode(error);
      const location = /((?:probe-recovery|recovery-acceptance-owner)\.mjs):(\d+):(\d+)/.exec(String(error?.stack ?? ''));
      if (location) entry.failureSite = { file: location[1], line: Number(location[2]), column: Number(location[3]) };
      throw error;
    }
    finally { entry.durationMs = Math.round(performance.now() - started); await persist(); }
  }
  function context(packageValue, targetRoot) {
    const value = { pkg: packageValue, root: targetRoot, runtime: packageValue.api.openProductRuntime({ root: targetRoot, resources: packageValue.resources }), storages: new Set() };
    contexts.push(value); return value;
  }
  function trackStorage(value, storage) {
    if (!value.storages.has(storage)) {
      const close = storage.close.bind(storage);
      let closing;
      storage.close = () => closing ??= close();
      value.storages.add(storage);
    }
    return storage;
  }
  async function source(packageValue, sourceRoot, backendFactory) {
    const value = context(packageValue, sourceRoot);
    const serviceId = randomUUID();
    const installed = await value.runtime.install({ profile: 'local', host: '127.0.0.1', requiredServiceIds: [serviceId] });
    value.owner = { environmentId: installed.environment.environmentId, serviceId };
    value.backend = await backendFactory(value.owner, sourceRoot);
    value.host = await packageValue.api.createProductRuntimeHost({ root: sourceRoot, async createRecoveryOwners() {
      const admin = await packageValue.api.recoveryDatabase(sourceRoot);
      assert.ok(admin);
      value.binding = await packageValue.api.storage.provisionStorage({ admin, owner: value.owner,
        password: randomBytes(32).toString('base64url'), migrations });
      value.storage = await packageValue.api.storage.openStorage({ binding: value.binding, migrations, backend: value.backend });
      trackStorage(value, value.storage); value.service = acceptanceService(value.storage);
      return [packageValue.api.createStorageRecoveryOwner({ storage: value.storage, binding: value.binding, migrations,
        resources: packageValue.resources, validateService: store => validateAcceptanceService(acceptanceService(store), value.expected) })];
    } });
    assert.equal((await value.host.status()).state, 'ready');
    await writeFile(join(root, 'private', `${serviceId}.binding.json`), JSON.stringify(value.binding), { mode: 0o600, flag: 'wx' });
    return value;
  }
  async function seed(value) {
    const bytes = [Buffer.from('循阶 opaque recovery bytes\0\xff', 'utf8'), randomBytes(128 * 1024 + 19)];
    const references = [];
    for (const content of bytes) references.push(await value.service.stage(randomUUID(), content));
    const requestId = randomUUID(), intentId = randomUUID();
    value.originalRequest = { requestId, id: 'kept', value: { state: 'unknown', effectRequestId: intentId, 中文: '边界内容' }, references, intentId };
    const saved = await value.service.save(value.originalRequest);
    const second = await value.service.save({ requestId: randomUUID(), id: 'second', value: { count: 2 } });
    value.expected = { records: [
      { id: 'kept', value: { state: 'unknown', effectRequestId: intentId, 中文: '边界内容' }, seq: '1' },
      { id: 'second', value: { count: 2 }, seq: '2' },
    ], receipts: [saved, second], resources: [], sequence: { last_value: '2', is_called: true } };
    for (const [index, reference] of references.entries()) {
      const resource = await value.service.resource(reference.resourceId);
      assert.deepEqual(resource.bytes, bytes[index]); value.expected.resources.push(resource);
    }
    value.expected.pending = await value.service.pending();
    assert.deepEqual(value.expected.pending, [{ intentId, payload: { requestId, recordId: 'kept', externalRequestId: intentId, state: 'unknown' } }]);
    await validateAcceptanceService(value.service, value.expected);
    return { recordCount: 2, requestId, effectRequestId: intentId, engineVersion: await value.service.engine(),
      resources: value.expected.resources.map(item => ({ resourceId: item.reference.resourceId, sha256: hash(item.bytes),
        byteLength: item.bytes.length, opaqueSha256: hash(item.opaque), opaqueByteLength: item.opaque.length, backendId: item.reference.locator.backendId })) };
  }
  function target(packageValue, targetRoot, original, backend, targetMigrations = migrations, validation) {
    const value = context(packageValue, targetRoot);
    value.owner = original.owner;
    value.expected = restoreExpected(structuredClone(portableExpected(original.expected)));
    value.backend = backend; value.migrations = targetMigrations;
    value.target = packageValue.api.createStorageRecoveryTarget({ owner: value.owner,
      admin: async () => { const admin = await packageValue.api.recoveryDatabase(targetRoot); assert.ok(admin); return admin; },
      resources: packageValue.resources, backend, migrations: targetMigrations,
      onRestored(storage, binding) { value.storage = trackStorage(value, storage); value.binding = binding; value.service = acceptanceService(storage); },
      async validateService(storage) { await validateAcceptanceService(acceptanceService(storage), value.expected); await validation?.(storage); },
    });
    return value;
  }
  async function restore(value, backup, overrides = {}) {
    value.restored = await value.pkg.api.restoreProductRecovery({ root: value.root, backupDirectory: backup,
      resources: value.pkg.resources, key, targets: [value.target], ...overrides });
    return verifyIsolated(value);
  }
  async function verifyIsolated(value) {
    await validateAcceptanceService(value.service, value.expected);
    await assert.rejects(value.storage.pendingIntents(), error => error.code === 'maintenance');
    await assert.rejects(value.service.save({ requestId: randomUUID(), id: 'isolated-write', value: {} }), error => error.code === 'maintenance');
    assert.equal((await json(join(value.root, 'recovery-state.json'))).phase, 'isolated');
    return { isolated: true, pendingIntentsRejected: true, writesRejected: true, backupId: value.restored.manifest.backupId,
      engineVersion: await value.service.engine(), environment: (await value.runtime.status()).environment };
  }
  async function takeover(value, original) {
    const storageOwner = value.restored.owners.filter(item => item.participant.descriptor.serviceId === value.owner.serviceId);
    assert.equal(storageOwner.length, 1);
    value.host = await value.pkg.api.createProductRuntimeHost({ root: value.root, recoveryOwners: storageOwner });
    await assert.rejects(value.service.pending(), error => error.code === 'maintenance');
    await value.host.recovery.takeover({ source: original.host.recovery, receivers: [] });
    await assert.rejects(original.host.recovery.resume(), error => error.code === 'source-retired');
    await assert.rejects(original.runtime.start(), error => error.code === 'source-retired');
    const alive = await fetch(new URL('/runtime/environment', original.host.endpoint), { redirect: 'error', signal: AbortSignal.timeout(5000) });
    assert.equal(alive.status, 200);
    assert.equal((await alive.json()).installationId, original.host.environment.installationId);
    assert.deepEqual(await value.service.pending(), original.expected.pending);
    await validateAcceptanceService(value.service, value.expected);
    // Reusing the confirmed request must return the original receipt even after takeover.
    const receipt = original.expected.receipts[0];
    assert.deepEqual(await value.service.receipt(receipt.requestId), receipt);
    assert.deepEqual(await value.service.save(original.originalRequest), receipt);
    assert.deepEqual(await value.service.pending(), original.expected.pending);
    const next = await value.service.save({ requestId: randomUUID(), id: 'after-takeover', value: { active: true } });
    assert.equal(next.result.seq, '3');
    await assert.rejects(value.service.save({ requestId: randomUUID(), id: 'kept', value: {} }), error => error.code === 'conflict');
    await assert.rejects(value.service.save({ requestId: randomUUID(), id: 'duplicate-seq', value: {}, seq: '1' }), error => error.code === 'conflict');
    await assert.rejects(value.service.save({ requestId: randomUUID(), id: 'invalid-value', value: [] }));
    assert.equal(await value.service.read('invalid-value'), null);
    value.expected.records.push({ id: 'after-takeover', value: { active: true }, seq: next.result.seq });
    value.expected.receipts.push(next);
    value.expected.sequence = (await value.service.structure()).sequence;
    await validateAcceptanceService(value.service, value.expected);
    assert.deepEqual(original.expected.sequence, { last_value: '2', is_called: true });
    assert.equal(original.expected.records.length, 2);
    assert.equal(original.expected.receipts.length, 2);
    return { active: true, originalSourceStillAlive: true, sourceResumeRejected: true, sourceStartRejected: true,
      unknownEffectIdentityPreserved: true, pendingIntentIdentityPreserved: true, nextSequence: next.result.seq,
      primaryKeyAndUniqueAndCheckConstraints: true };
  }
  async function restartTarget(value, original) {
    const previousStorage = value.storage;
    const installationId = value.host.environment.installationId;
    const beforeStop = await value.service.structure();
    assert.equal(beforeStop.sequence.is_called, true);
    // Failed constraint requests can consume sequence values despite rollback.
    // Preserve the actual last value across restart, then require exactly +1.
    const expectedNext = (BigInt(beforeStop.sequence.last_value) + 1n).toString();
    const expected = value.expected;
    assert.notEqual(expected, original.expected);
    assert.deepEqual(expected.sequence, beforeStop.sequence);
    await validateAcceptanceService(value.service, expected);
    await value.host.stop();
    value.host = undefined;
    assert.equal(await exists(join(value.root, 'instance.json')), false);
    assert.equal((await value.runtime.status()).state, 'stopped');
    const credentialRef = `storage-${value.owner.serviceId}`;
    const backend = value.pkg.api.storage.createFileBackend({ id: value.backend.id, root: join(value.root, 'objects') });
    value.host = await value.pkg.api.createProductRuntimeHost({ root: value.root, async createRecoveryOwners() {
      // Load both the connection and the module instance from durable public
      // APIs. Neither the original target binding nor its pool is reused.
      const binding = JSON.parse(await value.pkg.api.resolveCredential(value.root, credentialRef));
      assert.deepEqual(binding.owner, value.owner);
      assert.notEqual(binding.connection.password, original.binding.connection.password);
      const storage = trackStorage(value, await value.pkg.api.openRecoveredStorage({ root: value.root,
        serviceId: value.owner.serviceId, migrations: value.migrations, backend }));
      assert.notEqual(storage, previousStorage);
      value.storage = storage; value.binding = binding; value.backend = backend;
      value.service = acceptanceService(storage);
      return [value.pkg.api.createStorageRecoveryOwner({ storage, binding, migrations: value.migrations,
        resources: value.pkg.resources, validateService: store => validateAcceptanceService(acceptanceService(store), expected) })];
    } });
    assert.equal(value.host.environment.installationId, installationId);
    assert.equal((await value.host.status()).state, 'ready');
    await validateAcceptanceService(value.service, expected);
    assert.deepEqual(await value.service.pending(), value.expected.pending);
    const saved = await value.service.save({ requestId: randomUUID(), id: 'after-normal-restart', value: { restarted: true } });
    assert.equal(saved.result.seq, expectedNext);
    expected.records.push({ id: 'after-normal-restart', value: { restarted: true }, seq: expectedNext });
    expected.receipts.push(saved); expected.sequence = { last_value: expectedNext, is_called: true };
    await validateAcceptanceService(value.service, expected);
    assert.deepEqual(await value.service.pending(), value.expected.pending);
    await assert.rejects(original.pkg.api.createProductRuntimeHost({ root: original.root }), error => error.code === 'source-retired');
    return { root: value.root, normalStopConfirmed: true, newHostCreated: true, newStorageModuleAndPool: true,
      persistedCredentialRef: credentialRef, credentialFile: join(value.root, 'credentials', credentialRef),
      rotatedTargetCredentialUsed: true, originalRowsReceiptsRawAndOpaqueBytesUnchanged: true,
      originalPendingIntentsUnchanged: true, sequenceBeforeStop: beforeStop.sequence.last_value,
      expectedNextSequence: expectedNext, actualNextSequence: saved.result.seq, sourceHostReopenRejected: true };
  }
  const fileBackend = (packageValue, directory, id = 'recovery-files') => packageValue.api.storage.createFileBackend({ id, root: directory });
  async function terminateRestoreChild(inputFile) {
    const child = spawn(pkg.resources.nodePath, [script, '--package', pkg.root, '--crash-restore-state', inputFile], {
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !['NODE_PATH', 'NODE_OPTIONS'].includes(key) && !/^PG/.test(key))),
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], shell: false, windowsHide: true,
    });
    let ready = false, killed = false, childError, schemaVersion;
    const result = await new Promise((yes, no) => {
      const timeout = setTimeout(() => { childError = 'crash-child-timeout'; killed = child.kill('SIGKILL'); }, 120_000);
      child.on('message', message => {
        if (message?.error) childError = message.error;
        if (message?.phase === 'restored-before-isolated-commit' && !killed) {
          ready = true; schemaVersion = message.schemaVersion; killed = child.kill('SIGKILL');
        }
      });
      child.once('error', error => { clearTimeout(timeout); no(error); });
      child.once('exit', (code, signal) => { clearTimeout(timeout); yes({ code, signal }); });
    });
    if (childError) fail(childError);
    assert.ok(ready && killed, 'owned child must reach real restore before termination');
    assert.ok(result.signal === 'SIGKILL' || result.code !== 0);
    return { childReachedRealRestore: true, terminatedByParent: true, exitSignal: result.signal, exitCode: result.code,
      ...(schemaVersion ? { schemaVersion } : {}) };
  }
  async function upgrade(kind, originalPackage, targetPackage, label, targetMigrations = migrations) {
    const sourceRoot = join(root, `${label}-source`);
    const original = await source(originalPackage, sourceRoot, () => fileBackend(originalPackage, join(sourceRoot, 'objects')));
    const seeded = await seed(original);
    const targetRoot = join(root, `${label}-target`), backups = join(root, `${label}-backups`);
    const upgraded = target(targetPackage, targetRoot, original, fileBackend(targetPackage, join(targetRoot, 'objects')), targetMigrations);
    upgraded.restored = await targetPackage.api.upgradeProductRecovery({ kind, sourceRoot, root: targetRoot,
      backupDirectory: backups, key, resources: targetPackage.resources, targets: [upgraded.target],
      backup: () => original.host.recovery.backup({ directory: backups, key, leaveClosed: true }) });
    const isolated = await verifyIsolated(upgraded);
    if (kind === 'schema') assert.deepEqual(await upgraded.service.schemaUpgrade(), [{ upgrade_note: 'schema-v2' }]);
    else {
      assert.equal(seeded.engineVersion, originalPackage.resources.postgresVersion);
      assert.equal(isolated.engineVersion, targetPackage.resources.postgresVersion);
      assert.notEqual(await realpath(originalPackage.resources.postgresBin), await realpath(targetPackage.resources.postgresBin));
    }
    const activated = await takeover(upgraded, original);
    return { sourceVersion: seeded.engineVersion, targetVersion: isolated.engineVersion, backupId: isolated.backupId,
      boundaryAt: upgraded.restored.manifest.boundaryAt, backupDurationMs: upgraded.restored.manifest.durationMs,
      isolatedVerified: true, schemaVersion: kind === 'schema' ? 2 : 1, ...activated };
  }
  try {
    for (const value of packages) evidence.packages.push({ path: value.root, ...(await exists(value.entry) ? { entrySha256: await fileHash(value.entry) } : {}),
      resourcesSha256: await fileHash(join(value.root, 'resources.json')), nodeSha256: await fileHash(value.resources.nodePath),
      nodeVersion: value.resources.nodeVersion, postgresVersion: value.resources.postgresVersion,
      postgresSha256: await fileHash(join(value.resources.postgresBin, process.platform === 'win32' ? 'postgres.exe' : 'postgres')) });
    if (opt['import-backup']) {
      evidence.importInputs = { backupDirectory: await realpath(opt['import-backup']),
        expectFile: await realpath(opt['expect-file']), inputKeyFile: await realpath(opt['key-file']), stagedKeyFile: keyFile };
      const portable = await privateJson(opt['expect-file']);
      assert.equal(portable.formatVersion, 1);
      assert.equal(portable.kind, 'recovery-acceptance-portability');
      assert.equal(await fileHash(join(opt['import-backup'], 'manifest.json')), portable.manifestSha256);
      const original = { owner: portable.owner, expected: restoreExpected(portable.expected), originalRequest: portable.originalRequest };
      const importedRoot = join(root, 'import-target');
      const imported = target(pkg, importedRoot, original, fileBackend(pkg, join(importedRoot, 'objects'), portable.backendId), portable.migrations);
      await stage('cross-platform-import-isolated-service-api-verification', async () => {
        const result = await restore(imported, opt['import-backup']);
        assert.equal(result.backupId, portable.backupId);
        return { ...result, sourcePlatform: portable.sourcePlatform, sourceEngineVersion: portable.sourceEngineVersion,
          targetPlatform: process.platform, sourceContacted: false, takeoverAttempted: false,
          expectedFileSha256: await fileHash(opt['expect-file']), receiptCount: portable.expected.receipts.length,
          rawAndOpaqueResourcesVerified: portable.expected.resources.length };
      });
    } else {
    const sourceRoot = join(root, 'file-source');
    const a = await source(pkg, sourceRoot, () => fileBackend(pkg, join(sourceRoot, 'objects')));
    await stage('file-source-service-api-seed', () => seed(a));
    const bRoot = join(root, 'unrelated-B');
    const b = await source(pkg, bRoot, () => fileBackend(pkg, join(bRoot, 'objects')));
    await stage('unrelated-B-service-api-seed', () => seed(b));
    const backups = join(root, 'file-backups');
    let manifest;
    await stage('file-held-backup', async () => {
      manifest = await a.host.recovery.backup({ directory: backups, key, leaveClosed: true });
      return { backupId: manifest.backupId, boundaryAt: manifest.boundaryAt, completedAt: manifest.completedAt,
        durationMs: manifest.durationMs, artifacts: manifest.artifacts, services: manifest.services };
    });
    const backup = join(backups, manifest.backupId);
    const portability = { formatVersion: 1, kind: 'recovery-acceptance-portability', owner: a.owner,
      backendId: a.backend.id, backupId: manifest.backupId, migrations, expected: portableExpected(a.expected),
      originalRequest: a.originalRequest, sourceRoot: a.root, sourcePlatform: process.platform, sourceEngineVersion: await a.service.engine(),
      manifestSha256: await fileHash(join(backup, 'manifest.json')) };
    const expectFile = join(root, 'portability.private.json');
    await stage('portability-export-private-inputs', async () => {
      await writeFile(expectFile, JSON.stringify(portability, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      evidence.portability = { sourceRoot: a.root, expectFile, keyFile, backupDirectory: backup,
        manifestFile: join(backup, 'manifest.json'), backupId: manifest.backupId,
        privateExpectedEncoding: 'explicit-base64-for-raw-and-opaque-bytes' };
      return { ...evidence.portability, generatedKeyFile: keyFile };
    });
    const targetRoot = join(root, 'file-restored');
    const restored = target(pkg, targetRoot, a, fileBackend(pkg, join(targetRoot, 'objects')));
    await stage('file-restore-isolated-service-api-verification', () => restore(restored, backup));
    await stage('file-target-takeover-source-alive-and-constraints', () => takeover(restored, a));
    await stage('file-target-normal-stop-fresh-host-reopens-rotated-storage-and-writes', () => restartTarget(restored, a));
    await stage('unrelated-B-not-modified-by-A-restore', async () => {
      await validateAcceptanceService(b.service, b.expected);
      assert.equal((await b.host.status()).state, 'ready');
      return { independentInstallationId: b.host.environment.installationId, stillReady: true, dataAndReceiptsAndBytesUnchanged: true };
    });
    async function rejectRestore(name, directory, overrides = {}, occupied) {
      const failedRoot = occupied?.root ?? join(root, `failed-${name}`);
      const failed = occupied ?? target(pkg, failedRoot, a, fileBackend(pkg, join(failedRoot, 'objects')));
      let rejected;
      try { await pkg.api.restoreProductRecovery({ root: failedRoot, backupDirectory: directory, resources: pkg.resources,
        key, targets: [failed.target], ...overrides }); } catch (error) { rejected = error; }
      assert.ok(rejected, 'failed restore must reject');
      if (!occupied) {
        assert.equal(await exists(join(failedRoot, 'instance.json')), false);
        assert.equal(await exists(join(failedRoot, 'launch.json')), false);
        if (await exists(join(failedRoot, 'recovery-state.json'))) assert.notEqual((await json(join(failedRoot, 'recovery-state.json'))).phase, 'active');
      }
      return { rejected: true, error: errorCode(rejected), targetNeverEnabled: !occupied };
    }
    for (const kind of ['missing-cipher', 'corrupt-cipher']) {
      await stage(kind, async () => {
        const damaged = join(root, `${kind}-backup`); await cp(backup, damaged, { recursive: true, errorOnExist: true, force: false });
        const cipher = join(damaged, 'artifacts', manifest.artifacts[0].path);
        if (kind === 'missing-cipher') await rm(cipher);
        else { const file = await open(cipher, 'r+'); try { const byte = Buffer.alloc(1); await file.read(byte, 0, 1, 0); byte[0] ^= 1; await file.write(byte, 0, 1, 0); } finally { await file.close(); } }
        return rejectRestore(kind, damaged);
      });
    }
    await stage('wrong-recovery-key', async () => {
      const wrongKey = randomBytes(48), wrongKeyFile = join(root, 'private', 'wrong-recovery-key.base64');
      await writeFile(wrongKeyFile, wrongKey.toString('base64') + '\n', { flag: 'wx', mode: 0o600 });
      return { ...await rejectRestore('wrong-key', backup, { key: wrongKey }), keyFile: wrongKeyFile };
    });
    await stage('insufficient-space-preflight', async () => {
      const result = await rejectRestore('space', backup, { minimumFreeBytes: Number.MAX_SAFE_INTEGER });
      assert.equal(result.error, 'insufficient-space'); return result;
    });
    await stage('occupied-target-preserves-live-B', async () => {
      const result = await rejectRestore('occupied', backup, {}, b);
      await validateAcceptanceService(b.service, b.expected); assert.equal((await b.host.status()).state, 'ready');
      return { ...result, independentBUnmodified: true };
    });
    await stage('validation-interruption-and-same-backup-new-target-rebuild', async () => {
      const interruptedRoot = join(root, 'interrupted-target');
      const interrupted = target(pkg, interruptedRoot, a, fileBackend(pkg, join(interruptedRoot, 'objects')),
        migrations, () => fail('acceptance-validation-interruption'));
      await assert.rejects(pkg.api.restoreProductRecovery({ root: interruptedRoot, backupDirectory: backup, resources: pkg.resources, key, targets: [interrupted.target] }));
      assert.ok(interrupted.storage, 'interruption must happen after real bytes/database restore');
      assert.equal((await json(join(interruptedRoot, 'recovery-state.json'))).phase, 'failed');
      await assert.rejects(interrupted.service.pending(), error => error.code === 'maintenance');
      await assert.rejects(interrupted.service.save({ requestId: randomUUID(), id: 'failed-write', value: {} }), error => error.code === 'maintenance');
      assert.equal(await exists(join(interruptedRoot, 'instance.json')), false);
      const rebuiltRoot = join(root, 'rebuilt-after-interruption');
      const rebuilt = target(pkg, rebuiltRoot, a, fileBackend(pkg, join(rebuiltRoot, 'objects')));
      await restore(rebuilt, backup);
      for (const artifact of manifest.artifacts) assert.equal(await fileHash(join(backup, 'artifacts', artifact.path)), artifact.sha256);
      return { interruption: 'validation-after-real-restore', failedTargetNeverEnabled: true, rebuiltInNewRoot: true,
        originalBackupId: manifest.backupId, originalCipherUnchanged: true, rebuildIsolated: true };
    });
    await stage('process-termination-mid-restore-and-same-backup-rebuild', async () => {
      const crashedRoot = join(root, 'process-crashed-target');
      const crashed = context(pkg, crashedRoot);
      const stateFile = join(root, 'private', 'crash-restore-input.json');
      await writeFile(stateFile, JSON.stringify({ root: crashedRoot, backupDirectory: backup,
        keyFile: join(root, 'private', 'recovery-key.base64'), expectFile }), { mode: 0o600, flag: 'wx' });
      const termination = await terminateRestoreChild(stateFile);
      const state = await json(join(crashedRoot, 'recovery-state.json'));
      assert.notEqual(state.phase, 'active'); assert.notEqual(state.phase, 'isolated');
      assert.equal(await exists(join(crashedRoot, 'instance.json')), false);
      await crashed.runtime.stop(); // the child's managed PG can survive its app process
      const rebuiltRoot = join(root, 'rebuilt-after-process-termination');
      const rebuilt = target(pkg, rebuiltRoot, a, fileBackend(pkg, join(rebuiltRoot, 'objects')));
      await restore(rebuilt, backup);
      for (const artifact of manifest.artifacts) assert.equal(await fileHash(join(backup, 'artifacts', artifact.path)), artifact.sha256);
      return { ...termination, interruptedPhase: state.phase, failedTargetNeverEnabled: true,
        originalBackupId: manifest.backupId, sameBackupRebuiltInNewRoot: true, rebuildIsolated: true,
        orphanedManagedDatabaseStopped: true, originalCipherUnchanged: true };
    });
    await stage('schema-upgrade-v1-to-v2-held-backup', () => upgrade('schema', pkg, pkg, 'schema', upgradedMigrations));
    await stage('process-termination-mid-schema-upgrade-and-actual-data-recovery', async () => {
      const sourceRoot = join(root, 'schema-crash-source');
      const original = await source(pkg, sourceRoot, () => fileBackend(pkg, join(sourceRoot, 'objects')));
      await seed(original);
      const backups = join(root, 'schema-crash-backups');
      const saved = await original.host.recovery.backup({ directory: backups, key, leaveClosed: true });
      const selectedBackup = join(backups, saved.backupId);
      const expectation = join(root, 'private', 'schema-crash-expected.json');
      await writeFile(expectation, JSON.stringify({ owner: original.owner, backendId: original.backend.id,
        migrations: upgradedMigrations, expected: portableExpected(original.expected) }), { mode: 0o600, flag: 'wx' });
      const crashedRoot = join(root, 'schema-process-crashed-target');
      const crashed = context(pkg, crashedRoot);
      const input = join(root, 'private', 'schema-crash-input.json');
      await writeFile(input, JSON.stringify({ root: crashedRoot, backupDirectory: selectedBackup, keyFile,
        expectFile: expectation, kind: 'schema', sourceRoot, manifest: saved }), { mode: 0o600, flag: 'wx' });
      const termination = await terminateRestoreChild(input);
      assert.equal(termination.schemaVersion, 2);
      const journals = await Promise.all((await readdir(sourceRoot)).filter(name => /^upgrade-[a-f0-9-]+\.json$/.test(name)).map(name => json(join(sourceRoot, name))));
      assert.ok(journals.some(item => item.kind === 'schema' && item.phase === 'restoring'));
      const state = await json(join(crashedRoot, 'recovery-state.json'));
      assert.notEqual(state.phase, 'active'); assert.notEqual(state.phase, 'isolated');
      await crashed.runtime.stop();
      const rebuiltRoot = join(root, 'schema-rebuilt-after-process-exit');
      const rebuilt = target(pkg, rebuiltRoot, original, fileBackend(pkg, join(rebuiltRoot, 'objects')), upgradedMigrations);
      rebuilt.restored = await pkg.api.upgradeProductRecovery({ kind: 'schema', sourceRoot, root: rebuiltRoot,
        backupDirectory: backups, key, resources: pkg.resources, targets: [rebuilt.target], backup: async () => saved });
      await verifyIsolated(rebuilt);
      assert.deepEqual(await rebuilt.service.schemaUpgrade(), [{ upgrade_note: 'schema-v2' }]);
      const active = await takeover(rebuilt, original);
      for (const artifact of saved.artifacts) assert.equal(await fileHash(join(selectedBackup, 'artifacts', artifact.path)), artifact.sha256);
      return { ...termination, kind: 'schema', sourceSchemaVersion: 1, targetSchemaVersion: 2,
        interruptedPhase: state.phase, sourceUpgradeJournalPreserved: true, originalBackupId: saved.backupId,
        actualDataRestoredInFreshTarget: true, sameBackupUsed: true, originalCipherUnchanged: true, ...active };
    });
    if (opt['s3-config']) {
      await stage('s3-independent-bucket-round-trip-and-takeover', async () => {
        const configStat = await lstat(opt['s3-config']);
        if (!configStat.isFile() || (process.platform !== 'win32' && (configStat.mode & 0o077))) fail('s3-config-must-be-private-file');
        const config = await json(opt['s3-config']);
        const fixture = await json(join(dirname(opt['s3-config']), 'evidence.json'));
        if ((fixture.version ?? fixture.releaseTag) !== '4.50') fail('pinned-seaweed-fixture-required');
        const targetBucket = config.targetBucket ?? `recovery-${randomBytes(12).toString('hex')}`;
        if (targetBucket === config.bucket) fail('independent-target-bucket-required');
        let status = await bucketRequest(config, targetBucket, 'HEAD');
        if (!config.targetBucket && status !== 404) fail('new-target-bucket-conflict');
        let created = false;
        if (status === 404) {
          status = await bucketRequest(config, targetBucket, 'PUT');
          if (![200, 201, 204].includes(status)) fail('s3-create-target-bucket-failed-provide-targetBucket');
          created = true;
        } else if (status !== 200) fail('s3-target-bucket-unavailable');
        for (let attempt = 0; attempt < 20; attempt++) {
          if (await bucketRequest(config, targetBucket, 'HEAD') === 200) break;
          if (attempt === 19) fail('s3-target-bucket-not-ready');
          await delay(250);
        }
        const backendId = config.id ?? 'recovery-s3';
        const backend = bucket => pkg.api.storage.createS3Backend({ id: backendId, endpoint: config.endpoint, region: config.region,
          bucket, accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey });
        const s3Root = join(root, 's3-source');
        const original = await source(pkg, s3Root, () => backend(config.bucket));
        const seeded = await seed(original);
        const backups = join(root, 's3-backups');
        const saved = await original.host.recovery.backup({ directory: backups, key, leaveClosed: true });
        const recovered = target(pkg, join(root, 's3-target'), original, backend(targetBucket));
        const isolated = await restore(recovered, join(backups, saved.backupId));
        const active = await takeover(recovered, original);
        return { fixtureVersion: '4.50', fixtureBinarySha256: fixture.binarySha256, backendId,
          sourceBucket: config.bucket, targetBucket, targetBucketCreatedByHost: created, independentBuckets: true,
          backupId: saved.backupId, boundaryAt: saved.boundaryAt, backupDurationMs: saved.durationMs,
          resources: seeded.resources, isolatedVerified: isolated.isolated, ...active };
      });
    } else evidence.skipped.push({ name: 's3', reason: 's3-config-not-supplied' });
    const oldPackage = packages.find(item => item.flag === 'old-package');
    const minorPackage = packages.find(item => item.flag === 'minor-package');
    if (minorPackage) await stage('external-major-upgrade-refuses-unchanged-server-engine', async () => {
      const sourceRoot = join(root, 'wrong-engine-source');
      const original = await source(minorPackage, sourceRoot, () => fileBackend(minorPackage, join(sourceRoot, 'objects')));
      await seed(original);
      const provider = context(minorPackage, join(root, 'unchanged-external-provider'));
      await provider.runtime.install({ profile: 'local' });
      assert.equal((await provider.runtime.start()).state, 'ready');
      const externalAdmin = await pkg.api.recoveryDatabase(provider.root);
      const backups = join(root, 'wrong-engine-backups');
      const saved = await original.host.recovery.backup({ directory: backups, key, leaveClosed: true });
      const targetRoot = join(root, 'wrong-engine-target');
      const failed = target(pkg, targetRoot, original, fileBackend(pkg, join(targetRoot, 'objects')));
      const { password, ...binding } = externalAdmin;
      await assert.rejects(pkg.api.upgradeProductRecovery({ kind: 'pg-major', sourceRoot, root: targetRoot,
        backupDirectory: backups, key, resources: pkg.resources, targets: [failed.target],
        database: { mode: 'external', ...binding, credentialRef: 'external-admin' }, databaseCredential: password,
        backup: async () => saved }), error => error.code === 'target-engine-version-mismatch');
      assert.equal((await json(join(targetRoot, 'recovery-state.json'))).phase, 'failed');
      assert.equal((await provider.runtime.status()).state, 'ready');
      await original.host.recovery.resume();
      await validateAcceptanceService(original.service, original.expected);
      for (const artifact of saved.artifacts) assert.equal(await fileHash(join(backups, saved.backupId, 'artifacts', artifact.path)), artifact.sha256);
      return { sourceEngineVersion: minorPackage.resources.postgresVersion, requestedTargetVersion: pkg.resources.postgresVersion,
        unchangedActualTargetVersion: minorPackage.resources.postgresVersion, rejected: true, targetNeverEnabled: true,
        sourceResumedAndVerified: true, externalProviderStillReady: true, originalBackupUnchanged: true };
    });
    if (oldPackage && minorPackage) {
      if (oldPackage.resources.postgresVersion !== '17.10' || minorPackage.resources.postgresVersion !== '17.11') fail('expected-17-10-and-17-11-packages');
      await stage('pg-minor-17.10-to-17.11-product-upgrade', () => upgrade('pg-minor', oldPackage, minorPackage, 'pg-minor'));
    } else evidence.skipped.push({ name: 'postgres-minor', reason: 'old-and-minor-packages-required' });
    if (minorPackage) {
      if (minorPackage.resources.postgresVersion !== '17.11' || pkg.resources.postgresVersion !== '18.6') fail('expected-17-11-and-18-6-packages');
      await stage('pg-major-17.11-to-18.6-product-upgrade', () => upgrade('pg-major', minorPackage, pkg, 'pg-major'));
    } else evidence.skipped.push({ name: 'postgres-major', reason: 'minor-package-required' });
    }
    evidence.status = 'passed';
  } catch (error) { evidence.status = 'failed'; evidence.error = errorCode(error); }
  finally {
    for (const value of [...contexts].reverse()) {
      const entry = { root: value.root, hostsStopped: false, poolsClosed: false, databaseStopped: false };
      evidence.cleanup.push(entry);
      try { if (value.host) await value.host.stop(); entry.hostsStopped = true; }
      catch (error) { entry.hostError = errorCode(error); evidence.status = 'failed'; }
      try { for (const storage of value.storages) await storage.close(); entry.poolsClosed = true; }
      catch (error) { entry.poolError = errorCode(error); evidence.status = 'failed'; }
      try { if (await exists(join(value.root, 'installation.json'))) await value.runtime.stop(); entry.databaseStopped = true; }
      catch (error) { entry.stopError = errorCode(error); evidence.status = 'failed'; }
    }
    evidence.finishedAt = new Date().toISOString(); evidence.durationMs = Date.parse(evidence.finishedAt) - Date.parse(evidence.startedAt);
    evidence.retained = true; await persist();
  }
  console.log(`Recovery acceptance ${evidence.status}; evidence: ${opt.out}`);
  if (evidence.status !== 'passed') process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  if (process.argv.includes('--help')) console.log(usage);
  else {
    try {
      const opt = options(process.argv.slice(2));
      const base = await packageInfo(opt.package, false);
      if (await realpath(process.execPath) !== await realpath(base.resources.nodePath)) {
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['NODE_PATH', 'NODE_OPTIONS'].includes(key) && !/^PG/.test(key)));
        const child = spawn(base.resources.nodePath, [script, ...process.argv.slice(2)], { env, stdio: 'inherit', shell: false, windowsHide: true });
        const code = await new Promise((yes, no) => { child.once('error', no); child.once('exit', (code, signal) => yes(signal ? 1 : code ?? 1)); });
        process.exitCode = code;
      } else if (opt['crash-restore-state']) await crashRestoreChild(opt, await packageInfo(opt.package));
      else await main(opt, await packageInfo(opt.package));
    } catch (error) { console.error(`Recovery acceptance failed: ${errorCode(error)}`); process.exitCode = 1; }
  }
}
