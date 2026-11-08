import { createHash } from 'node:crypto';
import { z } from 'zod';
import { StorageError } from '@xunjie/storage';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import type { LearningActivity } from '@xunjie/contracts/learning-data';
import type { CourseBindingAuthority } from '@xunjie/contracts/courses';
import type { TeachingSkillReference, TeachingSkillState } from '@xunjie/contracts/agent-skills';
import type { QuestionReferenceInput } from '@xunjie/contracts/question-drafts';
import { materialSearchInputSchema, materialSearchResultSchema, materialSearchScopeSchema, PERSONAL_MATERIAL_LIMITS, type MaterialSearchMatch,
  type MaterialSearchResult, type MaterialSearchSourceState, type MaterialSourceRef } from '@xunjie/contracts/personal-materials';
import type { createPdfMaterials } from './pdf-materials.js';
import type { createPersonalMaterials } from './personal-materials.js';

const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const textMedia = (mediaType: string) => {
  const type = mediaType.toLowerCase().split(';')[0]!.trim();
  return type.startsWith('text/') || type === 'application/json' || type === 'application/xml';
};
const normalize = (value: string) => value.toLocaleLowerCase();
const sourceFailure = (error: unknown, detail: string): [MaterialSearchSourceState['state'], string] => {
  const code = (error as { code?: unknown })?.code;
  if (code === 'forbidden' || code === 'identity-conflict') return ['no-access', `${detail}：无访问资格`];
  if (code === 'missing') return ['missing', `${detail}：来源缺失`];
  return ['partial-failure', `${detail}：读取失败`];
};
const lineAt = (text: string, index: number) => text.slice(0, index).split('\n').length;
const excerpt = (text: string, index: number, length: number) => text.slice(Math.max(0, index - 120), Math.min(text.length, index + length + 120))
  .replace(/\s+/g, ' ').trim().slice(0, 500);

/**
 * The unified search owner. It authorizes every source before naming it, and returns only
 * fixed-version snippets with their actual read method and coverage. It never writes an index
 * that could outlive its original: sources are read at query time.
 */
