import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { pathToFileURL } from 'node:url';
import { ensureCertificateAuthority, ensureEnvironmentCertificate } from '../src/certificates.mjs';
import { environmentPaths, PINNED_NODE, TOOL_VERSION } from '../src/paths.mjs';
import { ACCESS_PROTOCOL, digest as hexDigest, publicKey, verifyProof, writePrivateJson } from '../src/enrollment-protocol.mjs';
import { joinEnrollment } from '../src/enrollment-client.mjs';
import { encodeZip, digest, jsonBytes } from '../src/repro-archive.mjs';
import { LOCKFILES, LOCK_DIGEST_ALGORITHM, lockfileDigest } from '../src/repro-code.mjs';
import { schemaFingerprint } from '../src/repro-data.mjs';
import { inspectRepro } from '../src/repro.mjs';
import { crc64XZ, publishFrozen, resumeUpload, fetchRepro, pruneCache } from '../src/package-transfer.mjs';

const worktree = join(import.meta.dirname, '../../..'), PART = 8 * 1024 * 1024;
let shared, ca, cert, schema, previousCA;
before(async () => {
  shared = realpathSync(mkdtempSync(join(tmpdir(), 'xj-transfer-tls-')));
  ca = ensureCertificateAuthority(shared); cert = ensureEnvironmentCertificate(environmentPaths(shared, 'tls'), ca);
  schema = await schemaFingerprint(join(worktree, 'apps/teaching'), shared);
  previousCA = getCACertificates('default');
  setDefaultCACertificates([...previousCA, readFileSync(ca.certFile, 'utf8')]);
});
after(() => { setDefaultCACertificates(previousCA); rmSync(shared, { recursive: true, force: true, maxRetries: 3 }); });

function makePackage(file, { large = false, incompatible = false, title = 'transfer protocol' } = {}) {
  const code = Buffer.from('protocol fixture bundle'), data = Buffer.from('protocol fixture database');
  const entries = new Map([['code/source.bundle', code], ['data/shared.sqlite', data],
    ['scenario.json', jsonBytes({ start: 'before-trigger', title, steps: ['manual observation'], expected: 'expected', observed: 'observed' })]]);
  if (large) entries.set('assets/random', randomBytes(PART + 300));
  const manifest = { formatVersion: 'xj-repro/1', tool: { version: TOOL_VERSION },
    code: { exportedCommit: 'fixture', files: [], bundleDigest: digest(code) }, data: { schema, digest: digest(data) },
    conditions: { node: PINNED_NODE, toolVersion: incompatible ? 'incompatible' : TOOL_VERSION,
      lockfileDigestAlgorithm: LOCK_DIGEST_ALGORITHM, capabilities: {},
      lockfiles: Object.fromEntries(LOCKFILES.map(path => [path, lockfileDigest(readFileSync(join(worktree, path)))])) },
    resources: { assets: large ? [{ path: 'assets/random', bytes: entries.get('assets/random').length, digest: digest(entries.get('assets/random')) }] : [], evidence: [] },
    verification: { generated: true, restored: false, reproduction: 'unverified' } };
  entries.set('manifest.json', jsonBytes(manifest));
  entries.set('checksums.json', jsonBytes(Object.fromEntries([...entries].map(([path, bytes]) => [path, digest(bytes)]))));
  const bytes = encodeZip(entries); writeFileSync(file, bytes); return bytes;
}

