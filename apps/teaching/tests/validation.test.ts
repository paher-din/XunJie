import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { createApp } from '../server/app.ts';
import { parseRequest } from '../server/app/validation.ts';

test('shared parsing validates input and rejects undeclared identity fields without echoing data', async (t) => {
  const app = createApp();
  t.after(() => app.close());
  const schema = z.strictObject({ question: z.string().min(1).max(100) });
  app.post('/test-input', async (request) => ({
    requestId: request.id,
    data: parseRequest(schema, request.body),
  }));
  const valid = await app.inject({ method: 'POST', url: '/test-input', payload: { question: 'Explain pointers.' } });
  assert.equal(valid.statusCode, 200);
  assert.deepEqual(valid.json().data, { question: 'Explain pointers.' });

  const invalid = await app.inject({
    method: 'POST', url: '/test-input',
    payload: { question: 'SYNTHETIC_PRIVATE_TEXT', role: 'teacher', studentId: 'another-student' },
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error.code, 'INVALID_REQUEST');
  assert.equal(invalid.body.includes('SYNTHETIC_PRIVATE_TEXT'), false);
  assert.equal(invalid.body.includes('another-student'), false);
});
