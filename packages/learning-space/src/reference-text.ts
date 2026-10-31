import { createHash } from 'node:crypto';
import { StorageError } from '@xunjie/storage';

function splitsPair(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset - 1), after = text.charCodeAt(offset);
  return (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) || (before === 13 && after === 10);
}

export function referenceTextSelection(text: string, range: { start: number; end: number }): string {
  const { start, end } = range;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start
    || end > text.length || splitsPair(text, start) || splitsPair(text, end)) throw new StorageError('invalid');
  const selection = text.slice(start, end);
  if (!selection.trim()) throw new StorageError('invalid');
  return selection;
}

// Match the UTF-16 offsets, preserving lone surrogates rather than UTF-8 replacement.
export const referenceSelectionDigest = (text: string) => createHash('sha256').update(text, 'utf16le').digest('hex');
