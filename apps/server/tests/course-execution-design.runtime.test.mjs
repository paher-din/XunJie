import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { provisionStorage, openStorage, createFileBackend, StorageError } from '@xunjie/storage';
import { createCourseExecutionDesign, createCourses, createSpaces, createLearningData, createTeachingTools,
  spaceCourseMigrations, learningMigrations } from '@xunjie/learning-space';
import { courseExecutionPlanBasis, courseExecutionPlanSchema, decideExecutionPlacement, canonicalValue,
  plannedExecutionScope, legacyCourseExecutionPlanSchema } from '@xunjie/contracts/execution';
import { manifestResources } from '@xunjie/contracts/components';
import { nativeFixture } from '../../../packages/storage/test/native-fixture.mjs';
import { accumulatorPackage } from '../../../components/state-accumulator/package.mjs';
import { aggregationPackage } from '../../../components/table-aggregation/package.mjs';
import { aluPackage } from '../../../components/alu-experiment/package.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(canonicalValue(value))).digest('hex');
const readyDevice = { platform: 'macos-arm64', browser: { worker: true, webassembly: true, sandboxedFrame: true },
  native: { supported: true, installed: true, authorized: true, prepared: 'ready' } };
const actionScope = (identity, activityId) => ({ environmentId: identity.environmentId,
  spaceId: identity.spaceId, principalId: identity.principalId, activityId });

async function fixture() {
  const pg = await nativeFixture(), storages = [], learners = [];
  const environmentId = randomUUID();
  async function owner(migrations) {
    const binding = await provisionStorage({ admin: pg.admin, owner: { environmentId, serviceId: randomUUID() },
      password: randomUUID(), migrations });
    const storage = await openStorage({ binding, migrations,
      backend: createFileBackend({ id: 'files', root: pg.root + '/' + binding.owner.serviceId }) });
    storages.push(storage); return storage;
  }
  try {
    const storage = await owner(spaceCourseMigrations);
    const spaces = createSpaces(storage);
    const teacher = await spaces.createMember({ requestId: randomUUID(), loginName: 'teacher', password: randomUUID() });
    const student = await spaces.createMember({ requestId: randomUUID(), loginName: 'student', password: randomUUID() });
    const courseId = randomUUID(), taskId = randomUUID();
    let available = true, preparations = 0;
    const publicationChecks = [];
    const options = {
      authorize: async identity => {
        await spaces.authorize(identity);
        if (identity.principalId !== teacher.principalId) throw new StorageError('forbidden');
      },
      checkSchoolRuntime: async input => {
        publicationChecks.push(structuredClone(input));
        if (available instanceof Error) throw available;
        return { ready: available, detail: available ? 'fixture ready now' : 'fixture stopped' };
      },
      prepareSchoolRuntime: async () => { preparations++; return { ready: available, detail: available ? 'fixture ready' : 'fixture absent' }; },
    };
    const courses = createCourses(storage, spaces, options);
    const design = createCourseExecutionDesign(storage, options);
    async function inputFor(target, key = 'counter', component) {
      const published = component ?? (target === 'student-browser' ? await aggregationPackage() : await accumulatorPackage({ version: 1 }));
      const definition = await courses.components.register({ ...published, requestId: randomUUID() });
      const binding = { key, definition, configuration: { title: 'fixed target' }, materialIds: [] }, m = definition.manifest;
      const native = !!m.session;
      const operations = m.formatVersion === 3 ? m.runtime.operations.map(item => item.operationId)
        : native ? [m.session.operation.operationId] : m.operations.map(item => item.operationId);
      const resources = [m.entry, ...manifestResources(m)].map(({ resourceId, sha256, byteLength }) => ({ resourceId, sha256, byteLength }));
      const budgets = m.formatVersion === 3 ? { ...m.runtime.operations[0].budgets,
        concurrentJobs: m.budget.concurrentJobs, queuedJobs: m.budget.queuedJobs } : native ? { ...m.session.budgets } : {
        timeMs: m.operations[0].budgets.timeMs, outputBytes: m.operations[0].budgets.outputBytes,
        memoryPages: m.algorithm.memoryPages, inputBytes: 1048576, concurrentJobs: 2, queuedJobs: 4,
      };
      return { courseId, taskId, releaseId: randomUUID(), components: [binding], plan: {
        version: 2, planId: 'teacher-design', planVersion: 1,
        components: [{ key, definitionDigest: definition.digest, configurationDigest: hash(binding.configuration), operations }],
        capabilities: native ? ['execution.submit', 'native-session'] : ['execution.submit'],
        resources: { browser: native ? null : { features: ['worker', 'webassembly'] },
          native: native ? { memoryMiB: budgets.memoryMiB, operationTimeoutMs: budgets.operationTimeoutMs, maxMs: budgets.maxMs } : null },
        locations: [native ? 'native' : 'browser'], remote: null,
        placements: operations.map(operationId => ({ componentKey: key, operationId, target, resources,
          budgets: m.formatVersion === 3 ? { ...m.runtime.operations.find(item => item.operationId === operationId).budgets,
            concurrentJobs: m.budget.concurrentJobs, queuedJobs: m.budget.queuedJobs } : budgets })),
      } };
    }
    const publish = (input, plan, consumer = courses, requestId = randomUUID()) => consumer.registerRelease({ formatVersion: 1, requestId,
      course: { courseId: input.courseId, name: 'placement fixture' }, task: { taskId: input.taskId, title: 'fixed target', summary: '' },
      release: { releaseId: input.releaseId, objectives: ['observe real execution'], requirements: 'run at the teacher target',
        materials: [], starterWorks: [], capabilities: [], components: input.components,
        helpPolicy: { version: 1, questions: 'allowed', scope: 'course' }, ...(plan ? { executionPlan: plan } : {}) }, resources: [] });
    async function learner(placement, identity = student) {
      const learningStorage = await owner(learningMigrations);
      const target = { ...learningStorage.owner, version: 1 };
      await spaces.bindMember(identity, target);
      const learning = createLearningData(learningStorage, spaces, courses, {}, {
        nodePath: process.execPath, sessionRoot: pg.root + '/sessions-' + learningStorage.owner.serviceId,
        nodeId: placement.nodeClass === 'school-execution-node' ? 'school-fixture-' + randomUUID() : 'device-' + randomUUID(), placement,
      });
      learners.push(learning); return learning;
    }
    return { storage, spaces, courses, design, teacher, student, options, inputFor, publish, learner, publicationChecks,
      setAvailable(value) { available = value; }, get preparations() { return preparations; },
      async close() { for (const learning of learners) await learning.executions.shutdown();
        for (const storage of storages.reverse()) await storage.close(); await pg.close(); } };
  } catch (error) { for (const storage of storages.reverse()) await storage.close(); await pg.close(); throw error; }
}

