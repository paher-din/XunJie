import { z } from 'zod';
import { StorageError } from '@xunjie/storage';
import { modelToolResultSchema } from '@xunjie/contracts/model-connections';
import type { PdfReading, pdfSearchResultSchema } from '@xunjie/contracts/pdf-materials';
import type { QuestionReferenceInput } from '@xunjie/contracts/question-drafts';
import type { TeachingToolOutcome, TeachingToolScope, TeachingPreparedTool } from './tool-types.js';
import { retainPdfImages, type TeachingImageModels } from './tools-images.js';
import { toolFeedbackBytes } from './tool-results.js';

const encodedFeedback = (value: unknown) => {
  const text = JSON.stringify(value);
  // Reserve the common Command/SHA locator envelope without losing PDF-specific
  // continuation metadata. The UTF-8 budget also covers non-ASCII page text.
  return Buffer.byteLength(text, 'utf8') <= toolFeedbackBytes - 1024
    ? modelToolResultSchema.shape.text.safeParse(text) : { success: false as const };
};
const sourceOf = (reading: PdfReading) => ({ kind: 'pdf' as const, activityId: reading.activityId,
  documentId: reading.documentId, documentSha256: reading.documentSha256, readingId: reading.readingId });
const continueText = (referenceId: string, readingId: string) => ({ tool: 'read_pdf_text', referenceId, readingId,
  coordinates: 'utf16-code-units', detail: 'Choose a retained actual page and start/length; nextStart continues the same native text. No OCR.' });

export const pdfTextInputSchema = z.object({ referenceId: z.uuid(), readingId: z.uuid(),
  page: z.number().int().min(1).max(100000), start: z.number().int().min(0).max(1000000),
  length: z.number().int().min(1).max(2400) }).strict();

/** A pure range read of the existing rendition; no new parser or page image is invoked. */
export function pdfTextOutcome(reading: PdfReading, input: z.infer<typeof pdfTextInputSchema>): TeachingToolOutcome {
  const page = reading.pages.find(page => page.page === input.page);
  if (!page || page.state !== 'ready' || input.start > page.text.length) throw new StorageError('invalid');
  let length = Math.min(input.length, page.text.length - input.start);
  for (;;) {
    const end = input.start + length;
    const result = { source: sourceOf(reading), page: page.page, text: page.text.slice(input.start, end),
      start: input.start, end, total: page.text.length, nextStart: end < page.text.length ? end : null,
      coordinates: 'utf16-code-units', textOrigin: 'native', ocr: 'not-performed', imagesSent: false,
      readMore: continueText(input.referenceId, reading.readingId) };
    const encoded = encodedFeedback(result);
    if (encoded.success) return { state: 'completed', feedback: { outcome: 'success', text: encoded.data, images: [] }, result,
      source: { label: reading.documentName + ' · PDF 第 ' + page.page + ' 页原生文字' } };
    if (!length) throw new StorageError('invalid');
    length = Math.floor(length / 2);
  }
}

export function pdfSearchOutcome(result: ReturnType<typeof pdfSearchResultSchema.parse>, referenceId: string): TeachingToolOutcome {
  let count = Math.min(result.matches.length, 12);
  for (;;) {
    const projection = { ...result, matches: result.matches.slice(0, count), retainedMatchCount: result.matches.length,
      feedbackMatchesTruncated: count < result.matches.length, readMore: continueText(referenceId, result.source.readingId) };
    const encoded = encodedFeedback(projection);
    if (encoded.success) return { state: 'completed', feedback: { outcome: 'success', text: encoded.data, images: [] }, result,
      source: { label: 'PDF 原生文字查找' } };
    if (!count) throw new StorageError('invalid');
    count--;
  }
}

/** The full original stays at the material owner. Protocol feedback contains bounded text and image references. */
export async function pdfReadingOutcome(scope: TeachingToolScope, models: TeachingImageModels | undefined,
  command: TeachingPreparedTool, reading: PdfReading, reference?: QuestionReferenceInput): Promise<TeachingToolOutcome> {
  const canSee = !!models && (command.basis.imageRoute as { available?: boolean } | undefined)?.available === true;
  const images = canSee ? await retainPdfImages(scope, models!, command.commandId, reading) : [];
  const pages = reading.pages.map(page => ({ ...page, image: page.image ? {
    mediaType: page.image.mediaType, width: page.image.width, height: page.image.height, sha256: page.image.sha256 } : null }));
  const source = sourceOf(reading);
  const result = { source, ...(reference ? { reference } : {}), reading: { ...reading, pages }, images,
    visualPages: images.map(image => image.page), textPages: pages.filter(page => page.state === 'ready').map(page => page.page),
    sourceState: 'fixed-version', ...(canSee ? {} : { limitation: 'image-capability-unverified',
      detail: '当前固定模型路线未核验图像能力；仅提供原生文字层，未查看页图。可由学生在原模型入口选择已配置的图像路线。' }) };
  const state = pages.some(page => page.state === 'ready') ? 'completed' : 'failed';
  let limit = 2400, text: string;
  for (;;) {
    const projection = { source, visualPages: result.visualPages, textPages: result.textPages,
      sourceState: result.sourceState, ...(result.limitation ? { limitation: result.limitation, detail: result.detail } : {}),
      readMore: continueText(String(command.arguments.referenceId), reading.readingId),
      reading: { coordinates: reading.coordinates, requestedPages: reading.requestedPages, region: reading.region,
        pages: pages.map(({ detail: _detail, ...page }) => ({ ...page, text: page.text.slice(0, limit),
          textRange: { start: 0, end: Math.min(page.text.length, limit), total: page.text.length },
          textTruncated: page.text.length > limit })) } };
    const encoded = encodedFeedback(projection);
    if (encoded.success) { text = encoded.data; break; }
    if (!limit) throw new StorageError('invalid');
    limit = Math.floor(limit / 2);
  }
  return { state, feedback: { outcome: state === 'failed' ? 'error' : 'success',
    text, images: images.map(image => image.reference) }, result,
    source: { label: reading.documentName + ' · PDF 第 ' + reading.requestedPages.join('、') + ' 页' } };
}
