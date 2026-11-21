import { createHash } from 'node:crypto';
import { StorageError } from '@xunjie/storage';
import { operationId } from '@xunjie/storage/identity';
import type { LearningTarget, SpaceIdentity } from '@xunjie/contracts/spaces';
import { canonicalValue } from '@xunjie/contracts/execution';
import { learningPageSchema, learningReadSchema, learningSearchSchema,
  learningProvenanceSchema, learningCourseProvenanceSchema, type LearningProvenance,
  type LearningReference, type LearningPage, type LearningDetail, type LearningItem } from '@xunjie/contracts/student-learning';
import type { createLearningData } from './index.js';
import { courseCatalogSchema, type CourseMaterialContent, type CourseRelease } from '@xunjie/contracts/courses';
import type { createPersonalProjects } from './personal-projects.js';
import { executionReveal, projectExecutionRecord } from './execution-visibility.js';
import type { ExecutionRecord } from '@xunjie/contracts/execution-records';
import { renderPdf } from '../pdf-engine/index.js';

type LearningOwner = ReturnType<typeof createLearningData>;
export interface LearningQuerySource {
  /** Host-owned mapping of local personal identity or the currently connected school member. */
  sourceId: string;
  identity: SpaceIdentity;
  target: LearningTarget;
  learning: Pick<LearningOwner, 'list' | 'open'> & {
    works?: Pick<LearningOwner['works'], 'read' | 'content'>;
    executionRecords?: Pick<LearningOwner['executionRecords'], 'history' | 'read'> &
      Partial<Pick<LearningOwner['executionRecords'], 'wasDisplayed'>>;
  };
  courses?: { owner: LearningTarget; listCourses(identity: SpaceIdentity): Promise<unknown>;
    readRelease(identity: SpaceIdentity, releaseId: string): Promise<CourseRelease>;
    readMaterial?(identity: SpaceIdentity, releaseId: string, materialId: string): Promise<CourseMaterialContent> };
  personalProjects?: Pick<ReturnType<typeof createPersonalProjects>, 'list' | 'read'>;
  ownerConversationRead?: OwnerConversationRead;
}
/** Implemented by the actual conversation owner, including its own fresh authorization. */
export interface OwnerConversationRead {
  owner: LearningTarget;
  list(identity: SpaceIdentity, cursor?: string): Promise<{ entries: OwnerConversation[]; nextCursor: string | null }>;
  /** Reauthorize the actual session and workspace before returning text/provenance. Version fixes both. */
  read(identity: SpaceIdentity, objectId: string, version: string): Promise<OwnerConversation>;
}
export interface OwnerConversation {
  objectId: string; version: string; title: string; text: string;
  /** The session's fixed Agent owner; the directory's provider may aggregate multiple historical Agents. */
  owner?: LearningTarget;
  /** Fresh owner metadata; workspace provenance is also reopened by the learning owner. */
  provenance?: LearningProvenance;
}
export type LearningQuerySourceFailure = LearningPage['unavailable'][number];
/** Construction failures carry only the host's exact source identity and error; no owner is invented. */
export interface LearningQuerySourceResult {
  sources: readonly LearningQuerySource[];
  unavailable: readonly LearningQuerySourceFailure[];
}
export interface LearningQueryHost {
  sources(): Promise<readonly LearningQuerySource[] | LearningQuerySourceResult>;
  pdfReadingReceipt?(readingId: string, fingerprint: string, write: boolean): Promise<boolean>;
}
export const learningObjectVersion = (value: unknown) => createHash('sha256').update(JSON.stringify(canonicalValue(value))).digest('hex');
const subject = (identity: Omit<SpaceIdentity, 'name'>) => [identity.environmentId, identity.spaceId, identity.principalId, identity.kind];
const equal = (a: unknown, b: unknown) => learningObjectVersion(a) === learningObjectVersion(b);

