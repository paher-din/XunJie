import { createHash } from 'node:crypto';
import { z } from 'zod';
import { StorageError, type OwnedStorage, type Migration } from '@xunjie/storage';
import { canonicalValue, courseExecutionPlanBasis, courseExecutionPlanV2Schema,
  type CourseExecutionPlanV2 } from '@xunjie/contracts/execution';
import { courseExecutionDesignInputSchema, prepareCourseDeploymentSchema, courseDeploymentSchema,
  type CourseDeployment } from '@xunjie/contracts/courses';
import { manifestResources, type ComponentBinding } from '@xunjie/contracts/components';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import { createComponents } from './components.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonicalValue(value))).digest('hex');
const fail = (): never => { throw new StorageError('invalid'); };
export const courseDeploymentMigration: Migration = { version: 11, name: 'course-execution-deployments', sql:
  'CREATE TABLE course_execution_deployments(request_id uuid PRIMARY KEY,course_id uuid NOT NULL,' +
  'task_id uuid NOT NULL,release_id uuid NOT NULL,plan_digest text NOT NULL,fingerprint text NOT NULL,' +
  'result jsonb NOT NULL,prepared_at timestamptz NOT NULL DEFAULT clock_timestamp());' +
  'CREATE INDEX course_execution_deployment_release ON course_execution_deployments(release_id,plan_digest);'
};

/** Reject fabricated targets, budgets, resource lists and component identities before publication. */
export function verifyCourseExecutionDesign(plan: CourseExecutionPlanV2, bindings: ComponentBinding[]): void {
  if (hash(courseExecutionPlanBasis(plan)) !== plan.planDigest || plan.components.length !== bindings.length) fail();
  const capabilities = new Set(bindings.flatMap(item => [...item.definition.manifest.requiredCapabilities] as string[]));
  if (plan.capabilities.some(item => item !== 'native-session' && !capabilities.has(item))) fail();
  const nativeBudgets: { memoryMiB: number; operationTimeoutMs: number; maxMs: number }[] = [];
  for (const binding of bindings) {
    const manifest = binding.definition.manifest;
    const planned = plan.components.find(item => item.key === binding.key);
    if (!planned || planned.definitionDigest !== binding.definition.digest
      || hash(binding.configuration) !== planned.configurationDigest) fail();
    const operations = manifest.formatVersion === 3 ? manifest.runtime.operations.map(item => item.operationId)
      : manifest.formatVersion === 1 ? (manifest.operations?.map(item => item.operationId)
        ?? (manifest.session ? [manifest.session.operation.operationId] : [])) : [];
    if (operations.length !== planned!.operations.length || operations.some(id => !planned!.operations.includes(id))) fail();
    const resources = [manifest.entry, ...manifestResources(manifest)].map(({ resourceId, sha256, byteLength }) =>
      ({ resourceId, sha256, byteLength }));
    for (const operationId of operations) {
      const placement = plan.placements.find(item => item.componentKey === binding.key && item.operationId === operationId) ?? fail();
      if (hash([...placement.resources].sort((a,b) => a.resourceId.localeCompare(b.resourceId)))
        !== hash([...resources].sort((a,b) => a.resourceId.localeCompare(b.resourceId)))) fail();
      let ceilings: Record<string, number>;
      if (manifest.formatVersion === 3) {
        if (placement.target !== 'student-browser') fail();
        ceilings = { ...manifest.runtime.operations.find(item => item.operationId === operationId)!.budgets,
          concurrentJobs: manifest.budget.concurrentJobs, queuedJobs: manifest.budget.queuedJobs };
        // This shipped adapter has a fixed WASM memory, not an enforceable lower heap allowance.
        // The manifest and the teacher's request must both match the actual v1 executor.
        if (manifest.runtime.adapterId === 'icarus-alu' && manifest.runtime.adapterVersion === 1
          && (ceilings.memoryMiB !== 256 || placement.budgets.memoryMiB !== 256)) fail();
      } else if (manifest.formatVersion === 1 && manifest.session) {
        if (placement.target === 'student-browser') fail();
        ceilings = { ...manifest.session.budgets };
        nativeBudgets.push(manifest.session.budgets);
        const envelope = plan.resources.native ?? fail();
        if (placement.budgets.memoryMiB! > envelope.memoryMiB
          || placement.budgets.operationTimeoutMs! > envelope.operationTimeoutMs
          || placement.budgets.maxMs! > envelope.maxMs) fail();
      } else if (manifest.formatVersion === 1) {
        if (placement.target !== 'student-browser' || !manifest.algorithm) fail();
        const operation = manifest.operations!.find(item => item.operationId === operationId)!;
        ceilings = { timeMs: operation.budgets.timeMs, outputBytes: operation.budgets.outputBytes,
          memoryPages: manifest.algorithm!.memoryPages, inputBytes: 1048576, concurrentJobs: 2, queuedJobs: 4 };
      } else return fail();
      const minimums: Record<string,number> = { timeMs: 50, memoryPages: 1, inputBytes: 1,
        outputBytes: 1, concurrentJobs: 1, operationTimeoutMs: 50, idleMs: 1000, maxMs: 1000,
        memoryMiB: 16, concurrentSessions: 1, compileTimeoutMs: 1000, simulateTimeoutMs: 100,
        jobTimeoutMs: 1000, textBytes: 1024, vcdBytes: 1024, resultBytes: 1024 };
      if (Object.entries(placement.budgets).some(([key,value]) => value < (minimums[key] ?? 0))) fail();
      if (Object.keys(placement.budgets).length !== Object.keys(ceilings).length
        || Object.entries(ceilings).some(([key, max]) => placement.budgets[key] === undefined
          || placement.budgets[key]! > max || (max > 0 && placement.budgets[key] === 0))) fail();
    }
  }
  for (const budget of nativeBudgets) {
    const requested = plan.resources.native ?? fail();
    if (requested.memoryMiB > budget.memoryMiB || requested.operationTimeoutMs > budget.operationTimeoutMs
      || requested.maxMs > budget.maxMs) fail();
  }
}

