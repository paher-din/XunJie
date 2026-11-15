import { z } from 'zod';
import { createHash } from 'node:crypto';
import { StorageError } from '@xunjie/storage';
import { canonicalDigest, operationId } from '@xunjie/storage/identity';
import { learningTargetSchema, type LearningTarget } from '@xunjie/contracts/spaces';
import { personalProjectMaterialReferenceSchema, type PersonalProjectMaterialReference } from '@xunjie/contracts/student-learning';
import { materialScopeSchema, type MaterialScope, type SessionMaterialPort,
  type PersonalMaterialPort, type PdfMaterialPort } from '@xunjie/contracts/session-materials';
import { pdfRegionSchema, type ScopedPdfReading } from '@xunjie/contracts/pdf-materials';
import type { MaterialSourceRef } from '@xunjie/contracts/personal-materials';
import { modelImageRefSchema, type ModelImageRef } from '@xunjie/contracts/model-connections';
import type { LearningModelPort } from '@xunjie/model-gateway/service';
import type { AgentToolResult } from '@xunjie/contracts/agent-runtime';
import type { AgentTool, ToolCall, ToolContext } from '@xunjie/agent-runtime';
import { completed, errored, json } from '../tool-support.js';

/** Full materials libraries for management consumers, including HTTP. */
export type SessionMaterials = Pick<SessionMaterialPort, 'personal' | 'pdf' | 'search'>;
/** Authorized data-owner reads. PDF read retains its reading at that owner; model images use models below. */
export interface DocumentMaterialsPort {
  personal: Pick<PersonalMaterialPort, 'list' | 'original' | 'readRange'>;
  pdf: Pick<PdfMaterialPort, 'list' | 'document' | 'reading' | 'read'>;
  search: SessionMaterialPort['search'];
}
export interface DocumentMaterialSource { sourceId: string; owner: LearningTarget; }
export interface DocumentToolOptions {
  materials: DocumentMaterialsPort;
  models?: LearningModelPort;
  /** Host-owned provenance, never model input. Without it this module offers no tools. */
  source?: DocumentMaterialSource | ((scope: MaterialScope) => Promise<DocumentMaterialSource>);
  /** Fixed by the assembling host: the session's own materials or its workspace activity. */
  scope: MaterialScope;
}
const sourceSchema = z.object({ sourceId: z.string().min(1).max(200), owner: learningTargetSchema }).strict();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const textReference = z.object({ materialId: z.uuid(), version: z.number().int().min(1).max(64), sha256 }).strict();
const pdfReference = z.object({ documentId: z.uuid(), sha256, readingId: z.uuid() }).strict();
const schemas = {
  list_materials: z.object({ offset: z.number().int().min(0).max(1000000).default(0), limit: z.number().int().min(1).max(24).default(8) }).strict(),
  read_personal_material: z.object({ materialId: z.uuid(), version: z.number().int().min(1).max(64), sha256,
    start: z.number().int().min(0).max(100000000), length: z.number().int().min(1).max(6000) }).strict(),
  read_pdf: z.object({ documentId: z.uuid(), sha256,
    pages: z.array(z.number().int().min(1).max(100000)).min(1).max(2).refine(pages => new Set(pages).size === pages.length),
    region: pdfRegionSchema.nullable().default(null) }).strict(),
  read_pdf_text: z.object({ documentId: z.uuid(), sha256, readingId: z.uuid(), page: z.number().int().min(1).max(100000),
    start: z.number().int().min(0).max(1000000), length: z.number().int().min(1).max(2400) }).strict(),
  search_materials: z.object({ query: z.string().trim().min(1).max(200),
    personalReferences: z.array(textReference).max(64).optional(), pdfReferences: z.array(pdfReference).max(16).optional() }).strict(),
  read_pdf_images: pdfReference.extend({ pages: z.array(z.number().int().min(1).max(100000)).min(1).max(2)
    .refine(pages => new Set(pages).size === pages.length).optional() }).strict(),
};
type Name = keyof typeof schemas;
const descriptions: Record<Name, string> = {
  list_materials: '分页列出当前会话或真实工作区获准的文本和 PDF 资料，保留固定版本和摘要。每项 reference 可直接用于 create_personal_project 的 materialRefs。',
  read_personal_material: '按目录中的固定版本、SHA256 和 UTF-16 范围读取文本。nextStart 继续读取同一版本。',
  read_pdf: '读取固定 PDF 的最多两页，保留一次不可变 reading。仅返回原生文字；扫描页没有文字时如实返回。',
  read_pdf_text: '按 readingId、页码和 UTF-16 范围继续读取已保留的 PDF 原生文字，不重新渲染。',
  search_materials: '搜索当前获准的固定文本版本及已保留 PDF reading 的原生文字。省略文本引用时固定当前目录版本；PDF 需先 read_pdf。',
  read_pdf_images: '读取已保留 reading 的页图。仅在装配了模型图像能力时提供，不切换模型或重新渲染。',
};
const subject = (identity: { environmentId: string; spaceId: string; principalId: string; kind: string }) =>
  [identity.environmentId, identity.spaceId, identity.principalId, identity.kind];
