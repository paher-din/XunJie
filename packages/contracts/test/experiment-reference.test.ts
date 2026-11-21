import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { experimentDraftSchema, experimentReferenceSchema } from '@xunjie/contracts/experiment-references';

const id = () => randomUUID();
const source = () => {
  const activityId = id(), requestId = id(), executionRef = id();
  return { activityId, requestId, executionRef } as const;
};

test('experiment references share one strict browser/host identity', () => {
  const fixed = source();
  const reference = {
    ...fixed, inputDigest: 'a'.repeat(64), label: '工作区实验', question: '请解释实际结果',
    source: { kind: 'component' as const, formatVersion: 1 as const, environmentId: id(), spaceId: id(), principalId: id(),
      activityId: fixed.activityId, instanceId: 'alu-instance', componentId: id(), componentVersion: 4,
      definitionDigest: 'b'.repeat(64), bindingKey: 'alu', objectId: fixed.requestId, contentId: id(),
      origin: 'execution-result' as const, requestId: fixed.requestId, executionRef: fixed.executionRef },
  };
  assert.equal(experimentReferenceSchema.safeParse(reference).success, true);
  assert.deepEqual(experimentDraftSchema.parse(JSON.parse(JSON.stringify(reference))), reference);
  const { question, label, ...identity } = reference;
  assert.deepEqual(experimentReferenceSchema.parse({ ...identity, label }), { ...identity, label });
  assert.equal(experimentDraftSchema.safeParse({ ...identity, label }).success, false);
  assert.equal(experimentReferenceSchema.safeParse({ ...reference, requestId: id() }).success, false);
  const { inputDigest: _digest, ...withoutDigest } = reference;
  assert.equal(experimentReferenceSchema.safeParse(withoutDigest).success, false);
});
