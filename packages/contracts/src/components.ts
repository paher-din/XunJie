import { questionReferenceInputSchema, questionReferenceRangeSchema, questionReferenceSourceSchema } from './question-drafts.js';
import { z } from 'zod';

const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
/** Shape property names are ordinary JSON keys, so camelCase is allowed; nothing executable. */
const propertyKey = z.string().regex(/^[a-zA-Z][a-zA-Z0-9-]{0,47}$/);
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
/**
 * A native stateful adapter shipped with the product. The manifest names it and declares the
 * bounded input/observation shapes; it never supplies a command, path or environment.
 */
const componentSessionSchema = z.object({
  adapterId: identifier, adapterVersion: z.number().int().positive(),
  /** Fixed parameters the session is created with; the input operation has its own shape. */
  parameters: stateShapeSchema,
  operation: z.object({ operationId: identifier, parameters: stateShapeSchema, result: stateShapeSchema }).strict(),
  controls: z.array(z.enum(['pause', 'resume', 'step', 'reset', 'checkpoint'])).max(5).optional(),
  checkpointVersion: z.number().int().positive().optional(),
  lifecycle: z.object({ acrossViews: z.literal(true), pageClose: z.literal('continue'),
    activityClose: z.literal('stop'), reconnect: z.literal('query') }).strict().optional(),
  budgets: z.object({
    operationTimeoutMs: z.number().int().min(50).max(30000),
    idleMs: z.number().int().min(1000).max(3600000),
    maxMs: z.number().int().min(1000).max(86400000),
    memoryMiB: z.number().int().min(16).max(512),
    inputBytes: z.number().int().min(1).max(1048576),
    outputBytes: z.number().int().min(1).max(1048576),
    concurrentSessions: z.number().int().min(1).max(4),
    queuedSessions: z.number().int().min(0).max(16),
  }).strict(),
}).strict();
export const componentManifestSchema = z.object({
  formatVersion: z.literal(1), componentId: z.uuid(), version: z.number().int().positive(),
  hostApiVersion: z.literal(1), title: z.string().min(1).max(100),
  entry: z.object({ resourceId: z.uuid(), sha256: digest, byteLength: z.number().int().min(1).max(1000000), mediaType: z.literal('text/html') }).strict(),
  stateVersion: z.number().int().positive(), stateShape: stateShapeSchema, initialState: z.unknown().transform(normalized),
  requiredCapabilities: z.array(z.enum(['workspace.read', 'workspace.change', 'execution.submit'])).max(3),
  algorithm: componentAlgorithmSchema.optional(),
  operations: z.array(componentOperationSchema).max(4).optional(),
  session: componentSessionSchema.optional(),
}).strict()
  .refine(value => acceptsState(value.stateShape, value.initialState), 'Initial state does not match its declared structure')
  .refine(value => !value.operations || value.algorithm !== undefined, 'Declared operations require a restricted algorithm resource')
  .refine(value => !value.operations || value.requiredCapabilities.includes('execution.submit'), 'Declared operations require the execution capability')
  .refine(value => !value.operations || new Set(value.operations.map(item => item.operationId)).size === value.operations.length,
    'Operation identities must be unique')
  .refine(value => !value.algorithm || value.algorithm.resource.mediaType === value.algorithm.mediaType,
    'Algorithm resource media type must be WebAssembly')
  .refine(value => !value.session || (!value.algorithm && !value.operations), 'A native session component carries no browser algorithm')
  .refine(value => !value.session || value.requiredCapabilities.includes('execution.submit'),
    'A native session component requires the execution capability')
  .refine(value => !value.session?.controls || new Set(value.session.controls).size === value.session.controls.length,
    'Session controls must be unique')
  .refine(value => !value.session || !!value.session.checkpointVersion === !!value.session.controls?.includes('checkpoint'),
    'Checkpoint support requires an explicit format version');
