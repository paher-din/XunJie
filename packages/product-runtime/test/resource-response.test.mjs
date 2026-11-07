import assert from 'node:assert/strict';
import test from 'node:test';
import { boundedJsonResponse, runtimeResourcePathPattern, runtimeResourceResponseBytes,
  runtimeResourceRoute,executionArtifactRoute } from '../dist/resource-response.js';

const releaseId = '11111111-1111-4111-8111-111111111111';
const resourceRoute = (path) => `releases/${releaseId}/components/alu/resources/${path}`;
test('the retained-result response bound cannot be borrowed by control, upload or unrelated routes',()=>{
  assert.equal(executionArtifactRoute.test(`executions/${releaseId}/${releaseId}/artifact`),true);
  for(const route of [`executions/${releaseId}/${releaseId}/result`,`executions/${releaseId}/${releaseId}/control`,
    `intents/${releaseId}/${releaseId}/artifact`,`executions/${releaseId}/${releaseId}/artifact/extra`])assert.equal(executionArtifactRoute.test(route),false);
});

test('the resource bound matches only the exact runtime resource route', () => {
  assert.equal(runtimeResourceRoute.test(resourceRoute('ivl.wasm')), true);
  assert.equal(runtimeResourceRoute.test(resourceRoute('nested/dir/alu-tb.sv')), true);
  // The other release payloads keep the bound they already had.
  assert.equal(runtimeResourceRoute.test(`releases/${releaseId}/components/alu/algorithm`), false);
  assert.equal(runtimeResourceRoute.test(`releases/${releaseId}/components/alu/dependencies/mark-js`), false);
  assert.equal(runtimeResourceRoute.test(`releases/${releaseId}/materials/${releaseId}`), false);
  assert.equal(runtimeResourceRoute.test(`releases/${releaseId}`), false);
  // An operation cannot borrow the ceiling by naming a resource path it is not.
  assert.equal(runtimeResourceRoute.test(`releases/${releaseId}/components/alu/resources/`), false);
  assert.equal(runtimeResourceRoute.test(`releases/${releaseId}/components/alu/resources/../escape.js`), false);
  assert.equal(runtimeResourceRoute.test(`releases/${releaseId}/components/alu/resources/ivl.wasm/`), false);
  assert.equal(runtimeResourceRoute.test(`releases/${releaseId}/components/alu/view`), false);
  assert.equal(runtimeResourceRoute.test(`manage/component-import`), false);
  assert.equal(runtimeResourceRoute.test(`executions/${releaseId}/result`), false);
});

test('a runtime resource path stays traversal-free and depth-bounded', () => {
  assert.equal(new RegExp(`^${runtimeResourcePathPattern}$`).test('../escape.js'), false);
  assert.equal(new RegExp(`^${runtimeResourcePathPattern}$`).test('a/../../etc/passwd'), false);
  assert.equal(new RegExp(`^${runtimeResourcePathPattern}$`).test('/absolute.js'), false);
  assert.equal(new RegExp(`^${runtimeResourcePathPattern}$`).test(`a/${'b/'.repeat(9)}c`), false);
});

const body = (text) => new Response(text);
const streamed = (size) => new Response(new ReadableStream({
  start(controller) {
    for (let sent = 0; sent < size; sent += 64 * 1024) {
      controller.enqueue(new Uint8Array(Math.min(64 * 1024, size - sent)).fill(32));
    }
    controller.close();
  },
}));

test('a bounded response is read in full while it fits and refused once it does not', async () => {
  const value = { resourceId: releaseId, contentBase64: 'AAAA' };
  assert.deepEqual(await boundedJsonResponse(body(JSON.stringify(value)), 1024), value);
  // A toolchain file really is larger than an ordinary release payload; that is the case this bound exists for.
  const encoded = 11_200_000;
  const large = JSON.stringify({ contentBase64: 'A'.repeat(encoded) });
  assert.equal((await boundedJsonResponse(body(large), runtimeResourceResponseBytes)).contentBase64.length, encoded);
  await assert.rejects(boundedJsonResponse(streamed(runtimeResourceResponseBytes + 1), runtimeResourceResponseBytes),
    { code: 'unavailable' });
});

test('a truncated or malformed response is an upstream failure, never partial data', async () => {
  await assert.rejects(boundedJsonResponse(body('{"resourceId":'), 1024), { code: 'unavailable' });
  await assert.rejects(boundedJsonResponse(body(''), 1024), { code: 'unavailable' });
});
