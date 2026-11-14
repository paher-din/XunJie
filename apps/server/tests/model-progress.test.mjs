import assert from 'node:assert/strict';
import { test } from 'node:test';

const { createProgressPublisher } = await import(new URL(
  '../../../packages/model-gateway/dist/sensitive-output.js', import.meta.url).href);

test('incremental previews withhold credential-sized tails and stop at the credential', () => {
  const key = 'synthetic-progress-key';
  const seen = [];
  const publish = createProgressPublisher(key, text => seen.push(text));
  publish('短');
  assert.deepEqual(seen, [], 'a short answer never publishes ahead of the credential window');
  publish('甲'.repeat(100));
  assert.equal(seen.at(-1).length, 100 - (key.length - 1));
  publish('甲'.repeat(100) + key.slice(0, 11));
  assert.equal(seen.at(-1).length, 111 - (key.length - 1), 'a partial credential stays private');
  assert.ok(!seen.some(text => [...key.slice(0, key.length - 1)].some((_, index) => text.endsWith(key.slice(0, index + 1)))));
  assert.ok(seen.every(text => !text.includes(key)));
  publish('甲'.repeat(100) + key + '后面的内容');
  assert.ok(seen.every(text => !text.includes(key)), 'the credential is never published');
  const count = seen.length;
  publish('甲'.repeat(200));
  assert.equal(seen.length, count, 'publication stops once the credential appears');
  assert.ok(seen.every((text, index) => index === 0 || seen[index - 1].length < text.length));
});

test('without a credential the whole accumulated text is published', () => {
  const seen = [];
  const publish = createProgressPublisher('', text => seen.push(text));
  publish('第一段');
  publish('第一段第二段');
  assert.deepEqual(seen, ['第一段', '第一段第二段']);
});
