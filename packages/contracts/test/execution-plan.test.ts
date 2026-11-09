import assert from 'node:assert/strict';
import test from 'node:test';
import { courseExecutionPlanBasis, courseExecutionPlanSchema, decideExecutionPlacement,
  executionDecisionSchema, plannedExecutionScope, type CourseExecutionPlan, type ExecutionDevice } from '@xunjie/contracts/execution';

const digest = (seed: string) => seed.repeat(64).slice(0, 64);
const definition = digest('a'), configuration = digest('b');

const plan = (overrides: Partial<CourseExecutionPlan> = {}): CourseExecutionPlan => courseExecutionPlanSchema.parse({
  planId: 'table-statistics', planVersion: 1, planDigest: digest('c'),
  components: [{ key: 'table', definitionDigest: definition, configurationDigest: configuration, operations: ['summarize'] }],
  capabilities: ['execution.submit'], resources: { browser: { features: ['worker', 'webassembly'] }, native: null },
  locations: ['browser'], remote: null, ...overrides,
});

const sessionPlan = (overrides: Partial<CourseExecutionPlan> = {}): CourseExecutionPlan => courseExecutionPlanSchema.parse({
  planId: 'accumulator', planVersion: 2, planDigest: digest('d'),
  components: [{ key: 'accumulator', definitionDigest: definition, configurationDigest: configuration, operations: ['step'] }],
  capabilities: ['execution.submit', 'native-session'],
  resources: { browser: null, native: { memoryMiB: 64, operationTimeoutMs: 5000, maxMs: 600000 } },
  locations: ['native'],
  remote: { nodeClass: 'school-execution-node', secureTransport: true,
    adapter: { adapterId: 'four-state-accumulator', adapterVersion: 1 }, clientPlatforms: ['windows-x64'] },
  ...overrides,
});

const adapter = { adapterId: 'four-state-accumulator', adapterVersion: 1 };
const device = (overrides: Partial<ExecutionDevice> = {}): ExecutionDevice => ({
  platform: 'macos-arm64',
  browser: { worker: true, webassembly: true, sandboxedFrame: true },
  native: { supported: true, installed: true, authorized: true, prepared: 'ready' }, ...overrides,
});

test('a plan digest covers its own content and never a mutable head', () => {
  const basis = courseExecutionPlanBasis(plan());
  assert.deepEqual(Object.keys(basis).sort(), ['capabilities', 'components', 'locations', 'planId', 'planVersion', 'remote', 'resources']);
  // Component order is not part of the digest; each entry keeps its own pinned digests.
  const reordered = plan({ components: [
    { key: 'second', definitionDigest: definition, configurationDigest: configuration, operations: ['summarize'] },
    { key: 'first', definitionDigest: digest('e'), configurationDigest: configuration, operations: ['summarize'] }] });
  assert.deepEqual(courseExecutionPlanBasis(reordered).components.map(item => item.key), ['first', 'second']);
  // Browser feature order is normalised too: a reordered declaration is the same requirement.
  const features = plan({ resources: { browser: { features: ['webassembly', 'worker'] }, native: null } });
  assert.deepEqual(courseExecutionPlanBasis(features).resources.browser?.features, ['webassembly', 'worker']);
  assert.notDeepEqual(courseExecutionPlanBasis(reordered), basis);
});

test('a plan keeps locations, resources and capabilities consistent', () => {
  assert.throws(() => plan({ locations: ['native'], resources: { browser: null, native: null } }));
  assert.throws(() => plan({ locations: ['browser'], resources: { browser: null, native: null } }));
  assert.throws(() => plan({ capabilities: ['workspace.read'] }));
  assert.throws(() => plan({ components: [], capabilities: ['execution.submit'] }));
  assert.throws(() => plan({ components: [
    { key: 'table', definitionDigest: definition, configurationDigest: configuration, operations: ['summarize'] },
    { key: 'table', definitionDigest: definition, configurationDigest: configuration, operations: ['summarize'] }] }));
  // A remote arrangement is only meaningful for a native session.
  assert.throws(() => sessionPlan({ locations: ['browser'], capabilities: ['execution.submit'],
    resources: { browser: { features: ['worker'] }, native: null } }));
  assert.throws(() => sessionPlan({ capabilities: ['execution.submit'] }));
  // An old single-location plan keeps its meaning; this course plan never invents a third location.
  assert.deepEqual(plan().locations, ['browser']);
});

