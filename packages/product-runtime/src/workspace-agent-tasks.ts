import { z } from 'zod';
import { StorageError, type OwnedStorage } from '@xunjie/storage';
import { operationId } from '@xunjie/storage/identity';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import { spaceIdentitySchema } from '@xunjie/contracts/spaces';
import { isTerminalExecutionState, type ExecutionState } from '@xunjie/contracts/execution';
import type { AgentNotification, AgentRuntimeSession } from '@xunjie/contracts/agent-runtime';
import type { ScenarioInput, TaskTerminalFact, TaskFactsPort, TaskFact, TaskCancellationPort } from '@xunjie/agent-runtime';

/**
 * Replaces the deleted workspace-agent-waits bridge. The course task owner runs and confirms real
 * terminal states; this product bridge only turns registered background terminals into Session
 * notifications, enumerates a stopped Turn's tasks for idempotent cancellation, and selects the
 * deterministic task facts the model may see. It never dispatches execution and never invents a
 * second loop: terminal delivery goes through the kernel's registerNotification, cancellation
 * through the kernel's durable cancel intent, and facts through the kernel's TaskFactsPort.
 */

/** One durable task fact read from the course owner. `taskId` is the execution requestId. */
export interface WorkspaceTaskRecord {
  taskId: string;
  activityId: string;
  identity: SpaceIdentity;
  /** Agent Session that owns the origin Turn; tracking only, never an authorization boundary. */
  sessionId: string;
  originTurnId: string;
  state: ExecutionState;
  statusKnowledge: 'confirmed' | 'unknown';
  confirmedSeq: number;
  name: string;
  summary: string;
  resultRef: string | null;
}

/**
 * The real course owner seam. Implementations read existing owner records (never re-dispatch) and
 * cancel through the owner's existing stop path. Enumeration/delivery happen outside transactions
 * and survive restart because every fact is derived from durable owner records.
 */
export interface WorkspaceTaskOwner {
  /** Read-only current/terminal fact for a task; null when the owner holds no such task. */
  read(taskId: string): Promise<WorkspaceTaskRecord | null>;
  /** Tasks whose origin Turn == turnId for this Session, from durable association records. */
  listByOriginTurn(sessionId: string, turnId: string): Promise<WorkspaceTaskRecord[]>;
  /** Idempotent cancel via the owner's existing stop path; a repeated call is a no-op. */
  cancel(taskId: string): Promise<void>;
}

export interface WorkspaceAgentTasksOptions {
  /** The Agent kernel storage: background ToolCall registrations, Turns, inputs and Session state. */
  storage: OwnedStorage;
  owner: WorkspaceTaskOwner;
  /** Trusted host bridge into the kernel; derives a stable notificationId from taskId+taskVersion. */
  registerNotification(identity: SpaceIdentity, sessionId: string, originTurnId: string, fact: TaskTerminalFact): Promise<{ notificationId: string; turnId: string | null }>;
  timers?: { setTimeout(callback: () => void, delayMs: number): unknown; clearTimeout(timer: unknown): void };
  /** Observation cadence for the owner's terminal events; progress never triggers the model. */
  pollMs?: number;
}

const terminalStatus = (state: ExecutionState): TaskTerminalFact['terminalStatus'] | null =>
  state === 'succeeded' ? 'success' : state === 'failed' ? 'failed' : state === 'cancelled' ? 'cancelled' : null;
const isConfirmedTerminal = (record: WorkspaceTaskRecord) =>
  record.statusKnowledge === 'confirmed' && isTerminalExecutionState(record.state);
const taskVersion = (record: WorkspaceTaskRecord) => String(record.confirmedSeq);

/** Structured UI references and trusted tool-query taskIds; never arbitrary text similarity. */
const explicitReferenceSchema = z.object({
  taskId: z.string().min(1).max(200).optional(),
  taskRefs: z.array(z.union([z.string().min(1).max(200), z.object({ taskId: z.string().min(1).max(200) }).passthrough()])).max(64).optional(),
}).passthrough();
function explicitTaskRefs(context: unknown): string[] {
  const parsed = explicitReferenceSchema.safeParse(context);
  if (!parsed.success) return [];
  const refs = new Set<string>();
  if (parsed.data.taskId) refs.add(parsed.data.taskId);
  for (const ref of parsed.data.taskRefs ?? []) refs.add(typeof ref === 'string' ? ref : ref.taskId);
  return [...refs];
}

