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
export const componentCapabilities = ['workspace.read', 'workspace.change', 'material.highlight'] as const;
export type ComponentCapability = typeof componentCapabilities[number];

/**
 * A locked browser dependency: exact package/version plus the immutable resource its bytes must match.
 * Only the resource digest authorizes execution; package coordinates record provenance.
 */
export const componentDependencySchema = z.object({
  dependencyId: identifier, package: z.string().min(1).max(100),
  version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/), role: z.literal('script'),
  resourceId: z.uuid(), sha256: digest, byteLength: z.number().int().min(1).max(2000000),
  mediaType: z.literal('text/javascript'), loadOrder: z.number().int().min(0).max(7),
  preparationTypes: z.array(z.literal('browser')).min(1).max(1),
}).strict();
export type ComponentDependency = z.infer<typeof componentDependencySchema>;
/** Features this host actually implements; an unknown required feature is refused, not ignored. */
export const componentEnvironmentSchema = z.object({
  preparationType: z.literal('browser'), preparationProtocolVersion: z.literal(1),
  requiredFeatures: z.array(z.enum(['message-port', 'crypto-subtle', 'indexeddb', 'sandboxed-iframe'])).max(8),
  selfTestVersion: z.number().int().positive(),
  capabilityDependencies: z.array(z.object({ capability: z.enum(componentCapabilities), dependencyIds: z.array(identifier).max(8) }).strict()).max(8),
}).strict();
export type ComponentEnvironment = z.infer<typeof componentEnvironmentSchema>;
/** Limits measured against the annotation sample; not a capacity promise for other components. */
export const componentBudgetSchema = z.object({
  resourceCount: z.number().int().min(1).max(8), totalResourceBytes: z.number().int().min(1).max(4000000),
  messageBytes: z.number().int().min(1024).max(2100000),
  preparationTimeoutMs: z.number().int().min(1000).max(300000), selfTestTimeoutMs: z.number().int().min(1000).max(120000),
  parallelism: z.number().int().min(1).max(4), cacheScope: z.literal('device-local'),
}).strict();
export type ComponentBudget = z.infer<typeof componentBudgetSchema>;
/** Typed, bounded self-test declarations; deliberately not a scriptable workflow engine. */
export const componentSelfTestStepSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('dependency-loads'), checkId: identifier, dependencyIds: z.array(identifier).min(1).max(4),
    expect: z.object({ globalName: z.string().min(1).max(64) }).strict() }).strict(),
  z.object({ kind: z.literal('highlight-matches'), checkId: identifier, quote: z.string().min(1).max(500),
    expect: z.object({ marks: z.number().int().min(0).max(50), markedText: z.string().max(500) }).strict() }).strict(),
  z.object({ kind: z.literal('highlight-releases'), checkId: identifier, quote: z.string().min(1).max(500),
    expect: z.object({ marks: z.literal(0), bodyText: z.string().min(1).max(4000) }).strict() }).strict(),
  z.object({ kind: z.literal('annotation-roundtrip'), checkId: identifier, quote: z.string().min(1).max(500), note: z.string().max(4000),
    expect: z.object({ annotations: z.number().int().min(0).max(100), note: z.string().max(4000) }).strict() }).strict(),
  z.object({ kind: z.literal('invalid-input-rejected'), checkId: identifier, quote: z.string().max(5000),
    expect: z.object({ annotations: z.number().int().min(0).max(100), rejected: z.literal(true) }).strict() }).strict(),
]);
export type ComponentSelfTestStep = z.infer<typeof componentSelfTestStepSchema>;
export const componentSelfTestSchema = z.object({
  selfTestVersion: z.number().int().positive(),
  material: z.object({ title: z.string().min(1).max(100), text: z.string().min(1).max(4000) }).strict(),
  steps: z.array(componentSelfTestStepSchema).min(1).max(16),
}).strict().refine(value => new Set(value.steps.map(step => step.checkId)).size === value.steps.length, 'Check identifiers must be unique');
export type ComponentSelfTest = z.infer<typeof componentSelfTestSchema>;

