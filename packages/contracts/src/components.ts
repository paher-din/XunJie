import { z } from 'zod';

const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
/** Shape property names are ordinary JSON keys, so camelCase is allowed; nothing executable. */
const propertyKey = z.string().regex(/^[a-z][a-zA-Z0-9-]{0,47}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
/** Deliberately bounded declarative state language; no executable validators from imports. */
export type StateShape = { type: 'string'; maxLength: number } | { type: 'number' } | { type: 'boolean' }
  | { type: 'array'; maxItems: number; items: StateShape }
  | { type: 'object'; properties: Record<string, StateShape> };
export function validateStateShape(value: unknown, depth = 0): StateShape {
  if (depth > 6) throw new Error('invalid-input');
  const base = z.object({ type: z.string() }).passthrough().parse(value);
  if (base.type === 'string') return z.object({ type: z.literal('string'), maxLength: z.number().int().min(1).max(100000) }).strict().parse(value);
  if (base.type === 'number' || base.type === 'boolean') return z.object({ type: z.enum(['number', 'boolean']) }).strict().parse(value) as StateShape;
  if (base.type === 'array') {
    const item = z.object({ type: z.literal('array'), maxItems: z.number().int().min(1).max(1000), items: z.unknown() }).strict().parse(value);
    return { ...item, items: validateStateShape(item.items, depth + 1) };
  }
  const item = z.object({ type: z.literal('object'), properties: z.record(propertyKey, z.unknown()) }).strict().parse(value);
  if (Object.keys(item.properties).length > 32) throw new Error('invalid-input');
  return { type: 'object', properties: Object.fromEntries(Object.entries(item.properties).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, shape]) => [key, validateStateShape(shape, depth + 1)])) };
}
function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, child]) => [key, normalized(child)]));
  return value;
}
export function acceptsState(shape: StateShape, value: unknown): boolean {
  if (shape.type === 'string') return typeof value === 'string' && value.length <= shape.maxLength;
  if (shape.type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (shape.type === 'boolean') return typeof value === 'boolean';
  if (shape.type === 'array') return Array.isArray(value) && value.length <= shape.maxItems && value.every(item => acceptsState(shape.items, item));
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === Object.keys(shape.properties).length
    && Object.entries(shape.properties).every(([key, child]) => Object.hasOwn(record, key) && acceptsState(child, record[key]));
}
export const stateShapeSchema = z.unknown().transform((value, ctx): StateShape => {
  try { return validateStateShape(value); } catch { ctx.addIssue({ code: 'custom', message: 'Unsupported or unbounded component state shape' }); return z.NEVER; }
});
const componentResourceSchema = z.object({ resourceId: z.uuid(), sha256: digest,
  byteLength: z.number().int().min(1).max(1048576), mediaType: z.enum(['text/html', 'application/wasm', 'application/json']) }).strict();
/** A restricted WebAssembly algorithm: no imports, one bounded linear memory, one exported entry. */
const componentAlgorithmSchema = z.object({ resource: componentResourceSchema,
  mediaType: z.literal('application/wasm'), entry: identifier,
  /** 64 KiB pages the adapter must cap the module's linear memory to before instantiation. */
  memoryPages: z.number().int().min(1).max(256) }).strict();
const componentOperationSchema = z.object({ operationId: identifier, effect: z.literal('execute'),
  parameters: stateShapeSchema, result: stateShapeSchema,
  /** Declared per-operation budgets; never larger than the adapter's own ceiling. */
  budgets: z.object({ timeMs: z.number().int().min(50).max(5000), outputBytes: z.number().int().min(1).max(1048576) }).strict()
}).strict();
export const componentManifestSchema = z.object({
  formatVersion: z.literal(1), componentId: z.uuid(), version: z.number().int().positive(),
  hostApiVersion: z.literal(1), title: z.string().min(1).max(100),
  entry: z.object({ resourceId: z.uuid(), sha256: digest, byteLength: z.number().int().min(1).max(1000000), mediaType: z.literal('text/html') }).strict(),
  stateVersion: z.number().int().positive(), stateShape: stateShapeSchema, initialState: z.unknown().transform(normalized),
  requiredCapabilities: z.array(z.enum(['workspace.read', 'workspace.change', 'execution.submit'])).max(3),
  algorithm: componentAlgorithmSchema.optional(),
  operations: z.array(componentOperationSchema).max(4).optional(),
}).strict()
  .refine(value => acceptsState(value.stateShape, value.initialState), 'Initial state does not match its declared structure')
  .refine(value => !value.operations || value.algorithm !== undefined, 'Declared operations require a restricted algorithm resource')
  .refine(value => !value.operations || value.requiredCapabilities.includes('execution.submit'), 'Declared operations require the execution capability')
  .refine(value => !value.operations || new Set(value.operations.map(item => item.operationId)).size === value.operations.length,
    'Operation identities must be unique')
  .refine(value => !value.algorithm || value.algorithm.resource.mediaType === value.algorithm.mediaType,
    'Algorithm resource media type must be WebAssembly');
export type ComponentManifest = z.infer<typeof componentManifestSchema>;
export const componentDefinitionSchema = z.object({ manifest: componentManifestSchema, digest }).strict();
export type ComponentDefinition = z.infer<typeof componentDefinitionSchema>;
export const componentBundleSchema = z.object({ definition: componentDefinitionSchema, contentBase64: z.string().max(1400000) }).strict();
/** Extra resources are optional, so every previously annotated component keeps its own import shape. */
export const componentImportSchema = z.object({ requestId: z.uuid(), manifest: componentManifestSchema,
  contentBase64: z.string().max(1400000), algorithmBase64: z.string().max(1400000).optional() }).strict()
  .refine(value => !value.manifest.algorithm || value.algorithmBase64 !== undefined,
    'A declared algorithm must be uploaded with the manifest that pins it');
/** The algorithm is delivered only through the authorised release, never from the component view. */
export const componentAlgorithmBundleSchema = z.object({ definition: componentDefinitionSchema,
  mediaType: z.literal('application/wasm'), entry: identifier, memoryPages: z.number().int().min(1).max(256),
  sha256: digest, byteLength: z.number().int().positive(), contentBase64: z.string().max(1400000) }).strict();
export type ComponentAlgorithmBundle = z.infer<typeof componentAlgorithmBundleSchema>;
export const componentBindingSchema = z.object({ key: identifier, definition: componentDefinitionSchema,
  configuration: z.object({ title: z.string().min(1).max(200) }).strict(), materialIds: z.array(z.uuid()).max(20) }).strict();
export type ComponentBinding = z.infer<typeof componentBindingSchema>;
export const componentBindingsSchema = z.array(componentBindingSchema).max(8)
  .refine(items => new Set(items.map(item => item.key)).size === items.length);
export const componentMessageSchema = z.object({ hostApiVersion: z.literal(1), connectionId: z.uuid(), instanceId: z.string().min(1).max(300),
  messageId: z.uuid(), method: z.enum(['component.ready', 'workspace.read', 'workspace.change', 'component.event', 'component.close',
    'execution.capabilities', 'execution.submit', 'execution.query', 'execution.stop', 'execution.control', 'reference.select', 'reference.locate']),
  payload: z.unknown() }).strict();
export const componentChangeSchema = z.object({ operationId: z.uuid(), expectedContentId: z.uuid().nullable(), contentId: z.uuid(), content: z.unknown() }).strict();
/** The component fixes only what it legitimately knows; basis, plan and limits come from the host manifest. */
export const componentExecutionSubmitSchema = z.object({ requestId: z.uuid(), operationId: identifier,
  parameters: z.unknown(), expectedContentId: z.uuid().nullable() }).strict();
export const componentExecutionQuerySchema = z.object({ requestId: z.uuid(), inputDigest: digest.optional() }).strict();
export const componentExecutionStopSchema = z.object({ requestId: z.uuid(), stopId: z.uuid(), inputDigest: digest.optional() }).strict();
export const componentStateSchema = z.object({ formatVersion: z.literal(1), instanceId: z.string().min(1).max(300),
  componentId: z.uuid(), version: z.number().int().positive(), definitionDigest: digest, stateVersion: z.number().int().positive(),
  operationId: z.uuid(), content: z.unknown() }).strict();
export function componentInstanceId(activityId: string, key: string) { return `${activityId}:${key}`; }
export function componentStateName(key: string) { return `components/${key}.json`; }
