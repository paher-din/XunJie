import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { aluTeachingFixture } from './fixtures/alu-teaching.mjs';

test('uppercase HDL include survives Agent preparation and execution owner dispatch', { timeout: 120000 }, async t => {
  const f = await aluTeachingFixture(t);
  const file = (name, value) => ({ objectId: randomUUID(), contentId: randomUUID(), name,
    kind: 'code', encoding: 'utf8', mediaType: 'text/plain', value });
  const source = file('alu.sv', '`include "carry.SVH"\n'
    + 'module alu(input [3:0] A, B, input M, input [1:0] S, input Cin, output [3:0] F, output Cout);\n'
    + 'assign {Cout, F} = `ALU_SUM(A, B, Cin);\nendmodule\n');
  const header = file('carry.SVH', "`define ALU_SUM(a, b, cin) ({1'b0, a} + {1'b0, b} + cin)\n");
  const fixedWorks = [source, header];
  for (const work of fixedWorks)
    await f.learning.works.registerBasis(f.scope.identity, f.activity.activityId, work);
  f.scope.input.works = structuredClone(fixedWorks);

  const commandId = randomUUID();
  const command = await f.host.prepare(f.scope, { callId: 'uppercase-include', name: 'course_operation',
    arguments: { componentKey: 'alu', operationId: 'run-single',
      parameters: { A: 15, B: 1, M: 1, S: 0, Cin: 0 } } }, commandId);
  assert.deepEqual(command.basis.action.execution.basis.works, fixedWorks);
  assert.equal((await f.host.dispatch(f.scope, command)).state, 'accepted');

  const pending = await f.learning.executions.agent.pendingBrowser(f.scope.identity, f.activity.activityId);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].action.requestId, commandId);
  assert.deepEqual(pending[0].action.execution.basis.works, fixedWorks,
    'the owner retains both the referencing HDL and its uppercase include under the original command');
});
