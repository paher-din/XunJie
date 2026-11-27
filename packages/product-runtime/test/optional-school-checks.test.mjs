import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StorageError } from '@xunjie/storage';
import { mergeOptionalSchoolChecks } from '../dist/optional-school-checks.js';

const own = [{ attemptId: 'local-check', createdAt: '2026-11-20T00:00:00.000Z' }];

test('a school without a model service keeps the local check history', async () => {
  assert.deepEqual(await mergeOptionalSchoolChecks(own, async () => {
    throw new StorageError('unavailable');
  }), own);
});

test('the optional school history only swallows unavailable, not refusal or malformed data', async () => {
  await assert.rejects(mergeOptionalSchoolChecks(own, async () => {
    throw new StorageError('forbidden');
  }), { code: 'forbidden' });
  await assert.rejects(mergeOptionalSchoolChecks(own, async () => ({ malformed: true })));
});
