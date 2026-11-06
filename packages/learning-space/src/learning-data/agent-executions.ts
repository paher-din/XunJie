import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { StorageError, type Migration, type OwnedStorage } from '@xunjie/storage';
import { spaceIdentitySchema } from '@xunjie/contracts/spaces';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import type { LearningActivity } from '@xunjie/contracts/learning-data';
import { canonicalValue, executionActionSchema, executionAcceptanceSchema, executionControlSchema, executionStopSchema,
  agentExecutionAssociationSchema as associationSchema, agentBrowserIdSchema, agentBrowserCommandSchema,
  agentBrowserPendingSchema, agentBrowserStopsSchema, isTerminalExecutionState, executionQuerySchema,
  type AgentExecutionAssociation, type ExecutionAction, type ExecutionQuery } from '@xunjie/contracts/execution';
import type { createWorks } from './works.js';

export const agentExecutionMigration: Migration = { version: 17, name: 'trusted-agent-execution-commands', sql: `
  CREATE TABLE agent_execution_commands(command_id uuid PRIMARY KEY,request_id uuid NOT NULL,
    activity_id uuid NOT NULL REFERENCES activities(id),association jsonb NOT NULL,body_text text NOT NULL,
    input_digest text NOT NULL,kind text NOT NULL CHECK(kind IN ('submit','control')),
    cancelled boolean NOT NULL DEFAULT false,claimed boolean NOT NULL DEFAULT false,browser_id uuid,stop_body jsonb,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
  CREATE INDEX agent_execution_requests ON agent_execution_commands(activity_id,request_id);
` };
export const agentExecutionOriginMigration: Migration = { version: 20, name: 'agent-execution-owner-cleanup-origins', sql: `
  CREATE TABLE agent_execution_origins(command_id uuid PRIMARY KEY REFERENCES agent_execution_commands(command_id),
    identity jsonb NOT NULL,source jsonb,cleanup_state text NOT NULL DEFAULT 'none' CHECK(cleanup_state IN ('none','pending','confirmed','ended')),
    cleanup_query jsonb,next_check_at timestamptz NOT NULL DEFAULT clock_timestamp());
  CREATE INDEX agent_execution_origins_due ON agent_execution_origins(next_check_at,command_id) WHERE cleanup_state IN ('none','pending');
  INSERT INTO agent_execution_origins(command_id,identity)
    SELECT c.command_id,a.body->'identity' FROM agent_execution_commands c JOIN activities a ON a.id=c.activity_id WHERE c.kind='submit';
` };
const originSchema = z.object({ sourceEnvironmentId: z.uuid(), sourceServiceId: z.uuid(),
  sourceInstallationId: z.uuid(), grantId: z.uuid() }).strict();
export type AgentExecutionOrigin = z.infer<typeof originSchema>;

export const agentExecutionAuthorityMigration: Migration = { version: 22, name: 'agent-execution-recovery-authorities', sql: `
  CREATE TABLE agent_execution_authorities(command_id uuid PRIMARY KEY REFERENCES agent_execution_commands(command_id),
    source jsonb NOT NULL,history jsonb NOT NULL);
` };

/** Only server code constructs this context. The callback is reconstructed from the durable Run permit. */
export interface AgentExecutionContext extends AgentExecutionAssociation {
  assertDispatch(): Promise<void>;
  /** Set by the trusted service host, never taken from a student or model payload. */
  origin?: AgentExecutionOrigin;
}
const association = ({ runId, stepId, commandId, snapshotId }: AgentExecutionContext) =>
  associationSchema.parse({ runId, stepId, commandId, snapshotId });
const actionScope = (identity: SpaceIdentity, activityId: string) => ({ environmentId: identity.environmentId,
  spaceId: identity.spaceId, principalId: identity.principalId, activityId });
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonicalValue(value))).digest('hex');
function fail(code: 'forbidden' | 'invalid' | 'identity-conflict' | 'missing' | 'corrupt'): never { throw new StorageError(code); }

