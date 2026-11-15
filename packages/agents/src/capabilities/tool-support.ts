import { createHash } from 'node:crypto';
import { z } from 'zod';
import { StorageError } from '@xunjie/storage';
import { canonical } from '@xunjie/storage/identity';
import type { AgentToolResult } from '@xunjie/contracts/agent-runtime';
import type { Facts } from '@xunjie/agent-runtime';

export const toolFeedbackBytes = 8192;
export const json = (value: unknown): Facts => z.record(z.string(), z.json()).parse(JSON.parse(JSON.stringify(value)));
export const fits = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= toolFeedbackBytes;

/** Bounded model feedback; the complete result is retained as data/resultRef for later reading. */
type CompletedResult = Extract<AgentToolResult, { kind: 'completed' }>;
export function completed(summary: string, data?: Facts, resultRef?: string): CompletedResult {
  return { kind: 'completed', outcome: 'success', summary: summary.slice(0, toolFeedbackBytes),
    ...(data === undefined ? {} : { data }), ...(resultRef === undefined ? {} : { resultRef }) };
}
export function errored(summary: string, data?: Facts): CompletedResult {
  return { kind: 'completed', outcome: 'error', summary: summary.slice(0, toolFeedbackBytes), ...(data === undefined ? {} : { data }) };
}

const resultBytes = (result: Facts) => Buffer.from(canonical(result), 'utf8');
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** An excerpt never claims an arbitrary byte boundary is a UTF-8 character. */
function preview(bytes: Buffer, maximum: number) {
  let start = 0, end = Math.min(bytes.length, maximum);
  while (start < end && (bytes[start]! & 0xc0) === 0x80) start++;
  if (end < bytes.length) while (end > start && (bytes[end]! & 0xc0) === 0x80) end--;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let removed = 0; removed < 4 && end >= start; removed++, end--) {
    try { return { text: decoder.decode(bytes.subarray(start, end)), start, end }; }
    catch { /* Only discard an incomplete trailing codepoint, never the original bytes. */ }
  }
  throw new StorageError('corrupt');
}

/** Preserve the complete committed result; only the model-facing summary is bounded. */
export function projectResult(result: Facts, summary: string, outcome: 'success' | 'error' = 'success'): AgentToolResult {
  const bytes = resultBytes(result);
  if (bytes.length <= toolFeedbackBytes && Buffer.byteLength(summary) <= toolFeedbackBytes)
    return { kind: 'completed', outcome, summary, data: result };
  const original = { sha256: sha256(bytes), byteLength: bytes.length, encoding: 'utf8' };
  let text = summary;
  if (Buffer.byteLength(text) > toolFeedbackBytes) {
    const excerpt = preview(bytes, 2048);
    text = JSON.stringify({ preview: excerpt.text, original, byteRange: { offset: excerpt.start, end: excerpt.end }, truncated: true });
  }
  return { kind: 'completed', outcome, summary: text.slice(0, toolFeedbackBytes), data: result,
    resultRef: `result:${original.sha256}` };
}