// Real TLS and OpenSSH proof at the public boundary; this deliberately is not
// an OSS or deployed access-service acceptance test.
async function fixture(t, options) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'xj-transfer-'))), home = join(root, 'home');
  const file = join(root, 'scene.zip'), bytes = makePackage(file, options);
  const key = join(root, 'host');
  assert.equal(spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key], { stdio: 'ignore' }).status, 0);
  const knownHosts = 'approved.test ' + publicKey(readFileSync(key + '.pub', 'utf8')) + '\n';
  const serviceId = randomUUID(), secret = randomBytes(32).toString('base64url'), challenges = new Map();
  const identity = { memberId: 'member-one', deviceId: 'device-one', teamRole: 'developer', capabilities: ['page'] };
  const controls = {}, calls = [], puts = [], gets = [], grants = [], records = new Map(), uploads = new Map();
  const server = createServer({ key: readFileSync(cert.keyFile), cert: readFileSync(cert.certFile) }, async (req, res) => {
    const reply = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    try {
      const url = new URL(req.url, endpoint);
      if (url.pathname.startsWith('/objects/')) {
        if (req.method === 'PUT') {
          const partNumber = Number(url.searchParams.get('part')), transferId = url.pathname.split('/').at(-1);
          puts.push(partNumber);
          if (controls.redirectPUT) { res.writeHead(302, { location: `https://unapproved.test/?signature=${secret}` }); res.end(); return; }
          if (controls.expiredPUT) { controls.expiredPUT--; res.writeHead(403); res.end('secret URL failure'); return; }
          if (controls.failPart === partNumber) { req.socket.destroy(); return; }
          const chunks = []; for await (const chunk of req) chunks.push(chunk);
          const body = Buffer.concat(chunks), contentMD5 = createHash('md5').update(body).digest('base64');
          assert.equal(req.headers['content-md5'], contentMD5); assert.equal(Number(req.headers['content-length']), body.length);
          const etag = '"' + createHash('md5').update(body).digest('hex').toUpperCase() + '"';
          uploads.get(transferId).set(partNumber, { partNumber, bytes: body.length, contentMD5, etag, body });
          if (controls.losePUTResponse) { controls.losePUTResponse = false; req.socket.destroy(); return; }
          res.writeHead(200, { etag }); res.end(); return;
        }
        const id = url.pathname.split('/').at(-1), entry = records.get(id);
        const body = controls.corrupt ? Buffer.from(entry.body).fill(0, 30, 31) : entry.body;
        const offset = Number(req.headers.range?.match(/^bytes=(\d+)-$/)?.[1]); gets.push({ offset, etag: req.headers['if-match'] });
        if (controls.precondition) { controls.precondition--; res.writeHead(412); res.end(); return; }
        const headers = { etag: controls.wrongETag ? '"different"' : entry.etag,
          'content-range': `bytes ${controls.wrongRange ? offset + 1 : offset}-${body.length - 1}/${body.length}`,
          'content-length': body.length - offset };
        if (controls.pauseGET) { controls.pauseGET(res); await controls.releaseGET; }
        res.writeHead(controls.fullResponse ? 200 : 206, headers);
        if (controls.interruptGET) {
          controls.interruptGET = false; res.write(body.subarray(offset, offset + 321));
          setTimeout(() => res.destroy(), 20); return;
        }
        res.end(body.subarray(offset)); return;
      }
      let text = ''; for await (const chunk of req) text += chunk;
      const input = JSON.parse(text);
      if (req.url === '/v1/challenges') {
        if (controls.revoked) return reply(403, { ok: false, code: 'DEVICE_REVOKED', secret });
        const challenge = { serviceId, challengeId: randomUUID(), nonce: randomBytes(24).toString('base64url'), expiresAt: Date.now() + 60000,
          method: 'POST', path: input.path, bodyHash: input.bodyHash };
        challenges.set(challenge.challengeId, { challenge, key: input.publicKey });
        return reply(200, { ok: true, data: challenge });
      }
      const saved = challenges.get(input.challengeId); assert.ok(saved); challenges.delete(input.challengeId);
      assert.equal(saved.challenge.path, req.url); assert.equal(saved.challenge.bodyHash, hexDigest(JSON.stringify(input.body)));
      verifyProof(saved.key, saved.challenge, input.signature);
      if (req.url === '/v1/enroll') return reply(200, { ok: true, data: { identity,
        connection: { schema: 'xj-dev/connection-v1', host: 'approved.test', port: 22, browserUser: 'xjd_test', applicationPort: 13444,
          browserOrigin: 'https://localhost:13445', knownHosts, caPem: readFileSync(ca.certFile, 'utf8') },
        account: { loginName: 'synthetic-member', password: randomBytes(24).toString('base64url') } } });
      assert.equal(input.body.deviceId, identity.deviceId); calls.push({ path: req.url, body: input.body });
      if (controls.denied) return reply(403, { ok: false, code: 'CAPABILITY_DENIED', detail: secret });
      const body = input.body; let data;
      const transfer = id => ({ transferId: id, record: records.get(id).record, partSize: PART,
        partCount: Math.ceil(records.get(id).record.bytes / PART), limits: { packageBytes: 134217728, memberBytes: 268435456, teamBytes: 1073741824 } });
      if (req.url === '/v1/packages/upload') {
        let entry = [...records.values()].find(r => r.key === body.idempotencyKey);
        if (!entry) {
          const reproId = 'xjp_' + randomUUID();
          entry = { key: body.idempotencyKey, record: { reproId, publisherId: identity.memberId, digest: body.digest, bytes: body.bytes, crc64: body.crc64,
            formatVersion: body.formatVersion, toolVersion: body.toolVersion, state: 'uploading', createdAt: Date.now(), publishedAt: null } };
          records.set(reproId, entry); uploads.set(reproId, new Map());
        }
        data = transfer(entry.record.reproId);
        if (controls.loseUploadResponse) { controls.loseUploadResponse = false; req.socket.destroy(); return; }
      } else if (req.url === '/v1/packages/upload-status') {
        data = { ...transfer(body.transferId), parts: [...uploads.get(body.transferId).values()].map(({ body, ...part }) => part) };
        if (controls.badPart && data.parts.length) data.parts[0].contentMD5 = 'AAAAAAAAAAAAAAAAAAAAAA==';
      } else if (req.url === '/v1/packages/upload-parts') {
        data = { transferId: body.transferId, parts: body.parts.map(part => ({ ...part, method: 'PUT',
          url: `${endpoint}/objects/${body.transferId}?part=${part.partNumber}&signature=${secret}`, allowedHost: new URL(endpoint).host,
          headers: { host: new URL(endpoint).host, 'content-length': String(part.bytes), 'content-md5': part.contentMD5, 'content-type': 'application/octet-stream' },
          expiresAt: Date.now() + 300000, ...controls.grant })) };
        grants.push(...data.parts.map(p => p.url));
      } else if (req.url === '/v1/packages/complete') {
        const entry = records.get(body.transferId);
        entry.body = Buffer.concat([...uploads.get(body.transferId).values()].sort((a, b) => a.partNumber - b.partNumber).map(p => p.body));
        assert.equal(digest(entry.body), entry.record.digest);
        entry.record.state = 'published'; entry.record.publishedAt = Date.now(); entry.etag = '"opaque-multipart-2"';
        data = { record: entry.record };
        if (controls.loseCompleteResponse) { controls.loseCompleteResponse = false; req.socket.destroy(); return; }
      } else if (req.url === '/v1/packages/resolve') {
        const entry = records.get(body.reproId);
        if (body.etag && body.etag !== entry.etag) return reply(409, { ok: false, code: 'ETAG_CHANGED' });
        data = { record: entry.record, etag: entry.etag, authorization: body.offset === entry.record.bytes ? null : {
          method: 'GET', url: `${endpoint}/objects/${body.reproId}?signature=${secret}`, allowedHost: new URL(endpoint).host,
          headers: { host: new URL(endpoint).host, range: `bytes=${body.offset}-`, 'if-match': entry.etag }, expiresAt: Date.now() + 300000, ...controls.grant } };
        grants.push(data.authorization?.url);
      } else throw new Error('unexpected route');
      reply(200, { ok: true, data });
    } catch (error) { controls.serverError = error; reply(400, { ok: false, code: 'PROOF_INVALID' }); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const endpoint = `https://127.0.0.1:${server.address().port}`, invitationFile = join(root, 'invite.json');
  writePrivateJson(invitationFile, { protocol: ACCESS_PROTOCOL, serviceId, invitationId: randomUUID(), secret, endpoint,
    caPem: readFileSync(ca.certFile, 'utf8'), cloudCaPem: readFileSync(ca.certFile, 'utf8'), sshKnownHosts: knownHosts, expiresAt: Date.now() + 60000 });
  const registration = await joinEnrollment({ home, invitationFile });
  t.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });
  return { root, file, bytes, deviceFile: registration.deviceFile, context: { home, worktree, repo: { teaching: join(worktree, 'apps/teaching') } },
    controls, calls, puts, gets, grants, records, uploads, secret };
}