/** Read persisted owner facts only. A monitor must never reconcile a supervisor through a different host handle. */
async function terminalFact(storage: OwnedStorage, activityId: string, requestId: string): Promise<boolean> {
  const { rows } = await storage.read(`SELECT state,status_knowledge FROM native_sessions WHERE activity_id=$1 AND request_id=$2
    UNION ALL SELECT state,status_knowledge FROM execution_commands WHERE activity_id=$1 AND request_id=$2
    UNION ALL SELECT execution->>'state' AS state,execution->>'statusKnowledge' AS status_knowledge
      FROM channel_executions WHERE activity_id=$1 AND request_id=$2`, [activityId, requestId]);
  return rows.length > 0 && rows.every(row => row.status_knowledge === 'confirmed'
    && ['succeeded', 'failed', 'cancelled'].includes(String(row.state)));
}

export function createAgentExecutions(storage: OwnedStorage, options: {
  activity(identity: SpaceIdentity, activityId: string): Promise<LearningActivity>;
  works: ReturnType<typeof createWorks>;
  verify(activity: LearningActivity, action: ExecutionAction): Promise<void>;
  accept(identity: SpaceIdentity, activityId: string, value: unknown, guard: () => Promise<void>): Promise<ExecutionQuery>;
  read(identity: SpaceIdentity, activityId: string, requestId: string, guard?: () => Promise<void>): Promise<ExecutionQuery | null>;
  control(identity: SpaceIdentity, activityId: string, requestId: string, value: unknown, guard: () => Promise<void>): Promise<ExecutionQuery>;
  stop(identity: SpaceIdentity, activityId: string, requestId: string, value: unknown): Promise<ExecutionQuery | null>;
  reclaim(action: ExecutionAction, value: unknown): Promise<ExecutionQuery | null>;
}) {
  async function root(identity: SpaceIdentity, activityId: string, context: AgentExecutionContext, requestId: string, currentAuthorization = true) {
    if (currentAuthorization) await options.activity(identity, activityId);
    association(context); z.uuid().parse(requestId);
    const { rows: [row] } = await storage.read(`SELECT * FROM agent_execution_commands
      WHERE activity_id=$1 AND command_id=$2 AND kind='submit'`, [activityId, requestId]);
    if (!row) return null;
    const action = executionActionSchema.parse(JSON.parse(String(row.body_text)));
    if (associationSchema.parse(row.association).runId !== context.runId
      || hash(action.scope) !== hash(actionScope(identity, activityId)) || action.execution.initiator.kind !== 'agent') fail('forbidden');
    if (hash(action) !== row.input_digest) fail('corrupt');
    return { row, action };
  }
  async function register(identity: SpaceIdentity, activityId: string, context: AgentExecutionContext,
    requestId: string, kind: 'submit' | 'control', body: unknown) {
    const fixed = association(context), inputDigest = hash(body);
    if (context.origin) {
      const { rows: [saved] } = await storage.read(`SELECT c.*,COALESCE(a.source,o.source) AS current_source
        FROM agent_execution_commands c LEFT JOIN agent_execution_origins o ON o.command_id=$2
        LEFT JOIN agent_execution_authorities a ON a.command_id=$2 WHERE c.command_id=$1`, [fixed.commandId, requestId]);
      if (saved) {
        const current = originSchema.parse(saved.current_source), caller = originSchema.parse(context.origin);
        if (saved.activity_id !== activityId || saved.request_id !== requestId || saved.kind !== kind
          || saved.input_digest !== inputDigest || hash(saved.association) !== hash(fixed)
          || current.sourceEnvironmentId !== caller.sourceEnvironmentId || current.sourceServiceId !== caller.sourceServiceId
          || current.sourceInstallationId !== caller.sourceInstallationId) fail('identity-conflict');
        // The host authenticated this live grant; multiple credentials for the same installation do not change its command identity.
        return; // The immutable original receipt is already present; never replay a different fingerprint.
      }
    }
    await storage.request({ requestId: `agent-execution:${context.commandId}`, fingerprint: hash({ identity, activityId, fixed, body, kind, requestId, ...(context.origin ? { origin: originSchema.parse(context.origin) } : {}) }) }, async tx => {
      await tx.query(`INSERT INTO agent_execution_commands(command_id,request_id,activity_id,association,body_text,input_digest,kind)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(command_id) DO NOTHING`, [fixed.commandId, requestId, activityId,
        JSON.stringify(fixed), JSON.stringify(body), inputDigest, kind]);
      const { rows: [saved] } = await tx.query('SELECT * FROM agent_execution_commands WHERE command_id=$1 FOR UPDATE', [fixed.commandId]);
      if (!saved || saved.activity_id !== activityId || saved.request_id !== requestId || saved.kind !== kind
        || saved.input_digest !== inputDigest || hash(saved.association) !== hash(fixed)) fail('identity-conflict');
      if (kind === 'submit') {
        const source = context.origin ? originSchema.parse(context.origin) : null;
        await tx.query('INSERT INTO agent_execution_origins(command_id,identity,source) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
          [fixed.commandId, spaceIdentitySchema.parse(identity), source]);
        const { rows: [origin] } = await tx.query('SELECT identity,source FROM agent_execution_origins WHERE command_id=$1', [fixed.commandId]);
        if (!origin || hash(origin.identity) !== hash(identity) || hash(origin.source) !== hash(source)) fail('identity-conflict');
      }
      if (kind === 'submit') for (const file of executionActionSchema.parse(body).execution.basis.works)
        await tx.reference(`agent-execution/${fixed.commandId}/work/${file.contentId}`, file.contentId);
      return null;
    });
  }
  function guard(identity: SpaceIdentity, activityId: string, context: AgentExecutionContext, requestId: string) {
    return async () => {
      const original = await root(identity, activityId, context, requestId);
      if (!original || original.row.cancelled) fail('forbidden');
      const activity = await options.activity(identity, activityId);
      if (activity.status !== 'open') fail('forbidden');
      await options.verify(activity, original.action);
      await context.assertDispatch();
    };
  }
  async function dispatch(identity: SpaceIdentity, activityId: string, context: AgentExecutionContext, value: unknown) {
    const action = executionActionSchema.parse(value), activity = await options.activity(identity, activityId);
    if (action.execution.initiator.kind !== 'agent' || context.commandId !== action.requestId
      || hash(action.scope) !== hash(actionScope(identity, activityId)) || activity.status !== 'open') fail('forbidden');
    await options.verify(activity, action);
    await context.assertDispatch();
    for (const file of action.execution.basis.works) await options.works.registerBasis(identity, activityId, file);
    await register(identity, activityId, context, action.requestId, 'submit', action);
    const check = guard(identity, activityId, context, action.requestId);
    await check();
    // A browser job waits durably for its original browser broker. No server calculation or invented receipt.
    if (action.execution.plan.location === 'browser') return options.read(identity, activityId, action.requestId);
    return options.accept(identity, activityId, { action }, check);
  }
  async function read(identity: SpaceIdentity, activityId: string, context: AgentExecutionContext, requestId: string) {
    if (!await root(identity, activityId, context, requestId)) return null;
    return options.read(identity, activityId, requestId, guard(identity, activityId, context, requestId));
  }
  async function control(identity: SpaceIdentity, activityId: string, context: AgentExecutionContext, requestId: string, value: unknown) {
    const original = await root(identity, activityId, context, requestId);
    if (!original) fail('forbidden');
    const input = executionControlSchema.parse(value);
    if (context.commandId !== input.controlId) fail('identity-conflict');
    const check = guard(identity, activityId, context, requestId);
    await check();
    await register(identity, activityId, context, requestId, 'control', input);
    return options.control(identity, activityId, requestId, input, check);
  }
  async function stop(identity: SpaceIdentity, activityId: string, context: AgentExecutionContext, requestId: string, value: unknown) {
    if (!await root(identity, activityId, context, requestId)) return null;
    const input = executionStopSchema.parse(value);
    await storage.request({ requestId: `agent-execution-stop:${input.stopId}`, fingerprint: hash({ identity, activityId, requestId, input }) }, async tx => {
      await tx.query('UPDATE agent_execution_commands SET cancelled=true,stop_body=COALESCE(stop_body,$3::jsonb) WHERE activity_id=$1 AND request_id=$2', [activityId, requestId, JSON.stringify(input)]);
      return null;
    });
    // Never call the student stop path if the original Agent command has no execution yet.
    const current = await options.read(identity, activityId, requestId);
    return current ? options.stop(identity, activityId, requestId, input) : null;
  }
  /** Restricted owner cleanup: original scope and Run only; grants no new effect or source read. */
  async function cleanup(identity: SpaceIdentity, activityId: string, context: AgentExecutionContext, requestId: string, value: unknown) {
    const original = await root(identity, activityId, context, requestId, false);
    if (!original) return null;
    const input = executionStopSchema.parse(value);
    await storage.request({ requestId: `agent-execution-stop:${input.stopId}`, fingerprint: hash({ identity, activityId, requestId, input }) }, async tx => {
      await tx.query('UPDATE agent_execution_commands SET cancelled=true,stop_body=COALESCE(stop_body,$3::jsonb) WHERE activity_id=$1 AND request_id=$2',
        [activityId, requestId, JSON.stringify(input)]);
      return null;
    });
    // Reclaim validates the persisted original instance/claim and does not repair a
    // different live host through the normal read/ensureReady path.
    return options.reclaim(original.action, input);
  }
  /** Owner-only reconciliation. Original facts select cleanup targets; callers cannot inject a source or new effect. */
  async function reconcileAuthorization(authorize: (identity: SpaceIdentity, activityId: string, origin?: AgentExecutionOrigin) => Promise<void>,
    isOpen: () => boolean = () => true) {
    if (!isOpen()) return [];
    const due = await storage.read(`SELECT command_id FROM agent_execution_origins
      WHERE cleanup_state IN ('none','pending') AND next_check_at<=clock_timestamp() ORDER BY next_check_at,command_id LIMIT 1`);
    if (!due.rows.length) return [];
    const claimed = await storage.request({ requestId: `agent-origin-check:${randomUUID()}`, fingerprint: 'agent-origin-check' }, async tx => {
      const { rows } = await tx.query(`WITH due AS (
        SELECT command_id FROM agent_execution_origins WHERE cleanup_state IN ('none','pending') AND next_check_at<=clock_timestamp()
        ORDER BY next_check_at,command_id LIMIT 20 FOR UPDATE SKIP LOCKED)
        UPDATE agent_execution_origins o SET next_check_at=clock_timestamp()+interval '1 second'
        FROM due WHERE o.command_id=due.command_id RETURNING o.command_id`);
      return rows.map(row => String(row.command_id));
    });
    const commandIds = z.array(z.uuid()).parse(claimed.result);
    if (!commandIds.length) return [];
    const { rows } = await storage.read(`SELECT c.*,o.identity,COALESCE(a.source,o.source) AS source,a.history,o.cleanup_state FROM agent_execution_origins o
      JOIN agent_execution_commands c USING(command_id) LEFT JOIN agent_execution_authorities a USING(command_id)
      WHERE c.command_id=ANY($1::uuid[]) ORDER BY c.command_id`, [commandIds]);
    const results: { requestId: string; state: 'pending' | 'confirmed'; query: ExecutionQuery | null }[] = [];
    for (const row of rows) {
      if (!isOpen()) break;
      const identity = spaceIdentitySchema.parse(row.identity), activityId = String(row.activity_id);
      const origin = row.source === null ? undefined : originSchema.parse(row.source);
      if (row.cleanup_state === 'none') {
        try {
          const candidates: (AgentExecutionOrigin | undefined)[] = [origin];
          if (origin && row.history) {
            const history = z.array(z.object({ from: originSchema, to: originSchema }).strict()).parse(row.history);
            for (const candidate of history.flatMap(transfer => [transfer.to, transfer.from])) {
              if (candidate.sourceEnvironmentId === origin.sourceEnvironmentId && candidate.sourceServiceId === origin.sourceServiceId
                && candidate.sourceInstallationId === origin.sourceInstallationId && !candidates.some(saved => saved?.grantId === candidate.grantId)) candidates.push(candidate);
            }
          }
          let denied: unknown;
          for (const candidate of candidates) {
            try { await authorize(identity, activityId, candidate); denied = undefined; break; }
            catch (error) {
              if (!(error instanceof StorageError) || !['forbidden', 'missing', 'identity-conflict'].includes(error.code)) throw error;
              denied = error;
            }
          }
          if (denied) throw denied;
          if (await terminalFact(storage, activityId, String(row.request_id))) {
            await storage.request({ requestId: `agent-origin-ended:${row.command_id}`, fingerprint: String(row.input_digest) }, async tx => {
              await tx.query("UPDATE agent_execution_origins SET cleanup_state='ended' WHERE command_id=$1 AND cleanup_state='none'", [row.command_id]);
              return null;
            });
          }
          continue;
        }
        catch (error) {
          if (!(error instanceof StorageError) || !['forbidden', 'missing', 'identity-conflict'].includes(error.code)) continue;
        }
      }
      const context: AgentExecutionContext = { ...associationSchema.parse(row.association),
        assertDispatch: async () => fail('forbidden') };
      // Re-read and verify original scope/digest before recording or touching any physical owner.
      const original = await root(identity, activityId, context, String(row.request_id), false);
      if (!original) fail('corrupt');
      if (row.cleanup_state === 'none') {
        const checkedSource = hash(row.source);
        const cleanup = await storage.request({ requestId: `agent-origin-cleanup:${row.command_id}:${checkedSource}`, fingerprint: String(row.input_digest) }, async tx => {
          const { rows: [current] } = await tx.query(`SELECT o.cleanup_state,COALESCE(a.source,o.source) AS source FROM agent_execution_origins o
            LEFT JOIN agent_execution_authorities a USING(command_id) WHERE o.command_id=$1 FOR UPDATE OF o`, [row.command_id]);
          if (!current || current.cleanup_state !== 'none' || hash(current.source) !== checkedSource) return false;
          await tx.query("UPDATE agent_execution_origins SET cleanup_state='pending' WHERE command_id=$1", [row.command_id]);
          return true;
        });
        if (!cleanup.result) continue; // A newly adopted authorization must be checked before its command can be cleaned.
      }
      const digest = createHash('sha256').update('agent-stop:' + row.command_id).digest('hex');
      const stopId = `${digest.slice(0,8)}-${digest.slice(8,12)}-4${digest.slice(13,16)}-a${digest.slice(17,20)}-${digest.slice(20,32)}`;
      let query: ExecutionQuery | null;
      try { query = await cleanup(identity, activityId, context, String(row.request_id), { stopId, reason: '' }); }
      catch (error) {
        if (error instanceof StorageError && ['maintenance', 'unavailable', 'resource-busy'].includes(error.code)) continue;
        throw error;
      }
      const confirmed = query ? query.statusKnowledge === 'confirmed' && isTerminalExecutionState(query.state)
        : original.action.execution.plan.location === 'browser' && !original.row.claimed;
      const state = confirmed ? 'confirmed' as const : 'pending' as const;
      await storage.request({ requestId: `agent-origin-cleanup-result:${row.command_id}:${hash([state, query])}`, fingerprint: hash([state, query]) }, async tx => {
        await tx.query('UPDATE agent_execution_origins SET cleanup_state=$2,cleanup_query=$3 WHERE command_id=$1 AND cleanup_state IN (\'none\',\'pending\')', [row.command_id, state, query]);
        return null;
      });
      results.push({ requestId: String(row.request_id), state, query });
    }
    return results;
  }
  async function adoptAuthorization(value: unknown, successor: (from: AgentExecutionOrigin, to: AgentExecutionOrigin) => Promise<boolean>) {
    const source = originSchema.parse(value);
    const { rows } = await storage.read(`SELECT o.command_id,o.identity,c.activity_id,COALESCE(a.source,o.source) AS source
      FROM agent_execution_origins o JOIN agent_execution_commands c USING(command_id)
      LEFT JOIN agent_execution_authorities a USING(command_id) WHERE o.cleanup_state='none' AND c.cancelled=false AND o.source IS NOT NULL`);
    const transfers: { commandId: string; from: AgentExecutionOrigin }[] = [];
    for (const row of rows) {
      const from = originSchema.parse(row.source);
      if (from.sourceEnvironmentId !== source.sourceEnvironmentId || from.sourceServiceId !== source.sourceServiceId
        || from.grantId === source.grantId) continue;
      const activity = await options.activity(spaceIdentitySchema.parse(row.identity), String(row.activity_id));
      if (activity.status !== 'open' || !await successor(from, source)) continue;
      transfers.push({ commandId: String(row.command_id), from });
    }
    const operation = { requestId: 'agent-recovery-authority:' + source.grantId, fingerprint: hash(source) };
    const save = () => storage.request(operation, async tx => {
      for (const transfer of transfers) {
        const { rows: [current] } = await tx.query(`SELECT o.cleanup_state,c.cancelled,COALESCE(a.source,o.source) AS source
          FROM agent_execution_origins o JOIN agent_execution_commands c USING(command_id)
          LEFT JOIN agent_execution_authorities a USING(command_id) WHERE o.command_id=$1 FOR UPDATE OF o,c`, [transfer.commandId]);
        if (!current || current.cleanup_state !== 'none' || current.cancelled) continue;
        const from = originSchema.parse(current.source);
        if (hash(from) !== hash(transfer.from) && (from.sourceEnvironmentId !== source.sourceEnvironmentId
          || from.sourceServiceId !== source.sourceServiceId || from.sourceInstallationId !== source.sourceInstallationId)) fail('identity-conflict');
        await tx.query(`INSERT INTO agent_execution_authorities VALUES($1,$2,$3)
          ON CONFLICT(command_id) DO UPDATE SET source=EXCLUDED.source,
          history=agent_execution_authorities.history||EXCLUDED.history`,
        [transfer.commandId, source, JSON.stringify([{ from, to: source }])]);
      }
      return null;
    });
    try { await save(); } catch (error) {
      if (!(error instanceof StorageError) || error.code !== 'commit-unknown') throw error;
      await save(); // One owner transaction and its original receipt, not an external operation.
    }
  }
  async function pendingBrowser(identity: SpaceIdentity, activityId: string) {
    await options.activity(identity, activityId);
    const { rows } = await storage.read(`SELECT body_text,association FROM agent_execution_commands a
      WHERE activity_id=$1 AND kind='submit' AND cancelled=false
        AND body_text::jsonb#>>'{execution,plan,location}'='browser'
        AND NOT EXISTS(SELECT 1 FROM execution_commands e WHERE e.request_id=a.request_id)
      ORDER BY created_at,command_id LIMIT 32`, [activityId]);
    return agentBrowserPendingSchema.parse(rows.map(row => ({ action: executionActionSchema.parse(JSON.parse(String(row.body_text))),
      association: associationSchema.parse(row.association) })).filter(item => item.action.execution.plan.location === 'browser'));
  }
  async function claimBrowser(identity: SpaceIdentity, activityId: string, requestId: string, browserId: string,
    assertDispatch: (association: AgentExecutionAssociation) => Promise<void>) {
    const { rows: [row] } = await storage.read(`SELECT association FROM agent_execution_commands
      WHERE command_id=$1 AND activity_id=$2 AND kind='submit'`, [requestId, activityId]);
    if (!row) fail('forbidden');
    agentBrowserIdSchema.parse(browserId);
    const fixed = associationSchema.parse(row.association), context = { ...fixed, assertDispatch: () => assertDispatch(fixed) };
    const original = await root(identity, activityId, context, requestId);
    if (!original || original.action.execution.plan.location !== 'browser') fail('forbidden');
    await guard(identity, activityId, context, requestId)();
    await storage.request({ requestId: `agent-browser-claim:${requestId}`, fingerprint: hash({ fixed, browserId }) }, async tx => {
      const { rows: [current] } = await tx.query('SELECT cancelled,browser_id FROM agent_execution_commands WHERE command_id=$1 FOR UPDATE', [requestId]);
      if (!current || current.cancelled) fail('forbidden');
      if (current.browser_id && current.browser_id !== browserId) fail('identity-conflict');
      await tx.query('UPDATE agent_execution_commands SET claimed=true,browser_id=$2 WHERE command_id=$1', [requestId, browserId]);
      return null;
    });
    return agentBrowserCommandSchema.parse({ action: original.action, association: fixed });
  }
  async function acceptBrowser(identity: SpaceIdentity, activityId: string, requestId: string, browserId: string, value: unknown,
    assertDispatch: (association: AgentExecutionAssociation) => Promise<void>) {
    const { rows: [row] } = await storage.read(`SELECT association FROM agent_execution_commands
      WHERE command_id=$1 AND activity_id=$2 AND kind='submit'`, [requestId, activityId]);
    if (!row) fail('forbidden');
    const fixed = associationSchema.parse(row.association);
    const context = { ...fixed, assertDispatch: () => assertDispatch(fixed) };
    const original = await root(identity, activityId, context, requestId);
    if (!original || original.action.execution.plan.location !== 'browser') fail('forbidden');
    const { rows: [claim] } = await storage.read('SELECT claimed,cancelled,browser_id,stop_body FROM agent_execution_commands WHERE command_id=$1', [requestId]);
    agentBrowserIdSchema.parse(browserId);
    if (!claim?.claimed || claim.browser_id !== browserId) fail('forbidden');
    // This only archives the broker's original receipt after a durable dispatch grant. A late
    // receipt is evidence, never a new dispatch permit or permission to revive the Run.
    const checkFact = async () => { await options.activity(identity, activityId); };
    const accepted = await options.accept(identity, activityId,
      { action: original.action, acceptance: executionAcceptanceSchema.parse(value) }, checkFact);
    const { rows: [latest] } = await storage.read('SELECT cancelled,stop_body FROM agent_execution_commands WHERE command_id=$1', [requestId]);
    return latest?.cancelled ? await options.stop(identity, activityId, requestId, executionStopSchema.parse(latest.stop_body)) ?? accepted : accepted;
  }
  async function browserStops(identity: SpaceIdentity, activityId: string, browserId: string) {
    agentBrowserIdSchema.parse(browserId);
    await options.activity(identity, activityId);
    const { rows } = await storage.read(`SELECT request_id,association,stop_body,body_text FROM agent_execution_commands
      WHERE activity_id=$1 AND kind='submit' AND cancelled=true AND claimed=true AND browser_id=$2
        AND NOT EXISTS(SELECT 1 FROM execution_commands e WHERE e.request_id=agent_execution_commands.request_id
          AND e.state IN ('succeeded','failed','cancelled') AND e.status_knowledge='confirmed')
      ORDER BY created_at LIMIT 32`, [activityId, browserId]);
    return agentBrowserStopsSchema.parse(rows.filter(row => executionActionSchema.parse(JSON.parse(String(row.body_text))).execution.plan.location === 'browser')
      .map(row => ({ requestId: String(row.request_id), association: associationSchema.parse(row.association), stop: executionStopSchema.parse(row.stop_body) })));
  }
  const validate = () => validateAgentExecutionCommands(storage);

  return { dispatch, read, control, stop, cleanup, reconcileAuthorization, adoptAuthorization, pendingBrowser, claimBrowser, acceptBrowser, browserStops, validate,
    status: async (identity: SpaceIdentity, activityId: string, context: AgentExecutionContext, requestId: string) => {
      const found = await root(identity, activityId, context, requestId);
      return found ? { cancelled: Boolean(found.row.cancelled), claimed: Boolean(found.row.claimed),
        browserId: found.row.browser_id ? String(found.row.browser_id) : null } : null;
    },
    cleanupStatus: async (identity: SpaceIdentity, activityId: string, context: AgentExecutionContext, requestId: string) => {
      const found = await root(identity, activityId, context, requestId, false);
      return found ? { cancelled: Boolean(found.row.cancelled), claimed: Boolean(found.row.claimed),
        browserId: found.row.browser_id ? String(found.row.browser_id) : null } : null;
    },
    original: async (identity: SpaceIdentity, activityId: string, context: AgentExecutionContext, requestId: string) => {
      const found = await root(identity, activityId, context, requestId);
      return found ? agentBrowserCommandSchema.parse({ action: found.action, association: associationSchema.parse(found.row.association) }) : null;
    } };
}

