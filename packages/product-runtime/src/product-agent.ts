import type { OwnedStorage } from '@xunjie/storage';
import { StorageError } from '@xunjie/storage';
import type { AgentRuntimeOptions, AgentScenario, AgentTool, Facts, HistoryEntry, ModelGatewaySource, ScenarioInput } from '@xunjie/agent-runtime';
import { resolveGateway } from '@xunjie/agent-runtime';
import type { AgentSession } from '@xunjie/contracts/agent-sessions';
import type { AgentSessionPort } from '@xunjie/contracts/agent-service';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import type { PersonalProject } from '@xunjie/contracts/student-learning';
import { createStudentAssistant } from '@xunjie/agents/student-assistant/index';
import { createTeacherAssistant } from '@xunjie/agents/teacher-assistant/index';
import type { LearningToolsHost } from '@xunjie/agents/student-assistant/tools/learning-tools';
import { createWorkspaceAssistant, type WorkspaceToolOptions } from '@xunjie/agents/workspace-assistant/index';
import type { AgentSessionApplicationHost, AgentSessionDirectory } from './agent-sessions.js';
import { createSessionRuntimeHost } from './session-runtime.js';
import { createWorkspaceAgentTasks, type WorkspaceTaskOwner } from './workspace-agent-tasks.js';
import { toolMaterial } from '@xunjie/agent-runtime/context';

