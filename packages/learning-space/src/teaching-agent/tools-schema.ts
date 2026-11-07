import type { StateShape } from '@xunjie/contracts/components';
import type { ModelTool } from '@xunjie/contracts/model-connections';
import { toolValidators } from '../model-connections/chat-native.js';
import { plannedExecutionScope } from '@xunjie/contracts/execution';
import type { TeachingToolScope } from './tool-types.js';
import { aluVerificationSchema } from './alu-tools.js';
export const uuid = { type: 'string', minLength: 36, maxLength: 36 };
export const objectSchema = (properties: Record<string, unknown>) => ({ type: 'object', properties,
  required: Object.keys(properties), additionalProperties: false });
export function shapeSchema(shape: StateShape): Record<string, unknown> {
  if (shape.type === 'object') return objectSchema(Object.fromEntries(Object.entries(shape.properties).map(([key, value]) => [key, shapeSchema(value)])));
  if (shape.type === 'array') return { type: 'array', maxItems: shape.maxItems, items: shapeSchema(shape.items) };
  return { ...shape };
}
/** Tool names and semantics are platform owned. Materials and output never define tools. */
export function teachingDefinitions(scope: TeachingToolScope): ModelTool[] {
  const tool = (name: string, description: string, inputSchema: Record<string, unknown>): ModelTool =>
    ({ name, description: `v1. ${description}`, inputSchema });
  const operations: Record<string, unknown>[] = [];
  for (const binding of scope.activity.course?.components ?? []) {
    const manifest = binding.definition.manifest;
    const alu = aluVerificationSchema(scope, binding);
    if (alu) operations.push(alu);
    if (manifest.formatVersion !== 1) continue;
    const base = { componentKey: { type: 'string', const: binding.key } };
    for (const op of manifest.operations ?? []) {
      if (plannedExecutionScope(scope.activity.course?.executionPlan, { key: binding.key, definitionDigest: binding.definition.digest,
        operationId: op.operationId, location: 'browser' }) !== 'allowed') continue;
      operations.push(objectSchema({ ...base,
      operationId: { type: 'string', const: op.operationId }, parameters: shapeSchema(op.parameters) }));
    }
    if (manifest.session) {
      const d = manifest.session;
      if (plannedExecutionScope(scope.activity.course?.executionPlan, { key: binding.key, definitionDigest: binding.definition.digest,
        operationId: d.operation.operationId, location: 'native' }) !== 'allowed') continue;
      operations.push(objectSchema({ ...base, operationId: { type: 'string', const: 'start_session' }, parameters: shapeSchema(d.parameters) }));
      operations.push(objectSchema({ ...base, operationId: { type: 'string', const: d.operation.operationId },
        parameters: shapeSchema(d.operation.parameters), requestId: uuid, expectedSeq: { type: 'integer', minimum: 0 } }));
    }
  }
  const definitions = [tool('read_work', 'Read only an approved immutable work version. Never the current workspace head.', objectSchema({ objectId: uuid, contentId: uuid })),
    tool('read_reference', 'Read one approved reference, preserving its original range and source.', objectSchema({ referenceId: uuid })),
    tool('read_material', 'Read a student-open text material from this fixed course release.', objectSchema({ materialId: uuid })),
    tool('read_result', 'Read the real result of an approved or original Agent execution.', objectSchema({ requestId: uuid })),
    tool('execution_query', 'Query the original execution identity without replaying it.', objectSchema({ requestId: uuid })),
    tool('execution_stop', 'Stop only an execution originally started by this Agent run.', objectSchema({ requestId: uuid }))];
  if (operations.length) definitions.push(tool('course_operation', 'Run one declared component operation. start_session initializes a native session; later inputs require its requestId and last observed expectedSeq.',
    { type: 'object', anyOf: operations }));
  toolValidators(definitions);
  return definitions;
}
