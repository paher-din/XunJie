import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { StorageError } from '@xunjie/storage';
import type { OwnedStorage, Migration } from '@xunjie/storage';
import { createActivitySchema, activitySchema, courseActivityResultSchema } from '@xunjie/contracts/learning-data';
import type { CreateActivity, LearningActivity, CourseActivityResult } from '@xunjie/contracts/learning-data';
import { createCourseActivitySchema, courseActivityBindingSchema } from '@xunjie/contracts/courses';
import type { CourseBindingAuthority } from '@xunjie/contracts/courses';
import type { SpaceIdentity, SpaceAuthority } from '@xunjie/contracts/spaces';
import { createWorks, workMigration, validateWorks } from './works.js';

export const learningMigrations: readonly Migration[] = [{ version: 1, name: 'course-free-activities', sql: `
  CREATE TABLE activities (id uuid PRIMARY KEY,space_environment_id uuid NOT NULL,space_id uuid NOT NULL,
    principal_id uuid NOT NULL,body jsonb NOT NULL);
  CREATE INDEX activities_scope ON activities(space_environment_id,space_id,principal_id);
  CREATE TABLE activity_requests (request_id uuid PRIMARY KEY,space_environment_id uuid NOT NULL,
    space_id uuid NOT NULL,principal_id uuid NOT NULL);
` }, workMigration, { version: 3, name: 'course-activity-coordination', sql: `
  CREATE TABLE course_activity_requests (request_id uuid PRIMARY KEY,space_environment_id uuid NOT NULL,
    space_id uuid NOT NULL,principal_id uuid NOT NULL,release_id uuid NOT NULL,association_id uuid NOT NULL,
    activity_id uuid NOT NULL,input_digest text NOT NULL,state text NOT NULL CHECK(state IN ('pending','accepted','rejected')),
    binding jsonb,result jsonb,error text,updated_at timestamptz NOT NULL DEFAULT clock_timestamp());
  CREATE INDEX course_activity_requests_scope ON course_activity_requests(space_environment_id,space_id,principal_id);
` }];
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scope = (identity: SpaceIdentity) => [identity.environmentId, identity.spaceId, identity.principalId];
const fail = (code: 'missing' | 'forbidden' | 'identity-conflict'): never => { throw new StorageError(code); };
const definitive = (error: unknown) => error instanceof StorageError
  && ['forbidden', 'missing', 'corrupt', 'invalid'].includes(error.code);

