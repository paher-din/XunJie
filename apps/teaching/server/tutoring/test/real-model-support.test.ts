import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { assertSafeEvidence, createObservedModelFetch, type HttpFact } from './real-model-support.ts';

for (const [authorization, message] of [
  ['', 'Explicit P2 synthetic-data model authorization is required.'],
  ['approved-synthetic', 'DEEPSEEK_API_KEY is not configured through the approved local channel.'],
] as const) {
  test(`P2 model gate rejects ${authorization ? 'missing credentials' : 'missing authorization'} without network`, () => {
    const source = `
      import assert from 'node:assert/strict';
      import { realModelProbe } from ${JSON.stringify(new URL('./real-model-support.ts', import.meta.url).href)};
      globalThis.fetch = () => { throw new Error('Unexpected network access'); };
      assert.throws(() => realModelProbe(), { message: ${JSON.stringify(message)} });
      process.stdout.write('gate-closed');
    `;
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', source], {
      env: { ...process.env, DEEPSEEK_API_KEY: '', XUNJIE_P2_REAL_MODEL: authorization }, encoding: 'utf8',
    });
    assert.equal(output, 'gate-closed');
  });
}

test('P2 model evidence observes bounded response metadata and latency', async () => {
  const http: HttpFact[] = [];
  const ticks = [1_000, 1_025];
  const observed = createObservedModelFetch(http, async () => new Response(JSON.stringify({
    model: 'deepseek-flash-test', system_fingerprint: 'fp_test',
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, negative_tokens: -1 },
  }), { status: 200, headers: { 'content-type': 'application/json' } }), () => ticks.shift()!);

  const response = await observed('https://synthetic.invalid');
  assert.equal(response.status, 200);
  assert.deepEqual(http, [{
    startedAt: new Date(1_000).toISOString(),
    finishedAt: new Date(1_025).toISOString(),
    latencyMs: 25,
    outcome: 'response',
    status: 200,
    model: 'deepseek-flash-test',
    fingerprint: 'fp_test',
    tokens: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }]);
});

for (const [name, error, signal, expected] of [
  ['network failure', new TypeError('synthetic network failure'), undefined, 'network_error'],
  ['cancellation', new DOMException('synthetic cancellation', 'AbortError'), AbortSignal.abort(), 'cancelled'],
  ['timeout', new DOMException('synthetic timeout', 'TimeoutError'), AbortSignal.abort(new DOMException('deadline', 'TimeoutError')), 'timed_out'],
] as const) {
  test(`P2 model evidence classifies ${name} without persisting raw errors`, async () => {
    const http: HttpFact[] = [];
    const ticks = [2_000, 2_010];
    const observed = createObservedModelFetch(http, async () => { throw error; }, () => ticks.shift()!);
    await assert.rejects(observed('https://synthetic.invalid', signal ? { signal } : undefined));
    assert.deepEqual(http, [{
      startedAt: new Date(2_000).toISOString(),
      finishedAt: new Date(2_010).toISOString(),
      latencyMs: 10,
      outcome: expected,
    }]);
    assert.equal(JSON.stringify(http).includes(error.message), false);
  });
}

test('P2 model evidence rejects credential, lease and reasoning fields recursively', () => {
  for (const value of [
    { apiKey: 'secret' },
    { nested: { leaseToken: 'lease' } },
    { array: [{ reasoning_content: 'hidden' }] },
    { headers: { authorization: 'Bearer secret' } },
  ]) assert.throws(() => assertSafeEvidence(value), /Sensitive evidence field is not allowed/);

  assert.doesNotThrow(() => assertSafeEvidence({
    outcome: 'success', authorizedReferenceIds: ['resource:sha256'], usage: { totalTokens: 15 },
  }));
});
