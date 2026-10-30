import { createHash } from 'node:crypto';
import { z } from 'zod';
import { StorageError } from '@xunjie/storage';
import type { Migration, OwnedStorage, OwnedTransaction } from '@xunjie/storage';
import {
  courseAccessInputSchema, courseActivityBindingSchema, courseBindingStateSchema, courseImportSchema,
  courseMaterialContentSchema, courseRegistrationResultSchema, courseReleaseSchema, courseDigestSchema,
} from '@xunjie/contracts/courses';
import type {
  CourseAccessInput, CourseBindingPointer, CourseBindingState, CourseConfirmInput, CoursePrepareInput,
  CourseRegistrationResult, CourseRelease, CourseStarterWork, CourseCapability,
} from '@xunjie/contracts/courses';
import { spaceIdentitySchema, learningTargetSchema } from '@xunjie/contracts/spaces';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import { spaceMigrations } from '../spaces/index.js';

export const courseMigrations: readonly Migration[] = [{ version: 5, name: 'course-catalog-and-releases', sql: `
  CREATE TABLE courses (course_id uuid PRIMARY KEY,space_id uuid NOT NULL REFERENCES spaces(id),
    name text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
  CREATE TABLE course_tasks (task_id uuid PRIMARY KEY,course_id uuid NOT NULL REFERENCES courses(course_id),
    title text NOT NULL,summary text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
  CREATE TABLE course_releases (release_id uuid PRIMARY KEY,task_id uuid NOT NULL REFERENCES course_tasks(task_id),
    content_digest text NOT NULL,content jsonb NOT NULL,
    published_at timestamptz NOT NULL DEFAULT clock_timestamp());
  CREATE TABLE course_release_materials (release_id uuid NOT NULL REFERENCES course_releases(release_id),
    material_id uuid NOT NULL,access text NOT NULL CHECK(access IN ('student','private')),
    title text NOT NULL,media_type text NOT NULL,sha256 text NOT NULL,byte_length bigint NOT NULL,
    PRIMARY KEY(release_id,material_id));
` }, { version: 6, name: 'course-access-and-activity-bindings', sql: `
  CREATE TABLE course_access (course_id uuid NOT NULL REFERENCES courses(course_id),space_id uuid NOT NULL,
    principal_id uuid NOT NULL,active boolean NOT NULL,updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(course_id,principal_id));
  CREATE TABLE course_activity_associations (association_id uuid PRIMARY KEY,
    course_id uuid NOT NULL,task_id uuid NOT NULL,release_id uuid NOT NULL,space_id uuid NOT NULL,
    principal_id uuid NOT NULL,identity jsonb NOT NULL,activity_environment_id uuid NOT NULL,
    activity_service_id uuid NOT NULL,activity_id uuid NOT NULL,request_id uuid NOT NULL,
    input_digest text NOT NULL,state text NOT NULL CHECK(state IN ('prepared','accepted','rejected')),
    binding jsonb,error text,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp());
  CREATE TABLE course_registrations (request_id uuid PRIMARY KEY,
    release_id uuid NOT NULL REFERENCES course_releases(release_id),input_digest text NOT NULL,
    result jsonb NOT NULL,registered_at timestamptz NOT NULL DEFAULT clock_timestamp());
` }];

/** The school/course owner migration set: existing space versions plus the course domain. */
export const spaceCourseMigrations: readonly Migration[] = [...spaceMigrations, ...courseMigrations];

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid = z.uuid();
const hex = courseDigestSchema;
const fail = (code: 'forbidden' | 'invalid' | 'missing' | 'corrupt' | 'identity-conflict'): never => {
  throw new StorageError(code);
};