function operationId(value: string) {
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 64; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function requestResult(row: Record<string, unknown>): CourseActivityResult {
  return courseActivityResultSchema.parse({ requestId: row.request_id, state: row.state,
    activity: row.state === 'accepted' ? row.result : null, error: row.error ?? null });
}

export async function validateLearningData(storage: OwnedStorage) {
  await validateWorks(storage);
  const { rows } = await storage.read('SELECT id,body,space_environment_id,space_id,principal_id FROM activities');
  for (const row of rows) {
    const a = activitySchema.parse(row.body);
    if (a.activityId !== row.id || a.identity.environmentId !== row.space_environment_id || a.identity.spaceId !== row.space_id
      || a.identity.principalId !== row.principal_id || a.target.environmentId !== storage.owner.environmentId
      || a.target.serviceId !== storage.owner.serviceId) throw new StorageError('corrupt');
  }
  const { rows: requests } = await storage.read(`SELECT request_id,space_environment_id,space_id,principal_id,release_id,
    association_id,activity_id,state,binding,result,error FROM course_activity_requests`);
  for (const row of requests) {
    const state = requestResult(row);
    if (row.binding !== null && row.binding !== undefined) {
      const binding = courseActivityBindingSchema.parse(row.binding);
      if (binding.releaseId !== row.release_id) throw new StorageError('corrupt');
    }
    if (state.state === 'accepted') {
      const activity = state.activity;
      if (!activity || activity.activityId !== row.activity_id || !activity.course
        || activity.course.releaseId !== row.release_id
        || activity.identity.environmentId !== row.space_environment_id || activity.identity.spaceId !== row.space_id
        || activity.identity.principalId !== row.principal_id) throw new StorageError('corrupt');
    }
    if (state.state === 'rejected' && !state.error) throw new StorageError('corrupt');
  }
}

/** Only this module writes activities. Authority supplies a narrow, current member binding. */
export function createLearningData(storage: OwnedStorage, authority: SpaceAuthority, courses?: CourseBindingAuthority) {
  async function access(identity: SpaceIdentity) {
    const target = await authority.resolveBinding(identity);
    if (target.environmentId !== storage.owner.environmentId || target.serviceId !== storage.owner.serviceId || target.version !== 1) fail('forbidden');
    return target;
  }
  async function courseAuthorize(identity: SpaceIdentity, activity: LearningActivity) {
    if (!activity.course) return;
    const courseAuthority = courses;
    if (!courseAuthority) return fail('forbidden');
    await courseAuthority.authorize(identity, activity.course);
  }
  async function open(identity: SpaceIdentity, activityId: string): Promise<LearningActivity> {
    await access(identity); z.uuid().parse(activityId);
    const { rows: [row] } = await storage.read(`SELECT body FROM activities
      WHERE space_environment_id=$1 AND space_id=$2 AND principal_id=$3 AND id=$4`, [...scope(identity), activityId]);
    if (!row) return fail('missing');
    const activity = activitySchema.parse(row.body);
    await courseAuthorize(identity, activity);
    return activity;
  }
  async function list(identity: SpaceIdentity): Promise<LearningActivity[]> {
    await access(identity);
    const { rows } = await storage.read(`SELECT body FROM activities WHERE space_environment_id=$1 AND space_id=$2 AND principal_id=$3
      ORDER BY id`, scope(identity));
    const visible: LearningActivity[] = [];
    for (const row of rows) {
      const activity = activitySchema.parse(row.body);
      if (!activity.course) { visible.push(activity); continue; }
      try { await courseAuthorize(identity, activity); visible.push(activity); }
      catch (error) {
        // Revoked eligibility hides the course projection. A lost or corrupt version still
        // appears in the owner's own list; opening it reports the missing/corrupt basis.
        if (!(error instanceof StorageError)) throw error;
        if (error.code === 'forbidden') continue;
        if (error.code === 'missing' || error.code === 'corrupt') { visible.push(activity); continue; }
        throw error;
      }
    }
    return visible;
  }
  async function create(identity: SpaceIdentity, value: CreateActivity): Promise<LearningActivity> {
    const target = await access(identity);
    const input = createActivitySchema.parse(value);
    const receipt = await storage.request({ requestId: input.requestId, fingerprint: fingerprint({ identity, target, input }) }, async tx => {
      const activity: LearningActivity = { activityId: randomUUID(), identity, target, goal: input.goal, question: input.question,
        references: input.references, status: 'open', createdAt: new Date().toISOString() };
      await tx.query('INSERT INTO activities VALUES ($1,$2,$3,$4,$5)', [activity.activityId, ...scope(identity), JSON.stringify(activity)]);
      await tx.query('INSERT INTO activity_requests VALUES ($1,$2,$3,$4)', [input.requestId, ...scope(identity)]);
      return activity;
    });
    return activitySchema.parse(receipt.result);
  }
  async function markRejected(requestId: string, inputDigest: string, error: unknown) {
    const code = error instanceof StorageError ? error.code : 'unavailable';
    await storage.request({ requestId: `${requestId}:reject:${code}`, fingerprint: inputDigest }, async tx => {
      const { rows: [row] } = await tx.query('SELECT * FROM course_activity_requests WHERE request_id=$1 FOR UPDATE', [requestId]);
      if (!row) return fail('missing');
      if (row.state === 'pending') {
        await tx.query(`UPDATE course_activity_requests SET state='rejected',error=$2,updated_at=clock_timestamp()
          WHERE request_id=$1`, [requestId, code]);
        return { requestId, state: 'rejected', activity: null, error: code };
      }
      return requestResult(row);
    }).catch(() => undefined);
  }
  /** Two-owner protocol: register -> prepare -> persist pending -> confirm -> visible commit. */
  async function createCourse(identity: SpaceIdentity, value: unknown): Promise<LearningActivity> {
    const target = await access(identity);
    const courseAuthority = courses;
    if (!courseAuthority) return fail('forbidden');
    const input = createCourseActivitySchema.parse(value);
    const inputDigest = fingerprint({ identity, target, releaseId: input.releaseId });
    const associationId = operationId(`course-association:${input.requestId}`);
    const activityId = operationId(`course-activity:${input.requestId}`);
    const registered = await storage.request({ requestId: `${input.requestId}:register`, fingerprint: inputDigest }, async tx => {
      await tx.query(`INSERT INTO course_activity_requests(request_id,space_environment_id,space_id,principal_id,release_id,
        association_id,activity_id,input_digest,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending')
        ON CONFLICT(request_id) DO NOTHING`, [input.requestId, ...scope(identity), input.releaseId, associationId, activityId, inputDigest]);
      const { rows: [row] } = await tx.query('SELECT * FROM course_activity_requests WHERE request_id=$1', [input.requestId]);
      if (!row || row.space_environment_id !== identity.environmentId || row.space_id !== identity.spaceId
        || row.principal_id !== identity.principalId || row.release_id !== input.releaseId
        || row.association_id !== associationId || row.activity_id !== activityId || row.input_digest !== inputDigest) return fail('identity-conflict');
      return requestResult(row);
    });
    const state = courseActivityResultSchema.parse(registered.result);
    if (state.state === 'rejected') throw new StorageError((state.error ?? 'missing') as 'missing');
    const { rows: [current] } = await storage.read(`SELECT state,error FROM course_activity_requests
      WHERE request_id=$1 AND space_environment_id=$2 AND space_id=$3 AND principal_id=$4`, [input.requestId, ...scope(identity)]);
    if (!current) return fail('missing');
    if (current.state === 'accepted') return open(identity, activityId);
    if (current.state === 'rejected') throw new StorageError((current.error ?? 'missing') as 'missing');
    let prepared;
    try {
      prepared = await courseAuthority.prepare({ associationId, requestId: input.requestId, identity, target, activityId,
        releaseId: input.releaseId, inputDigest });
    } catch (error) { if (definitive(error)) await markRejected(input.requestId, inputDigest, error); throw error; }
    if (!prepared.binding || prepared.state === 'rejected') {
      const error = new StorageError((prepared.error ?? 'missing') as 'missing');
      await markRejected(input.requestId, inputDigest, error); throw error;
    }
    await storage.request({ requestId: `${input.requestId}:bind`, fingerprint: fingerprint({ associationId, binding: prepared.binding }) }, async tx => {
      const { rows: [row] } = await tx.query('SELECT state FROM course_activity_requests WHERE request_id=$1 FOR UPDATE', [input.requestId]);
      if (!row) return fail('missing');
      if (row.state !== 'pending') return null;
      await tx.query(`UPDATE course_activity_requests SET binding=$2,updated_at=clock_timestamp() WHERE request_id=$1`,
        [input.requestId, JSON.stringify(prepared.binding)]);
      return null;
    });
    try { await courseAuthority.confirm({ associationId, requestId: input.requestId, inputDigest }); }
    catch (error) { if (definitive(error)) await markRejected(input.requestId, inputDigest, error); throw error; }
    const receipt = await storage.request({ requestId: input.requestId, fingerprint: inputDigest }, async tx => {
      const { rows: [row] } = await tx.query('SELECT * FROM course_activity_requests WHERE request_id=$1 FOR UPDATE', [input.requestId]);
      if (!row) return fail('missing');
      if (row.state === 'accepted') return activitySchema.parse(row.result);
      if (row.state === 'rejected') throw new StorageError((row.error ?? 'missing') as 'missing');
      const activity: LearningActivity = { activityId, identity, target, goal: prepared.binding!.taskTitle, question: '',
        references: [], status: 'open', createdAt: new Date().toISOString(), course: prepared.binding! };
      await tx.query('INSERT INTO activities VALUES ($1,$2,$3,$4,$5)', [activityId, ...scope(identity), JSON.stringify(activity)]);
      await tx.query('INSERT INTO activity_requests VALUES ($1,$2,$3,$4)', [input.requestId, ...scope(identity)]);
      await tx.query(`UPDATE course_activity_requests SET state='accepted',result=$2,error=NULL,updated_at=clock_timestamp()
        WHERE request_id=$1`, [input.requestId, JSON.stringify(activity)]);
      return activity;
    });
    // Confirm readability through the same public path before reporting success.
    return open(identity, activitySchema.parse(receipt.result).activityId);
  }
  async function courseResult(identity: SpaceIdentity, requestId: string): Promise<CourseActivityResult | null> {
    await access(identity); z.uuid().parse(requestId);
    const { rows: [row] } = await storage.read(`SELECT * FROM course_activity_requests
      WHERE request_id=$1 AND space_environment_id=$2 AND space_id=$3 AND principal_id=$4`, [requestId, ...scope(identity)]);
    if (!row) return null;
    const result = requestResult(row);
    if (result.state === 'accepted' && row.binding) {
      const courseAuthority = courses;
      if (!courseAuthority) return fail('forbidden');
      await courseAuthority.authorize(identity, courseActivityBindingSchema.parse(row.binding));
    }
    return result;
  }
  async function receipt(identity: SpaceIdentity, requestId: string): Promise<LearningActivity | null> {
    await access(identity); z.uuid().parse(requestId);
    const { rows } = await storage.read(`SELECT request_id FROM activity_requests
      WHERE request_id=$1 AND space_environment_id=$2 AND space_id=$3 AND principal_id=$4`, [requestId, ...scope(identity)]);
    if (!rows.length) return null;
    const result = await storage.receipt(requestId);
    if (!result) return null;
    const activity = activitySchema.parse(result.result);
    await courseAuthorize(identity, activity);
    return activity;
  }
  async function setStatus(identity: SpaceIdentity, value: { requestId: string; activityId: string; status: 'open' | 'closed' }) {
    await access(identity);
    const input = z.object({ requestId: z.uuid(), activityId: z.uuid(), status: z.enum(['open', 'closed']) }).strict().parse(value);
    const { rows: [preview] } = await storage.read(`SELECT body FROM activities WHERE space_environment_id=$1
      AND space_id=$2 AND principal_id=$3 AND id=$4`, [...scope(identity), input.activityId]);
    if (!preview) return fail('missing');
    const before = activitySchema.parse(preview.body);
    // External eligibility and resource reads stay outside the activity transaction.
    await courseAuthorize(identity, before);
    const receipt = await storage.request({ requestId: input.requestId, fingerprint: fingerprint({ identity, input }) }, async tx => {
      const { rows: [row] } = await tx.query(`SELECT body FROM activities WHERE space_environment_id=$1
        AND space_id=$2 AND principal_id=$3 AND id=$4 FOR UPDATE`, [...scope(identity), input.activityId]);
      if (!row) return fail('missing');
      const existing = activitySchema.parse(row.body);
      const activity = activitySchema.parse({ ...existing, status: input.status });
      await tx.query('UPDATE activities SET body=$2 WHERE id=$1', [input.activityId, JSON.stringify(activity)]);
      await tx.query('INSERT INTO activity_requests VALUES ($1,$2,$3,$4)', [input.requestId, ...scope(identity)]);
      return activity;
    });
    const activity = activitySchema.parse(receipt.result);
    // Cached receipts must not bypass the current course projection either.
    await courseAuthorize(identity, activity);
    return activity;
  }
  return { create, createCourse, courseResult, list, open, receipt, setStatus, works: createWorks(storage, open), validate: () => validateLearningData(storage) };
}