test('CRC64/XZ uses unsigned decimal BigInt values from official check vectors', () => {
  assert.equal(crc64XZ(Buffer.alloc(0)), '0');
  assert.equal(crc64XZ(Buffer.from('123456789')), '11051210869376104954');
});

test('publishing freezes an inspected ZIP, uses real device proofs and returns a stable ID without signed URLs', async t => {
  const f = await fixture(t);
  const result = await publishFrozen(f.context, { deviceFile: f.deviceFile, file: f.file, expectedDigest: digest(f.bytes) });
  assert.equal(result.state, 'published'); assert.match(result.reproId, /^xjp_/);
  assert.equal(result.digest, digest(f.bytes)); assert.deepEqual(readFileSync(result.file), f.bytes);
  assert.equal(inspectRepro(result.file).verification.reproduction, 'unverified');
  assert.equal(JSON.stringify(result).includes(f.secret), false);
  assert.deepEqual(f.puts, [1]); assert.equal(f.controls.serverError, undefined);
  const repeated = await publishFrozen(f.context, { deviceFile: f.deviceFile, file: f.file, expectedDigest: digest(f.bytes) });
  assert.equal(repeated.reproId, result.reproId); assert.deepEqual(f.puts, [1]);
});

test('a lost upload registration response retries the same idempotency key and frozen content', async t => {
  const f = await fixture(t); f.controls.loseUploadResponse = true;
  await assert.rejects(() => publishFrozen(f.context, { deviceFile: f.deviceFile, file: f.file, expectedDigest: digest(f.bytes) }), { code: 'ACCESS_UNREACHABLE' });
  const result = await publishFrozen(f.context, { deviceFile: f.deviceFile, file: f.file, expectedDigest: digest(f.bytes) });
  assert.equal(result.state, 'published'); assert.equal(f.records.size, 1);
  assert.equal(new Set(f.calls.filter(c => c.path.endsWith('/upload')).map(c => c.body.idempotencyKey)).size, 1);
});