/** Concrete scene ports per session: the product host builds real owner tools, not the kernel. */
export interface ProductAgentScene {
  student?: LearningToolsHost;
  workspace?: WorkspaceToolOptions;
  /** A dependency host supplies the Step's tool set from the data owner. */
  tools?(input: ScenarioInput): Promise<readonly AgentTool[]>;
  documents?: readonly AgentTool[];
  skills?: readonly AgentTool[];
  contextExtension?(input: ScenarioInput): Promise<string | undefined>;
  experimentMaterials?(input: ScenarioInput): Promise<readonly import('@xunjie/agent-runtime').ContextMaterial[]>;
  project?(identity: SpaceIdentity, activityId: string): Promise<PersonalProject | null>;
}
/** Fixed target facts the host permission hook needs before any inspected data is returned. */
export interface ProductAgentInspectionTarget {
  session: AgentSession;
  /** The exact Attempt/Turn/Step selected from the persisted snapshot, never a client claim. */
  attempt: { attemptId: string; stepId: string; turnId: string };
  /** Course activities proven by this Attempt's accepted materials, history and tool receipts. */
  activityIds: readonly string[];
  /** Course-level sources that have no activity link (for example a course material citation). */
  courseIds: readonly string[];
}
const recordOf = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
function collectInspectionSource(scope: { activityIds: Set<string>; courseIds: Set<string> }, value: unknown) {
  const source = recordOf(value);
  if (!source) return;
  if (typeof source.activityId === 'string') scope.activityIds.add(source.activityId);
  if (typeof source.courseId === 'string') scope.courseIds.add(source.courseId);
  const nestedScope = recordOf(source.scope);
  if (nestedScope && typeof nestedScope.activityId === 'string') scope.activityIds.add(nestedScope.activityId);
  // Tool receipts wrap the original fixed source under `source`; material lists carry
  // individual fixed references whose activity/course identity is equally enforceable.
  if (source.kind === 'tool-call') collectInspectionSource(scope, source.source);
  for (const key of ['references', 'items']) for (const value of Array.isArray(source[key]) ? source[key] as unknown[] : []) {
    const item = recordOf(value);
    collectInspectionSource(scope, item?.source ?? value);
  }
}
function collectInspectionSources(scope: { activityIds: Set<string>; courseIds: Set<string> }, values: unknown) {
  for (const value of Array.isArray(values) ? values : []) {
    const item = recordOf(value);
    collectInspectionSource(scope, item?.source ?? value);
  }
}
function collectInspectionMaterials(scope: { activityIds: Set<string>; courseIds: Set<string> }, values: unknown) {
  for (const value of Array.isArray(values) ? values : []) {
    const item = recordOf(value);
    // A failed/denied material can echo a client-provided activity id without proving access.
    if (!item || !['included', 'reference-only'].includes(String(item.readState))) continue;
    collectInspectionSource(scope, item.source);
  }
}
function inspectionScope(session: AgentSession, snapshot: Awaited<ReturnType<AgentSessionPort['sessionSnapshot']>>,
  step: { stepId: string; turnId: string; snapshot: Record<string, unknown> }, attemptId: string) {
  const scope = { activityIds: new Set<string>(), courseIds: new Set<string>() };
  // A workspace Session is itself fixed to one course activity. A home Session must prove
  // its link from the exact Attempt's accepted materials/history, never from raw client input
  // activity ids or the whole Session's unrelated Turns.
  if (session.workspace) scope.activityIds.add(session.workspace.activityId);
  const attemptContexts = recordOf(step.snapshot.attemptContexts);
  const assembly = recordOf(attemptContexts?.[attemptId]) ?? recordOf(step.snapshot.context);
  collectInspectionMaterials(scope, assembly?.materials);
  collectInspectionSources(scope, assembly?.historySources);
  for (const call of snapshot.toolCalls) {
    if (call.stepId !== step.stepId || call.attemptId !== attemptId) continue;
    collectInspectionSources(scope, toolMaterial(call).map(material => material.source));
  }
  return { activityIds: [...scope.activityIds].sort(), courseIds: [...scope.courseIds].sort() };
}
/** A prior Turn may be replayed inside the native request; it must fit the same approved scope. */
function priorTurnsWithinScope(session: AgentSession, snapshot: Awaited<ReturnType<AgentSessionPort['sessionSnapshot']>>,
  targetStepId: string, targetScope: { activityIds: readonly string[]; courseIds: readonly string[] }) {
  const targetIndex = snapshot.steps.findIndex(step => step.stepId === targetStepId);
  if (targetIndex < 0) return false;
  const activityIds = new Set(targetScope.activityIds), courseIds = new Set(targetScope.courseIds);
  for (const step of snapshot.steps.slice(0, targetIndex)) {
    const attempts = snapshot.attempts.filter(item => item.stepId === step.stepId);
    if (!attempts.length) return false;
    for (const attempt of attempts) {
      const scope = inspectionScope(session, snapshot, step, attempt.attemptId);
      if (!scope.activityIds.length && !scope.courseIds.length) return false;
      if (scope.activityIds.some(activityId => !activityIds.has(activityId))
        || scope.courseIds.some(courseId => !courseIds.has(courseId))) return false;
    }
  }
  return true;
}
export interface ProductAgentOptions {
  storage: OwnedStorage;
  directory: AgentSessionDirectory;
  models: ModelGatewaySource;
  budgetForSession?: AgentRuntimeOptions['budgetForSession'];
  authorize(identity: SpaceIdentity): Promise<void>;
  /** The trusted host checks the actor and this exact target; the kernel never weakens it. */
  authorizeInspection?(identity: SpaceIdentity, target: ProductAgentInspectionTarget): Promise<void>;
  /** Host-only trusted directory read; absent for standalone hosts that do not own the data. */
  inspectSession?(sessionId: string): Promise<AgentSession>;
  scene(session: AgentSession): Promise<ProductAgentScene>;
  taskOwner?: WorkspaceTaskOwner;
  /** The host's own observation cadence for terminal task facts; foreground only uses observe. */
  taskPollMs?: number;
  remote?(session: AgentSession): Promise<AgentSessionPort>;
  deleted?(session: AgentSession): Promise<void>;
  readOnly?: boolean;
  workspaceRequest?: AgentSessionApplicationHost['workspaceRequest'];
}