export const componentPreparedManifestSchema = z.object({
  formatVersion: z.literal(2), componentId: z.uuid(), version: z.number().int().positive(),
  hostApiVersion: z.literal(1), preparationProtocolVersion: z.literal(1), title: z.string().min(1).max(100),
  entry: z.object({ resourceId: z.uuid(), sha256: digest, byteLength: z.number().int().min(1).max(1000000), mediaType: z.literal('text/html') }).strict(),
  dependencies: z.array(componentDependencySchema).min(1).max(8),
  environment: componentEnvironmentSchema, budget: componentBudgetSchema, selfTest: componentSelfTestSchema,
  stateVersion: z.number().int().positive(), stateShape: stateShapeSchema, initialState: z.unknown().transform(normalized),
  requiredCapabilities: z.array(z.enum(componentCapabilities)).max(3),
}).strict()
  .refine(value => acceptsState(value.stateShape, value.initialState), 'Initial state does not match its declared structure')
  .refine(value => value.environment.selfTestVersion === value.selfTest.selfTestVersion, 'Self-test version is declared twice with different values')
  .refine(value => new Set(value.dependencies.map(item => item.dependencyId)).size === value.dependencies.length, 'Dependency identifiers must be unique')
  .refine(value => new Set(value.dependencies.map(item => item.loadOrder)).size === value.dependencies.length, 'Load order must be unique')
  .refine(value => new Set(value.dependencies.map(item => item.resourceId)).size === value.dependencies.length, 'Dependency resources must be unique')
  .refine(value => value.dependencies.every(item => item.resourceId !== value.entry.resourceId), 'A dependency cannot reuse the entry resource')
  .refine(value => value.dependencies.reduce((total, item) => total + item.byteLength, value.entry.byteLength) <= value.budget.totalResourceBytes,
    'Declared resources exceed the component budget')
  .refine(value => value.dependencies.length + 1 <= value.budget.resourceCount, 'Declared resource count exceeds the component budget')
  .refine(value => value.environment.capabilityDependencies.every(item => item.dependencyIds.every(id => value.dependencies.some(entry => entry.dependencyId === id))),
    'A capability depends on an undeclared dependency');
export type ComponentPreparedManifest = z.infer<typeof componentPreparedManifestSchema>;
/** Format versions stay separate branches: a v1 definition must never gain defaulted v2 fields, which would move its digest. */
export const componentAnyManifestSchema = z.union([componentManifestSchema, componentPreparedManifestSchema]);
export type ComponentAnyManifest = z.infer<typeof componentAnyManifestSchema>;
export function manifestDependencies(manifest: ComponentAnyManifest): ComponentDependency[] {
  return manifest.formatVersion === 1 ? [] : [...manifest.dependencies].sort((a, b) => a.loadOrder - b.loadOrder);
}

export const componentDefinitionSchema = z.object({ manifest: componentAnyManifestSchema, digest }).strict();
export type ComponentDefinition = z.infer<typeof componentDefinitionSchema>;
export const componentBundleSchema = z.object({ definition: componentDefinitionSchema, contentBase64: z.string().max(1400000) }).strict();
export const componentResourceContentSchema = z.object({ resourceId: z.uuid(), contentBase64: z.string().max(2800000) }).strict();
export const componentImportSchema = z.object({ requestId: z.uuid(), manifest: componentAnyManifestSchema,
  contentBase64: z.string().max(1400000), dependencies: z.array(componentResourceContentSchema).max(8).optional() }).strict()
  .refine(value => value.manifest.formatVersion === 1 || value.dependencies !== undefined, 'A prepared component must submit its dependency resources')
  .refine(value => value.manifest.formatVersion === 2 || !value.dependencies, 'A format 1 component carries no dependency resources')
  .refine(value => {
    // Total on every branch: a missing list is reported above, never thrown from here as a non-validation error.
    if (value.manifest.formatVersion !== 2 || !value.dependencies) return true
    const submitted = value.dependencies
    return new Set(submitted.map(item => item.resourceId)).size === submitted.length
      && submitted.length === value.manifest.dependencies.length
      && manifestDependencies(value.manifest).every(item => submitted.some(content => content.resourceId === item.resourceId))
  }, 'Dependency resources must match the manifest exactly');
