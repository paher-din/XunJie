import { teachingArtifactPublishSchema } from '@xunjie/contracts/teaching-artifacts';
import type { ModelTool } from '@xunjie/contracts/model-connections';
import { StorageError } from '@xunjie/storage';
import { objectSchema, uuid } from '../../capabilities/tool-discovery/tool-json-schema.js';

const optionalId = { anyOf: [uuid, { type: 'null' }] };
const text = (maxLength: number) => ({ type: 'string', maxLength });
const field = { type: 'string', pattern: '^[a-zA-Z][a-zA-Z0-9-]{0,47}$' };

/** The host supplies request/Run identities; generated arguments can only describe content. */
export const artifactToolDefinitions: ModelTool[] = [
  { name: 'read_teaching_artifact', description: 'v1. List this activity\'s teaching pages/cards when artifactId is null. Otherwise read one fixed revision (revisionId null selects the current version). Read before revising; identities and state meanings must not be guessed. No generation, execution or state change.',
    inputSchema: objectSchema({ artifactId: optionalId, revisionId: optionalId }) },
  { name: 'generate_teaching_artifact', description: 'v1. Create or revise an interactive teaching page/card in this activity. Put HTML first for a static progressive preview. Use explicit state and the documented window.xunjie host API; no network/imports or student-code edits. Local controls do not ask the model. Actual experiments use host capabilities; label generated values as teaching illustrations. A revision requires original artifactId/parentRevisionId and stable field meanings; incompatible changes preserve the old page. For a new page use null IDs. Full output is checked before enabling interaction.',
    progress: { kind: 'json-string', property: 'html' },
    inputSchema: objectSchema({
      html: { type: 'string', minLength: 1, maxLength: 500000 },
      title: { type: 'string', minLength: 1, maxLength: 100 }, display: { type: 'string', enum: ['card', 'page'] },
      formatVersion: { type: 'integer', const: 1 }, hostApiVersion: { type: 'integer', const: 1 },
      css: text(100000), javascript: text(250000), stateVersion: { type: 'integer', minimum: 1 },
      stateShape: { type: 'object', properties: { type: { const: 'object' }, properties: { type: 'object', additionalProperties: { type: 'object' } } },
        required: ['type', 'properties'], additionalProperties: false },
      initialState: { type: 'object', additionalProperties: true },
      semanticFields: { type: 'array', maxItems: 32, items: objectSchema({ key: field, meaning: { type: 'string', minLength: 1, maxLength: 500 } }) },
      semanticObjects: { type: 'array', maxItems: 64, items: objectSchema({ id: field, meaning: { type: 'string', minLength: 1, maxLength: 500 }, summary: { type: 'string', minLength: 1, maxLength: 4000 } }) },
      requiredCapabilities: { type: 'array', maxItems: 7, uniqueItems: true,
        items: { type: 'string', enum: ['workspace.read', 'workspace.change', 'execution.submit', 'materials.read', 'observations.read', 'reference.select', 'student.respond'] } },
      artifactId: optionalId, parentRevisionId: optionalId,
      mapping: { type: 'array', maxItems: 32, items: objectSchema({ from: field, to: field }) },
    }) },
];

export function artifactPublishInput(arguments_: Record<string, unknown>, commandId: string) {
  const { artifactId, parentRevisionId, mapping, ...payload } = arguments_;
  const parsed = teachingArtifactPublishSchema.safeParse({ requestId: commandId, payload,
    ...(artifactId == null ? {} : { artifactId }), ...(parentRevisionId == null ? {} : { parentRevisionId }), mapping });
  if (!parsed.success) throw new StorageError('invalid');
  return parsed.data;
}
