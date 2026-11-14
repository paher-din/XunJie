import { createHash } from 'node:crypto';
import { z } from 'zod';
import { StorageError, type Migration, type OwnedStorage } from '@xunjie/storage';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import type { CourseBindingAuthority } from '@xunjie/contracts/courses';
import { PDF_LIMITS, pdfReadingSchema, pdfReadInputSchema, pdfUploadSchema,
  pdfReferenceCopy, pdfReferenceTargetSchema, pdfCourseInputSchema, pdfFindInputSchema, pdfSearchResultSchema, type PdfDocument, type PdfReading } from '@xunjie/contracts/pdf-materials';
import { scopedPdfDocumentSchema, scopedPdfReadingSchema, scopedPdfSearchResultSchema,
  type ScopedPdfDocument, type ScopedPdfReading, type ScopedPdfSearchResult } from '@xunjie/contracts/pdf-materials';
import type { MaterialScopeInput } from '@xunjie/contracts/session-materials';
import type { QuestionReferenceInput } from '@xunjie/contracts/question-drafts';
import { inspectPdf, renderPdf } from '../pdf-engine/index.js';
import { createMaterialScopeAccess, materialHasScope, materialPlacement, materialResourceScope, materialScopeColumn,
  materialScopeId, materialScopeKey, inspectMaterialScope, type MaterialScopeOptions, type WorkspaceMaterialOpen } from './session-materials.js';

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