/** Both product hosts assemble scenes here and inject concrete tools into the shared kernel loop. */
export function createProductAgent(options: ProductAgentOptions) {
  const scenes = new Map<string, Promise<AgentScenario>>();
  function build(session: AgentSession): Promise<AgentScenario> {
    let pending = scenes.get(session.sessionId);
    if (!pending) {
      pending = (async () => {
          if (session.scenario === 'teacher-assistant') return createTeacherAssistant();
          const parts = await options.scene(session);
        if (session.scenario === 'student-assistant') {
          if (!parts.student && !parts.tools) throw new Error('missing-student-scene');
          return createStudentAssistant({ ...(parts.student ? { learning: parts.student } : {}),
            ...(parts.tools ? { tools: parts.tools } : {}),
            ...(parts.documents ? { documents: parts.documents } : {}), ...(parts.skills ? { skills: parts.skills } : {}),
            ...(parts.experimentMaterials ? { experimentMaterials: parts.experimentMaterials } : {}),
            ...(parts.contextExtension ? { contextExtension: parts.contextExtension } : {}) });
        }
        if (!parts.workspace) throw new Error('missing-workspace-scene');
        return createWorkspaceAssistant({ ...parts.workspace, ...(parts.tools ? { tools: parts.tools } : {}),
          ...(parts.documents ? { documents: parts.documents } : {}), ...(parts.skills ? { skills: parts.skills } : {}),
          ...(parts.contextExtension ? { contextExtension: parts.contextExtension } : {}),
          ...(parts.project ? { project: parts.project } : {}) });
      })();
      scenes.set(session.sessionId, pending);
      void pending.catch(() => { if (scenes.get(session.sessionId) === pending) scenes.delete(session.sessionId); });
    }
    return pending;
  }
  async function sceneFor(identity: SpaceIdentity, sessionId: string) {
    return build(await options.directory.read(identity, sessionId));
  }
  const dispatcher: AgentScenario = { id: 'product', version: 1,
    async context(input) {
      const scene = await sceneFor(input.identity, input.sessionId);
      const prepared = await scene.context(input);
      return { ...prepared, facts: scene.modelFacts ? scene.modelFacts(prepared.facts) : prepared.facts };
    },
    async tools(input) { return (await sceneFor(input.identity, input.sessionId)).tools(input); },
    async messageImages(input, contexts, route) {
      return (await sceneFor(input.identity, input.sessionId)).messageImages?.(input, contexts, route);
    },
    async authorizeHistory(input, history) {
      const scene = await sceneFor(input.identity, input.sessionId);
      if (!scene.authorizeHistory) return [...history];
      return [...await scene.authorizeHistory(input, history)];
    },
    async validateAnswer(presentation, answer) {
      // Student and workspace scenes validate teaching answers identically; any built scene suffices.
      for (const pending of scenes.values()) { const scene = await pending.catch(() => null); if (scene?.validateAnswer) return scene.validateAnswer(presentation, answer); }
    },
    async compactionFor(input) { return (await sceneFor(input.identity, input.sessionId)).compaction; },
  };
  let tasks: ReturnType<typeof createWorkspaceAgentTasks> | undefined;
  const host = createSessionRuntimeHost({ storage: options.storage, directory: options.directory,
    authorize: options.authorize, scenario: dispatcher, gateway: options.models, budgetForSession: options.budgetForSession,
    ...(options.readOnly ? { readOnly: options.readOnly } : {}),
    ...(options.remote ? { remote: options.remote } : {}), ...(options.deleted ? { deleted: options.deleted } : {}),
    ...(options.workspaceRequest ? { workspaceRequest: options.workspaceRequest } : {}),
    ...(options.taskOwner ? {
      taskFacts: { relevant: (input, consumed) => tasks!.taskFacts.relevant(input, consumed) },
      taskCancellation: { listNonTerminal: (s, t) => tasks!.taskCancellation.listNonTerminal(s, t),
        cancel: (s, t) => tasks!.taskCancellation.cancel(s, t),
        cancelCall: (s, t, c, r) => tasks!.taskCancellation.cancelCall!(s, t, c, r) },
    } : {}) });
  if (options.taskOwner) tasks = createWorkspaceAgentTasks({ storage: options.storage, owner: options.taskOwner,
    ...(options.taskPollMs ? { pollMs: options.taskPollMs } : {}),
    registerNotification: (identity, sessionId, originTurnId, fact) =>
      host.runtime.registerNotification(identity, sessionId, originTurnId, fact) });
  async function inspect(identity: SpaceIdentity, sessionId: string, target: { attemptId?: string; turnId?: string; stepId?: string }) {
    if (!options.authorizeInspection || !options.inspectSession) throw new StorageError('forbidden');
    // Trusted metadata lookup happens before any actor-scoped directory read. A regular student
    // route can never reach this method: the host exposes it only through the inspection port.
    const session = await options.inspectSession(sessionId);
    if (session.deleted) throw new StorageError('forbidden');
    if (session.owner.target.environmentId !== options.storage.owner.environmentId
      || session.owner.target.serviceId !== options.storage.owner.serviceId) throw new StorageError('forbidden');
    // Read the fixed runtime facts with the target's own identity, never the inspector's. This is
    // the same immutable snapshot a normal read would use and performs no model or tool action.
    const snapshot = await host.local.sessionSnapshot(session.identity, sessionId);
    const attempt = snapshot.attempts.filter(item => (!target.attemptId || item.attemptId === target.attemptId)
      && (!target.stepId || item.stepId === target.stepId)
      && (!target.turnId || snapshot.steps.find(step => step.stepId === item.stepId)?.turnId === target.turnId)).at(-1);
    // Do not distinguish a non-existent target from a private one before the host hook runs.
    if (!attempt) throw new StorageError('forbidden');
    const step = snapshot.steps.find(item => item.stepId === attempt.stepId);
    if (!step) throw new StorageError('corrupt');
    // The host-level permission hook receives the exact Attempt identity and evidence drawn
    // only from that Turn/Attempt. A whole-Session activity can never authorize a private one.
    const scope = inspectionScope(session, snapshot, step, attempt.attemptId);
    if (!scope.activityIds.length && !scope.courseIds.length) throw new StorageError('forbidden');
    await options.authorizeInspection(identity, { session,
      attempt: { attemptId: attempt.attemptId, stepId: step.stepId, turnId: step.turnId }, ...scope });
    await options.authorize(identity);
    const attemptContexts = step.snapshot.attemptContexts as Record<string, unknown> | undefined;
    const assembly = attemptContexts?.[attempt.attemptId] as {
      materials?: { sourceId: string; label: string; source: Facts; readState: string }[];
      historySources?: HistoryEntry['sources'];
    } | undefined;
    if (!assembly?.materials || !assembly.historySources) throw new StorageError('unavailable');
    const calls = 'purpose' in assembly && assembly.purpose === 'compaction'
      ? [] : snapshot.toolCalls.filter(call => call.stepId === step.stepId && call.attemptId === attempt.attemptId);
    const receipts: HistoryEntry[] = [...assembly.historySources, ...assembly.materials.filter(material =>
      material.readState === 'included' || material.readState === 'reference-only'), ...calls.flatMap(toolMaterial)]
      .map((source, index) => ({ id: 'inspection:' + index, version: 1, role: 'user', text: '', sources: [source] }));
    const workspaceInputs = snapshot.inputs.flatMap(item => {
      const action = item.input.context.action;
      return item.state === 'adopted' && action ? [{ inputId: item.inputId, action }] : [];
    });
    if (receipts.length) {
      // Current course withdrawal, prediction gates and home-session isolation are rechecked
      // under the target's own fixed identity; the inspector's authority is never substituted.
      const allowed = await dispatcher.authorizeHistory!({ identity: session.identity, sessionId, turnId: step.turnId,
        stepId: step.stepId, inputIds: [], sessionState: { workspaceInputs } }, receipts);
      const surviving = new Set(allowed.map(entry => entry.id));
      if (!receipts.every(entry => surviving.has(entry.id))) throw new StorageError('forbidden');
    }
    const requestInScope = priorTurnsWithinScope(session, snapshot, step.stepId, scope);
    const gateway = await resolveGateway(options.models, session.identity, sessionId);
    if (!gateway.checks.readRecorded) throw new StorageError('unavailable');
    const modelResult = requestInScope && attempt.requestRef
      ? await gateway.checks.readRecorded(session.identity, attempt.attemptId) : null;
    const request = modelResult ? await gateway.checks.requestPayload(session.identity, attempt.attemptId) : null;
    const capacities = step.snapshot.attemptCapacities as Record<string, unknown> | undefined;
    return { version: 1 as const, sessionId, turnId: step.turnId, stepId: step.stepId, attemptId: attempt.attemptId,
      assembly: requestInScope ? assembly : null, attempt, capacity: capacities?.[attempt.attemptId] ?? null,
      request: requestInScope ? request : null, result: requestInScope ? modelResult : null,
      ...(!requestInScope ? { redaction: { assembly: 'mixed-session-history', request: 'mixed-session-history',
        result: 'mixed-session-history', tools: 'mixed-session-history', citations: 'mixed-session-history' }, tools: [], citations: [] } : {
        tools: calls.map(call => ({ toolCallId: call.toolCallId, name: call.name, state: call.state, result: call.result })),
        citations: calls.filter(call => call.name === 'cite_source').flatMap(call => {
        const value = call.result?.kind === 'completed' && call.result.data && typeof call.result.data === 'object'
          && !Array.isArray(call.result.data) ? call.result.data.citation as Record<string, unknown> | undefined : undefined;
        return value ? [value] : [];
        }) }) };
  }
  return { ...host,
    inspect,
    observe: () => tasks?.observe() ?? Promise.resolve(),
    materials: async (identity: SpaceIdentity, sessionId: string) => {
      const session = await options.directory.read(identity, sessionId);
      const parts = await options.scene(session);
      if (!parts.student) throw new Error('missing-student-scene');
      return parts.student;
    } };
}
