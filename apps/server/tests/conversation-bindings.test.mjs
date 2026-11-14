import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConversationCapabilities } from '@xunjie/agents/conversation/capabilities';

const offer = (scope = { source: 'course-a', version: 1 }) => ({ definition: { name: 'read_original', description: '读取固定来源',
  inputSchema: { type: 'object', additionalProperties: false } }, effect: 'read', scope });
const module = (id, offers, version = 1) => ({ id, version, list: async () => offers });
const context = { snapshot: { steps: [] } };

test('public conversation bindings retain module/version/source identity and disambiguate equal logical names without choosing by name', async () => {
  const first = module('course-reader-a', [offer()]), second = module('course-reader-b', [offer({ source: 'course-b', version: 1 })]);
  const original = await createConversationCapabilities([first, second]).bindings(context);
  const reordered = await createConversationCapabilities([second, first]).bindings(context);
  assert.deepEqual(reordered.toSorted((a, b) => a.bindingId.localeCompare(b.bindingId)), original.toSorted((a, b) => a.bindingId.localeCompare(b.bindingId)));
  assert.notEqual(original[0].bindingId, original[1].bindingId);
  assert.notEqual(original[0].modelName, original[1].modelName);
  for (const binding of original) { assert.equal(binding.moduleVersion, 1); assert.equal(binding.effect, 'read'); }
  const changedSource = await createConversationCapabilities([module(first.id, [offer({ source: 'course-a', version: 2 })]), second]).bindings(context);
  const changedCode = await createConversationCapabilities([module(first.id, [offer()], 2), second]).bindings(context);
  assert.notEqual(changedSource[0].bindingId, original[0].bindingId);
  assert.notEqual(changedCode[0].bindingId, original[0].bindingId);
  assert.equal(changedSource[1].bindingId, original[1].bindingId);
});

test('public conversation binding admission rejects duplicate modules, duplicated offers and more than 64 tools', async () => {
  const first = module('source', [offer()]);
  assert.throws(() => createConversationCapabilities([first, first]), { code: 'identity-conflict' });
  await assert.rejects(createConversationCapabilities([module('source', [offer(), offer()])]).bindings(context), { code: 'identity-conflict' });
  const entries = Array.from({ length: 65 }, (_, version) => offer({ source: 'course', version }));
  await assert.rejects(createConversationCapabilities([module('source', entries)]).bindings(context), { code: 'invalid' });
  assert.equal((await createConversationCapabilities([module('source', entries.slice(0, 64))]).bindings(context)).length, 64);
});
