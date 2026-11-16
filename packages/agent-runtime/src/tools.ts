import { StorageError } from '@xunjie/storage';
import { AgentError } from './errors.js';
import type { AgentToolCall, AgentToolResult, AgentTurnBudget } from '@xunjie/contracts/agent-runtime';
import type { AgentTool, ToolCall, ToolContext, ToolEffectReference } from './ports.js';
import type { AgentStore } from './store.js';

export function createToolRegistry(tools: readonly AgentTool[]): Map<string, AgentTool> {
  const registry = new Map<string, AgentTool>();
  for (const tool of tools) {
    if (registry.has(tool.definition.name)) throw new StorageError('identity-conflict');
    registry.set(tool.definition.name, tool);
  }
  return registry;
}
export function toToolCall(call: AgentToolCall): ToolCall {
  return { toolCallId: call.toolCallId, nativeCallId: call.nativeCallId, callIndex: call.callIndex,
    name: call.name, input: call.input, executionMode: call.executionMode };
}
export interface ExecuteToolsOptions {
  calls: readonly AgentToolCall[]; registry: ReadonlyMap<string, AgentTool>;
  store: AgentStore; signal: AbortSignal; budget: AgentTurnBudget;
  isActive(): Promise<boolean>;
  contextFor(call: AgentToolCall): ToolContext;
  /** A background task accepted after Stop needs the durable cancel intent delivered again. */
  onLateAcceptance?(): void | Promise<void>;
  /** Durably enqueue idempotent cancellation for this exact Session/Turn/ToolCall, not the whole Turn.
   * The host owns delivery/retry, including late references after executeTools has returned.
   * Must resolve after enqueue, without waiting for physical cancellation by the task owner. */
  onCallTimeout?(call: AgentToolCall, reference: ToolEffectReference): Promise<void>;
}
const timeoutToken = Symbol('timeout');
/** Wait for a tool no longer than the call/Turn deadline, even when it ignores its signal. */
async function bounded<T>(run: Promise<T>, signal: AbortSignal): Promise<T | typeof timeoutToken> {
  if (signal.aborted) { void run.catch(() => {}); return timeoutToken; }
  let onAbort: () => void = () => {};
  const expired = new Promise<typeof timeoutToken>(resolve => {
    onAbort = () => resolve(timeoutToken);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([run, expired]); }
  finally { signal.removeEventListener('abort', onAbort); }
}
/** Serial batch: each call starts only after the previous returns. Stop/abort terminates the batch. */
export async function executeTools(options: ExecuteToolsOptions): Promise<'done' | 'stopped'> {
  const { calls, registry, store, signal, budget } = options;
  for (const call of calls) {
    if (signal.aborted || !await options.isActive()) {
      await closeRemaining(options, call, 'turn-stopped');
      return 'stopped';
    }
    const tool = registry.get(call.name);
    if (!tool) {
      await store.startToolCall(call.toolCallId);
      await store.saveToolResult(call.toolCallId, { kind: 'completed', outcome: 'error', summary: '工具不可用：' + call.name }, null);
      continue;
    }
    if (call.executionMode === 'background' && !tool.supportsBackground) {
      await store.startToolCall(call.toolCallId);
      await store.saveToolResult(call.toolCallId, { kind: 'completed', outcome: 'error', summary: '该工具不支持 background 模式' }, null);
      continue;
    }
    const started = await store.startToolCall(call.toolCallId);
    if (!started) { await store.saveToolResult(call.toolCallId, { kind: 'not_started', reason: 'turn-stopped' }, null).catch(() => {}); continue; }
    const deadline = tool.timeoutPolicy === 'business' ? Date.parse(budget.deadline)
      : Math.min(Date.now() + budget.maxCallMs, Date.parse(budget.deadline));
    if (deadline <= Date.now()) {
      await store.saveToolResult(call.toolCallId, { kind: 'not_started', reason: 'deadline-exceeded' }, null);
      continue;
    }
    const base = options.contextFor(call);
    const controller = new AbortController();
    let timedOut = false;
    let dispatched = false;
    let hostInterrupted = false;
    let cancellationRequired = false;
    let effectKnown = false;
    let reference: ToolEffectReference = { requestRef: call.toolCallId };
    const cancelTimedOutCall = () => !hostInterrupted && cancellationRequired && dispatched && (tool.supportsBackground || effectKnown)
      ? options.onCallTimeout?.(call, { ...reference }) : undefined;
    const onStop = () => {
      const code = (signal.reason as { code?: string } | undefined)?.code;
      hostInterrupted = code === 'host-interrupted';
      timedOut ||= code === 'deadline-exceeded' || (!hostInterrupted && code !== 'turn-stopped' && Date.now() >= deadline);
      cancellationRequired ||= timedOut;
      controller.abort(signal.reason);
    };
    signal.addEventListener('abort', onStop, { once: true });
    if (signal.aborted) onStop();
    const timer = setTimeout(() => { timedOut = true; cancellationRequired = true; controller.abort(new AgentError('deadline-exceeded')); }, deadline - Date.now());
    timer.unref?.();
    const context: ToolContext = { ...base, signal: controller.signal, deadline: new Date(deadline).toISOString(),
      async reportEffect(effect) {
        effectKnown ||= !!(effect.taskId || effect.requestRef);
        reference = { ...reference, ...effect };
        await base.reportEffect?.(effect);
        if (cancellationRequired) await cancelTimedOutCall();
      },
      async assertActive() {
        if (controller.signal.aborted) throw new AgentError('cancelled');
        await base.assertActive();
        if (controller.signal.aborted) throw new AgentError('cancelled');
      } };
    const run = (async (): Promise<{ result?: AgentToolResult; error?: unknown }> => {
      try {
        await context.assertActive();
        dispatched = true;
        const result = await tool.execute(toToolCall(call), context);
        if (result.kind === 'accepted' || result.kind === 'outcome_unknown') {
          effectKnown ||= !!(result.taskId || (result.kind === 'outcome_unknown' && result.requestRef));
          reference = { ...reference,
          ...(result.taskId ? { taskId: result.taskId } : {}),
          ...(result.kind === 'outcome_unknown' && result.requestRef ? { requestRef: result.requestRef } : {}) };
        }
        return { result };
      }
      catch (error) { return { error }; }
    })();
    try {
      const settled = await bounded(run, controller.signal);
      async function saveLateAcceptance(result: AgentToolResult) {
        if (result.kind !== 'accepted' || timedOut || hostInterrupted) return;
        // The store alone decides whether this is a stopped Turn of the still-live owner.
        // A lost host is rejected by its lock fence even though its old owner id still matches.
        const reopened = await store.saveToolResult(call.toolCallId, result, result.taskId);
        if (reopened) await options.onLateAcceptance?.();
      }
      if (settled === timeoutToken) {
        // Keep observing the real executor. A timeout closes the ToolCall once; a late receipt
        // is cancellation evidence, never a second successful ToolResult.
        void run.then(async late => {
          const result = late.result;
          if (!result) return;
          if (result.kind === 'accepted') reference = { ...reference, taskId: result.taskId };
          else if (result.kind === 'outcome_unknown') reference = { ...reference,
            ...(result.taskId ? { taskId: result.taskId } : {}), ...(result.requestRef ? { requestRef: result.requestRef } : {}) };
          if (cancellationRequired) await cancelTimedOutCall();
          else await saveLateAcceptance(result);
        }).catch(() => {}); // The durable host cancellation hook owns delivery errors and retries.
      }
      // A lost host or a Stop must not commit final execution facts; the successor repairs the open call.
      const active = await options.isActive();
      if (signal.aborted || !active) {
        if (settled !== timeoutToken && settled.result) await saveLateAcceptance(settled.result).catch(() => {});
        await cancelTimedOutCall();
        return 'stopped';
      }
      if (settled === timeoutToken) {
        try {
          await store.saveToolResult(call.toolCallId, dispatched
            ? { kind: 'outcome_unknown', reason: '工具调用超时，执行效果未知；请按任务或请求引用查询，勿自动重试。', ...reference }
            : { kind: 'not_started', reason: 'deadline-exceeded' }, reference.taskId ?? null);
        } finally { await cancelTimedOutCall(); }
        continue;
      }
      let result: AgentToolResult;
      if (settled.error !== undefined) {
        if (signal.aborted) {
          await store.saveToolResult(call.toolCallId, { kind: 'outcome_unknown', reason: 'turn-stopped' }, null).catch(() => {});
          await closeRemaining(options, calls[calls.indexOf(call) + 1]!, 'turn-stopped');
          return 'stopped';
        }
        // An expected tool failure is a result; the batch continues.
        const error = settled.error;
        result = { kind: 'completed', outcome: 'error', summary: (error instanceof Error ? error.message : '工具执行失败').slice(0, 8192) };
      } else result = settled.result!;
      const taskId = result.kind === 'accepted' || result.kind === 'outcome_unknown' ? result.taskId ?? null : null;
      if (result.kind === 'outcome_unknown') {
        cancellationRequired = true;
        reference = { ...reference, ...(result.taskId ? { taskId: result.taskId } : {}),
          ...(result.requestRef ? { requestRef: result.requestRef } : {}) };
        // Business waits can expire before the kernel timer. They still require durable owner cancellation.
        await cancelTimedOutCall();
      }
      const reopened = await store.saveToolResult(call.toolCallId, result, taskId);
      if (reopened) await options.onLateAcceptance?.();
      // A late acceptance after Stop must still be registered for cancellation by the runtime fence.
    } finally { clearTimeout(timer); signal.removeEventListener('abort', onStop); }
  }
  return 'done';
}
async function closeRemaining(options: ExecuteToolsOptions, from: AgentToolCall | undefined, reason: string) {
  if (!from) return;
  const index = options.calls.indexOf(from);
  for (const call of options.calls.slice(index)) {
    if (call.state === 'closed') continue;
    await options.store.saveToolResult(call.toolCallId, { kind: 'not_started', reason }, null).catch(() => {});
  }
}