/** Fixed originals and derived pages stay with their actual session or workspace data owner. */
type DocumentFor<S> = S extends string ? PdfDocument : ScopedPdfDocument;
type ReadingFor<S> = S extends string ? PdfReading : ScopedPdfReading;
export interface PdfMaterials<S extends MaterialScopeInput = MaterialScopeInput> {
  document(identity: SpaceIdentity, scope: S, documentId: string): Promise<DocumentFor<S>>;
  original(identity: SpaceIdentity, scope: S, documentId: string): Promise<{ document: DocumentFor<S>; bytes: Uint8Array }>;
  list(identity: SpaceIdentity, scope: S): Promise<DocumentFor<S>[]>;
  upload(identity: SpaceIdentity, scope: S, value: unknown): Promise<DocumentFor<S>>;
  importCourse(identity: SpaceIdentity, scope: S, value: unknown): Promise<DocumentFor<S>>;
  reading(identity: SpaceIdentity, scope: S, readingId: string): Promise<ReadingFor<S> | null>;
  read(identity: SpaceIdentity, scope: S, value: unknown): Promise<ReadingFor<S>>;
  find(identity: SpaceIdentity, scope: S, value: unknown): Promise<S extends string ? z.infer<typeof pdfSearchResultSchema> : ScopedPdfSearchResult>;
}
export function createPdfMaterials(storage: OwnedStorage, open: WorkspaceMaterialOpen, courses?: CourseBindingAuthority): PdfMaterials<string>;
export function createPdfMaterials(storage: OwnedStorage, options: MaterialScopeOptions, courses?: CourseBindingAuthority): PdfMaterials;
export function createPdfMaterials(storage: OwnedStorage, host: WorkspaceMaterialOpen | MaterialScopeOptions,
  courses?: CourseBindingAuthority): PdfMaterials | PdfMaterials<string> {
  const access = createMaterialScopeAccess(storage, host);
  async function document(identity: SpaceIdentity, value: MaterialScopeInput, documentId: string): Promise<ScopedPdfDocument> {
    const { scope } = await access.open(identity, value); z.uuid().parse(documentId);
    const { rows: [row] } = await storage.read(`SELECT body FROM pdf_documents WHERE document_id=$1 AND ${materialScopeColumn(scope)}=$2`, [documentId, materialScopeId(scope)]);
    if (!row) throw new StorageError('missing');
    const doc = scopedPdfDocumentSchema.parse(row.body);
    if (doc.documentId !== documentId || !materialHasScope(doc, scope)) throw new StorageError('corrupt');
    return doc;
  }
  async function original(identity: SpaceIdentity, scope: MaterialScopeInput, documentId: string) {
    const doc = await document(identity, scope, documentId);
    const bytes = await storage.readResource(documentId);
    if (hash(bytes) !== doc.sha256 || bytes.length !== doc.byteLength) throw new StorageError('corrupt');
    return { document: doc, bytes };
  }
  async function list(identity: SpaceIdentity, value: MaterialScopeInput) {
    const { scope } = await access.open(identity, value);
    const { rows } = await storage.read(`SELECT document_id FROM pdf_documents WHERE ${materialScopeColumn(scope)}=$1 ORDER BY created_at,document_id`, [materialScopeId(scope)]);
    return Promise.all(rows.map(row => document(identity, scope, String(row.document_id))));
  }
  async function receive(identity: SpaceIdentity, value: MaterialScopeInput, input: z.infer<typeof pdfUploadSchema>, courseSource?: PdfDocument['courseSource']) {
    const { scope } = await access.open(identity, value);
    const bytes = Buffer.from(input.dataBase64, 'base64');
    if (!bytes.length || bytes.length > PDF_LIMITS.inputBytes || bytes.toString('base64') !== input.dataBase64) throw new StorageError('invalid');
    const sha256 = hash(bytes), fingerprint = digest({ ...materialScopeKey(scope), ...input, dataBase64: sha256, ...(courseSource ? { courseSource } : {}) });
    const prior = await storage.receipt('pdf-upload:' + input.requestId, fingerprint);
    if (!prior) {
      const resource = await storage.stageResource({ uploadId: input.documentId, scope: 'pdf-document:' + materialResourceScope(scope),
        bytes, mediaType: 'application/pdf', contentVersion: 1 });
      const body = scopedPdfDocumentSchema.parse({ documentId: input.documentId, requestId: input.requestId, ...materialPlacement(scope), name: input.name,
        sha256, byteLength: bytes.length, state: 'received', pageCount: 0, pageLabels: [], ...(courseSource ? { courseSource } : {}) });
      await access.open(identity, scope);
      await storage.request({ requestId: 'pdf-upload:' + input.requestId, fingerprint }, async tx => {
        await access.lock(tx, identity, scope);
        await tx.query(`INSERT INTO pdf_documents(document_id,${materialScopeColumn(scope)},request_id,input_digest,body) VALUES($1,$2,$3,$4,$5)`,
          [input.documentId, materialScopeId(scope), input.requestId, fingerprint, body]);
        await tx.reference('pdf-document:' + input.documentId, resource.resourceId);
        return body;
      });
    }
    const current = await document(identity, scope, input.documentId);
    if (current.state !== 'received') return current;
    // The original is already durable. Interrupted inspection can be resumed under the same identity.
    const metadata = await inspectPdf(bytes);
    const result = scopedPdfDocumentSchema.parse({ ...current, ...metadata });
    await access.open(identity, scope);
    await storage.request({ requestId: 'pdf-inspect:' + input.requestId, fingerprint }, async tx => {
      await access.lock(tx, identity, scope);
      await tx.query('UPDATE pdf_documents SET body=$2 WHERE document_id=$1', [input.documentId, result]); return result;
    });
    return document(identity, scope, input.documentId);
  }
  async function importCourse(identity: SpaceIdentity, scopeInput: MaterialScopeInput, value: unknown) {
    const input = pdfCourseInputSchema.parse(value), opened = await access.open(identity, scopeInput), activity = opened.activity;
    if (!activity) throw new StorageError('forbidden');
    const material = activity.course?.materials.find(item => item.materialId === input.materialId);
    if (!material || material.mediaType.toLowerCase().split(';')[0]!.trim() !== 'application/pdf'
      || !activity.course || !courses?.readMaterial) throw new StorageError('forbidden');
    const fixed = await courses.readMaterial(identity, activity.course.releaseId, input.materialId);
    if (fixed.materialId !== material.materialId || fixed.sha256 !== material.sha256 || fixed.byteLength !== material.byteLength
      || fixed.mediaType !== material.mediaType || hash(Buffer.from(fixed.contentBase64, 'base64')) !== material.sha256) throw new StorageError('corrupt');
    return receive(identity, opened.scope, pdfUploadSchema.parse({ requestId: input.requestId, documentId: input.documentId,
      name: material.title.slice(0, 240), dataBase64: fixed.contentBase64 }), { releaseId: activity.course.releaseId, materialId: input.materialId });
  }
  async function reading(identity: SpaceIdentity, value: MaterialScopeInput, readingId: string): Promise<ScopedPdfReading | null> {
    const { scope } = await access.open(identity, value); z.uuid().parse(readingId);
    const { rows: [row] } = await storage.read(`SELECT body FROM pdf_readings WHERE reading_id=$1 AND ${materialScopeColumn(scope)}=$2`, [readingId, materialScopeId(scope)]);
    if (!row?.body) return null;
    const body = scopedPdfReadingSchema.parse(row.body), bytes = await storage.readResource(readingId);
    if (body.readingId !== readingId || !materialHasScope(body, scope)) throw new StorageError('corrupt');
    if (Buffer.from(bytes).toString('utf8') !== JSON.stringify(body)) {
      // jsonb key order is not byte order; compare parsed fixed content, never rerender it.
      const retained = scopedPdfReadingSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')));
      if (JSON.stringify(retained) !== JSON.stringify(body)) throw new StorageError('corrupt');
    }
    const doc = await document(identity, scope, body.documentId);
    if (doc.sha256 !== body.documentSha256) throw new StorageError('corrupt');
    return body;
  }
  async function read(identity: SpaceIdentity, scopeInput: MaterialScopeInput, value: unknown): Promise<ScopedPdfReading> {
    const { scope } = await access.open(identity, scopeInput);
    const input = pdfReadInputSchema.parse(value), fingerprint = digest({ ...materialScopeKey(scope), input });
    const prior = await storage.receipt('pdf-read:' + input.requestId, fingerprint);
    if (prior) {
      const saved = await reading(identity, scope, input.requestId);
      if (saved) return saved;
    }
    const source = await original(identity, scope, input.documentId);
    if (source.document.state !== 'ready') throw new StorageError('invalid');
    await storage.request({ requestId: 'pdf-read:' + input.requestId, fingerprint }, async tx => {
      await access.lock(tx, identity, scope);
      await tx.query(`INSERT INTO pdf_readings(reading_id,${materialScopeColumn(scope)},document_id,input_digest,input) VALUES($1,$2,$3,$4,$5)`,
        [input.requestId, materialScopeId(scope), input.documentId, fingerprint, input]);
      await tx.reference('pdf-reading-original:' + input.requestId, input.documentId); return input;
    });
    // If conversion finished but its receipt was lost, adopt the already staged exact bytes.
    let retained: Uint8Array | null = null;
    try { retained = await storage.readResource(input.requestId); }
    catch (error) { if (!(error instanceof StorageError) || !['missing', 'resource-gone'].includes(error.code)) throw error; }
    const body = retained ? scopedPdfReadingSchema.parse(JSON.parse(Buffer.from(retained).toString('utf8')))
      : scopedPdfReadingSchema.parse({ readingId: input.requestId, ...materialPlacement(scope), documentId: input.documentId,
        documentSha256: source.document.sha256, documentName: source.document.name,
        coordinates: 'rotated-cropbox-top-left-normalized', requestedPages: input.pages, region: input.region,
        pages: await renderPdf(source.bytes, input.pages, input.region) });
    if (body.readingId !== input.requestId || !materialHasScope(body, scope) || body.documentId !== input.documentId
      || digest(body.requestedPages) !== digest(input.pages) || digest(body.region) !== digest(input.region)
      || body.documentSha256 !== source.document.sha256) throw new StorageError('corrupt');
    const resource = await storage.stageResource({ uploadId: input.requestId, scope: 'pdf-reading:' + materialResourceScope(scope),
      bytes: Buffer.from(JSON.stringify(body)), mediaType: 'application/json', contentVersion: 1 });
    await access.open(identity, scope);
    await storage.request({ requestId: 'pdf-read-complete:' + input.requestId, fingerprint }, async tx => {
      await access.lock(tx, identity, scope);
      await tx.query('UPDATE pdf_readings SET body=$2 WHERE reading_id=$1', [input.requestId, body]);
      await tx.reference('pdf-reading:' + input.requestId, resource.resourceId); return body;
    });
    return (await reading(identity, scope, input.requestId))!;
  }
  async function find(identity: SpaceIdentity, scopeInput: MaterialScopeInput, value: unknown) {
    const { scope } = await access.open(identity, scopeInput);
    const input = pdfFindInputSchema.parse(value);
    await storage.request({ requestId: 'pdf-find:' + input.requestId, fingerprint: digest({ ...materialScopeKey(scope), input }) }, async () => input);
    const fixed = await read(identity, scope, { requestId: input.requestId, documentId: input.documentId, pages: input.pages, region: null });
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
    return scopedPdfSearchResultSchema.parse({ source: { kind: 'pdf', ...materialPlacement(scope), documentId: fixed.documentId,
      documentSha256: fixed.documentSha256, readingId: fixed.readingId }, query: input.query,
      searchedPages: fixed.pages.filter(page => page.state === 'ready').map(page => page.page), matches,
      incompletePages: fixed.pages.filter(page => page.state !== 'ready').map(page => page.page),
      noTextPages: fixed.pages.filter(page => page.state === 'ready' && !page.text).map(page => page.page),
      truncated, textOrigin: 'native', ocr: 'not-performed', imagesSent: false, coordinates: 'utf16-code-units' });
  }
  return { upload: (identity: SpaceIdentity, scope: MaterialScopeInput, value: unknown) => receive(identity, scope, pdfUploadSchema.parse(value)),
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
  const { rows: documents } = await storage.read('SELECT * FROM pdf_documents');
  for (const row of documents) {
    const { scope, released } = await inspectMaterialScope(storage, row), doc = scopedPdfDocumentSchema.parse(row.body);
    if (doc.documentId !== row.document_id || !materialHasScope(doc, scope) || doc.requestId !== row.request_id) throw new StorageError('corrupt');
    if (released) continue;
    const bytes = await storage.readResource(doc.documentId);
    if (hash(bytes) !== doc.sha256 || bytes.length !== doc.byteLength) throw new StorageError('corrupt');
  }
  const { rows: readings } = await storage.read('SELECT * FROM pdf_readings');
  for (const row of readings) {
    const { scope, released } = await inspectMaterialScope(storage, row);
    const input = pdfReadInputSchema.parse(row.input);
    if (input.requestId !== row.reading_id || input.documentId !== row.document_id
      || digest({ ...materialScopeKey(scope), input }) !== row.input_digest) throw new StorageError('corrupt');
    const doc = documents.find(document => document.document_id === row.document_id);
    if (!doc || doc[materialScopeColumn(scope)] !== materialScopeId(scope)) throw new StorageError('corrupt');
    if (!row.body) continue;
    const body = scopedPdfReadingSchema.parse(row.body);
    if (body.readingId !== row.reading_id || !materialHasScope(body, scope)
      || body.documentId !== row.document_id || digest(body.requestedPages) !== digest(input.pages)
      || digest(body.region) !== digest(input.region)) throw new StorageError('corrupt');
    if (scopedPdfDocumentSchema.parse(doc.body).sha256 !== body.documentSha256) throw new StorageError('corrupt');
    if (released) continue;
    const bytes = await storage.readResource(body.readingId);
    const fixed = scopedPdfReadingSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')));
    if (JSON.stringify(fixed) !== JSON.stringify(body)) throw new StorageError('corrupt');
  }
}
