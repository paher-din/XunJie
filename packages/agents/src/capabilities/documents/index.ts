import { z } from 'zod';
import { createHash } from 'node:crypto';
import { StorageError } from '@xunjie/storage';
import { canonicalDigest, operationId } from '@xunjie/storage/identity';
import { spaceIdentitySchema, learningTargetSchema, type LearningTarget } from '@xunjie/contracts/spaces';
import { personalProjectMaterialReferenceSchema, type PersonalProjectMaterialReference } from '@xunjie/contracts/student-learning';
import { activitySchema } from '@xunjie/contracts/learning-data';
import { materialScopeSchema, type MaterialScope, type SessionMaterialPort,
  type PersonalMaterialPort, type PdfMaterialPort } from '@xunjie/contracts/session-materials';
import { pdfRegionSchema, type ScopedPdfReading } from '@xunjie/contracts/pdf-materials';
import type { MaterialSourceRef } from '@xunjie/contracts/personal-materials';
import { modelConnectionSchema, modelAllowsImages, modelImageRefSchema, type ModelImageRef } from '@xunjie/contracts/model-connections';
import type { LearningModelPort } from '@xunjie/model-gateway/service';
import type { Facts } from '@xunjie/agent-runtime';
import type { ConversationToolContext, ConversationToolModule, ConversationToolOutcome, ConversationPreparedTool } from '../../conversation/tools.js';
import { requireConversationModelStep } from '../../conversation/basis.ts';

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
  read_pdf_images: '读取已保留 reading 的页图。仅在本次工具调用原模型步骤和 native segment 真实支持图像时提供，不切换模型或重新渲染。',
};
const preparedSchema = z.object({ version: z.literal(1), sessionId: z.uuid(), runId: z.uuid(), identity: spaceIdentitySchema,
  scope: materialScopeSchema, source: sourceSchema, modelStepId: z.uuid(), contextDigest: sha256,
  args: z.record(z.string(), z.json()), basis: z.record(z.string(), z.json()) }).strict();
type Prepared = z.infer<typeof preparedSchema>;
const json = (value: unknown): Facts => z.record(z.string(), z.json()).parse(JSON.parse(JSON.stringify(value)));
const subject = (identity: z.infer<typeof spaceIdentitySchema>) => [identity.environmentId, identity.spaceId, identity.principalId, identity.kind];
const equal = (a: unknown, b: unknown) => canonicalDigest(a) === canonicalDigest(b);
const placement = (scope: MaterialScope) => scope.kind === 'session' ? { scope } : { activityId: scope.activityId };
function hasScope(value: { activityId?: unknown; scope?: unknown }, scope: MaterialScope) {
  return scope.kind === 'session' ? value.activityId === undefined && equal(value.scope ?? null, scope)
    : value.activityId === scope.activityId && value.scope === undefined;
}
function scopeOf(ctx: ConversationToolContext): MaterialScope {
  const session = ctx.snapshot.session;
  z.uuid().parse(session.sessionId); spaceIdentitySchema.parse(session.identity);
  if (ctx.snapshot.run.sessionId !== session.sessionId) throw new StorageError('forbidden');
  if (session.scenario === 'student-assistant') return { kind: 'session', sessionId: session.sessionId };
  if (session.scenario !== 'workspace-assistant') throw new StorageError('forbidden');
  const activity = activitySchema.parse(ctx.context.facts.workspace);
  if (!equal(subject(activity.identity), subject(session.identity))) throw new StorageError('forbidden');
  return { kind: 'workspace', activityId: activity.activityId };
}
const modelStep = requireConversationModelStep;
function nameOf(value: string): Name {
  if (!Object.hasOwn(schemas, value)) throw new StorageError('invalid');
  return value as Name;
}
const fits = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= 8192;
function completed(value: unknown): ConversationToolOutcome {
  const result = json(value), text = JSON.stringify(result);
  if (!fits(result) || text.length > 8192) throw new StorageError('invalid');
  return { state: 'completed', feedback: { outcome: 'success', text, images: [] }, result };
}
const imageRouteSchema = z.object({ segmentId: z.uuid(), modelDigest: sha256 }).strict();