export type ComponentManifest = z.infer<typeof componentManifestSchema>;
export const componentCapabilities = ['workspace.read', 'workspace.change', 'material.highlight'] as const;
export type ComponentCapability = typeof componentCapabilities[number];
/**
 * A format 3 runtime is the only component that can ask for a real executor. It is a separate list
 * rather than an extra member of the one above, so a format 1 or 2 manifest still cannot declare it.
 */
export const componentRuntimeCapabilities = ['workspace.read', 'workspace.change', 'execution.submit'] as const;
export type ComponentRuntimeCapability = typeof componentRuntimeCapabilities[number];

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

/**
 * A fixed multi-resource browser runtime. The host ships the executor code for an Adapter it knows;
 * the course declares only that identity and pins the exact resources the Adapter will read. A course
 * resource can therefore never turn itself into a host adapter.
 */
export const componentRuntimeResourceRoles = ['toolchain-script', 'toolchain-wasm', 'data', 'scaffold', 'attachment'] as const;
export const componentRuntimeResourceSchema = z.object({
  resourceId: z.uuid(), sha256: digest, byteLength: z.number().int().min(1).max(8388608),
  /** Relative to the runtime root; unique, no traversal. The Adapter resolves files by this path. */
  path: z.string().min(1).max(200),
  role: z.enum(componentRuntimeResourceRoles),
  mediaType: z.enum(['text/javascript', 'application/wasm', 'application/json', 'text/plain', 'application/pdf', 'application/gzip']),
}).strict();
export type ComponentRuntimeResource = z.infer<typeof componentRuntimeResourceSchema>;

/** The only operation a fixed ALU-style runtime exposes in this format version. */
export const componentRunOperationSchema = z.object({
  operationId: identifier, effect: z.literal('execute'),
  /** A/B/M/S/Cin and nothing else; every control input is binary, outputs keep their four states. */
  parameters: stateShapeSchema,
  /** Fixed compilation inputs. The student's file set is the include closure this names, not a guess. */
  compile: z.object({
    top: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_$]{0,199}$/),
    entryFiles: z.array(z.string().min(1).max(200)).min(1).max(64),
    includeDirs: z.array(z.string().min(1).max(200)).max(32),
    strictExprWidth: z.boolean().optional(),
  }).strict(),
  /** How the observation is read back: read-only scaffold, public ports and result format. */
  observation: z.object({
    scaffoldResourceId: z.uuid(), scaffoldVersion: z.number().int().positive(),
    ports: z.object({ result: z.string().min(1).max(64), carry: z.string().min(1).max(64) }).strict(),
    resultFormat: z.literal('xunjie-observations-v1'),
  }).strict(),
  result: stateShapeSchema,
  budgets: z.object({
    compileTimeoutMs: z.number().int().min(1000).max(30000),
    simulateTimeoutMs: z.number().int().min(100).max(5000),
    jobTimeoutMs: z.number().int().min(1000).max(40000),
    memoryMiB: z.number().int().min(16).max(512),
    inputBytes: z.number().int().min(1).max(1048576),
    textBytes: z.number().int().min(1024).max(2097152),
    vcdBytes: z.number().int().min(1024).max(8388608),
    resultBytes: z.number().int().min(1024).max(16777216),
  }).strict(),
}).strict();
export type ComponentRunOperation = z.infer<typeof componentRunOperationSchema>;