/** Validates the owner ledger and resource pins without dispatching or asking a model. */
export async function validateAgentExecutionCommands(storage: OwnedStorage) {
  const { rows } = await storage.read('SELECT * FROM agent_execution_commands');
  for (const row of rows) {
    const a = associationSchema.parse(row.association), body = JSON.parse(String(row.body_text));
    const parsed = row.kind === 'submit' ? executionActionSchema.parse(body) : executionControlSchema.parse(body);
    if (hash(parsed) !== row.input_digest || a.commandId !== row.command_id
      || (row.kind === 'submit' ? (parsed as ExecutionAction).requestId : (parsed as { controlId: string }).controlId) !== row.command_id
      || Boolean(row.claimed) !== Boolean(row.browser_id) || row.cancelled && !row.stop_body) fail('corrupt');
    if (row.stop_body) executionStopSchema.parse(row.stop_body);
    if (row.browser_id) agentBrowserIdSchema.parse(row.browser_id);
    if (row.kind === 'control') {
      const { rows: [parent] } = await storage.read(`SELECT association,activity_id FROM agent_execution_commands
        WHERE command_id=$1 AND kind='submit'`, [row.request_id]);
      if (!parent || parent.activity_id !== row.activity_id || associationSchema.parse(parent.association).runId !== a.runId) fail('corrupt');
      continue;
    }
    const action = parsed as ExecutionAction;
    const { rows: [activity] } = await storage.read('SELECT body FROM activities WHERE id=$1', [row.activity_id]);
    const owned = activity?.body as LearningActivity | undefined;
    if (!owned || action.requestId !== row.request_id || action.execution.initiator.kind !== 'agent'
      || hash(action.scope) !== hash(actionScope(owned.identity, String(row.activity_id)))
      || row.claimed && action.execution.plan.location !== 'browser') fail('corrupt');
    for (const file of action.execution.basis.works) {
      const { rows: refs } = await storage.read('SELECT resource_id FROM _storage_references WHERE reference_id=$1',
        [`agent-execution/${row.command_id}/work/${file.contentId}`]);
      if (refs.length !== 1 || refs[0]!.resource_id !== file.contentId) fail('corrupt');
    }
  }
  const { rows: origins } = await storage.read(`SELECT o.*,c.body_text,c.activity_id,c.kind FROM agent_execution_origins o
    JOIN agent_execution_commands c USING(command_id)`);
  for (const row of origins) {
    const identity = spaceIdentitySchema.parse(row.identity);
    const action = executionActionSchema.parse(JSON.parse(String(row.body_text)));
    if (row.kind !== 'submit' || hash(action.scope) !== hash(actionScope(identity, String(row.activity_id)))) fail('corrupt');
    if (row.source !== null) originSchema.parse(row.source);
    if (row.cleanup_query !== null) {
      const query = executionQuerySchema.parse(row.cleanup_query);
      if (query.requestId !== action.requestId || hash(query.scope) !== hash(action.scope)) fail('corrupt');
      if (['confirmed', 'ended'].includes(String(row.cleanup_state)) && (query.statusKnowledge !== 'confirmed' || !isTerminalExecutionState(query.state))) fail('corrupt');
    } else if (row.cleanup_state === 'ended') {
      if (!await terminalFact(storage, String(row.activity_id), action.requestId)) fail('corrupt');
    } else if (row.cleanup_state === 'confirmed' && action.execution.plan.location !== 'browser') fail('corrupt');
  }
  const { rows: authorities } = await storage.read(`SELECT a.*,o.source AS original_source FROM agent_execution_authorities a
    JOIN agent_execution_origins o USING(command_id)`);
  for (const row of authorities) {
    let source = originSchema.parse(row.original_source);
    const history = z.array(z.object({ from: originSchema, to: originSchema }).strict()).min(1).parse(row.history);
    for (const transfer of history) {
      if (hash(transfer.from) !== hash(source) || transfer.to.sourceEnvironmentId !== source.sourceEnvironmentId
        || transfer.to.sourceServiceId !== source.sourceServiceId) fail('corrupt');
      source = transfer.to;
    }
    if (hash(source) !== hash(originSchema.parse(row.source))) fail('corrupt');
  }
}

/** A claimed browser command without its broker receipt is still an unresolved physical boundary. */
export async function agentBrowserBoundary(storage: OwnedStorage) {
  const { rows } = await storage.read(`SELECT a.* FROM agent_execution_commands a
    WHERE kind='submit' AND body_text::jsonb#>>'{execution,plan,location}'='browser'
      AND NOT EXISTS(SELECT 1 FROM execution_commands e WHERE e.request_id=a.request_id)
    ORDER BY command_id`);
  return rows.map(row => ({ requestId: String(row.request_id), activityId: String(row.activity_id),
    inputDigest: String(row.input_digest), association: associationSchema.parse(row.association),
    claimed: Boolean(row.claimed), browserId: row.browser_id ? String(row.browser_id) : null,
    cancelled: Boolean(row.cancelled), stop: row.stop_body ? executionStopSchema.parse(row.stop_body) : null }));
}
