import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { digest, signProof } from '../xj-dev/src/enrollment-protocol.mjs';
import { openAccessStore } from './store.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'xj-enroll-'));
  const keys = [join(root, 'one'), join(root, 'two')];
  for (const key of keys) execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key], { stdio: 'ignore' });
  const keyFile = join(root, 'credential.key'); writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
  let clock = Date.now();
  const store = openAccessStore(join(root, 'access.sqlite'), keyFile, 'test-access-service', () => clock);
  const invite = options => store.createInvitation({ label: 'test member', teamRole: 'developer', appRole: 'student', courseId: 'synthetic-course', ttlSeconds: 60, capabilities: ['page'], ...options });
  const proof = (invitation, index = 0, path = '/v1/enroll', body = { invitationSecret: invitation.secret }) => {
    const challenge = store.issueChallenge({ publicKey: readFileSync(keys[index] + '.pub', 'utf8'), invitationSecret: invitation.secret, method: 'POST', path, bodyHash: digest(JSON.stringify(body)) });
    return { challengeId: challenge.challengeId, signature: signProof(keys[index], challenge), body };
  };
  return { root, store, keys, invite, proof, advance: ms => { clock += ms; }, close() { store.close(); rmSync(root, { force: true, recursive: true }); } };
}

test('first valid key binds one device; same-key recovery is idempotent and proof replay is rejected', () => {
  const f = fixture();
  try {
    const i = f.invite(), p = f.proof(i), d = f.store.authenticateProof(p, '/v1/enroll');
    assert.throws(() => f.store.authenticateProof(p, '/v1/enroll'), { code: 'PROOF_EXPIRED_OR_REPLAYED' });
    const recovered = f.store.authenticateProof(f.proof(i), '/v1/enroll');
    assert.equal(recovered.id, d.id);
    assert.equal(f.store.inspect().devices.length, 1);
    assert.equal(f.store.inspect().members.length, 1);
    assert.throws(() => f.proof(i, 1), { code: 'INVITATION_KEY_MISMATCH' });
    f.store.stage(d.id, 'ssh_ready'); f.store.stage(d.id, 'app_ready'); f.store.activate(d.id);
    assert.equal(f.store.device(d.id).state, 'active');
  } finally { f.close(); }
});

test('proof binds method/path/body and TTL; an invalid proof never consumes the invitation', () => {
  const f = fixture();
  try {
    const i = f.invite(), p = f.proof(i);
    assert.throws(() => f.store.authenticateProof({ ...p, body: { unrelated: true } }, '/v1/enroll'), { code: 'PROOF_EXPIRED_OR_REPLAYED' });
    assert.throws(() => f.store.authenticateProof(p, '/v1/config'), { code: 'PROOF_EXPIRED_OR_REPLAYED' });
    const expired = f.proof(i); f.advance(61000);
    assert.throws(() => f.store.authenticateProof(expired, '/v1/enroll'), { code: 'PROOF_EXPIRED_OR_REPLAYED' });
    assert.throws(() => f.proof(i), { code: 'INVITATION_EXPIRED' });
    assert.equal(f.store.inspect().devices.length, 0);
  } finally { f.close(); }
});

test('device/member deny persists before cleanup; other devices remain active and credentials stay private', () => {
  const f = fixture();
  try {
    const a = f.invite(), b = f.invite({ memberId: a.memberId });
    const da = f.store.authenticateProof(f.proof(a), '/v1/enroll'), db = f.store.authenticateProof(f.proof(b, 1), '/v1/enroll');
    f.store.denyDevice(da.id);
    assert.throws(() => f.store.identity(da.id), { code: 'DEVICE_REVOKED' });
    assert.equal(f.store.identity(db.id).memberId, a.memberId);
    assert.equal(JSON.stringify(f.store.inspect()).includes(f.store.credentials(a.memberId).password), false);
    f.store.denyMember(a.memberId);
    assert.throws(() => f.store.identity(db.id), { code: 'DEVICE_REVOKED' });
    assert.equal(f.store.inspect().devices.length, 2, 'retained records are not deleted');
  } finally { f.close(); }
});
