import { createHash } from 'node:crypto';
import { z } from 'zod';
import { StorageError, type Migration, type OwnedStorage } from '@xunjie/storage';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import type { LearningActivity } from '@xunjie/contracts/learning-data';
import type { CourseBindingAuthority } from '@xunjie/contracts/courses';
import { PDF_LIMITS, pdfDocumentSchema, pdfReadingSchema, pdfReadInputSchema, pdfUploadSchema,
  pdfReferenceCopy, pdfReferenceTargetSchema, pdfCourseInputSchema, pdfFindInputSchema, pdfSearchResultSchema, type PdfDocument, type PdfReading } from '@xunjie/contracts/pdf-materials';
import type { QuestionReferenceInput } from '@xunjie/contracts/question-drafts';
import { inspectPdf, renderPdf } from '../pdf-engine/index.js';

export const pdfMaterialMigration: Migration = { version: 23, name: 'fixed-pdf-materials', sql: `
  CREATE TABLE pdf_documents(document_id uuid PRIMARY KEY,activity_id uuid NOT NULL REFERENCES activities(id),
    request_id uuid NOT NULL UNIQUE,input_digest text NOT NULL,body jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp());
  CREATE TABLE pdf_readings(reading_id uuid PRIMARY KEY,activity_id uuid NOT NULL REFERENCES activities(id),
    document_id uuid NOT NULL REFERENCES pdf_documents(document_id),input_digest text NOT NULL,input jsonb NOT NULL,
    body jsonb,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
` };
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const digest = (value: unknown) => hash(JSON.stringify(value));

