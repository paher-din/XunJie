import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { componentAnyManifestSchema, componentDependencyContentSchema, componentImportSchema,
  componentPreparationReportSchema, componentRuntimeResourceContentSchema, manifestResources,
  runtimeAdapter } from '@xunjie/contracts/components';

const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const digest = (seed: string) => seed.repeat(64).slice(0, 64);
const componentDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * The v1 and v2 branches are frozen: adding a format version must never give an existing definition a
 * defaulted field, because that would move its digest and invalidate every published release.
 */
const v1Manifest = {
  formatVersion: 1 as const, componentId: uuid(1), version: 1, hostApiVersion: 1 as const, title: '聚合',
  entry: { resourceId: uuid(2), sha256: digest('a'), byteLength: 100, mediaType: 'text/html' as const },
  stateVersion: 1, stateShape: { type: 'object', properties: {} }, initialState: {},
  requiredCapabilities: ['workspace.read' as const],
};
const v2Manifest = {
  formatVersion: 2 as const, componentId: uuid(3), version: 1, hostApiVersion: 1 as const,
  preparationProtocolVersion: 1 as const, title: '标注',
  entry: { resourceId: uuid(4), sha256: digest('b'), byteLength: 100, mediaType: 'text/html' as const },
  dependencies: [{ dependencyId: 'runtime', package: 'pin', version: '1.0.0', role: 'script' as const,
    resourceId: uuid(5), sha256: digest('c'), byteLength: 50, mediaType: 'text/javascript' as const, loadOrder: 0,
    preparationTypes: ['browser' as const] }],
  environment: { preparationType: 'browser' as const, preparationProtocolVersion: 1 as const,
    requiredFeatures: ['message-port' as const], selfTestVersion: 1, capabilityDependencies: [] },
  budget: { resourceCount: 8, totalResourceBytes: 4000000, messageBytes: 1048576, preparationTimeoutMs: 30000,
    selfTestTimeoutMs: 20000, parallelism: 2, cacheScope: 'device-local' as const },
  selfTest: { selfTestVersion: 1, material: { title: 't', text: 'x' },
    steps: [{ kind: 'dependency-loads' as const, checkId: 'loads', dependencyIds: ['runtime'],
      expect: { globalName: 'Pin' } }] },
  stateVersion: 1, stateShape: { type: 'object', properties: {} }, initialState: {},
  requiredCapabilities: ['workspace.read' as const],
};

test('a version 1 definition keeps its original digest after format 3 exists', () => {
  const parsed = componentAnyManifestSchema.parse(v1Manifest);
  assert.equal(componentDigest(parsed), createHash('sha256').update(JSON.stringify(v1Manifest)).digest('hex'));
  // Parsing must not graft v2/v3 fields onto it.
  assert.equal((parsed as Record<string, unknown>).dependencies, undefined);
  assert.equal((parsed as Record<string, unknown>).runtime, undefined);
  assert.deepEqual(manifestResources(parsed), []);
  assert.equal(runtimeAdapter(parsed), undefined);
});

test('a version 2 definition keeps its original digest and dependency order', () => {
  const parsed = componentAnyManifestSchema.parse(v2Manifest);
  assert.equal(componentDigest(parsed), createHash('sha256').update(JSON.stringify(v2Manifest)).digest('hex'));
  assert.equal((parsed as Record<string, unknown>).runtime, undefined);
  assert.deepEqual(manifestResources(parsed).map(item => item.resourceId), [uuid(5)]);
  assert.equal(runtimeAdapter(parsed), undefined);
});

