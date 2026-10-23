import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ensureBaseline } from '../src/baseline.mjs';
import { environmentPaths } from '../src/paths.mjs';
import { openApplicationDatabase } from '../../../apps/teaching/server/db/transaction.ts';
import { createDigitalLogicApplication } from '../../../apps/teaching/server/app/digital-logic.ts';
import { runtime } from '../../../apps/teaching/tests/dl-a-support.ts';

const teaching = fileURLToPath(new URL('../../../apps/teaching', import.meta.url));
const baselineUrl = new URL('../src/baseline.mjs', import.meta.url).href;
const origin = 'https://synthetic.example';
const injection = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const paths = JSON.parse(process.env.XJ_TEST_BASELINE_PATHS);
const mode = process.env.XJ_TEST_BASELINE_FAULT;
const rename = fs.renameSync, write = fs.writeFileSync;
fs.renameSync = (from, to, ...rest) => {
  const result = rename(from, to, ...rest);
  if ((mode === 'after-database' && to === paths.database)
    || (mode === 'after-credentials' && to === paths.baselineCredentials)
    || (mode === 'after-marker' && to === paths.baselineFile)) process.exit(86);
  return result;
};
fs.writeFileSync = (file, ...rest) => {
  if (mode === 'credentials-enospc' && file === paths.baselineCredentials + '.tmp') {
    throw Object.assign(new Error('injected ENOSPC'), { code: 'ENOSPC' });
  }
  return write(file, ...rest);
};
syncBuiltinESMExports();
const { ensureBaseline } = await import(${JSON.stringify(baselineUrl)});
try {
  await ensureBaseline(process.env.XJ_TEST_TEACHING, paths, () => {});
  process.stdout.write('complete');
} catch (error) {
  process.stdout.write(error.code ?? 'unexpected');
  process.exitCode = 87;
}
`;

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'xj-baseline-recovery-'));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return environmentPaths(home, 'baseline-recovery');
}

function interrupt(paths, fault) {
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', injection], {
    env: { ...process.env, XJ_TEST_BASELINE_PATHS: JSON.stringify(paths), XJ_TEST_BASELINE_FAULT: fault, XJ_TEST_TEACHING: teaching },
    encoding: 'utf8', timeout: 90_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, fault === 'credentials-enospc' ? 87 : 86, 'fault reached actual filesystem publication');
  if (fault === 'credentials-enospc') assert.equal(result.stdout, 'BASELINE_FAILED');
}

async function assertLogin(paths) {
  const credentials = JSON.parse(readFileSync(paths.baselineCredentials, 'utf8'));
  const db = openApplicationDatabase(paths.database);
  let service;
  try {
    service = await createDigitalLogicApplication({
      db, origin, signingSecret: randomBytes(48).toString('hex'), approvedHdlRuntimes: [runtime], executionNodes: [],
      review: { versions: { modelConfigVersion: 'unconfigured', promptVersion: 'unconfigured', schemaVersion: 'unconfigured', analysisVersion: 'learner-analysis-v1' } },
    });
    for (const { loginName, password } of credentials) {
      const response = await service.app.inject({ method: 'POST', url: '/api/sessions', headers: { origin }, payload: { loginName, password } });
      assert.equal(response.statusCode, 200, 'persisted account can really log in');
      assert.ok(response.cookies.some(cookie => cookie.value), 'login establishes a session');
    }
  } finally {
    if (service) await service.shutdown();
    db.close();
  }
}

test('process death immediately after DB publication leaves complete usable login material', async t => {
  const paths = fixture(t);
  interrupt(paths, 'after-database');
  assert.ok(existsSync(paths.database));
  assert.ok(existsSync(paths.baselineCredentials), 'published DB must never lack random passwords');
  const credentials = readFileSync(paths.baselineCredentials);
  assert.equal((await ensureBaseline(teaching, paths, () => {})).created, false);
  assert.ok(readFileSync(paths.baselineCredentials).equals(credentials), 'retry never resets published credentials');
  await assertLogin(paths);
});

test('credential ENOSPC publishes no DB; retry seeds an actually login-capable baseline', async t => {
  const paths = fixture(t);
  interrupt(paths, 'credentials-enospc');
  assert.equal(existsSync(paths.database), false, 'failed secret persistence cannot publish a database');
  assert.equal((await ensureBaseline(teaching, paths, () => {})).created, true);
  await assertLogin(paths);
});

for (const boundary of ['after-credentials', 'after-marker']) {
  test(`process death ${boundary} resumes with the same persisted credentials`, async t => {
    const paths = fixture(t);
    interrupt(paths, boundary);
    assert.equal(existsSync(paths.database), false);
    const credentials = readFileSync(paths.baselineCredentials);
    assert.equal((await ensureBaseline(teaching, paths, () => {})).created, true);
    assert.ok(readFileSync(paths.baselineCredentials).equals(credentials), 'interrupted initialization reuses its passwords');
    await assertLogin(paths);
  });
}

test('existing business DB with missing/corrupt/mismatched material fails closed without reset', async t => {
  const paths = fixture(t);
  await ensureBaseline(teaching, paths, () => {});
  await assertLogin(paths);
  const used = openApplicationDatabase(paths.database);
  try { used.withTransaction(tx => tx.run('UPDATE courses SET name=? WHERE id=?', 'Work preserved after login', 'synthetic-textscope-c')); }
  finally { used.close(); }
  const marker = readFileSync(paths.baselineFile), credentials = readFileSync(paths.baselineCredentials);
  const database = readFileSync(paths.database);
  const expectPreservedFailure = async () => {
    await assert.rejects(ensureBaseline(teaching, paths, () => {}), error => error.stage === 'baseline' && /BASELINE_/.test(error.code));
    assert.ok(readFileSync(paths.database).equals(database), 'business database is untouched');
  };
  rmSync(paths.baselineCredentials);
  await expectPreservedFailure();
  assert.equal(existsSync(paths.baselineCredentials), false);
  writeFileSync(paths.baselineCredentials, '{', { mode: 0o600 });
  await expectPreservedFailure();
  assert.equal(readFileSync(paths.baselineCredentials, 'utf8'), '{');
  const mismatched = JSON.parse(credentials);
  mismatched.pop();
  writeFileSync(paths.baselineCredentials, JSON.stringify(mismatched));
  await expectPreservedFailure();
  writeFileSync(paths.baselineCredentials, credentials);
  rmSync(paths.baselineFile);
  await expectPreservedFailure();
  assert.equal(existsSync(paths.baselineFile), false);
  writeFileSync(paths.baselineFile, '{');
  await expectPreservedFailure();
  writeFileSync(paths.baselineFile, marker);
  assert.equal((await ensureBaseline(teaching, paths, () => {})).created, false);
  await assertLogin(paths);
});

test('existing restored baseline keeps its own version/account metadata and credentials', async t => {
  const paths = fixture(t);
  await ensureBaseline(teaching, paths, () => {});
  const marker = JSON.parse(readFileSync(paths.baselineFile, 'utf8'));
  marker.version = 'repro-v1'; marker.source = 'repro-package';
  marker.accounts = marker.accounts.map((account, index) => ({ ...account, id: `restored-${index}`, loginName: `restored-${account.role}` }));
  const restoredCredentials = JSON.parse(readFileSync(paths.baselineCredentials, 'utf8'));
  const db = openApplicationDatabase(paths.database);
  try {
    db.withTransaction(tx => {
      for (const account of restoredCredentials) {
        const loginName = `restored-${account.role}`;
        tx.run('UPDATE users SET login_name=? WHERE login_name=?', loginName, account.loginName);
        account.loginName = loginName;
      }
    });
  } finally { db.close(); }
  writeFileSync(paths.baselineCredentials, JSON.stringify(restoredCredentials), { mode: 0o600 });
  writeFileSync(paths.baselineFile, JSON.stringify(marker));
  const credentials = readFileSync(paths.baselineCredentials), database = readFileSync(paths.database);
  assert.deepEqual(await ensureBaseline(teaching, paths, () => {}), { created: false, version: 'repro-v1' });
  assert.ok(readFileSync(paths.database).equals(database));
  assert.ok(readFileSync(paths.baselineCredentials).equals(credentials));
  await assertLogin(paths);
});
