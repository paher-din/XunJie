import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { StorageError } from '@xunjie/storage';
import type { Migration, OwnedStorage } from '@xunjie/storage';
import { spaceIdentitySchema } from '@xunjie/contracts/spaces';
import { advanceExecution, canonicalValue, executionQuerySchema, isTerminalExecutionState } from '@xunjie/contracts/execution';
import type { ExecutionQuery } from '@xunjie/contracts/execution';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import { productNativeAdapters } from './native-process.js';

export const nativeChannelMigration: Migration = { version: 9, name: 'authenticated-native-pull-channel', sql: `
  CREATE TABLE native_channel_nodes(connection_id uuid PRIMARY KEY,node_id text NOT NULL,installation_id uuid NOT NULL,
    owner_generation text NOT NULL,identity jsonb NOT NULL,snapshot jsonb NOT NULL,lease_until timestamptz NOT NULL DEFAULT '-infinity',registered_at timestamptz NOT NULL DEFAULT clock_timestamp());
  CREATE TABLE native_channel_commands(command_id uuid PRIMARY KEY,connection_id uuid NOT NULL REFERENCES native_channel_nodes(connection_id),
    activity_id uuid NOT NULL,session_id uuid NOT NULL,operation text NOT NULL CHECK(operation IN ('submit','control','stop')),
    command jsonb NOT NULL,command_text text NOT NULL,input_digest text NOT NULL,position bigserial UNIQUE,
    state text NOT NULL CHECK(state IN ('pending','claimed','reported')),claim_id uuid UNIQUE,claim_generation text,claim_node jsonb,result jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp());
  CREATE INDEX native_channel_pending ON native_channel_commands(connection_id,position) WHERE state='pending';
` };
export const nativeChannelTargetMigration: Migration = { version: 12, name: 'native-channel-fixed-targets', sql: `
  ALTER TABLE native_channel_commands ADD COLUMN target_node jsonb;
  ALTER TABLE native_channel_commands ADD COLUMN target_generation text;
  UPDATE native_channel_commands c SET target_node=COALESCE(
    (SELECT s.claim_node FROM native_channel_commands s WHERE s.connection_id=c.connection_id AND s.session_id=c.session_id AND s.operation='submit'),
    n.snapshot || jsonb_strip_nulls(jsonb_build_object(
      'supervisorEpoch',(SELECT s.command#>>'{payload,execution,session,supervisorEpoch}' FROM native_channel_commands s WHERE s.connection_id=c.connection_id AND s.session_id=c.session_id AND s.operation='submit')))),
    target_generation=COALESCE((SELECT s.claim_generation FROM native_channel_commands s WHERE s.connection_id=c.connection_id AND s.session_id=c.session_id AND s.operation='submit'),n.owner_generation)
    FROM native_channel_nodes n WHERE n.connection_id=c.connection_id;
  ALTER TABLE native_channel_commands ALTER COLUMN target_node SET NOT NULL;
  ALTER TABLE native_channel_commands ALTER COLUMN target_generation SET NOT NULL;
  CREATE TABLE native_channel_late_reports(command_id uuid NOT NULL REFERENCES native_channel_commands(command_id),
    claim_id uuid NOT NULL,report_digest text NOT NULL,node jsonb NOT NULL,result jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(command_id,claim_id,report_digest));
` };
export const nativeChannelObservationMigration: Migration = { version: 13, name: 'native-channel-session-observations', sql: `
  ALTER TABLE native_channel_commands ADD COLUMN observed_result jsonb;
  ALTER TABLE native_channel_commands ADD COLUMN observed_seq bigint;
  ALTER TABLE native_channel_commands ADD CONSTRAINT native_channel_observation_pair CHECK(
    (observed_result IS NULL AND observed_seq IS NULL) OR
    (operation='submit' AND observed_result IS NOT NULL AND observed_seq IS NOT NULL AND observed_seq>=0));
` };
export const nativeChannelCancellationMigration: Migration = { version: 14, name: 'native-channel-unclaimed-cancellation', sql: `
  ALTER TABLE native_channel_commands DROP CONSTRAINT native_channel_commands_state_check;
  ALTER TABLE native_channel_commands ADD CONSTRAINT native_channel_commands_state_check
    CHECK(state IN ('pending','claimed','reported','cancelled'));
` };
export const nativeChannelCleanupMigration: Migration = { version: 15, name: 'native-channel-claimed-instance-cleanup', sql: `
  CREATE TABLE native_channel_cleanups(command_id uuid PRIMARY KEY REFERENCES native_channel_commands(command_id),
    claim_id uuid NOT NULL,node jsonb NOT NULL,owner jsonb NOT NULL,generation text NOT NULL,
    execution_identity jsonb NOT NULL,proof_digest text NOT NULL,confirmed_at timestamptz NOT NULL DEFAULT clock_timestamp());
` };
export const nativeChannelNodeSchema = z.object({ connectionId: z.uuid(), nodeId: z.string().min(1).max(80), installationId: z.uuid(),
  platform: z.enum(['macos-arm64', 'windows-x64', 'linux-x64']), supervisorEpoch: z.uuid(),
  runtime: z.object({ platform: z.enum(['darwin', 'win32', 'linux']), arch: z.enum(['arm64', 'x64']),
    node: z.string().regex(/^v\d+\.\d+\.\d+$/) }).strict().optional(),
  adapters: z.array(z.object({ adapterId: z.string().min(1).max(100), adapterVersion: z.number().int().positive() }).strict()).max(32),
}).strict();
const nodeSchema = nativeChannelNodeSchema;
const commandSchema = z.object({ commandId: z.uuid(), activityId: z.uuid(), sessionId: z.uuid(),
  operation: z.enum(['submit', 'control', 'stop']), payload: z.json() }).strict();