test('a lost PUT response resumes from service-confirmed parts, preserving the original frozen file', async t => {
  const f = await fixture(t); f.controls.losePUTResponse = true;
  await assert.rejects(() => publishFrozen(f.context, { deviceFile: f.deviceFile, file: f.file, expectedDigest: digest(f.bytes) }), { code: 'OBJECT_UNREACHABLE' });
  const transferId = [...f.records.keys()][0];
  writeFileSync(f.file, 'the original scene has since changed');
  const result = await resumeUpload(f.context, { deviceFile: f.deviceFile, transferId });
  assert.equal(result.state, 'published'); assert.deepEqual(f.puts, [1]);
  assert.deepEqual(readFileSync(result.file), f.bytes);
});

test('a lost completion response exposes safe recovery information and reuses the already published record', async t => {
  const f = await fixture(t); f.controls.loseCompleteResponse = true;
  let interrupted;
  await assert.rejects(() => publishFrozen(f.context, { deviceFile: f.deviceFile, file: f.file, expectedDigest: digest(f.bytes) }), error => {
    assert.equal(error.code, 'ACCESS_UNREACHABLE'); interrupted = error.transfer;
    assert.equal(JSON.stringify(error).includes(f.secret), false); return true;
  });
  assert.equal(interrupted.state, 'interrupted'); assert.equal(interrupted.confirmedParts, 1);
  assert.deepEqual(readFileSync(interrupted.file), f.bytes);
  const result = await resumeUpload(f.context, { deviceFile: f.deviceFile, transferId: interrupted.transferId });
  assert.equal(result.state, 'published'); assert.deepEqual(f.puts, [1]); assert.equal(f.records.size, 1);
});

test('a stable idempotency key cannot publish different content; capability denial preserves the frozen file', async t => {
  const f = await fixture(t), key = randomUUID();
  const result = await publishFrozen(f.context, { deviceFile: f.deviceFile, file: f.file, expectedDigest: digest(f.bytes), idempotencyKey: key });
  const changed = makePackage(f.file, { title: 'another frozen scene' }), before = f.calls.length;
  await assert.rejects(() => publishFrozen(f.context, { deviceFile: f.deviceFile, file: f.file, expectedDigest: digest(changed), idempotencyKey: key }), { code: 'UPLOAD_CONFLICT' });
  assert.equal(f.calls.length, before); assert.deepEqual(readFileSync(result.file), f.bytes);
  const denied = await fixture(t); denied.controls.denied = true;
  await assert.rejects(() => publishFrozen(denied.context, { deviceFile: denied.deviceFile, file: denied.file, expectedDigest: digest(denied.bytes) }), error => {
    assert.equal(error.code, 'CAPABILITY_DENIED'); assert.deepEqual(readFileSync(error.transfer.file), denied.bytes);
    assert.equal(JSON.stringify(error).includes(denied.secret), false); return true;
  });
  assert.equal(denied.puts.length, 0);
});

test('expired object authorization is renewed once with fresh device proof; revoked devices cannot use saved state', async t => {
  const f = await fixture(t); f.controls.expiredPUT = 1;
  const result = await publishFrozen(f.context, { deviceFile: f.deviceFile, file: f.file, expectedDigest: digest(f.bytes) });
  assert.deepEqual(f.puts, [1, 1]); assert.equal(result.state, 'published');
  f.controls.revoked = true;
  await assert.rejects(() => resumeUpload(f.context, { deviceFile: f.deviceFile, transferId: result.transferId }), { code: 'DEVICE_REVOKED' });
  assert.deepEqual(readFileSync(result.file), f.bytes);
});

