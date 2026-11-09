import { z } from 'zod';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);

/** Fixed client platforms the product installs on. A plan names them; it never discovers a device. */
export const executionPlatformSchema = z.enum(['linux-x64', 'macos-arm64', 'windows-x64']);
export type ExecutionPlatform = z.infer<typeof executionPlatformSchema>;
/** Browser features an execution plan may require before a job is allowed to start. */
export const browserExecutionFeatureSchema = z.enum(['worker', 'webassembly', 'sandboxed-frame']);
export type BrowserExecutionFeature = z.infer<typeof browserExecutionFeatureSchema>;

/**
 * One task-level execution plan published with the course release. It pins the component and
 * configuration the teacher reviewed, what the run needs, and where it may happen. It never names an
 * owner, a node or a student choice: a location is a way to run, not a machine to borrow.
 */
export const legacyCourseExecutionPlanSchema = z.object({
  planId: identifier, planVersion: z.number().int().positive(),
  /** SHA-256 over `courseExecutionPlanBasis(plan)`, computed by the owner that publishes the plan. */
  planDigest: digest,
  components: z.array(z.object({ key: identifier, definitionDigest: digest, configurationDigest: digest,
    /** Empty only when the bound component declares no execution operations. */
    operations: z.array(identifier).max(4) }).strict()).min(1).max(8),
  capabilities: z.array(z.enum(['workspace.read', 'workspace.change', 'material.highlight', 'execution.submit',
    'native-session'])).max(5),
  resources: z.object({
    browser: z.object({ features: z.array(browserExecutionFeatureSchema).min(1).max(3) }).strict().nullable(),
    native: z.object({ memoryMiB: z.number().int().min(16).max(512),
      operationTimeoutMs: z.number().int().min(50).max(30000), maxMs: z.number().int().min(1000).max(86400000) }).strict().nullable(),
  }).strict(),
  locations: z.array(z.enum(['browser', 'native'])).min(1).max(2),
  /** The only arrangement under which a device that genuinely cannot run the task may use a school node. */
  remote: z.object({ nodeClass: z.literal('school-execution-node'), secureTransport: z.literal(true),
    adapter: z.object({ adapterId: identifier, adapterVersion: z.number().int().positive() }).strict(),
    clientPlatforms: z.array(executionPlatformSchema).min(1).max(3) }).strict().nullable(),
}).strict()
  .refine(value => new Set(value.components.map(item => item.key)).size === value.components.length,
    { message: 'Plan component keys must be unique' })
  .refine(value => new Set(value.locations).size === value.locations.length,
    { message: 'A plan lists each location once' })
  .refine(value => (value.resources.browser !== null) === value.locations.includes('browser'),
    { message: 'A browser location and its required features are declared together' })
  .refine(value => (value.resources.native !== null) === value.locations.includes('native'),
    { message: 'A native location and its budgets are declared together' })
  .refine(value => !value.locations.includes('browser') || value.capabilities.includes('execution.submit'),
    { message: 'A browser location requires the execution capability' })
  .refine(value => !value.locations.includes('native') || value.capabilities.includes('native-session'),
    { message: 'A native location requires the native session capability' })
  .refine(value => value.remote === null || value.locations.includes('native'),
    { message: 'A remote arrangement needs the native location' });
/** Teacher placement is fixed per component/operation, never a student preference. */
export const executionTargetSchema = z.enum(['student-browser', 'student-runtime', 'school-runtime']);
export type ExecutionTarget = z.infer<typeof executionTargetSchema>;
export const courseExecutionPlacementSchema = z.object({
  componentKey: identifier, operationId: identifier, target: executionTargetSchema,
  resources: z.array(z.object({ resourceId: z.uuid(), sha256: digest,
    byteLength: z.number().int().positive() }).strict()).min(1).max(64),
  /** Keys and ceilings are checked against the operation's manifest before compilation. */
  budgets: z.record(z.string().min(1).max(48), z.number().int().nonnegative())
    .transform(value => Object.fromEntries(Object.entries(value).sort(([a],[b]) => a.localeCompare(b, 'en')))),
}).strict().refine(value => new Set(value.resources.map(item => item.resourceId)).size === value.resources.length,
  'Each resource is declared once');