/** Fixed originals and derived pages belong to the same learning-data owner as the activity. */
export function createPdfMaterials(storage: OwnedStorage, open: (identity: SpaceIdentity, activityId: string) => Promise<LearningActivity>,
  courses?: CourseBindingAuthority) {
  async function document(identity: SpaceIdentity, activityId: string, documentId: string): Promise<PdfDocument> {
    await open(identity, activityId); z.uuid().parse(documentId);
    const { rows: [row] } = await storage.read('SELECT body FROM pdf_documents WHERE document_id=$1 AND activity_id=$2', [documentId, activityId]);
    if (!row) throw new StorageError('missing');
    return pdfDocumentSchema.parse(row.body);
  }
  async function original(identity: SpaceIdentity, activityId: string, documentId: string) {
    const doc = await document(identity, activityId, documentId);
    const bytes = await storage.readResource(documentId);
    if (hash(bytes) !== doc.sha256 || bytes.length !== doc.byteLength) throw new StorageError('corrupt');
    return { document: doc, bytes };
  }
  async function list(identity: SpaceIdentity, activityId: string) {
    await open(identity, activityId);
    const { rows } = await storage.read('SELECT body FROM pdf_documents WHERE activity_id=$1 ORDER BY created_at,document_id', [activityId]);
    return rows.map(row => pdfDocumentSchema.parse(row.body));
  }
  async function receive(identity: SpaceIdentity, activityId: string, input: z.infer<typeof pdfUploadSchema>, courseSource?: PdfDocument['courseSource']) {
    await open(identity, activityId);
    const bytes = Buffer.from(input.dataBase64, 'base64');
    if (!bytes.length || bytes.length > PDF_LIMITS.inputBytes || bytes.toString('base64') !== input.dataBase64) throw new StorageError('invalid');
    const sha256 = hash(bytes), fingerprint = digest({ activityId, ...input, dataBase64: sha256, ...(courseSource ? { courseSource } : {}) });
    const prior = await storage.receipt('pdf-upload:' + input.requestId, fingerprint);
    if (!prior) {
      const resource = await storage.stageResource({ uploadId: input.documentId, scope: 'pdf-document:' + activityId,
        bytes, mediaType: 'application/pdf', contentVersion: 1 });
      const body: PdfDocument = { documentId: input.documentId, requestId: input.requestId, activityId, name: input.name,
        sha256, byteLength: bytes.length, state: 'received', pageCount: 0, pageLabels: [], ...(courseSource ? { courseSource } : {}) };
      await storage.request({ requestId: 'pdf-upload:' + input.requestId, fingerprint }, async tx => {
        await tx.query('INSERT INTO pdf_documents(document_id,activity_id,request_id,input_digest,body) VALUES($1,$2,$3,$4,$5)',
          [input.documentId, activityId, input.requestId, fingerprint, body]);
        await tx.reference('pdf-document:' + input.documentId, resource.resourceId);
        return body;
      });
    }
    const current = await document(identity, activityId, input.documentId);
    if (current.state !== 'received') return current;
    // The original is already durable. Interrupted inspection can be resumed under the same identity.
    const metadata = await inspectPdf(bytes);
    const result = pdfDocumentSchema.parse({ ...current, ...metadata });
    await open(identity, activityId);
    await storage.request({ requestId: 'pdf-inspect:' + input.requestId, fingerprint }, async tx => {
      await tx.query('UPDATE pdf_documents SET body=$2 WHERE document_id=$1', [input.documentId, result]); return result;
    });
    return document(identity, activityId, input.documentId);
  }
  async function importCourse(identity: SpaceIdentity, activityId: string, value: unknown) {
    const input = pdfCourseInputSchema.parse(value), activity = await open(identity, activityId);
    const material = activity.course?.materials.find(item => item.materialId === input.materialId);
    if (!material || material.mediaType.toLowerCase().split(';')[0]!.trim() !== 'application/pdf'
      || !activity.course || !courses?.readMaterial) throw new StorageError('forbidden');
    const fixed = await courses.readMaterial(identity, activity.course.releaseId, input.materialId);
    if (fixed.materialId !== material.materialId || fixed.sha256 !== material.sha256 || fixed.byteLength !== material.byteLength
      || fixed.mediaType !== material.mediaType || hash(Buffer.from(fixed.contentBase64, 'base64')) !== material.sha256) throw new StorageError('corrupt');
    return receive(identity, activityId, pdfUploadSchema.parse({ requestId: input.requestId, documentId: input.documentId,
      name: material.title.slice(0, 240), dataBase64: fixed.contentBase64 }), { releaseId: activity.course.releaseId, materialId: input.materialId });
  }
  async function reading(identity: SpaceIdentity, activityId: string, readingId: string): Promise<PdfReading | null> {
    await open(identity, activityId); z.uuid().parse(readingId);
    const { rows: [row] } = await storage.read('SELECT body FROM pdf_readings WHERE reading_id=$1 AND activity_id=$2', [readingId, activityId]);
    if (!row?.body) return null;
    const body = pdfReadingSchema.parse(row.body), bytes = await storage.readResource(readingId);
    if (Buffer.from(bytes).toString('utf8') !== JSON.stringify(body)) {
      // jsonb key order is not byte order; compare parsed fixed content, never rerender it.
      const retained = pdfReadingSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')));
      if (JSON.stringify(retained) !== JSON.stringify(body)) throw new StorageError('corrupt');
    }
    const doc = await document(identity, activityId, body.documentId);
    if (doc.sha256 !== body.documentSha256) throw new StorageError('corrupt');
    return body;
  }
  async function read(identity: SpaceIdentity, activityId: string, value: unknown): Promise<PdfReading> {
    await open(identity, activityId);
    const input = pdfReadInputSchema.parse(value), fingerprint = digest({ activityId, input });
    const prior = await storage.receipt('pdf-read:' + input.requestId, fingerprint);
    if (prior) {
      const saved = await reading(identity, activityId, input.requestId);
      if (saved) return saved;
    }
    const source = await original(identity, activityId, input.documentId);
    if (source.document.state !== 'ready') throw new StorageError('invalid');
    await storage.request({ requestId: 'pdf-read:' + input.requestId, fingerprint }, async tx => {
      await tx.query('INSERT INTO pdf_readings(reading_id,activity_id,document_id,input_digest,input) VALUES($1,$2,$3,$4,$5)',
        [input.requestId, activityId, input.documentId, fingerprint, input]);
      await tx.reference('pdf-reading-original:' + input.requestId, input.documentId); return input;
    });
    // If conversion finished but its receipt was lost, adopt the already staged exact bytes.
    let retained: Uint8Array | null = null;
    try { retained = await storage.readResource(input.requestId); }
    catch (error) { if (!(error instanceof StorageError) || !['missing', 'resource-gone'].includes(error.code)) throw error; }
    const body = retained ? pdfReadingSchema.parse(JSON.parse(Buffer.from(retained).toString('utf8')))
      : pdfReadingSchema.parse({ readingId: input.requestId, activityId, documentId: input.documentId,
        documentSha256: source.document.sha256, documentName: source.document.name,
        coordinates: 'rotated-cropbox-top-left-normalized', requestedPages: input.pages, region: input.region,
        pages: await renderPdf(source.bytes, input.pages, input.region) });
    if (body.readingId !== input.requestId || body.activityId !== activityId || body.documentId !== input.documentId
      || digest(body.requestedPages) !== digest(input.pages) || digest(body.region) !== digest(input.region)
      || body.documentSha256 !== source.document.sha256) throw new StorageError('corrupt');
    const resource = await storage.stageResource({ uploadId: input.requestId, scope: 'pdf-reading:' + activityId,
      bytes: Buffer.from(JSON.stringify(body)), mediaType: 'application/json', contentVersion: 1 });
    await open(identity, activityId);
    await storage.request({ requestId: 'pdf-read-complete:' + input.requestId, fingerprint }, async tx => {
      await tx.query('UPDATE pdf_readings SET body=$2 WHERE reading_id=$1', [input.requestId, body]);
      await tx.reference('pdf-reading:' + input.requestId, resource.resourceId); return body;
    });
    return (await reading(identity, activityId, input.requestId))!;
  }
  async function find(identity: SpaceIdentity, activityId: string, value: unknown) {
    await open(identity, activityId);
    const input = pdfFindInputSchema.parse(value);
    await storage.request({ requestId: 'pdf-find:' + input.requestId, fingerprint: digest({ activityId, input }) }, async () => input);
    const fixed = await read(identity, activityId, { requestId: input.requestId, documentId: input.documentId, pages: input.pages, region: null });
    const matches: { page: number; start: number; end: number; excerpt: string }[] = [];
    let truncated = false;
    for (const page of fixed.pages) {
      if (page.state !== 'ready') continue;
      let offset = 0;
      for (;;) {
        const start = page.text.indexOf(input.query, offset);
        if (start < 0) break;
        if (matches.length === 100) { truncated = true; break; }
        const end = start + input.query.length;
        matches.push({ page: page.page, start, end, excerpt: page.text.slice(Math.max(0, start - 80), end + 80) });
        offset = end;
      }
    }
    return pdfSearchResultSchema.parse({ source: { kind: 'pdf', activityId, documentId: fixed.documentId,
      documentSha256: fixed.documentSha256, readingId: fixed.readingId }, query: input.query,
      searchedPages: fixed.pages.filter(page => page.state === 'ready').map(page => page.page), matches,
      incompletePages: fixed.pages.filter(page => page.state !== 'ready').map(page => page.page),
      noTextPages: fixed.pages.filter(page => page.state === 'ready' && !page.text).map(page => page.page),
      truncated, textOrigin: 'native', ocr: 'not-performed', imagesSent: false, coordinates: 'utf16-code-units' });
  }
  return { upload: (identity: SpaceIdentity, activityId: string, value: unknown) => receive(identity, activityId, pdfUploadSchema.parse(value)),
    importCourse, list, document, original, read, reading, find };
}

