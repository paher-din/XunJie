import type { StateShape } from '@xunjie/contracts/components';
import type { ModelTool } from '@xunjie/contracts/model-connections';
import { plannedExecutionScope } from '@xunjie/contracts/execution';
import type { TeachingToolScope } from './tool-types.js';
import { aluVerificationSchema } from './alu-tools.js';
import { canonicalDigest } from './identity.js';
import type { TeachingToolContribution } from './tool-types.js';
import { platformToolContribution } from './tool-contributions.js';
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
    tool('execution_stop', 'Stop only an execution originally started by this Agent run.', objectSchema({ requestId: uuid })),
    tool('search_materials', 'Search permitted course text materials, fixed personal notes, native PDF text already read from a selected reference, and explicitly selected Skill text attachments. Returns only authorized snippets with fixed version, source position, read method and actual coverage: no-hit, not-indexed, no-text, partial-failure and no-access are different. Never claims unsearched sources.',
      { type: 'object', properties: {
        query: { type: 'string', minLength: 1, maxLength: 200 },
        scope: { anyOf: [{ type: 'null' }, { type: 'object', properties: {
          courseMaterials: { type: 'boolean' },
          personalMaterialIds: { type: 'array', items: uuid, maxItems: 64, uniqueItems: true },
          pdfReferenceIds: { type: 'array', items: uuid, maxItems: 16, uniqueItems: true },
          skillAttachments: { type: 'boolean' } }, additionalProperties: false }] } }, required: ['query'], additionalProperties: false }),
    tool('read_student_facts', 'Read the student\'s explicit preference and fact statements from the original owner records. Facts are never confirmed merely because they are absent; corrections and retractions keep their links. Same-course task reading only continues permitted related facts; other courses only explicit global preferences; ambiguous personal continuation is reported as ambiguous instead of guessed.',
      { type: 'object', properties: { query: { anyOf: [{ type: 'null' }, { type: 'string', maxLength: 200 }] },
        scope: { type: 'string', enum: ['current-activity', 'same-course', 'eligible'] } }, additionalProperties: false })];
  if (scope.input.draft.references.some(reference => reference.source.kind === 'personal-material')) definitions.push(
    tool('read_personal_material', 'Read a fixed UTF-16 range of a personal note version pinned in the current draft reference. Use this after search when the hit lies outside the quoted selection; never re-open the current workspace copy.',
      objectSchema({ materialId: uuid, version: { type: 'integer', minimum: 1, maximum: 64 },
        start: { type: 'integer', minimum: 0, maximum: 100000000 },
        length: { type: 'integer', minimum: 1, maximum: 6000 } })));
  if (scope.input.draft.references.some(reference => reference.source.kind === 'pdf')) definitions.push(
    tool('read_pdf_text', 'Continue native text from an already retained PDF readingId returned by read_pdf, read_reference or find_pdf. Uses actual page index and UTF-16 start/length; nextStart continues the same saved text without rendering. No OCR or image reading.',
      objectSchema({ referenceId: uuid, readingId: uuid, page: { type: 'integer', minimum: 1, maximum: 100000 },
        start: { type: 'integer', minimum: 0, maximum: 1000000 }, length: { type: 'integer', minimum: 1, maximum: 2400 } })),
    tool('find_pdf', 'Case-sensitive native-text search on one or two explicit actual PDF pages. No OCR or visual reading; empty scanned text is not evidence of no visual match. Offsets are UTF-16 code units.',
      objectSchema({ referenceId: uuid, pages: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 100000 }, minItems: 1, maxItems: 2, uniqueItems: true },
        query: { type: 'string', minLength: 1, maxLength: 200 } })),
    tool('read_pdf', 'Read at most two actual 1-based pages of the PDF selected by referenceId. Page images are sent only on the fixed verified image route; printed labels are not page indexes. Region coordinates use the rotated visible page, top-left origin, normalized 0..1. Never claim unread pages or OCR.',
      objectSchema({ referenceId: uuid, pages: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 100000 }, minItems: 1, maxItems: 2, uniqueItems: true },
        region: { anyOf: [{ type: 'null' }, objectSchema({ x: { type: 'number', minimum: 0, maximum: 1 },
          y: { type: 'number', minimum: 0, maximum: 1 }, width: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
          height: { type: 'number', exclusiveMinimum: 0, maximum: 1 } })] } })));
  if (operations.length) definitions.push(tool('course_operation', 'Run one declared component operation. start_session initializes a native session; later inputs require its requestId and last observed expectedSeq.',
    { type: 'object', anyOf: operations }));
  return definitions;
}

/** Each course component owns its operation schema even when logical names match. */
export function teachingContributions(scope: TeachingToolScope): TeachingToolContribution[] {
  return teachingDefinitions(scope).flatMap<TeachingToolContribution>(definition => {
    const resourceScope = { identity: scope.identity, activityId: scope.activity.activityId,
      releaseId: scope.activity.course?.releaseId ?? null };
    if (definition.name !== 'course_operation') return [platformToolContribution(definition, scope)];
    return (scope.activity.course?.components ?? []).flatMap(binding => {
      const operations = (definition.inputSchema.anyOf as Record<string, unknown>[]).filter(operation => {
        const properties = operation.properties as Record<string, { const?: string }>;
        return properties?.componentKey?.const === binding.key;
      });
      if (!operations.length) return [];
      const owned = { ...definition, inputSchema: { type: 'object', anyOf: operations } };
      return [{ definition: owned, purpose: owned.description,
        resultSchema: { type: 'object', properties: { query: { type: 'object' }, artifact: { type: 'object' } }, additionalProperties: true }, source: { kind: 'course' as const,
        sourceId: 'course:' + scope.activity.course!.releaseId + ':' + binding.key,
        version: binding.definition.digest, contentDigest: canonicalDigest({ definition: binding.definition, tool: owned }),
        releaseId: scope.activity.course!.releaseId, componentKey: binding.key },
        executor: { executorId: 'teaching-tools:course_operation:' + binding.key,
          toolName: definition.name, version: binding.definition.digest }, effect: 'execute' as const, resourceScope }];
    });
  });
}