export const courseExecutionPlanV2Schema = legacyCourseExecutionPlanSchema.safeExtend({
  version: z.literal(2), placements: z.array(courseExecutionPlacementSchema).max(32),
}).refine(plan => {
  const pairs = plan.placements.map(item => item.componentKey + '/' + item.operationId);
  return new Set(pairs).size === pairs.length
    && plan.components.every(item => item.operations.every(operation => pairs.includes(item.key + '/' + operation)))
    && pairs.length === plan.components.reduce((total, item) => total + item.operations.length, 0)
    && plan.placements.every(item => plan.locations.includes(item.target === 'student-browser' ? 'browser' : 'native'))
    && plan.locations.every(location => plan.placements.some(item => location === 'browser'
      ? item.target === 'student-browser' : item.target !== 'student-browser'));
}, 'Exactly one teacher placement is required for each component operation');
export type CourseExecutionPlanV2 = z.infer<typeof courseExecutionPlanV2Schema>;
export const courseExecutionPlanSchema = z.union([legacyCourseExecutionPlanSchema, courseExecutionPlanV2Schema]);
export type CourseExecutionPlan = z.infer<typeof courseExecutionPlanSchema>;
export function isCourseExecutionPlanV2(plan: CourseExecutionPlan): plan is CourseExecutionPlanV2 {
  return 'version' in plan && plan.version === 2;
}
export interface CourseExecutionPlanBasis {
  version?: 2; placements?: CourseExecutionPlanV2['placements'];
  planId: string; planVersion: number;
  components: { key: string; definitionDigest: string; configurationDigest: string; operations: string[] }[];
  capabilities: string[];
  resources: { browser: { features: string[] } | null;
    native: { memoryMiB: number; operationTimeoutMs: number; maxMs: number } | null };
  locations: string[];
  remote: { nodeClass: string; secureTransport: boolean; adapter: { adapterId: string; adapterVersion: number };
    clientPlatforms: string[] } | null;
}
/**
 * The one canonical form every digest uses: sorted keys at every level, so `JSON.stringify`
 * produces the same bytes on both sides of an owner boundary. Publishing an execution plan and
 * accepting an execution command must not be able to disagree about this rule.
 */
export function canonicalValue(value: unknown): unknown {
  return Array.isArray(value) ? value.map(canonicalValue)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right, 'en'))
        .map(([key, child]) => [key, canonicalValue(child)]))
      : value;
}
/**
 * The exact content every owner hashes to obtain the plan digest:
 * `sha256(JSON.stringify(courseExecutionPlanBasis(plan)))`. Ordering is normalised here so an
 * authoring tool and the publishing owner cannot disagree about the same plan.
 */
export function courseExecutionPlanBasis(plan: CourseExecutionPlan): CourseExecutionPlanBasis {
  const byKey = (left: string, right: string) => left.localeCompare(right, 'en');
  return canonicalValue({ ...(isCourseExecutionPlanV2(plan) ? { version: 2,
    placements: plan.placements.map(item => ({ ...item, resources: [...item.resources].sort((a,b) => byKey(a.resourceId,b.resourceId)) }))
      .sort((a,b) => byKey(a.componentKey,b.componentKey) || byKey(a.operationId,b.operationId)) } : {}),
    planId: plan.planId, planVersion: plan.planVersion,
    components: plan.components.map(item => ({ key: item.key, definitionDigest: item.definitionDigest,
      configurationDigest: item.configurationDigest, operations: [...item.operations] }))
      .sort((left, right) => byKey(left.key, right.key)),
    capabilities: [...plan.capabilities].sort(byKey),
    resources: { browser: plan.resources.browser ? { features: [...plan.resources.browser.features].sort(byKey) } : null,
      native: plan.resources.native ? { memoryMiB: plan.resources.native.memoryMiB,
        operationTimeoutMs: plan.resources.native.operationTimeoutMs, maxMs: plan.resources.native.maxMs } : null },
    locations: [...plan.locations].sort(byKey),
    remote: plan.remote ? { nodeClass: plan.remote.nodeClass, secureTransport: plan.remote.secureTransport,
      adapter: { adapterId: plan.remote.adapter.adapterId, adapterVersion: plan.remote.adapter.adapterVersion },
      clientPlatforms: [...plan.remote.clientPlatforms].sort(byKey) } : null }) as CourseExecutionPlanBasis;
}