/** Installed only by explicit scenario composition; construction starts no work or background tasks. */
export function createDocumentTools(options: DocumentToolOptions): ConversationToolModule {
  const materials = options.materials;
  async function sourceOf(scope: MaterialScope): Promise<DocumentMaterialSource> {
    if (!options.source) throw new StorageError('forbidden');
    return sourceSchema.parse(typeof options.source === 'function' ? await options.source(structuredClone(scope)) : options.source);
  }
  function reference(ctx: ConversationToolContext, prepared: Pick<Prepared, 'scope' | 'source'>,
    kind: 'personal-material' | 'pdf', objectId: string, version: string, sha256: string): PersonalProjectMaterialReference {
    const { name, ...identity } = spaceIdentitySchema.parse(ctx.snapshot.session.identity);
    return personalProjectMaterialReferenceSchema.parse({ ...prepared.source, identity, scope: prepared.scope, kind, objectId, version, sha256 });
  }
  const pdfReferenceOf = (ctx: ConversationToolContext, prepared: Prepared, fixed: ScopedPdfReading) =>
    reference(ctx, prepared, 'pdf', fixed.documentId, fixed.documentSha256, fixed.documentSha256);
  async function catalogue(ctx: ConversationToolContext, scope = scopeOf(ctx)) {
    const identity = ctx.snapshot.session.identity;
    const personal = await materials.personal.list(identity, scope), pdf = await materials.pdf.list(identity, scope);
    if (personal.some(item => !hasScope(item, scope)) || pdf.some(item => !hasScope(item, scope))) throw new StorageError('corrupt');
    return { personal, pdf };
  }
  async function textOriginal(ctx: ConversationToolContext, scope: MaterialScope, args: z.infer<typeof schemas.read_personal_material>) {
    const fixed = await materials.personal.original(ctx.snapshot.session.identity, scope, args.materialId, args.version);
    if (!hasScope(fixed.material, scope) || fixed.material.materialId !== args.materialId || fixed.material.removedAt
      || fixed.version.materialId !== args.materialId || fixed.version.version !== args.version || fixed.version.sha256 !== args.sha256)
      throw new StorageError('forbidden');
    return fixed;
  }
  async function document(ctx: ConversationToolContext, scope: MaterialScope, args: { documentId: string; sha256: string }) {
    const fixed = await materials.pdf.document(ctx.snapshot.session.identity, scope, args.documentId);
    if (!hasScope(fixed, scope) || fixed.documentId !== args.documentId || fixed.sha256 !== args.sha256) throw new StorageError('forbidden');
    return fixed;
  }
  async function reading(ctx: ConversationToolContext, scope: MaterialScope, args: { documentId: string; sha256: string; readingId: string }) {
    await document(ctx, scope, args);
    const fixed = await materials.pdf.reading(ctx.snapshot.session.identity, scope, args.readingId);
    if (fixed && (!hasScope(fixed, scope) || fixed.readingId !== args.readingId || fixed.documentId !== args.documentId
      || fixed.documentSha256 !== args.sha256)) throw new StorageError('corrupt');
    return fixed;
  }
  function pdfSource(scope: MaterialScope, fixed: ScopedPdfReading) {
    return { kind: 'pdf', ...placement(scope), documentId: fixed.documentId, documentSha256: fixed.documentSha256, readingId: fixed.readingId };
  }
  function pdfOutcome(ctx: ConversationToolContext, prepared: Prepared, fixed: ScopedPdfReading) {
    const scope = prepared.scope;
    let limit = 2400;
    for (;;) {
      const pages = fixed.pages.map(({ image, text, detail, ...page }) => ({ ...page, ...(detail ? { detail: detail.slice(0, 200) } : {}), text: text.slice(0, limit),
        textRange: { start: 0, end: Math.min(text.length, limit), total: text.length }, textTruncated: text.length > limit,
        image: image ? { mediaType: image.mediaType, sha256: image.sha256, width: image.width, height: image.height } : null }));
      const result = { source: pdfSource(scope, fixed), reference: pdfReferenceOf(ctx, prepared, fixed), reading: { ...fixed, pages }, imagesSent: false,
        readMore: { tool: 'read_pdf_text', documentId: fixed.documentId, sha256: fixed.documentSha256, readingId: fixed.readingId,
          coordinates: 'utf16-code-units', maxLength: 2400 } };
      if (fits(result)) {
        const outcome = completed(result);
        return pages.some(page => page.state === 'ready') ? outcome
          : { ...outcome, state: 'failed' as const, feedback: { ...outcome.feedback, outcome: 'error' as const } };
      }
      if (!limit) throw new StorageError('invalid');
      limit = Math.floor(limit / 2);
    }
  }
  async function imageRoute(ctx: ConversationToolContext, stepId: string) {
    if (!options.models) throw new StorageError('forbidden');
    const step = modelStep(ctx, stepId), parsed = modelConnectionSchema.safeParse(step.snapshot.model);
    if (!parsed.success || !modelAllowsImages(parsed.data)) throw new StorageError('forbidden');
    const segmentId = z.uuid().parse(step.operation.input.segmentId);
    const segment = await options.models.segments.read(ctx.snapshot.session.identity, segmentId);
    if (segment.segmentId !== segmentId || segment.sessionId !== ctx.snapshot.session.sessionId
      || !equal(segment.connection, parsed.data) || !modelAllowsImages(segment.connection)) throw new StorageError('forbidden');
    return { segmentId, modelDigest: canonicalDigest(parsed.data) };
  }
  async function imageOutcome(ctx: ConversationToolContext, command: ConversationPreparedTool, prepared: Prepared,
    reconcile: boolean, assertDispatch?: () => Promise<void>): Promise<ConversationToolOutcome | null> {
    const args = schemas.read_pdf_images.parse(prepared.args), retained = await reading(ctx, prepared.scope, args);
    if (!retained) throw new StorageError('missing');
    const route = await imageRoute(ctx, prepared.modelStepId);
    if (!equal(route, imageRouteSchema.parse(prepared.basis.imageRoute))) throw new StorageError('forbidden');
    const selected = args.pages ?? retained.pages.filter(page => page.state === 'ready' && page.image).map(page => page.page);
    if (!selected.length || selected.length > 2) throw new StorageError('invalid');
    const images: { page: number; reference: ModelImageRef; sha256: string; width: number; height: number }[] = [];
    const source = pdfSource(prepared.scope, retained);
    for (const pageNumber of selected) {
      const page = retained.pages.find(page => page.page === pageNumber);
      if (!page || page.state !== 'ready' || !page.image) throw new StorageError('invalid');
      const bytes = Buffer.from(page.image.dataBase64, 'base64');
      if (bytes.length > 262144 || bytes.toString('base64') !== page.image.dataBase64
        || createHash('sha256').update(bytes).digest('hex') !== page.image.sha256) throw new StorageError('corrupt');
      const key = `${command.commandId}:${canonicalDigest(source)}:${page.page}:${page.image.sha256}`;
      const reference = modelImageRefSchema.parse({ imageId: operationId('agent-document-image:' + key), version: 1 });
      if (!reconcile) {
        await assertDispatch?.();
        await options.models!.images.upload(ctx.snapshot.session.identity, { requestId: operationId('agent-document-image-upload:' + key),
          imageId: reference.imageId, mediaType: 'image/png', dataBase64: page.image.dataBase64 });
        await assertDispatch?.(); await catalogue(ctx, prepared.scope);
      }
      let image;
      try { image = await options.models!.images.read(ctx.snapshot.session.identity, reference); }
      catch (error) {
        if (reconcile && error instanceof StorageError && ['missing', 'forbidden'].includes(error.code)) return null;
        throw error;
      }
      if (image.imageId !== reference.imageId || image.version !== 1 || image.mediaType !== 'image/png'
        || image.sha256 !== page.image.sha256 || image.byteLength !== bytes.length) throw new StorageError('corrupt');
      images.push({ page: page.page, reference, sha256: image.sha256, width: page.image.width, height: page.image.height });
    }
    const result = completed({ source, reference: pdfReferenceOf(ctx, prepared, retained), modelSegmentId: route.segmentId, visualPages: images.map(image => image.page), images });
    return { ...result, feedback: { ...result.feedback, images: images.map(image => image.reference) } };
  }
  async function fixed(ctx: ConversationToolContext, command: ConversationPreparedTool): Promise<{ name: Name; prepared: Prepared }> {
    const name = nameOf(command.name), prepared = preparedSchema.parse(command.input);
    if (command.effect !== 'read' || prepared.sessionId !== ctx.snapshot.session.sessionId || prepared.runId !== ctx.snapshot.run.runId
      || !equal(subject(prepared.identity), subject(ctx.snapshot.session.identity)) || !equal(prepared.scope, scopeOf(ctx))
      || prepared.contextDigest !== canonicalDigest(ctx.context)
      || !equal(prepared.source, await sourceOf(prepared.scope))) throw new StorageError('forbidden');
    modelStep(ctx, prepared.modelStepId); schemas[name].parse(prepared.args);
    return { name, prepared };
  }
  async function readTool(ctx: ConversationToolContext, command: ConversationPreparedTool, reconcile = false,
    assertDispatch?: () => Promise<void>): Promise<ConversationToolOutcome | null> {
    const { name, prepared } = await fixed(ctx, command), scope = prepared.scope;
    const files = await catalogue(ctx, scope);
    if (name === 'read_pdf_images') return imageOutcome(ctx, command, prepared, reconcile, assertDispatch);
    if (name === 'list_materials') {
      const args = schemas.list_materials.parse(prepared.args);
      const items = [...files.personal.map(material => {
        const version = material.versions.find(item => item.version === material.currentVersion);
        if (!version) throw new StorageError('corrupt');
        return { kind: 'personal-material', name: version.name, mediaType: version.mediaType, byteLength: version.byteLength,
          reference: reference(ctx, prepared, 'personal-material', material.materialId, String(version.version), version.sha256),
          source: { kind: 'personal-material', ...placement(scope), materialId: material.materialId, version: version.version, sha256: version.sha256 } };
      }), ...files.pdf.map(document => ({ kind: 'pdf', name: document.name, state: document.state, pageCount: document.pageCount,
        byteLength: document.byteLength, reference: reference(ctx, prepared, 'pdf', document.documentId, document.sha256, document.sha256),
        source: { kind: 'pdf', ...placement(scope), documentId: document.documentId, sha256: document.sha256 } }))];
      const selected = items.slice(args.offset, args.offset + args.limit);
      for (;;) {
        const nextOffset = args.offset + selected.length;
        const result = { scope, items: selected, total: items.length, offset: args.offset, nextOffset: nextOffset < items.length ? nextOffset : null };
        if (fits(result)) return completed(result);
        if (!selected.length) throw new StorageError('invalid');
        selected.pop();
      }
    }
    if (name === 'read_pdf') {
      const args = schemas.read_pdf.parse(prepared.args);
      const source = await document(ctx, scope, args);
      if (source.state !== 'ready' || args.pages.some(page => page > source.pageCount)) throw new StorageError('invalid');
      const readingId = operationId('agent-document-reading:' + command.commandId);
      const retained = reconcile ? await reading(ctx, scope, { ...args, readingId })
        : await materials.pdf.read(ctx.snapshot.session.identity, scope, { requestId: readingId,
          documentId: args.documentId, pages: args.pages, region: args.region });
      if (!retained) return null;
      if (!hasScope(retained, scope) || retained.readingId !== readingId || retained.documentId !== args.documentId
        || retained.documentSha256 !== args.sha256 || !equal(retained.requestedPages, args.pages) || !equal(retained.region, args.region))
        throw new StorageError('corrupt');
      return pdfOutcome(ctx, prepared, retained);
    }
    if (name === 'read_pdf_text') {
      const args = schemas.read_pdf_text.parse(prepared.args), retained = await reading(ctx, scope, args);
      const page = retained?.pages.find(page => page.page === args.page);
      if (!retained || !page || page.state !== 'ready' || args.start > page.text.length) throw new StorageError('invalid');
      let text = page.text.slice(args.start, args.start + args.length);
      for (;;) {
        const end = args.start + text.length;
        const result = { source: pdfSource(scope, retained), reference: pdfReferenceOf(ctx, prepared, retained), page: page.page, text, start: args.start, end,
          total: page.text.length, nextStart: end < page.text.length ? end : null,
          coordinates: 'utf16-code-units', textOrigin: 'native', ocr: 'not-performed', imagesSent: false };
        if (fits(result)) return completed(result);
        if (!text.length) throw new StorageError('invalid');
        text = text.slice(0, Math.floor(text.length / 2));
      }
    }
    if (name === 'search_materials') {
      const input = schemas.search_materials.parse({ ...prepared.args, personalReferences: prepared.basis.personalReferences,
        pdfReferences: prepared.basis.pdfReferences });
      const personalReferences = (input.personalReferences ?? []).map(source => ({ source: {
        kind: 'personal-material' as const, ...placement(scope), ...source } }));
      const pdfReferences = (input.pdfReferences ?? []).map(source => ({ source: { kind: 'pdf' as const, ...placement(scope),
        documentId: source.documentId, documentSha256: source.sha256, readingId: source.readingId } }));
      const found = await materials.search(ctx.snapshot.session.identity, scope, { query: input.query, scope: {
        courseMaterials: scope.kind === 'workspace', skillAttachments: false,
        personalMaterialIds: [...new Set((input.personalReferences ?? []).map(source => source.materialId))],
        pdfReferenceIds: [...new Set((input.pdfReferences ?? []).map(source => source.readingId))],
      } }, { personalReferences, pdfReferences });
      function searchReference(source?: MaterialSourceRef) {
        if (!source || !['personal-material', 'pdf'].includes(source.kind)) return {};
        if (source.scope ? !equal(source.scope, scope) : scope.kind !== 'workspace') throw new StorageError('corrupt');
        if (source.kind === 'personal-material') {
          const fixed = input.personalReferences?.find(item => item.materialId === source.id && String(item.version) === source.version
            && item.sha256 === source.sha256);
          if (!fixed) throw new StorageError('corrupt');
          return { reference: reference(ctx, prepared, 'personal-material', fixed.materialId, String(fixed.version), fixed.sha256) };
        }
        const fixed = input.pdfReferences?.find(item => item.readingId === source.id && item.documentId === source.documentId
          && item.sha256 === source.sha256 && item.sha256 === source.version);
        if (!fixed) throw new StorageError('corrupt');
        return { reference: reference(ctx, prepared, 'pdf', fixed.documentId, fixed.sha256, fixed.sha256) };
      }
      const matches = found.matches.map(match => ({ ...match, ...searchReference(match.source) }));
      const sources = found.sources.map(state => ({ ...state, ...searchReference(state.source) }));
      for (;;) {
        const result = { ...found, matches, sources, retainedMatchCount: found.matches.length,
          retainedSourceCount: found.sources.length, feedbackMatchesTruncated: matches.length < found.matches.length,
          sourceStatesTruncated: sources.length < found.sources.length };
        if (fits(result)) return completed(result);
        if (matches.length) matches.pop();
        else if (sources.length) sources.pop();
        else throw new StorageError('invalid');
      }
    }
    const args = schemas.read_personal_material.parse(prepared.args);
    await textOriginal(ctx, scope, args);
    const read = await materials.personal.readRange(ctx.snapshot.session.identity, scope, args.materialId, args.version, { start: args.start, length: args.length });
    if (read.materialId !== args.materialId || read.version !== args.version || read.sha256 !== args.sha256) throw new StorageError('corrupt');
    let text = read.text;
    for (;;) {
      const end = read.start + text.length;
      const result = { ...read, text, end, nextStart: end < read.total ? end : null,
        reference: reference(ctx, prepared, 'personal-material', args.materialId, String(args.version), args.sha256),
        source: { kind: 'personal-material', ...placement(scope), materialId: args.materialId, version: args.version, sha256: args.sha256 } };
      if (fits(result)) return completed(result);
      if (!text.length) throw new StorageError('invalid');
      text = text.slice(0, Math.floor(text.length / 2));
    }
  }
  async function list(ctx: ConversationToolContext) {
    if (!options.source) return [];
    const scope = scopeOf(ctx); await catalogue(ctx, scope);
    const source = await sourceOf(scope);
    return (Object.keys(schemas) as Name[]).filter(name => name !== 'read_pdf_images' || !!options.models).map(name => ({ definition: { name, description: descriptions[name],
      inputSchema: z.toJSONSchema(schemas[name], { io: 'input', override({ jsonSchema }) {
        if (jsonSchema.format === 'uuid') delete jsonSchema.format;
      } }), strict: false }, effect: 'read' as const, scope: json({ sessionId: ctx.snapshot.session.sessionId,
        scenario: ctx.snapshot.session.scenario, identity: subject(ctx.snapshot.session.identity), materials: scope, source }) }));
  }
  return { id: 'documents', version: 1, list,
    async prepare(ctx, offer, intent, commandId) {
      z.uuid().parse(commandId); const name = nameOf(intent.name), scope = scopeOf(ctx);
      const actual = (await list(ctx)).find(current => current.definition.name === name);
      if (!actual || !equal(actual, { definition: offer.definition, effect: offer.effect, scope: offer.scope })) throw new StorageError('forbidden');
      const args = schemas[name].parse(intent.arguments), step = modelStep(ctx);
      let basis: Facts = {};
      if (name === 'read_personal_material') await textOriginal(ctx, scope, schemas.read_personal_material.parse(args));
      if (name === 'read_pdf') {
        const input = schemas.read_pdf.parse(args), source = await document(ctx, scope, input);
        if (source.state !== 'ready' || input.pages.some(page => page > source.pageCount)) throw new StorageError('invalid');
      }
      if (name === 'read_pdf_text') {
        const input = schemas.read_pdf_text.parse(args), retained = await reading(ctx, scope, input);
        const page = retained?.pages.find(page => page.page === input.page);
        if (!page || page.state !== 'ready' || input.start > page.text.length) throw new StorageError('invalid');
      }
      if (name === 'search_materials') {
        const input = schemas.search_materials.parse(args), files = await catalogue(ctx, scope);
        const personalReferences = input.personalReferences ?? files.personal.map(material => {
          const version = material.versions.find(item => item.version === material.currentVersion);
          if (!version) throw new StorageError('corrupt');
          return { materialId: material.materialId, version: version.version, sha256: version.sha256 };
        });
        for (const reference of personalReferences) await textOriginal(ctx, scope, { ...reference, start: 0, length: 1 });
        const pdfReferences = input.pdfReferences ?? [];
        for (const reference of pdfReferences) if (!await reading(ctx, scope, reference)) throw new StorageError('missing');
        basis = json(schemas.search_materials.omit({ query: true }).parse({ personalReferences, pdfReferences }));
      }
      if (name === 'read_pdf_images') {
        const input = schemas.read_pdf_images.parse(args), retained = await reading(ctx, scope, input);
        if (!retained) throw new StorageError('missing');
        const pages = input.pages ?? retained.pages.filter(page => page.state === 'ready' && page.image).map(page => page.page);
        if (!pages.length || pages.some(number => !retained.pages.some(page => page.page === number && page.state === 'ready' && page.image)))
          throw new StorageError('invalid');
        basis = json({ imageRoute: await imageRoute(ctx, step.stepId) });
      }
      return { commandId, name, effect: 'read', input: json({ version: 1, sessionId: ctx.snapshot.session.sessionId,
        runId: ctx.snapshot.run.runId, identity: ctx.snapshot.session.identity, scope, source: sourceSchema.parse(actual.scope.source), modelStepId: step.stepId,
        contextDigest: canonicalDigest(ctx.context), args, basis }) };
    },
    async dispatch(ctx, command, permit, assertDispatch) {
      await fixed(ctx, command);
      if (permit.sessionId !== ctx.snapshot.session.sessionId || permit.runId !== ctx.snapshot.run.runId
        || permit.operationId !== command.commandId || permit.generation !== ctx.snapshot.run.generation
        || !ctx.snapshot.steps.some(step => step.stepId === permit.stepId && step.operation.kind === 'tool.call'
          && step.operation.operationId === command.commandId)) throw new StorageError('forbidden');
      await assertDispatch(); const result = await readTool(ctx, command, false, assertDispatch); await assertDispatch();
      if (!result) throw new StorageError('corrupt');
      await catalogue(ctx); await fixed(ctx, command); return result;
    },
    async reconcile(ctx, command) {
      const result = await readTool(ctx, command, true);
      await fixed(ctx, command); return result;
    },
  };
}