export interface CourseExecutionDesignOptions {
  /** Host must use formal teacher/admin authority; student course membership is insufficient. */
  authorize(identity: SpaceIdentity, courseId: string, operation: 'compile' | 'prepare' | 'read'): Promise<void>;
  /** Real school executor provisioning/readiness, never a caller-supplied readiness flag. */
  // Provisioning must also be idempotent by requestId + placement, including recovery after a crash.
  prepareSchoolRuntime?(input: { requestId: string; courseId: string; releaseId: string;
    planDigest: string; placement: CourseExecutionPlanV2['placements'][number]; binding: ComponentBinding }):
    Promise<{ ready: boolean; detail: string }>;
}

export interface CoursePublicationOptions {
  /** Read current readiness at publication; never provision or enable an executor here. */
  checkSchoolRuntime?(input: {
    courseId: string; taskId: string; releaseId: string; planDigest: string;
    placement: CourseExecutionPlanV2['placements'][number]; binding: ComponentBinding;
    preparation: CourseDeployment;
  }): Promise<{ ready: boolean; detail: string }>;
}

/** Course-owner persistence, exposed to future teacher Agents through the same authority. */
export function createCourseExecutionDesign(storage: OwnedStorage, options: CourseExecutionDesignOptions) {
  const components = createComponents(storage);
  async function compileExecutionDesign(identity: SpaceIdentity, value: unknown): Promise<CourseExecutionPlanV2> {
    const input = courseExecutionDesignInputSchema.parse(value);
    await options.authorize(identity, input.courseId, 'compile');
    const draft = courseExecutionPlanV2Schema.parse({ ...input.plan, planDigest: '0'.repeat(64) });
    const plan = { ...draft, planDigest: hash(courseExecutionPlanBasis(draft)) };
    if (input.plan.planDigest && input.plan.planDigest !== plan.planDigest) fail();
    verifyCourseExecutionDesign(plan, input.components);
    for (const binding of input.components) {
      await components.assertEnabled(binding.definition.manifest.componentId, binding.definition.manifest.version);
      await components.verify(binding.definition);
    }
    return plan;
  }
  async function prepareCourseDeployment(identity: SpaceIdentity, value: unknown): Promise<CourseDeployment> {
    const input = prepareCourseDeploymentSchema.parse(value);
    await options.authorize(identity, input.courseId, 'prepare');
    const fingerprint = hash(input);
    const prior = await storage.receipt(input.requestId, fingerprint);
    if (prior) return courseDeploymentSchema.parse(prior.result);
    const { requestId, ...design } = input;
    const plan = await compileExecutionDesign(identity, design);
    return courseDeploymentSchema.parse((await storage.request({ requestId, fingerprint }, async tx => {
    const targets: CourseDeployment['targets'] = [];
    for (const placement of plan.placements) {
      const ready = placement.target === 'school-runtime'
        ? await options.prepareSchoolRuntime?.({ requestId, courseId: input.courseId, releaseId: input.releaseId,
          planDigest: plan.planDigest, placement, binding: input.components.find(item => item.key === placement.componentKey)! })
        : { ready: true, detail: '课程资源已由课程 owner 验证保留；学生接入时已安装客户端自动准备。' };
      targets.push({ componentKey: placement.componentKey, operationId: placement.operationId, target: placement.target,
        state: ready?.ready ? 'ready' : 'unavailable', detail: ready?.detail ?? '教师指定的学校执行节点尚未就绪。' });
    }
    const result = courseDeploymentSchema.parse({ requestId, courseId: input.courseId, taskId: input.taskId,
      releaseId: input.releaseId, planDigest: plan.planDigest, plan,
      state: targets.every(item => item.state === 'ready') ? 'ready' : 'blocked', preparedAt: new Date().toISOString(), targets });
      await tx.query('INSERT INTO course_execution_deployments(request_id,course_id,task_id,release_id,plan_digest,fingerprint,result)' +
        ' VALUES($1,$2,$3,$4,$5,$6,$7)', [requestId, input.courseId, input.taskId, input.releaseId, plan.planDigest, fingerprint, JSON.stringify(result)]);
      return result;
    })).result);
  }
  async function readCourseDeployment(identity: SpaceIdentity, requestId: string): Promise<CourseDeployment | null> {
    z.uuid().parse(requestId);
    const { rows: [row] } = await storage.read('SELECT * FROM course_execution_deployments WHERE request_id=$1', [requestId]);
    if (!row) return null;
    await options.authorize(identity, String(row.course_id), 'read');
    return validatedDeployment(row);
  }
  return { compileExecutionDesign, prepareCourseDeployment, readCourseDeployment };
}

