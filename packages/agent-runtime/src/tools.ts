import { StorageError } from '@xunjie/storage';
import type { AgentToolCall, AgentToolResult, AgentTurnBudget } from '@xunjie/contracts/agent-runtime';
import type { AgentTool, ToolCall, ToolContext } from './ports.js';
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
}
const timeoutToken = Symbol('timeout');
/** Wait for a tool no longer than the call/Turn deadline, even when it ignores its signal. */
async function bounded<T>(run: Promise<T>, deadline: number): Promise<T | typeof timeoutToken> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) { void run.catch(() => {}); return timeoutToken; }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<typeof timeoutToken>(resolve => { timer = setTimeout(() => resolve(timeoutToken), remaining); timer.unref?.(); });
  run.catch(() => {});
  try { return await Promise.race([run, expired]); } finally { if (timer) clearTimeout(timer); }
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
    const deadline = Math.min(Date.now() + budget.maxCallMs, Date.parse(budget.deadline));
    const settled = await bounded((async (): Promise<{ result?: AgentToolResult; error?: unknown }> => {
      try { return { result: await tool.execute(toToolCall(call), options.contextFor(call)) }; }
      catch (error) { return { error }; }
    })(), deadline);
    // A lost host or a Stop must not commit final execution facts; the successor repairs the open call.
    if (!await options.isActive()) return 'stopped';
    if (settled === timeoutToken) {
      if (signal.aborted) { await store.saveToolResult(call.toolCallId, { kind: 'outcome_unknown', reason: 'turn-stopped' }, null).catch(() => {}); return 'stopped'; }
      await store.saveToolResult(call.toolCallId, { kind: 'completed', outcome: 'error', summary: '工具调用超时（结果未返回）' }, null);
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
    const taskId = result.kind === 'accepted' ? result.taskId : null;
    const reopened = await store.saveToolResult(call.toolCallId, result, taskId);
    if (reopened) await options.onLateAcceptance?.();
    // A late acceptance after Stop must still be registered for cancellation by the runtime fence.
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
