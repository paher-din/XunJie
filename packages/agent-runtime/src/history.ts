import { canonicalDigest } from '@xunjie/storage/identity';
import type { Facts, HistoryEntry } from './ports.js';

export const conversationHistory = (state: Facts): HistoryEntry[] => (state.history ?? []) as unknown as HistoryEntry[];
export function appendHistory(history: HistoryEntry[], entries: HistoryEntry[]) {
  const result = [...history], known = new Set(history.map(item => item.id + ':' + item.version));
  for (const entry of entries) if (!known.has(entry.id + ':' + entry.version)) { result.push(entry); known.add(entry.id + ':' + entry.version); }
  return result;
}
/** Only visible authorized text crosses a route. Provider-native IDs/signatures never enter this shape. */
export function portableHistory(history: readonly HistoryEntry[]) {
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
export const historyDigest = (history: HistoryEntry[]) => canonicalDigest(history.map(({ id, version, text, role, images }) => ({ id, version, role, text, ...(images?.length ? { images } : {}) })));
