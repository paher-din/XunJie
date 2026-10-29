#!/usr/bin/env node
// Standalone acceptance: only Node builtins, the owner helper and the actual
// distribution API. No workspace package, driver, native PG launcher or fixture.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises';
import { arch, platform, release } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { acceptanceService, migrations, validateAcceptanceService } from './recovery-acceptance-owner.mjs';

const script = fileURLToPath(import.meta.url);
const helper = fileURLToPath(new URL('./recovery-acceptance-owner.mjs', import.meta.url));
const repository = resolve(dirname(script), '..');
const usage = `Usage: <Node> probe-recovery-external.mjs --package DIR --root NEW --out JSON
Re-executes with the distribution's bundled Node. Uses two new managed database
providers and external school source/target installations, all under NEW.
NEW must not exist and must be outside the repository and distribution.
All owned hosts/pools/providers stop in finally. Private data and the recovery
key remain under NEW for explicit cleanup. Existing services/data are not used.
Requires the new restoreProductRecovery databaseCredential/installation API.
`;
const exists = async path => { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const inside = (parent, child) => { const part = relative(parent, child); return !part || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`)); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const safeCode = error => typeof error?.code === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(error.code) ? error.code : 'external-probe-failed';
const fail = code => { throw Object.assign(new Error(code), { code }); };
async function fileHash(path) { const digest = createHash('sha256'); for await (const bytes of createReadStream(path)) digest.update(bytes); return digest.digest('hex'); }

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
async function packageInfo(directory) {
  const root = await realpath(directory), resources = await json(join(root, 'resources.json'));
  for (const name of ['nodePath', 'postgresBin', 'webRoot', 'windowsPrerequisitePath']) if (resources[name]) {
    resources[name] = await realpath(resolve(root, resources[name]));
    if (!inside(root, resources[name])) fail('package-resource-outside-distribution');
  }
  if (!resources.postgresBin || !resources.postgresVersion || !resources.nodePath || !resources.webRoot) fail('full-native-package-required');
  return { root, resources, entry: join(root, 'app/product-runtime.js') };
}
function privateWindowsRoot(root) {
  if (process.platform !== 'win32') return;
  const literal = "'" + root.replaceAll("'", "''") + "'";
  const code = `$ErrorActionPreference='Stop';$path=${literal}
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
if((Get-Acl -LiteralPath $path).GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'Owner mismatch'}
$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false)
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
Set-Acl -LiteralPath $path -AclObject $acl`;
  const result = spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')],
    { shell: false, windowsHide: true, encoding: 'utf8', timeout: 15_000 });
  if (result.error || result.status !== 0) fail('private-root-acl-failed');
}

async function main(opt, pkg) {
  process.umask(0o077);
  for (const name of Object.keys(process.env)) if (/^PG/.test(name) || ['NODE_PATH', 'NODE_OPTIONS'].includes(name)) delete process.env[name];
  const api = await import(pathToFileURL(pkg.entry).href);
  for (const name of ['openProductRuntime', 'createProductRuntimeHost', 'recoveryDatabase', 'createStorageRecoveryOwner',
    'createStorageRecoveryTarget', 'restoreProductRecovery', 'resolveCredential', 'openRecoveredStorage']) {
    if (typeof api[name] !== 'function') fail('package-recovery-api-missing');
  }
  for (const name of ['provisionStorage', 'openStorage', 'createFileBackend']) if (typeof api.storage?.[name] !== 'function') fail('package-storage-api-missing');
  assert.equal(process.version, `v${pkg.resources.nodeVersion}`);
  const root = join(await realpath(dirname(opt.root)), basename(opt.root));
  if ([await realpath(repository), pkg.root].some(parent => inside(parent, root))) fail('root-must-be-outside-repository-and-package');
  if (inside(pkg.root, opt.out)) fail('evidence-must-be-outside-package');
  await mkdir(root, { mode: 0o700 }); // exclusive; never adopt or remove an existing root
  privateWindowsRoot(root);
  await mkdir(join(root, 'private'), { mode: 0o700 });
  await mkdir(dirname(opt.out), { recursive: true });
  const handle = await open(opt.out, 'wx', 0o600); await handle.close();
  const evidence = { formatVersion: 1, issue: 145, kind: 'school-external-database-distribution-recovery',
    status: 'running', startedAt: new Date().toISOString(), root,
    host: { platform: platform(), arch: arch(), release: release(), node: process.version, bundledNode: true },
    package: { root: pkg.root, postgresVersion: pkg.resources.postgresVersion, apiSha256: await fileHash(pkg.entry) },
    probeSha256: await fileHash(script), ownerSha256: await fileHash(helper), stages: [], cleanup: [],
    scope: 'Owned loopback providers A/B; file resources; no pre-existing database, remote receiver or public TLS endpoint.' };
  const persist = () => writeFile(opt.out, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  const actors = [], pools = new Set();
  const key = randomBytes(48);
  await writeFile(join(root, 'private/recovery-key.base64'), key.toString('base64') + '\n', { flag: 'wx', mode: 0o600 });
  async function stage(name, operation) {
    const result = { name, status: 'running', startedAt: new Date().toISOString() };
    evidence.stages.push(result); await persist();
    console.error(`[probe-recovery-external] ${name}`);
    const start = performance.now();
    try { result.result = await operation(); result.status = 'passed'; return result.result; }
    catch (error) { result.status = 'failed'; result.error = safeCode(error); throw error; }
    finally { result.durationMs = Math.round(performance.now() - start); await persist(); }
  }
  function actor(name) {
    const value = { root: join(root, name), name };
    value.runtime = api.openProductRuntime({ root: value.root, resources: pkg.resources });
    actors.push(value); return value;
  }
  function track(storage) {
    const close = storage.close.bind(storage); let closing;
    storage.close = () => closing ??= close();
    pools.add(storage); return storage;
  }
  const backend = (value, id) => api.storage.createFileBackend({ id, root: join(value.root, 'objects') });
  const ownerModule = (value, expected = value.expected) => api.createStorageRecoveryOwner({ storage: value.storage,
    binding: value.binding, migrations, resources: pkg.resources,
    validateService: store => validateAcceptanceService(acceptanceService(store), expected ?? value.expected) });
  const publicConnection = connection => ({ host: connection.host, port: connection.port, database: connection.database, user: connection.user });
  const external = (admin, credentialRef) => ({ mode: 'external', ...publicConnection(admin), credentialRef,
    ...(admin.ssl ? { ssl: admin.ssl } : {}) });
  async function verifyHost(value, state = 'ready') {
    assert.equal((await value.host.status()).state, state);
    const response = await fetch(new URL('/runtime/environment', value.host.endpoint), { redirect: 'error', signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    const environment = await response.json();
    assert.equal(environment.environmentId, value.host.environment.environmentId);
    assert.equal(environment.installationId, value.host.environment.installationId);
    assert.equal(environment.profile, 'school');
  }
  async function ready(provider) {
    assert.equal((await provider.runtime.status()).state, 'ready');
    const admin = await api.recoveryDatabase(provider.root); assert.ok(admin);
    assert.deepEqual(publicConnection(admin), publicConnection(provider.admin));
    const identity = await json(join(provider.root, 'database.json'));
    assert.equal(identity.systemIdentifier, provider.systemIdentifier);
  }
  async function installProvider(value) {
    await value.runtime.install({ profile: 'local', host: '127.0.0.1' });
    assert.equal((await value.runtime.start()).state, 'ready');
    value.admin = await api.recoveryDatabase(value.root); assert.ok(value.admin);
    value.systemIdentifier = (await json(join(value.root, 'database.json'))).systemIdentifier;
    assert.ok(value.systemIdentifier); await ready(value);
  }
  async function seed(value, label) {
    const bytes = [Buffer.from(`循阶 external ${label}\0`, 'utf8'), randomBytes(128 * 1024 + 19)];
    const references = [];
    for (const content of bytes) references.push(await value.service.stage(randomUUID(), content));
    const requestId = randomUUID(), intentId = randomUUID();
    value.request = { requestId, id: 'kept', value: { label, effectState: 'unknown', 中文: '外部数据库' }, references, intentId };
    const first = await value.service.save(value.request);
    const second = await value.service.save({ requestId: randomUUID(), id: 'second', value: { label, count: 2 } });
    value.expected = { records: [
      { id: 'kept', value: value.request.value, seq: '1' }, { id: 'second', value: { label, count: 2 }, seq: '2' },
    ], receipts: [first, second], resources: [], sequence: { last_value: '2', is_called: true } };
    for (const [index, reference] of references.entries()) {
      const item = await value.service.resource(reference.resourceId); assert.deepEqual(item.bytes, bytes[index]);
      value.expected.resources.push(item);
    }
    value.expected.pending = await value.service.pending();
    assert.deepEqual(value.expected.pending, [{ intentId, payload: { requestId, recordId: 'kept', externalRequestId: intentId, state: 'unknown' } }]);
    await validateAcceptanceService(value.service, value.expected);
    return { owner: value.binding.owner, records: 2, receipts: 2,
      resources: value.expected.resources.map(item => ({ sha256: hash(item.bytes), opaqueSha256: hash(item.opaque), byteLength: item.bytes.length })) };
  }
  async function provision(value, admin, owner) {
    value.binding = await api.storage.provisionStorage({ admin, owner, password: randomBytes(32).toString('base64url'), migrations });
    value.storage = track(await api.storage.openStorage({ binding: value.binding, migrations, backend: value.backend }));
    value.service = acceptanceService(value.storage);
  }
  const providerA = actor('provider-A'), providerB = actor('provider-B');
  const source = actor('school-source'), target = actor('school-target');
  const independent = { root: join(root, 'independent-B') };
  let backup, manifest, backupHashes, sourceIdentity, targetIdentity;
  async function protect() {
    if (backupHashes) {
      assert.equal(await fileHash(join(backup, 'manifest.json')), backupHashes.manifest);
      for (const item of manifest.artifacts) assert.equal(await fileHash(join(backup, 'artifacts', item.path)), item.sha256);
    }
    if (independent.expected) {
      await validateAcceptanceService(independent.service, independent.expected);
      assert.deepEqual(await independent.service.pending(), independent.expected.pending);
    }
  }
  try {
    await stage('independent-managed-providers', async () => {
      await installProvider(providerA); await installProvider(providerB);
      assert.notEqual(providerA.admin.port, providerB.admin.port);
      assert.notEqual(providerA.systemIdentifier, providerB.systemIdentifier);
      independent.backend = backend(independent, 'independent-b-files');
      const descriptor = (await providerB.runtime.status()).environment;
      await provision(independent, providerB.admin, { environmentId: descriptor.environmentId, serviceId: randomUUID() });
      const sentinel = await seed(independent, 'independent-B');
      return { A: publicConnection(providerA.admin), B: publicConnection(providerB.admin), separateClusters: true, sentinel };
    });
    await stage('external-school-source-real-owner-and-seed', async () => {
      await source.runtime.setCredential('external-admin-A', providerA.admin.password);
      const serviceId = randomUUID();
      const installed = await source.runtime.install({ profile: 'school', host: '127.0.0.1',
        database: external(providerA.admin, 'external-admin-A'), requiredServiceIds: [serviceId] });
      source.owner = { environmentId: installed.environment.environmentId, serviceId };
      source.backend = backend(source, 'external-school-files');
      source.host = await api.createProductRuntimeHost({ root: source.root, async createRecoveryOwners() {
        const admin = await api.recoveryDatabase(source.root); assert.ok(admin);
        assert.deepEqual(publicConnection(admin), publicConnection(providerA.admin));
        await provision(source, admin, source.owner); return [ownerModule(source)];
      } });
      await verifyHost(source);
      assert.equal(await source.service.engine(), pkg.resources.postgresVersion);
      assert.equal(await exists(join(source.root, 'pgdata')), false);
      sourceIdentity = await json(join(source.root, 'external-database.json'));
      return seed(source, 'source-A');
    });
    await stage('held-backup-and-failed-restore-protection', async () => {
      manifest = await source.host.recovery.backup({ directory: join(root, 'backups'), key, leaveClosed: true });
      backup = join(root, 'backups', manifest.backupId);
      backupHashes = { manifest: await fileHash(join(backup, 'manifest.json')) };
      assert.deepEqual(manifest.receiverIds, []);
      await assert.rejects(source.service.save({ requestId: randomUUID(), id: 'held-write', value: {} }), error => error.code === 'maintenance');
      await assert.rejects(api.restoreProductRecovery({ root: join(root, 'wrong-key-target'), backupDirectory: backup,
        resources: pkg.resources, key: randomBytes(48), database: external(providerB.admin, 'external-admin-B'),
        databaseCredential: providerB.admin.password, installation: { profile: 'school', host: '127.0.0.1' } }));
      assert.equal(await exists(join(root, 'wrong-key-target')), false);
      await validateAcceptanceService(source.service, source.expected); await protect();
      await ready(providerA); await ready(providerB);
      return { backupId: manifest.backupId, backupDirectory: backup, held: true, failedRestoreRejected: true,
        backupCipherUnchanged: true, sourceAndIndependentBUnchanged: true };
    });
    await stage('external-B-restore-isolated', async () => {
      target.owner = source.owner; target.expected = structuredClone(source.expected);
      // Keep Buffers: structuredClone converts them to Uint8Arrays.
      target.expected.resources = source.expected.resources;
      target.backend = backend(target, source.backend.id);
      const storageTarget = api.createStorageRecoveryTarget({ owner: target.owner, resources: pkg.resources,
        backend: target.backend, migrations, admin: async () => {
          const admin = await api.recoveryDatabase(target.root); assert.ok(admin);
          assert.deepEqual(publicConnection(admin), publicConnection(providerB.admin)); return admin;
        }, onRestored(storage, binding) { target.storage = track(storage); target.binding = binding; target.service = acceptanceService(storage); },
        validateService: storage => validateAcceptanceService(acceptanceService(storage), target.expected) });
      target.restored = await api.restoreProductRecovery({ root: target.root, backupDirectory: backup, resources: pkg.resources,
        key, targets: [storageTarget], database: external(providerB.admin, 'external-admin-B'), databaseCredential: providerB.admin.password,
        installation: { profile: 'school', host: '127.0.0.1' } });
      await validateAcceptanceService(target.service, target.expected);
      const restoredEnvironment = (await target.runtime.status()).environment;
      assert.equal(restoredEnvironment.profile, 'school');
      assert.equal(restoredEnvironment.environmentId, source.host.environment.environmentId);
      assert.notEqual(restoredEnvironment.installationId, source.host.environment.installationId);
      assert.notEqual(restoredEnvironment.clientNamespace, source.host.environment.clientNamespace);
      assert.notEqual(restoredEnvironment.services[0].endpoint, source.host.endpoint);
      assert.equal((await json(join(target.root, 'recovery-state.json'))).phase, 'isolated');
      await assert.rejects(target.service.pending(), error => error.code === 'maintenance');
      await assert.rejects(target.service.save({ requestId: randomUUID(), id: 'isolated-write', value: {} }), error => error.code === 'maintenance');
      assert.notEqual(target.binding.connection.password, source.binding.connection.password);
      assert.deepEqual(target.binding.owner, source.binding.owner);
      assert.deepEqual(publicConnection(await api.recoveryDatabase(target.root)), publicConnection(providerB.admin));
      targetIdentity = await json(join(target.root, 'external-database.json'));
      assert.notDeepEqual(targetIdentity, sourceIdentity);
      assert.equal(await exists(join(target.root, 'pgdata')), false);
      await protect();
      return { profile: 'school', databaseMode: 'external', isolated: true, readsVerified: true, writesAndDispatchClosed: true,
        ownerPreserved: true, targetCredentialRotated: true, targetDatabaseB: true, independentBUnchanged: true };
    });
    await stage('takeover-source-retirement-and-new-writes', async () => {
      const owners = target.restored.owners.filter(item => item.participant.descriptor.serviceId === target.owner.serviceId);
      assert.equal(owners.length, 1);
      target.host = await api.createProductRuntimeHost({ root: target.root, recoveryOwners: owners });
      await assert.rejects(target.service.pending(), error => error.code === 'maintenance');
      await target.host.recovery.takeover({ source: source.host.recovery, receivers: [] });
      await verifyHost(target); await verifyHost(source, 'maintenance');
      assert.equal((await json(join(target.root, 'recovery-state.json'))).phase, 'active');
      await assert.rejects(source.host.recovery.resume(), error => error.code === 'source-retired');
      await assert.rejects(source.runtime.start(), error => error.code === 'source-retired');
      await assert.rejects(source.service.save({ requestId: randomUUID(), id: 'retired-write', value: {} }), error => error.code === 'maintenance');
      assert.deepEqual(await target.service.save(source.request), source.expected.receipts[0]);
      assert.deepEqual(await target.service.pending(), source.expected.pending);
      await validateAcceptanceService(target.service, target.expected);
      const saved = await target.service.save({ requestId: randomUUID(), id: 'after-takeover', value: { active: true } });
      assert.equal(saved.result.seq, '3');
      target.expected.records.push({ id: 'after-takeover', value: { active: true }, seq: '3' });
      target.expected.receipts.push(saved); target.expected.sequence = { last_value: '3', is_called: true };
      await validateAcceptanceService(target.service, target.expected); await protect();
      return { sourceRetired: true, sourceResumeAndStartRejected: true, sourceWritesFenced: true,
        targetActive: true, idempotentReceiptPreserved: true, unknownIntentsPreserved: true, newSequence: '3', remoteReceiversRegistered: 0 };
    });
    await stage('school-stop-uninstall-do-not-manage-external-postgres', async () => {
      target.installationId = target.host.environment.installationId;
      await source.host.stop(); source.host = undefined;
      await target.host.stop(); target.host = undefined;
      assert.equal((await source.runtime.stop()).state, 'stopped');
      assert.equal((await target.runtime.stop()).state, 'stopped');
      assert.equal((await source.runtime.uninstall()).state, 'uninstalled');
      assert.equal((await target.runtime.uninstall()).state, 'uninstalled');
      await ready(providerA); await ready(providerB);
      const readSource = track(await api.storage.openStorage({ binding: source.binding, migrations, backend: source.backend }));
      const readTarget = track(await api.openRecoveredStorage({ root: target.root, serviceId: target.owner.serviceId, migrations, backend: target.backend }));
      await validateAcceptanceService(acceptanceService(readSource), source.expected);
      await validateAcceptanceService(acceptanceService(readTarget), target.expected);
      await readSource.close(); await readTarget.close(); await protect();
      assert.deepEqual(await json(join(source.root, 'external-database.json')), sourceIdentity);
      assert.deepEqual(await json(join(target.root, 'external-database.json')), targetIdentity);
      return { bothSchoolsStoppedAndUninstalled: true, bothProvidersStillReady: true,
        sourceAndTargetDatabaseDataReadable: true, externalDatabaseIdentityUnchanged: true, independentBUnchanged: true };
    });
    await stage('administrator-restarts-B-and-school-reopens-private-target-binding', async () => {
      // Close the unrelated sentinel's pool before the administrator's real PG restart.
      await independent.storage.close();
      assert.equal((await providerB.runtime.stop()).state, 'stopped');
      await ready(providerA);
      assert.equal((await providerB.runtime.start()).state, 'ready'); await ready(providerB);
      independent.storage = track(await api.storage.openStorage({ binding: independent.binding, migrations, backend: independent.backend }));
      independent.service = acceptanceService(independent.storage);
      // Reinstall preserves the existing installation identity and bound external DB.
      await target.runtime.install({ profile: 'school', database: external(providerB.admin, 'external-admin-B') });
      const previous = target.storage;
      target.host = await api.createProductRuntimeHost({ root: target.root, async createRecoveryOwners() {
        const binding = JSON.parse(await api.resolveCredential(target.root, `storage-${target.owner.serviceId}`));
        assert.deepEqual(binding.owner, source.owner);
        assert.notEqual(binding.connection.password, source.binding.connection.password);
        assert.deepEqual(publicConnection(binding.connection), publicConnection(target.binding.connection));
        target.binding = binding;
        target.backend = backend(target, source.backend.id);
        target.storage = track(await api.openRecoveredStorage({ root: target.root, serviceId: target.owner.serviceId, migrations, backend: target.backend }));
        assert.notEqual(target.storage, previous); target.service = acceptanceService(target.storage);
        return [ownerModule(target)];
      } });
      assert.equal(target.host.environment.installationId, target.installationId);
      await verifyHost(target);
      assert.deepEqual(await json(join(target.root, 'external-database.json')), targetIdentity);
      await validateAcceptanceService(target.service, target.expected);
      assert.deepEqual(await target.service.pending(), source.expected.pending);
      const saved = await target.service.save({ requestId: randomUUID(), id: 'after-provider-restart', value: { restarted: true } });
      assert.equal(saved.result.seq, '4');
      target.expected.records.push({ id: 'after-provider-restart', value: { restarted: true }, seq: '4' });
      target.expected.receipts.push(saved); target.expected.sequence = { last_value: '4', is_called: true };
      await validateAcceptanceService(target.service, target.expected); await protect();
      await assert.rejects(api.createProductRuntimeHost({ root: source.root }), error => error.code === 'source-retired');
      return { providerBRestartedByAdministrator: true, newOwnerModuleAndPool: true, privateRotatedCredentialReopened: true,
        installationAndDataOwnerPreserved: true, originalReceiptsAndRawAndOpaqueBytesPreserved: true,
        independentBUnchanged: true, sequenceAfterRestart: '4', sourceCannotReopen: true };
    });
    evidence.status = 'passed';
  } catch (error) {
    evidence.status = 'failed'; evidence.error = safeCode(error);
    // A failed operation must also leave the confirmed backup and unrelated B
    // sample readable. Never print original SQL/driver errors or binding values.
    try { await protect(); evidence.failureProtection = { backupAndIndependentBUnchanged: true }; }
    catch (protectionError) { evidence.failureProtection = { backupAndIndependentBUnchanged: false, error: safeCode(protectionError) }; }
  } finally {
    for (const value of [...actors].reverse()) if (value.host) {
      try { await value.host.stop(); evidence.cleanup.push({ actor: value.name, action: 'host-stop', passed: true }); }
      catch (error) { evidence.status = 'failed'; evidence.cleanup.push({ actor: value.name, action: 'host-stop', passed: false, error: safeCode(error) }); }
    }
    for (const storage of pools) {
      try { await storage.close(); }
      catch (error) { evidence.status = 'failed'; evidence.cleanup.push({ action: 'pool-close', passed: false, error: safeCode(error) }); }
    }
    for (const value of [...actors].reverse()) if (await exists(join(value.root, 'installation.json'))) {
      try { await value.runtime.stop(); evidence.cleanup.push({ actor: value.name, action: 'runtime-stop', passed: true }); }
      catch (error) { evidence.status = 'failed'; evidence.cleanup.push({ actor: value.name, action: 'runtime-stop', passed: false, error: safeCode(error) }); }
    }
    evidence.finishedAt = new Date().toISOString(); evidence.retained = true;
    evidence.privateKeyFile = join(root, 'private/recovery-key.base64');
    await persist();
  }
  console.log(`External school recovery ${evidence.status}; evidence: ${opt.out}`);
  if (evidence.status !== 'passed') process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  if (process.argv.includes('--help')) console.log(usage);
  else {
    try {
      const opt = options(process.argv.slice(2)), pkg = await packageInfo(opt.package);
      if (await realpath(process.execPath) !== await realpath(pkg.resources.nodePath)) {
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['NODE_PATH', 'NODE_OPTIONS'].includes(key) && !/^PG/.test(key)));
        const child = spawn(pkg.resources.nodePath, [script, ...process.argv.slice(2)], { shell: false, windowsHide: true, stdio: 'inherit', env });
        process.exitCode = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', (code, signal) => done(signal ? 1 : code ?? 1)); });
      } else await main(opt, pkg);
    } catch (error) { console.error(`External school recovery failed: ${safeCode(error)}`); process.exitCode = 1; }
  }
}
