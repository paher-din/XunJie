import { z } from 'zod';
import { pdfReadInputSchema } from '@xunjie/contracts/pdf-materials';
import type { ModelTool } from '@xunjie/contracts/model-connections';
import { toolValidators } from '@xunjie/model-gateway/chat-native';
import type { Facts, Json, RuleVersion } from './ports.js';

interface ReadWith {
  formatVersion: 1;
  tool: string;
  arguments: Facts;
}
export interface ReadbackPlan {
  locator: Facts;
  readWith: ReadWith;
}
export interface ReadbackScope {
  accepts(tool: string, args: Facts): boolean;
  courseRelease?: RuleVersion;
}

export function stepReadbackScope(tools: readonly ModelTool[], rules: readonly RuleVersion[]): ReadbackScope {
  const definitions = new Map(tools.map(tool => [tool.name, tool]));
  const courseRelease = rules.find(rule => rule.kind === 'course');
  return { ...(courseRelease ? { courseRelease } : {}), accepts(name, args) {
    const definition = definitions.get(name);
    if (!definition) return false;
    try { return toolValidators([definition]).get(name)!(args); }
    catch { return false; }
  } };
}

const uuid = z.uuid();
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const personalVersion = z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)]).pipe(z.number().int().min(1).max(64));
const objectOf = (value: Json | undefined): Facts | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;

function fixedSourceOf(source: Facts | undefined): Facts | undefined {
  return source?.kind === 'tool-call' ? fixedSourceOf(objectOf(source.source)) : source;
}

/** Read a valid prefix of the fixed range in the reader's coordinates. */
function textRange(range: { [key: string]: Json | undefined }, maximumLength: number, maximumStart = Number.MAX_SAFE_INTEGER) {
  const start = range.start ?? range.offset ?? 0;
  if (typeof start !== 'number' || !Number.isSafeInteger(start) || start < 0 || start > maximumStart) return null;
  const length = range.length ?? (typeof range.end === 'number' ? range.end - start : maximumLength);
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 1) return null;
  return { start, length: Math.min(length, maximumLength) };
}

/** Shared by the recorded readback flag and projection against the current Step's tools. */
export function readbackForSource(source: Facts, scope: ReadbackScope, capturedRange?: Facts): ReadbackPlan[] {
  const fixed = fixedSourceOf(source);
  if (!fixed) return [];
  const range = { ...objectOf(fixed.range), ...capturedRange };
  const locator: Facts = {};
  for (const key of ['kind', 'objectId', 'contentId', 'requestId', 'materialId', 'materialSha256', 'sha256',
    'readingId', 'documentId', 'documentSha256', 'releaseId', 'contentDigest', 'activityId', 'executionRef',
    'inputDigest', 'version', 'start', 'end', 'offset', 'length', 'statusOnly']) {
    const value = fixed[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') locator[key] = value;
  }
  if (Object.keys(range).length) locator.range = range;
  const call = (tool: string, args: Facts, location = locator): ReadbackPlan[] =>
    scope.accepts(tool, args) ? [{ locator: location, readWith: { formatVersion: 1, tool, arguments: args } }] : [];

  switch (fixed.kind) {
    case 'work': {
      const id = z.object({ objectId: uuid, contentId: uuid }).safeParse(fixed);
      const slice = textRange({ ...fixed, ...range }, 8192);
      return id.success && slice ? call('read_work', { ...id.data, offset: slice.start, length: slice.length }) : [];
    }
    case 'course-material': {
      const materialId = uuid.safeParse(fixed.materialId);
      const release = scope.courseRelease;
      if (!release || release.id !== fixed.releaseId || release.version !== fixed.contentDigest
        || !materialId.success || !sha.safeParse(fixed.materialSha256).success) return [];
      return call('read_material', { materialId: materialId.data });
    }
    case 'personal-material': {
      const id = z.object({ materialId: uuid, version: personalVersion, sha256: sha }).safeParse(fixed);
      const slice = textRange({ ...fixed, ...range }, 6000, 100_000_000);
      return id.success && slice ? call('read_personal_material', { ...id.data, ...slice }) : [];
    }
    case 'pdf': {
      const id = z.object({ documentId: uuid, documentSha256: sha }).safeParse(fixed);
      if (!id.success) return [];
      const identity = { documentId: id.data.documentId, sha256: id.data.documentSha256 };
      const readingId = fixed.readingId;
      const page = range.page ?? fixed.page;
      const pages = pdfReadInputSchema.shape.pages.safeParse(page !== undefined ? [page] : range.pages ?? fixed.pages);
      if (!pages.success) return [];
      if (readingId === undefined || readingId === null) {
        const region = pdfReadInputSchema.shape.region.safeParse(range.region ?? fixed.region ?? null);
        return region.success ? call('read_pdf', { ...identity, pages: pages.data, region: region.data },
          { ...locator, pages: pages.data, region: region.data }) : [];
      }
      if (!uuid.safeParse(readingId).success) return [];
      const reads = pages.data.flatMap(page => {
        const pageRanges = objectOf(range.pageRanges);
        const pageSlice = objectOf(pageRanges?.[page]);
        if (pageRanges && !pageSlice) return [];
        const slice = textRange({ ...fixed, ...range, ...pageSlice }, 2400, 1_000_000);
        return slice ? call('read_pdf_text', { ...identity, readingId, page, ...slice }, { ...locator, page }) : [];
      });
      return reads.length === pages.data.length ? reads : [];
    }
    case 'component':
    case 'experiment-reference': {
      const requestId = uuid.safeParse(fixed.requestId);
      if (!requestId.success) return [];
      const args = { requestId: requestId.data };
      const result = call('read_result', args);
      return result.length ? result : call('execution_query', args);
    }
    default:
      return [];
  }
}

export function hasFixedReadback(source: Facts, scope: ReadbackScope, range?: Facts): boolean {
  return readbackForSource(source, scope, range).length > 0;
}
