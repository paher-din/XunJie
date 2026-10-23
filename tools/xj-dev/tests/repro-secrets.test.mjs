import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { ensureBaseline } from '../src/baseline.mjs';
import { decodeZip } from '../src/repro-archive.mjs';
import { assertShareable, collectCode, git, LOCKFILES } from '../src/repro-code.mjs';
import { databaseDriver } from '../src/repro-data.mjs';
import { captureRepro } from '../src/repro.mjs';
import { environmentPaths } from '../src/paths.mjs';

const worktree = resolve(import.meta.dirname, '../../..');
const opaque = () => randomBytes(24).toString('base64url');
const invitation = secret => ({ protocol: 'xj-dev/access-v1', serviceId: 'development', endpoint: 'https://invalid.example', secret });
const url = params => 'https://invalid.example/object?' + new URLSearchParams(params);
const materials = () => [
  ['invitation envelope', JSON.stringify(invitation(opaque()))],
  ['enrollment proof', JSON.stringify({ body: { invitationSecret: opaque() } })],
  ['OSS V4 URL', url({ 'x-oss-signature': randomBytes(32).toString('hex') })],
  ['OSS V1 URL', url({ OSSAccessKeyId: 'STS.' + opaque(), Expires: '4102444800', Signature: randomBytes(20).toString('base64') })],
  ['OSS temporary credential', url({ 'security-token': randomBytes(128).toString('base64') })],
];

function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), 'xj-repro-secrets-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  return root;
}
function rejectsSecret(value) {
  assert.throws(() => assertShareable(value), error => error.code === 'SECRET_DETECTED' && !error.message.includes(value));
}

test('access invitation envelopes reject secret literals regardless of order, nesting or surrounding text', () => {
  const secret = opaque();
  for (const value of [
    JSON.stringify(invitation(secret)),
    JSON.stringify({ secret, metadata: { description: 'public information' }, protocol: 'xj-dev/access-v1' }, null, 2),
    JSON.stringify({ attachments: [invitation(secret)] }),
    'received invitation: ' + JSON.stringify(invitation(secret)),
    'export const invite = ' + JSON.stringify(invitation(secret)) + ';',
  ]) rejectsSecret(value);
});

test('named invitation secrets are rejected in JSON, proof bodies and source assignments', () => {
  const secret = opaque();
  for (const value of [
    JSON.stringify({ invitationSecret: secret }),
    JSON.stringify({ body: { invitationSecret: secret } }),
    ['const invitationSecret', ' = ', JSON.stringify(secret), ';'].join(''),
    JSON.stringify({ invitation_secret: secret }),
    JSON.stringify({ 'invitation-secret': secret }),
  ]) rejectsSecret(value);
});

test('OSS V4 signed URLs reject decoded, reordered and repeated signature parameters', () => {
  const signature = randomBytes(32).toString('hex');
  for (const value of [
    url({ 'x-oss-signature': signature }),
    url({ 'x-oss-date': '20261023T000000Z', 'x-oss-signature-version': 'OSS4-HMAC-SHA256', 'x-oss-signature': signature }),
    'GET /object?%78-oss-signature=' + signature + ' HTTP/1.1',
    url({ 'x-oss-signature': 'invalid-signature' }) + '&x-oss-signature=' + signature,
    JSON.stringify({ download: url({ 'x-oss-signature': signature }) }),
  ]) rejectsSecret(value);
});

test('traditional OSS signatures require the OSS access key in the same query', () => {
  const params = { OSSAccessKeyId: 'STS.' + opaque(), Signature: randomBytes(20).toString('base64'), Expires: '4102444800' };
  for (const value of [
    url(params),
    url({ Signature: params.Signature, Expires: params.Expires, OSSAccessKeyId: params.OSSAccessKeyId }),
    url(params).replaceAll('&', '&amp;'),
    'GET /object?' + new URLSearchParams(params) + ' HTTP/1.1',
  ]) rejectsSecret(value);
  assert.doesNotThrow(() => assertShareable(url({ Signature: params.Signature })));
  assert.doesNotThrow(() => assertShareable(url({ OSSAccessKeyId: params.OSSAccessKeyId })));
  assert.doesNotThrow(() => assertShareable(url({ Signature: params.Signature }) + '\n' + url({ OSSAccessKeyId: params.OSSAccessKeyId })));
});

test('OSS STS credentials are rejected in both URL versions and named request headers', () => {
  const token = randomBytes(128).toString('base64');
  for (const name of ['security-token', 'x-oss-security-token']) {
    rejectsSecret(url({ [name]: token }));
    rejectsSecret(JSON.stringify({ headers: { [name]: token } }));
    rejectsSecret(`${name}: ${token}\r\n`);
  }
});