test('public design API verifies teacher authority, pinned resources and budgets and requires exact deployment before publish',
  { timeout: 120000 }, async () => {
    const f = await fixture();
    try {
      for (const target of ['student-browser', 'student-runtime', 'school-runtime']) {
        const input = await f.inputFor(target);
        await assert.rejects(f.design.compileExecutionDesign(f.student, input), { code: 'forbidden' });
        const plan = await f.design.compileExecutionDesign(f.teacher, input);
        assert.equal(plan.version, 2); assert.equal(plan.planDigest, hash(courseExecutionPlanBasis(plan)));
        await assert.rejects(f.publish(input, plan), { code: 'unavailable' });
        const prepare = { requestId: randomUUID(), ...input, plan };
        await assert.rejects(f.design.prepareCourseDeployment(f.student, prepare), { code: 'forbidden' });
        const [first, concurrent] = await Promise.all([
          f.design.prepareCourseDeployment(f.teacher, prepare), f.design.prepareCourseDeployment(f.teacher, prepare)]);
        assert.deepEqual(first, concurrent);
        assert.equal(first.state, 'ready');
        assert.equal(f.preparations, target === 'school-runtime' ? 1 : 0, 'concurrent prepare provisions once');
        const reopened = createCourseExecutionDesign(f.storage, f.options);
        assert.deepEqual(await reopened.readCourseDeployment(f.teacher, prepare.requestId), first);
        await assert.rejects(reopened.readCourseDeployment(f.student, prepare.requestId), { code: 'forbidden' });
        await assert.rejects(f.design.prepareCourseDeployment(f.teacher, { ...prepare, releaseId: randomUUID() }),
          { code: 'identity-conflict' });
        assert.equal((await f.publish(input, plan)).releaseId, input.releaseId);
        await assert.rejects(f.publish({ ...input, releaseId: randomUUID() }, plan), { code: 'unavailable' });
        await assert.rejects(f.design.compileExecutionDesign(f.teacher, { ...input, plan: { ...input.plan,
          placements: input.plan.placements.map(item => ({ ...item, resources: item.resources.map(resource =>
            ({ ...resource, sha256: 'a'.repeat(64) })) })) } }), { code: 'invalid' });
        await assert.rejects(f.design.compileExecutionDesign(f.teacher, { ...input, plan: { ...input.plan,
          placements: input.plan.placements.map(item => ({ ...item, budgets: { ...item.budgets, invented: 1 } })) } }), { code: 'invalid' });
        await assert.rejects(f.design.compileExecutionDesign(f.teacher, { ...input, plan: { ...input.plan,
          placements: input.plan.placements.map(item => ({ ...item, budgets: Object.fromEntries(
            Object.entries(item.budgets).map(([key,value]) => [key,value + 1])) })) } }), { code: 'invalid' });
      }
      await f.courses.validate();
      const legacy = await f.inputFor('student-browser');
      assert.equal((await f.publish(legacy)).releaseId, legacy.releaseId, 'old releases do not require preparation');
      const oldPlan = { ...legacy.plan }; delete oldPlan.version; delete oldPlan.placements;
      oldPlan.planDigest = hash(courseExecutionPlanBasis(oldPlan));
      const wire = JSON.stringify(legacyCourseExecutionPlanSchema.parse(oldPlan)), basis = courseExecutionPlanBasis(oldPlan);
      assert.equal('version' in basis, false); assert.equal('placements' in basis, false);
      assert.equal(JSON.stringify(courseExecutionPlanSchema.parse(oldPlan)), wire);
      assert.equal((await f.publish({ ...legacy, releaseId: randomUUID() }, oldPlan)).releaseId.length, 36);
    } finally { await f.close(); }
  });