/** Federates public owner APIs. This module never receives a database or an execution-control port. */
export function createLearningQuery(host: LearningQueryHost) {
  async function currentSources(): Promise<LearningQuerySourceResult> {
    const result = await host.sources();
    return 'sources' in result ? result : { sources: result, unavailable: [] };
  }
  function reference(source: LearningQuerySource, kind: LearningReference['kind'], objectId: string,
    version: string, owner = source.target, activityId?: string): LearningReference {
    const { name: _name, ...identity } = source.identity;
    return { sourceId: source.sourceId, identity, owner, kind, objectId, version, ...(activityId ? { activityId } : {}) };
  }
  function courseConstraints(course: NonNullable<LearningProvenance['course']>) {
    const { courseId, courseName, taskId, taskTitle, releaseId, contentDigest, helpPolicy } = course;
    return learningCourseProvenanceSchema.parse({ courseId, courseName, taskId, taskTitle, releaseId, contentDigest, helpPolicy });
  }
  function activityProvenance(activity: Awaited<ReturnType<LearningOwner['open']>>): LearningProvenance {
    return { activity: { activityId: activity.activityId, target: activity.target },
      ...(activity.course ? { course: courseConstraints(activity.course) } : {}) };
  }
  // Course Skill packages have their own discovery/load owner. A query never emits all their bodies.
  function withoutSkills<T extends { skills?: unknown }>(value: T): Omit<T, 'skills'> {
    const { skills: _skills, ...rest } = value; return rest;
  }
  function activityData(activity: Awaited<ReturnType<LearningOwner['open']>>) {
    return { ...activity, ...(activity.course ? { course: withoutSkills(activity.course) } : {}) };
  }
  async function openActivity(source: LearningQuerySource, activityId: string) {
    const activity = await source.learning.open(source.identity, activityId);
    if (activity.activityId !== activityId || !equal(subject(activity.identity), subject(source.identity)) || !equal(activity.target, source.target))
      throw new StorageError('forbidden');
    return activity;
  }
  async function conversationProvenance(source: LearningQuerySource, conversation: OwnerConversation) {
    if (!conversation.provenance) return undefined;
    const provenance = learningProvenanceSchema.parse(conversation.provenance);
    if (!provenance.activity) return provenance;
    if (!equal(provenance.activity.target, source.target)) throw new StorageError('forbidden');
    const fresh = activityProvenance(await openActivity(source, provenance.activity.activityId));
    if (provenance.course && !equal(provenance.course, fresh.course)) throw new StorageError('identity-conflict');
    return fresh;
  }
  function item(ref: LearningReference, title: string, text: string, missing: string[] = [], provenance?: LearningProvenance): LearningItem {
    return { reference: provenance ? { ...ref, provenanceDigest: learningObjectVersion(provenance) } : ref,
      ...(provenance ? { provenance } : {}), title: title.slice(0, 300), excerpt: text.slice(0, 500), dueAt: null, missing };
  }
  async function recordProjection(source: LearningQuerySource, activity: Awaited<ReturnType<LearningOwner['open']>>,
    record: Record<string, unknown>) {
    const fixed = record as unknown as ExecutionRecord;
    const wasDisplayed = source.learning.executionRecords?.wasDisplayed;
    const reveal = await executionReveal({ activity, record: fixed,
      works: source.learning.works, readRecord: requestId =>
        source.learning.executionRecords!.read(source.identity, activity.activityId, requestId),
      ...(wasDisplayed ? { wasDisplayed: record => wasDisplayed(source.identity, activity.activityId, record) } : {}) });
    return projectExecutionRecord(fixed, reveal);
  }
  async function collect(kinds: readonly LearningReference['kind'][], query?: string): Promise<{ items: LearningItem[]; unavailable: LearningPage['unavailable'] }> {
    const current = await currentSources();
    const items: LearningItem[] = [], unavailable: LearningPage['unavailable'] = [...current.unavailable];
    function add(ref: LearningReference, title: string, text: string, missing: string[] = [], provenance?: LearningProvenance) {
      if (kinds.includes(ref.kind) && (!query || `${title}\n${text}`.toLocaleLowerCase().includes(query))) items.push(item(ref, title, text, missing, provenance));
    }
    async function attempt(source: LearningQuerySource, kind: LearningReference['kind'], action: () => Promise<void>) {
      try { await action(); }
      catch (error) {
        // Connection failure remains tied to this source; never change identity or owner.
        if (!(error instanceof StorageError) && !(error instanceof TypeError) && !(error instanceof Error && 'code' in error)) throw error;
        unavailable.push({ sourceId: source.sourceId, kind, code: error instanceof StorageError ? error.code : 'unavailable' });
      }
    }
    async function pages<T>(read: (cursor?: string) => Promise<{ entries: T[]; nextCursor: string | null }>, consume: (entry: T) => void | Promise<void>) {
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const result = await read(cursor);
        for (const entry of result.entries) await consume(entry);
        if (!result.nextCursor) return;
        if (seen.has(result.nextCursor) || seen.size >= 1000) throw new StorageError('corrupt');
        seen.add(result.nextCursor); cursor = result.nextCursor;
      } while (cursor);
    }
    for (const source of current.sources) {
      for (const kind of ['work', 'record', 'conversation'] as const) {
        const configured = kind === 'work' ? source.learning.works : kind === 'record'
          ? source.learning.executionRecords : source.ownerConversationRead;
        if (kinds.includes(kind) && !configured) unavailable.push({ sourceId: source.sourceId, kind, code: 'not-configured' });
      }
      const projectActivities = new Set<string>();
      if (kinds.includes('personal-project') && source.personalProjects) await attempt(source, 'personal-project', async () => {
        for (const project of await source.personalProjects!.list(source.identity)) {
          projectActivities.add(project.activityId);
          add(reference(source, 'personal-project', project.projectId, learningObjectVersion(project)),
            project.content.title, JSON.stringify(project), ['deadline']);
        }
      });
      await attempt(source, 'activity', async () => {
        for (const activity of await source.learning.list(source.identity)) {
          if (!equal(subject(activity.identity), subject(source.identity)) || !equal(activity.target, source.target)) throw new StorageError('forbidden');
          if (activity.purpose === 'preview') continue;
          const provenance = activityProvenance(activity);
          if (!projectActivities.has(activity.activityId)) add(reference(source, 'activity', activity.activityId, learningObjectVersion(activity)),
            activity.course?.taskTitle ?? activity.goal, JSON.stringify(activityData(activity)), ['deadline'], provenance);
          if (kinds.includes('work') && source.learning.works) await attempt(source, 'work', async () => {
            const works = await source.learning.works!.read(source.identity, activity.activityId);
            for (const file of works.files) add(reference(source, 'work', file.objectId, file.contentId, source.target, activity.activityId), file.name, file.value, [], provenance);
          });
          if (kinds.includes('record') && source.learning.executionRecords) await attempt(source, 'record', async () => {
            await pages(cursor => source.learning.executionRecords!.history(source.identity, activity.activityId, cursor), async record => {
              const projected = await recordProjection(source, activity, record as unknown as Record<string, unknown>);
              add(reference(source, 'record', record.requestId, learningObjectVersion(record), source.target, activity.activityId),
                `${activity.goal} · 实验记录`, projected.text,
                [...(record.result ? [] : ['execution-result']), ...projected.missing], provenance);
            });
          });
        }
      });
      if ((kinds.includes('course') || kinds.includes('course-material')) && source.courses) await attempt(source, 'course', async () => {
        const catalog = courseCatalogSchema.parse(await source.courses!.listCourses(source.identity));
        for (const course of catalog.courses) for (const task of course.tasks) for (const release of task.releases) {
          const fixed = await source.courses!.readRelease(source.identity, release.releaseId);
          if (fixed.releaseId !== release.releaseId || fixed.courseId !== course.courseId || fixed.taskId !== task.taskId
            || fixed.contentDigest !== release.contentDigest) throw new StorageError('identity-conflict');
          const provenance = { course: courseConstraints(fixed) };
          add(reference(source, 'course', release.releaseId, release.contentDigest, source.courses!.owner),
            `${course.name} · ${task.title}`, JSON.stringify({ title: task.title, release, provenance }), ['deadline'], provenance);
          if (source.courses!.readMaterial) for (const material of fixed.materials) {
            if (!readableCourseMaterial(material.mediaType)) continue;
            add({ ...reference(source, 'course-material', material.materialId, material.sha256, source.courses!.owner),
              releaseId: fixed.releaseId }, material.title, `${course.name} · ${task.title}`, [], provenance);
          }
        }
      });
      if (kinds.includes('conversation') && source.ownerConversationRead) await attempt(source, 'conversation', async () => {
        await pages(cursor => source.ownerConversationRead!.list(source.identity, cursor), async conversation =>
          add(reference(source, 'conversation', conversation.objectId, conversation.version, conversation.owner ?? source.ownerConversationRead!.owner), conversation.title, conversation.text, [], await conversationProvenance(source, conversation)));
      });
    }
    items.sort((a, b) => JSON.stringify(a.reference).localeCompare(JSON.stringify(b.reference), 'en'));
    return { items, unavailable };
  }
  function page(items: LearningItem[], unavailable: LearningPage['unavailable'], input: { offset: number; limit: number }): LearningPage {
    return { items: items.slice(input.offset, input.offset + input.limit), ...input,
      nextOffset: items.length > input.offset + input.limit ? input.offset + input.limit : null, unavailable };
  }
  async function listLearningTasks(value: unknown = {}) {
    const input = learningPageSchema.parse(value), result = await collect(['activity', 'course', 'personal-project']);
    return page(result.items, result.unavailable, input);
  }
  async function searchLearning(value: unknown) {
    const input = learningSearchSchema.parse(value), result = await collect(input.kinds
      ?? ['activity', 'course', 'course-material', 'personal-project', 'work', 'record', 'conversation'], input.query.toLocaleLowerCase());
    return page(result.items, result.unavailable, { offset: input.offset, limit: input.limit });
  }
  async function readLearning(value: unknown): Promise<LearningDetail> {
    const input = learningReadSchema.parse(value), ref = input.reference;
    const current = await currentSources();
    const source = current.sources.find(source => source.sourceId === ref.sourceId);
    const failure = current.unavailable.find(item => item.sourceId === ref.sourceId && item.kind === ref.kind)
      ?? (!source ? current.unavailable.find(item => item.sourceId === ref.sourceId) : undefined);
    if (!source) {
      // A failed construction has no trustworthy owner to authorize or query. Preserve only its original error.
      if (failure) throw new StorageError(failure.code as StorageError['code']);
      throw new StorageError('forbidden');
    }
    if (!equal(subject(source.identity), subject(ref.identity))) throw new StorageError('forbidden');
    const courseSource = ref.kind === 'course' || ref.kind === 'course-material';
    const owner = courseSource ? source.courses?.owner : ref.kind === 'conversation' ? source.ownerConversationRead?.owner : source.target;
    // A conversation directory may contain several fixed Agents; compare its fresh entry owner after authorization.
    if (!owner || (ref.kind !== 'conversation' && !equal(owner, ref.owner))) throw new StorageError('forbidden');
    if (failure) throw new StorageError(failure.code as StorageError['code']);
    let data: unknown, version: string, missing: string[] = [], provenance: LearningProvenance | undefined;
    let pdf: LearningDetail['pdf'];
    if (input.page && ref.kind !== 'course-material') throw new StorageError('invalid');
    if (ref.kind === 'work' || ref.kind === 'record') {
      if (!ref.activityId) throw new StorageError('invalid');
      const activity = await openActivity(source, ref.activityId);
      provenance = activityProvenance(activity);
      if (ref.kind === 'work') {
        if (!source.learning.works) throw new StorageError('missing');
        const file = await source.learning.works.content(source.identity, ref.activityId, ref.version);
        if (file.objectId !== ref.objectId || file.contentId !== ref.version) throw new StorageError('identity-conflict');
        data = file; version = file.contentId;
      } else {
        if (!source.learning.executionRecords) throw new StorageError('missing');
        const record = await source.learning.executionRecords.read(source.identity, ref.activityId, ref.objectId);
        if (!record) throw new StorageError('missing');
        const projected = await recordProjection(source, activity, record as unknown as Record<string, unknown>);
        data = projected.value; version = learningObjectVersion(record);
        missing = [...(record.result ? [] : ['execution-result']), ...projected.missing];
      }
    } else {
      if (ref.activityId) throw new StorageError('invalid');
      if (ref.kind === 'activity') {
        const activity = await openActivity(source, ref.objectId);
        provenance = activityProvenance(activity);
        data = activityData(activity); version = learningObjectVersion(activity); missing = ['deadline'];
      } else if (ref.kind === 'course') {
        if (!source.courses) throw new StorageError('missing');
        const course = await source.courses.readRelease(source.identity, ref.objectId);
        if (course.releaseId !== ref.objectId) throw new StorageError('identity-conflict');
        provenance = { course: courseConstraints(course) };
        data = withoutSkills(course); version = course.contentDigest; missing = ['deadline'];
      } else if (ref.kind === 'course-material') {
        if (!ref.releaseId || !source.courses?.readMaterial) throw new StorageError('missing');
        const fixed = await source.courses.readRelease(source.identity, ref.releaseId);
        if (fixed.releaseId !== ref.releaseId) throw new StorageError('identity-conflict');
        provenance = { course: courseConstraints(fixed) };
        const material = fixed.materials.find(item => item.materialId === ref.objectId);
        if (!material || !readableCourseMaterial(material.mediaType)) throw new StorageError('missing');
        version = material.sha256;
        if (version !== ref.version) throw new StorageError('conflict');
        if (fixed.helpPolicy.questions === 'disabled') {
          data = ''; missing = ['course-agent-help-disabled'];
        } else {
          const content = await source.courses.readMaterial(source.identity, ref.releaseId, material.materialId);
          const bytes = Buffer.from(content.contentBase64, 'base64');
          if (content.materialId !== material.materialId || content.sha256 !== version
            || createHash('sha256').update(bytes).digest('hex') !== version) throw new StorageError('identity-conflict');
          if (material.mediaType.toLowerCase().split(';')[0]?.trim() === 'application/pdf') {
            if (input.page) {
              const readingRange = (length: number) => ({ offset: input.range.offset, length });
              const fingerprintFor = (range: { offset: number; length: number }) => learningObjectVersion({
                identity: ref.identity, sourceId: ref.sourceId, owner: ref.owner, courseId: fixed.courseId,
                releaseId: fixed.releaseId, releaseDigest: fixed.contentDigest, documentId: material.materialId,
                documentSha256: version, page: input.page, range });
              const readingIdFor = (fingerprint: string) => operationId('course-pdf-text:' + fingerprint);
              if (input.readingId) {
                const fingerprint = fingerprintFor(input.range);
                if (input.readingId !== readingIdFor(fingerprint)
                  || !await host.pdfReadingReceipt?.(input.readingId, fingerprint, false)) throw new StorageError('missing');
              }
              const [page] = await renderPdf(bytes, [input.page], null);
              if (!page || page.state !== 'ready') {
                data = ''; missing = ['pdf-' + (page?.state ?? 'failed')];
              } else {
                // Rendering can take time. Authorize again before recording or returning text.
                const current = await source.courses.readRelease(source.identity, fixed.releaseId);
                if (current.contentDigest !== fixed.contentDigest) throw new StorageError('identity-conflict');
                data = page.text;
                const length = Math.min(input.range.length, page.text.length - input.range.offset);
                if (length > 0 && host.pdfReadingReceipt) {
                  const range = readingRange(length);
                  const fingerprint = fingerprintFor(range), readingId = readingIdFor(fingerprint);
                  if (input.readingId && input.readingId !== readingId) throw new StorageError('missing');
                  if (input.readingId || await host.pdfReadingReceipt(readingId, fingerprint, true)) {
                    pdf = { readingId, documentId: material.materialId, documentSha256: version, page: input.page, range };
                  }
                }
                if (!page.text) missing = ['pdf-no-native-text'];
                else if (length <= 0) missing = ['pdf-range-out-of-range'];
              }
            } else {
              data = JSON.stringify({ releaseId: fixed.releaseId, materialId: material.materialId,
                title: material.title, mediaType: material.mediaType, sha256: version });
              missing = ['pdf-page-required'];
            }
          } else {
            if (input.page) throw new StorageError('invalid');
            data = new TextDecoder().decode(bytes);
          }
        }
      } else if (ref.kind === 'personal-project') {
        if (!source.personalProjects) throw new StorageError('missing');
        data = await source.personalProjects.read(source.identity, ref.objectId); version = learningObjectVersion(data); missing = ['deadline'];
      } else {
        if (!source.ownerConversationRead) throw new StorageError('missing');
        const conversation = await source.ownerConversationRead.read(source.identity, ref.objectId, ref.version);
        if (conversation.objectId !== ref.objectId) throw new StorageError('identity-conflict');
        if (!equal(conversation.owner ?? source.ownerConversationRead.owner, ref.owner)) throw new StorageError('forbidden');
        provenance = await conversationProvenance(source, conversation);
        data = conversation; version = conversation.version;
      }
    }
    if (version !== ref.version || ref.provenanceDigest && (!provenance || learningObjectVersion(provenance) !== ref.provenanceDigest))
      throw new StorageError('conflict');
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    const start = input.range.offset, end = Math.min(text.length, start + input.range.length);
    return { reference: ref, ...(provenance ? { provenance } : {}), ...(pdf ? { pdf } : {}), text: text.slice(start, end), range: { offset: start, length: Math.max(0, end - start),
      total: text.length, nextOffset: end < text.length ? end : null }, missing, role: 'source-data' };
  }
  return { listLearningTasks, searchLearning, readLearning };
}

function readableCourseMaterial(mediaType: string) {
  return /^(?:text\/|application\/json(?:;|$)|application\/pdf(?:;|$))/i.test(mediaType.trim());
}
