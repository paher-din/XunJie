import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '../app/errors.ts';
import { parseRequest } from '../app/validation.ts';

const visibilitySchema = z.strictObject({ student: z.boolean(), tutor: z.boolean() });
const inputSchema = z.strictObject({
  format: z.enum(['txt', 'markdown', 'paste']), title: z.string().min(1),
  content: z.union([z.string(), z.instanceof(Uint8Array)]),
  kind: z.enum(['learning_material', 'private_answer', 'validation_asset']).optional(),
  visibility: visibilitySchema.optional(),
});
import { materialByteLimit } from '../../contracts/design/results.ts';
export { materialByteLimit } from '../../contracts/design/results.ts';
export const courseByteLimit = 2 * 1024 * 1024;
const contentHash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

export function prepareMaterial(input: unknown, courseBodyBytes: number) {
  const parsed = parseRequest(inputSchema, input);
  if (!Number.isSafeInteger(courseBodyBytes) || courseBodyBytes < 0) throw new ApiError('INVALID_REQUEST');
  const raw = parsed.content;
  if ((typeof raw === 'string' ? Buffer.byteLength(raw, 'utf8') : raw.byteLength) > materialByteLimit) throw new ApiError('CONTENT_LIMIT');
  let text: string;
  try {
    text = typeof raw === 'string' ? raw : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
    if (!text.isWellFormed()) throw new Error('Invalid Unicode.');
  } catch { throw new ApiError('INVALID_REQUEST'); }
  const byteLength = Buffer.byteLength(text, 'utf8');
  if (byteLength + courseBodyBytes > courseByteLimit) throw new ApiError('CONTENT_LIMIT');
  const kind = parsed.kind ?? 'learning_material';
  const visibility = parsed.visibility ?? { student: false, tutor: false };
  if (kind !== 'learning_material' && (visibility.student || visibility.tutor)) throw new ApiError('FORBIDDEN');
  const paragraphs: { ordinal: number; start: number; end: number; text: string; contentHash: string }[] = [];
  const append = (start: number, end: number) => {
    const body = text.slice(start, end);
    if (!body.trim()) return;
    paragraphs.push({ ordinal: paragraphs.length + 1, start, end, text: body, contentHash: contentHash(body) });
  };
  // Blank lines separate references; headings and original text are never interpreted or rewritten.
  const separator = /(?:\r\n|\r(?!\n)|(?<!\r)\n)[\t ]*(?:\r\n|\r(?!\n)|(?<!\r)\n)(?:[\t ]*(?:\r\n|\r(?!\n)|(?<!\r)\n))*/g;
  let start = 0;
  for (const match of text.matchAll(separator)) {
    append(start, match.index);
    start = match.index + match[0].length;
  }
  append(start, text.length);
  return { format: parsed.format, title: parsed.title, text, byteLength, contentHash: contentHash(text), kind, visibility, paragraphs };
}
export type PreparedMaterial = ReturnType<typeof prepareMaterial>;
export interface DesignMaterialVersion {
  courseId: string;
  resourceVersionId: string;
  available: boolean;
  teacherDesignAllowed: boolean;
  material: PreparedMaterial;
}