test('school readiness blocks publication and fixed placement never substitutes a different target', { timeout: 120000 }, async () => {
  const f = await fixture();
  try {
    const input = await f.inputFor('school-runtime'), plan = await f.design.compileExecutionDesign(f.teacher, input);
    f.setAvailable(false);
    const prepare = { requestId: randomUUID(), ...input, plan };
    const blocked = await f.design.prepareCourseDeployment(f.teacher, prepare);
    assert.equal(blocked.state, 'blocked');
    await assert.rejects(f.publish(input, plan), { code: 'unavailable' });
    const placement = remoteAvailable => decideExecutionPlacement({ componentKey: 'counter', operationId: 'advance',
      kind: 'session', adapter: input.components[0].definition.manifest.session, plan, device: readyDevice, remoteAvailable });
    assert.equal(placement(false).owner, null); assert.equal(placement(false).state, 'target-unavailable');
    assert.equal(placement(true).owner, 'school-node', 'school target applies even on a capable installed student device');
    f.setAvailable(true);
    assert.deepEqual(await f.design.prepareCourseDeployment(f.teacher, prepare), blocked, 'retry keeps original receipt');
    assert.equal((await f.design.prepareCourseDeployment(f.teacher, { ...prepare, requestId: randomUUID() })).state, 'ready');
    await f.publish(input, plan);
    const localInput = await f.inputFor('student-runtime'), localPlan = await f.design.compileExecutionDesign(f.teacher, localInput);
    const decision = decideExecutionPlacement({ componentKey: 'counter', operationId: 'advance', kind: 'session',
      adapter: localInput.components[0].definition.manifest.session, plan: localPlan, remoteAvailable: true,
      device: { ...readyDevice, native: { ...readyDevice.native, supported: false } } });
    assert.equal(decision.owner, null, 'a local target cannot fall back to an available school node');
    assert.equal(plannedExecutionScope(plan, { key: 'counter', definitionDigest: input.components[0].definition.digest,
      operationId: 'advance', location: 'native', target: 'student-runtime' }), 'forbidden');
    const duplicate = { ...input.plan, placements: [...input.plan.placements, ...input.plan.placements] };
    await assert.rejects(f.design.compileExecutionDesign(f.teacher, { ...input, plan: duplicate }));
  } finally { await f.close(); }
});