export type ComponentImport = z.infer<typeof componentImportSchema>;
/** Verified dependency bytes for an already-authorized client; never an arbitrary URL proxy. */
export const componentDependencyContentSchema = z.object({
  dependencyId: identifier, resourceId: z.uuid(), sha256: digest, byteLength: z.number().int().min(1).max(2000000),
  mediaType: z.literal('text/javascript'), contentBase64: z.string().max(2800000),
}).strict();
export type ComponentDependencyContent = z.infer<typeof componentDependencyContentSchema>;
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
/** Host-side validation of the handshake payload; a prepared component must be told which mode it is running in. */
export const componentInitializeSchema = z.object({
  hostApiVersion: z.literal(1), connectionId: z.uuid(), instanceId: z.string().min(1).max(300),
  messageId: z.uuid(), method: z.literal('host.initialize'),
  payload: z.object({
    binding: componentBindingSchema,
    theme: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), z.string().max(64)),
    materials: z.array(z.object({ title: z.string().min(1).max(300), text: z.string().max(16000000) }).strict()).max(20),
    readOnly: z.boolean(),
    preparation: z.object({ preparationProtocolVersion: z.literal(1), mode: z.enum(['production', 'preparation']) }).strict().optional(),
  }).strict(),
}).strict()
  .refine(value => value.payload.binding.definition.manifest.formatVersion === 1 || value.payload.preparation !== undefined,
    'A prepared component must be initialized with an explicit preparation mode');
export type ComponentInitialize = z.infer<typeof componentInitializeSchema>;
/** Preparation is its own protocol version, so a v1 host refuses these messages instead of ignoring them and writing on. */
export const componentPreparationRequestSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('preparation.load'),
    payload: z.object({ dependencies: z.array(z.object({ dependencyId: identifier, scriptBase64: z.string().max(2800000) }).strict()).min(1).max(8) }).strict() }).strict(),
  z.object({ method: z.literal('preparation.step'), payload: z.object({ step: componentSelfTestStepSchema }).strict() }).strict(),
  z.object({ method: z.literal('preparation.reset'), payload: z.object({}).strict() }).strict(),
]);
export type ComponentPreparationRequest = z.infer<typeof componentPreparationRequestSchema>;
export const componentPreparationMessageSchema = z.object({
  preparationProtocolVersion: z.literal(1), connectionId: z.uuid(), instanceId: z.string().min(1).max(300),
  messageId: z.uuid(), request: componentPreparationRequestSchema,
}).strict();
export type ComponentPreparationMessage = z.infer<typeof componentPreparationMessageSchema>;
/** Bounded observations only: an opaque iframe's DOM stays unreadable to the host, so the view reports fixed shapes. */
export const componentPreparationObservationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('loaded'), loaded: z.array(z.object({ dependencyId: identifier, globals: z.array(z.string().min(1).max(64)).max(8) }).strict()).max(8) }).strict(),
  z.object({ kind: z.literal('highlight'), marks: z.number().int().min(0).max(50),
    markedTexts: z.array(z.string().max(500)).max(50), bodyText: z.string().max(4000) }).strict(),
  z.object({ kind: z.literal('annotations'), annotations: z.number().int().min(0).max(100), note: z.string().max(4000), rejected: z.boolean() }).strict(),
  z.object({ kind: z.literal('reset'), reset: z.literal(true) }).strict(),
]);
export type ComponentPreparationObservation = z.infer<typeof componentPreparationObservationSchema>;
export const componentPreparationReplySchema = z.object({
  preparationProtocolVersion: z.literal(1), connectionId: z.uuid(), instanceId: z.string().min(1).max(300),
  replyTo: z.uuid(), observation: componentPreparationObservationSchema.optional(),
  error: z.object({ code: z.enum(['invalid-input', 'unsupported-version', 'capability-unavailable', 'forbidden',
    'stale-connection', 'conflict', 'resource-unavailable', 'outcome-unknown']) }).strict().optional(),
}).strict()
  .refine(value => (value.observation === undefined) !== (value.error === undefined),
    'A preparation reply carries exactly one of observation or error');
export type ComponentPreparationReply = z.infer<typeof componentPreparationReplySchema>;

