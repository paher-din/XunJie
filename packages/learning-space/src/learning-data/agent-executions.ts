import { createHash } from 'node:crypto';
import { z } from 'zod';
import { StorageError, type Migration, type OwnedStorage } from '@xunjie/storage';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import type { LearningActivity } from '@xunjie/contracts/learning-data';
import { canonicalValue, executionActionSchema, executionAcceptanceSchema, executionControlSchema, executionStopSchema,
  agentExecutionAssociationSchema as associationSchema, agentBrowserIdSchema, agentBrowserCommandSchema,
  agentBrowserPendingSchema, agentBrowserStopsSchema,
  type AgentExecutionAssociation, type ExecutionAction, type ExecutionQuery } from '@xunjie/contracts/execution';
import type { createWorks } from './works.js';

export const agentExecutionMigration: Migration = { version: 17, name: 'trusted-agent-execution-commands', sql: `
  CREATE TABLE agent_execution_commands(command_id uuid PRIMARY KEY,request_id uuid NOT NULL,
    activity_id uuid NOT NULL REFERENCES activities(id),association jsonb NOT NULL,body_text text NOT NULL,
    input_digest text NOT NULL,kind text NOT NULL CHECK(kind IN ('submit','control')),
    cancelled boolean NOT NULL DEFAULT false,claimed boolean NOT NULL DEFAULT false,browser_id uuid,stop_body jsonb,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
  CREATE INDEX agent_execution_requests ON agent_execution_commands(activity_id,request_id);
` };
/** Only server code constructs this context. The callback is reconstructed from the durable Run permit. */
export interface AgentExecutionContext extends AgentExecutionAssociation {
  assertDispatch(): Promise<void>;
}
const association = ({ runId, stepId, commandId, snapshotId }: AgentExecutionContext) =>
  associationSchema.parse({ runId, stepId, commandId, snapshotId });
const actionScope = (identity: SpaceIdentity, activityId: string) => ({ environmentId: identity.environmentId,
  spaceId: identity.spaceId, principalId: identity.principalId, activityId });
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonicalValue(value))).digest('hex');
function fail(code: 'forbidden' | 'invalid' | 'identity-conflict' | 'missing' | 'corrupt'): never { throw new StorageError(code); }

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
    await storage.request({ requestId: `agent-execution:${context.commandId}`, fingerprint: hash({ identity, activityId, fixed, body, kind, requestId }) }, async tx => {
      await tx.query(`INSERT INTO agent_execution_commands(command_id,request_id,activity_id,association,body_text,input_digest,kind)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(command_id) DO NOTHING`, [fixed.commandId, requestId, activityId,
        JSON.stringify(fixed), JSON.stringify(body), inputDigest, kind]);
      const { rows: [saved] } = await tx.query('SELECT * FROM agent_execution_commands WHERE command_id=$1 FOR UPDATE', [fixed.commandId]);
      if (!saved || saved.activity_id !== activityId || saved.request_id !== requestId || saved.kind !== kind
        || saved.input_digest !== inputDigest || hash(saved.association) !== hash(fixed)) fail('identity-conflict');
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
    try {
      const current = await options.read(identity, activityId, requestId);
      return current ? await options.stop(identity, activityId, requestId, input) : null;
    } catch (error) {
      if (!(error instanceof StorageError) || !['forbidden', 'identity-conflict'].includes(error.code)) throw error;
      return options.reclaim(original.action, input);
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

  return { dispatch, read, control, stop, cleanup, pendingBrowser, claimBrowser, acceptBrowser, browserStops, validate,
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
