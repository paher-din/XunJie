import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../../tests/dl-a-support.ts';

test('PR53 integration preserves DL-A HDL readiness while sharing the original health route', async () => {
  const f = await fixture();
  const counts = () => f.db.withTransaction(tx =>
    ['jobs', 'attempts', 'command_receipts'].map(table => tx.get(`SELECT COUNT(*) AS n FROM ${table}`)!.n));
  try {
    const before = counts();
    const ready = await f.app.inject({ url: '/health/ready' });
    assert.equal(ready.statusCode, 200, ready.body);
    assert.deepEqual(ready.json().data, { status: 'ready' });
    assert.equal(ready.headers['x-request-id'], ready.json().requestId);
    assert.equal(ready.headers['cache-control'], 'no-store');
    f.node.unavailable();
    const unavailable = await f.app.inject({ url: '/health/ready' });
    assert.equal(unavailable.statusCode, 503, unavailable.body);
    assert.equal(unavailable.json().error.code, 'DEPENDENCY_UNAVAILABLE');
    assert.equal(unavailable.headers['cache-control'], 'no-store');
    f.node.available();
    assert.equal((await f.app.inject({ url: '/health/ready' })).statusCode, 200);
    assert.deepEqual(counts(), before);
  } finally { await f.close(); }
});