test('download authenticates, verifies complete SHA and compatibility, then authorizes and rechecks each cache hit', async t => {
  const f = await fixture(t);
  const source = await publishFrozen(f.context, { deviceFile: f.deviceFile, file: f.file, expectedDigest: digest(f.bytes) });
  const downloaded = await fetchRepro(f.context, { deviceFile: f.deviceFile, reproId: source.reproId });
  assert.equal(downloaded.state, 'downloaded'); assert.equal(downloaded.cacheHit, false);
  assert.equal(downloaded.restored, false); assert.equal(downloaded.reproduction, 'unverified');
  assert.deepEqual(readFileSync(downloaded.file), f.bytes); assert.deepEqual(f.gets, [{ offset: 0, etag: '"opaque-multipart-2"' }]);
  const reused = await fetchRepro(f.context, { deviceFile: f.deviceFile, reproId: source.reproId });
  assert.equal(reused.cacheHit, true); assert.equal(f.gets.length, 1);
  f.controls.revoked = true;
  await assert.rejects(() => fetchRepro(f.context, { deviceFile: f.deviceFile, reproId: source.reproId }), { code: 'DEVICE_REVOKED' });
  assert.deepEqual(readFileSync(downloaded.file), f.bytes);
});

test('an interrupted download resumes with Range and If-Match from the bytes actually received', async t => {
  const f = await fixture(t), source = await publishFrozen(f.context, { deviceFile: f.deviceFile, file: f.file, expectedDigest: digest(f.bytes) });
  f.controls.interruptGET = true;
  await assert.rejects(() => fetchRepro(f.context, { deviceFile: f.deviceFile, reproId: source.reproId }), { code: 'OBJECT_UNREACHABLE' });
  const result = await fetchRepro(f.context, { deviceFile: f.deviceFile, reproId: source.reproId });
  assert.deepEqual(f.gets.map(g => g.offset), [0, 321]);
  assert.ok(f.gets.every(g => g.etag === '"opaque-multipart-2"')); assert.deepEqual(readFileSync(result.file), f.bytes);
});

test('412 discards the stale partial before one bounded resolve and fresh download', async t => {
  const f = await fixture(t), source = await publishFrozen(f.context, { deviceFile: f.deviceFile, file: f.file, expectedDigest: digest(f.bytes) });
  f.controls.interruptGET = true;
  await assert.rejects(() => fetchRepro(f.context, { deviceFile: f.deviceFile, reproId: source.reproId }));
  f.controls.precondition = 1;
  const result = await fetchRepro(f.context, { deviceFile: f.deviceFile, reproId: source.reproId });
  assert.deepEqual(f.gets.map(g => g.offset), [0, 321, 0]); assert.deepEqual(readFileSync(result.file), f.bytes);
});

test('200, wrong Content-Range and wrong ETag are rejected before appending any body', async t => {
  for (const key of ['fullResponse', 'wrongRange', 'wrongETag']) {
    const f = await fixture(t), source = await publishFrozen(f.context, { deviceFile: f.deviceFile, file: f.file, expectedDigest: digest(f.bytes) });
    f.controls[key] = true;
    await assert.rejects(() => fetchRepro(f.context, { deviceFile: f.deviceFile, reproId: source.reproId }), { code: key === 'fullResponse' ? 'OBJECT_HTTP_FAILED' : 'OBJECT_RANGE_INVALID' });
    f.controls[key] = false;
    const result = await fetchRepro(f.context, { deviceFile: f.deviceFile, reproId: source.reproId });
    assert.deepEqual(f.gets.map(g => g.offset), [0, 0]); assert.deepEqual(readFileSync(result.file), f.bytes);
  }
});