/**
 * Construction registers no timers and performs no storage scan. The product drives observation
 * through its existing poll loop (observe) or a cadence timer; both merge into one serial scan.
 */
export function createWorkspaceAgentTasks(options: WorkspaceAgentTasksOptions) {
  const { storage, owner } = options;
  const timers = options.timers ?? {
    setTimeout(callback: () => void, delayMs: number) { const timer = setTimeout(callback, delayMs); timer.unref(); return timer; },
    clearTimeout(timer: unknown) { clearTimeout(timer as ReturnType<typeof setTimeout>); },
  };
  let closed = false;
  let scanning: Promise<void> | null = null;
  let queued = false;
  let timer: unknown = null;

  async function sessionIdentity(sessionId: string): Promise<SpaceIdentity> {
    const { rows: [row] } = await storage.read('SELECT body FROM agent_runtime_sessions WHERE session_id=$1', [sessionId]);
    if (!row) throw new StorageError('missing');
    return (row.body as AgentRuntimeSession).identity;
  }

  /** Background ToolCall registrations: the only tasks whose terminals may wake the model. */
  async function registeredBackground(): Promise<{ taskId: string; sessionId: string; originTurnId: string; identity: SpaceIdentity }[]> {
    const { rows } = await storage.read(`SELECT c.task_id, t.session_id, t.turn_id, sess.body
      FROM agent_tool_calls c
      JOIN agent_steps s USING(step_id)
      JOIN agent_turns t USING(turn_id)
      JOIN agent_runtime_sessions sess ON sess.session_id = t.session_id
      WHERE c.execution_mode='background' AND c.task_id IS NOT NULL
      ORDER BY c.created_at, c.tool_call_id`);
    return rows.map(row => ({ taskId: String(row.task_id), sessionId: String(row.session_id),
      originTurnId: String(row.turn_id), identity: (row.body as AgentRuntimeSession).identity }));
  }

  /** One serial pass: deliver only registered background terminals that the owner confirmed. */
  async function scanOnce(): Promise<void> {
    for (const registration of await registeredBackground()) {
      if (closed) return;
      const record = await owner.read(registration.taskId);
      if (!record || !isConfirmedTerminal(record)) continue;
      // The owner record must name the same Session/origin Turn the kernel registered.
      if (record.sessionId !== registration.sessionId || record.originTurnId !== registration.originTurnId)
        throw new StorageError('identity-conflict');
      const status = terminalStatus(record.state);
      if (!status) continue;
      await options.registerNotification(registration.identity, registration.sessionId, registration.originTurnId,
        { taskId: record.taskId, taskVersion: taskVersion(record), terminalStatus: status,
          summary: record.summary, resultRef: record.resultRef });
    }
  }
  function scan(): Promise<void> {
    if (closed) return Promise.resolve();
    if (scanning) { queued = true; return scanning; }
    scanning = (async () => {
      do { queued = false; await scanOnce(); } while (queued && !closed);
    })().finally(() => { scanning = null; });
    return scanning;
  }
  function schedule() {
    if (closed || timer !== null || options.pollMs === undefined) return;
    timer = timers.setTimeout(() => { timer = null; void scan().then(schedule, schedule); }, options.pollMs);
  }
  /** Trigger an immediate merged observation; the product poll loop calls this. */
  function observe(): Promise<void> { const result = scan(); schedule(); return result; }

  // ---- TaskCancellationPort: only the given Turn's non-terminal tasks, idempotent delivery ----
  const taskCancellation: TaskCancellationPort = {
    async listNonTerminal(sessionId, turnId) {
      const records = await owner.listByOriginTurn(sessionId, turnId);
      return records.filter(record => !isConfirmedTerminal(record)).map(record => ({ taskId: record.taskId }));
    },
    async cancel(_sessionId, taskId) { await owner.cancel(taskId); },
  };

  // ---- TaskFactsPort: deterministic selection by real association, never the whole ledger ----
  async function inputContext(sessionId: string, inputId: string): Promise<unknown> {
    const { rows: [row] } = await storage.read('SELECT body FROM agent_inputs WHERE session_id=$1 AND input_id=$2', [sessionId, inputId]);
    return row ? (row.body as { context?: unknown }).context : undefined;
  }
  async function turnTrigger(sessionId: string, turnId: string): Promise<string | null> {
    const { rows: [row] = [] } = await storage.read('SELECT trigger FROM agent_turns WHERE session_id=$1 AND turn_id=$2', [sessionId, turnId]);
    return row ? String(row.trigger) : null;
  }
  /** Unresolved effects of interrupted/stopped/failed Turns: unknown outcomes and unconfirmed tasks. */
  async function unresolvedEffects(sessionId: string): Promise<string[]> {
    const { rows } = await storage.read(`SELECT c.task_id, c.result
      FROM agent_tool_calls c
      JOIN agent_steps s USING(step_id)
      JOIN agent_turns t USING(turn_id)
      WHERE t.session_id=$1 AND t.state IN ('stopped','interrupted','failed')
      ORDER BY c.created_at, c.tool_call_id`, [sessionId]);
    const candidates = new Set<string>();
    for (const row of rows) {
      if (row.task_id) candidates.add(String(row.task_id));
      const result = row.result as { taskId?: unknown } | null;
      if (result && typeof result.taskId === 'string') candidates.add(result.taskId);
    }
    // The continue chain keeps associations until a real query/receipt confirms them resolved.
    const state = await storage.read('SELECT state FROM agent_runtime_sessions WHERE session_id=$1', [sessionId]);
    const carried = (state.rows[0]?.state as { unresolvedTasks?: unknown } | undefined)?.unresolvedTasks;
    if (Array.isArray(carried)) for (const item of carried) if (typeof item === 'string') candidates.add(item);
    const unresolved: string[] = [];
    for (const taskId of candidates) {
      const record = await owner.read(taskId);
      if (!record || !isConfirmedTerminal(record)) unresolved.push(taskId);
    }
    return unresolved;
  }
  const taskFacts: TaskFactsPort = {
    async relevant(input: ScenarioInput, consumedNotifications: readonly AgentNotification[]): Promise<TaskFact[]> {
      const priorities = new Map<string, number>();
      const claim = (taskId: string, priority: number) => {
        const prior = priorities.get(taskId);
        if (prior === undefined || priority < prior) priorities.set(taskId, priority);
      };
      // 1. This Turn's explicit structured references / trusted tool-query taskIds.
      for (const inputId of input.inputIds)
        for (const taskId of explicitTaskRefs(await inputContext(input.sessionId, inputId))) claim(taskId, 0);
      // 2. Tasks this Step's consumed notifications point to.
      for (const notification of consumedNotifications) claim(notification.taskId, 1);
      // 3. A manual continue resolves the prior interrupted/stopped/failed Turn's possible effects.
      if (await turnTrigger(input.sessionId, input.turnId) === 'continue')
        for (const taskId of await unresolvedEffects(input.sessionId)) claim(taskId, 0);
      const facts: TaskFact[] = [];
      for (const [taskId, priority] of [...priorities.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))) {
        const record = await owner.read(taskId);
        if (!record) continue;
        facts.push({ taskId, taskVersion: taskVersion(record), name: record.name, status: record.state,
          summary: record.summary, resultRef: record.resultRef, priority });
      }
      return facts;
    },
  };

  return {
    taskFacts, taskCancellation, observe, scan,
    closeDispatch() { closed = true; if (timer !== null) { timers.clearTimeout(timer); timer = null; } },
    async drain() { if (scanning) await scanning; },
  };
}
export type WorkspaceAgentTasks = ReturnType<typeof createWorkspaceAgentTasks>;

