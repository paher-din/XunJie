import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { aluPackage, aluCoursePackage } from '../../../components/alu-experiment/package.mjs';

test('ALU 课程规则发布复用不可变 v4 组件定义', async () => {
  const component = await aluPackage(), course = await aluCoursePackage();
  assert.equal(component.requestId, '19200000-0000-4000-8000-000000000184');
  assert.equal(component.manifest.componentId, '19200000-0000-4000-8000-000000000001');
  assert.equal(component.manifest.version, 4);
  assert.equal(course.requestId, '19200000-0000-4000-8000-000000000304');
  assert.equal(course.release.releaseId, '19200000-0000-4000-8000-000000000306');
  assert.equal(course.release.components[0].definition.manifest.version, 4);
  assert.equal(course.release.components[0].definition.digest,
    createHash('sha256').update(JSON.stringify(component.manifest)).digest('hex'));
  assert.equal(course.release.helpPolicy.predictionGate.hideResultsBeforePrediction, true);
});