test('student and Agent use the same published placement and real native owner refuses relocation', { timeout: 120000 }, async () => {
  const f = await fixture();
  try {
    for (const target of ['student-runtime', 'school-runtime']) {
      const identity = await f.spaces.createMember({ requestId: randomUUID(), loginName: 'student-' + randomUUID(), password: randomUUID() });
      const input = await f.inputFor(target);
      input.plan.placements[0].budgets.operationTimeoutMs = 3000;
      input.plan.placements[0].budgets.inputBytes = 512;
      input.plan.placements[0].budgets.concurrentSessions = 1;
      const plan = await f.design.compileExecutionDesign(f.teacher, input);
      await f.design.prepareCourseDeployment(f.teacher, { requestId: randomUUID(), ...input, plan });
      await f.publish(input, plan);
      await f.courses.setAccess({ requestId: randomUUID(), courseId: input.courseId,
        principalId: identity.principalId, active: true });
      const school = target === 'school-runtime';
      const learning = await f.learner({ nodeClass: school ? 'school-execution-node' : 'device', secureTransport: true }, identity);
      const activity = await learning.createCourse(identity, { requestId: randomUUID(), releaseId: input.releaseId });
      const scope = { identity: identity, activity, runId: randomUUID(), stepId: randomUUID(), snapshotId: randomUUID(),
        assertDispatch: async () => {}, input: { requestId: randomUUID(), scope: actionScope(identity, activity.activityId),
          receiver: { receiverId: 'teaching-agent', kind: 'question', location: 'local' },
          draft: { token: 'fixed', question: 'advance', references: [], bases: [] }, works: [], evidence: [] } };
      const host = createTeachingTools({ learning: () => learning, courses: f.courses,
        environment: async () => ({ device: readyDevice, remoteAvailable: school }) });
      const command = await host.prepare(scope, { callId: randomUUID(), name: 'course_operation',
        arguments: { componentKey: 'counter', operationId: 'start_session', parameters: {} } }, randomUUID());
      assert.equal(command.basis.action.receiver.location, school ? 'remote' : 'local');
      assert.equal(command.basis.action.execution.session.limits.operationTimeoutMs, 3000);
      assert.equal(command.basis.action.execution.limits.timeMs, 3000);
      assert.equal(command.basis.action.execution.limits.inputBytes, 512);
      const action = structuredClone(command.basis.action);
      action.requestId = randomUUID(); action.execution.initiator = { kind: 'student', principalId: identity.principalId };
      const malicious = structuredClone(action); malicious.receiver.location = school ? 'local' : 'remote';
      await assert.rejects(learning.executions.accept(identity, activity.activityId, { action: malicious }), { code: 'forbidden' });
      const started = await learning.executions.accept(identity, activity.activityId, { action });
      assert.equal(started.state, 'running');
      assert.equal(started.session.nodeId.startsWith('school-'), school);
      const repeated = await learning.executions.accept(identity, activity.activityId, { action });
      assert.equal(repeated.executionRef, started.executionRef);
      await learning.executions.stop(identity, activity.activityId, action.requestId, { stopId: randomUUID(), reason: '' });
      const executed = await host.dispatch(scope, command);
      assert.equal(executed.result.query.session.nodeId.startsWith('school-'), school);
      await host.stop(scope, command);
    }
  } finally { await f.close(); }
});

