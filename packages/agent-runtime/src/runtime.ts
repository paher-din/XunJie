import { randomUUID } from 'node:crypto';
import { StorageError, type OwnedStorage, type HostLock } from '@xunjie/storage';
import { canonicalDigest, operationId } from '@xunjie/storage/identity';
import { agentInputSchema, agentQuestionResponseSchema, agentDispatchPermitSchema, type AgentInput, type AgentInputReceipt, type AgentRuntimeSession,
  type AgentTurn, type AgentQuestionResponse, type AgentQuestionReceipt, type AgentEvent, type AgentDispatchPermit } from '@xunjie/contracts/agent-runtime';
import { createAgentStore, type AgentStore, type AgentSessionSnapshot, type AgentSessionInput } from './store.js';
import { createModelAdapter, type ModelGatewaySource } from './model.js';
import { runTurn, type LoopDependencies } from './loop.js';
import { createCancellationRunner, type TaskCancellationPort } from './interruption.js';
import type { AgentScenario, AgentCancellationTimers, AskInput, AskOutcome, Facts, TaskTerminalFact } from './ports.js';
import type { TaskFactsPort } from './context.js';

export interface AgentRuntimeOptions {
  authorize(identity: AgentRuntimeSession['identity']): Promise<void>;
  scenario: AgentScenario;
  gateway: ModelGatewaySource;
  taskFacts?: TaskFactsPort;
  taskCancellation?: TaskCancellationPort;
  budget?: { maxSteps?: number; maxToolCalls?: number; maxInputTokens?: number; maxOutputTokens?: number; maxCallMs?: number; hardDeadlineMs?: number };
  now?: () => number;
  ownerInstanceId?: string;
  cancellationTimers?: AgentCancellationTimers;
  readOnly?: boolean;
}
const subject = ({ environmentId, spaceId, principalId, kind }: AgentRuntimeSession['identity']) => canonicalDigest({ environmentId, spaceId, principalId, kind });

