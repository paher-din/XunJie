import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { StorageError } from '@xunjie/storage';
import type { OwnedStorage, Migration } from '@xunjie/storage';
import { createActivitySchema, activitySchema } from '@xunjie/contracts/learning-data';
import type { CreateActivity, LearningActivity } from '@xunjie/contracts/learning-data';
import type { SpaceIdentity, SpaceAuthority } from '@xunjie/contracts/spaces';
import { createWorks, workMigration, validateWorks } from './works.js';

export const learningMigrations: readonly Migration[] = [{ version: 1, name: 'course-free-activities', sql: `
  CREATE TABLE activities (id uuid PRIMARY KEY,space_environment_id uuid NOT NULL,space_id uuid NOT NULL,
    principal_id uuid NOT NULL,body jsonb NOT NULL);
  CREATE INDEX activities_scope ON activities(space_environment_id,space_id,principal_id);
  CREATE TABLE activity_requests (request_id uuid PRIMARY KEY,space_environment_id uuid NOT NULL,
    space_id uuid NOT NULL,principal_id uuid NOT NULL);
` }, workMigration];
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scope = (identity: SpaceIdentity) => [identity.environmentId, identity.spaceId, identity.principalId];
const fail = (code: 'missing' | 'forbidden'): never => { throw new StorageError(code); };

export async function validateLearningData(storage: OwnedStorage) {
  await validateWorks(storage);
  const { rows } = await storage.read('SELECT id,body,space_environment_id,space_id,principal_id FROM activities');
  for (const row of rows) {
    const a = activitySchema.parse(row.body);
    if (a.activityId !== row.id || a.identity.environmentId !== row.space_environment_id || a.identity.spaceId !== row.space_id
      || a.identity.principalId !== row.principal_id || a.target.environmentId !== storage.owner.environmentId
      || a.target.serviceId !== storage.owner.serviceId) throw new StorageError('corrupt');
  }
}

/** Only this module writes activities. Authority supplies a narrow, current member binding. */
export function createLearningData(storage: OwnedStorage, authority: SpaceAuthority) {
  async function access(identity: SpaceIdentity) {
    const target = await authority.resolveBinding(identity);
    if (target.environmentId !== storage.owner.environmentId || target.serviceId !== storage.owner.serviceId || target.version !== 1) fail('forbidden');
    return target;
  }
  async function open(identity: SpaceIdentity, activityId: string): Promise<LearningActivity> {
    await access(identity); z.uuid().parse(activityId);
    const { rows: [row] } = await storage.read(`SELECT body FROM activities
      WHERE space_environment_id=$1 AND space_id=$2 AND principal_id=$3 AND id=$4`, [...scope(identity), activityId]);
    if (!row) return fail('missing');
    return activitySchema.parse(row.body);
  }
  async function list(identity: SpaceIdentity): Promise<LearningActivity[]> {
    await access(identity);
    const { rows } = await storage.read(`SELECT body FROM activities WHERE space_environment_id=$1 AND space_id=$2 AND principal_id=$3
      ORDER BY id`, scope(identity));
    return rows.map(row => activitySchema.parse(row.body));
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
  async function receipt(identity: SpaceIdentity, requestId: string): Promise<LearningActivity | null> {
    await access(identity); z.uuid().parse(requestId);
    const { rows } = await storage.read(`SELECT request_id FROM activity_requests
      WHERE request_id=$1 AND space_environment_id=$2 AND space_id=$3 AND principal_id=$4`, [requestId, ...scope(identity)]);
    if (!rows.length) return null;
    const result = await storage.receipt(requestId);
    return result ? activitySchema.parse(result.result) : null;
  }
  async function setStatus(identity: SpaceIdentity, value: { requestId: string; activityId: string; status: 'open' | 'closed' }) {
    await access(identity);
    const input = z.object({ requestId: z.uuid(), activityId: z.uuid(), status: z.enum(['open', 'closed']) }).strict().parse(value);
    const receipt = await storage.request({ requestId: input.requestId, fingerprint: fingerprint({ identity, input }) }, async tx => {
      const { rows: [row] } = await tx.query(`SELECT body FROM activities WHERE space_environment_id=$1
        AND space_id=$2 AND principal_id=$3 AND id=$4 FOR UPDATE`, [...scope(identity), input.activityId]);
      if (!row) return fail('missing');
      const activity = activitySchema.parse({ ...(row.body as LearningActivity), status: input.status });
      await tx.query('UPDATE activities SET body=$2 WHERE id=$1', [input.activityId, JSON.stringify(activity)]);
      await tx.query('INSERT INTO activity_requests VALUES ($1,$2,$3,$4)', [input.requestId, ...scope(identity)]);
      return activity;
    });
    return activitySchema.parse(receipt.result);
  }
  return { create, list, open, receipt, setStatus, works: createWorks(storage, open), validate: () => validateLearningData(storage) };
}