export type NativeChannelNode = z.infer<typeof nodeSchema>;
export type NativeChannelCommand = z.infer<typeof commandSchema>;
const cleanupSchema = z.object({ node: nodeSchema, commandId: z.uuid(), claimId: z.uuid(),
  owner: z.object({ environmentId: z.uuid(), serviceId: z.uuid() }).strict(), generation: z.string().min(1).max(128),
  query: executionQuerySchema.refine(query => query.statusKnowledge === 'confirmed' && isTerminalExecutionState(query.state)),
}).strict();
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(canonicalValue(value))).digest('hex');
const fail = (code: 'forbidden' | 'identity-conflict' | 'missing' | 'unavailable'): never => { throw new StorageError(code); };
const same = (a: SpaceIdentity, b: SpaceIdentity) => a.environmentId === b.environmentId && a.spaceId === b.spaceId && a.principalId === b.principalId;

function assertObservationIdentity(original: ExecutionQuery, observed: ExecutionQuery) {
  const left = original.session, right = observed.session;
  if (!left || !right || original.requestId !== observed.requestId || original.inputDigest !== observed.inputDigest
    || original.executionRef !== observed.executionRef || hash(original.scope) !== hash(observed.scope)
    || ['adapterId', 'adapterVersion', 'instanceId', 'instanceKey', 'nodeId', 'installGeneration', 'supervisorEpoch', 'executorInstanceId']
      .some(key => left[key as keyof typeof left] !== right[key as keyof typeof right])) fail('identity-conflict');
}
function executionIdentity(query: ExecutionQuery) {
  const session = query.session;
  if (!session) return fail('identity-conflict');
  return { requestId: query.requestId, executionRef: query.executionRef, inputDigest: query.inputDigest, scope: query.scope,
    session: { adapterId: session.adapterId, adapterVersion: session.adapterVersion, instanceId: session.instanceId,
      instanceKey: session.instanceKey, nodeId: session.nodeId, installGeneration: session.installGeneration,
      supervisorEpoch: session.supervisorEpoch, executorInstanceId: session.executorInstanceId } };
}

