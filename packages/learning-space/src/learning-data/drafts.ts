import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { StorageError } from '@xunjie/storage';
import type { Migration, OwnedStorage } from '@xunjie/storage';
import { questionDraftSyncSchema, questionDraftViewSchema, questionReferenceKey } from '@xunjie/contracts/question-drafts';
import type { QuestionDraftSync, QuestionDraftView, QuestionReference } from '@xunjie/contracts/question-drafts';
import { courseReferenceTextSourceSchema } from '@xunjie/contracts/courses';
import type { CourseReferenceAuthority } from '@xunjie/contracts/courses';
import type { LearningActivity } from '@xunjie/contracts/learning-data';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import { referenceTextSelection, referenceSelectionDigest } from '../reference-text.js';

export const questionDraftMigration: Migration = { version: 4, name: 'question-drafts-and-fixed-references', sql: `
  CREATE TABLE question_drafts(draft_id uuid PRIMARY KEY,activity_id uuid NOT NULL REFERENCES activities(id),
    space_environment_id uuid NOT NULL,space_id uuid NOT NULL,principal_id uuid NOT NULL,
    revision integer NOT NULL CHECK(revision>=1),revision_id uuid NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp());
  CREATE TABLE question_draft_revisions(draft_id uuid NOT NULL REFERENCES question_drafts(draft_id),
    revision integer NOT NULL,revision_id uuid NOT NULL,body jsonb NOT NULL,content_digest text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(draft_id,revision),UNIQUE(draft_id,revision_id));
  CREATE TABLE question_draft_receipts(request_id uuid PRIMARY KEY,draft_id uuid NOT NULL REFERENCES question_drafts(draft_id));
` };

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copyDigest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const fail = (code: 'forbidden' | 'invalid' | 'missing' | 'corrupt' | 'identity-conflict' | 'conflict'): never => {
  throw new StorageError(code);
};
function operationId(value: string) {
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 64; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export const draftIdFor = (activityId: string) => operationId(`question-draft:${activityId}`);

function verifiedCopy(text: string, reference: { range: { start: number; end: number }; copy: string }) {
  if (referenceTextSelection(text, reference.range) !== reference.copy) return fail('invalid');
}

type WorksBasis = {
  content(identity: SpaceIdentity, activityId: string, contentId: string): Promise<{ objectId: string; kind: string; value: string }>;
  registerBasis(identity: SpaceIdentity, activityId: string, basis: unknown): Promise<{ objectId: string; contentId: string }>;
};

export function createQuestionDrafts(storage: OwnedStorage, options: {
  activity(identity: SpaceIdentity, activityId: string): Promise<LearningActivity>;
  works: WorksBasis;
  courses: CourseReferenceAuthority | undefined;
}) {
  const { activity: open, works, courses } = options;
  function empty(draftId: string): QuestionDraftView {
    return questionDraftViewSchema.parse({ draftId, revision: 0, revisionId: null, question: '', references: [] });
  }
  function scope(identity: SpaceIdentity, activityId: string) {
    return [activityId, identity.environmentId, identity.spaceId, identity.principalId] as const;
  }
  async function head(identity: SpaceIdentity, activityId: string) {
    const draftId = draftIdFor(activityId);
    const { rows: [row] } = await storage.read(`SELECT h.revision,h.revision_id,r.body FROM question_drafts h
      JOIN question_draft_revisions r ON r.draft_id=h.draft_id AND r.revision=h.revision
      WHERE h.draft_id=$1 AND h.activity_id=$2 AND h.space_environment_id=$3 AND h.space_id=$4 AND h.principal_id=$5`,
      [draftId, ...scope(identity, activityId)]);
    return row ? { draft: questionDraftViewSchema.parse(row.body), draftId } : { draft: empty(draftId), draftId };
  }
  async function read(identity: SpaceIdentity, activityId: string): Promise<QuestionDraftView> {
    await open(identity, activityId);
    return (await head(identity, activityId)).draft;
  }
  async function revision(identity: SpaceIdentity, activityId: string, revisionId: string): Promise<QuestionDraftView | null> {
    await open(identity, activityId); z.uuid().parse(revisionId);
    const draftId = draftIdFor(activityId);
    const { rows: [row] } = await storage.read(`SELECT r.body FROM question_draft_revisions r JOIN question_drafts h
      ON h.draft_id=r.draft_id WHERE r.draft_id=$1 AND r.revision_id=$2 AND h.activity_id=$3
      AND h.space_environment_id=$4 AND h.space_id=$5 AND h.principal_id=$6`,
      [draftId, revisionId, ...scope(identity, activityId)]);
    return row ? questionDraftViewSchema.parse(row.body) : null;
  }
  async function receipt(identity: SpaceIdentity, activityId: string, requestId: string): Promise<QuestionDraftView | null> {
    await open(identity, activityId); z.uuid().parse(requestId);
    const draftId = draftIdFor(activityId);
    const { rows } = await storage.read('SELECT request_id FROM question_draft_receipts WHERE request_id=$1 AND draft_id=$2',
      [requestId, draftId]);
    if (!rows.length) return null;
    const saved = await storage.receipt(requestId);
    if (!saved) return fail('corrupt');
    return questionDraftViewSchema.parse((saved.result as { draft: unknown }).draft);
  }

  async function verifySources(identity: SpaceIdentity, activity: LearningActivity, input: QuestionDraftSync) {
    const bases = new Map<string, QuestionDraftSync['bases'][number]>();
    for (const basis of input.bases) {
      if (bases.has(basis.contentId)) return fail('identity-conflict');
      bases.set(basis.contentId, basis);
    }
    const used = new Set<string>();
    for (const reference of input.references) {
      const source = reference.source;
      if (source.kind === 'work') {
        used.add(source.contentId);
        const basis = bases.get(source.contentId);
        if (basis) {
          if (basis.objectId !== source.objectId || (reference.range.kind === 'code') !== (basis.kind === 'code'))
            return fail('invalid');
          await works.registerBasis(identity, activity.activityId, basis);
        }
        const content = await works.content(identity, activity.activityId, source.contentId);
        if (content.objectId !== source.objectId || (reference.range.kind === 'code') !== (content.kind === 'code'))
          return fail('identity-conflict');
        verifiedCopy(content.value, reference);
        continue;
      }
      const course = activity.course;
      if (!course) return fail('forbidden');
      if (source.courseId !== course.courseId || source.taskId !== course.taskId
        || source.releaseId !== course.releaseId || source.contentDigest !== course.contentDigest)
        return fail('identity-conflict');
      if (source.kind === 'course-material') {
        const material = course.materials.find(item => item.materialId === source.materialId);
        if (!material) return fail('missing');
        if (material.sha256 !== source.materialSha256 || material.mediaType !== source.mediaType)
          return fail('identity-conflict');
      }
      if (reference.range.kind !== 'text') return fail('invalid');
      await courses!.verifyReference(identity, { source, range: { start: reference.range.start, end: reference.range.end },
        selectionDigest: referenceSelectionDigest(reference.copy) });
    }
    for (const contentId of bases.keys()) if (!used.has(contentId)) return fail('invalid');
  }

  function storedReferences(input: QuestionDraftSync): QuestionReference[] {
    return input.references.map(reference => ({ ...reference, copyDigest: copyDigest(reference.copy) }));
  }

  async function sync(identity: SpaceIdentity, activityId: string, value: unknown): Promise<QuestionDraftView> {
    const activity = await open(identity, activityId);
    let input: QuestionDraftSync;
    try { input = questionDraftSyncSchema.parse(value); } catch { return fail('invalid'); }
    const draftId = draftIdFor(activityId);
    if (input.draftId !== draftId) return fail('identity-conflict');
    if (new Set(input.references.map(questionReferenceKey)).size !== input.references.length) return fail('invalid');
    const fingerprint = digest({ identity, activityId, input });
    const previous = await storage.receipt(input.requestId, fingerprint);
    if (previous) return questionDraftViewSchema.parse((previous.result as { draft: unknown }).draft);
    await verifySources(identity, activity, input);
    const references = storedReferences(input);
    const result = await storage.request({ requestId: input.requestId, fingerprint }, async tx => {
      const { rows: [row] } = await tx.query(`SELECT revision FROM question_drafts WHERE draft_id=$1 AND activity_id=$2
        AND space_environment_id=$3 AND space_id=$4 AND principal_id=$5 FOR UPDATE`, [draftId, ...scope(identity, activityId)]);
      if (!row && input.baseRevision !== 0) throw new StorageError('conflict');
      if (row && Number(row.revision) !== input.baseRevision) throw new StorageError('conflict');
      const revisionId = randomUUID();
      const draft = questionDraftViewSchema.parse({ draftId, revision: input.baseRevision + 1, revisionId,
        question: input.question, references });
      const contentDigest = digest({ question: draft.question, references: draft.references });
      if (!row) {
        await tx.query(`INSERT INTO question_drafts(draft_id,activity_id,space_environment_id,space_id,principal_id,revision,revision_id)
          VALUES($1,$2,$3,$4,$5,$6,$7)`, [draftId, ...scope(identity, activityId), draft.revision, revisionId]);
      } else {
        await tx.query(`UPDATE question_drafts SET revision=$2,revision_id=$3,updated_at=clock_timestamp()
          WHERE draft_id=$1`, [draftId, draft.revision, revisionId]);
      }
      await tx.query(`INSERT INTO question_draft_revisions(draft_id,revision,revision_id,body,content_digest)
        VALUES($1,$2,$3,$4,$5)`, [draftId, draft.revision, revisionId, JSON.stringify(draft), contentDigest]);
      for (const reference of draft.references) {
        // Course material retention belongs to its release in the course owner; this owner
        // only links work content it actually stores.
        if (reference.source.kind === 'work')
          await tx.reference(`question-reference/${draftId}/${revisionId}/${reference.referenceId}`, reference.source.contentId);
      }
      await tx.query('INSERT INTO question_draft_receipts(request_id,draft_id) VALUES($1,$2)', [input.requestId, draftId]);
      return { draft };
    });
    return questionDraftViewSchema.parse((result.result as { draft: unknown }).draft);
  }

  return { read, revision, sync, receipt, validate: () => validateQuestionDrafts(storage) };
}

export async function validateQuestionDrafts(storage: OwnedStorage) {
    const { rows: heads } = await storage.read(`SELECT h.draft_id,h.activity_id,h.space_environment_id,h.space_id,h.principal_id,
      h.revision,h.revision_id,r.body,r.content_digest FROM question_drafts h
      JOIN question_draft_revisions r ON r.draft_id=h.draft_id AND r.revision=h.revision`);
    for (const row of heads) {
      const draft = questionDraftViewSchema.parse(row.body);
      if (draft.draftId !== row.draft_id || draft.draftId !== draftIdFor(String(row.activity_id))
        || draft.revision !== Number(row.revision) || draft.revisionId !== row.revision_id
        || row.content_digest !== digest({ question: draft.question, references: draft.references })) fail('corrupt');
      for (const reference of draft.references) {
        if (reference.copyDigest !== copyDigest(reference.copy)
          || reference.copy.length !== reference.range.end - reference.range.start) fail('corrupt');
        if (reference.source.kind !== 'work') continue;
        const { rows: [content] } = await storage.read(`SELECT activity_id,object_id FROM work_contents WHERE content_id=$1`,
          [reference.source.contentId]);
        if (!content || content.activity_id !== row.activity_id || content.object_id !== reference.source.objectId) fail('corrupt');
        const text = Buffer.from(await storage.readResource(reference.source.contentId)).toString('utf8');
        if (text.slice(reference.range.start, reference.range.end) !== reference.copy) fail('corrupt');
      }
    }
    const { rows: revisions } = await storage.read(`SELECT r.draft_id,r.revision,r.revision_id,r.body,r.content_digest
      FROM question_draft_revisions r`);
    for (const row of revisions) {
      const draft = questionDraftViewSchema.parse(row.body);
      if (draft.draftId !== row.draft_id || draft.revision !== Number(row.revision) || draft.revisionId !== row.revision_id
        || row.content_digest !== digest({ question: draft.question, references: draft.references })) fail('corrupt');
    }
    const { rows: receipts } = await storage.read('SELECT request_id,draft_id FROM question_draft_receipts');
    for (const receiptRow of receipts) {
      const saved = await storage.receipt(String(receiptRow.request_id));
      if (!saved) return fail('corrupt');
      const draft = questionDraftViewSchema.parse((saved.result as { draft: unknown }).draft);
      const { rows: [stored] } = await storage.read(`SELECT body FROM question_draft_revisions
        WHERE draft_id=$1 AND revision=$2`, [receiptRow.draft_id, draft.revision]);
      if (!stored) return fail('corrupt');
      // jsonb does not preserve key order; compare schema-normalized bodies.
      if (JSON.stringify(questionDraftViewSchema.parse(stored.body)) !== JSON.stringify(draft)) fail('corrupt');
    }
}