const componentRuntimeSchema = z.object({
  /** Host-shipped executor; the course names it and can never supply its code. */
  adapterId: identifier, adapterVersion: z.number().int().positive(),
  /** Identity of the whole fixed file set the Adapter reads, recomputed by the host before any run. */
  bundleIdentity: digest,
  resources: z.array(componentRuntimeResourceSchema).min(1).max(32),
  operations: z.array(componentRunOperationSchema).min(1).max(4),
}).strict()
  .refine(value => new Set(value.resources.map(item => item.resourceId)).size === value.resources.length,
    'Runtime resource identities must be unique')
  .refine(value => new Set(value.resources.map(item => item.path)).size === value.resources.length,
    'Runtime resource paths must be unique')
  .refine(value => value.resources.every(item => item.path.split('/').every(part => part && part !== '.' && part !== '..')
    && !item.path.startsWith('/') && !item.path.includes('\\')), 'Runtime resource paths must be relative and traversal-free')
  .refine(value => new Set(value.operations.map(item => item.operationId)).size === value.operations.length,
    'Runtime operation identities must be unique')
  .refine(value => value.resources.filter(item => item.role === 'toolchain-script' || item.role === 'toolchain-wasm')
    .every(item => item.mediaType === 'text/javascript' || item.mediaType === 'application/wasm'),
  'Executable runtime resources must be JavaScript or WebAssembly')
  .refine(value => value.resources.filter(item => item.role === 'scaffold').every(item => item.mediaType === 'text/plain'),
    'A sampling scaffold is fixed Verilog text')
  .refine(value => value.operations.every(operation => value.resources.some(item =>
    item.resourceId === operation.observation.scaffoldResourceId && item.role === 'scaffold')),
  'An operation must observe through a declared scaffold resource')
  .refine(value => value.resources.reduce((total, item) => total + item.byteLength, 0) <= 16777216,
    'Runtime resources exceed the declared 16 MiB preparation budget');

/** Format 3 preparation: a real toolchain rather than a script bundle, so the feature set is explicit. */
export const componentRuntimeEnvironmentSchema = z.object({
  preparationType: z.literal('browser'), preparationProtocolVersion: z.literal(2),
  requiredFeatures: z.array(z.enum(['worker', 'webassembly', 'crypto-subtle', 'indexeddb', 'message-port', 'web-locks'])).max(8),
  selfTestVersion: z.number().int().positive(),
}).strict();
export type ComponentRuntimeEnvironment = z.infer<typeof componentRuntimeEnvironmentSchema>;

/** A self-check that really compiles and simulates a fixed miniature module; it reads no student work. */
export const componentRuntimeSelfTestSchema = z.object({
  selfTestVersion: z.number().int().positive(),
  fixture: z.object({
    resourceId: z.uuid(), path: z.string().min(1).max(200), top: z.string().min(1).max(200),
    /** The exact four-state observation a correct toolchain produces for this fixture. */
    expect: z.object({ result: z.string().regex(/^[01xz]{1,32}$/), carry: z.string().regex(/^[01xz]$/) }).strict(),
  }).strict(),
  timeoutMs: z.number().int().min(1000).max(120000),
}).strict();

/** Budgets measured for a fixed toolchain; the Adapter enforces them, this only declares them. */
export const componentRuntimeBudgetSchema = z.object({
  resourceCount: z.number().int().min(1).max(32), totalResourceBytes: z.number().int().min(1).max(16777216),
  preparationTimeoutMs: z.number().int().min(1000).max(300000), selfTestTimeoutMs: z.number().int().min(1000).max(120000),
  concurrentJobs: z.number().int().min(1).max(2), queuedJobs: z.number().int().min(0).max(4),
  cacheScope: z.literal('device-local'),
}).strict();