test('public metadata, unrelated secret descriptions and explicitly invalid fixtures remain shareable', () => {
  for (const fixture of ['invalid-invitation', 'test-secret', 'synthetic-secret', 'placeholder', 'changeme', 'prep-only-not-a-real-secret']) {
    for (const value of [
      JSON.stringify(invitation(fixture)),
      JSON.stringify({ invitationSecret: fixture }),
      url({ 'x-oss-signature': fixture }),
      url({ OSSAccessKeyId: 'test-access-key', Signature: fixture }),
      url({ 'security-token': fixture, 'x-oss-security-token': fixture }),
    ]) assert.doesNotThrow(() => assertShareable(value));
  }
  for (const value of [
    JSON.stringify({ protocol: 'xj-dev/access-v1', serviceId: opaque(), endpoint: 'https://invalid.example' }),
    JSON.stringify({ protocol: 'ordinary-protocol', secret: 'the secret to learning is practice' }),
    JSON.stringify({ metadata: { protocol: 'xj-dev/access-v1' }, secret: 'the secret to learning is practice' }),
    'invitationSecret is a request field; x-oss-signature and security-token are OSS parameter names.',
    'export const invitationSecret = input.invitationSecret; export const invite = { protocol: ACCESS_PROTOCOL, secret };',
    url({ 'x-oss-signature-version': 'OSS4-HMAC-SHA256', 'x-oss-expires': '60', source: 'course material' }),
  ]) assert.doesNotThrow(() => assertShareable(value));
});

test('capture rejects new private material in committed source, selected overlays, assets and evidence without publishing a ZIP', async t => {
  const root = scratch(t), repo = join(root, 'repo'); mkdirSync(repo);
  git(repo, ['init', '-q']);
  for (const path of LOCKFILES) {
    mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), '{}\n');
  }
  const materialPath = 'handoff/arbitrary-name.txt'; mkdirSync(join(repo, 'handoff'));
  git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'safe source']);
  const teaching = join(worktree, 'apps/teaching'), env = environmentPaths(join(root, 'home'), 'private-material');
  await ensureBaseline(teaching, env, () => {});
  const Driver = databaseDriver(teaching), db = new Driver(env.database);
  let attempt;
  try { attempt = db.prepare("SELECT attempt_id FROM attempts WHERE course_id='synthetic-textscope-c'").get().attempt_id; }
  finally { db.close(); }
  const context = { worktree: repo, env, repo: { teaching } };
  const spec = {
    formatVersion: 'xj-repro-context/1', code: { roots: LOCKFILES },
    data: { scope: { courseIds: ['synthetic-textscope-c'], userIds: ['synthetic-teacher', 'synthetic-student'], attemptIds: [attempt] } },
    scenario: { title: 'private material guard', start: 'before-trigger', steps: ['manual inspection'], expected: 'private material excluded', observed: 'capture rejects credentials' },
  };
  const contextFile = join(root, 'context.json'), out = join(root, 'scene.zip');
  for (const [label, value] of materials()) {
    for (const boundary of ['committed source', 'selected overlay', 'assets', 'evidence']) await t.test(`${label}: ${boundary}`, async () => {
      writeFileSync(join(repo, materialPath), value);
      const request = structuredClone(spec);
      if (boundary === 'committed source') {
        git(repo, ['add', materialPath]); git(repo, ['commit', '-qm', 'selected material']);
        request.code.roots.push(materialPath);
      } else if (boundary === 'selected overlay') {
        request.code.roots.push(materialPath); request.code.paths = [materialPath];
      } else request[boundary] = [{ path: materialPath }];
      writeFileSync(contextFile, JSON.stringify(request));
      try {
        await assert.rejects(() => captureRepro(context, { contextFile, out }), { code: 'SECRET_DETECTED' });
        assert.equal(existsSync(out), false, 'a rejected request must not publish an archive');
      } finally {
        rmSync(out, { force: true });
        if (boundary === 'committed source') {
          git(repo, ['rm', '--cached', materialPath]); git(repo, ['commit', '-qm', 'unselect material']);
        }
      }
    });
  }
  // The same public capture entry point must accept safe source and attachments.
  const safe = JSON.stringify({ fixture: invitation('invalid-invitation'), source: { protocol: 'xj-dev/access-v1', serviceId: 'development' } });
  writeFileSync(join(repo, materialPath), safe);
  writeFileSync(contextFile, JSON.stringify({ ...spec, code: { roots: [...LOCKFILES, materialPath], paths: [materialPath] }, assets: [{ path: materialPath }], evidence: [{ path: materialPath }] }));
  // The committed snapshot is checked before overlays, so replace its private fixture too.
  git(repo, ['add', materialPath]); git(repo, ['commit', '-qm', 'safe fixture']);
  const captured = await captureRepro(context, { contextFile, out });
  assert.equal(captured.verification.generated, true);
  const entries = decodeZip(readFileSync(out));
  assert.ok(entries.get('assets/' + materialPath).equals(Buffer.from(safe)));
  assert.ok(entries.get('evidence/' + materialPath).equals(Buffer.from(safe)));
});

test('the current source snapshot including the new guard and runtime-generated tests remains collectable', t => {
  const code = collectCode(worktree, scratch(t), { paths: ['tools/xj-dev/src/repro-code.mjs', 'tools/xj-dev/tests/repro-secrets.test.mjs'] });
  assert.ok(code.manifest.files.length > 500);
  assert.ok(code.sourceFiles.has('tools/xj-dev/src/repro-code.mjs'));
  assert.ok(code.sourceFiles.has('tools/xj-dev/tests/repro-secrets.test.mjs'));
});