test('corrupt downloaded bytes and a damaged ready cache never become usable packages', async t => {
  const f = await fixture(t), source = await publishFrozen(f.context, { deviceFile: f.deviceFile, file: f.file, expectedDigest: digest(f.bytes) });
  f.controls.corrupt = true;
  await assert.rejects(() => fetchRepro(f.context, { deviceFile: f.deviceFile, reproId: source.reproId }), { code: 'DIGEST_MISMATCH' });
  const g = await fixture(t), published = await publishFrozen(g.context, { deviceFile: g.deviceFile, file: g.file, expectedDigest: digest(g.bytes) });
  const cached = await fetchRepro(g.context, { deviceFile: g.deviceFile, reproId: published.reproId });
  writeFileSync(cached.file, 'damaged cache');
  await assert.rejects(() => fetchRepro(g.context, { deviceFile: g.deviceFile, reproId: published.reproId }), { code: 'DIGEST_MISMATCH' });
  assert.equal(g.gets.length, 1, 'an invalid cache is rejected rather than returned or silently considered verified');
});

test('a competing process cannot operate the same member transfer namespace; the permanent mutex survives release', async t => {
  const f = await fixture(t), source = await publishFrozen(f.context, { deviceFile: f.deviceFile, file: f.file, expectedDigest: digest(f.bytes) });
  let entered, release;
  const pending = new Promise(done => entered = done); f.controls.releaseGET = new Promise(done => release = done);
  f.controls.pauseGET = () => entered();
  const download = fetchRepro(f.context, { deviceFile: f.deviceFile, reproId: source.reproId });
  await pending;
  try {
    await assert.rejects(() => pruneCache(f.context, { reproId: source.reproId }), { code: 'LOCK_HELD' });
    const script = `import {fetchRepro} from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../src/package-transfer.mjs')).href)};
      try {await fetchRepro(JSON.parse(process.argv[1]),JSON.parse(process.argv[2]));process.exitCode=1;} catch(e) {console.log(e.code);}`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(f.context), JSON.stringify({ deviceFile: f.deviceFile, reproId: source.reproId })], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.resume();
    assert.equal(await new Promise(done => child.once('close', done)), 0); assert.equal(output.trim(), 'LOCK_HELD');
  } finally { release(); await download; }
  const namespace = join(f.context.home, 'transfers', readdirSync(join(f.context.home, 'transfers'))[0]);
  assert.ok(lstatSync(join(namespace, 'operation-lock', 'mutex.sqlite')).isFile());
  assert.equal((await fetchRepro(f.context, { deviceFile: f.deviceFile, reproId: source.reproId })).cacheHit, true);
});

test('multipart resumes without repeating confirmed 8MiB content and checks every part MD5 and size', async t => {
  const f = await fixture(t, { large: true }); f.controls.failPart = 2;
  await assert.rejects(() => publishFrozen(f.context, { deviceFile: f.deviceFile, file: f.file, expectedDigest: digest(f.bytes) }), { code: 'OBJECT_UNREACHABLE' });
  const transferId = [...f.records.keys()][0];
  assert.equal(f.uploads.get(transferId).get(1).bytes, 8388608);
  assert.deepEqual(f.puts, [1, 2]); f.controls.failPart = undefined;
  const result = await resumeUpload(f.context, { deviceFile: f.deviceFile, transferId });
  assert.deepEqual(f.puts, [1, 2, 2]); assert.equal(result.confirmedParts, 2);
  const downloaded = await fetchRepro(f.context, { deviceFile: f.deviceFile, reproId: transferId });
  assert.deepEqual(readFileSync(downloaded.file), f.bytes);
});

test('a changed frozen file or service-confirmed MD5 mismatch fails before further upload or publication', async t => {
  const f = await fixture(t); f.controls.losePUTResponse = true;
  await assert.rejects(() => publishFrozen(f.context, { deviceFile: f.deviceFile, file: f.file, expectedDigest: digest(f.bytes) }));
  const transferId = [...f.records.keys()][0]; f.controls.badPart = true;
  await assert.rejects(() => resumeUpload(f.context, { deviceFile: f.deviceFile, transferId }), { code: 'PART_CONFLICT' });
  assert.deepEqual(f.puts, [1]); assert.equal(f.records.get(transferId).record.state, 'uploading');
  f.controls.badPart = false;
  const transfers = join(f.context.home, 'transfers'), namespace = join(transfers, readdirSync(transfers)[0]);
  const uploads = join(namespace, 'uploads'), frozen = join(uploads, readdirSync(uploads)[0], 'frozen.zip');
  writeFileSync(frozen, Buffer.alloc(7)); const before = f.calls.length;
  await assert.rejects(() => resumeUpload(f.context, { deviceFile: f.deviceFile, transferId }), { code: 'FROZEN_FILE_CHANGED' });
  assert.equal(f.calls.length, before); assert.deepEqual(f.puts, [1]);
});