/** Session owner, merged wakes, host lock and the public entry. The only loop lives in loop.ts. */
export function createAgentRuntime(storage: OwnedStorage, options: AgentRuntimeOptions) {
  const ownerInstanceId = options.ownerInstanceId ?? randomUUID();
  const store = createAgentStore(storage, { budget: options.budget, now: options.now, ownerInstanceId,
    assertOwner: () => lock !== null && !lockLost });
  const model = createModelAdapter(options.gateway, store);
  const now = options.now ?? Date.now;
  const cancellationTimers: AgentCancellationTimers = options.cancellationTimers ?? {
    setTimeout(callback, delayMs) { const timer = setTimeout(callback, delayMs); timer.unref(); return timer; },
    clearTimeout(timer) { clearTimeout(timer as ReturnType<typeof setTimeout>); },
  };
  const cancellations = createCancellationRunner(store, options.taskCancellation, cancellationTimers);
  let closed = false, writesClosed = !!options.readOnly, dispatchClosed = !!options.readOnly;
  let lock: HostLock | null = null;
  let lockLost = false;
  // A participating host dispatches only while it really holds the exclusive host lock (K01/K02).
  const dispatchOpen = () => !closed && !writesClosed && !dispatchClosed && !lockLost && lock !== null;
  const pumps = new Map<string, Promise<void>>();
  const queued = new Set<string>();
  const failures: unknown[] = [];
  const turnControllers = new Map<string, AbortController>();
  const waiters = new Map<string, { resolve: (outcome: AskOutcome) => void; timer?: unknown; onAbort?: () => void }>();
  const turnDeadlines = new Map<string, { timer: unknown; expired: boolean }>();

  async function acquireLock(): Promise<boolean> {
    if (lock) return true;
    lock = await storage.tryHostLock('agent-host:' + storage.owner.environmentId + '/' + storage.owner.serviceId);
    if (!lock) { lockLost = true; return false; }
    lockLost = false;
    void lock.lost.then(() => { lockLost = true; for (const controller of turnControllers.values()) controller.abort(); });
    return true;
  }

  const ready = (async () => {
    // Every host that may execute Agent work must own the store before repairing or accepting Turns.
    // Opening the runtime readOnly only pauses admission until resume(); it never skips the lock.
    if (!await acquireLock()) return;
    await store.recoverInterrupted();
    await cancellations.resumePending();
  })();
  void ready.catch(error => { failures.push(error); });

  function signalFor(turnId: string): AbortSignal {
    let controller = turnControllers.get(turnId);
    if (!controller) { controller = new AbortController(); turnControllers.set(turnId, controller); }
    return controller.signal;
  }
  /** A Turn's frozen deadline aborts the same signal model/tool calls observe. */
  function armTurn(turnId: string, deadline: string | null) {
    disarmTurn(turnId);
    if (!deadline) return;
    const delayMs = Math.max(0, Date.parse(deadline) - now());
    const entry = { timer: undefined as unknown, expired: false };
    entry.timer = cancellationTimers.setTimeout(() => {
      if (turnDeadlines.get(turnId) !== entry) return;
      entry.expired = true;
      turnControllers.get(turnId)?.abort();
    }, delayMs);
    turnDeadlines.set(turnId, entry);
    if (delayMs === 0) { entry.expired = true; turnControllers.get(turnId)?.abort(); }
  }
  function disarmTurn(turnId: string) {
    const entry = turnDeadlines.get(turnId);
    if (entry) cancellationTimers.clearTimeout(entry.timer);
    turnDeadlines.delete(turnId);
  }
  function deadlineReached(turnId: string): boolean { return turnDeadlines.get(turnId)?.expired === true; }
  async function isActive(turnId: string): Promise<boolean> {
    if (!dispatchOpen()) return false;
    const sessionId = await sessionOfTurn(turnId);
    const turn = await store.turn(sessionId, turnId);
    return turn.state === 'active' && turn.ownerInstanceId === ownerInstanceId;
  }
  async function sessionOfTurn(turnId: string): Promise<string> {
    const { rows } = await storage.read('SELECT session_id FROM agent_turns WHERE turn_id=$1', [turnId]);
    if (!rows[0]) throw new StorageError('missing');
    return String(rows[0].session_id);
  }
  const deps: LoopDependencies = {
    store, model, gateway: options.gateway, scenario: options.scenario, taskFacts: options.taskFacts,
    isActive, signalFor, armTurn, disarmTurn, deadlineReached,
    ask: (turnId, stepId, toolCallId, input) => ask(turnId, stepId, toolCallId, input),
    onLateAcceptance: turnId => { void (async () => {
      const sessionId = await sessionOfTurn(turnId);
      await cancellations.deliverTurn(sessionId, turnId);
    })().catch(error => { failures.push(error); }); },
    onProgress: async (sessionId, turnId, stepId, attemptId, progress) => { await store.recordProgress(sessionId, attemptId, progress); },
  };
  function wake(sessionId: string) {
    if (!dispatchOpen()) return;
    if (pumps.has(sessionId)) { queued.add(sessionId); return; }
    const pump = (async () => {
      await ready;
      do {
        queued.delete(sessionId);
        if (!dispatchOpen()) return;
        let active = await store.activeTurnOf(sessionId);
        // An idle Session may still have a legitimately pending completed-origin notification.
        if (!active) {
          await store.openPendingTurn(sessionId).catch(error => { failures.push(error); });
          active = await store.activeTurnOf(sessionId);
        }
        if (active) await runTurn(deps, active.turnId).catch(error => { failures.push(error); });
        turnControllers.delete(active?.turnId ?? '');
      } while (queued.has(sessionId) && dispatchOpen());
    })().finally(() => { pumps.delete(sessionId); });
    pumps.set(sessionId, pump);
  }
  /** Save a real question and await its answer in memory; the answer is persisted before waking. */
  async function ask(turnId: string, stepId: string, toolCallId: string, input: AskInput): Promise<AskOutcome> {
    const sessionId = await sessionOfTurn(turnId);
    const questionId = operationId('agent-question:' + toolCallId);
    await store.saveQuestion({ questionId, sessionId, turnId, stepId, toolCallId, presentation: input.presentation, deadline: input.deadline });
    return new Promise<AskOutcome>(resolve => {
      const finish = (outcome: AskOutcome) => {
        const waiter = waiters.get(questionId);
        if (!waiter) return;
        waiters.delete(questionId);
        if (waiter.timer) cancellationTimers.clearTimeout(waiter.timer);
        if (waiter.onAbort) signalFor(turnId).removeEventListener('abort', waiter.onAbort);
        resolve(outcome);
      };
      const onAbort = () => { void store.closeQuestion(questionId, 'closed').catch(() => {}); finish({ kind: 'closed', questionId }); };
      const waiter: { resolve: (o: AskOutcome) => void; timer?: unknown; onAbort?: () => void } = { resolve: finish, onAbort };
      if (input.deadline) {
        const delayMs = Math.max(0, Date.parse(input.deadline) - now());
        waiter.timer = cancellationTimers.setTimeout(() => { void store.closeQuestion(questionId, 'expired').catch(() => {}); finish({ kind: 'expired', questionId }); }, delayMs);
      }
      signalFor(turnId).addEventListener('abort', onAbort, { once: true });
      waiters.set(questionId, waiter);
      if (signalFor(turnId).aborted) onAbort();
    });
  }
  function resolveWaiter(questionId: string, outcome: AskOutcome) {
    const waiter = waiters.get(questionId);
    if (waiter) waiter.resolve(outcome);
  }
  async function authorized(identity: AgentRuntimeSession['identity'], sessionId: string) {
    await ready;
    if (closed) throw new StorageError('maintenance');
    await options.authorize(identity);
    const session = await store.session(sessionId);
    if (subject(session.identity) !== subject(identity)) throw new StorageError('forbidden');
    return session;
  }
  function writable() { if (closed || writesClosed || lockLost) throw new StorageError('maintenance'); }

  const runtime = {
    async initialize(session: AgentRuntimeSession) {
      await ready; if (closed) throw new StorageError('maintenance');
      await options.authorize(session.identity); writable();
      return store.initialize(session);
    },
    async submit(identity: AgentRuntimeSession['identity'], value: AgentInput): Promise<AgentInputReceipt> {
      const input = agentInputSchema.parse(value);
      await authorized(identity, input.sessionId); writable();
      const receipt = await store.submitInput(input);
      wake(receipt.sessionId);
      return receipt;
    },
    async answerQuestion(identity: AgentRuntimeSession['identity'], sessionId: string, value: AgentQuestionResponse): Promise<AgentQuestionReceipt> {
      const response = agentQuestionResponseSchema.parse(value);
      await authorized(identity, sessionId); writable();
      const receipt = await store.answerQuestion(sessionId, response, options.scenario.validateAnswer?.bind(options.scenario));
      const answer = response.answer as Facts;
      resolveWaiter(response.questionId, (answer as { kind?: string }).kind === 'skip'
        ? { kind: 'skipped', questionId: response.questionId }
        : { kind: 'answered', questionId: response.questionId, version: receipt.questionVersion, answer });
      return receipt;
    },
    async stop(identity: AgentRuntimeSession['identity'], sessionId: string, turnId: string, requestId: string): Promise<AgentTurn> {
      await authorized(identity, sessionId); writable();
      const stopped = await store.stopTurn(sessionId, turnId, requestId);
      turnControllers.get(turnId)?.abort();
      // Only a real durable cancel intent drives delivery; a late Stop on an old completed Turn never widens it.
      if (stopped.stopped) void cancellations.deliverTurn(sessionId, turnId).catch(error => { failures.push(error); });
      if (stopped.stopped) wake(sessionId);
      return stopped.turn;
    },
    async continueSession(identity: AgentRuntimeSession['identity'], sessionId: string, requestId: string): Promise<AgentTurn> {
      await authorized(identity, sessionId); writable();
      const turn = await store.continueSession(sessionId, requestId);
      wake(sessionId);
      return turn;
    },
    async turn(identity: AgentRuntimeSession['identity'], sessionId: string, turnId: string): Promise<AgentTurn> {
      await authorized(identity, sessionId);
      return store.turn(sessionId, turnId);
    },
    async events(identity: AgentRuntimeSession['identity'], sessionId: string, after = 0): Promise<AgentEvent[]> {
      await authorized(identity, sessionId);
      return store.events(sessionId, after);
    },
    async sessionSnapshot(identity: AgentRuntimeSession['identity'], sessionId: string): Promise<AgentSessionSnapshot> {
      await authorized(identity, sessionId);
      return store.sessionSnapshot(sessionId);
    },
    async request(identity: AgentRuntimeSession['identity'], sessionId: string, requestId: string) {
      await authorized(identity, sessionId);
      return store.request(sessionId, requestId);
    },
    async inputControl(identity: AgentRuntimeSession['identity'], sessionId: string, inputId: string, control: { requestId: string; expectedVersion: number; operation: 'edit' | 'remove'; text?: string; context?: Facts }) {
      await authorized(identity, sessionId); writable();
      return store.inputControl(sessionId, inputId, control);
    },
    /** Trusted host bridge: a task terminal fact becomes a notification; idle may open a new Turn. */
    async registerNotification(identity: AgentRuntimeSession['identity'], sessionId: string, originTurnId: string, fact: TaskTerminalFact) {
      await authorized(identity, sessionId); writable();
      const result = await store.registerNotification(sessionId, originTurnId, fact);
      if (result.turnId) wake(sessionId);
      return result;
    },
    async recordProgress(identity: AgentRuntimeSession['identity'], sessionId: string, attemptId: string, progress: { revision: number; text: string; tools?: readonly unknown[] }) {
      await authorized(identity, sessionId);
      if (!dispatchOpen()) return false;
      return store.recordProgress(sessionId, attemptId, progress);
    },
    /** Cross-machine adapters mint a permit from the live call and the owner verifies the Step here. */
    async assertDispatch(identity: AgentRuntimeSession['identity'], permit: AgentDispatchPermit): Promise<null> {
      const input = agentDispatchPermitSchema.parse(permit);
      await authorized(identity, input.sessionId);
      if (!dispatchOpen()) throw new StorageError('stale-generation');
      return store.assertDispatch(input);
    },
    closeWrites() { writesClosed = true; dispatchClosed = true; for (const c of turnControllers.values()) c.abort(); },
    closeDispatch() { dispatchClosed = true; for (const c of turnControllers.values()) c.abort(); },
    async drain() {
      await ready;
      await Promise.allSettled([...pumps.values()]);
      await cancellations.drain();
      const errors = failures.splice(0);
      if (errors.length) throw new AggregateError([...new Set(errors)], 'Agent execution failed');
    },
    async resume() {
      if (closed) throw new StorageError('maintenance');
      await this.drain();
      // Take over (and repair) before opening admission; a host that cannot take the lock stays closed.
      if (!lock && !await acquireLock()) return;
      if (!lockLost) { await store.recoverInterrupted(); await cancellations.resumePending(); }
      writesClosed = false; dispatchClosed = false;
    },
    close(): Promise<void> {
      this.closeWrites();
      for (const turnId of turnDeadlines.keys()) disarmTurn(turnId);
      return (async () => {
        try { await this.drain(); cancellations.close(); await lock?.release(); }
        finally { closed = true; lock = null; }
      })();
    },
  };
  return runtime;
}
export type AgentRuntime = ReturnType<typeof createAgentRuntime>;
export type { AgentSessionSnapshot, AgentSessionInput };