const runtimeResource = (n: number, path: string, role: 'toolchain-script' | 'toolchain-wasm' | 'text/plain' | 'scaffold' | 'data', mediaType: string) => ({
  resourceId: uuid(n), sha256: digest(String(n)), byteLength: 1000, path, role, mediaType,
});
const v3Manifest = (overrides: Record<string, unknown> = {}) => ({
  formatVersion: 3 as const, componentId: uuid(6), version: 1, hostApiVersion: 1 as const,
  preparationProtocolVersion: 2 as const, title: 'ALU',
  entry: { resourceId: uuid(7), sha256: digest('d'), byteLength: 100, mediaType: 'text/html' as const },
  stateVersion: 1,
  stateShape: { type: 'object', properties: { a: { type: 'number' } } }, initialState: { a: 0 },
  requiredCapabilities: ['workspace.read' as const, 'execution.submit' as const],
  runtime: {
    adapterId: 'icarus-alu', adapterVersion: 1, bundleIdentity: digest('e'),
    resources: [runtimeResource(8, 'ivl.js', 'toolchain-script', 'text/javascript'),
      runtimeResource(9, 'ivl.wasm', 'toolchain-wasm', 'application/wasm'),
      runtimeResource(10, 'alu-tb.sv', 'scaffold', 'text/plain')],
    operations: [{
      operationId: 'run-single', effect: 'execute' as const,
      parameters: { type: 'object', properties: { a: { type: 'number' } } },
      compile: { top: 'alu', entryFiles: ['alu.sv'], includeDirs: [] },
      observation: { scaffoldResourceId: uuid(10), scaffoldVersion: 1, ports: { result: 'F', carry: 'Cout' },
        resultFormat: 'xunjie-observations-v1' as const },
      result: { type: 'object', properties: {} },
      budgets: { compileTimeoutMs: 30000, simulateTimeoutMs: 5000, jobTimeoutMs: 40000, memoryMiB: 256,
        inputBytes: 1048576, textBytes: 2097152, vcdBytes: 8388608, resultBytes: 16777216 },
    }],
  },
  environment: { preparationType: 'browser' as const, preparationProtocolVersion: 2 as const,
    requiredFeatures: ['worker' as const, 'webassembly' as const], selfTestVersion: 1 },
  budget: { resourceCount: 32, totalResourceBytes: 16777216, preparationTimeoutMs: 300000, selfTestTimeoutMs: 120000,
    concurrentJobs: 1, queuedJobs: 1, cacheScope: 'device-local' as const },
  selfTest: { selfTestVersion: 1, fixture: { resourceId: uuid(10), path: 'alu-tb.sv', top: 'alu',
    expect: { result: '0101', carry: '0' } }, timeoutMs: 60000 },
  ...overrides,
});

test('a version 3 runtime declares its resources and is read as one fixed set', () => {
  const parsed = componentAnyManifestSchema.parse(v3Manifest());
  assert.equal(parsed.formatVersion, 3);
  assert.equal(runtimeAdapter(parsed)?.adapterId, 'icarus-alu');
  assert.deepEqual(manifestResources(parsed).map(item => item.kind), ['runtime', 'runtime', 'runtime']);
  // A v3 runtime is not a v2 script dependency list.
  assert.deepEqual(manifestDependenciesOf(parsed), []);
});

function manifestDependenciesOf(manifest: unknown) {
  const value = manifest as { dependencies?: unknown[] };
  return value.dependencies ?? [];
}

test('a version 3 manifest rejects a traversal path, an unknown media type and an unsampled scaffold', () => {
  const manifest = v3Manifest();
  const withPath = structuredClone(manifest);
  withPath.runtime.resources[0]!.path = '../escape.js';
  assert.equal(componentAnyManifestSchema.safeParse(withPath).success, false);

  const withMedia = structuredClone(manifest);
  withMedia.runtime.resources[0]!.mediaType = 'text/html';
  assert.equal(componentAnyManifestSchema.safeParse(withMedia).success, false);

  const withoutScaffold = structuredClone(manifest);
  withoutScaffold.runtime.resources = withoutScaffold.runtime.resources.filter(item => item.role !== 'scaffold');
  assert.equal(componentAnyManifestSchema.safeParse(withoutScaffold).success, false);
});