/**
 * What this device really observed about itself; only the caller can report it, no owner can infer it.
 * `null` means "not observed", never "unsupported": a browser cannot attest its own CPU architecture,
 * and a page that has not asked the local runtime anything has no native facts to report.
 */
export const executionDeviceSchema = z.object({
  platform: executionPlatformSchema.nullable(),
  browser: z.object({ worker: z.boolean(), webassembly: z.boolean(), sandboxedFrame: z.boolean() }).strict(),
  native: z.object({ supported: z.boolean(), installed: z.boolean(), authorized: z.boolean(),
    prepared: z.enum(['ready', 'preparing', 'failed', 'none']) }).strict().nullable(),
}).strict();
export type ExecutionDevice = z.infer<typeof executionDeviceSchema>;

export const executionDecisionStateSchema = z.enum(['browser-satisfied', 'native-required', 'install-missing',
  'authorization-pending', 'preparation-failed', 'device-unsupported', 'school-required', 'target-unavailable']);
export type ExecutionDecisionState = z.infer<typeof executionDecisionStateSchema>;
/**
 * One operation's placement answer. `location` and `owner` are filled only when a run may start now;
 * a missing install, a pending authorization and a failed preparation never become a relocation.
 */
export const executionDecisionSchema = z.object({ operationId: identifier, state: executionDecisionStateSchema,
  location: z.enum(['browser', 'native']).nullable(), owner: z.enum(['device', 'school-node']).nullable(),
  remote: z.object({ declared: z.boolean(), available: z.boolean() }).strict(), detail: z.string().min(1).max(300) }).strict()
  .refine(value => (value.location === null) === (value.owner === null),
    { message: 'A decision names a location and an owner together, or neither' })
  .refine(value => value.owner !== 'school-node' || value.location === 'native',
    { message: 'A school node runs a native session, never a browser job' })
  .refine(value => value.owner !== 'school-node' || value.state === 'device-unsupported' || value.state === 'school-required',
    { message: 'Only a device that cannot run the operation uses the school node' })
  .refine(value => value.owner !== 'school-node' || value.remote.available,
    { message: 'A school node is chosen only while an eligible node is registered' });
export type ExecutionDecision = z.infer<typeof executionDecisionSchema>;

export interface ExecutionPlacementInput {
  componentKey?: string;
  operationId: string; kind: 'job' | 'session';
  /** The product adapter a native session declares; absent for a browser job. */
  adapter: { adapterId: string; adapterVersion: number } | null;
  plan: CourseExecutionPlan; device: ExecutionDevice;
  /** Whether a registered school execution node can take this operation right now. */
  remoteAvailable: boolean;
}
/**
 * The one placement rule. A run that could start here never moves because of a failure, a lost
 * connection or a convenience preference; only a device limitation the plan already anticipated does.
 */