test('ALU v1 compilation requires the actual fixed 256 MiB and publication cannot bypass it', { timeout: 120000 }, async () => {
  const f = await fixture();
  try {
    const input = await f.inputFor('student-browser', 'alu', await aluPackage());
    input.plan.placements[0].budgets.compileTimeoutMs = 1000;
    const plan = await f.design.compileExecutionDesign(f.teacher, input);
    assert.equal(plan.placements[0].budgets.memoryMiB, 256);
    await f.design.prepareCourseDeployment(f.teacher, { requestId: randomUUID(), ...input, plan });
    assert.equal((await f.publish(input, plan)).releaseId, input.releaseId);
    assert.equal(f.publicationChecks.length, 0, 'browser execution does not require a school executor');
    for (const memoryMiB of [16, 128, 255, 257, 512]) {
      const changed = structuredClone(input);
      changed.releaseId = randomUUID();
      changed.plan.placements[0].budgets.memoryMiB = memoryMiB;
      await assert.rejects(f.design.compileExecutionDesign(f.teacher, changed), { code: 'invalid' });
      await assert.rejects(f.design.prepareCourseDeployment(f.teacher, { requestId: randomUUID(), ...changed }), { code: 'invalid' });
      const forged = { ...changed.plan, planDigest: hash(courseExecutionPlanBasis(changed.plan)) };
      await assert.rejects(f.publish(changed, forged), { code: 'invalid' });
    }
    // A manifest that claims a different memory size must not make the shipped adapter tunable.
    let component = await aluPackage();
    let encoded = JSON.stringify(component);
    for (const resourceId of [component.manifest.entry.resourceId, ...component.manifest.runtime.resources.map(item => item.resourceId)])
      encoded = encoded.replaceAll(resourceId, randomUUID());
    component = JSON.parse(encoded);
    component.manifest.version += 1;
    for (const operation of component.manifest.runtime.operations) operation.budgets.memoryMiB = 128;
    const incompatible = await f.inputFor('student-browser', 'alu', component);
    await assert.rejects(f.design.compileExecutionDesign(f.teacher, incompatible), { code: 'invalid' });
  } finally { await f.close(); }
});

test('publication probes current school readiness, denies absent probes and preserves successful request replay', { timeout: 120000 }, async () => {
  const f = await fixture();
  try {
    const input = await f.inputFor('school-runtime'), plan = await f.design.compileExecutionDesign(f.teacher, input);
    const preparation = await f.design.prepareCourseDeployment(f.teacher, { requestId: randomUUID(), ...input, plan });
    assert.equal(preparation.state, 'ready');
    const requestId = randomUUID();
    const withoutProbe = createCourses(f.storage, f.spaces);
    await assert.rejects(f.publish(input, plan, withoutProbe, requestId), { code: 'unavailable' });
    assert.equal(f.publicationChecks.length, 0, 'absence of a callback does not enable school execution');
    f.setAvailable(false);
    await assert.rejects(f.publish(input, plan, f.courses, requestId), { code: 'unavailable' });
    assert.equal((await f.storage.read('SELECT 1 FROM course_releases WHERE release_id=$1', [input.releaseId])).rows.length, 0);
    assert.equal((await f.storage.read('SELECT 1 FROM course_registrations WHERE request_id=$1', [requestId])).rows.length, 0);
    assert.deepEqual(await f.design.readCourseDeployment(f.teacher, preparation.requestId), preparation,
      'current unavailability never rewrites a historical preparation receipt');
    const checked = f.publicationChecks.at(-1);
    assert.equal(checked.courseId, input.courseId);
    assert.equal(checked.taskId, input.taskId);
    assert.equal(checked.releaseId, input.releaseId);
    assert.equal(checked.planDigest, plan.planDigest);
    assert.deepEqual(checked.placement, plan.placements[0]);
    assert.deepEqual(checked.binding, input.components[0]);
    assert.deepEqual(checked.preparation, preparation);
    f.setAvailable(new StorageError('unavailable'));
    await assert.rejects(f.publish(input, plan, f.courses, requestId), { code: 'unavailable' });
    assert.equal(await f.courses.registrationResult(requestId), null);
    f.setAvailable(true);
    const registered = await f.publish(input, plan, f.courses, requestId);
    assert.equal(registered.releaseId, input.releaseId);
    const checks = f.publicationChecks.length;
    f.setAvailable(false);
    assert.deepEqual(await f.publish(input, plan, withoutProbe, requestId), registered,
      'a lost successful publication reply is recovered without applying a new readiness decision');
    assert.equal(f.publicationChecks.length, checks);
    const local = await f.inputFor('student-runtime'), localPlan = await f.design.compileExecutionDesign(f.teacher, local);
    await f.design.prepareCourseDeployment(f.teacher, { requestId: randomUUID(), ...local, plan: localPlan });
    await f.publish(local, localPlan, withoutProbe);
    assert.equal(f.publicationChecks.length, checks, 'student execution never requires a school check');
  } finally { await f.close(); }
});
