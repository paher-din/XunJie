import { z } from 'zod';

export const PDF_LIMITS = { inputBytes: 20 * 1024 * 1024, pages: 200, pagesPerRead: 2,
  imageBytes: 262144, imageDimension: 2048, timeoutMs: 30000 } as const;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
/** Top-left origin on the rotated, visible CropBox, normalized to [0,1]. */
export const pdfRegionSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1),
  width: z.number().positive().max(1), height: z.number().positive().max(1) }).strict()
  .refine(r => r.x + r.width <= 1 && r.y + r.height <= 1);
export type PdfRegion = z.infer<typeof pdfRegionSchema>;
export const pdfUploadSchema = z.object({ requestId: z.uuid(), documentId: z.uuid(),
  name: z.string().min(1).max(240), dataBase64: z.string().min(1).max(Math.ceil(PDF_LIMITS.inputBytes / 3) * 4) }).strict();
export const pdfCourseInputSchema = z.object({ requestId: z.uuid(), documentId: z.uuid(), materialId: z.uuid() }).strict();
export const pdfDocumentSchema = z.object({ documentId: z.uuid(), activityId: z.uuid(), requestId: z.uuid(),
  name: z.string().min(1).max(240), sha256: digest, byteLength: z.number().int().positive(),
  state: z.enum(['received', 'ready', 'damaged', 'encrypted', 'limit', 'timeout', 'failed']),
  pageCount: z.number().int().nonnegative(), pageLabels: z.array(z.string().max(300)).max(PDF_LIMITS.pages),
  courseSource: z.object({ releaseId: z.uuid(), materialId: z.uuid() }).strict().optional(),
  detail: z.string().max(2000).optional() }).strict();
export type PdfDocument = z.infer<typeof pdfDocumentSchema>;
export const pdfReadInputSchema = z.object({ requestId: z.uuid(), documentId: z.uuid(),
  pages: z.array(z.number().int().min(1).max(100000)).min(1).max(PDF_LIMITS.pagesPerRead)
    .refine(pages => new Set(pages).size === pages.length), region: pdfRegionSchema.nullable() }).strict();
export const pdfPageSchema = z.object({ page: z.number().int().positive(), label: z.string(),
  state: z.enum(['ready', 'out-of-range', 'failed', 'limit', 'timeout']), text: z.string().max(1000000),
  textOrigin: z.literal('native'), ocr: z.literal('not-performed'),
  image: z.object({ mediaType: z.literal('image/png'), dataBase64: z.string().max(350000),
    width: z.number().int().positive().max(PDF_LIMITS.imageDimension), height: z.number().int().positive().max(PDF_LIMITS.imageDimension), sha256: digest }).strict().nullable(),
  transform: z.object({ rotation: z.number(), cropBox: z.array(z.number()).refine(box => box.length === 0 || box.length === 4), region: pdfRegionSchema.nullable(),
    scale: z.number().nonnegative(), engine: z.string().min(1) }).strict(), detail: z.string().max(2000).optional() }).strict();
export type PdfPage = z.infer<typeof pdfPageSchema>;
export const pdfReadingSchema = z.object({ readingId: z.uuid(), documentId: z.uuid(), activityId: z.uuid(),
  documentSha256: digest, documentName: z.string(), coordinates: z.literal('rotated-cropbox-top-left-normalized'),
  requestedPages: pdfReadInputSchema.shape.pages, region: pdfRegionSchema.nullable(), pages: z.array(pdfPageSchema).min(1).max(2) }).strict();
export type PdfReading = z.infer<typeof pdfReadingSchema>;
export const pdfFindInputSchema = pdfReadInputSchema.omit({ region: true }).extend({ query: z.string().min(1).max(200) }).strict();
export const pdfSearchResultSchema = z.object({ source: z.object({ kind: z.literal('pdf'), activityId: z.uuid(),
  documentId: z.uuid(), documentSha256: digest, readingId: z.uuid() }).strict(),
  query: z.string(), searchedPages: z.array(z.number().int().positive()),
  matches: z.array(z.object({ page: z.number().int().positive(), start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(), excerpt: z.string() }).strict()).max(100),
  incompletePages: z.array(z.number().int().positive()), noTextPages: z.array(z.number().int().positive()),
  truncated: z.boolean(), textOrigin: z.literal('native'), ocr: z.literal('not-performed'), imagesSent: z.literal(false),
  coordinates: z.literal('utf16-code-units') }).strict();

export const pdfReferenceSourceSchema = z.object({ kind: z.literal('pdf'), activityId: z.uuid(), documentId: z.uuid(),
  documentSha256: digest, readingId: z.uuid() }).strict();
export const pdfReferenceTargetSchema = z.object({ pages: pdfReadInputSchema.shape.pages,
  region: pdfRegionSchema.nullable(), coordinates: z.literal('rotated-cropbox-top-left-normalized') }).strict();
/** The source owner checks this copy against the retained reading, never browser-supplied text. */
export function pdfReferenceCopy(value: unknown): string {
  const reading = pdfReadingSchema.parse(value);
  if (reading.pages.length !== reading.requestedPages.length || reading.pages.some((page, i) =>
    page.page !== reading.requestedPages[i] || page.state !== 'ready' || !page.image)) throw new Error('PDF pages unavailable');
  return reading.pages.map(page => `${reading.documentName} · PDF 第 ${page.page} 页（标签 ${page.label}）\n`
    + (page.text || '无原生文字层；未执行 OCR，请读取页图。')
    + (reading.region ? '\n页图为所选区域；文字来自整页原生文字层。' : '')).join('\n\n');
}
