import { createHash } from 'node:crypto';
import { z } from 'zod';
import { StorageError, type Migration, type OwnedStorage } from '@xunjie/storage';
import { activitySchema, type LearningActivity, type WorkFile } from '@xunjie/contracts/learning-data';
import { learningTargetSchema, type SpaceIdentity } from '@xunjie/contracts/spaces';
import { canonicalValue } from '@xunjie/contracts/execution';
import type { NativeSessionHostOptions } from './native-sessions.js';
import { validateNativeSessions } from './native-sessions.js';
import { createExecutions, validateExecutions } from './executions.js';
import { createWorks, validateWorks } from './works.js';
import { learningMigrations } from './index.js';
import { createExecutionRecordExport, executionExportMigration, validateExecutionRecordExport } from './execution-record-export.js';
import type { ExecutionRecordEvent } from '@xunjie/contracts/execution-records';

// These immutable migrations provide the command/session machinery without the learning-space,
// course, draft, conversation or Agent stores. `activities` is a private execution-context snapshot.
const executionSchemaVersions = new Set([1, 2, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 20, 22]);
export const executionOwnerMigrations: readonly Migration[] = [{ version: 1, name: 'independent-execution-owner', sql:
  learningMigrations.filter(migration => executionSchemaVersions.has(migration.version)).map(migration => migration.sql).join('\n')
  + '\nCREATE TABLE execution_activity_authorities(activity_id uuid PRIMARY KEY REFERENCES activities(id),target jsonb NOT NULL);' }, executionExportMigration,
  { version: 3, name: 'local-study-execution-authority', sql: `
    CREATE TABLE execution_activity_target_migrations(activity_id uuid PRIMARY KEY REFERENCES activities(id),
      source_activity jsonb NOT NULL,target jsonb NOT NULL);` }];
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonicalValue(value))).digest('hex');
const subject = (identity: SpaceIdentity) => [identity.kind, identity.environmentId, identity.spaceId, identity.principalId];
const activityScopeDigest = (activity: LearningActivity) => hash([activity.activityId, subject(activity.identity), activity.course]);
function validLocalMove(storage: OwnedStorage, source: LearningActivity, current: LearningActivity) {
  return activityScopeDigest(source) === activityScopeDigest(current) && source.identity.kind === 'school'
    && current.target.environmentId === storage.owner.environmentId && hash(source.target) !== hash(current.target);
}

async function authority(storage: OwnedStorage, activityId: string) {
  const { rows: [row] } = await storage.read('SELECT target FROM execution_activity_authorities WHERE activity_id=$1', [activityId]);
  if (!row) throw new StorageError('corrupt');
  return learningTargetSchema.parse(row.target);
}

export async function validateExecutionOwner(storage: OwnedStorage) {
  const { rows } = await storage.read('SELECT a.*,p.target AS authority_target FROM activities a LEFT JOIN execution_activity_authorities p ON p.activity_id=a.id');
  for (const row of rows) {
    const activity = activitySchema.parse(row.body), target = learningTargetSchema.parse(row.authority_target);
    if (activity.activityId !== row.id || activity.identity.environmentId !== row.space_environment_id
      || activity.identity.spaceId !== row.space_id || activity.identity.principalId !== row.principal_id
      || hash(activity.target) !== hash(target)) throw new StorageError('corrupt');
  }
  const { rows: moves } = await storage.read(`SELECT m.*,a.body FROM execution_activity_target_migrations m
    LEFT JOIN activities a ON a.id=m.activity_id`);
  for (const row of moves) {
    const source = activitySchema.parse(row.source_activity), current = activitySchema.parse(row.body);
    const target = learningTargetSchema.parse(row.target);
    if (source.activityId !== row.activity_id || !validLocalMove(storage, source, current)
      || hash(target) !== hash(current.target)) throw new StorageError('corrupt');
  }
  await validateWorks(storage);
  await validateExecutions(storage, { activityOwner: id => authority(storage, id) });
  await validateNativeSessions(storage);
  await validateExecutionRecordExport(storage);
}

