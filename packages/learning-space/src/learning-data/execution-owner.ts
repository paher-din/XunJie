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
  + '\nCREATE TABLE execution_activity_authorities(activity_id uuid PRIMARY KEY REFERENCES activities(id),target jsonb NOT NULL);' }, executionExportMigration];
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonicalValue(value))).digest('hex');

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
  await validateWorks(storage);
  await validateExecutions(storage, { activityOwner: id => authority(storage, id) });
  await validateNativeSessions(storage);
  await validateExecutionRecordExport(storage);
}

/** Owns only commands, processes, fixed execution inputs and results. School activities stay at school. */
export function createExecutionOwner(storage: OwnedStorage, options: {
  activity(identity: SpaceIdentity, activityId: string): Promise<LearningActivity>;
  sourceFile(identity: SpaceIdentity, activityId: string, contentId: string): Promise<Omit<WorkFile, 'name'>>;
  native?: NativeSessionHostOptions;
  installationId?: string;
  publishRecord?(identity: SpaceIdentity, activityId: string, event: ExecutionRecordEvent): Promise<void>;
}) {
  async function open(identity: SpaceIdentity, activityId: string) {
    const activity = activitySchema.parse(await options.activity(identity, z.uuid().parse(activityId)));
    if (hash(activity.identity) !== hash(identity)) throw new StorageError('forbidden');
    const { rows: [old] } = await storage.read('SELECT body FROM activities WHERE id=$1', [activityId]);
    if (old) {
      const saved = activitySchema.parse(old.body);
      if (hash([saved.identity, saved.target, saved.course]) !== hash([activity.identity, activity.target, activity.course]))
        throw new StorageError('identity-conflict');
    }
    await storage.request({ requestId: `execution-context:${activityId}:${hash(activity)}`, fingerprint: hash(activity) }, async tx => {
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
