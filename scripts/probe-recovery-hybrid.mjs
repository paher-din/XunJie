#!/usr/bin/env node
// Real distribution consumer. No production imports, lifecycle reimplementation,
// SSH tunnels, insecure TLS, alternate request IDs or unknown-effect replay.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises';
import { arch, platform, release } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { acceptanceService, migrations, validateAcceptanceService, portableExpected } from './recovery-acceptance-owner.mjs';

const script = fileURLToPath(import.meta.url), repository = resolve(dirname(script), '..');
const HELP = `XunJie #145 REAL Mac -> Linux public TLS hybrid recovery acceptance.
  node scripts/probe-recovery-hybrid.mjs --mac-package DIR --root NEW_PRIVATE_ROOT
    --out NEW_EVIDENCE_JSON --ssh-host xunjie-cloud [--ssh-config FILE]
    --remote-root PREPARED_HOST_ROOT --remote-script REMOTE_HOST_SCRIPT
    [--remote-node REMOTE_BUNDLED_NODE] --s3-config LOCAL_PRIVATE_JSON --ca PEM

Main must prepare (this probe never changes SG/nginx/deployment):
1. Copy recovery-hybrid-host.mjs and Linux distribution to school Linux. Create a
   new Host root using its --help, an existing Seaweed loopback private config,
   cert/key and public port. Keep that process alive (SSH nohup is sufficient).
2. Permit public TLS to that independent Host. Copy its trust CA to Mac.
3. Copy S3 private config to Mac (0600), change endpoint to Host public HTTPS
   origin; supply bucket, targetBucket, failedTargetBucket: THREE distinct empty
   buckets prepared by main. Same backend id; source/targets use distinct buckets.
   Config must retain region/accessKeyId/secretAccessKey. No keys in argv/stdout.
4. SSH account can run the copied Host script and read/write its own private
   root. Pass --remote-node when the remote default node is not suitable.
No SSH forwarding. Mac and Linux evidence must report darwin and linux. TLS
validation stays enabled; re-exec uses the Mac distribution's bundled Node and CA.

Offline backup is tested BEFORE the final held backup: resuming that boundary
afterwards would invalidate takeover. Then a held backup is restored isolated,
the bridge/receiver stops again, another target restore fails, and a NEW target
is rebuilt from the SAME retained backup after connectivity returns. Source
stays alive through real takeover; all original service IDs are fenced via SSH.
Only the original effect ID is queried again with the new target's fresh grant.
Data responsibility is reported by the authenticated external-school status API.
Own Mac hosts/pools/managed PG and this acceptance Host stop in finally. Roots,
encrypted backup, receipts and S3 objects are retained as evidence; temporary SSH
source/grant export files are removed. This is not teaching-effectiveness testing.
`;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const codeOf = error => /^[a-zA-Z0-9_-]{1,80}$/.test(error?.code ?? '') ? error.code : 'hybrid-probe-failed';
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (parent, child) => { const p = relative(parent, child); return !p || (!isAbsolute(p) && p !== '..' && !p.startsWith(`..${sep}`)); };
const exists = async path => { try { await lstat(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
async function fileHash(path) { const h = createHash('sha256'); for await (const bytes of createReadStream(path)) h.update(bytes); return h.digest('hex'); }
async function privateJson(path) {
  const info = await lstat(path); if (!info.isFile() || (info.mode & 0o077)) fail('private-input-file-required'); return json(path);
}
const privateWrite = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
function options(argv) {
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].slice(2);
    if (!argv[i].startsWith('--') || !['mac-package','root','out','ssh-host','ssh-config','remote-root','remote-script','remote-node','s3-config','ca'].includes(name)
      || !argv[i + 1] || argv[i + 1].startsWith('--') || opt[name]) fail('invalid-arguments');
    opt[name] = argv[++i];
  }
  for (const name of ['mac-package','root','out','ssh-host','remote-root','remote-script','s3-config','ca']) if (!opt[name]) fail('required-arguments-missing');
  for (const name of ['mac-package','root','out','s3-config','ca','ssh-config']) if (opt[name]) opt[name] = resolve(opt[name]);
  for (const name of ['remote-root','remote-script']) if (!posix.isAbsolute(opt[name]) || /[\r\n\0]/.test(opt[name])) fail('absolute-remote-path-required');
  if (!/^[a-zA-Z0-9_@.-]+$/.test(opt['ssh-host']) || opt['ssh-host'].startsWith('-')) fail('invalid-ssh-host');
  return opt;
}
function run(binary, args, timeoutMs = 30000, env = process.env) {
  return new Promise((yes, no) => {
    const child = spawn(binary, args, { shell: false, env, stdio: ['ignore','pipe','pipe'] });
    let stdout = '', size = 0, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 2 * 1024 * 1024) child.kill('SIGTERM'); else stdout += chunk; });
    // Subprocess stderr may contain third-party diagnostics: never echo it.
    child.stderr.resume();
    child.once('error', error => { clearTimeout(timer); no(error); });
    child.once('close', code => { clearTimeout(timer); if (timedOut || code !== 0 || size > 2 * 1024 * 1024) no(Object.assign(new Error(), { code: timedOut ? 'subprocess-timeout' : 'subprocess-failed' })); else yes(stdout); });
  });
}
async function packageInfo(path) {
  const root = await realpath(path), raw = await json(join(root, 'resources.json')), resources = { ...raw };
  for (const name of ['nodePath','postgresBin','webRoot']) {
    if (!raw[name]) fail('full-native-package-required');
    resources[name] = await realpath(resolve(root, raw[name]));
    if (!inside(root, resources[name])) fail('package-resource-outside-distribution');
  }
  return { root, resources, entry: join(root, 'app', 'product-runtime.js') };
}
async function main(opt, pkg) {
  process.umask(0o077);
  if (process.platform !== 'darwin') fail('real-mac-source-required');
  if (process.version !== `v${pkg.resources.nodeVersion}`) fail('bundled-node-version-mismatch');
  const root = join(await realpath(dirname(opt.root)), basename(opt.root));
  if ([await realpath(repository), pkg.root].some(parent => inside(parent, root))) fail('independent-root-required');
  await mkdir(root, { mode: 0o700 });
  await mkdir(join(root, 'private'), { mode: 0o700 });
  const out = await open(opt.out, 'wx', 0o600); await out.close();
  const api = await import(pathToFileURL(pkg.entry).href);
  const config = await privateJson(opt['s3-config']);
  const endpoint = new URL(config.endpoint);
  if (endpoint.protocol !== 'https:' || ['localhost','127.0.0.1','[::1]'].includes(endpoint.hostname)
    || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) fail('public-tls-s3-endpoint-required');
  const buckets = [config.bucket, config.targetBucket, config.failedTargetBucket];
  if (new Set(buckets).size !== 3 || buckets.some(b => typeof b !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(b))) fail('three-independent-prepared-buckets-required');
  const backendId = config.id ?? 'recovery-hybrid-s3';
  const backend = bucket => api.storage.createS3Backend({ id: backendId, endpoint: endpoint.origin, region: config.region,
    bucket, accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey });
  const sshArgs = ['-o','BatchMode=yes','-o','ConnectTimeout=10', ...(opt['ssh-config'] ? ['-F',opt['ssh-config']] : [])];
  const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
  const ssh = args => run('ssh', [...sshArgs, opt['ssh-host'], args.map(quote).join(' ')], 45000);
  const scp = (from, to) => run('scp', [...sshArgs, '--', from, to], 30000);
  const remoteFiles = [];
  const action = async (name, args = []) => JSON.parse(await ssh([opt['remote-node'] ?? 'node', opt['remote-script'], '--root', opt['remote-root'], '--action', name, ...args]));
  const upload = async (name, value) => {
    const local = join(root, 'private', `${name}-${randomUUID()}.json`);
    const remote = posix.join(opt['remote-root'], 'private', basename(local));
    await privateWrite(local, value); remoteFiles.push(remote);
    // SFTP-mode scp preserves local 0600 creation mode at the new remote path.
    await scp(local, `${opt['ssh-host']}:${remote}`); await ssh(['chmod','600',remote]); return remote;
  };
  async function authorize(identity, label) {
    const input = await upload(`${label}-identity`, identity);
    const remote = posix.join(opt['remote-root'], 'private', `${label}-grant-${randomUUID()}.json`);
    remoteFiles.push(remote);
    const proof = await action('authorize', ['--source-file', input, '--private-out', remote]);
    assert.equal(proof.authorized, true);
    const local = join(root, 'private', basename(remote));
    // Reserve 0600 before transfer; parent root itself is 0700.
    await writeFile(local, '', { flag: 'wx', mode: 0o600 });
    await scp(`${opt['ssh-host']}:${remote}`, local);
    const grant = await privateJson(local); assert.equal(grant.grantId, proof.grantId);
    return { grant, file: local };
  }
  let schoolRunning = true, schoolConfirmed = false;
  const contexts = [];
  const key = randomBytes(48), keyFile = join(root, 'private', 'recovery-key.base64');
  await writeFile(keyFile, key.toString('base64') + '\n', { mode: 0o600, flag: 'wx' });
  const evidence = { formatVersion: 1, issue: 145, kind: 'real-mac-linux-public-tls-hybrid-recovery', status: 'running',
    startedAt: new Date().toISOString(), publicEndpoint: endpoint.origin, root, keyFile,
    source: { platform: platform(), arch: arch(), release: release(), node: process.version, bundledNode: true },
    target: { platform: platform(), arch: arch(), node: process.version, database: 'independent managed PostgreSQL on Mac' },
    school: null, package: { path: pkg.root, nodeVersion: pkg.resources.nodeVersion, postgresVersion: pkg.resources.postgresVersion,
      entrySha256: await fileHash(pkg.entry), resourcesSha256: await fileHash(join(pkg.root, 'resources.json')),
      nodeSha256: await fileHash(pkg.resources.nodePath), postgresSha256: await fileHash(join(pkg.resources.postgresBin, 'postgres')) },
    refs: { coordinatorSha256: await fileHash(script), ownerSha256: await fileHash(join(dirname(script), 'recovery-acceptance-owner.mjs')),
      hostLocalSha256: await fileHash(join(dirname(script), 'recovery-hybrid-host.mjs')),
      repositoryHead: (await run('git', ['-C', repository, 'rev-parse', 'HEAD'])).trim() },
    storage: { backendId, endpoint: endpoint.origin, sourceBucket: buckets[0], isolatedBucket: buckets[1], rebuiltBucket: buckets[2] },
    stages: [], cleanup: [], limitations: ['Independent acceptance service; not teaching business data or teaching-effectiveness acceptance',
      'No school PostgreSQL installed; Mac managed PG plus external school S3/effect receiver',
      'Stops only the acceptance TLS bridge/receiver; does not interrupt or restart Seaweed, nginx or other school services'] };
  const persist = () => writeFile(opt.out, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  async function stage(name, work) {
    const item = { name, status: 'running', startedAt: new Date().toISOString() }; evidence.stages.push(item); await persist();
    console.error(`[probe-recovery-hybrid] ${name}`);
    const start = performance.now();
    try { item.result = await work(); item.status = 'passed'; return item.result; }
    catch (e) {
      item.error = codeOf(e); item.status = 'failed';
      const site = /(?:probe-recovery-hybrid|recovery-acceptance-owner)\.mjs:(\d+):(\d+)/.exec(String(e?.stack ?? ''));
      if (site) item.failureLine = Number(site[1]); throw e;
    }
    finally { item.durationMs = Math.round(performance.now() - start); await persist(); }
  }
  const context = name => {
    const value = { root: join(root, name), storages: new Set() };
    value.runtime = api.openProductRuntime({ root: value.root, resources: pkg.resources }); contexts.push(value); return value;
  };
  const track = (value, storage) => {
    const close = storage.close.bind(storage); let closing;
    storage.close = () => closing ??= close(); value.storages.add(storage); return storage;
  };
  const connection = (identity, service) => ({ connectionId: randomUUID(), ...identity, target: service,
    requiredCapabilities: ['effect','status'], optionalCapabilities: [], credentialRef: `hybrid-${randomUUID()}` });
  const outbound = (descriptor, grant) => api.createOutboundConnection({ connection: descriptor, credential: async () => grant.token, timeoutMs: 15000 });
  const rejected = async (operation, allowed) => {
    let error; try { await operation(); } catch (e) { error = e; }
    assert.ok(error, 'operation must reject'); const code = codeOf(error);
    if (allowed) assert.ok(allowed(code), 'must reject for expected reason'); return code;
  };
  let service, original, originalOutbound, originalReceipt, backupDirectory, manifest, manifestSha;
  function target(name, original, bucket) {
    const value = context(name); value.backend = backend(bucket);
    value.target = api.createStorageRecoveryTarget({ owner: original.owner, admin: () => api.recoveryDatabase(value.root),
      resources: pkg.resources, backend: value.backend, migrations,
      onRestored(storage, binding) { value.storage = track(value, storage); value.binding = binding; value.service = acceptanceService(storage); },
      validateService: store => validateAcceptanceService(acceptanceService(store), original.expected) });
    return value;
  }
  async function restore(value) {
    value.restored = await api.restoreProductRecovery({ root: value.root, backupDirectory, resources: pkg.resources, key, targets: [value.target] });
    await validateAcceptanceService(value.service, original.expected);
    const pending = await rejected(() => value.service.pending(), code => code === 'maintenance');
    const writes = await rejected(() => value.service.save({ requestId: randomUUID(), id: 'isolated-rejected', value: {} }), code => code === 'maintenance');
    assert.equal((await json(join(value.root, 'recovery-state.json'))).phase, 'isolated');
    const env = (await value.runtime.status()).environment;
    const engineVersion = await value.service.engine(); assert.equal(engineVersion, pkg.resources.postgresVersion);
    assert.equal(env.environmentId, original.host.environment.environmentId);
    assert.notEqual(env.installationId, original.host.environment.installationId);
    assert.deepEqual(env.services.map(s => s.serviceId), original.host.environment.services.map(s => s.serviceId));
    return { backupId: value.restored.manifest.backupId, isolated: true, pendingRejected: pending, writesRejected: writes,
      environmentId: env.environmentId, installationId: env.installationId, originalServiceIdsPreserved: true,
      engineVersion, recordsReceiptsAndRawOpaqueBytesVerified: true };
  }
  async function unchangedBackup() {
    assert.equal(await fileHash(join(backupDirectory, 'manifest.json')), manifestSha);
    for (const artifact of manifest.artifacts) assert.equal(await fileHash(join(backupDirectory, 'artifacts', artifact.path)), artifact.sha256);
    return { sameBackupId: manifest.backupId, originalManifestAndArtifactsUnchanged: true };
  }
  try {
    await stage('school-independent-host-real-linux-identity', async () => {
      const school = await action('status');
      assert.equal(school.platform, 'linux'); assert.equal(school.service.endpoint, endpoint.origin);
      assert.equal(school.scriptSha256, evidence.refs.hostLocalSha256);
      schoolConfirmed = true;
      service = school.service; evidence.school = school;
      const unauth = await fetch(new URL('/runtime/capabilities/status', endpoint), { method: 'POST', signal: AbortSignal.timeout(15000) });
      await unauth.body?.cancel(); assert.equal(unauth.status, 401);
      return { platform: school.platform, pid: school.pid, service, unauthenticatedStatusRejected: true };
    });
    original = context('source'); original.backend = backend(buckets[0]);
    evidence.source.runtimeRoot = original.root;
    await stage('source-install-connect-before-host-and-seed-unknown-effect', async () => {
      const ownerId = randomUUID();
      const installed = await original.runtime.install({ profile: 'local', host: '127.0.0.1', requiredServiceIds: [ownerId] });
      original.owner = { environmentId: installed.environment.environmentId, serviceId: ownerId };
      original.identity = { sourceEnvironmentId: installed.environment.environmentId, sourceServiceId: installed.environment.services[0].serviceId };
      const authorization = await authorize(original.identity, 'source'); original.grant = authorization.grant;
      original.connection = connection(original.identity, service);
      await original.runtime.connect(original.connection, original.grant.token);
      originalOutbound = outbound(original.connection, original.grant);
      assert.equal((await originalOutbound.check()).state, 'ready');
      original.host = await api.createProductRuntimeHost({ root: original.root, async createRecoveryOwners() {
        const admin = await api.recoveryDatabase(original.root); assert.ok(admin);
        original.binding = await api.storage.provisionStorage({ admin, owner: original.owner, password: randomBytes(32).toString('base64url'), migrations });
        original.storage = track(original, await api.storage.openStorage({ binding: original.binding, backend: original.backend, migrations }));
        original.service = acceptanceService(original.storage);
        return [api.createStorageRecoveryOwner({ storage: original.storage, binding: original.binding, migrations,
          resources: pkg.resources, validateService: store => validateAcceptanceService(acceptanceService(store), original.expected) })];
      } });
      assert.equal((await original.host.status()).state, 'ready');
      const bytes = [Buffer.from('跨机公网 TLS recovery\0\u00ff'), randomBytes(128 * 1024 + 23)], refs = [];
      for (const content of bytes) refs.push(await original.service.stage(randomUUID(), content));
      const requestId = randomUUID(), intentId = randomUUID();
      original.request = { requestId, id: 'kept', value: { effectRequestId: intentId, state: 'unknown' }, references: refs, intentId };
      const saved = await original.service.save(original.request);
      const second = await original.service.save({ requestId: randomUUID(), id: 'second', value: { count: 2 } });
      original.expected = { records: [{ id: 'kept', value: original.request.value, seq: '1' }, { id: 'second', value: { count: 2 }, seq: '2' }],
        receipts: [saved, second], resources: [], sequence: { last_value: '2', is_called: true }, pending: await original.service.pending() };
      for (const [i, ref] of refs.entries()) { const item = await original.service.resource(ref.resourceId); assert.deepEqual(item.bytes, bytes[i]); original.expected.resources.push(item); }
      assert.deepEqual(original.expected.pending, [{ intentId, payload: { requestId, recordId: 'kept', externalRequestId: intentId, state: 'unknown' } }]);
      original.effectId = intentId;
      const before = await originalOutbound.request('status'); assert.equal(before.counter, 0);
      originalReceipt = await originalOutbound.request('effect', { requestId: intentId });
      assert.deepEqual(originalReceipt.originalSource, original.identity); assert.equal(originalReceipt.counter, 1);
      assert.deepEqual(await original.service.pending(), original.expected.pending); // deliberately do NOT acknowledge the outbox
      await privateWrite(join(root, 'private', 'expected.json'), { expected: portableExpected(original.expected), request: original.request, originalReceipt });
      evidence.responsibility = (await originalOutbound.request('status')).responsibility;
      const engineVersion = await original.service.engine(); assert.equal(engineVersion, pkg.resources.postgresVersion);
      return { sourceEnvironment: original.host.environment, owner: original.owner, connectionRegisteredBeforeHost: true,
        engineVersion, originalRequestId: requestId, originalEffectId: intentId, originalReceipt, outboxRemainsUnknown: true,
        resources: original.expected.resources.map(r => ({ reference: r.reference, sha256: hash(r.bytes), opaqueSha256: hash(r.opaque), byteLength: r.bytes.length })) };
    });
    await stage('offline-public-bridge-backup-fails-before-held-boundary', async () => {
      const stopped = await action('stop'); schoolRunning = false; assert.equal(stopped.ownPidConfirmed, true);
      assert.equal((await originalOutbound.check()).state, 'unavailable');
      const error = await rejected(() => original.host.recovery.backup({ directory: join(root, 'offline-backup'), key, leaveClosed: true }),
        code => code.startsWith('owner-export-'));
      assert.deepEqual(await original.service.receipt(original.request.requestId), original.expected.receipts[0]);
      const started = await action('start'); schoolRunning = true;
      assert.deepEqual(started.service, service); assert.equal((await originalOutbound.check()).state, 'ready');
      await original.host.recovery.resume();
      const status = await originalOutbound.request('status'); assert.equal(status.counter, 1);
      assert.deepEqual(status.receipts[original.effectId], originalReceipt);
      assert.deepEqual(await original.service.pending(), original.expected.pending);
      return { stopped, backupRejected: error, restoredConnection: true, unknownEffectNotReplayed: true, receiptAndCounterUnchanged: true };
    });
    await stage('source-held-backup-with-real-receiver-id', async () => {
      const backups = join(root, 'backups');
      manifest = await original.host.recovery.backup({ directory: backups, key, leaveClosed: true });
      backupDirectory = join(backups, manifest.backupId); manifestSha = await fileHash(join(backupDirectory, 'manifest.json'));
      assert.deepEqual(manifest.receiverIds, [`${service.environmentId}/${service.serviceId}`]);
      evidence.backup = { backupDirectory, backupId: manifest.backupId, boundaryAt: manifest.boundaryAt,
        completedAt: manifest.completedAt, durationMs: manifest.durationMs, manifestSha256: manifestSha, artifacts: manifest.artifacts };
      return { ...evidence.backup, receiverIds: manifest.receiverIds, held: true };
    });
    const isolated = target('isolated-target', original, buckets[1]);
    await stage('first-target-isolated-original-api-bytes-and-identities', () => restore(isolated));
    await stage('offline-public-bridge-restore-fails-and-original-backup-survives', async () => {
      const stopped = await action('stop'); schoolRunning = false;
      assert.equal((await originalOutbound.check()).state, 'unavailable');
      const failed = target('offline-failed-target', original, buckets[2]);
      const error = await rejected(() => api.restoreProductRecovery({ root: failed.root, backupDirectory,
        resources: pkg.resources, key, targets: [failed.target] }), code => code === 'unavailable');
      const state = await json(join(failed.root, 'recovery-state.json')); assert.equal(state.phase, 'failed');
      assert.equal(await exists(join(failed.root, 'instance.json')), false);
      const backupProof = await unchangedBackup();
      const started = await action('start'); schoolRunning = true; assert.deepEqual(started.service, service);
      assert.equal((await originalOutbound.check()).state, 'ready');
      const status = await originalOutbound.request('status'); assert.equal(status.counter, 1); assert.deepEqual(status.receipts[original.effectId], originalReceipt);
      return { stopped, restoreRejected: error, failedTargetNeverActive: true, connectivityRestored: true, unknownEffectNotReplayed: true, ...backupProof };
    });
    const rebuilt = target('same-backup-rebuilt-target', original, buckets[2]);
    evidence.target.runtimeRoot = rebuilt.root;
    await stage('same-backup-new-independent-target-rebuild', async () => ({ ...await restore(rebuilt), ...await unchangedBackup() }));
    await stage('real-takeover-with-source-alive-and-ssh-authority-fence', async () => {
      const owners = rebuilt.restored.owners.filter(o => o.participant.descriptor.serviceId === original.owner.serviceId);
      assert.equal(owners.length, 1);
      rebuilt.host = await api.createProductRuntimeHost({ root: rebuilt.root, recoveryOwners: owners });
      await rejected(() => rebuilt.service.pending(), code => code === 'maintenance');
      const fences = [];
      const result = await rebuilt.host.recovery.takeover({ source: original.host.recovery, receivers: [{
        id: `${service.environmentId}/${service.serviceId}`,
        async fence(sourceEnvironment, sourceServiceIds) {
          const sourceFile = await upload('fence-original-all-services', { sourceEnvironmentId: sourceEnvironment.environmentId, sourceServiceIds });
          const proof = await action('fence-source', ['--source-file', sourceFile]);
          assert.equal(proof.fenced, true);
          assert.deepEqual(proof.proofs.map(p => p.sourceServiceId).sort(), [...sourceServiceIds].sort());
          fences.push(proof); return proof;
        },
      }] });
      assert.equal(result.phase, 'active');
      const alive = await fetch(new URL('/runtime/environment', original.host.endpoint), { signal: AbortSignal.timeout(5000) });
      assert.equal(alive.status, 200); assert.equal((await alive.json()).installationId, original.host.environment.installationId);
      const resumeError = await rejected(() => original.host.recovery.resume(), code => code === 'source-retired');
      const startError = await rejected(() => original.runtime.start(), code => code === 'source-retired');
      await validateAcceptanceService(rebuilt.service, original.expected);
      assert.deepEqual(await rebuilt.service.pending(), original.expected.pending);
      assert.deepEqual(await rebuilt.service.save(original.request), original.expected.receipts[0]);
      const oldCheck = await originalOutbound.check(); assert.equal(oldCheck.reason, 'http_401');
      const oldEffectError = await rejected(() => originalOutbound.request('effect', { requestId: original.effectId }), code => code === 'http_401');
      const reconnect = outbound(original.connection, original.grant); assert.equal((await reconnect.check()).reason, 'http_401');
      return { result, fences, originalSourceStillAlive: true, resumeError, startError, oldEffectError,
        oldTokenRejected: true, freshConnectionOldTokenRejected: true, unknownOutboxIDsAndReceiptPreserved: true };
    });
    await stage('receiver-restart-keeps-fence-new-target-grant-original-effect-receipt', async () => {
      const stopped = await action('stop'); schoolRunning = false;
      const started = await action('start'); schoolRunning = true; assert.deepEqual(started.service, service);
      assert.equal((await outbound(original.connection, original.grant).check()).reason, 'http_401');
      await rejected(() => originalOutbound.request('effect', { requestId: original.effectId }), code => code === 'http_401');
      const env = rebuilt.host.environment;
      const identity = { sourceEnvironmentId: env.environmentId, sourceServiceId: env.services[0].serviceId };
      const fresh = await authorize(identity, 'target'); assert.notEqual(fresh.grant.grantId, original.grant.grantId);
      // Restored connection deliberately retains its original descriptor; replace
      // only the credential through the public API, never copied installation JSON.
      await rebuilt.runtime.setCredential(original.connection.credentialRef, fresh.grant.token);
      const receiver = outbound(original.connection, fresh.grant);
      assert.equal((await receiver.check()).state, 'ready');
      const before = await receiver.request('status'); assert.equal(before.counter, 1);
      const receipt = await receiver.request('effect', { requestId: original.effectId });
      assert.deepEqual(receipt, originalReceipt);
      const after = await receiver.request('status'); assert.equal(after.counter, before.counter);
      assert.deepEqual(after.receipts, before.receipts);
      assert.equal((await originalOutbound.check()).reason, 'http_401');
      assert.deepEqual(await rebuilt.service.pending(), original.expected.pending);
      await validateAcceptanceService(rebuilt.service, original.expected);
      assert.equal((await rebuilt.host.status()).state, 'ready');
      return { stopped, restartedPid: started.pid, serviceIdentityStable: true, oldTokenStillRejectedAfterRestartAndNewAuthorization: true,
        newTargetGrantId: fresh.grant.grantId, originalEffectId: original.effectId, sameOriginalReceipt: receipt,
        counterBefore: before.counter, counterAfter: after.counter, noNewEffectIdOrUnknownReplay: true,
        sourceOutboxUnknownPreserved: true, targetRuntimeReadyWithReissuedCredential: true, ...await unchangedBackup() };
    });
    evidence.status = 'passed';
  } catch (error) { evidence.status = 'failed'; evidence.error = codeOf(error); throw error; }
  finally {
    for (const value of contexts.reverse()) {
      const errors = [];
      if (value.host) await value.host.stop().catch(e => errors.push(codeOf(e)));
      for (const storage of value.storages) await storage.close().catch(e => errors.push(codeOf(e)));
      if (await exists(join(value.root, 'installation.json'))) await value.runtime.stop().catch(e => errors.push(codeOf(e)));
      evidence.cleanup.push({ root: value.root, ownHostPoolsAndManagedPgStopped: errors.length === 0, dataRetained: true, ...(errors.length ? { errors } : {}) });
      if (errors.length) evidence.status = 'failed';
    }
    if (schoolConfirmed && schoolRunning) {
      try { evidence.cleanup.push({ schoolAcceptanceHost: await action('stop') }); schoolRunning = false; }
      catch (error) { evidence.cleanup.push({ schoolAcceptanceHostStopError: codeOf(error) }); evidence.status = 'failed'; }
    }
    if (remoteFiles.length) {
      try { await ssh(['rm','-f','--',...remoteFiles]); evidence.cleanup.push({ privateRemoteTransferFilesRemoved: remoteFiles.length }); }
      catch (error) { evidence.cleanup.push({ privateRemoteTransferCleanupError: codeOf(error) }); evidence.status = 'failed'; }
    }
    evidence.cleanup.push({ retained: 'Private roots, original encrypted backup/key, service receipts, source/target S3 objects; no other school services touched',
      schoolAcceptanceHostRunning: schoolRunning });
    evidence.completedAt = new Date().toISOString(); await persist();
    if (evidence.status !== 'passed') process.exitCode = 1;
  }
}
async function entry() {
  if (process.argv.includes('--help')) { console.log(HELP); return; }
  const opt = options(process.argv.slice(2)), pkg = await packageInfo(opt['mac-package']);
  const executable = await realpath(process.execPath), ca = await realpath(opt.ca);
  if (executable !== pkg.resources.nodePath || process.env.NODE_EXTRA_CA_CERTS !== ca) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['NODE_PATH','NODE_OPTIONS','NODE_TLS_REJECT_UNAUTHORIZED'].includes(key) && !/^PG/.test(key)));
    const child = spawn(pkg.resources.nodePath, [script,...process.argv.slice(2)], { shell: false,
      stdio: 'inherit', env: { ...env, NODE_EXTRA_CA_CERTS: ca } });
    process.exitCode = await new Promise((yes, no) => { child.once('error', no); child.once('exit', code => yes(code ?? 1)); });
    return;
  }
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') fail('tls-verification-required');
  await main(opt, pkg);
}
entry().catch(error => { console.error(JSON.stringify({ error: codeOf(error) })); process.exitCode = 1; });
