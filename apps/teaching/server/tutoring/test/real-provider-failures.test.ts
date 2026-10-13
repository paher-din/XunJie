import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProviderRequest } from '../providers.ts';
import {
  assertRealFailureProbeAuthorization,
  realFailureProbeEnabled,
  realModelEnabled,
  realModelProbe,
  writeRealModelEvidence,
} from './real-model-support.ts';

const enabled = realModelEnabled && realFailureProbeEnabled;

function request(signal: AbortSignal, remainingMs: number): ProviderRequest {
  return {
    purpose: 'student_help',
    systemPolicy: [
      'Synthetic-only failure probe. Return bounded tutoring JSON if the request is not interrupted.',
      'Do not provide a whole solution, write files, run code, or make a formal evaluation.',
      'Authorized reference IDs: resource:synthetic-failure-probe.',
    ].join('\n'),
    untrustedInput: {
      question: 'Give one short synthetic concept hint about an array boundary.',
      references: [{
        id: 'resource:synthetic-failure-probe',
        content: 'Synthetic course material: inspect the array bound before advancing a pointer.',
      }],
      policy: { helpAllowed: true, wholeSolutionAllowed: false },
    },
    repair: false,
    remainingMs,
    signal,
  };
}

test('P2 real-provider cancellation, timeout and HTTP failure probes', { skip: !enabled }, async t => {
  assertRealFailureProbeAuthorization();
  const cancellation = new AbortController();
  const probe = realModelProbe({
    onRequestStart(attemptIndex) {
      if (attemptIndex === 0) setTimeout(() => cancellation.abort(), 25);
    },
  });
  const evidence: Record<string, unknown> = {
    approvedScope: {
      dataScope: 'synthetic-only',
      maximumExternalRequests: 3,
      retries: 0,
      execution: 'serial-stop-on-unexpected-result',
    },
  };

  try {
    await assert.rejects(probe.provider.generate(request(cancellation.signal, 45_000)));
    assert.equal(probe.http.length, 1);
    assert.equal(probe.http[0]?.outcome, 'cancelled');
    evidence.cancellation = { outcome: probe.http[0]?.outcome, usage: 'unknown' };

    await assert.rejects(probe.provider.generate(request(new AbortController().signal, 100)));
    assert.equal(probe.http.length, 2);
    assert.equal(probe.http[1]?.outcome, 'timed_out');
    evidence.timeout = { outcome: probe.http[1]?.outcome, usage: 'unknown' };

    const failureResponse = await probe.requestExpectedProviderFailure(AbortSignal.timeout(10_000));
    assert.equal(probe.http.length, 3);
    assert.equal(failureResponse.ok, false);
    assert.equal(probe.http[2]?.outcome, 'provider_error');
    assert.ok((probe.http[2]?.status ?? 0) >= 400);
    evidence.failure = {
      outcome: probe.http[2]?.outcome,
      status: probe.http[2]?.status,
      usage: 'unknown',
    };
  } finally {
    try {
      t.diagnostic(`Synthetic-data provider failure evidence: ${writeRealModelEvidence(
        'provider_failure_probes', evidence, probe.http,
      )}`);
    } finally {
      cancellation.abort();
    }
  }
});