const storedMaterialSchema = z.object({
  materialId: uuid, title: z.string().min(1).max(300), mediaType: z.string().min(1).max(200),
  access: z.enum(['student', 'private']), sha256: hex,
  byteLength: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
const storedContentSchema = z.object({
  formatVersion: z.literal(1), courseId: uuid, taskId: uuid, releaseId: uuid,
  objectives: z.array(z.string().min(1).max(500)).min(1).max(20), requirements: z.string().min(1).max(20000),
  materials: z.array(storedMaterialSchema).max(100), starterWorks: z.array(z.object({
    workId: uuid, title: z.string().min(1).max(300), description: z.string().max(4000), materialId: uuid.nullable(),
  }).strict()).max(50), capabilities: z.array(z.object({
    kind: z.enum(['component', 'executor']), objectId: uuid, version: z.number().int().positive(),
  }).strict()).max(50),
}).strict();
type StoredContent = z.infer<typeof storedContentSchema>;

function contentDigest(content: StoredContent): string { return digest(content); }

function parseContent(value: unknown): StoredContent {
  try { return storedContentSchema.parse(value); } catch { return fail('corrupt'); }
}

function studentMaterials(content: StoredContent) {
  return content.materials.filter(item => item.access === 'student')
    .map(({ materialId, title, mediaType, byteLength, sha256 }) => ({ materialId, title, mediaType, byteLength, sha256 }));
}

function bindingOf(associationId: string, courseName: string, taskTitle: string, content: StoredContent) {
  return courseActivityBindingSchema.parse({ associationId, courseId: content.courseId, courseName,
    taskId: content.taskId, taskTitle, releaseId: content.releaseId, contentDigest: contentDigest(content),
    objectives: content.objectives, requirements: content.requirements, materials: studentMaterials(content),
    starterWorks: content.starterWorks, capabilities: content.capabilities });
}

const bindingRowSchema = z.object({
  association_id: uuid, course_id: uuid, task_id: uuid, release_id: uuid, space_id: uuid, principal_id: uuid,
  identity: z.unknown(), activity_environment_id: uuid, activity_service_id: uuid, activity_id: uuid,
  request_id: uuid, input_digest: z.string(), state: z.enum(['prepared', 'accepted', 'rejected']),
  binding: z.unknown(), error: z.string().nullable(),
});

function associationState(row: Record<string, unknown>): CourseBindingState {
  const parsed = bindingRowSchema.parse(row);
  return courseBindingStateSchema.parse({ associationId: parsed.association_id, state: parsed.state,
    binding: parsed.binding ?? null, error: parsed.error });
}

function decodeBase64(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return fail('invalid');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) return fail('invalid');
  return bytes;
}

function validateImport(value: unknown) {
  let input;
  try { input = courseImportSchema.parse(value); } catch { return fail('invalid'); }
  const materialIds = new Set<string>(), paths = new Set<string>(), workIds = new Set<string>();
  for (const material of input.release.materials) {
    if (materialIds.has(material.materialId) || paths.has(material.path)) fail('invalid');
    materialIds.add(material.materialId); paths.add(material.path);
  }
  for (const work of input.release.starterWorks) {
    if (workIds.has(work.workId)) fail('invalid');
    workIds.add(work.workId);
  }
  const studentIds = new Set(input.release.materials.filter(item => item.access === 'student').map(item => item.materialId));
  if (input.release.starterWorks.some(work => work.materialId !== null && !studentIds.has(work.materialId))) fail('invalid');
  const uploaded = new Map<string, Buffer>();
  for (const resource of input.resources) {
    if (uploaded.has(resource.path)) fail('invalid');
    uploaded.set(resource.path, decodeBase64(resource.contentBase64));
  }
  if (uploaded.size !== input.release.materials.length) fail('invalid');
  const materials: StoredContent['materials'] = input.release.materials.map(material => {
    const bytes = uploaded.get(material.path);
    if (!bytes || bytes.byteLength !== material.byteLength
      || createHash('sha256').update(bytes).digest('hex') !== material.sha256) fail('invalid');
    return { materialId: material.materialId, title: material.title, mediaType: material.mediaType,
      access: material.access, sha256: material.sha256, byteLength: material.byteLength };
  });
  if (new Set(materials.map(item => item.materialId)).size !== materials.length) fail('invalid');
  const content: StoredContent = { formatVersion: 1, courseId: input.course.courseId, taskId: input.task.taskId,
    releaseId: input.release.releaseId, objectives: input.release.objectives, requirements: input.release.requirements,
    materials, starterWorks: input.release.starterWorks as CourseStarterWork[], capabilities: input.release.capabilities as CourseCapability[] };
  storedContentSchema.parse(content);
  return { input, content, materials, resources: uploaded };
}

/** Only this module writes course facts; learning data reaches it through the narrow authority interface. */
export function createCourses(storage: OwnedStorage, spaces: { authorize(identity: SpaceIdentity): Promise<void>;
  schoolSpace(): Promise<string> }) {
  async function schoolSpace(): Promise<string> { return spaces.schoolSpace(); }
  async function accessActive(identity: SpaceIdentity, courseId: string): Promise<boolean> {
    const { rows } = await storage.read('SELECT 1 FROM course_access WHERE course_id=$1 AND space_id=$2 AND principal_id=$3 AND active',
      [courseId, identity.spaceId, identity.principalId]);
    return rows.length > 0;
  }
  async function releaseRow(releaseId: string) {
    const { rows: [row] } = await storage.read(`SELECT r.content_digest,r.content,r.published_at,t.task_id,t.title AS task_title,
      c.course_id,c.name AS course_name,c.space_id FROM course_releases r JOIN course_tasks t ON t.task_id=r.task_id
      JOIN courses c ON c.course_id=t.course_id WHERE r.release_id=$1`, [releaseId]);
    return row as { content_digest: string; content: unknown; published_at: Date; task_id: string; task_title: string;
      course_id: string; course_name: string; space_id: string } | undefined;
  }
  async function materialRows(releaseId: string) {
    const { rows } = await storage.read(`SELECT material_id,access,title,media_type,sha256,byte_length
      FROM course_release_materials WHERE release_id=$1 ORDER BY material_id`, [releaseId]);
    return rows;
  }
  async function resourceStates(ids: string[], query: Pick<OwnedTransaction, 'query'> | null = null) {
    if (!ids.length) return new Map<string, string>();
    const run = query ? query.query.bind(query) : storage.read.bind(storage);
    const { rows } = await run('SELECT resource_id,state FROM _storage_resources WHERE resource_id = ANY($1::uuid[])', [ids]);
    return new Map(rows.map(row => [row.resource_id as string, row.state as string]));
  }
  function absentState(states: Map<string, string>, ids: string[]): 'missing' | 'corrupt' | 'busy' | null {
    for (const id of ids) {
      const state = states.get(id);
      if (!state || state === 'deleted') return 'missing';
      if (state === 'failed') return 'corrupt';
      if (state !== 'ready') return 'busy';
    }
    return null;
  }
  async function ensureStudentResources(content: StoredContent) {
    for (const material of studentMaterials(content)) {
      try { await storage.readResource(material.materialId); }
      catch (error) {
        if (!(error instanceof StorageError)) throw error;
        if (['missing', 'resource-gone'].includes(error.code)) return fail('missing');
        if (error.code === 'corrupt') return fail('corrupt');
        throw error;
      }
    }
  }
  async function authorizedRelease(identity: SpaceIdentity, releaseId: string) {
    await spaces.authorize(identity);
    const row = await releaseRow(releaseId);
    if (!row || row.space_id !== identity.spaceId) return fail('missing');
    if (!await accessActive(identity, row.course_id)) return fail('forbidden');
    const content = parseContent(row.content);
    if (content.releaseId !== releaseId || content.courseId !== row.course_id || content.taskId !== row.task_id
      || contentDigest(content) !== row.content_digest) fail('corrupt');
    return { row, content };
  }

  async function registerRelease(value: unknown): Promise<CourseRegistrationResult> {
    const { input, content, materials, resources } = validateImport(value);
    const spaceId = await schoolSpace();
    const contentHash = contentDigest(content);
    for (const material of materials) {
      const reference = await storage.stageResource({ uploadId: material.materialId,
        scope: `course/${content.courseId}/${content.releaseId}`, bytes: resources.get(input.release.materials
          .find(item => item.materialId === material.materialId)!.path)!, mediaType: material.mediaType, contentVersion: 1 });
      if (reference.resourceId !== material.materialId || reference.sha256 !== material.sha256
        || reference.byteLength !== material.byteLength || reference.mediaType !== material.mediaType) fail('invalid');
    }
    const fingerprint = digest({ course: input.course, task: input.task,
      release: { releaseId: input.release.releaseId, contentHash, materials: materials.map(item => ({ materialId: item.materialId,
        access: item.access, sha256: item.sha256, byteLength: item.byteLength, mediaType: item.mediaType })) } });
    const receipt = await storage.request({ requestId: input.requestId, fingerprint }, async tx => {
      const { rows: [existingCourse] } = await tx.query('SELECT space_id,name FROM courses WHERE course_id=$1', [content.courseId]);
      let publishedAt: Date;
      const { rows: [existingTask] } = await tx.query('SELECT course_id,title,summary FROM course_tasks WHERE task_id=$1', [content.taskId]);
      const { rows: [existingRelease] } = await tx.query(`SELECT task_id,content_digest,published_at FROM course_releases
        WHERE release_id=$1 FOR UPDATE`, [content.releaseId]);
      if (existingCourse && (existingCourse.space_id !== spaceId || existingCourse.name !== input.course.name)) fail('identity-conflict');
      if (existingTask && (existingTask.course_id !== content.courseId || existingTask.title !== input.task.title
        || existingTask.summary !== input.task.summary)) fail('identity-conflict');
      if (existingRelease) {
        if (existingRelease.task_id !== content.taskId || existingRelease.content_digest !== contentHash) fail('identity-conflict');
        publishedAt = existingRelease.published_at as Date;
      } else {
        if (!existingCourse) await tx.query('INSERT INTO courses VALUES($1,$2,$3)', [content.courseId, spaceId, input.course.name]);
        if (!existingTask) await tx.query('INSERT INTO course_tasks VALUES($1,$2,$3,$4)', [content.taskId, content.courseId,
          input.task.title, input.task.summary]);
        await tx.query('INSERT INTO course_releases(release_id,task_id,content_digest,content) VALUES($1,$2,$3,$4)',
          [content.releaseId, content.taskId, contentHash, JSON.stringify(content)]);
        for (const material of materials) {
          await tx.query(`INSERT INTO course_release_materials(release_id,material_id,access,title,media_type,sha256,byte_length)
            VALUES($1,$2,$3,$4,$5,$6,$7)`, [content.releaseId, material.materialId, material.access, material.title,
            material.mediaType, material.sha256, material.byteLength]);
          await tx.reference(`${content.releaseId}:${material.materialId}`, material.materialId);
        }
        const { rows: [stamp] } = await tx.query('SELECT published_at FROM course_releases WHERE release_id=$1', [content.releaseId]);
        publishedAt = stamp!.published_at as Date;
      }
      const result = courseRegistrationResultSchema.parse({ kind: 'course-release', requestId: input.requestId,
        courseId: content.courseId, taskId: content.taskId, releaseId: content.releaseId, contentDigest: contentHash,
        publishedAt: publishedAt.toISOString(), materials: materials.map(item => ({ ...item })) });
      await tx.query(`INSERT INTO course_registrations(request_id,release_id,input_digest,result) VALUES($1,$2,$3,$4)
        ON CONFLICT(request_id) DO NOTHING`, [input.requestId, content.releaseId, contentHash, JSON.stringify(result)]);
      return result;
    });
    return courseRegistrationResultSchema.parse(receipt.result);
  }

  async function registrationResult(requestId: string): Promise<CourseRegistrationResult | null> {
    uuid.parse(requestId);
    const { rows: [row] } = await storage.read('SELECT result FROM course_registrations WHERE request_id=$1', [requestId]);
    return row ? courseRegistrationResultSchema.parse(row.result) : null;
  }

  async function listCourses(identity: SpaceIdentity) {
    await spaces.authorize(identity);
    const { rows } = await storage.read(`SELECT c.course_id,c.name,t.task_id,t.title,t.summary,
      r.release_id,r.content_digest,r.content,r.published_at FROM course_access a
      JOIN courses c ON c.course_id=a.course_id AND c.space_id=a.space_id
      JOIN course_tasks t ON t.course_id=c.course_id
      JOIN course_releases r ON r.task_id=t.task_id
      WHERE a.space_id=$1 AND a.principal_id=$2 AND a.active
      ORDER BY c.name,t.title,r.published_at DESC,r.release_id`, [identity.spaceId, identity.principalId]);
    const courses = new Map<string, { courseId: string; name: string; tasks: Map<string, { taskId: string; title: string;
      summary: string; releases: unknown[] }> }>();
    for (const row of rows) {
      const content = parseContent(row.content);
      let course = courses.get(row.course_id as string);
      if (!course) { course = { courseId: row.course_id as string, name: row.name as string, tasks: new Map() }; courses.set(course.courseId, course); }
      let task = course.tasks.get(row.task_id as string);
      if (!task) { task = { taskId: row.task_id as string, title: row.title as string, summary: row.summary as string, releases: [] }; course.tasks.set(task.taskId, task); }
      task.releases.push({ releaseId: row.release_id, contentDigest: row.content_digest, objectives: content.objectives,
        publishedAt: (row.published_at as Date).toISOString() });
    }
    return { courses: [...courses.values()].map(course => ({ courseId: course.courseId, name: course.name,
      tasks: [...course.tasks.values()] })) };
  }

  async function readRelease(identity: SpaceIdentity, releaseId: string): Promise<CourseRelease> {
    uuid.parse(releaseId);
    const { row, content } = await authorizedRelease(identity, releaseId);
    return courseReleaseSchema.parse({ formatVersion: 1, courseId: content.courseId, taskId: content.taskId,
      releaseId: content.releaseId, contentDigest: row.content_digest, objectives: content.objectives,
      requirements: content.requirements, materials: studentMaterials(content), starterWorks: content.starterWorks,
      capabilities: content.capabilities, publishedAt: row.published_at.toISOString(), courseName: row.course_name,
      taskTitle: row.task_title });
  }

  async function readMaterial(identity: SpaceIdentity, releaseId: string, materialId: string) {
    uuid.parse(releaseId); uuid.parse(materialId);
    const { row } = await authorizedRelease(identity, releaseId);
    const { rows: [material] } = await storage.read(`SELECT access,title,media_type,sha256,byte_length
      FROM course_release_materials WHERE release_id=$1 AND material_id=$2`, [releaseId, materialId]);
    // Private material identity is indistinguishable from a missing one.
    if (!material || material.access !== 'student') return fail('missing');
    let bytes: Uint8Array;
    try { bytes = await storage.readResource(materialId); } catch (error) {
      if (error instanceof StorageError && ['resource-gone', 'missing'].includes(error.code)) fail('missing');
      throw error;
    }
    if (bytes.byteLength !== Number(material.byte_length) || createHash('sha256').update(bytes).digest('hex') !== material.sha256) fail('corrupt');
    return courseMaterialContentSchema.parse({ materialId, title: material.title, mediaType: material.media_type,
      byteLength: Number(material.byte_length), sha256: material.sha256, contentBase64: Buffer.from(bytes).toString('base64') });
  }

  async function setAccess(value: CourseAccessInput) {
    const input = courseAccessInputSchema.parse(value);
    const receipt = await storage.request({ requestId: input.requestId, fingerprint: digest(input) }, async tx => {
      const { rows: [course] } = await tx.query('SELECT space_id FROM courses WHERE course_id=$1', [input.courseId]);
      if (!course) return fail('missing');
      const { rows: [member] } = await tx.query(`SELECT p.space_id FROM principals p JOIN memberships m
        ON m.space_id=p.space_id AND m.principal_id=p.id WHERE p.id=$1 AND m.active`, [input.principalId]);
      if (!member || member.space_id !== course.space_id) return fail('missing');
      await tx.query(`INSERT INTO course_access(course_id,space_id,principal_id,active,updated_at)
        VALUES($1,$2,$3,$4,clock_timestamp()) ON CONFLICT(course_id,principal_id)
        DO UPDATE SET active=EXCLUDED.active,updated_at=clock_timestamp()`,
        [input.courseId, course.space_id, input.principalId, input.active]);
      return { courseId: input.courseId, principalId: input.principalId, active: input.active };
    });
    return receipt.result as { courseId: string; principalId: string; active: boolean };
  }

  async function prepare(value: CoursePrepareInput): Promise<CourseBindingState> {
    const input = z.object({ associationId: uuid, requestId: uuid, identity: spaceIdentitySchema, target: learningTargetSchema,
      activityId: uuid, releaseId: uuid, inputDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(value);
    const identity = input.identity;
    const target = input.target;
    await spaces.authorize(identity);
    const { row, content } = await authorizedRelease(identity, input.releaseId);
    await ensureStudentResources(content);
    const binding = bindingOf(input.associationId, row.course_name, row.task_title, content);
    const receipt = await storage.request({ requestId: `course-prepare:${input.associationId}`,
      fingerprint: digest({ ...input, identity, target }) }, async tx => {
      const { rows: [existing] } = await tx.query('SELECT * FROM course_activity_associations WHERE association_id=$1', [input.associationId]);
      if (existing) {
        const parsed = bindingRowSchema.parse(existing);
        if (parsed.request_id !== input.requestId || parsed.space_id !== identity.spaceId || parsed.principal_id !== identity.principalId
          || parsed.release_id !== input.releaseId || parsed.activity_id !== input.activityId || parsed.input_digest !== input.inputDigest
          || parsed.activity_environment_id !== target.environmentId || parsed.activity_service_id !== target.serviceId)
          fail('identity-conflict');
        return associationState(existing);
      }
      await tx.query(`INSERT INTO course_activity_associations(association_id,course_id,task_id,release_id,space_id,
        principal_id,identity,activity_environment_id,activity_service_id,activity_id,request_id,input_digest,state,binding)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'prepared',$13)`,
        [input.associationId, content.courseId, content.taskId, content.releaseId, identity.spaceId, identity.principalId,
        JSON.stringify(identity), target.environmentId, target.serviceId, input.activityId, input.requestId, input.inputDigest,
        JSON.stringify(binding)]);
      return { associationId: input.associationId, state: 'prepared', binding, error: null };
    });
    return courseBindingStateSchema.parse(receipt.result);
  }

  async function confirm(value: CourseConfirmInput): Promise<CourseBindingState> {
    const input = z.object({ associationId: uuid, requestId: uuid, inputDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(value);
    const { rows: [stored] } = await storage.read('SELECT binding FROM course_activity_associations WHERE association_id=$1',
      [input.associationId]);
    if (stored?.binding) {
      const binding = courseActivityBindingSchema.parse(stored.binding);
      for (const material of binding.materials) {
        try { await storage.readResource(material.materialId); }
        catch (error) {
          if (error instanceof StorageError && ['missing', 'resource-gone'].includes(error.code)) return fail('missing');
          if (error instanceof StorageError && error.code === 'corrupt') return fail('corrupt');
          throw error;
        }
      }
    }
    const receipt = await storage.request({ requestId: `course-confirm:${input.associationId}`, fingerprint: digest(input) },
      async tx => {
        const { rows: [row] } = await tx.query('SELECT * FROM course_activity_associations WHERE association_id=$1 FOR UPDATE',
          [input.associationId]);
        if (!row) return fail('missing');
        const parsed = bindingRowSchema.parse(row);
        if (parsed.request_id !== input.requestId || parsed.input_digest !== input.inputDigest) return fail('identity-conflict');
        if (parsed.state !== 'prepared') return associationState(row);
        const identity = spaceIdentitySchema.parse(parsed.identity);
        const binding = courseActivityBindingSchema.parse(parsed.binding);
        async function reject(code: string) {
          await tx.query(`UPDATE course_activity_associations SET state='rejected',error=$2,updated_at=clock_timestamp()
            WHERE association_id=$1`, [input.associationId, code]);
          return { associationId: input.associationId, state: 'rejected', binding, error: code };
        }
        const { rows: [member] } = await tx.query(`SELECT 1 FROM memberships m JOIN spaces s ON s.id=m.space_id
          WHERE m.space_id=$1 AND m.principal_id=$2 AND m.active AND s.kind=$3`, [identity.spaceId, identity.principalId, identity.kind]);
        if (!member) return reject('forbidden');
        const { rows: [access] } = await tx.query(`SELECT 1 FROM course_access WHERE course_id=$1 AND space_id=$2
          AND principal_id=$3 AND active`, [parsed.course_id, identity.spaceId, identity.principalId]);
        if (!access) return reject('forbidden');
        const { rows: [release] } = await tx.query('SELECT content_digest FROM course_releases WHERE release_id=$1', [parsed.release_id]);
        if (!release) return reject('missing');
        if (release.content_digest !== binding.contentDigest) return reject('corrupt');
        const ids = binding.materials.map(item => item.materialId);
        const states = await resourceStates(ids, tx);
        const absent = absentState(states, ids);
        if (absent === 'busy') throw new StorageError('resource-busy');
        if (absent) return reject(absent);
        await tx.query(`UPDATE course_activity_associations SET state='accepted',error=NULL,updated_at=clock_timestamp()
          WHERE association_id=$1`, [input.associationId]);
        return { associationId: input.associationId, state: 'accepted', binding, error: null };
      });
    const state = courseBindingStateSchema.parse(receipt.result);
    if (state.state === 'rejected' && state.error) throw new StorageError(state.error as 'forbidden' | 'missing' | 'corrupt');
    return state;
  }

  async function bindingResult(associationId: string): Promise<CourseBindingState | null> {
    uuid.parse(associationId);
    const { rows: [row] } = await storage.read('SELECT * FROM course_activity_associations WHERE association_id=$1', [associationId]);
    return row ? associationState(row) : null;
  }

  async function authorize(identity: SpaceIdentity, pointer: CourseBindingPointer): Promise<void> {
    uuid.parse(pointer.associationId); uuid.parse(pointer.releaseId); hex.parse(pointer.contentDigest);
    const { row, content } = await authorizedRelease(identity, pointer.releaseId);
    if (row.content_digest !== pointer.contentDigest) return fail('corrupt');
    const { rows: [association] } = await storage.read(`SELECT state FROM course_activity_associations
      WHERE association_id=$1 AND space_id=$2 AND principal_id=$3 AND release_id=$4`,
      [pointer.associationId, identity.spaceId, identity.principalId, pointer.releaseId]);
    if (!association || association.state !== 'accepted') return fail('missing');
    await ensureStudentResources(content);
  }

  async function validate() {
    const { rows: courses } = await storage.read('SELECT course_id,space_id,name FROM courses');
    for (const course of courses) {
      const { rows: [space] } = await storage.read('SELECT 1 FROM spaces WHERE id=$1', [course.space_id]);
      if (!space) fail('corrupt');
    }
    const { rows: tasks } = await storage.read('SELECT task_id,course_id FROM course_tasks');
    for (const task of tasks) {
      if (!courses.some(course => course.course_id === task.course_id)) fail('corrupt');
    }
    const { rows: releases } = await storage.read('SELECT release_id,task_id,content_digest,content FROM course_releases');
    for (const release of releases) {
      const content = parseContent(release.content);
      if (content.releaseId !== release.release_id || content.taskId !== release.task_id
        || contentDigest(content) !== release.content_digest) fail('corrupt');
      const rows = await materialRows(release.release_id as string);
      if (rows.length !== content.materials.length) fail('corrupt');
      for (const material of content.materials) {
        const stored = rows.find(row => row.material_id === material.materialId);
        if (!stored || stored.access !== material.access || stored.title !== material.title || stored.media_type !== material.mediaType
          || stored.sha256 !== material.sha256 || Number(stored.byte_length) !== material.byteLength) fail('corrupt');
        const { rows: links } = await storage.read('SELECT resource_id FROM _storage_references WHERE reference_id=$1',
          [`${release.release_id}:${material.materialId}`]);
        if (!links.length || links[0]!.resource_id !== material.materialId) fail('corrupt');
      }
    }
    const { rows: access } = await storage.read('SELECT course_id,space_id,principal_id,active FROM course_access');
    for (const row of access) {
      const course = courses.find(item => item.course_id === row.course_id);
      if (!course || course.space_id !== row.space_id || typeof row.active !== 'boolean') fail('corrupt');
      const { rows: [member] } = await storage.read('SELECT 1 FROM memberships WHERE space_id=$1 AND principal_id=$2',
        [row.space_id, row.principal_id]);
      if (!member) fail('corrupt');
    }
    const { rows: associations } = await storage.read('SELECT * FROM course_activity_associations');
    for (const row of associations) {
      const parsed = bindingRowSchema.parse(row);
      const release = releases.find(item => item.release_id === parsed.release_id);
      if (!release || release.task_id !== parsed.task_id) return fail('corrupt');
      if (parsed.state === 'accepted' || parsed.state === 'prepared') {
        const binding = courseActivityBindingSchema.parse(parsed.binding);
        if (binding.releaseId !== parsed.release_id || binding.contentDigest !== release.content_digest) fail('corrupt');
      }
      if (parsed.state === 'rejected' && !parsed.error) fail('corrupt');
    }
    const { rows: registrations } = await storage.read('SELECT request_id,release_id,input_digest,result FROM course_registrations');
    for (const row of registrations) {
      const result = courseRegistrationResultSchema.parse(row.result);
      if (result.requestId !== row.request_id || result.releaseId !== row.release_id || result.contentDigest !== row.input_digest
        || !releases.some(release => release.release_id === row.release_id)) return fail('corrupt');
    }
  }

  return { registerRelease, registrationResult, listCourses, readRelease, readMaterial, setAccess,
    prepare, confirm, bindingResult, authorize, validate, migrations: spaceCourseMigrations };
}