const equal = (a: unknown, b: unknown) => canonicalDigest(a) === canonicalDigest(b);
const placement = (scope: MaterialScope) => scope.kind === 'session' ? { scope } : { activityId: scope.activityId };
function hasScope(value: { activityId?: unknown; scope?: unknown }, scope: MaterialScope) {
  return scope.kind === 'session' ? value.activityId === undefined && equal(value.scope ?? null, scope)
    : value.activityId === scope.activityId && value.scope === undefined;
}
const fits = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= 8192;

/** Installed only by explicit scenario composition; construction starts no work or background tasks. */
export function createDocumentTools(options: DocumentToolOptions): AgentTool[] {
  const materials = options.materials, scope = materialScopeSchema.parse(options.scope);
  if (!options.source) return [];
  async function sourceOf(): Promise<DocumentMaterialSource> {
    return sourceSchema.parse(typeof options.source === 'function' ? await options.source(structuredClone(scope)) : options.source);
  }
  function reference(ctx: ToolContext, kind: 'personal-material' | 'pdf', objectId: string, version: string, digest: string, source: DocumentMaterialSource): PersonalProjectMaterialReference {
    const { name, ...identity } = ctx.identity;
    return personalProjectMaterialReferenceSchema.parse({ ...source, identity, scope, kind, objectId, version, sha256: digest });
  }
  const pdfReferenceOf = (ctx: ToolContext, fixed: ScopedPdfReading, source: DocumentMaterialSource) =>
    reference(ctx, 'pdf', fixed.documentId, fixed.documentSha256, fixed.documentSha256, source);
  async function catalogue(ctx: ToolContext) {
    const personal = await materials.personal.list(ctx.identity, scope), pdf = await materials.pdf.list(ctx.identity, scope);
    if (personal.some(item => !hasScope(item, scope)) || pdf.some(item => !hasScope(item, scope))) throw new StorageError('corrupt');
    return { personal, pdf };
  }
  async function textOriginal(ctx: ToolContext, args: z.infer<typeof schemas.read_personal_material>) {
    const fixed = await materials.personal.original(ctx.identity, scope, args.materialId, args.version);
    if (!hasScope(fixed.material, scope) || fixed.material.materialId !== args.materialId || fixed.material.removedAt
      || fixed.version.materialId !== args.materialId || fixed.version.version !== args.version || fixed.version.sha256 !== args.sha256)
      throw new StorageError('forbidden');
    return fixed;
  }
  async function document(ctx: ToolContext, args: { documentId: string; sha256: string }) {
    const fixed = await materials.pdf.document(ctx.identity, scope, args.documentId);
    if (!hasScope(fixed, scope) || fixed.documentId !== args.documentId || fixed.sha256 !== args.sha256) throw new StorageError('forbidden');
    return fixed;
  }
  async function reading(ctx: ToolContext, args: { documentId: string; sha256: string; readingId: string }) {
    await document(ctx, args);
    const fixed = await materials.pdf.reading(ctx.identity, scope, args.readingId);
    if (fixed && (!hasScope(fixed, scope) || fixed.readingId !== args.readingId || fixed.documentId !== args.documentId
      || fixed.documentSha256 !== args.sha256)) throw new StorageError('corrupt');
    return fixed;
  }
  function pdfSource(fixed: ScopedPdfReading) {
    return { kind: 'pdf', ...placement(scope), documentId: fixed.documentId, documentSha256: fixed.documentSha256, readingId: fixed.readingId };
  }
  function pdfOutcome(ctx: ToolContext, fixed: ScopedPdfReading, source: DocumentMaterialSource): AgentToolResult {
    let limit = 2400;
    for (;;) {
      const pages = fixed.pages.map(({ image, text, detail, ...page }) => ({ ...page, ...(detail ? { detail: detail.slice(0, 200) } : {}), text: text.slice(0, limit),
        textRange: { start: 0, end: Math.min(text.length, limit), total: text.length }, textTruncated: text.length > limit,
        image: image ? { mediaType: image.mediaType, sha256: image.sha256, width: image.width, height: image.height } : null }));
      const result = { source: pdfSource(fixed), reference: pdfReferenceOf(ctx, fixed, source), reading: { ...fixed, pages }, imagesSent: false,
        readMore: { tool: 'read_pdf_text', documentId: fixed.documentId, sha256: fixed.documentSha256, readingId: fixed.readingId,
          coordinates: 'utf16-code-units', maxLength: 2400 } };
      if (fits(result)) {
        const outcome = completed(JSON.stringify(result), json(result));
        return pages.some(page => page.state === 'ready') ? outcome : errored(JSON.stringify(result), json(result));
      }
      if (!limit) throw new StorageError('invalid');
      limit = Math.floor(limit / 2);
    }
  }
  async function imageOutcome(ctx: ToolContext, call: ToolCall, source: DocumentMaterialSource): Promise<AgentToolResult> {
    if (!options.models) throw new StorageError('forbidden');
    const args = schemas.read_pdf_images.parse(call.input), retained = await reading(ctx, args);
    if (!retained) throw new StorageError('missing');
    const selected = args.pages ?? retained.pages.filter(page => page.state === 'ready' && page.image).map(page => page.page);
    if (!selected.length || selected.length > 2) throw new StorageError('invalid');
    const images: { page: number; reference: ModelImageRef; sha256: string; width: number; height: number }[] = [];
    const pdfSrc = pdfSource(retained);
    for (const pageNumber of selected) {
      const page = retained.pages.find(page => page.page === pageNumber);
      if (!page || page.state !== 'ready' || !page.image) throw new StorageError('invalid');
      const bytes = Buffer.from(page.image.dataBase64, 'base64');
      if (bytes.length > 262144 || bytes.toString('base64') !== page.image.dataBase64
        || createHash('sha256').update(bytes).digest('hex') !== page.image.sha256) throw new StorageError('corrupt');
      const key = `${call.toolCallId}:${canonicalDigest(pdfSrc)}:${page.page}:${page.image.sha256}`;
      const ref = modelImageRefSchema.parse({ imageId: operationId('agent-document-image:' + key), version: 1 });
      await options.models.images.upload(ctx.identity, { requestId: operationId('agent-document-image-upload:' + key),
        imageId: ref.imageId, mediaType: 'image/png', dataBase64: page.image.dataBase64 });
      const image = await options.models.images.read(ctx.identity, ref);
      if (image.imageId !== ref.imageId || image.version !== 1 || image.mediaType !== 'image/png'
        || image.sha256 !== page.image.sha256 || image.byteLength !== bytes.length) throw new StorageError('corrupt');
      images.push({ page: page.page, reference: ref, sha256: image.sha256, width: page.image.width, height: page.image.height });
    }
    const result = { source: pdfSrc, reference: pdfReferenceOf(ctx, retained, source), visualPages: images.map(image => image.page), images };
    return { ...completed(JSON.stringify(result), json(result)), images: images.map(image => image.reference) };
  }
  async function readTool(ctx: ToolContext, call: ToolCall, name: Name): Promise<AgentToolResult> {
    const source = await sourceOf();
    const files = await catalogue(ctx);
    if (name === 'read_pdf_images') return imageOutcome(ctx, call, source);
    if (name === 'list_materials') {
      const args = schemas.list_materials.parse(call.input);
      const items = [...files.personal.map(material => {
        const version = material.versions.find(item => item.version === material.currentVersion);
        if (!version) throw new StorageError('corrupt');
        return { kind: 'personal-material', name: version.name, mediaType: version.mediaType, byteLength: version.byteLength,
          reference: reference(ctx, 'personal-material', material.materialId, String(version.version), version.sha256, source),
          source: { kind: 'personal-material', ...placement(scope), materialId: material.materialId, version: version.version, sha256: version.sha256 } };
      }), ...files.pdf.map(doc => ({ kind: 'pdf', name: doc.name, state: doc.state, pageCount: doc.pageCount,
        byteLength: doc.byteLength, reference: reference(ctx, 'pdf', doc.documentId, doc.sha256, doc.sha256, source),
        source: { kind: 'pdf', ...placement(scope), documentId: doc.documentId, sha256: doc.sha256 } }))];
      const selected = items.slice(args.offset, args.offset + args.limit);
      for (;;) {
        const nextOffset = args.offset + selected.length;
        const result = { scope, items: selected, total: items.length, offset: args.offset, nextOffset: nextOffset < items.length ? nextOffset : null };
        if (fits(result)) return completed(JSON.stringify(result), json(result));
        if (!selected.length) throw new StorageError('invalid');
        selected.pop();
      }
    }
    if (name === 'read_pdf') {
      const args = schemas.read_pdf.parse(call.input);
      const doc = await document(ctx, args);
      if (doc.state !== 'ready' || args.pages.some(page => page > doc.pageCount)) throw new StorageError('invalid');
      const readingId = operationId('agent-document-reading:' + call.toolCallId);
      const retained = await materials.pdf.read(ctx.identity, scope, { requestId: readingId,
        documentId: args.documentId, pages: args.pages, region: args.region });
      if (!hasScope(retained, scope) || retained.readingId !== readingId || retained.documentId !== args.documentId
        || retained.documentSha256 !== args.sha256 || !equal(retained.requestedPages, args.pages) || !equal(retained.region, args.region))
        throw new StorageError('corrupt');
      return pdfOutcome(ctx, retained, source);
    }
    if (name === 'read_pdf_text') {
      const args = schemas.read_pdf_text.parse(call.input), retained = await reading(ctx, args);
      const page = retained?.pages.find(page => page.page === args.page);
      if (!retained || !page || page.state !== 'ready' || args.start > page.text.length) throw new StorageError('invalid');
      let text = page.text.slice(args.start, args.start + args.length);
      for (;;) {
        const end = args.start + text.length;
        const result = { source: pdfSource(retained), reference: pdfReferenceOf(ctx, retained, source), page: page.page, text, start: args.start, end,
          total: page.text.length, nextStart: end < page.text.length ? end : null,
          coordinates: 'utf16-code-units', textOrigin: 'native', ocr: 'not-performed', imagesSent: false };
        if (fits(result)) return completed(JSON.stringify(result), json(result));
        if (!text.length) throw new StorageError('invalid');
        text = text.slice(0, Math.floor(text.length / 2));
      }
    }
    if (name === 'search_materials') {
      const input = schemas.search_materials.parse(call.input);
      const personalReferences = (input.personalReferences ?? []).map(ref => ({ source: { kind: 'personal-material' as const, ...placement(scope), ...ref } }));
      const pdfReferences = (input.pdfReferences ?? []).map(ref => ({ source: { kind: 'pdf' as const, ...placement(scope),
        documentId: ref.documentId, documentSha256: ref.sha256, readingId: ref.readingId } }));
      const found = await materials.search(ctx.identity, scope, { query: input.query, scope: {
        courseMaterials: scope.kind === 'workspace', skillAttachments: false,
        personalMaterialIds: [...new Set((input.personalReferences ?? []).map(ref => ref.materialId))],
        pdfReferenceIds: [...new Set((input.pdfReferences ?? []).map(ref => ref.readingId))],
      } }, { personalReferences, pdfReferences });
      function searchReference(matchSource?: MaterialSourceRef) {
        if (!matchSource || !['personal-material', 'pdf'].includes(matchSource.kind)) return {};
        if (matchSource.scope ? !equal(matchSource.scope, scope) : scope.kind !== 'workspace') throw new StorageError('corrupt');
        if (matchSource.kind === 'personal-material') {
          const fixed = input.personalReferences?.find(item => item.materialId === matchSource.id && String(item.version) === matchSource.version && item.sha256 === matchSource.sha256);
          if (!fixed) throw new StorageError('corrupt');
          return { reference: reference(ctx, 'personal-material', fixed.materialId, String(fixed.version), fixed.sha256, source) };
        }
        const fixed = input.pdfReferences?.find(item => item.readingId === matchSource.id && item.documentId === matchSource.documentId && item.sha256 === matchSource.sha256);
        if (!fixed) throw new StorageError('corrupt');
        return { reference: reference(ctx, 'pdf', fixed.documentId, fixed.sha256, fixed.sha256, source) };
      }
      const matches = found.matches.map(match => ({ ...match, ...searchReference(match.source) }));
      const sources = found.sources.map(state => ({ ...state, ...searchReference(state.source) }));
      for (;;) {
        const result = { ...found, matches, sources, retainedMatchCount: found.matches.length,
          retainedSourceCount: found.sources.length, feedbackMatchesTruncated: matches.length < found.matches.length,
          sourceStatesTruncated: sources.length < found.sources.length };
        if (fits(result)) return completed(JSON.stringify(result), json(result));
        if (matches.length) matches.pop();
        else if (sources.length) sources.pop();
        else throw new StorageError('invalid');
      }
    }
    const args = schemas.read_personal_material.parse(call.input);
    await textOriginal(ctx, args);
    const read = await materials.personal.readRange(ctx.identity, scope, args.materialId, args.version, { start: args.start, length: args.length });
    if (read.materialId !== args.materialId || read.version !== args.version || read.sha256 !== args.sha256) throw new StorageError('corrupt');
    let text = read.text;
    for (;;) {
      const end = read.start + text.length;
      const result = { ...read, text, end, nextStart: end < read.total ? end : null,
        reference: reference(ctx, 'personal-material', args.materialId, String(args.version), args.sha256, source),
        source: { kind: 'personal-material', ...placement(scope), materialId: args.materialId, version: args.version, sha256: args.sha256 } };
      if (fits(result)) return completed(JSON.stringify(result), json(result));
      if (!text.length) throw new StorageError('invalid');
      text = text.slice(0, Math.floor(text.length / 2));
    }
  }
  return (Object.keys(schemas) as Name[]).filter(name => name !== 'read_pdf_images' || !!options.models).map(name => ({
    definition: { name, description: descriptions[name], inputSchema: z.toJSONSchema(schemas[name], { io: 'input',
      override({ jsonSchema }) { if (jsonSchema.format === 'uuid') delete jsonSchema.format; } }) },
    supportsBackground: false,
    async execute(call: ToolCall, ctx: ToolContext): Promise<AgentToolResult> {
      if (call.executionMode === 'background') return errored('该工具不支持 background 模式');
      return readTool(ctx, call, name);
    },
  }));
}