/** A pure owner read, also used by isolated restore; it cannot create or render a page. */
export async function verifyPdfReference(storage: OwnedStorage, activityId: string, reference: QuestionReferenceInput) {
  const source = reference.source, range = reference.range;
  if (source.kind !== 'pdf' || source.activityId !== activityId || range.kind !== 'semantic'
    || range.typeId !== 'pdf-pages' || range.version !== 1) throw new StorageError('invalid');
  const target = pdfReferenceTargetSchema.parse(range.target);
  const { rows: [row] } = await storage.read('SELECT body FROM pdf_readings WHERE reading_id=$1 AND activity_id=$2 AND document_id=$3',
    [source.readingId, activityId, source.documentId]);
  if (!row?.body) throw new StorageError('missing');
  const reading = pdfReadingSchema.parse(row.body);
  let copy: string;
  try { copy = pdfReferenceCopy(reading); }
  catch { throw new StorageError('invalid'); }
  if (source.documentSha256 !== reading.documentSha256 || reference.copy !== copy
    || digest(target.pages) !== digest(reading.requestedPages) || digest(target.region) !== digest(reading.region)) throw new StorageError('invalid');
  const bytes = await storage.readResource(reading.readingId);
  if (JSON.stringify(pdfReadingSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')))) !== JSON.stringify(reading)) throw new StorageError('corrupt');
  const original = await storage.readResource(source.documentId);
  if (hash(original) !== source.documentSha256) throw new StorageError('corrupt');
  return reading;
}

/** Restore is a pure read of originals and used derivatives; conversion never repairs missing evidence. */
export async function validatePdfMaterials(storage: OwnedStorage) {
  const { rows: documents } = await storage.read('SELECT document_id,activity_id,request_id,body FROM pdf_documents');
  for (const row of documents) {
    const doc = pdfDocumentSchema.parse(row.body), bytes = await storage.readResource(doc.documentId);
    if (doc.documentId !== row.document_id || doc.activityId !== row.activity_id || doc.requestId !== row.request_id
      || hash(bytes) !== doc.sha256 || bytes.length !== doc.byteLength) throw new StorageError('corrupt');
  }
  const { rows: readings } = await storage.read('SELECT * FROM pdf_readings');
  for (const row of readings) {
    const input = pdfReadInputSchema.parse(row.input);
    if (input.requestId !== row.reading_id || input.documentId !== row.document_id
      || digest({ activityId: row.activity_id, input }) !== row.input_digest) throw new StorageError('corrupt');
    if (!row.body) continue;
    const body = pdfReadingSchema.parse(row.body), bytes = await storage.readResource(body.readingId);
    const fixed = pdfReadingSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')));
    if (JSON.stringify(fixed) !== JSON.stringify(body) || body.readingId !== row.reading_id || body.activityId !== row.activity_id
      || body.documentId !== row.document_id || digest(body.requestedPages) !== digest(input.pages)
      || digest(body.region) !== digest(input.region)) throw new StorageError('corrupt');
    const doc = documents.find(row => row.document_id === body.documentId);
    if (!doc || pdfDocumentSchema.parse(doc.body).sha256 !== body.documentSha256) throw new StorageError('corrupt');
  }
}