test('only a device that genuinely cannot run the operation may be sent to the course school node', () => {
  const unsupported = decideExecutionPlacement({ operationId: 'step', kind: 'session', adapter, plan: sessionPlan(),
    device: device({ platform: 'windows-x64', native: { supported: false, installed: false, authorized: false, prepared: 'none' } }),
    remoteAvailable: true });
  assert.deepEqual({ state: unsupported.state, location: unsupported.location, owner: unsupported.owner },
    { state: 'device-unsupported', location: 'native', owner: 'school-node' });
  assert.equal(executionDecisionSchema.parse(unsupported).remote.available, true);

  // The same device without an eligible node keeps the unknown outcome instead of a silent relocation.
  const withoutNode = decideExecutionPlacement({ operationId: 'step', kind: 'session', adapter, plan: sessionPlan(),
    device: device({ platform: 'windows-x64', native: { supported: false, installed: false, authorized: false, prepared: 'none' } }),
    remoteAvailable: false });
  assert.deepEqual({ state: withoutNode.state, location: withoutNode.location, owner: withoutNode.owner, available: withoutNode.remote.available },
    { state: 'device-unsupported', location: null, owner: null, available: false });

  // A declared remote arrangement for another client platform is not an invitation either.
  const otherPlatform = decideExecutionPlacement({ operationId: 'step', kind: 'session', adapter, plan: sessionPlan(),
    device: device({ platform: 'macos-arm64', native: { supported: false, installed: false, authorized: false, prepared: 'none' } }),
    remoteAvailable: true });
  assert.equal(otherPlatform.owner, null);
  assert.equal(otherPlatform.remote.declared, true);
  assert.equal(otherPlatform.remote.available, false);
});

test('a device that could run the component never silently moves to the school node', () => {
  const cases = [
    { native: { supported: true, installed: false, authorized: false, prepared: 'none' as const }, state: 'install-missing' },
    { native: { supported: true, installed: true, authorized: false, prepared: 'none' as const }, state: 'authorization-pending' },
    // A failed download is a transient preparation problem, not an unsupported device.
    { native: { supported: true, installed: true, authorized: true, prepared: 'failed' as const }, state: 'preparation-failed' },
    { native: { supported: true, installed: true, authorized: true, prepared: 'preparing' as const }, state: 'install-missing' },
  ];
  for (const item of cases) {
    const decision = decideExecutionPlacement({ operationId: 'step', kind: 'session', adapter, plan: sessionPlan(),
      device: device({ platform: 'windows-x64', native: item.native }), remoteAvailable: true });
    assert.equal(decision.state, item.state);
    assert.equal(decision.location, null, `${item.state} must not run anywhere yet`);
    assert.equal(decision.owner, null);
  }
  const ready = decideExecutionPlacement({ operationId: 'step', kind: 'session', adapter, plan: sessionPlan(),
    device: device(), remoteAvailable: true });
  assert.deepEqual({ state: ready.state, location: ready.location, owner: ready.owner },
    { state: 'native-required', location: 'native', owner: 'device' });
});

test('a browser job is decided by the features the plan requires', () => {
  const satisfied = decideExecutionPlacement({ operationId: 'summarize', kind: 'job', adapter: null,
    plan: plan(), device: device(), remoteAvailable: false });
  assert.deepEqual({ state: satisfied.state, location: satisfied.location, owner: satisfied.owner },
    { state: 'browser-satisfied', location: 'browser', owner: 'device' });

  const missing = decideExecutionPlacement({ operationId: 'summarize', kind: 'job', adapter: null, plan: plan(),
    device: device({ browser: { worker: true, webassembly: false, sandboxedFrame: true } }), remoteAvailable: true });
  assert.equal(missing.state, 'device-unsupported');
  assert.equal(missing.location, null, 'a browser job is never sent to a school node');
  assert.equal(missing.owner, null);
  assert.match(missing.detail, /webassembly/);
});

test('an operation the plan does not pin is refused instead of being placed anywhere', () => {
  assert.throws(() => decideExecutionPlacement({ operationId: 'aggregate', kind: 'job', adapter: null, plan: plan(),
    device: device(), remoteAvailable: false }), /not-planned/);
  assert.throws(() => decideExecutionPlacement({ operationId: 'step', kind: 'job', adapter: null, plan: sessionPlan(),
    device: device(), remoteAvailable: false }), /not-planned/);
  assert.throws(() => decideExecutionPlacement({ operationId: 'summarize', kind: 'session', adapter, plan: plan(),
    device: device(), remoteAvailable: false }), /not-planned/);
});

