import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, syntheticProfile } from '../workspace/test-support.ts';
import { createI0App } from './i0.ts';
import type { SyntheticDatabase } from '../db/transaction.ts';
import type { RunnerTransport } from '../records/runner.ts';

function readyResponse(generation = 'generation') {
  const fingerprint = { profile: syntheticProfile, sourceHash: 'd'.repeat(64) };
  return { data: { ready: true, ...syntheticProfile, recoveryGeneration: generation, fingerprint,
    validation: { passed: true, fingerprintHash: createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex'),
      validatedAt: new Date().toISOString() } } };
}
async function untilReady(service: Awaited<ReturnType<typeof createI0App>>) {
  for (let i = 0; i < 80; i++) {
    const response = await service.app.inject({ url: '/health/ready' });
    if (response.statusCode === 200) return response;
    await delay(10);
  }
  assert.fail('Healthy host did not become ready');
}
function options(f: Awaited<ReturnType<typeof fixture>>, runner: RunnerTransport, db = f.db) {
  return { db, origin: 'https://synthetic.example', signingSecret: f.signingSecret,
    currentGeneration: f.generation, now: f.timestamp, runner, consumerIntervalMs: 50 };
}

test('host readiness requires the original consumer and a current database/runner, without creating business rows', async () => {
  let probes = 0;
  const f = await fixture();
  const service = await createI0App(options(f, async () => { probes++; return readyResponse(); }));
  try {
    assert.equal((await service.app.inject({ url: '/health/ready' })).statusCode, 503);
    assert.equal(probes, 0);
    service.startConsumer();
    const response = await untilReady(service);
    assert.deepEqual(response.json().data, { status: 'ready' });
    assert.equal(response.headers['x-request-id'], response.json().requestId);
    assert.equal(response.headers['cache-control'], 'no-store');
    for (const table of ['jobs', 'audit_events', 'command_receipts', 'attempts', 'sessions']) {
      assert.equal(f.db.withTransaction(tx => tx.get(`SELECT COUNT(*) AS n FROM ${table}`)!.n), 0);
    }
    assert.ok(probes > 0);
  } finally { await service.close(); await f.close(); }
});

test('host readiness rejects missing, unavailable, unvalidated and wrong-generation execution dependencies', async () => {
  const f = await fixture();
  let response: unknown = readyResponse();
  let offline = false;
  const service = await createI0App(options(f, async () => {
    if (offline) throw new Error('SYNTHETIC_PRIVATE_CONNECTION');
    return response;
  }));
  try {
    service.startConsumer(); await untilReady(service);
    const badHash = readyResponse(); badHash.data.validation.fingerprintHash = '0'.repeat(64);
    const future = readyResponse(); future.data.validation.validatedAt = new Date(Date.now() + 60000).toISOString();
    const profileMismatch = readyResponse(); profileMismatch.data.runtimeProfileVersion = 'wrong-profile';
    for (const bad of [null, { data: { ready: false } }, badHash, future, profileMismatch, readyResponse('old-generation')]) {
      response = bad;
      assert.equal((await service.app.inject({ url: '/health/ready' })).statusCode, 503);
    }
    offline = true;
    const failed = await service.app.inject({ url: '/health/ready' });
    assert.equal(failed.statusCode, 503);
    assert.doesNotMatch(failed.body, /SYNTHETIC_PRIVATE_CONNECTION|sourceHash|fingerprint/);
    offline = false; response = readyResponse(); await untilReady(service);
    const missing = await createI0App({ db: f.db, origin: 'https://synthetic.example', signingSecret: f.signingSecret,
      currentGeneration: f.generation, consumerIntervalMs: 50 });
    try {
      missing.startConsumer(); await delay(20);
      assert.equal((await missing.app.inject({ url: '/health/ready' })).statusCode, 503);
    } finally { await missing.close(); }
  } finally { await service.close(); await f.close(); }
});

test('host readiness detects database and consumer scan failure and resumes after successful scans', async () => {
  const f = await fixture(); let databaseFailed = false, scanFailed = false;
  const db: SyntheticDatabase = { ...f.db, withTransaction(work) {
    if (databaseFailed) throw new Error('SYNTHETIC_PRIVATE_DATABASE');
    return f.db.withTransaction(tx => work({ ...tx, all(sql, ...args) {
      if (scanFailed && sql.includes('FROM jobs')) throw new Error('Synthetic scan unavailable');
      return tx.all(sql, ...args);
    } }));
  } };
  const service = await createI0App(options(f, async () => readyResponse(), db));
  try {
    service.startConsumer(); await untilReady(service);
    databaseFailed = true;
    const failed = await service.app.inject({ url: '/health/ready' });
    assert.equal(failed.statusCode, 503);
    assert.doesNotMatch(failed.body, /SYNTHETIC_PRIVATE_DATABASE/);
    databaseFailed = false; await untilReady(service);
    scanFailed = true; await delay(120);
    assert.equal((await service.app.inject({ url: '/health/ready' })).statusCode, 503);
    scanFailed = false; await untilReady(service);
  } finally { databaseFailed = false; scanFailed = false; await service.close(); await f.close(); }
});