export const preparationStatuses = ['unprepared', 'preparing', 'permission-required', 'repairable', 'unsupported-device', 'self-test-failed', 'ready'] as const;
export type PreparationStatus = typeof preparationStatuses[number];
/** Separates "never finished" from "ran and failed": an interrupted check is not a passed check. */
export const preparationVerificationSchema = z.enum(['unverified', 'interrupted', 'verified', 'failed']);
export type PreparationVerification = z.infer<typeof preparationVerificationSchema>;
export const capabilityAvailabilitySchema = z.enum(['available', 'limited', 'unavailable']);
export type CapabilityAvailability = z.infer<typeof capabilityAvailabilitySchema>;
export const preparationReasonCodes = ['none', 'resource-missing', 'resource-corrupt', 'dependency-version-mismatch', 'dependency-load-failed',
  'device-feature-missing', 'protocol-unsupported', 'budget-exceeded', 'storage-unavailable', 'permission-pending',
  'self-test-failed', 'self-test-interrupted', 'self-test-mismatch', 'outcome-unknown', 'unsupported'] as const;
export type PreparationReasonCode = typeof preparationReasonCodes[number];
export const preparationCapabilitySchema = z.object({
  capability: z.enum(componentCapabilities), availability: capabilityAvailabilitySchema,
  reason: z.enum(preparationReasonCodes), verification: preparationVerificationSchema,
  limitation: z.string().max(300).optional(),
}).strict();
export type PreparationCapability = z.infer<typeof preparationCapabilitySchema>;
export const preparationDeviceSchema = z.object({
  platform: z.string().min(1).max(64), browser: z.string().min(1).max(64), browserVersion: z.string().max(64),
  features: z.array(z.string().min(1).max(64)).max(16), preparationImplementationVersion: z.number().int().positive(),
}).strict();
export type PreparationDevice = z.infer<typeof preparationDeviceSchema>;
export const preparationStageSchema = z.enum(['resolve', 'identity', 'detect', 'fetch', 'verify', 'load', 'self-test', 'persist', 'activate']);
export type PreparationStage = z.infer<typeof preparationStageSchema>;
/**
 * A device-local diagnostic record. It states what one device observed; it is never a ready credential for
 * another device, and it grants no installation, execution or eligibility.
 */
export const componentPreparationReportSchema = z.object({
  formatVersion: z.literal(1), componentId: z.uuid(), version: z.number().int().positive(), definitionDigest: digest,
  preparationProtocolVersion: z.literal(1), selfTestVersion: z.number().int().positive(),
  hostVersion: z.string().min(1).max(64), device: preparationDeviceSchema,
  status: z.enum(preparationStatuses), reason: z.enum(preparationReasonCodes),
  stage: preparationStageSchema, capabilities: z.array(preparationCapabilitySchema).max(8),
  durationMs: z.number().int().min(0).max(3600000),
  resourceBytes: z.number().int().min(0).max(100000000),
  cacheHit: z.boolean(), preview: z.boolean(),
  memoryNote: z.string().max(300).optional(),
}).strict();
export type ComponentPreparationReport = z.infer<typeof componentPreparationReportSchema>;
export const componentPreparationReportSubmissionSchema = z.object({ reportId: z.uuid(), requestId: z.uuid(), report: componentPreparationReportSchema }).strict();
export type ComponentPreparationReportSubmission = z.infer<typeof componentPreparationReportSubmissionSchema>;
export const componentPreparationReportReceiptSchema = z.object({ reportId: z.uuid(), report: componentPreparationReportSchema }).strict();
export type ComponentPreparationReportReceipt = z.infer<typeof componentPreparationReportReceiptSchema>;
export const componentPreparationReportsSchema = z.array(componentPreparationReportSchema).max(50);

export function componentInstanceId(activityId: string, key: string) { return `${activityId}:${key}`; }
export function componentStateName(key: string) { return `components/${key}.json`; }
/** A preparation instance is a separate identity, so a self-test cannot address a student's state object. */
export function componentTestInstanceId(preparationId: string, key: string) { return `preparation:${preparationId}:${key}`; }
export function componentDependencyReference(componentId: string, version: number, dependencyId: string) {
  return `component/${componentId}/${version}/dependency/${dependencyId}`;
}
