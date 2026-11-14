import { createHash } from 'node:crypto';
import { z } from 'zod';
import { StorageError, type Migration, type OwnedStorage } from '@xunjie/storage';
import { collectSources, validateSources, type SourceSpec, type OwnerSourceClosure } from '@xunjie/storage/source-closure';
import { canonicalDigest } from '@xunjie/storage/identity';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import { personalProjectCreateSchema, personalProjectSchema, type PersonalProject, type PersonalProjectCreate, type PersonalProjectsPort } from '@xunjie/contracts/student-learning';
import { activitySchema } from '@xunjie/contracts/learning-data';
import type { createLearningData } from './index.js';

export const personalProjectMigration: Migration = { version: 33, name: 'personal-learning-projects', sql: `
  CREATE TABLE personal_learning_projects(project_id uuid PRIMARY KEY,operation_id uuid UNIQUE NOT NULL,
    space_environment_id uuid NOT NULL,space_id uuid NOT NULL,principal_id uuid NOT NULL,
    activity_id uuid UNIQUE NOT NULL REFERENCES activities(id),body jsonb NOT NULL);
  CREATE INDEX personal_learning_projects_scope ON personal_learning_projects(space_environment_id,space_id,principal_id);
` };
type LearningOwner = Pick<ReturnType<typeof createLearningData>, 'create' | 'open' | 'receipt'>;
export interface PersonalProjectHost { authorize(identity: SpaceIdentity): Promise<unknown>; learning: LearningOwner; }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const subject = (identity: SpaceIdentity) => [identity.environmentId, identity.spaceId, identity.principalId, identity.kind];
const sameSubject = (a: SpaceIdentity, b: SpaceIdentity) => JSON.stringify(subject(a)) === JSON.stringify(subject(b));
/** Stable child identities survive process death and a lost upstream response. */
export function personalProjectOperationId(operationId: string, step: string) {
  const bytes = createHash('sha256').update(`personal-project:${operationId}:${step}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 64; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Owns project content; the learning owner alone creates the real workspace activity. */
export function createPersonalProjects(storage: OwnedStorage, host: PersonalProjectHost): PersonalProjectsPort {
  async function authorize(identity: SpaceIdentity) {
    if (identity.kind !== 'personal') throw new StorageError('forbidden');
    await host.authorize(identity);
  }
  async function check(identity: SpaceIdentity, value: unknown): Promise<PersonalProject> {
    const project = personalProjectSchema.parse(value);
    if (!sameSubject(identity, project.identity) || project.target.environmentId !== storage.owner.environmentId
      || project.target.serviceId !== storage.owner.serviceId) throw new StorageError('forbidden');
    const activity = await host.learning.open(identity, project.activityId);
    if (!sameSubject(activity.identity, identity) || activity.target.environmentId !== project.target.environmentId
      || activity.target.serviceId !== project.target.serviceId || activity.course) throw new StorageError('forbidden');
    return project;
  }
  async function read(identity: SpaceIdentity, projectId: string) {
    await authorize(identity); z.uuid().parse(projectId);
    const { rows: [row] } = await storage.read('SELECT body FROM personal_learning_projects WHERE project_id=$1', [projectId]);
    if (!row) throw new StorageError('missing');
    return check(identity, row.body);
  }
  async function receipt(identity: SpaceIdentity, operationId: string): Promise<PersonalProject | null> {
    await authorize(identity); z.uuid().parse(operationId);
    const { rows: [row] } = await storage.read('SELECT body FROM personal_learning_projects WHERE operation_id=$1', [operationId]);
    return row ? check(identity, row.body) : null;
  }
  async function list(identity: SpaceIdentity) {
    await authorize(identity);
    const { rows } = await storage.read(`SELECT body FROM personal_learning_projects
      WHERE space_environment_id=$1 AND space_id=$2 AND principal_id=$3 ORDER BY project_id`, subject(identity).slice(0, 3));
    return Promise.all(rows.map(row => check(identity, row.body)));
  }
  async function readForActivity(identity: SpaceIdentity, activityId: string): Promise<PersonalProject | null> {
    // A legitimate school/course workspace has no personal-project record; authorize it and return null.
    await host.authorize(identity); z.uuid().parse(activityId);
    const activity = await host.learning.open(identity, activityId);
    if (!sameSubject(activity.identity, identity) || activity.target.environmentId !== storage.owner.environmentId
      || activity.target.serviceId !== storage.owner.serviceId) throw new StorageError('forbidden');
    const { rows: [row] } = await storage.read('SELECT body FROM personal_learning_projects WHERE activity_id=$1', [activityId]);
    return row ? check(identity, row.body) : null;
  }
  async function create(identity: SpaceIdentity, value: PersonalProjectCreate): Promise<PersonalProject> {
    await authorize(identity);
    const input = personalProjectCreateSchema.parse(value);
    const requestId = `personal-project:${input.operationId}`;
    const fingerprint = hash({ subject: subject(identity), input });
    // Reserve the complete content before creating the activity: a crash cannot repurpose the operation.
    const reserved = await storage.request({ requestId: `${requestId}:reserve`, fingerprint }, async () => ({ input, identity }));
    const reservation = reserved.result as { input: unknown; identity: SpaceIdentity };
    const stable = personalProjectCreateSchema.parse(reservation.input);
    const existing = await receipt(identity, stable.operationId);
    if (existing) return existing;
    const activity = await host.learning.create(reservation.identity, { requestId: personalProjectOperationId(stable.operationId, 'activity'),
      goal: stable.content.goal, question: '', references: [] });
    if (!sameSubject(activity.identity, identity) || activity.target.environmentId !== storage.owner.environmentId
      || activity.target.serviceId !== storage.owner.serviceId || activity.course) throw new StorageError('forbidden');
    const result = await storage.request({ requestId, fingerprint }, async tx => {
      const project = personalProjectSchema.parse({ ...stable, projectId: personalProjectOperationId(stable.operationId, 'project'),
        workspaceSessionId: personalProjectOperationId(stable.operationId, 'session'), activityId: activity.activityId,
        identity, target: activity.target, createdAt: new Date().toISOString() });
      await tx.query(`INSERT INTO personal_learning_projects VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [project.projectId, project.operationId, ...subject(identity).slice(0, 3), project.activityId, JSON.stringify(project)]);
      return project;
    });
    return check(identity, result.result);
  }
  return { create, read, list, receipt, readForActivity, validate: () => validatePersonalProjects(storage) };
}