test('a run is allowed only by the plan the activity was opened with', () => {
  const planned = plan();
  const run = { key: 'table', definitionDigest: definition, operationId: 'summarize', location: 'browser' as const };
  assert.equal(plannedExecutionScope(planned, run), 'allowed');
  // A release published before plans existed keeps its original path.
  assert.equal(plannedExecutionScope(undefined, run), 'allowed');
  assert.equal(plannedExecutionScope(null, run), 'allowed');
  // The plan no longer describes the bound component.
  assert.equal(plannedExecutionScope(planned, { ...run, definitionDigest: digest('f') }), 'drifted');
  assert.equal(plannedExecutionScope(planned, { ...run, key: 'other' }), 'drifted');
  // An operation or a location the course did not declare.
  assert.equal(plannedExecutionScope(planned, { ...run, operationId: 'aggregate' }), 'forbidden');
  assert.equal(plannedExecutionScope(planned, { ...run, location: 'native' }), 'forbidden');
});

test('an unobserved device fact is never turned into a promise or a relocation', () => {
  // A browser cannot attest the CPU architecture, so a declared remote platform cannot match it.
  const unknownPlatform = decideExecutionPlacement({ operationId: 'step', kind: 'session', adapter, plan: sessionPlan(),
    device: device({ platform: null, native: { supported: false, installed: false, authorized: false, prepared: 'none' } }),
    remoteAvailable: true });
  assert.equal(unknownPlatform.remote.declared, true);
  assert.equal(unknownPlatform.remote.available, false);
  assert.equal(unknownPlatform.owner, null);
  // A page that has not asked the local runtime anything reports nothing, not "unsupported".
  const unobserved = decideExecutionPlacement({ operationId: 'step', kind: 'session', adapter, plan: sessionPlan(),
    device: device({ platform: 'windows-x64', native: null }), remoteAvailable: true });
  assert.deepEqual({ state: unobserved.state, location: unobserved.location, owner: unobserved.owner },
    { state: 'device-unsupported', location: null, owner: null });
  // A browser job never reads the native facts at all.
  const job = decideExecutionPlacement({ operationId: 'summarize', kind: 'job', adapter: null, plan: plan(),
    device: device({ platform: null, native: null }), remoteAvailable: false });
  assert.equal(job.state, 'browser-satisfied');
});

test('V2 places the same operation name independently for each component and never falls back', () => {
  const legacy = sessionPlan({ components: [
    { key: 'local', definitionDigest: definition, configurationDigest: configuration, operations: ['step'] },
    { key: 'school', definitionDigest: definition, configurationDigest: configuration, operations: ['step'] }], remote: null });
  const v2 = courseExecutionPlanSchema.parse({ ...legacy, version: 2,
    placements: ['local', 'school'].map(componentKey => ({ componentKey, operationId: 'step',
      target: componentKey === 'local' ? 'student-runtime' : 'school-runtime',
      resources: [{ resourceId: '11111111-1111-4111-8111-111111111111', sha256: definition, byteLength: 1 }],
      budgets: { memoryMiB: 64, operationTimeoutMs: 5000, maxMs: 600000 } })) });
  const locate = (componentKey: string, remoteAvailable = true) => decideExecutionPlacement({ componentKey,
    operationId: 'step', kind: 'session', adapter, plan: v2, device: device(), remoteAvailable });
  assert.equal(locate('local').owner, 'device');
  assert.equal(locate('school').owner, 'school-node');
  assert.equal(locate('school').state, 'school-required');
  assert.equal(locate('school', false).owner, null);
  assert.equal(locate('school', false).state, 'target-unavailable');
  assert.throws(() => decideExecutionPlacement({ operationId: 'step', kind: 'session', adapter,
    plan: v2, device: device(), remoteAvailable: true }), /not-planned/);
  assert.equal(plannedExecutionScope(v2, { key: 'school', definitionDigest: definition, operationId: 'step',
    location: 'native', target: 'student-runtime' }), 'forbidden');
  const basis = courseExecutionPlanBasis(v2);
  assert.equal(basis.version, 2);
  assert.equal(basis.placements?.length, 2);
  assert.notDeepEqual(basis, courseExecutionPlanBasis(legacy));
});