test('wrong digest, malformed ZIP and incompatible manifest fail without being presented as usable', async t => {
  const f = await fixture(t);
  await assert.rejects(() => publishFrozen(f.context, { deviceFile: f.deviceFile, file: f.file, expectedDigest: digest('different') }), { code: 'DIGEST_MISMATCH' });
  writeFileSync(f.file, 'invalid ZIP');
  await assert.rejects(() => publishFrozen(f.context, { deviceFile: f.deviceFile, file: f.file, expectedDigest: digest('invalid ZIP') }), { code: 'INVALID_ZIP' });
  truncateSync(f.file, 128 * 1024 * 1024 + 1);
  await assert.rejects(() => publishFrozen(f.context, { deviceFile: f.deviceFile, file: f.file, expectedDigest: digest('oversize') }), { code: 'PACKAGE_LIMIT' });
  assert.equal(f.calls.length, 0);
  const g = await fixture(t), result = await publishFrozen(g.context, { deviceFile: g.deviceFile, file: g.file, expectedDigest: digest(g.bytes) });
  // An old package can legitimately be catalogued; receiving it must still
  // compare against this machine's actual dependency/schema/tool conditions.
  const oldBytes = makePackage(join(g.root, 'old.zip'), { incompatible: true });
  const entry = g.records.get(result.reproId); entry.body = oldBytes;
  entry.record.digest = digest(oldBytes); entry.record.bytes = oldBytes.length; entry.record.crc64 = crc64XZ(oldBytes);
  await assert.rejects(() => fetchRepro(g.context, { deviceFile: g.deviceFile, reproId: result.reproId }), { code: 'TOOL_VERSION_MISMATCH' });
});

test('authorization rejects unsafe hosts, redirects and unbound headers; expiry retries are bounded and secret-free', async t => {
  for (const change of [{ allowedHost: 'unapproved.test' }, { method: 'POST' }, { headers: { host: 'unapproved.test' } }, { url: 'http://unapproved.test/private' }]) {
    const f = await fixture(t); f.controls.grant = change;
    await assert.rejects(() => publishFrozen(f.context, { deviceFile: f.deviceFile, file: f.file, expectedDigest: digest(f.bytes) }), error => {
      assert.equal(error.code, 'TRANSFER_AUTHORIZATION_INVALID'); assert.equal((error.stack + JSON.stringify(error)).includes(f.secret), false); return true;
    });
    assert.equal(f.puts.length, 0);
  }
  const f = await fixture(t); f.controls.expiredPUT = 100;
  await assert.rejects(() => publishFrozen(f.context, { deviceFile: f.deviceFile, file: f.file, expectedDigest: digest(f.bytes) }), error => {
    assert.equal(error.code, 'URL_EXPIRED'); assert.equal((error.stack + JSON.stringify(error)).includes(f.secret), false); return true;
  });
  assert.deepEqual(f.puts, [1, 1]);
  const redirected = await fixture(t); redirected.controls.redirectPUT = true;
  await assert.rejects(() => publishFrozen(redirected.context, { deviceFile: redirected.deviceFile, file: redirected.file, expectedDigest: digest(redirected.bytes) }), { code: 'OBJECT_HTTP_FAILED' });
  assert.deepEqual(redirected.puts, [1]);
  const scan = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? scan(join(dir, e.name)) : [join(dir, e.name)]);
  for (const file of scan(join(f.context.home, 'transfers'))) {
    assert.equal(readFileSync(file).includes(Buffer.from(f.secret)), false);
    if (process.platform !== 'win32' && /\.(json|zip)$/.test(file)) assert.equal(lstatSync(file).mode & 0o077, 0, file);
  }
});

test('broad permissions and symlinked transfer state are rejected before network or foreign-file changes', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), result = await publishFrozen(f.context, { deviceFile: f.deviceFile, file: f.file, expectedDigest: digest(f.bytes) });
  chmodSync(result.file, 0o644); const before = f.calls.length;
  await assert.rejects(() => resumeUpload(f.context, { deviceFile: f.deviceFile, transferId: result.transferId }), { code: 'PRIVATE_FILE_REQUIRED' });
  assert.equal(f.calls.length, before); chmodSync(result.file, 0o600);
  const outside = join(f.root, 'outside'); writeFileSync(outside, 'must survive', { mode: 0o600 });
  rmSync(result.file); symlinkSync(outside, result.file);
  await assert.rejects(() => resumeUpload(f.context, { deviceFile: f.deviceFile, transferId: result.transferId }), { code: 'PRIVATE_FILE_REQUIRED' });
  assert.equal(readFileSync(outside, 'utf8'), 'must survive'); assert.equal(f.calls.length, before);
});