export const componentRuntimeManifestSchema = z.object({
  formatVersion: z.literal(3), componentId: z.uuid(), version: z.number().int().positive(),
  hostApiVersion: z.literal(1), preparationProtocolVersion: z.literal(2), title: z.string().min(1).max(100),
  entry: z.object({ resourceId: z.uuid(), sha256: digest, byteLength: z.number().int().min(1).max(1000000),
    mediaType: z.literal('text/html') }).strict(),
  stateVersion: z.number().int().positive(), stateShape: stateShapeSchema, initialState: z.unknown().transform(normalized),
  requiredCapabilities: z.array(z.enum(componentRuntimeCapabilities)).max(3),
  runtime: componentRuntimeSchema,
  environment: componentRuntimeEnvironmentSchema, budget: componentRuntimeBudgetSchema,
  selfTest: componentRuntimeSelfTestSchema,
}).strict()
  .refine(value => acceptsState(value.stateShape, value.initialState), 'Initial state does not match its declared structure')
  .refine(value => value.requiredCapabilities.includes('execution.submit'), 'A runtime component requires the execution capability')
  .refine(value => value.environment.selfTestVersion === value.selfTest.selfTestVersion,
    'Self-test version is declared twice with different values')
  .refine(value => value.runtime.resources.length + 1 <= value.budget.resourceCount,
    'Declared resource count exceeds the component budget')
  .refine(value => value.runtime.resources.reduce((total, item) => total + item.byteLength, value.entry.byteLength)
    <= value.budget.totalResourceBytes, 'Declared resources exceed the component budget')
  .refine(value => value.runtime.resources.some(item => item.resourceId === value.selfTest.fixture.resourceId),
    'The self-test fixture must be a declared runtime resource')
  .refine(value => value.runtime.resources.every(item => item.resourceId !== value.entry.resourceId),
    'A runtime resource cannot reuse the entry resource');
export type ComponentRuntimeManifest = z.infer<typeof componentRuntimeManifestSchema>;

/** Format versions stay separate branches: a v1 definition must never gain defaulted v2/v3 fields, which would move its digest. */
export const componentAnyManifestSchema = z.union([componentManifestSchema, componentPreparedManifestSchema, componentRuntimeManifestSchema]);
export type ComponentAnyManifest = z.infer<typeof componentAnyManifestSchema>;
export function manifestDependencies(manifest: ComponentAnyManifest): ComponentDependency[] {
  // A format 3 runtime reads a fixed file set, not the v2 script-dependency list; it is not a dependency in that sense.
  if (manifest.formatVersion !== 2) return [];
  return [...manifest.dependencies].sort((a, b) => a.loadOrder - b.loadOrder);
}
/** Every resource a definition pins besides its entry, in a form the preparation/retention owners can iterate. */
export type ComponentManifestResource = { kind: 'algorithm'; resourceId: string; sha256: string; byteLength: number
  mediaType: string } | { kind: 'dependency'; resourceId: string; sha256: string; byteLength: number; mediaType: string }
  | { kind: 'runtime'; resourceId: string; path: string; role: string; sha256: string; byteLength: number; mediaType: string };
export function manifestResources(manifest: ComponentAnyManifest): ComponentManifestResource[] {
  if (manifest.formatVersion === 1) return manifest.algorithm ? [{ kind: 'algorithm' as const, ...manifest.algorithm.resource }] : [];
  if (manifest.formatVersion === 2) return manifest.dependencies.map(item => ({ kind: 'dependency' as const, resourceId: item.resourceId,
    sha256: item.sha256, byteLength: item.byteLength, mediaType: item.mediaType }));
  return manifest.runtime.resources.map(item => ({ kind: 'runtime' as const, resourceId: item.resourceId, path: item.path,
    role: item.role, sha256: item.sha256, byteLength: item.byteLength, mediaType: item.mediaType }));
}
/** The retained reference one non-entry resource is pinned under; the owner reads it by its own identity. */
export function componentResourceReference(manifest: ComponentAnyManifest,
  item: Pick<ComponentManifestResource, 'kind' | 'resourceId'> & { path?: string }): string {
  const scope = `component/${manifest.componentId}/${manifest.version}`;
  if (item.kind === 'algorithm') return `${scope}/algorithm`;
  if (item.kind === 'dependency') {
    const dependency = manifest.formatVersion === 2
      ? manifest.dependencies.find(entry => entry.resourceId === item.resourceId) : undefined;
    return componentDependencyReference(manifest.componentId, manifest.version, dependency?.dependencyId ?? item.resourceId);
  }
  // Runtime resources are addressed by their declared relative path, so a reader never guesses order.
  return `${scope}/runtime/${item.path}`;
}
/** The runtime an entry-level host must already ship before a format 3 definition may be mounted. */
export function runtimeAdapter(manifest: ComponentAnyManifest) {
  return manifest.formatVersion === 3 ? manifest.runtime : undefined;
}


