import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLocalAccountControl } from '../server/access/account-control.ts';
import { createPasswordRecord } from '../server/access/password.ts';
import { createDigitalLogicApplication } from '../server/app/digital-logic.ts';
import { createDigitalLogicApplicationDatabase } from '../server/db/transaction.ts';
import { runtime } from './dl-a-support.ts';

test('optional local account control grants one identity, revokes existing sessions, preserves the original account and normal startup', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'xac-'))), socketPath = join(directory, 's');
  const configurationFile = join(directory, 'control.json'), stateFile = join(directory, 'policy.json');
  writeFileSync(configurationFile, JSON.stringify({ socketPath, stateFile, accountPrefix: 'managed-', courseIds: ['course'] }), { mode: 0o600 });
  const db = createDigitalLogicApplicationDatabase(), password = randomBytes(36).toString('base64url'), record = await createPasswordRecord(password);
  db.withTransaction(tx => {
    tx.run('INSERT INTO users(id,login_name,password_hash,salt,algorithm,n,r,p,key_length) VALUES (?,?,?,?,?,?,?,?,?)', 'base', 'base', record.hash, record.salt, 'scrypt', 131072, 8, 1, 64);
    tx.run("INSERT INTO courses(id) VALUES ('course')");
    tx.run("INSERT INTO course_memberships(course_id,user_id,role,active) VALUES ('course','base','teacher',1)");
    tx.run("INSERT INTO application_control(singleton,recovery_generation,control_revision,initialized_at_ms) VALUES (1,'generation',1,?)", Date.now());
  });
  const options = { db, origin: 'https://account-control.example', signingSecret: randomBytes(40).toString('hex'),
    executionNodes: [], approvedHdlRuntimes: [runtime], allowedLoginUserIds: ['base'],
    studentHelp: { versions: { modelConfig: 'disabled', prompt: 'disabled', schema: 'disabled', policy: 'disabled' }, budgetAvailable: () => false } };
  const control = await createLocalAccountControl(configurationFile, { db, staticAllowed: ['base'] });
  let service = await createDigitalLogicApplication({ ...options, loginAuthorization: control.loginAuthorization });
  const call = (operation: string, body: unknown) => new Promise<{ status: number; data: unknown }>((accept, reject) => {
    const req = request({ socketPath, path: '/' + operation, method: 'POST' }, res => {
      let text = ''; res.on('data', bytes => { text += bytes; }); res.on('end', () => accept({ status: res.statusCode!, data: JSON.parse(text) }));
    }); req.on('error', reject); req.end(JSON.stringify(body));
  });
  const login = (loginName: string, supplied: string) => service.app.inject({ method: 'POST', url: '/api/sessions', headers: { origin: options.origin }, payload: { loginName, password: supplied } });
  const sessionCookie = (response: Awaited<ReturnType<typeof login>>) => response.cookies.filter(cookie => cookie.value).map(cookie => `${cookie.name}=${encodeURIComponent(cookie.value)}`).join('; ');
  try {
    await control.listen(service);
    const baseSession = await login('base', password); assert.equal(baseSession.statusCode, 200);
    const externalId = randomUUID(), loginName = 'managed-' + externalId, supplied = randomBytes(36).toString('base64url');
    const input = { externalId, loginName, password: supplied, courseId: 'course', role: 'student' };
    assert.equal((await login(loginName, supplied)).statusCode, 401);
    assert.equal((await call('ensure', input)).status, 200);
    assert.equal((await call('ensure', input)).status, 200);
    assert.equal(db.withTransaction(tx => Number(tx.get('SELECT count(*) AS n FROM users')!.n)), 2);
    const managedSession = await login(loginName, supplied); assert.equal(managedSession.statusCode, 200);
    const cookie = sessionCookie(managedSession);
    const view = await service.app.inject({ url: '/api/session', headers: { cookie } });
    assert.equal(view.statusCode, 200); assert.equal(view.json().data.courses[0].role, 'student');
    assert.equal(readFileSync(stateFile, 'utf8').includes(supplied), false);
    assert.equal((await call('ensure', { ...input, courseId: 'unapproved' })).status, 403);
    assert.equal((await call('disable', { externalId })).status, 200);
    const disabledAt = db.withTransaction(tx => tx.get('SELECT disabled_at_ms FROM users WHERE id=?', loginName)!.disabled_at_ms);
    assert.equal((await service.app.inject({ url: '/api/session', headers: { cookie } })).statusCode, 401);
    assert.equal((await login(loginName, supplied)).statusCode, 401);
    assert.equal((await call('disable', { externalId })).status, 200);
    assert.equal(db.withTransaction(tx => tx.get('SELECT disabled_at_ms FROM users WHERE id=?', loginName)!.disabled_at_ms), disabledAt);
    assert.equal((await service.app.inject({ url: '/api/session', headers: { cookie: sessionCookie(baseSession) } })).statusCode, 200);
    await control.close(); await service.shutdown();
    // Normal startup has no control socket/config, service or device dependency.
    rmSync(configurationFile); rmSync(stateFile);
    service = await createDigitalLogicApplication(options);
    assert.equal((await login('base', password)).statusCode, 200);
  } finally { await control.close(); await service.shutdown(); db.close(); rmSync(directory, { recursive: true, force: true }); }
});