/** Owns commands, processes, fixed inputs and results; activity authority remains at its data owner. */
export function createExecutionOwner(storage: OwnedStorage, options: {
  activity(identity: SpaceIdentity, activityId: string): Promise<LearningActivity>;
  /** Trusted local study provenance, never a caller-supplied replacement target. */
  migratedActivity?(identity: SpaceIdentity, activityId: string): Promise<LearningActivity | null>;
  sourceFile(identity: SpaceIdentity, activityId: string, contentId: string): Promise<Omit<WorkFile, 'name'>>;
  native?: NativeSessionHostOptions;
  installationId?: string;
  publishRecord?(identity: SpaceIdentity, activityId: string, event: ExecutionRecordEvent): Promise<void>;
}) {
  async function open(identity: SpaceIdentity, activityId: string) {
    const activity = activitySchema.parse(await options.activity(identity, z.uuid().parse(activityId)));
    if (hash(subject(activity.identity)) !== hash(subject(identity))) throw new StorageError('forbidden');
    const { rows: [old] } = await storage.read('SELECT body FROM activities WHERE id=$1', [activityId]);
    let source: LearningActivity | null = null;
    if (old) {
      const saved = activitySchema.parse(old.body);
      if (activityScopeDigest(saved) !== activityScopeDigest(activity)) throw new StorageError('identity-conflict');
      if (hash(saved.target) !== hash(activity.target)) {
        const original = await options.migratedActivity?.(identity, activityId);
        source = original ? activitySchema.parse(original) : null;
        if (!source || !validLocalMove(storage, source, activity) || hash(saved.target) !== hash(source.target))
          throw new StorageError('identity-conflict');
      }
    }
    await storage.request({ requestId: `execution-context:${activityId}:${hash(activity)}`, fingerprint: hash(activity) }, async tx => {
      const { rows: [existing] } = await tx.query('SELECT body FROM activities WHERE id=$1 FOR UPDATE', [activityId]);
      if (existing) {
        const saved = activitySchema.parse(existing.body);
        if (activityScopeDigest(saved) !== activityScopeDigest(activity)) throw new StorageError('identity-conflict');
        if (hash(saved.target) !== hash(activity.target)) {
          if (!source || !validLocalMove(storage, source, activity) || hash(saved.target) !== hash(source.target))
            throw new StorageError('identity-conflict');
          const previous = await tx.query('SELECT 1 FROM execution_activity_target_migrations WHERE activity_id=$1', [activityId]);
          if (previous.rows.length) throw new StorageError('identity-conflict');
          await tx.query('INSERT INTO execution_activity_target_migrations VALUES($1,$2,$3)', [activityId, source, activity.target]);
          const changed = await tx.query('UPDATE execution_activity_authorities SET target=$2 WHERE activity_id=$1 AND target=$3::jsonb',
            [activityId, activity.target, saved.target]);
          if (changed.rowCount !== 1) throw new StorageError('corrupt');
        }
      }
      await tx.query(`INSERT INTO activities VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET body=EXCLUDED.body`,
        [activityId, identity.environmentId, identity.spaceId, identity.principalId, activity]);
      await tx.query('INSERT INTO execution_activity_authorities VALUES($1,$2) ON CONFLICT DO NOTHING', [activityId, activity.target]);
      return null;
    });
    return activity;
  }
  const works = createWorks(storage, open);
  const executions = createExecutions(storage, { activity: open, works,
    ...(options.native ? { native: { ...options.native, activity: open, works,
      authorizeComponent: async (identity, activity, action) => {
        await open(identity, activity.activityId);
        // A school remains the source of the files. Only the immutable bytes needed by this
        // command are retained here; no workspace head or other school activities are copied.
        for (const file of action.execution.basis.works) {
          const original = await options.sourceFile(identity, activity.activityId, file.contentId);
          if (hash(original) !== hash(Object.fromEntries(Object.entries(file).filter(([key]) => key !== 'name'))))
            throw new StorageError('corrupt');
        }
      } } } : {}) });
  const publication = options.installationId && options.publishRecord ? createExecutionRecordExport(storage, {
    installationId: options.installationId, executions, publish: options.publishRecord }) : undefined;
  return { executions, open,
    async poll(isOpen: () => boolean) {
      await executions.agent.reconcileAuthorization(async (identity, activityId) => { await open(identity, activityId); }, isOpen);
      const { rows } = await storage.read(`SELECT session_ref,activity_id FROM native_sessions
        WHERE state NOT IN ('succeeded','failed','cancelled')`);
      for (const row of rows) {
        if (!isOpen()) return;
        const { rows: [context] } = await storage.read('SELECT body FROM activities WHERE id=$1', [row.activity_id]);
        try {
          const activity = activitySchema.parse(context?.body), current = await open(activity.identity, activity.activityId);
          if (current.status !== 'open') await executions.reclaim(String(row.session_ref));
        }
        catch (error) {
          if (!(error instanceof StorageError)) throw error;
          await executions.reclaim(String(row.session_ref));
        }
      }
      if (isOpen()) await publication?.poll(isOpen);
    },
    validate: () => validateExecutionOwner(storage),
  };
}
