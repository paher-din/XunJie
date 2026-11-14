import { randomUUID } from 'node:crypto';
import { StorageError, type OwnedStorage, type HostLock } from '@xunjie/storage';
import { canonicalDigest, operationId } from '@xunjie/storage/identity';
import { agentInputSchema, agentQuestionResponseSchema, type AgentInput, type AgentInputReceipt, type AgentRuntimeSession,
  type AgentTurn, type AgentQuestionResponse, type AgentQuestionReceipt, type AgentEvent } from '@xunjie/contracts/agent-runtime';
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
  const store = createAgentStore(storage, { budget: options.budget, now: options.now, ownerInstanceId });
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
  const dispatchOpen = () => !closed && !writesClosed && !dispatchClosed && !lockLost;
  const pumps = new Map<string, Promise<void>>();
  const queued = new Set<string>();
  const failures: unknown[] = [];
  const turnControllers = new Map<string, AbortController>();
  const waiters = new Map<string, { resolve: (outcome: AskOutcome) => void; timer?: unknown; onAbort?: () => void }>();

  const ready = (async () => {
    if (options.readOnly) return;
    lock = await storage.tryHostLock('agent-host:' + storage.owner.environmentId + '/' + storage.owner.serviceId);
    if (!lock) { lockLost = true; return; } // another host owns this store; do not run or repair
    void lock.lost.then(() => { lockLost = true; for (const controller of turnControllers.values()) controller.abort(); });
    await store.recoverInterrupted();
    await cancellations.resumePending();
  })();
  void ready.catch(error => { failures.push(error); });

  function signalFor(turnId: string): AbortSignal {
    let controller = turnControllers.get(turnId);
    if (!controller) { controller = new AbortController(); turnControllers.set(turnId, controller); }
    return controller.signal;
  }
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
    isActive, signalFor,
    ask: (turnId, stepId, toolCallId, input) => ask(turnId, stepId, toolCallId, input),
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
        const active = await store.activeTurnOf(sessionId);
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
      const turn = await store.stopTurn(sessionId, turnId, requestId);
      turnControllers.get(turnId)?.abort();
      // Deliver cancellation outside the stop transaction; the durable intent survives restart.
      void cancellations.deliverTurn(sessionId, turnId).catch(error => { failures.push(error); });
      wake(sessionId);
      return turn;
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
      writesClosed = false; dispatchClosed = false;
      if (!lock && !options.readOnly) {
        lock = await storage.tryHostLock('agent-host:' + storage.owner.environmentId + '/' + storage.owner.serviceId);
        if (lock) { lockLost = false; void lock.lost.then(() => { lockLost = true; for (const c of turnControllers.values()) c.abort(); }); await store.recoverInterrupted(); await cancellations.resumePending(); }
      }
    },
    close(): Promise<void> {
      this.closeWrites();
      return (async () => {
        try { await this.drain(); cancellations.close(); await lock?.release(); }
        finally { closed = true; }
      })();
    },
  };
  return runtime;
}
export type AgentRuntime = ReturnType<typeof createAgentRuntime>;
export type { AgentSessionSnapshot, AgentSessionInput };
