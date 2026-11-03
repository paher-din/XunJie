import { z } from 'zod';

const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
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
  const item = z.object({ type: z.literal('object'), properties: z.record(identifier, z.unknown()) }).strict().parse(value);
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
export const componentManifestSchema = z.object({
  formatVersion: z.literal(1), componentId: z.uuid(), version: z.number().int().positive(),
  hostApiVersion: z.literal(1), title: z.string().min(1).max(100),
  entry: z.object({ resourceId: z.uuid(), sha256: digest, byteLength: z.number().int().min(1).max(1000000), mediaType: z.literal('text/html') }).strict(),
  stateVersion: z.number().int().positive(), stateShape: stateShapeSchema, initialState: z.unknown().transform(normalized),
  requiredCapabilities: z.array(z.enum(['workspace.read', 'workspace.change'])).max(2),
}).strict().refine(value => acceptsState(value.stateShape, value.initialState), 'Initial state does not match its declared structure');
export type ComponentManifest = z.infer<typeof componentManifestSchema>;
export const componentDefinitionSchema = z.object({ manifest: componentManifestSchema, digest }).strict();
export type ComponentDefinition = z.infer<typeof componentDefinitionSchema>;
export const componentBundleSchema = z.object({ definition: componentDefinitionSchema, contentBase64: z.string().max(1400000) }).strict();
export const componentImportSchema = z.object({ requestId: z.uuid(), manifest: componentManifestSchema,
  contentBase64: z.string().max(1400000) }).strict().refine(value => value.manifest.componentId === value.manifest.componentId.toLowerCase(),
    'New component registrations require canonical lowercase UUIDs');
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
export const componentStateSchema = z.object({ formatVersion: z.literal(1), instanceId: z.string().min(1).max(300),
  componentId: z.uuid(), version: z.number().int().positive(), definitionDigest: digest, stateVersion: z.number().int().positive(),
  operationId: z.uuid(), content: z.unknown() }).strict();
const eventValue = z.union([z.string().max(4000), z.number().finite(), z.boolean(), z.null()]);
const eventIdentity = { formatVersion: z.literal(1), eventId: z.uuid(), sequence: z.number().int().positive() };
export const componentEventSchema = z.discriminatedUnion('kind', [
  z.object({ ...eventIdentity, kind: z.literal('control-change'), controlId: identifier, value: eventValue }).strict(),
  z.object({ ...eventIdentity, kind: z.literal('answer'), promptId: identifier, value: z.string().max(4000) }).strict(),
  z.object({ ...eventIdentity, kind: z.literal('prediction'), promptId: identifier, value: z.string().max(4000) }).strict(),
  z.object({ ...eventIdentity, kind: z.literal('confirmation'), targetId: identifier, confirmed: z.boolean() }).strict(),
]);
export type ComponentEvent = z.infer<typeof componentEventSchema>;
export const componentRequestSchema = z.union([
  componentMessageSchema.extend({ method: z.enum(['component.ready', 'component.close', 'workspace.read']), payload: z.object({}).strict() }),
  componentMessageSchema.extend({ method: z.literal('workspace.change'), payload: componentChangeSchema }),
  componentMessageSchema.extend({ method: z.literal('component.event'), payload: componentEventSchema }),
  componentMessageSchema.extend({ method: z.enum(['execution.capabilities', 'execution.submit', 'execution.query', 'execution.stop', 'execution.control', 'reference.select', 'reference.locate']) }),
]);
const hostEnvelope = z.object({ hostApiVersion: z.literal(1), connectionId: z.uuid(), instanceId: z.string().min(1).max(300),
  messageId: z.uuid(), method: z.string().min(1).max(80) });
export const componentInitializeSchema = hostEnvelope.extend({ method: z.literal('host.initialize'), payload: z.object({
  binding: componentBindingSchema, theme: z.record(z.string().max(50), z.string().max(1000)),
  materials: z.array(z.object({ title: z.string().max(300), text: z.string().max(8000000) }).strict()).max(20), readOnly: z.boolean(),
  titleFont: z.object({ base64: z.string().max(1500000), sha256: digest }).strict(),
}).strict() }).strict();
const successEnvelope = hostEnvelope.extend({ replyTo: z.uuid() });
export const componentSuccessSchema = z.union([
  successEnvelope.extend({ method: z.literal('component.ready'), payload: z.object({ ready: z.literal(true) }).strict() }).strict(),
  successEnvelope.extend({ method: z.literal('component.close'), payload: z.object({ closed: z.literal(true) }).strict() }).strict(),
  successEnvelope.extend({ method: z.literal('workspace.read'), payload: z.object({ contentId: z.uuid().nullable(), content: z.unknown() }).strict() }).strict(),
  successEnvelope.extend({ method: z.literal('workspace.change'), payload: z.object({ inputDigest: digest,
    confirmation: z.literal('local-protected'), contentId: z.uuid().nullable(), requestedContentId: z.uuid(), superseded: z.boolean() }).strict() }).strict(),
  successEnvelope.extend({ method: z.literal('component.event'), payload: z.object({ received: z.literal(true),
    eventId: z.uuid(), sequence: z.number().int().positive(), kind: z.enum(['control-change', 'answer', 'prediction', 'confirmation']) }).strict() }).strict(),
]);
export const componentErrorSchema = hostEnvelope.extend({ replyTo: z.uuid(), payload: z.null(), error: z.object({
  code: z.enum(['invalid-input', 'unsupported-version', 'capability-unavailable', 'forbidden', 'stale-connection', 'conflict', 'resource-unavailable', 'outcome-unknown']),
  next: z.string().min(1).max(1000),
}).strict() }).strict();
export const componentHostMessageSchema = z.union([componentInitializeSchema, componentSuccessSchema, componentErrorSchema]);
export function componentReply(context: { connectionId: string; instanceId: string }, request: { messageId: string; method: string },
  outcome: { payload: unknown } | { error: unknown }, messageId: string) {
  return componentHostMessageSchema.parse({ hostApiVersion: 1, connectionId: context.connectionId, instanceId: context.instanceId, messageId,
    method: request.method, replyTo: request.messageId, ...('error' in outcome ? { payload: null, error: outcome.error } : outcome) });
}
export function componentInstanceId(activityId: string, key: string) { return `${activityId}:${key}`; }
export function componentStateName(key: string) { return `components/${key}.json`; }
export const componentStateMediaType = 'application/vnd.xunjie.component-state+json';
/** Pure binding invariants only; each boundary must still authorize its real subject. */
export function matchesComponentState(binding: ComponentBinding, activityId: string,
  file: { name: string; kind: string; encoding: string; mediaType: string; value: string }): boolean {
  try {
    const value = componentStateSchema.parse(JSON.parse(file.value)), manifest = binding.definition.manifest;
    return file.name === componentStateName(binding.key) && file.kind === 'state' && file.encoding === 'json'
      && file.mediaType === componentStateMediaType && value.instanceId === componentInstanceId(activityId, binding.key)
      && value.componentId === manifest.componentId && value.version === manifest.version
      && value.definitionDigest === binding.definition.digest && value.stateVersion === manifest.stateVersion
      && acceptsState(manifest.stateShape, value.content);
  } catch { return false; }
}
