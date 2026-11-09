import { createHash } from 'node:crypto';
import type { Migration, OwnedStorage } from '@xunjie/storage';
import { StorageError } from '@xunjie/storage';
import { activitySchema } from '@xunjie/contracts/learning-data';
import { executionAcceptanceSchema, executionQuerySchema, canonicalValue } from '@xunjie/contracts/execution';
import { executionRecordEventSchema, executionRecordSessionIdentitySchema, type ExecutionRecordEvent } from '@xunjie/contracts/execution-records';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import type { createExecutions } from './executions.js';

export const executionExportMigration: Migration = { version: 2, name: 'execution-record-publication', sql: `
  CREATE TABLE execution_record_exports(request_id uuid PRIMARY KEY,command jsonb NOT NULL,
    command_sent boolean NOT NULL DEFAULT false,status_digest text,result_digest text);
` };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonicalValue(value))).digest('hex');

export async function validateExecutionRecordExport(storage: OwnedStorage) {
  const { rows } = await storage.read('SELECT * FROM execution_record_exports');
  for (const row of rows) {
    const parsed = executionRecordEventSchema.safeParse(row.command);
    if (!parsed.success || parsed.data.kind !== 'command') throw new StorageError('corrupt');
    const command = parsed.data;
    const { rows: original } = await storage.read(`SELECT input_digest,action_text,execution_ref AS ref FROM execution_commands WHERE request_id=$1
      UNION ALL SELECT input_digest,action_text,session_ref AS ref FROM native_sessions WHERE request_id=$1`, [row.request_id]);
    if (command.requestId !== row.request_id || digest(command.sourceOwner) !== digest(storage.owner) || original.length !== 1
      || command.actionText !== original[0]!.action_text || command.inputDigest !== original[0]!.input_digest
      || command.executionRef !== original[0]!.ref || createHash('sha256').update(command.actionText).digest('hex') !== command.inputDigest
      || [row.status_digest, row.result_digest].some(value => value !== null && !/^[a-f0-9]{64}$/.test(String(value))))
      throw new StorageError('corrupt');
  }
}

/** Uploads original execution facts. A failed upload is retried from local storage, never rerun. */
export function createExecutionRecordExport(storage: OwnedStorage, options: {
  installationId: string;
  executions: ReturnType<typeof createExecutions>;
  publish(identity: SpaceIdentity, activityId: string, event: ExecutionRecordEvent): Promise<void>;
}) {
  async function remember(requestId: string, column: 'command_sent' | 'status_digest' | 'result_digest', value: boolean | string) {
    await storage.request({ requestId: `execution-export:${requestId}:${column}:${value}`, fingerprint: digest(value) }, async tx => {
      await tx.query(`UPDATE execution_record_exports SET ${column}=$2 WHERE request_id=$1`, [requestId, value]);
      return null;
    });
  }
  async function poll(isOpen: () => boolean) {
    const { rows } = await storage.read(`SELECT request_id,activity_id,created_at,'browser' AS kind FROM execution_commands
      UNION ALL SELECT request_id,activity_id,created_at,'native' AS kind FROM native_sessions ORDER BY created_at,request_id`);
    for (const row of rows) {
      if (!isOpen()) return;
      const requestId = String(row.request_id), activityId = String(row.activity_id);
      try {
        const { rows: [context] } = await storage.read('SELECT body FROM activities WHERE id=$1', [activityId]);
        const activity = activitySchema.parse(context?.body);
        const current = await options.executions.read(activity.identity, activityId, requestId);
        if (!current) throw new StorageError('corrupt');
        const { rows: [saved] } = await storage.read('SELECT * FROM execution_record_exports WHERE request_id=$1', [requestId]);
        let command: Extract<ExecutionRecordEvent, { kind: 'command' }>;
        if (saved) command = executionRecordEventSchema.parse(saved.command) as typeof command;
        else {
          const table = row.kind === 'native' ? 'native_sessions' : 'execution_commands';
          const { rows: [original] } = await storage.read(`SELECT * FROM ${table} WHERE request_id=$1`, [requestId]);
          if (!original?.action_text) throw new StorageError('corrupt');
          const action = JSON.parse(String(original.action_text));
          const initial = executionQuerySchema.parse({ ...current, state: 'queued', statusKnowledge: 'confirmed',
            stopRequested: false, confirmedSeq: row.kind === 'native' ? 1 : executionAcceptanceSchema.parse(original.acceptance).execution!.acceptedSeq,
            reason: null, output: null, ...(current.session ? { session: { ...current.session, appliedSeq: 0,
              lastControlId: null, observation: null, observations: [], checkpoints: [] } } : {}) });
          const reception = row.kind === 'native' ? { kind: 'native', requestId, inputDigest: current.inputDigest,
            executionRef: current.executionRef, scope: action.scope, receiver: action.receiver, receivedSeq: 1,
            session: executionRecordSessionIdentitySchema.parse(current.session) }
            : { kind: 'browser', acceptance: executionAcceptanceSchema.parse(original.acceptance) };
          command = executionRecordEventSchema.parse({ version: 1, kind: 'command', sourceOwner: storage.owner,
            installationId: options.installationId, requestId, inputDigest: current.inputDigest, executionRef: current.executionRef,
            actionText: original.action_text, reception, query: initial,
            createdAt: new Date(original.created_at as string).toISOString() }) as typeof command;
          await storage.request({ requestId: `execution-export:${requestId}`, fingerprint: digest(command) }, async tx => {
            await tx.query('INSERT INTO execution_record_exports(request_id,command) VALUES($1,$2) ON CONFLICT DO NOTHING', [requestId, command]);
            return null;
          });
        }
        if (!isOpen()) return;
        if (!saved?.command_sent) {
          await options.publish(activity.identity, activityId, command);
          await remember(requestId, 'command_sent', true);
        }
        const statusDigest = digest(current);
        if (saved?.status_digest !== statusDigest && isOpen()) {
          await options.publish(activity.identity, activityId, { version: 1, kind: 'status', sourceOwner: command.sourceOwner,
            installationId: command.installationId, requestId, inputDigest: command.inputDigest, executionRef: command.executionRef, query: current });
          await remember(requestId, 'status_digest', statusDigest);
        }
        if (current.output && !saved?.result_digest && isOpen()) {
          const artifact = await options.executions.artifact(activity.identity, activityId, requestId);
          if (!artifact) continue;
          const event = executionRecordEventSchema.parse({ version: 1, kind: 'result', sourceOwner: command.sourceOwner,
            installationId: command.installationId, requestId, inputDigest: command.inputDigest, executionRef: command.executionRef,
            result: { ...artifact, contentId: current.output.contentId } });
          await options.publish(activity.identity, activityId, event);
          await remember(requestId, 'result_digest', digest(event));
        }
      } catch (error) {
        // Retain the original command and unsent facts while its data owner is unavailable or revoked.
        // Invalid source facts remain visible through validation instead of being silently replaced.
        if (!(error instanceof StorageError) || error.code === 'corrupt' || error.code === 'invalid') throw error;
      }
    }
  }
  return { poll };
}
