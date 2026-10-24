import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executionNodes } from '../server/app/execution-nodes.ts';

test('empty execution node list is an explicit no-execution deployment', () => {
  const routing = executionNodes([]);
  assert.deepEqual(routing.nodes, []);
  assert.throws(() => routing.selected({ headers: {} } as never),
    (error: unknown) => (error as { code?: string }).code === 'RUNTIME_NOT_READY');
  assert.throws(() => routing.node({ nodeId: 'ghost', nodeGeneration: 'generation' }),
    (error: unknown) => (error as { code?: string }).code === 'RECOVERY_REQUIRED');
  assert.throws(() => executionNodes([], 'unregistered-legacy'),
    (error: unknown) => (error as { code?: string }).code === 'INVALID_CONFIGURATION');
});
