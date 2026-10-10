import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PhaseResult } from './docker.ts';
import { verifyCase } from './verify.ts';

const execution: PhaseResult = { phase: 'execute', containerId: 'synthetic-unit', exitCode: 0,
  stdout: 'passed\n', stderr: '', outputBytes: 7, durationMs: 1, unitTerminated: true };
const rule = { checkRuleVersion: 'synthetic-rule-v1', validatorVersion: 'synthetic-verifier-v1',
  expectedExitCode: 0, expectedStdout: 'TOTAL\t4\t11\t51\n' };

test('stdout passed and exit zero cannot claim course success', () => {
  assert.equal(verifyCase('check', execution, rule)?.verdict, 'failed');
  assert.equal(verifyCase('run', execution, undefined), undefined);
  assert.throws(() => verifyCase('check', execution, undefined), /Trusted check rule/);
});

test('trusted expected exits one and two can pass error-handling checks', () => {
  for (const exitCode of [1, 2]) {
    const result = verifyCase('check', { ...execution, exitCode, stdout: '', stderr: 'usage\n' },
      { ...rule, expectedExitCode: exitCode, expectedStdout: '', expectedStderr: 'usage\n' });
    assert.equal(result?.verdict, 'passed');
  }
});

test('limits, tooling failures, unresolved termination and missing files remain incomplete', () => {
  const matching = { ...execution, stdout: rule.expectedStdout };
  for (const failureKind of ['timeout', 'oom', 'process_limit', 'temp_limit', 'output_limit', 'cancelled',
    'infrastructure_error'] as const) {
    assert.equal(verifyCase('check', { ...matching, failureKind }, rule)?.verdict, 'incomplete');
  }
  assert.equal(verifyCase('check', { ...matching, unitTerminated: false }, rule)?.verdict, 'incomplete');
  assert.equal(verifyCase('check', { ...matching, phase: 'compile' }, rule)?.verdict, 'incomplete');
  assert.equal(verifyCase('check', matching, rule, [{ relativeName: 'report.txt', status: 'missing' }])?.verdict, 'incomplete');
  assert.equal(verifyCase('check', matching, rule, [{ relativeName: 'report.txt', status: 'complete', text: 'unverified' }])?.verdict, 'incomplete');
});
