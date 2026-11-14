import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { readLearningBody } from '@xunjie/product-runtime/learning-http';

/** A minimal IncomingMessage stand-in: the reader only consumes the stream and the content type. */
const request = (chunks, headers = { 'content-type': 'application/json' }) =>
  Object.assign(Readable.from(chunks.map(chunk => Buffer.from(chunk))), { headers });

test('a component import body is read up to its own bound and refused past it', async () => {
  const toolchain = JSON.stringify({ runtimeResources: [
    { resourceId: '11111111-1111-4111-8111-111111111111', contentBase64: 'A'.repeat(11_200_000) }] });
  // The real six-file import is about 4 MB of base64 plus the manifest; the old 2 MB bound could not carry it.
  const parsed = await readLearningBody(request([toolchain]), 32 * 1024 * 1024);
  assert.equal((parsed.runtimeResources).length, 1);
  await assert.rejects(readLearningBody(request([toolchain]), 2_000_000), { code: 'invalid' });
  // Splitting the body across chunks must not be a way past the bound.
  await assert.rejects(readLearningBody(request([toolchain.slice(0, 1_000_000), toolchain.slice(1_000_000)]), 2_000_000),
    { code: 'invalid' });
});

test('a body is refused for the reasons it always was', async () => {
  await assert.rejects(readLearningBody(request(['{}'], { 'content-type': 'text/plain' })), { code: 'invalid' });
  await assert.rejects(readLearningBody(request(['{'])), { code: 'invalid' });
  await assert.rejects(readLearningBody(request(['[]'])), { code: 'invalid' });
});