/**
 * Concrete course-owner adapter over the learning-space execution ledger. Reads only existing
 * association/terminal records (never dispatch); cancellation reuses the owner's agent stop path.
 * `sessionIdOfTurn` resolves the kernel Turn→Session tracking link supplied by the product host.
 */
export function createLearningSpaceTaskOwner(options: {
  storage: OwnedStorage;
  /** The owner's agent execution facade (read/stop); never the dispatch path. */
  executions: {
    read(identity: SpaceIdentity, activityId: string, requestId: string): Promise<{ state: ExecutionState; statusKnowledge: 'confirmed' | 'unknown'; confirmedSeq: number; reason: { detail: string } | null; output: { contentId: string } | null; executionRef: string } | null>;
    agent: { stop(identity: SpaceIdentity, activityId: string, context: { runId: string; stepId: string; commandId: string; snapshotId: string; assertDispatch(): Promise<void> }, requestId: string, value: { stopId: string; reason: string }): Promise<unknown> };
  };
  sessionIdOfTurn(turnId: string): Promise<string>;
  /** Short human task name from the original action; defaults to the operation id. */
  taskName?(body: unknown): string;
}): WorkspaceTaskOwner {
  const { storage, executions } = options;
  const associationSchema = z.object({ runId: z.uuid(), stepId: z.uuid(), commandId: z.uuid(), snapshotId: z.uuid() });
  async function origin(commandId: string) {
    const { rows: [row] } = await storage.read(`SELECT c.command_id, c.request_id, c.activity_id, c.association, c.body_text, o.identity
      FROM agent_execution_commands c JOIN agent_execution_origins o ON o.command_id=c.command_id
      WHERE c.command_id=$1 AND c.kind='submit'`, [commandId]);
    if (!row) return null;
    const association = associationSchema.parse(row.association);
    const identity = spaceIdentitySchema.parse(row.identity);
    const body = JSON.parse(String(row.body_text)) as { execution?: { operation?: { operationId?: string } } };
    const name = options.taskName?.(body) ?? body.execution?.operation?.operationId ?? '课程任务';
    return { row, association, identity, name };
  }
  async function fact(commandId: string): Promise<WorkspaceTaskRecord | null> {
    const found = await origin(commandId);
    if (!found) return null;
    const { row, association, identity, name } = found;
    const activityId = String(row.activity_id), requestId = String(row.request_id);
    const query = await executions.read(identity, activityId, requestId);
    const sessionId = await options.sessionIdOfTurn(association.runId);
    if (!query) {
      // Accepted but no execution yet: a queued, unconfirmed task the owner still tracks.
      return { taskId: requestId, activityId, identity, sessionId, originTurnId: association.runId,
        state: 'queued', statusKnowledge: 'unknown', confirmedSeq: 0, name,
        summary: '任务已受理，执行节点尚未确认状态。', resultRef: null };
    }
    const summary = query.reason?.detail
      ?? (query.state === 'succeeded' ? '任务已完成。' : query.state === 'cancelled' ? '任务已确认取消。' : '任务执行中。');
    return { taskId: requestId, activityId, identity, sessionId, originTurnId: association.runId,
      state: query.state, statusKnowledge: query.statusKnowledge, confirmedSeq: query.confirmedSeq, name,
      summary: summary.slice(0, 2000), resultRef: query.output ? `execution:${query.executionRef}` : null };
  }
  return {
    read: taskId => fact(taskId),
    async listByOriginTurn(sessionId, turnId) {
      const { rows } = await storage.read(`SELECT command_id FROM agent_execution_commands
        WHERE kind='submit' AND association->>'runId'=$1 ORDER BY created_at, command_id`, [turnId]);
      const records: WorkspaceTaskRecord[] = [];
      for (const row of rows) {
        const record = await fact(String(row.command_id));
        if (record && record.sessionId === sessionId) records.push(record);
      }
      return records;
    },
    async cancel(taskId) {
      const found = await origin(taskId);
      if (!found) return;
      const { row, association, identity } = found;
      const stopId = operationId('workspace-task-cancel:' + taskId);
      await executions.agent.stop(identity, String(row.activity_id),
        { ...association, assertDispatch: async () => { throw new StorageError('forbidden'); } },
        String(row.request_id), { stopId, reason: '当前 Turn 已停止，取消该 Turn 发起的课程任务。' });
    },
  };
}