/** Publication requires the exact prepared plan and the school targets' current readiness. */
export async function assertCourseDeploymentPrepared(storage: OwnedStorage,
  input: { courseId: string; taskId: string; releaseId: string; plan: CourseExecutionPlanV2;
    components: ComponentBinding[] }, options: CoursePublicationOptions = {}) {
  const { rows } = await storage.read('SELECT * FROM course_execution_deployments' +
    ' WHERE course_id=$1 AND task_id=$2 AND release_id=$3 AND plan_digest=$4',
  [input.courseId, input.taskId, input.releaseId, input.plan.planDigest]);
  const preparation = rows.map(validatedDeployment).find(item => item.state === 'ready');
  if (!preparation) throw new StorageError('unavailable');
  for (const placement of input.plan.placements) {
    if (placement.target !== 'school-runtime') continue;
    const binding = input.components.find(item => item.key === placement.componentKey);
    if (!binding) fail();
    const current = await options.checkSchoolRuntime?.({ courseId: input.courseId, taskId: input.taskId,
      releaseId: input.releaseId, planDigest: input.plan.planDigest, placement, binding: binding!, preparation });
    if (current?.ready !== true) throw new StorageError('unavailable');
  }
}

function validatedDeployment(row: Record<string,unknown>): CourseDeployment {
  const parsed = courseDeploymentSchema.safeParse(row.result);
  if (!parsed.success) throw new StorageError('corrupt');
  const value = parsed.data;
  if (value.requestId !== row.request_id || value.courseId !== row.course_id
    || value.taskId !== row.task_id || value.releaseId !== row.release_id
    || value.planDigest !== row.plan_digest || value.planDigest !== value.plan.planDigest
    || hash(courseExecutionPlanBasis(value.plan)) !== value.planDigest
    || value.targets.length !== value.plan.placements.length
    || value.targets.some((item,index) => {
      const placement = value.plan.placements[index]!;
      return item.componentKey !== placement.componentKey || item.operationId !== placement.operationId
        || item.target !== placement.target;
    })
    || (value.state === 'ready') !== value.targets.every(item => item.state === 'ready')) throw new StorageError('corrupt');
  return value;
}
export async function validateCourseDeployments(storage: OwnedStorage): Promise<void> {
  const { rows } = await storage.read('SELECT * FROM course_execution_deployments');
  for (const row of rows) validatedDeployment(row);
}