/** 连接授权来自现有产品批准流程；通道只保存命令与固定节点，不保存连接密钥。 */
export function createNativeChannel(storage: OwnedStorage, options: {
  authenticate(token: string, connectionId: string): Promise<SpaceIdentity>;
  authorize(identity: SpaceIdentity, activityId: string): Promise<unknown>;
  authorizeConnection(identity: SpaceIdentity, connectionId: string): Promise<void>;
  leaseMs?: number;
}) {
  const leaseMs = z.number().int().min(1000).max(60000).parse(options.leaseMs ?? 15000);
  let dispatchOpen = true;
  async function node(token: string, value: unknown) {
    const input = nodeSchema.parse(value);
    const identity = await options.authenticate(token, input.connectionId);
    const { rows: [row] } = await storage.read('SELECT * FROM native_channel_nodes WHERE connection_id=$1', [input.connectionId]);
    if (!row || row.node_id !== input.nodeId || row.installation_id !== input.installationId
      || row.owner_generation !== storage.generation || hash(nodeSchema.parse(row.snapshot)) !== hash(input)
      || !same(spaceIdentitySchema.parse(row.identity), identity)) fail('forbidden');
    return { input, identity };
  }
  async function register(token: string, value: unknown) {
    const input = nodeSchema.parse(value);
    if (input.adapters.some(capability => !productNativeAdapters.some(adapter => adapter.adapterId === capability.adapterId
      && adapter.adapterVersion === capability.adapterVersion && adapter.platforms?.includes(input.platform)))) fail('forbidden');
    const identity = await options.authenticate(token, input.connectionId);
    if (!dispatchOpen) fail('unavailable');
    await storage.request({ requestId: `native-channel-register:${storage.generation}:${input.connectionId}:${input.supervisorEpoch}`, fingerprint: hash({ input, identity }) }, async tx => {
      const { rows: [existing] } = await tx.query('SELECT * FROM native_channel_nodes WHERE connection_id=$1 FOR UPDATE', [input.connectionId]);
      if (existing) {
        if (existing.node_id !== input.nodeId || existing.installation_id !== input.installationId
          || !same(spaceIdentitySchema.parse(existing.identity), identity)) fail('forbidden');
        await tx.query('UPDATE native_channel_nodes SET owner_generation=$2,snapshot=$3 WHERE connection_id=$1', [input.connectionId, storage.generation, JSON.stringify(input)]);
      } else await tx.query(`INSERT INTO native_channel_nodes(connection_id,node_id,installation_id,owner_generation,identity,snapshot)
        VALUES($1,$2,$3,$4,$5,$6)`, [input.connectionId, input.nodeId, input.installationId, storage.generation, JSON.stringify(identity), JSON.stringify(input)]);
      return null;
    });
    await node(token, input);
    return { ...input, owner: storage.owner, generation: storage.generation, leaseMs };
  }
  async function enqueue(identity: SpaceIdentity, connectionId: string, value: unknown) {
    z.uuid().parse(connectionId);
    const command = commandSchema.parse(value);
    await options.authorizeConnection(identity, connectionId);
    await options.authorize(identity, command.activityId);
    if (!dispatchOpen) fail('unavailable');
    const receipt = await storage.request({ requestId: `native-channel-enqueue:${command.commandId}`, fingerprint: hash({ identity, connectionId, command }) }, async tx => {
      const { rows: [registered] } = await tx.query('SELECT * FROM native_channel_nodes WHERE connection_id=$1 FOR UPDATE', [connectionId]);
      if (!registered || registered.owner_generation !== storage.generation || !same(spaceIdentitySchema.parse(registered.identity), identity)) fail('forbidden');
      const { rows: [session] } = await tx.query(`SELECT * FROM native_channel_commands
        WHERE connection_id=$1 AND session_id=$2 ORDER BY position LIMIT 1 FOR UPDATE`, [connectionId, command.sessionId]);
      if (session && (session.activity_id !== command.activityId || command.operation === 'submit')) fail('identity-conflict');
      if (!session && command.operation !== 'submit') fail('missing');
      const targetNode = nodeSchema.parse(session?.target_node ?? registered!.snapshot);
      const declaredTarget = z.object({ execution: z.object({ session: z.object({ supervisorEpoch: z.uuid() }) }) }).safeParse(command.payload);
      if (command.operation === 'submit' && declaredTarget.success
        && declaredTarget.data.execution.session.supervisorEpoch !== targetNode.supervisorEpoch) fail('forbidden');
      let cancellation: unknown = null;
      if (session?.state === 'cancelled') {
        if (command.operation !== 'stop') fail('forbidden');
        cancellation = session.result;
      } else if (session?.state === 'pending' && command.operation === 'stop') {
        // Locking the original submit also fences a concurrent claim. Only an unclaimed
        // start is known not to have dispatched; a claimed start must still be stopped remotely.
        const original = z.object({ execution: executionQuerySchema }).safeParse(
          JSON.parse(String(session.command_text)).payload);
        cancellation = original.success ? executionQuerySchema.parse({ ...original.data.execution,
          state: 'cancelled', statusKnowledge: 'confirmed', stopRequested: true,
          confirmedSeq: original.data.execution.confirmedSeq + 1 })
          : { state: 'cancelled', statusKnowledge: 'confirmed' };
        await tx.query("UPDATE native_channel_commands SET state='cancelled',result=$2 WHERE command_id=$1",
          [session.command_id, JSON.stringify(cancellation)]);
      }
      await tx.query(`INSERT INTO native_channel_commands(command_id,connection_id,activity_id,session_id,operation,command,command_text,input_digest,state,target_node,target_generation)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10)`, [command.commandId, connectionId, command.activityId, command.sessionId,
        command.operation, JSON.stringify(command), JSON.stringify(command), hash(command), JSON.stringify(targetNode), session?.target_generation ?? storage.generation]);
      if (cancellation) await tx.query("UPDATE native_channel_commands SET state='cancelled',result=$2 WHERE command_id=$1",
        [command.commandId, JSON.stringify(cancellation)]);
      return { commandId: command.commandId, state: cancellation ? 'cancelled' : 'pending' };
    });
    return receipt.result;
  }
  async function eligibleActivities(identity: SpaceIdentity, connectionId: string) {
    const { rows } = await storage.read(`SELECT DISTINCT activity_id FROM native_channel_commands c JOIN native_channel_nodes n ON n.connection_id=c.connection_id
      WHERE c.connection_id=$1 AND c.target_node=n.snapshot AND c.target_generation=n.owner_generation
      AND (state<>'reported' OR result->>'state' IN ('queued','running','paused','stopping'))
      AND NOT EXISTS(SELECT 1 FROM native_channel_commands p WHERE p.connection_id=c.connection_id AND p.session_id=c.session_id
        AND (p.state IN ('reported','cancelled') OR p.observed_result IS NOT NULL) AND COALESCE(p.observed_result,p.result)->>'state' IN ('succeeded','failed','cancelled','stopped'))`, [connectionId]);
    for (const activity of rows) await options.authorize(identity, String(activity.activity_id));
  }
  async function heartbeat(token: string, value: unknown) {
    const wrapped = z.object({ node: nodeSchema, queries: z.array(executionQuerySchema).max(256).optional() }).strict().safeParse(value);
    const { input, identity } = await node(token, wrapped.success ? wrapped.data.node : value);
    const queries = wrapped.success ? wrapped.data.queries ?? [] : [];
    const terminalOnly = !dispatchOpen;
    if (terminalOnly && (!queries.length || queries.some(query => query.statusKnowledge !== 'confirmed'
      || !isTerminalExecutionState(query.state)))) fail('unavailable');
    if (!terminalOnly) await eligibleActivities(identity, input.connectionId);
    await storage.request({ requestId: `native-channel-lease:${randomUUID()}`, fingerprint: hash({ input, queries }) }, async tx => {
      // Closing can race authentication or transaction admission. Never renew a lease after it.
      if (!dispatchOpen && (!queries.length || queries.some(query => query.statusKnowledge !== 'confirmed'
        || !isTerminalExecutionState(query.state)))) fail('unavailable');
      if (dispatchOpen) {
        const renewed = await tx.query(`UPDATE native_channel_nodes SET lease_until=clock_timestamp()+$2*interval '1 millisecond'
          WHERE connection_id=$1 AND snapshot=$3::jsonb AND owner_generation=$4`,
          [input.connectionId, leaseMs, JSON.stringify(input), storage.generation]);
        if (renewed.rowCount !== 1) fail('forbidden');
      }
      for (const observed of queries) {
        const { rows: [row] } = await tx.query(`SELECT * FROM native_channel_commands WHERE connection_id=$1 AND session_id=$2
          AND operation='submit' FOR UPDATE`, [input.connectionId, observed.executionRef]);
        if (!row || row.claim_id === null || hash(row.claim_node) !== hash(input)
          || row.claim_generation !== storage.generation) return fail('forbidden');
        const original = z.object({ execution: executionQuerySchema }).parse(JSON.parse(String(row.command_text)).payload).execution;
        assertObservationIdentity(original, observed);
        if (observed.scope.environmentId !== identity.environmentId || observed.scope.spaceId !== identity.spaceId
          || observed.scope.principalId !== identity.principalId) return fail('forbidden');
        if (hash(row.target_node) !== hash(input) || row.target_generation !== storage.generation) return fail('forbidden');
        if (observed.session!.nodeId !== input.nodeId || observed.session!.installGeneration !== input.installationId
          || observed.session!.supervisorEpoch !== input.supervisorEpoch) return fail('forbidden');
        await options.authorize(identity, String(row.activity_id));
        let current = original;
        const { rows: facts } = await tx.query(`SELECT result FROM native_channel_commands WHERE connection_id=$1 AND session_id=$2
          AND state='reported' ORDER BY position`, [input.connectionId, observed.executionRef]);
        for (const fact of facts) {
          const parsed = executionQuerySchema.safeParse(fact.result);
          if (parsed.success) current = advanceExecution(current, parsed.data);
        }
        if (row.observed_result !== null) current = advanceExecution(current, executionQuerySchema.parse(row.observed_result));
        if (observed.confirmedSeq < current.confirmedSeq || observed.confirmedSeq === current.confirmedSeq && observed.statusKnowledge === 'confirmed'
          || observed.session!.appliedSeq < current.session!.appliedSeq
          || isTerminalExecutionState(current.state) && current.statusKnowledge === 'confirmed') continue;
        const merged = advanceExecution(current, observed);
        if (hash(merged) === hash(current) && row.observed_result !== null) continue;
        await tx.query('UPDATE native_channel_commands SET observed_result=$2,observed_seq=$3 WHERE command_id=$1',
          [row.command_id, JSON.stringify(merged), merged.confirmedSeq]);
      }
      return null;
    });
    return { leaseMs };
  }
  async function claim(token: string, value: unknown) {
    const { input, identity } = await node(token, value);
    if (!dispatchOpen) fail('unavailable');
    await heartbeat(token, input);
    const { rows } = await storage.read(`SELECT command_text FROM native_channel_commands c WHERE connection_id=$1 AND state='pending'
      AND c.target_node=$3::jsonb AND c.target_generation=$4
      AND EXISTS(SELECT 1 FROM native_channel_commands s WHERE s.connection_id=c.connection_id AND s.session_id=c.session_id
        AND s.operation='submit' AND COALESCE(s.command#>>'{payload,execution,session,supervisorEpoch}',$2)=$2)
      AND (c.operation='stop' OR NOT EXISTS(SELECT 1 FROM native_channel_commands p WHERE p.connection_id=c.connection_id
        AND p.session_id=c.session_id AND p.position<c.position AND p.state<>'reported'))
      ORDER BY position LIMIT 1`, [input.connectionId, input.supervisorEpoch, JSON.stringify(input), storage.generation]);
    if (!rows[0]) return { command: null, leaseMs };
    const candidate = commandSchema.parse(JSON.parse(String(rows[0].command_text)));
    await options.authorize(identity, candidate.activityId);
    const result = await storage.request({ requestId: `native-channel-claim:${randomUUID()}`, fingerprint: hash({ input, commandId: candidate.commandId }) }, async tx => {
      // 同一会话的前一动作尚未报告时，后续控制不能越过它。已领取动作永不重新派发。
      const { rows: [row] } = await tx.query(`SELECT * FROM native_channel_commands c WHERE command_id=$1 AND state='pending'
        AND c.target_node=$2::jsonb AND c.target_generation=$3
        AND (c.operation='stop' OR NOT EXISTS(SELECT 1 FROM native_channel_commands p WHERE p.connection_id=c.connection_id
          AND p.session_id=c.session_id AND p.position<c.position AND p.state<>'reported')) FOR UPDATE`, [candidate.commandId, JSON.stringify(input), storage.generation]);
      if (!row) return null;
      await node(token, input);
      await options.authorize(identity, candidate.activityId);
      if (!dispatchOpen) fail('unavailable');
      const claimId = randomUUID();
      await tx.query("UPDATE native_channel_commands SET state='claimed',claim_id=$2,claim_generation=$3,claim_node=$4 WHERE command_id=$1", [candidate.commandId, claimId, storage.generation, JSON.stringify(input)]);
      return { commandText: String(row.command_text), claimId, node: input, owner: storage.owner, generation: storage.generation };
    });
    if (result.result === null) return { command: null, leaseMs };
    const claimed = z.object({ commandText: z.string(), claimId: z.uuid(), node: nodeSchema,
      owner: z.object({ environmentId: z.uuid(), serviceId: z.uuid() }), generation: z.string() }).parse(result.result);
    return { command: { ...commandSchema.parse(JSON.parse(claimed.commandText)), claimId: claimed.claimId,
      node: claimed.node, owner: claimed.owner, generation: claimed.generation }, leaseMs };
  }
  async function report(token: string, value: unknown) {
    const input = z.object({ node: nodeSchema, commandId: z.uuid(), claimId: z.uuid(), result: z.json().refine(result => result !== null) }).strict().parse(value);
    const identity = await options.authenticate(token, input.node.connectionId);
    const { rows: [registered] } = await storage.read('SELECT * FROM native_channel_nodes WHERE connection_id=$1', [input.node.connectionId]);
    if (!registered || registered.node_id !== input.node.nodeId || registered.installation_id !== input.node.installationId
      || !same(spaceIdentitySchema.parse(registered.identity), identity)) return fail('forbidden');
    const { rows: [row] } = await storage.read('SELECT * FROM native_channel_commands WHERE command_id=$1 AND connection_id=$2', [input.commandId, input.node.connectionId]);
    if (!row || row.claim_id !== input.claimId || hash(nodeSchema.parse(row.claim_node)) !== hash(input.node)) return fail('forbidden');
    await options.authorize(identity, String(row.activity_id));
    if (row.claim_generation !== storage.generation || hash(registered.snapshot) !== hash(input.node)) {
      await storage.request({ requestId: `native-channel-late:${input.commandId}:${hash(input)}`, fingerprint: hash(input) }, async tx => {
        await tx.query(`INSERT INTO native_channel_late_reports(command_id,claim_id,report_digest,node,result) VALUES($1,$2,$3,$4,$5)
          ON CONFLICT DO NOTHING`, [input.commandId, input.claimId, hash(input), JSON.stringify(input.node), JSON.stringify(input.result)]);
        return null;
      });
      return fail('forbidden');
    }
    const receipt = await storage.request({ requestId: `native-channel-report:${input.commandId}`, fingerprint: hash(input) }, async tx => {
      const changed = await tx.query(`UPDATE native_channel_commands SET state='reported',result=$3
        WHERE command_id=$1 AND claim_id=$2 AND state='claimed'`, [input.commandId, input.claimId, JSON.stringify(input.result)]);
      if (changed.rowCount !== 1) fail('identity-conflict');
      return { commandId: input.commandId, state: 'reported' };
    });
    return receipt.result;
  }
  async function cleanup(value: unknown) {
    const input = cleanupSchema.parse(value);
    // Possession of an original random claim can acknowledge only that exact submitted instance.
    // It grants no current connection, membership, course, read, registration or dispatch authority.
    if (hash(input.owner) !== hash(storage.owner)) return fail('forbidden');
    const verify = (row: Record<string, unknown> | undefined) => {
      if (!row || row.operation !== 'submit' || row.connection_id !== input.node.connectionId
        || row.claim_id !== input.claimId || row.claim_generation !== input.generation || row.target_generation !== input.generation
        || hash(row.claim_node) !== hash(input.node) || hash(row.target_node) !== hash(input.node)) return fail('forbidden');
      const original = z.object({ execution: executionQuerySchema }).parse(JSON.parse(String(row.command_text)).payload).execution;
      assertObservationIdentity(original, input.query);
      const session = original.session!;
      if (session.nodeId !== input.node.nodeId || session.installGeneration !== input.node.installationId
        || session.supervisorEpoch !== input.node.supervisorEpoch) return fail('forbidden');
      return executionIdentity(original);
    };
    const { rows: [row] } = await storage.read('SELECT * FROM native_channel_commands WHERE command_id=$1', [input.commandId]);
    const identity = verify(row), proofDigest = hash(input);
    const acknowledgement = { commandId: input.commandId, state: 'cleaned' as const };
    const { rows: [existing] } = await storage.read('SELECT * FROM native_channel_cleanups WHERE command_id=$1', [input.commandId]);
    if (existing) {
      if (existing.claim_id !== input.claimId || existing.generation !== input.generation || hash(existing.node) !== hash(input.node)
        || hash(existing.owner) !== hash(input.owner) || hash(existing.execution_identity) !== hash(identity)) return fail('forbidden');
      if (existing.proof_digest !== proofDigest) return fail('identity-conflict');
      // A lost response must remain retryable after closeWrites rotates the current generation.
      return acknowledgement;
    }
    const receipt = await storage.request({ requestId: `native-channel-cleanup:${input.commandId}:${input.claimId}`, fingerprint: proofDigest }, async tx => {
      const { rows: [claimed] } = await tx.query('SELECT * FROM native_channel_commands WHERE command_id=$1 FOR UPDATE', [input.commandId]);
      verify(claimed);
      await tx.query(`INSERT INTO native_channel_cleanups(command_id,claim_id,node,owner,generation,execution_identity,proof_digest)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [input.commandId, input.claimId, JSON.stringify(input.node), JSON.stringify(input.owner),
        input.generation, JSON.stringify(identity), proofDigest]);
      return acknowledgement;
    });
    return receipt.result;
  }
  async function query(identity: SpaceIdentity, commandId: string) {
    z.uuid().parse(commandId);
    const { rows: [row] } = await storage.read(`SELECT c.*,n.identity,n.owner_generation,n.snapshot,n.lease_until>clock_timestamp() AS lease_valid,
      EXISTS(SELECT 1 FROM native_channel_cleanups k JOIN native_channel_commands s ON s.command_id=k.command_id
        WHERE s.connection_id=c.connection_id AND s.session_id=c.session_id AND s.operation='submit'
        AND k.claim_id=s.claim_id AND k.node=s.claim_node AND k.node=s.target_node
        AND k.generation=s.claim_generation AND k.generation=s.target_generation AND k.owner=$2::jsonb) AS cleaned,
      (SELECT s.command#>>'{payload,execution,session,supervisorEpoch}' FROM native_channel_commands s
        WHERE s.connection_id=c.connection_id AND s.session_id=c.session_id AND s.operation='submit' LIMIT 1) AS session_epoch FROM native_channel_commands c
      JOIN native_channel_nodes n USING(connection_id) WHERE command_id=$1`, [commandId, JSON.stringify(storage.owner)]);
    if (!row || !same(spaceIdentitySchema.parse(row.identity), identity)) return fail('missing');
    await options.authorizeConnection(identity, String(row.connection_id));
    await options.authorize(identity, String(row.activity_id));
    let projected = row.result;
    const observation = executionQuerySchema.safeParse(row.observed_result);
    if (observation.success) {
      const accepted = executionQuerySchema.safeParse(row.result);
      projected = advanceExecution(accepted.success ? accepted.data : null, observation.data);
    }
    // A checkpoint keeps its immutable snapshot beside the execution query. Fence the
    // nested query just like a plain report, or an old wrapper can reconfirm a lost instance.
    const checkpoint = z.object({ query: executionQuerySchema, checkpoint: z.json() }).strict().safeParse(projected);
    const result = (checkpoint.success ? checkpoint.data.query : projected) as Record<string, unknown> | null;
    const active = result && ['queued', 'running', 'paused'].includes(String(result.state));
    const targetChanged = hash(row.target_node) !== hash(row.snapshot) || row.target_generation !== storage.generation;
    const unavailable = row.state === 'pending' && targetChanged || active && (row.cleaned || !row.lease_valid || row.claim_generation !== storage.generation
      || hash(row.claim_node) !== hash(row.snapshot));
    if (unavailable && result) {
      const fenced = { ...result, statusKnowledge: 'unknown', reason: result.reason ?? {
        code: 'resource-unavailable', detail: '原执行节点的租约、代际或退出状态已变化，保留原执行身份等待核实。',
      } };
      projected = checkpoint.success ? { ...checkpoint.data, query: fenced } : fenced;
    }
    return { commandId, state: row.state,
      result: projected,
      statusKnowledge: row.state === 'claimed' && !observation.success || unavailable ? 'unknown' : 'confirmed' };
  }
  async function nodes(identity: SpaceIdentity) {
    const { rows } = await storage.read('SELECT * FROM native_channel_nodes WHERE owner_generation=$1 AND lease_until>clock_timestamp() ORDER BY node_id,connection_id', [storage.generation]);
    const result: NativeChannelNode[] = [];
    for (const row of rows) {
      if (!same(spaceIdentitySchema.parse(row.identity), identity)) continue;
      try { await options.authorizeConnection(identity, String(row.connection_id)); }
      catch (error) { if (error instanceof StorageError && error.code === 'forbidden') continue; throw error; }
      result.push(nodeSchema.parse(row.snapshot));
    }
    return result;
  }
  async function drain() {
    const deadline = Date.now() + 20000;
    for (;;) {
      // Lease expiry proves loss of contact only. Each claimed submit needs a confirmed
      // terminal query from its original executor identity, even after a node replacement.
      const { rows } = await storage.read(`SELECT s.command_text,s.observed_result,
        (SELECT k.execution_identity FROM native_channel_cleanups k WHERE k.command_id=s.command_id
          AND k.claim_id=s.claim_id AND k.node=s.claim_node AND k.node=s.target_node
          AND k.generation=s.claim_generation AND k.generation=s.target_generation AND k.owner=$1::jsonb) AS cleaned_identity,
        (SELECT COALESCE(jsonb_agg(c.result),'[]'::jsonb) FROM native_channel_commands c
          WHERE c.connection_id=s.connection_id AND c.session_id=s.session_id AND c.state='reported'
          AND c.claim_node=s.claim_node AND c.claim_generation=s.claim_generation
          AND c.target_node=s.target_node AND c.target_generation=s.target_generation) AS facts
        FROM native_channel_commands s WHERE s.operation='submit' AND s.claim_id IS NOT NULL`, [JSON.stringify(storage.owner)]);
      const stopped = rows.every(row => {
        const original = z.object({ execution: executionQuerySchema }).safeParse(JSON.parse(String(row.command_text)).payload);
        if (!original.success) return false;
        if (row.cleaned_identity && hash(row.cleaned_identity) === hash(executionIdentity(original.data.execution))) return true;
        return [...row.facts as unknown[], row.observed_result].some(value => {
          const fact = executionQuerySchema.safeParse(value);
          if (!fact.success || fact.data.statusKnowledge !== 'confirmed' || !isTerminalExecutionState(fact.data.state)) return false;
          try { assertObservationIdentity(original.data.execution, fact.data); }
          catch { return false; }
          return true;
        });
      });
      if (stopped) return;
      if (Date.now() >= deadline) fail('unavailable');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  return { register, enqueue, claim, report, query, nodes, heartbeat, cleanup, drain,
    closeDispatch() { dispatchOpen = false; }, resume() { dispatchOpen = true; } };
}

export async function validateNativeChannel(storage: OwnedStorage) {
  const { rows: nodes } = await storage.read('SELECT * FROM native_channel_nodes');
  for (const row of nodes) {
    nodeSchema.parse(row.snapshot);
    spaceIdentitySchema.parse(row.identity); z.string().min(1).max(128).parse(row.owner_generation);
  }
  const { rows } = await storage.read('SELECT * FROM native_channel_commands');
  for (const row of rows) {
    const command = commandSchema.parse(JSON.parse(String(row.command_text)));
    const target = nodeSchema.parse(row.target_node);
    z.string().min(1).max(128).parse(row.target_generation);
    if (target.connectionId !== row.connection_id || row.claim_node !== null && hash(row.claim_node) !== hash(target)) throw new StorageError('corrupt');
    if (hash(command) !== hash(row.command) || command.commandId !== row.command_id || command.activityId !== row.activity_id || command.sessionId !== row.session_id
      || command.operation !== row.operation || hash(command) !== row.input_digest
      || (row.state === 'pending' || row.state === 'cancelled') !== (row.claim_id === null)
      || (row.state === 'pending' || row.state === 'cancelled') !== (row.claim_generation === null)
      || (row.state === 'pending' || row.state === 'cancelled') !== (row.claim_node === null)
      || (row.state === 'reported' || row.state === 'cancelled') !== (row.result !== null)) throw new StorageError('corrupt');
    if (row.observed_result !== null) {
      const observation = executionQuerySchema.parse(row.observed_result);
      const original = z.object({ execution: executionQuerySchema }).parse(command.payload).execution;
      try { assertObservationIdentity(original, observation); } catch { throw new StorageError('corrupt'); }
      if (row.operation !== 'submit' || observation.confirmedSeq !== Number(row.observed_seq)
        || observation.confirmedSeq < original.confirmedSeq) throw new StorageError('corrupt');
    }
  }
  const { rows: cleanups } = await storage.read(`SELECT k.*,to_jsonb(c) AS claimed FROM native_channel_cleanups k
    JOIN native_channel_commands c ON c.command_id=k.command_id`);
  for (const cleanup of cleanups) {
    try {
      const row = cleanup.claimed as Record<string, unknown>, node = nodeSchema.parse(cleanup.node);
      const original = z.object({ execution: executionQuerySchema }).parse(JSON.parse(String(row.command_text)).payload).execution;
      const session = original.session;
      if (row.operation !== 'submit' || row.claim_id !== cleanup.claim_id || row.connection_id !== node.connectionId
        || row.claim_generation !== cleanup.generation || row.target_generation !== cleanup.generation
        || hash(row.claim_node) !== hash(node) || hash(row.target_node) !== hash(node) || hash(cleanup.owner) !== hash(storage.owner)
        || !session || session.nodeId !== node.nodeId || session.installGeneration !== node.installationId || session.supervisorEpoch !== node.supervisorEpoch
        || hash(cleanup.execution_identity) !== hash(executionIdentity(original)) || !/^[0-9a-f]{64}$/.test(String(cleanup.proof_digest))) throw new StorageError('corrupt');
    } catch { throw new StorageError('corrupt'); }
  }
}