test('a delayed readiness response cannot succeed after shutdown or database failure', async () => {
  for (const stop of [true, false]) {
    const f = await fixture(); let fail = false, block = false;
    let release!: (value: unknown) => void, entered!: () => void;
    const waiting = new Promise<unknown>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const db: SyntheticDatabase = { ...f.db, withTransaction(work) {
      if (fail) throw new Error('Synthetic database unavailable');
      return f.db.withTransaction(work);
    } };
    const service = await createI0App(options(f, async () => {
      if (block) { entered(); return waiting; }
      return readyResponse();
    }, db));
    try {
      service.startConsumer(); await untilReady(service); block = true;
      const pending = service.app.inject({ url: '/health/ready' });
      await started;
      const closing = stop ? service.close() : undefined;
      if (!stop) fail = true;
      release(readyResponse());
      const result = await pending;
      assert.equal(result.statusCode, 503, result.body);
      fail = false; await closing;
    } finally { fail = false; await service.close(); await f.close(); }
  }
});

test('health queries time out without accepting late runner success', { timeout: 10000 }, async () => {
  const f = await fixture(); let block = false;
  let release!: (value: unknown) => void, entered!: () => void;
  const waiting = new Promise<unknown>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const service = await createI0App(options(f, async () => {
    if (block) { entered(); return waiting; }
    return readyResponse();
  }));
  try {
    service.startConsumer(); await untilReady(service); block = true;
    const before = Date.now();
    const pending = service.app.inject({ url: '/health/ready' }); await started;
    const response = await pending;
    assert.equal(response.statusCode, 503);
    assert.ok(Date.now() - before >= 4800, 'must exercise the pending runner timeout, not another readiness refusal');
    assert.equal(response.json().error.code, 'DEPENDENCY_UNAVAILABLE');
    release(readyResponse());
    assert.equal(response.statusCode, 503);
  } finally { release(readyResponse()); await service.close(); await f.close(); }
});

test('disabled model calls do not block readiness or authorized session access', async () => {
  const f = await fixture(undefined, { teaching: true }); let calls = 0, scanFailed = false;
  const db: SyntheticDatabase = { ...f.db, withTransaction(work) {
    return f.db.withTransaction(tx => work({ ...tx, all(sql, ...args) {
      if (scanFailed && sql.includes("WHERE purpose='student_help'")) throw new Error('Synthetic teaching scan unavailable');
      return tx.all(sql, ...args);
    } }));
  } };
  const service = await createI0App({ ...options(f, async () => readyResponse(), db), tutoring: {
    studentHelp: { versions: { modelConfig: 'model-v1', prompt: 'prompt-v1', schema: 'schema-v1', policy: 'help-v1' },
      budgetAvailable: () => false }, provider: { generate: async () => { calls++; throw new Error('Unavailable model'); } },
  } });
  try {
    service.startConsumer(); await untilReady(service);
    const student = await f.login();
    const session = await service.app.inject({ url: '/api/session', headers: student });
    assert.equal(session.statusCode, 200, session.body);
    scanFailed = true; await delay(120);
    assert.equal((await service.app.inject({ url: '/health/ready' })).statusCode, 503);
    scanFailed = false; await untilReady(service);
    assert.equal(calls, 0);
  } finally { scanFailed = false; await service.close(); await f.close(); }
});

test('a changed recovery generation during a readiness query requires a fresh probe', async () => {
  const f = await fixture(); let block = false;
  let release!: (value: unknown) => void, entered!: () => void;
  const waiting = new Promise<unknown>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const service = await createI0App(options(f, async () => {
    if (block) { entered(); return waiting; }
    return readyResponse(f.generation());
  }));
  try {
    service.startConsumer(); await untilReady(service); block = true;
    const pending = service.app.inject({ url: '/health/ready' }); await started;
    f.restoreGeneration(); release(readyResponse());
    assert.equal((await pending).statusCode, 503);
    block = false; await untilReady(service);
  } finally { release(readyResponse()); await service.close(); await f.close(); }
});

test('the real HTTP listener withdraws readiness when Fastify is closed directly', async () => {
  const f = await fixture(); let block = false;
  let release!: (value: unknown) => void, entered!: () => void, preClosed!: () => void;
  const waiting = new Promise<unknown>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const stopping = new Promise<void>(resolve => { preClosed = resolve; });
  const service = await createI0App(options(f, async () => {
    if (block) { entered(); return waiting; }
    return readyResponse();
  }));
  service.app.addHook('preClose', async () => { preClosed(); });
  try {
    const address = await service.app.listen({ host: '127.0.0.1', port: 0 });
    assert.equal((await fetch(address + '/health/ready')).status, 503);
    service.startConsumer(); await untilReady(service);
    const healthy = await fetch(address + '/health/ready');
    assert.equal(healthy.status, 200);
    const body = await healthy.json() as { requestId: string; data: { status: string } };
    assert.deepEqual(body.data, { status: 'ready' });
    assert.equal(healthy.headers.get('x-request-id'), body.requestId);
    block = true;
    const pending = fetch(address + '/health/ready'); await started;
    const closing = service.app.close(); await stopping;
    release(readyResponse());
    assert.equal((await pending).status, 503);
    await closing;
  } finally { release(readyResponse()); await service.close(); await f.close(); }
});
