import { canonicalDigest } from '@xunjie/storage/identity';
import type { Facts } from '@xunjie/agent-runtime';
import type { ModelImageRef } from '@xunjie/contracts/model-connections';

export interface ConversationHistoryEntry { id: string; version: number; role: 'user' | 'assistant'; text: string; resultRef?: string; images?: ModelImageRef[]; }
export const conversationHistory = (state: Facts): ConversationHistoryEntry[] => (state.history ?? []) as unknown as ConversationHistoryEntry[];
export function appendHistory(history: ConversationHistoryEntry[], entries: ConversationHistoryEntry[]) {
  const result = [...history], known = new Set(history.map(item => item.id + ':' + item.version));
  for (const entry of entries) if (!known.has(entry.id + ':' + entry.version)) { result.push(entry); known.add(entry.id + ':' + entry.version); }
  return result;
}
/** Only visible authorized text crosses a route. Provider-native IDs/signatures never enter this shape. */
export function portableHistory(history: ConversationHistoryEntry[]) {
  return history.flatMap(entry => {
    const parts: { role: 'user' | 'assistant'; text: string }[] = [];
    for (let start = 0; start < entry.text.length;) {
      let end = Math.min(start + 400_000, entry.text.length);
      if (end < entry.text.length && /[\uD800-\uDBFF]/.test(entry.text[end - 1]!)) end--;
      parts.push({ role: entry.role, text: entry.text.slice(start, end) }); start = end;
    }
    return parts.length ? parts : [{ role: entry.role, text: '' }];
  });
}
export const historyDigest = (history: ConversationHistoryEntry[]) => canonicalDigest(history.map(({ id, version, text, role, images }) => ({ id, version, role, text, ...(images?.length ? { images } : {}) })));