test('a version 3 import must upload exactly the resources its manifest pins', () => {
  const manifest = v3Manifest();
  const content = manifest.runtime.resources.map(item => ({ resourceId: item.resourceId, contentBase64: 'AAAA' }));
  const base = { requestId: uuid(1), manifest, contentBase64: 'AAAA' };
  assert.equal(componentImportSchema.safeParse({ ...base, runtimeResources: content }).success, true);
  // Missing one resource is an unusable definition, not a partial install.
  assert.equal(componentImportSchema.safeParse({ ...base, runtimeResources: content.slice(1) }).success, false);
  // A v1/v2 component must not smuggle runtime resources in.
  assert.equal(componentImportSchema.safeParse({ ...base, manifest: v1Manifest, runtimeResources: content }).success, false);
});

test('a runtime upload is bounded by the largest file a manifest may pin, not by a script', () => {
  const manifest = v3Manifest();
  // The real toolchain WASM files exceed the script bound; a definition that pins them must still be importable.
  const toolchain = manifest.runtime.resources.map((item, index) => ({ resourceId: item.resourceId,
    contentBase64: 'A'.repeat(index === 0 ? 3_153_000 : 4) }));
  const base = { requestId: uuid(1), manifest, contentBase64: 'AAAA' };
  assert.equal(componentImportSchema.safeParse({ ...base, runtimeResources: toolchain }).success, true);
  // 8 MiB is the most a single runtime resource may declare, so its base64 form is the most it may upload.
  const overFile = manifest.runtime.resources.map((item, index) => ({ resourceId: item.resourceId,
    contentBase64: 'A'.repeat(index === 0 ? 11_200_001 : 4) }));
  assert.equal(componentImportSchema.safeParse({ ...base, runtimeResources: overFile }).success, false);
  // The wider runtime bound must not widen the script-dependency path.
  assert.equal(componentDependencyContentSchema.safeParse({ dependencyId: 'runtime', resourceId: uuid(5), sha256: digest('c'),
    byteLength: 2000, mediaType: 'text/javascript', contentBase64: 'A'.repeat(2_800_001) }).success, false);
});

test('a served runtime resource reports the role its own manifest declared', () => {
  const base = { resourceId: uuid(9), path: 'ivl.wasm', sha256: digest('9'), byteLength: 1_771_889,
    mediaType: 'application/wasm', contentBase64: 'AAAA' };
  // Every declared role is answerable, toolchain included: those bytes are the release's own resources.
  for (const role of ['toolchain-script', 'toolchain-wasm', 'data', 'scaffold', 'attachment'])
    assert.equal(componentRuntimeResourceContentSchema.safeParse({ ...base, role }).success, true);
  assert.equal(componentRuntimeResourceContentSchema.safeParse({ ...base, role: 'adapter' }).success, false);
});

const report = (overrides: Record<string, unknown> = {}) => ({
  formatVersion: 1 as const, componentId: uuid(6), version: 1, definitionDigest: digest('f'),
  preparationProtocolVersion: 2, selfTestVersion: 1, hostVersion: '1',
  device: { platform: 'Win32', browser: 'chrome', browserVersion: '156', features: ['worker', 'webassembly'],
    preparationImplementationVersion: 3 },
  status: 'ready' as const, reason: 'none' as const, stage: 'activate' as const,
  capabilities: [{ capability: 'execution.submit', availability: 'available' as const, reason: 'none' as const,
    verification: 'verified' as const }],
  durationMs: 1000, resourceBytes: 3009439, cacheHit: false, preview: false,
  ...overrides,
});

test('a preparation report projects only the capabilities its own protocol can declare', () => {
  assert.equal(componentPreparationReportSchema.safeParse(report()).success, true);
  // A protocol 1 component has no execution capability, so it cannot report one as available.
  assert.equal(componentPreparationReportSchema.safeParse(report({ preparationProtocolVersion: 1 })).success, false);
  // A protocol 2 runtime cannot fall back to the script-bundle capability either.
  assert.equal(componentPreparationReportSchema.safeParse(report({ capabilities: [{ capability: 'material.highlight',
    availability: 'available', reason: 'none', verification: 'verified' }] })).success, false);
});
