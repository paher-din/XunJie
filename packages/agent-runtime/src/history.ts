import { canonicalDigest } from '@xunjie/storage/identity';
import type { AgentToolResult } from '@xunjie/contracts/agent-runtime';
import type { ModelImageRef } from '@xunjie/contracts/model-connections';
import type { Facts, HistoryEntry } from './ports.js';

export const conversationHistory = (state: Facts): HistoryEntry[] => (state.history ?? []) as unknown as HistoryEntry[];
export function appendHistory(history: HistoryEntry[], entries: HistoryEntry[]) {
  const result = [...history], known = new Set(history.map(item => item.id + ':' + item.version));
  for (const entry of entries) if (!known.has(entry.id + ':' + entry.version)) { result.push(entry); known.add(entry.id + ':' + entry.version); }
  return result;
}

type ToolFeedback = { outcome: 'success' | 'error' | 'not-executed'; text: string; images: ModelImageRef[] };
const toolFeedbackBytes = 8192;

function safeUtf16Prefix(text: string, length: number) {
  let end = Math.min(text.length, Math.max(0, length));
  if (end < text.length && end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
  return text.slice(0, end);
}

function structuredFeedback(value: Record<string, unknown>) {
  let summary = typeof value.summary === 'string' ? value.summary : '';
  for (;;) {
    const text = JSON.stringify({ ...value, summary });
    if (Buffer.byteLength(text, 'utf8') <= toolFeedbackBytes) return text;
    if (!summary.length) return text;
    const next = safeUtf16Prefix(summary, Math.max(0, Math.floor(summary.length * 0.75)));
    if (next.length === summary.length) return JSON.stringify({ ...value, summary: '' });
    summary = next;
  }
}

/** One model-visible projection is shared by Gateway settlement, history and recovery. */
export function toolFeedback(result: AgentToolResult | null, toolName?: string): ToolFeedback {
  if (!result) return { outcome: 'not-executed', text: '工具未执行', images: [] };
  const prefix = toolName ? { tool: toolName } : {};
  switch (result.kind) {
    case 'completed':
      return { outcome: result.outcome === 'success' ? 'success' : 'error', text: result.summary, images: result.images ?? [] };
    case 'accepted':
      return { outcome: 'success', text: structuredFeedback({ ...prefix, kind: result.kind, state: 'accepted', summary: result.summary, taskId: result.taskId }), images: [] };
    case 'not_started':
      return { outcome: 'not-executed', text: structuredFeedback({ ...prefix, kind: result.kind, state: 'not-started', summary: result.reason, reason: result.reason }), images: [] };
    case 'interrupted':
      return { outcome: 'not-executed', text: structuredFeedback({ ...prefix, kind: result.kind, state: 'interrupted', summary: result.reason, reason: result.reason }), images: [] };
    case 'outcome_unknown':
      return { outcome: 'error', text: structuredFeedback({ ...prefix, kind: result.kind, state: 'outcome-unknown', summary: result.reason, reason: result.reason,
        ...(result.taskId ? { taskId: result.taskId } : {}), ...(result.requestRef ? { requestRef: result.requestRef } : {}) }), images: [] };
  }
}

/** Only visible authorized text crosses a route. Provider-native IDs/signatures never enter this shape. */
export function portableHistory(history: readonly HistoryEntry[]) {
  return history.flatMap(entry => {
    const parts: { role: 'user' | 'assistant'; text: string; entryId: string }[] = [];
    for (let start = 0; start < entry.text.length;) {
      let end = Math.min(start + 400_000, entry.text.length);
      if (end < entry.text.length && /[\uD800-\uDBFF]/.test(entry.text[end - 1]!)) end--;
      parts.push({ role: entry.role, text: entry.text.slice(start, end), entryId: entry.id }); start = end;
    }
    return parts.length ? parts : [{ role: entry.role, text: '', entryId: entry.id }];
  });
}
export const historyDigest = (history: HistoryEntry[]) => canonicalDigest(history.map(({ id, version, text, role, turnId, stepId,
  kind, attemptId, nativeCallId, toolName, toolOutcome, readback, feedbackCompressed, images, sources }) =>
  ({ id, version, role, text, ...(turnId ? { turnId } : {}), ...(stepId ? { stepId } : {}), ...(kind ? { kind } : {}),
    ...(attemptId ? { attemptId } : {}), ...(nativeCallId ? { nativeCallId } : {}), ...(toolName ? { toolName } : {}),
    ...(toolOutcome ? { toolOutcome } : {}), ...(readback ? { readback } : {}),
    ...(feedbackCompressed ? { feedbackCompressed } : {}),
    ...(images?.length ? { images } : {}), ...(sources?.length ? { sources } : {}) })));