export function createMaterialSearch(options: {
  open(identity: SpaceIdentity, activityId: string): Promise<LearningActivity>;
  courses?: CourseBindingAuthority;
  pdf?: Pick<ReturnType<typeof createPdfMaterials>, 'reading'>;
  personal?: Pick<ReturnType<typeof createPersonalMaterials>, 'original'>;
}) {
  async function search(identity: SpaceIdentity, activityId: string, value: unknown, selection: {
    pdfReferences?: QuestionReferenceInput[];
    personalReferences?: QuestionReferenceInput[];
    skillReferences?: TeachingSkillReference[];
    skillState?: TeachingSkillState;
    skillRead?: (skillId: string, version: number, path: string) => Promise<{ content: string; digest: string }>;
  } = {}): Promise<MaterialSearchResult> {
    const input = materialSearchInputSchema.parse(value);
    const activity = await options.open(identity, activityId);
    // A caller that omits an explicit source list gets the current draft selection; an explicit
    // empty list remains an intentional empty scope. The effective scope is recorded below.
    const personalIds = input.scope.personalMaterialIds ?? (selection.personalReferences ?? [])
      .flatMap(reference => reference.source.kind === 'personal-material' ? [reference.source.materialId] : []);
    const pdfIds = input.scope.pdfReferenceIds ?? (selection.pdfReferences ?? [])
      .flatMap(reference => reference.source.kind === 'pdf' ? [reference.source.readingId] : []);
    const effectiveScope = materialSearchScopeSchema.parse({ ...input.scope,
      ...(personalIds === undefined ? {} : { personalMaterialIds: [...new Set(personalIds)] }),
      ...(pdfIds === undefined ? {} : { pdfReferenceIds: [...new Set(pdfIds)] }) });
    const matches: MaterialSearchMatch[] = [], sources: MaterialSearchSourceState[] = [];
    let truncated = false, searchedChars = 0, searched = 0, excluded = 0, total = 0;
    const kinds = new Set<MaterialSearchResult['coverage']['kinds'][number]>();
    const add = (source: MaterialSourceRef | undefined, state: MaterialSearchSourceState['state'], text: string | undefined,
      detail?: string, readMethod: MaterialSearchMatch['readMethod'] = 'stored-text', locator?: (index: number, length: number, text: string) => MaterialSearchMatch['locator']) => {
      total += 1;
      const hasText = text !== undefined && text.trim().length > 0;
      const effectiveState = text !== undefined && !hasText ? 'no-text' : state;
      if (hasText) { searched += 1; searchedChars += text!.length; if (source) kinds.add(source.kind); }
      sources.push({ ...(source ? { source } : {}), state: effectiveState,
        ...(detail ? { detail } : {}), ...(text !== undefined ? { searchedChars: text.length } : {}) });
      if (!hasText) return;
      const haystack = normalize(text), needle = normalize(input.query);
      let from = 0;
      while (matches.length < PERSONAL_MATERIAL_LIMITS.searchMatches) {
        const index = haystack.indexOf(needle, from);
        if (index < 0) break;
        matches.push({ source: source!, locator: locator ? locator(index, input.query.length, text) : { line: lineAt(text, index), start: index, end: index + input.query.length }, excerpt: excerpt(text, index, input.query.length), readMethod });
        from = index + Math.max(1, needle.length);
      }
      if (matches.length >= PERSONAL_MATERIAL_LIMITS.searchMatches && haystack.indexOf(needle, from) >= 0) truncated = true;
    };
    // Course materials: the course release is the authority; a failed read is reported without a title.
    if (input.scope.courseMaterials && !activity.course) {
      sources.push({ state: 'no-access', detail: '当前活动不属于课程，未搜索课程材料' });
    } else if (input.scope.courseMaterials && activity.course && options.courses?.readMaterial) {
      for (const material of activity.course.materials) {
        if (material.mediaType.toLowerCase().split(';')[0]!.trim() === 'application/pdf') {
          add(undefined, 'not-indexed', undefined, 'PDF 课程材料请在其引用范围内检索原生文字层');
          continue;
        }
        if (!textMedia(material.mediaType)) { add(undefined, 'no-text', undefined, '材料不是可检索文本'); continue; }
        try {
          const fixed = await options.courses.readMaterial(identity, activity.course.releaseId, material.materialId);
          if (fixed.materialId !== material.materialId || fixed.sha256 !== material.sha256
            || fixed.byteLength !== material.byteLength) throw new StorageError('identity-conflict');
          const bytes = Buffer.from(fixed.contentBase64, 'base64');
          if (digest(bytes) !== material.sha256 || bytes.length !== material.byteLength) throw new StorageError('corrupt');
          const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          add({ kind: 'course-material', id: material.materialId, version: material.sha256, sha256: material.sha256,
            label: material.title, releaseId: activity.course.releaseId, materialId: material.materialId }, 'searched', text);
        } catch (error) { const [state, detail] = sourceFailure(error, '材料当前不可读取'); add(undefined, state, undefined, detail); }
      }
    }
    // Personal notes: selection pins the exact version/digest. Same names never select by name.
    if (personalIds?.length && options.personal) {
      const seen = new Set<string>();
      for (const reference of selection.personalReferences ?? []) {
        if (reference.source.kind !== 'personal-material' || !personalIds.includes(reference.source.materialId)) continue;
        const key = reference.source.materialId + ':' + reference.source.version;
        if (seen.has(key)) continue; seen.add(key);
        try {
          const fixed = await options.personal.original(identity, activityId, reference.source.materialId, reference.source.version);
          if (fixed.version.sha256 !== reference.source.sha256) throw new StorageError('identity-conflict');
          if (fixed.material.removedAt) throw new StorageError('forbidden');
          add({ kind: 'personal-material', id: reference.source.materialId, version: String(fixed.version.version),
            sha256: fixed.version.sha256, label: fixed.version.name }, 'searched', fixed.text);
        } catch (error) { const [state, detail] = sourceFailure(error, '个人材料版本不可读取'); add(undefined, state, undefined, detail); }
      }
      const seenIds = new Set([...seen].map(key => key.slice(0, key.lastIndexOf(':'))));
      for (const id of personalIds) if (!seenIds.has(id)) {
        excluded += 1; add(undefined, 'missing', undefined, '所选个人材料不在本次草稿的固定引用中');
      }
    }
    // PDF readings: only the fixed reading in the draft reference; native text layer only.
    if (pdfIds?.length && options.pdf) {
      const seen = new Set<string>();
      for (const reference of selection.pdfReferences ?? []) {
        if (reference.source.kind !== 'pdf' || !pdfIds.includes(reference.source.readingId)) continue;
        const readingId = reference.source.readingId;
        if (seen.has(readingId)) continue; seen.add(readingId);
        try {
          const reading = await options.pdf.reading(identity, activityId, readingId);
          if (!reading || reading.activityId !== activityId || reading.documentId !== reference.source.documentId
            || reading.documentSha256 !== reference.source.documentSha256) throw new StorageError('identity-conflict');
          const pages = reading.pages.filter(page => page.state === 'ready');
          const text = pages.map(page => page.text).join('\n');
          const source: MaterialSourceRef = { kind: 'pdf', id: readingId, version: reading.documentSha256,
            sha256: reading.documentSha256, label: reading.documentName, documentId: reading.documentId, readingId };
          add(source, pages.length < reading.pages.length ? 'partial-failure' : pages.some(page => page.text) ? 'searched' : 'no-text',
            text || undefined, pages.length < reading.pages.length ? '部分页不可读取' : undefined, 'native-pdf-text', (index, length) => {
              let offset = 0;
              for (const page of pages) {
                const end = offset + page.text.length;
                if (index >= offset && index <= end) return { page: page.page, start: index - offset, end: index - offset + length };
                offset = end + 1;
              }
              return { page: pages[0]?.page ?? 1, start: 0, end: length };
            });
        } catch (error) { const [state, detail] = sourceFailure(error, 'PDF 引用不可读取'); add(undefined, state, undefined, detail); }
      }
      for (const id of pdfIds) if (!seen.has(id)) {
        excluded += 1; add(undefined, 'missing', undefined, '所选 PDF 不在本次草稿的固定引用中');
      }
    }
    // Skill attachments: only selected, non-disabled skills; inert data is read from the skill owner.
    if (input.scope.skillAttachments && selection.skillRead && selection.skillState) {
      const explicitSkills = selection.skillReferences
        ? new Set(selection.skillReferences.map(reference => `${reference.skillId}:${reference.version}`)) : null;
      for (const skill of selection.skillState.catalog) {
        if (!skill.selected || skill.disabled || skill.unavailable) continue;
        if (explicitSkills && !explicitSkills.has(`${skill.skillId}:${skill.version}`)) continue;
        for (const attachment of skill.attachments) {
          if (attachment.encoding !== 'utf8' || !textMedia(attachment.mediaType)) continue;
          if (attachment.byteLength > 512 * 1024) { add({ kind: 'skill-attachment', id: `${skill.skillId}:${attachment.path}`,
            version: String(skill.version), sha256: attachment.digest, label: `${skill.name} · ${attachment.path}`,
            skillId: skill.skillId, path: attachment.path }, 'not-indexed', undefined, '附件过大，未建立检索'); continue; }
          try {
            const fixed = await selection.skillRead(skill.skillId, skill.version, attachment.path);
            if (fixed.digest !== attachment.digest) throw new StorageError('identity-conflict');
            add({ kind: 'skill-attachment', id: `${skill.skillId}:${attachment.path}`, version: String(skill.version),
              sha256: attachment.digest, label: `${skill.name} · ${attachment.path}`, skillId: skill.skillId, path: attachment.path },
            'searched', fixed.content, undefined, 'skill-text-attachment');
          } catch (error) { const [state, detail] = sourceFailure(error, 'Skill 附件不可读取'); add(undefined, state, undefined, detail); }
        }
      }
    }
    if (searched > 0 && matches.length === 0)
      sources.push({ state: 'no-hit', detail: `已实际搜索 ${searched} 个来源，未找到匹配` });
    else if (searched === 0 && total === 0)
      sources.push({ state: 'no-access', detail: '本次范围没有可检索的来源' });
    return materialSearchResultSchema.parse({ query: input.query, scope: effectiveScope, matches, sources,
      coverage: { sourceCount: total, searchedSourceCount: searched, excludedSourceCount: excluded, searchedChars,
        kinds: [...kinds] }, truncated });
  }
  return { search };
}
