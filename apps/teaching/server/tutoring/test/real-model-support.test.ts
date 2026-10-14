import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import {
  assertRealFailureProbeAuthorization,
  assertRealModelRuntime,
  assertRealPerformanceBatchAuthorization,
  assertRealSemanticFixBatchAuthorization,
  assertSafeEvidence,
  createObservedModelFetch,
  type HttpFact,
} from './real-model-support.ts';

for (const [authorization, message] of [
  ['', 'Explicit DL-B HR-DL-03 semantic-fix authorization is required.'],
  ['approved-synthetic', 'DEEPSEEK_API_KEY is not configured through the approved local channel.'],
] as const) {
  test(`DL-B semantic-fix gate rejects ${authorization ? 'missing credentials' : 'missing authorization'} without network`, () => {
    const source = `
      import assert from 'node:assert/strict';
      import { dlBRealSemanticFixProbe } from ${JSON.stringify(new URL('./real-model-support.ts', import.meta.url).href)};
      globalThis.fetch = () => { throw new Error('Unexpected network access'); };
      assert.throws(() => dlBRealSemanticFixProbe(), { message: ${JSON.stringify(message)} });
      process.stdout.write('gate-closed');
    `;
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', source], {
      env: { ...process.env, DEEPSEEK_API_KEY: '', XUNJIE_DL_B_REAL_SEMANTIC_FIX: authorization }, encoding: 'utf8',
    });
    assert.equal(output, 'gate-closed');
  });
}

for (const [authorization, message] of [
  ['', 'Explicit DL-B synthetic HDL model authorization is required.'],
  ['approved-synthetic', 'DEEPSEEK_API_KEY is not configured through the approved local channel.'],
] as const) {
  test(`DL-B model gate rejects ${authorization ? 'missing credentials' : 'missing authorization'} without network`, () => {
    const source = `
      import assert from 'node:assert/strict';
      import { dlBRealModelProbe } from ${JSON.stringify(new URL('./real-model-support.ts', import.meta.url).href)};
      globalThis.fetch = () => { throw new Error('Unexpected network access'); };
      assert.throws(() => dlBRealModelProbe(), { message: ${JSON.stringify(message)} });
      process.stdout.write('gate-closed');
    `;
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', source], {
      env: { ...process.env, DEEPSEEK_API_KEY: '', XUNJIE_DL_B_REAL_MODEL: authorization }, encoding: 'utf8',
    });
    assert.equal(output, 'gate-closed');
  });
}

for (const [authorization, message] of [
  ['', 'Explicit B3 synthetic-data model authorization is required.'],
  ['approved-synthetic', 'DEEPSEEK_API_KEY is not configured through the approved local channel.'],
] as const) {
  test(`B3 model gate rejects ${authorization ? 'missing credentials' : 'missing authorization'} without network`, () => {
    const source = `
      import assert from 'node:assert/strict';
      import { b3RealModelProbe } from ${JSON.stringify(new URL('./real-model-support.ts', import.meta.url).href)};
      globalThis.fetch = () => { throw new Error('Unexpected network access'); };
      assert.throws(() => b3RealModelProbe(), { message: ${JSON.stringify(message)} });
      process.stdout.write('gate-closed');
    `;
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', source], {
      env: { ...process.env, DEEPSEEK_API_KEY: '', XUNJIE_B3_REAL_MODEL: authorization }, encoding: 'utf8',
    });
    assert.equal(output, 'gate-closed');
  });
}

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
    choices: [{ message: { content: '{"kind":"patch"}', reasoning_content: 'must not be captured' } }],
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
    visibleOutput: '{"kind":"patch"}',
  }]);
  assert.equal(JSON.stringify(http).includes('must not be captured'), false);
});

test('P2 model evidence classifies a non-success HTTP response without persisting its error body', async () => {
  const http: HttpFact[] = [];
  const observed = createObservedModelFetch(http, async () => new Response(JSON.stringify({
    error: { message: 'synthetic provider detail must not be persisted' },
  }), { status: 400, headers: { 'content-type': 'application/json' } }));

  const response = await observed('https://synthetic.invalid');
  assert.equal(response.status, 400);
  assert.equal(http[0]?.outcome, 'provider_error');
  assert.equal(http[0]?.status, 400);
  assert.equal(JSON.stringify(http).includes('synthetic provider detail'), false);
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

test('P2 real-model runtime gate rejects a non-locked Node before provider setup', () => {
  assert.throws(() => assertRealModelRuntime('24.14.1'), {
    message: 'P2 real-model validation requires Node 24.21.0; received 24.14.1.',
  });
  assert.doesNotThrow(() => assertRealModelRuntime('24.21.0'));
});

test('P2 real-provider failure probes require their own explicit authorization', () => {
  if (process.env.XUNJIE_P2_REAL_FAILURES === 'approved-synthetic') {
    assert.doesNotThrow(() => assertRealFailureProbeAuthorization());
  } else {
    assert.throws(() => assertRealFailureProbeAuthorization(), {
      message: 'Explicit P2 real-provider failure-probe authorization is required.',
    });
  }
});

test('P2 30-job performance batch requires its own explicit authorization', () => {
  if (process.env.XUNJIE_P2_REAL_PERFORMANCE === 'approved-synthetic') {
    assert.doesNotThrow(() => assertRealPerformanceBatchAuthorization());
  } else {
    assert.throws(() => assertRealPerformanceBatchAuthorization(), {
      message: 'Explicit P2 30-job synthetic performance authorization is required.',
    });
  }
});

test('P2 two-job semantic-fix batch requires its own explicit authorization', () => {
  if (process.env.XUNJIE_P2_REAL_SEMANTIC_FIXES === 'approved-synthetic') {
    assert.doesNotThrow(() => assertRealSemanticFixBatchAuthorization());
  } else {
    assert.throws(() => assertRealSemanticFixBatchAuthorization(), {
      message: 'Explicit P2 two-job synthetic semantic-fix authorization is required.',
    });
  }
});
