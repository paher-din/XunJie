import { StorageError } from '@xunjie/storage';
import type { AgentToolCall, AgentToolResult } from '@xunjie/contracts/agent-runtime';
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
  store: AgentStore; signal: AbortSignal;
  isActive(): Promise<boolean>;
  contextFor(call: AgentToolCall): ToolContext;
}
/** Serial batch: each call starts only after the previous returns. Stop/abort terminates the batch. */
export async function executeTools(options: ExecuteToolsOptions): Promise<void> {
  const { calls, registry, store, signal } = options;
  for (const call of calls) {
    if (signal.aborted || !await options.isActive()) {
      await closeRemaining(options, call, 'turn-stopped');
      return;
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
    if (!started) { await store.saveToolResult(call.toolCallId, { kind: 'not_started', reason: 'turn-stopped' }, null); continue; }
    let result: AgentToolResult;
    try {
      result = await tool.execute(toToolCall(call), options.contextFor(call));
    } catch (error) {
      if (signal.aborted) {
        await store.saveToolResult(call.toolCallId, { kind: 'outcome_unknown', reason: 'turn-stopped' }, null);
        await closeRemaining(options, calls[calls.indexOf(call) + 1]!, 'turn-stopped');
        return;
      }
      // An expected tool failure is a result; the batch continues.
      result = { kind: 'completed', outcome: 'error', summary: (error instanceof Error ? error.message : '工具执行失败').slice(0, 8192) };
    }
    const taskId = result.kind === 'accepted' ? result.taskId : null;
    await store.saveToolResult(call.toolCallId, result, taskId);
    // A late acceptance after Stop must still be registered for cancellation by the runtime fence.
  }
}
async function closeRemaining(options: ExecuteToolsOptions, from: AgentToolCall | undefined, reason: string) {
  if (!from) return;
  const index = options.calls.indexOf(from);
  for (const call of options.calls.slice(index)) {
    if (call.state === 'closed') continue;
    await options.store.saveToolResult(call.toolCallId, { kind: 'not_started', reason }, null).catch(() => {});
  }
}