test('explicit cache deletion reauthorizes and verifies one ready ZIP, preserves frozen uploads and can fetch again', async t => {
  const f = await fixture(t), source = await publishFrozen(f.context, { deviceFile: f.deviceFile, file: f.file, expectedDigest: digest(f.bytes) });
  const cache = await fetchRepro(f.context, { deviceFile: f.deviceFile, reproId: source.reproId });
  const result = await pruneCache(f.context, { reproId: source.reproId });
  assert.equal(result.state, 'cache-deleted'); assert.equal(result.removedBytes, f.bytes.length);
  assert.equal(existsSync(cache.file), false); assert.deepEqual(readFileSync(source.file), f.bytes);
  const mutex = join(dirname(dirname(dirname(cache.file))), 'operation-lock', 'mutex.sqlite');
  assert.ok(lstatSync(mutex).isFile());
  assert.equal(JSON.stringify(result).includes(f.secret), false);
  const again = await fetchRepro(f.context, { deviceFile: f.deviceFile, reproId: source.reproId });
  assert.deepEqual(readFileSync(again.file), f.bytes); assert.equal(f.gets.length, 2);
});

test('cache deletion preserves revoked, corrupt, partial and unknown local contents', async t => {
  const f = await fixture(t), source = await publishFrozen(f.context, { deviceFile: f.deviceFile, file: f.file, expectedDigest: digest(f.bytes) });
  const cache = await fetchRepro(f.context, { deviceFile: f.deviceFile, reproId: source.reproId });
  f.controls.revoked = true;
  await assert.rejects(() => pruneCache(f.context, { reproId: source.reproId }), { code: 'DEVICE_REVOKED' });
  assert.deepEqual(readFileSync(cache.file), f.bytes); f.controls.revoked = false;
  const unknown = join(dirname(cache.file), 'keep-this-note'); writeFileSync(unknown, 'unknown user data');
  await assert.rejects(() => pruneCache(f.context, { reproId: source.reproId }), { code: 'CACHE_UNSAFE' });
  assert.equal(readFileSync(unknown, 'utf8'), 'unknown user data'); assert.deepEqual(readFileSync(cache.file), f.bytes); rmSync(unknown);
  const partial = join(dirname(cache.file), 'partial.zip'); writeFileSync(partial, f.bytes.subarray(0, 321), { mode: 0o600 });
  await assert.rejects(() => pruneCache(f.context, { reproId: source.reproId }), { code: 'CACHE_IN_USE' });
  assert.equal(readFileSync(partial).length, 321); assert.deepEqual(readFileSync(cache.file), f.bytes); rmSync(partial);
  writeFileSync(cache.file, 'damaged but retained');
  await assert.rejects(() => pruneCache(f.context, { reproId: source.reproId }), { code: 'DIGEST_MISMATCH' });
  assert.equal(readFileSync(cache.file, 'utf8'), 'damaged but retained'); assert.deepEqual(readFileSync(source.file), f.bytes);
});

test('deleting one stable ID preserves a shared digest still referenced by another ID', async t => {
  const f = await fixture(t), first = await publishFrozen(f.context, { deviceFile: f.deviceFile, file: f.file, expectedDigest: digest(f.bytes) });
  const second = await publishFrozen(f.context, { deviceFile: f.deviceFile, file: f.file, expectedDigest: digest(f.bytes), idempotencyKey: randomUUID() });
  assert.notEqual(first.reproId, second.reproId);
  const cache = await fetchRepro(f.context, { deviceFile: f.deviceFile, reproId: first.reproId });
  await fetchRepro(f.context, { deviceFile: f.deviceFile, reproId: second.reproId });
  const result = await pruneCache(f.context, { reproId: first.reproId });
  assert.equal(result.retainedShared, true); assert.equal(result.removedBytes, 0); assert.deepEqual(readFileSync(cache.file), f.bytes);
  assert.equal((await fetchRepro(f.context, { deviceFile: f.deviceFile, reproId: second.reproId })).cacheHit, true);
  const last = await pruneCache(f.context, { reproId: second.reproId });
  assert.equal(last.removedBytes, f.bytes.length); assert.equal(existsSync(cache.file), false);
  assert.deepEqual(readFileSync(first.file), f.bytes); assert.deepEqual(readFileSync(second.file), f.bytes);
});