export function decideExecutionPlacement(input: ExecutionPlacementInput): ExecutionDecision {
  const { plan, device } = input;
  const matches = plan.components.filter(item => item.operations.includes(input.operationId)
    && (input.componentKey === undefined || item.key === input.componentKey));
  if (!matches.length || isCourseExecutionPlanV2(plan) && matches.length !== 1) throw new Error('not-planned');
  const component = matches[0];
  if (!component) throw new Error('not-planned');
  const planned = input.kind === 'job' ? plan.locations.includes('browser') : plan.locations.includes('native');
  if (!planned) throw new Error('not-planned');
  const fixed = isCourseExecutionPlanV2(plan) ? plan.placements.find(item => item.componentKey === component.key
    && item.operationId === input.operationId) : undefined;
  if (fixed && ((fixed.target === 'student-browser') !== (input.kind === 'job'))) throw new Error('not-planned');
  const remoteApplicable = plan.remote !== null && input.adapter !== null && device.platform !== null
    && plan.remote.adapter.adapterId === input.adapter.adapterId
    && plan.remote.adapter.adapterVersion === input.adapter.adapterVersion
    && plan.remote.clientPlatforms.includes(device.platform);
  const remote = fixed ? { declared: fixed.target === 'school-runtime',
    available: fixed.target === 'school-runtime' && input.remoteAvailable }
    : { declared: plan.remote !== null, available: remoteApplicable && input.remoteAvailable };
  const decision = (state: ExecutionDecisionState, location: 'browser' | 'native' | null,
    owner: 'device' | 'school-node' | null, detail: string): ExecutionDecision =>
    executionDecisionSchema.parse({ operationId: input.operationId, state, location, owner, remote, detail });
  if (fixed?.target === 'school-runtime') return remote.available
    ? decision('school-required', 'native', 'school-node', '按教师发布方案在学校执行节点运行。')
    : decision('target-unavailable', null, null, '教师指定的学校执行节点不可用，等待原位置恢复。');
  if (input.kind === 'job') {
    const observed: Record<BrowserExecutionFeature, boolean> = { worker: device.browser.worker,
      webassembly: device.browser.webassembly, 'sandboxed-frame': device.browser.sandboxedFrame };
    const missing = (plan.resources.browser?.features ?? []).filter(feature => !observed[feature]);
    if (!missing.length) return decision('browser-satisfied', 'browser', 'device', '当前浏览器已满足课程方案声明的执行条件。');
    // A restricted browser job has no other declared form; it is never re-expressed as a session.
    return decision('device-unsupported', null, null, `当前浏览器缺少 ${missing.join('、')}，该操作只允许在浏览器执行。`);
  }
  // Without an observed native capability nothing here is known, so nothing is promised or relocated.
  if (device.native === null)
    return decision('device-unsupported', null, null, '本机尚未报告原生执行能力，没有可在本机开始的会话。');
  if (device.native.supported) {
    if (!device.native.installed) return decision('install-missing', null, null, '本机还缺少该组件的运行环境，先完成安装。');
    if (!device.native.authorized) return decision('authorization-pending', null, null, '本机运行环境等待授权后才能开始。');
    if (device.native.prepared === 'failed')
      return decision('preparation-failed', null, null, '本机运行环境上次准备失败，可直接重试准备，不转到学校节点。');
    if (device.native.prepared !== 'ready') return decision('install-missing', null, null, '本机运行环境尚未完成准备。');
    return decision('native-required', 'native', 'device', '该操作需要原生会话，本机环境已就绪。');
  }
  if (!fixed && remote.available)
    return decision('device-unsupported', 'native', 'school-node', '本机不支持该原生会话，按课程方案在已登记的学校执行节点运行。');
  return decision('device-unsupported', null, null, remote.declared
    ? '本机不支持该原生会话，课程方案声明的学校节点当前不可用。'
    : '本机不支持该原生会话，课程方案也没有安排其他执行位置。');
}

export interface PlannedExecution {
  key: string; definitionDigest: string; operationId: string; location: 'browser' | 'native';
  target?: ExecutionTarget; budgets?: Record<string, number>;
}
/**
 * Whether the plan the activity was opened with still allows this run. `drifted` means the plan no
 * longer describes the bound component, which is corrupted storage rather than a user choice.
 */
export function plannedExecutionScope(plan: CourseExecutionPlan | null | undefined,
  input: PlannedExecution): 'allowed' | 'drifted' | 'forbidden' {
  if (!plan) return 'allowed';
  const planned = plan.components.find(item => item.key === input.key);
  if (!planned || planned.definitionDigest !== input.definitionDigest) return 'drifted';
  if (!planned.operations.includes(input.operationId)) return 'forbidden';
  if (!plan.locations.includes(input.location)) return 'forbidden';
  if (isCourseExecutionPlanV2(plan)) {
    const fixed = plan.placements.find(item => item.componentKey === input.key && item.operationId === input.operationId);
    if (!fixed || (fixed.target === 'student-browser') !== (input.location === 'browser')
      || input.target !== undefined && fixed.target !== input.target) return 'forbidden';
    if (input.budgets && Object.entries(input.budgets).some(([key, value]) =>
      fixed.budgets[key] === undefined || value > fixed.budgets[key]!)) return 'forbidden';
  }
  return 'allowed';
}