export const personalProjectSourceSpecs: readonly SourceSpec[] = [
  { table: 'personal_learning_projects', kind: 'personal_learning_projects', id: ['project_id'], version: ['operation_id'] },
];
const sourceOwner = 'xunjie.learning-data.personal-projects';
export function collectPersonalProjectSources(storage: OwnedStorage): Promise<OwnerSourceClosure> {
  return collectSources(storage, sourceOwner, personalProjectSourceSpecs);
}
export function validatePersonalProjectSources(storage: OwnedStorage, material: unknown): Promise<void> {
  return validateSources(storage, material, sourceOwner, personalProjectSourceSpecs);
}
/** Restore checks original owner facts only; no live member, session, model or remote authority is called. */
export async function validatePersonalProjects(storage: OwnedStorage): Promise<void> {
  const { rows } = await storage.read('SELECT * FROM personal_learning_projects');
  for (const row of rows) {
    try {
      const project = personalProjectSchema.parse(row.body);
      const input = personalProjectCreateSchema.parse({ operationId: project.operationId, sourceSessionId: project.sourceSessionId,
        inputId: project.inputId, ...(project.responseId ? { responseId: project.responseId } : {}), content: project.content });
      const fingerprint = hash({ subject: subject(project.identity), input });
      const committed = await storage.receipt('personal-project:' + project.operationId, fingerprint);
      const reservation = await storage.receipt('personal-project:' + project.operationId + ':reserve', fingerprint);
      const reserved = reservation?.result as { input?: unknown; identity?: SpaceIdentity } | undefined;
      if (project.projectId !== row.project_id || project.operationId !== row.operation_id || project.activityId !== row.activity_id
        || project.identity.environmentId !== row.space_environment_id || project.identity.spaceId !== row.space_id
        || project.identity.principalId !== row.principal_id || project.identity.kind !== 'personal'
        || project.target.environmentId !== storage.owner.environmentId || project.target.serviceId !== storage.owner.serviceId
        || project.projectId !== personalProjectOperationId(project.operationId, 'project')
        || project.workspaceSessionId !== personalProjectOperationId(project.operationId, 'session')
        || !committed || canonicalDigest(committed.result) !== canonicalDigest(project) || !reserved?.identity
        || !sameSubject(reserved.identity, project.identity) || canonicalDigest(reserved.input) !== canonicalDigest(input)) throw new StorageError('corrupt');
      const { rows: [parent] } = await storage.read('SELECT body FROM activities WHERE id=$1', [project.activityId]);
      const activity = activitySchema.parse(parent?.body);
      if (activity.activityId !== project.activityId || !sameSubject(activity.identity, project.identity) || activity.course
        || activity.goal !== project.content.goal || canonicalDigest(activity.target) !== canonicalDigest(project.target)) throw new StorageError('corrupt');
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof StorageError && error.code === 'identity-conflict') throw new StorageError('corrupt');
      throw error;
    }
  }
}