export const componentDefinitionSchema = z.object({ manifest: componentAnyManifestSchema, digest }).strict();
export type ComponentDefinition = z.infer<typeof componentDefinitionSchema>;
export const componentBundleSchema = z.object({ definition: componentDefinitionSchema, contentBase64: z.string().max(1400000) }).strict();
export const componentResourceContentSchema = z.object({ resourceId: z.uuid(), contentBase64: z.string().max(2800000) }).strict();
/**
 * A format 3 upload is bounded by the largest single runtime file the manifest may declare (8 MiB), not by a
 * script. A script-sized bound would refuse a toolchain WASM that the same manifest legitimately pins.
 */
export const componentRuntimeUploadSchema = z.object({ resourceId: z.uuid(), contentBase64: z.string().max(11200000) }).strict();
export const componentImportSchema = z.object({ requestId: z.uuid(), manifest: componentAnyManifestSchema,
  contentBase64: z.string().max(1400000), algorithmBase64: z.string().max(1400000).optional(),
  dependencies: z.array(componentResourceContentSchema).max(8).optional(),
  /** Format 3 pins every runtime file; the upload must match it one-for-one. */
  runtimeResources: z.array(componentRuntimeUploadSchema).max(32).optional() }).strict()
  .refine(value => value.manifest.formatVersion !== 1 || !value.manifest.algorithm || value.algorithmBase64 !== undefined,
    'A declared algorithm must be uploaded with the manifest that pins it')
  .refine(value => value.manifest.formatVersion !== 2 || value.dependencies !== undefined, 'A prepared component must submit its dependency resources')
  .refine(value => value.manifest.formatVersion !== 1 || !value.dependencies, 'A format 1 component carries no dependency resources')
  .refine(value => value.manifest.formatVersion === 3 || !value.runtimeResources, 'Only a format 3 component carries runtime resources')
  .refine(value => {
    // Total on every branch: a missing list is reported above, never thrown from here as a non-validation error.
    if (value.manifest.formatVersion !== 2 || !value.dependencies) return true
    const submitted = value.dependencies
    return new Set(submitted.map(item => item.resourceId)).size === submitted.length
      && submitted.length === value.manifest.dependencies.length
      && manifestDependencies(value.manifest).every(item => submitted.some(content => content.resourceId === item.resourceId))
  }, 'Dependency resources must match the manifest exactly')
  .refine(value => {
    if (value.manifest.formatVersion !== 3) return true
    // Every pinned runtime file is uploaded, and the product-shipped Adapter is deliberately not among
    // them: it is not a runtime resource, so no course can hand the host its own executor.
    const submitted = value.runtimeResources ?? []
    return new Set(submitted.map(item => item.resourceId)).size === submitted.length
      && submitted.length === value.manifest.runtime.resources.length
      && value.manifest.runtime.resources.every(item => submitted.some(content => content.resourceId === item.resourceId))
  }, 'Runtime resources must match the manifest exactly')
  .refine(value => value.manifest.componentId === value.manifest.componentId.toLowerCase(),
    'New component registrations require canonical lowercase UUIDs');
export type ComponentImport = z.infer<typeof componentImportSchema>;
/** Verified dependency bytes for an already-authorized client; never an arbitrary URL proxy. */
export const componentDependencyContentSchema = z.object({
  dependencyId: identifier, resourceId: z.uuid(), sha256: digest, byteLength: z.number().int().min(1).max(2000000),
  mediaType: z.literal('text/javascript'), contentBase64: z.string().max(2800000),
}).strict();
export type ComponentDependencyContent = z.infer<typeof componentDependencyContentSchema>;
/**
 * One runtime file a release really serves, addressed by the relative path its own manifest declared.
 * Every declared role is answered here, toolchain included: the six Icarus files are release resources the
 * client authorizes and digest-checks one by one. What is never answered is the Adapter itself — that
 * ships with the product, so a course cannot hand the host its own executor.
 */
export const componentRuntimeResourceContentSchema = z.object({
  resourceId: z.uuid(), path: z.string().min(1).max(200), role: z.enum(componentRuntimeResourceRoles),
  sha256: digest, byteLength: z.number().int().min(1).max(8388608), mediaType: z.string().min(1).max(120),
  contentBase64: z.string().max(11200000),
}).strict();
export type ComponentRuntimeResourceContent = z.infer<typeof componentRuntimeResourceContentSchema>;
/** The algorithm is delivered only through the authorised release, never from the component view. */
export const componentAlgorithmBundleSchema = z.object({ definition: componentDefinitionSchema,
  mediaType: z.literal('application/wasm'), entry: identifier, memoryPages: z.number().int().min(1).max(256),
  sha256: digest, byteLength: z.number().int().positive(), contentBase64: z.string().max(1400000) }).strict();
export type ComponentAlgorithmBundle = z.infer<typeof componentAlgorithmBundleSchema>;
/** Fixed declarative instrument wiring. Signal names/widths are validated by the course adapter. */
const boardPinsSchema = z.record(z.string().min(1).max(32), z.array(z.number().int().min(0).max(255)).min(1).max(32))
  .refine(value => Object.keys(value).length <= 32);
export const componentBindingSchema = z.object({ key: identifier, definition: componentDefinitionSchema,
  configuration: z.object({ title: z.string().min(1).max(200), boardMapping: z.object({ version: z.literal(1),
    inputs: boardPinsSchema, outputs: boardPinsSchema }).strict().optional() }).strict(), materialIds: z.array(z.uuid()).max(20) }).strict();
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
/** Host-side validation of the handshake payload; a prepared component must be told which mode it is running in. */
export const componentInitializeSchema = z.object({
  hostApiVersion: z.literal(1), connectionId: z.uuid(), instanceId: z.string().min(1).max(300),
  messageId: z.uuid(), method: z.literal('host.initialize'),
  payload: z.object({
    binding: componentBindingSchema,
    theme: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), z.string().max(64)),
    materials: z.array(z.object({ title: z.string().min(1).max(300), text: z.string().max(16000000) }).strict()).max(20),
    readOnly: z.boolean(),
    titleFont: z.object({ base64: z.string().max(1500000), sha256: digest }).strict().optional(),
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
/** Both lists are accepted here because a projection states what one device observed for whatever it mounted. */
export const preparationCapabilitySchema = z.object({
  capability: z.enum([...componentCapabilities, ...componentRuntimeCapabilities]), availability: capabilityAvailabilitySchema,
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
  /** Protocol 2 is the runtime one. A report states the protocol it actually ran, not the newest supported. */
  preparationProtocolVersion: z.union([z.literal(1), z.literal(2)]), selfTestVersion: z.number().int().positive(),
  hostVersion: z.string().min(1).max(64), device: preparationDeviceSchema,
  status: z.enum(preparationStatuses), reason: z.enum(preparationReasonCodes),
  stage: preparationStageSchema, capabilities: z.array(preparationCapabilitySchema).max(8),
  durationMs: z.number().int().min(0).max(3600000),
  resourceBytes: z.number().int().min(0).max(100000000),
  cacheHit: z.boolean(), preview: z.boolean(),
  memoryNote: z.string().max(300).optional(),
}).strict()
  // A protocol 1 component cannot declare an execution capability, and a protocol 2 runtime cannot project
  // anything its own manifest could not have asked for.
  .refine(value => value.capabilities.every(item => value.preparationProtocolVersion === 1
    ? (componentCapabilities as readonly string[]).includes(item.capability)
    : (componentRuntimeCapabilities as readonly string[]).includes(item.capability)),
  'A preparation report may only project capabilities its own protocol can declare');
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

const eventValue = z.union([z.string().max(4000), z.number().finite(), z.boolean(), z.null()]);
const eventIdentity = { formatVersion: z.literal(1), eventId: z.uuid(), sequence: z.number().int().positive() };
export const componentEventSchema = z.discriminatedUnion('kind', [
  z.object({ ...eventIdentity, kind: z.literal('control-change'), controlId: identifier, value: eventValue }).strict(),
  z.object({ ...eventIdentity, kind: z.literal('answer'), promptId: identifier, value: z.string().max(4000) }).strict(),
  z.object({ ...eventIdentity, kind: z.literal('prediction'), promptId: identifier, value: z.string().max(4000) }).strict(),
  z.object({ ...eventIdentity, kind: z.literal('confirmation'), targetId: identifier, confirmed: z.boolean() }).strict(),
]);
export type ComponentEvent = z.infer<typeof componentEventSchema>;
export const componentReferenceLocateSchema = questionReferenceInputSchema;
export const componentReferenceSelectionSchema = z.object({ expectedContentId: z.uuid(), typeId: z.string().min(1).max(80), version: z.number().int().positive(), target: z.record(z.string(), z.unknown()) }).strict();
export const componentRequestSchema = z.union([
  componentMessageSchema.extend({ method: z.enum(['component.ready', 'component.close', 'workspace.read']), payload: z.object({}).strict() }),
  componentMessageSchema.extend({ method: z.literal('workspace.change'), payload: componentChangeSchema }),
  componentMessageSchema.extend({ method: z.literal('component.event'), payload: componentEventSchema }),
  componentMessageSchema.extend({ method: z.enum(['execution.capabilities', 'execution.submit', 'execution.query', 'execution.stop', 'execution.control', 'reference.select', 'reference.locate']) }),
]);
const hostEnvelope = z.object({ hostApiVersion: z.literal(1), connectionId: z.uuid(), instanceId: z.string().min(1).max(300),
  messageId: z.uuid(), method: z.string().min(1).max(80) });
const successEnvelope = hostEnvelope.extend({ replyTo: z.uuid() });
export const componentSuccessSchema = z.union([
  successEnvelope.extend({ method: z.literal('reference.select'), payload: z.object({ selected: z.literal(true) }).strict() }).strict(),
  successEnvelope.extend({ method: z.literal('reference.locate'), payload: z.object({ located: z.boolean() }).strict() }).strict(),
  // Execution owners validate payloads with their own public execution schemas; this is the shared transport envelope.
  successEnvelope.extend({ method: z.enum(['execution.capabilities', 'execution.query', 'execution.stop']), payload: z.unknown() }).strict(),
  successEnvelope.extend({ method: z.literal('execution.submit'), payload: z.object({ requestId: z.uuid() }).strict() }).strict(),
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
export const componentLocateRequestSchema = hostEnvelope.extend({ method: z.literal('reference.locate'), payload: z.object({ source: questionReferenceSourceSchema, range: questionReferenceRangeSchema }).strict() }).strict();
export const componentHostMessageSchema = z.union([componentLocateRequestSchema, componentInitializeSchema, componentSuccessSchema, componentErrorSchema]);
export function componentReply(context: { connectionId: string; instanceId: string }, request: { messageId: string; method: string },
  outcome: { payload: unknown } | { error: unknown }, messageId: string) {
  return componentHostMessageSchema.parse({ hostApiVersion: 1, connectionId: context.connectionId, instanceId: context.instanceId, messageId,
    method: request.method, replyTo: request.messageId, ...('error' in outcome ? { payload: null, error: outcome.error } : outcome) });
}
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
