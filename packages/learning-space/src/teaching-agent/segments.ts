import { randomUUID } from 'node:crypto';
import { StorageError, type Migration, type OwnedStorage, type OwnedTransaction } from '@xunjie/storage';
import { spaceIdentitySchema, type SpaceIdentity } from '@xunjie/contracts/spaces';
import type { TeachingRun } from '@xunjie/contracts/teaching-agent';
import { resolvedAgentSchema, teachingModelFactSchema, teachingModelSwitchSchema, type ResolvedAgent } from '@xunjie/contracts/teaching-agent';
import { modelSegmentInputSchema } from '@xunjie/contracts/model-connections';
import type { LearningModelPort } from '../model-connections/service.js';
import { parseLearningModelResult } from '../model-connections/service.js';
import { canonicalDigest } from './identity.js';
import { retainTeachingAssembly } from './assembly.js';

export const teachingSegmentMigration: Migration = { version: 9, name: 'durable-teaching-segment-transitions', sql: `
  ALTER TABLE teaching_sessions ADD COLUMN segment_assembly_id text, ADD COLUMN segment_transition_id uuid;
  CREATE TABLE teaching_segment_transitions(
    transition_id uuid PRIMARY KEY, activity_id uuid NOT NULL REFERENCES teaching_sessions(activity_id),
    reason text NOT NULL CHECK(reason IN ('initial','assembly-change','model-switch')),
    state text NOT NULL CHECK(state IN ('accepted','completed')), identity jsonb NOT NULL,
    from_segment_id uuid, to_segment_id uuid NOT NULL UNIQUE, assembly_id text,
    fingerprint text NOT NULL, selection_version integer NOT NULL, target jsonb NOT NULL, resolved_agent jsonb,
    close_request_id uuid NOT NULL UNIQUE, create_request_id uuid NOT NULL UNIQUE, create_body jsonb NOT NULL,
    close_sequence bigint, close_result jsonb, create_result jsonb,
    lease_owner text, lease_expires_at timestamptz, authority_key text, generation integer NOT NULL DEFAULT 0,
    last_error text NOT NULL DEFAULT '', accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz);
  CREATE UNIQUE INDEX teaching_segment_transitions_pending ON teaching_segment_transitions(activity_id) WHERE state='accepted';
  CREATE INDEX teaching_segment_transitions_activity ON teaching_segment_transitions(activity_id,accepted_at);
` };

type NativeSegment = Awaited<ReturnType<LearningModelPort['segments']['read']>>;
export type TeachingSegmentTarget = { model: NonNullable<TeachingRun['model']>;
  source: { kind: 'school' | 'personal'; feeSource: string } };
export interface TeachingSegmentTransition {
  transitionId: string;
  activityId: string;
  reason: 'initial' | 'assembly-change' | 'model-switch';
  state: 'accepted' | 'completed';
  identity: SpaceIdentity;
  fromSegmentId: string | null;
  toSegmentId: string;
  assemblyId: string | null;
  fingerprint: string;
  selectionVersion: number;
  target: TeachingSegmentTarget;
  resolvedAgent: ResolvedAgent | null;
  closeRequestId: string;
  createRequestId: string;
  createBody: ReturnType<typeof modelSegmentInputSchema.parse>;
  closeSequence: number | null;
  closeResult: NativeSegment | null;
  createResult: NativeSegment | null;
}
type ReceiveTransition = Omit<TeachingSegmentTransition, 'state' | 'closeSequence' | 'closeResult' | 'createResult'>;
type Authority = { key: string; assert(tx: OwnedTransaction): Promise<unknown> };

function project(row: Record<string, unknown>): TeachingSegmentTransition {
  const transition: TeachingSegmentTransition = { transitionId: String(row.transition_id), activityId: String(row.activity_id),
    reason: row.reason as TeachingSegmentTransition['reason'], state: row.state as TeachingSegmentTransition['state'],
    identity: spaceIdentitySchema.parse(row.identity), fromSegmentId: row.from_segment_id as string | null,
    toSegmentId: String(row.to_segment_id), assemblyId: row.assembly_id as string | null,
    fingerprint: String(row.fingerprint), selectionVersion: Number(row.selection_version),
    target: { model: teachingModelFactSchema.parse((row.target as TeachingSegmentTarget).model),
      source: teachingModelSwitchSchema.shape.source.parse((row.target as TeachingSegmentTarget).source) },
    resolvedAgent: row.resolved_agent ? resolvedAgentSchema.parse(row.resolved_agent) : null,
    closeRequestId: String(row.close_request_id),
    createRequestId: String(row.create_request_id), createBody: modelSegmentInputSchema.parse(row.create_body),
    closeSequence: row.close_sequence == null ? null : Number(row.close_sequence),
    closeResult: row.close_result ? parseLearningModelResult('segments.read', row.close_result) as NativeSegment : null,
    createResult: row.create_result ? parseLearningModelResult('segments.read', row.create_result) as NativeSegment : null };
  checkReceived(transition);
  return transition;
}

function sameModel(segment: NativeSegment, target: TeachingSegmentTarget) {
  return segment.connection.connectionId === target.model.connectionId && segment.connection.version === target.model.version
    && segment.connection.protocol === target.model.protocol && segment.connection.modelId === target.model.modelId;
}

function checkReceived(row: ReceiveTransition) {
  const body = row.createBody;
  if (body.segmentId !== row.toSegmentId || body.requestId !== row.createRequestId
    || row.fromSegmentId === row.toSegmentId || (body.previousSegmentId ?? null) !== row.fromSegmentId || body.purpose !== 'learning'
    || !['initial', 'assembly-change', 'model-switch'].includes(row.reason)
    || row.reason === 'initial' && row.fromSegmentId !== null || row.reason === 'assembly-change' && !row.fromSegmentId
    || 'selected' in body.source && body.source.selectionVersion !== row.selectionVersion) throw new StorageError('corrupt');
  if (row.resolvedAgent && (row.assemblyId !== row.resolvedAgent.resolvedId
    || canonicalDigest(row.resolvedAgent.model) !== canonicalDigest(row.target.model)
    || canonicalDigest({ system: row.resolvedAgent.prompt.system, tools: row.resolvedAgent.tools.map(tool => tool.definition) }) !== canonicalDigest(body.prefix)))
    throw new StorageError('corrupt');
}

/** One owner ledger for initial segments, changed assemblies and explicit model switches.
 * External operations never run under an owner transaction. All identities and bytes are
 * received first; an uncertain operation is reconciled by reading that same native segment.
 */
export function createTeachingSegments(storage: OwnedStorage, owner: {
  models: LearningModelPort;
  leaseMs: number;
  assertWritable(): void;
}) {
  async function read(transitionId: string) {
    const { rows: [row] } = await storage.read('SELECT * FROM teaching_segment_transitions WHERE transition_id=$1', [transitionId]);
    if (!row) throw new StorageError('missing');
    return project(row);
  }
  async function pending(activityId: string) {
    const { rows: [row] } = await storage.read("SELECT * FROM teaching_segment_transitions WHERE activity_id=$1 AND state='accepted'", [activityId]);
    return row ? project(row) : null;
  }
  async function receive(tx: OwnedTransaction, input: ReceiveTransition) {
    owner.assertWritable();
    input = { ...input, createBody: modelSegmentInputSchema.parse(input.createBody) };
    if (input.assemblyId && !input.resolvedAgent) {
      const { rows: [resolved] } = await tx.query('SELECT body FROM teaching_resolved_agents WHERE resolved_id=$1', [input.assemblyId]);
      if (!resolved) throw new StorageError('corrupt');
      input.resolvedAgent = resolvedAgentSchema.parse(resolved.body);
    }
    checkReceived(input);
    const body = input.createBody;
    const { rows: [session] } = await tx.query('SELECT segment_id FROM teaching_sessions WHERE activity_id=$1 FOR UPDATE', [input.activityId]);
    if (!session) throw new StorageError('missing');
    const { rows: [prior] } = await tx.query('SELECT * FROM teaching_segment_transitions WHERE transition_id=$1', [input.transitionId]);
    if (prior) {
      const existing = project(prior);
      const { state: _state, closeSequence: _sequence, closeResult: _closed, createResult: _created, ...fixed } = existing;
      if (canonicalDigest(fixed) !== canonicalDigest(input)) throw new StorageError('identity-conflict');
      return existing;
    }
    if (session.segment_id !== input.fromSegmentId) throw new StorageError('conflict');
    const { rows: competing } = await tx.query("SELECT transition_id FROM teaching_segment_transitions WHERE activity_id=$1 AND state='accepted'", [input.activityId]);
    if (competing.length) throw new StorageError('resource-busy');
    const { rows: [inserted] } = await tx.query(`INSERT INTO teaching_segment_transitions(
      transition_id,activity_id,reason,state,identity,from_segment_id,to_segment_id,assembly_id,fingerprint,
      selection_version,target,close_request_id,create_request_id,create_body,resolved_agent)
      VALUES($1,$2,$3,'accepted',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [input.transitionId, input.activityId, input.reason, JSON.stringify(input.identity), input.fromSegmentId,
      input.toSegmentId, input.assemblyId, input.fingerprint, input.selectionVersion, JSON.stringify(input.target),
      input.closeRequestId, input.createRequestId, JSON.stringify(body), input.resolvedAgent ? JSON.stringify(input.resolvedAgent) : null]);
    return project(inserted!);
  }
  async function advance(identity: SpaceIdentity, transitionId: string, authority: Authority,
    completed?: (tx: OwnedTransaction, transition: TeachingSegmentTransition, segment: NativeSegment) => Promise<void>) {
    const before = await read(transitionId);
    if (canonicalDigest(identity) !== canonicalDigest(before.identity)) throw new StorageError('forbidden');
    if (before.state === 'completed') return before;
    owner.assertWritable();
    // A fresh token distinguishes concurrent invocations even within the same process.
    const token = randomUUID();
    const claim = await storage.request({ requestId: 'teaching-transition-claim:' + token, fingerprint: transitionId }, async tx => {
      owner.assertWritable(); await authority.assert(tx);
      const { rows: [claimed] } = await tx.query(`UPDATE teaching_segment_transitions SET lease_owner=$2,
        lease_expires_at=clock_timestamp()+($3 || ' milliseconds')::interval,authority_key=$4,generation=generation+1
        WHERE transition_id=$1 AND state='accepted' AND (lease_owner IS NULL OR lease_expires_at<clock_timestamp()
          OR authority_key IS DISTINCT FROM $4) RETURNING generation`,
      [transitionId, token, String(owner.leaseMs), authority.key]);
      return claimed ? Number(claimed.generation) : null;
    });
    if (claim.result === null) {
      const current = await read(transitionId);
      if (current.state === 'completed') return current;
      throw new StorageError('resource-busy');
    }
    const generation = Number(claim.result);
    async function guarded(tx: OwnedTransaction) {
      owner.assertWritable(); await authority.assert(tx);
      const { rows: [locked] } = await tx.query(`SELECT * FROM teaching_segment_transitions WHERE transition_id=$1
        AND lease_owner=$2 AND generation=$3 AND lease_expires_at>=clock_timestamp() FOR UPDATE`, [transitionId, token, generation]);
      if (!locked || locked.state !== 'accepted') throw new StorageError('conflict');
      const { rows: [session] } = await tx.query('SELECT segment_id FROM teaching_sessions WHERE activity_id=$1 FOR UPDATE', [locked.activity_id]);
      if (!session || session.segment_id !== locked.from_segment_id) throw new StorageError('conflict');
      return project(locked);
    }
    async function commit(stage: string, effect: (tx: OwnedTransaction, current: TeachingSegmentTransition) => Promise<void>) {
      await storage.request({ requestId: `teaching-transition:${transitionId}:${generation}:${stage}`,
        fingerprint: transitionId }, async tx => { const current = await guarded(tx); await effect(tx, current); return null; });
    }
    let renewing = true;
    const heartbeat = setInterval(() => {
      if (!renewing) return;
      void storage.request({ requestId: 'teaching-transition-heartbeat:' + randomUUID(), fingerprint: transitionId }, async tx => {
        owner.assertWritable(); await authority.assert(tx);
        await tx.query(`UPDATE teaching_segment_transitions SET lease_expires_at=clock_timestamp()+($4 || ' milliseconds')::interval
          WHERE transition_id=$1 AND lease_owner=$2 AND generation=$3`, [transitionId, token, generation, String(owner.leaseMs)]);
        return null;
      }).catch(() => {});
    }, Math.max(25, Math.floor(owner.leaseMs / 3)));
    heartbeat.unref();
    try {
      let current = await read(transitionId);
      if (current.fromSegmentId) {
        const old = await owner.models.segments.read(identity, current.fromSegmentId);
        if (old.pending || old.pendingTools.length) throw new StorageError('resource-busy');
        if (current.closeSequence !== null && old.sequence !== current.closeSequence) throw new StorageError('conflict');
        await commit('close-input', async (tx, row) => {
          await tx.query('UPDATE teaching_segment_transitions SET close_sequence=$2 WHERE transition_id=$1', [transitionId, row.closeSequence ?? old.sequence]);
        });
        if (!old.closed) {
          owner.assertWritable();
          await owner.models.segments.close(identity, current.fromSegmentId, { requestId: current.closeRequestId, expectedSequence: old.sequence });
        }
        const closed = await owner.models.segments.read(identity, current.fromSegmentId);
        if (!closed.closed || closed.pending || closed.pendingTools.length || closed.sequence !== old.sequence) throw new StorageError('conflict');
        await commit('closed', async tx => {
          await tx.query('UPDATE teaching_segment_transitions SET close_result=$2,updated_at=clock_timestamp() WHERE transition_id=$1', [transitionId, JSON.stringify(closed)]);
        });
      }
      let created: NativeSegment;
      try { created = await owner.models.segments.read(identity, current.toSegmentId); }
      catch (error) {
        if (!(error instanceof StorageError) || error.code !== 'missing') throw error;
        // Revalidate authority after reconciliation and before beginning a new external operation.
        await commit('create-permitted', async () => {});
        owner.assertWritable();
        await owner.models.segments.create(identity, current.createBody);
        created = await owner.models.segments.read(identity, current.toSegmentId);
      }
      if (created.segmentId !== current.toSegmentId || created.closed || created.pending || created.pendingTools.length
        || created.sequence !== 0 || created.prefixDigest !== canonicalDigest(current.createBody.prefix)
        || !sameModel(created, current.target))
        throw new StorageError('conflict');
      await commit('completed', async (tx, row) => {
        const { rows: updated } = await tx.query(`UPDATE teaching_sessions SET segment_id=$2,segment_fingerprint=$3,
          selection_version=$4,segment_assembly_id=$5,segment_transition_id=$6,updated_at=clock_timestamp()
          WHERE activity_id=$1 AND segment_id IS NOT DISTINCT FROM $7::uuid RETURNING activity_id`,
        [row.activityId, row.toSegmentId, row.fingerprint, row.selectionVersion, row.assemblyId, transitionId, row.fromSegmentId]);
        if (!updated.length) throw new StorageError('conflict');
        if (row.resolvedAgent) await retainTeachingAssembly(tx, row.resolvedAgent);
        await completed?.(tx, row, created);
        await tx.query(`UPDATE teaching_segment_transitions SET state='completed',create_result=$2,last_error='',
          completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE transition_id=$1`, [transitionId, JSON.stringify(created)]);
      });
      current = await read(transitionId);
      return current;
    } catch (error) {
      await storage.request({ requestId: 'teaching-transition-error:' + randomUUID(), fingerprint: transitionId }, async tx => {
        await tx.query(`UPDATE teaching_segment_transitions SET last_error=$4,updated_at=clock_timestamp()
          WHERE transition_id=$1 AND lease_owner=$2 AND generation=$3 AND state='accepted'`,
        [transitionId, token, generation, error instanceof StorageError ? error.code : 'unavailable']);
        return null;
      }).catch(() => {});
      throw error;
    } finally {
      renewing = false; clearInterval(heartbeat);
      await storage.request({ requestId: 'teaching-transition-release:' + token, fingerprint: transitionId }, async tx => {
        await tx.query('UPDATE teaching_segment_transitions SET lease_owner=NULL,lease_expires_at=NULL WHERE transition_id=$1 AND lease_owner=$2 AND generation=$3', [transitionId, token, generation]);
        return null;
      }).catch(() => {});
    }
  }
  return { pending, read, receive, advance };
}

/** Owner restore validation is pure reading; it never reconciles by replaying Gateway operations. */
export async function validateTeachingSegmentTransitions(storage: OwnedStorage) {
  const { rows } = await storage.read('SELECT * FROM teaching_segment_transitions');
  const { rows: sessions } = await storage.read('SELECT * FROM teaching_sessions');
  const { rows: switches } = await storage.read('SELECT * FROM teaching_model_switches');
  for (const stored of rows) {
    const row = project(stored);
    const session = sessions.find(session => session.activity_id === row.activityId);
    if (!session || !['accepted', 'completed'].includes(row.state)
      || row.closeSequence !== null && (!Number.isSafeInteger(row.closeSequence) || row.closeSequence < 0)
      || row.state === 'accepted' && (session.segment_id !== row.fromSegmentId || stored.completed_at || row.createResult)
      || !row.fromSegmentId && (row.closeSequence !== null || row.closeResult)) throw new StorageError('corrupt');
    if (row.closeResult && (row.closeResult.segmentId !== row.fromSegmentId || !row.closeResult.closed
      || row.closeResult.pending || row.closeResult.pendingTools.length || row.closeResult.sequence !== row.closeSequence)) throw new StorageError('corrupt');
    if (row.state === 'completed' && (!stored.completed_at || !row.createResult
      || row.createResult.segmentId !== row.toSegmentId || row.createResult.sequence !== 0 || row.createResult.closed
      || row.createResult.pending || row.createResult.pendingTools.length
      || row.createResult.prefixDigest !== canonicalDigest(row.createBody.prefix) || !sameModel(row.createResult, row.target)
      || row.fromSegmentId && !row.closeResult)) throw new StorageError('corrupt');
    if (row.assemblyId) {
      const { rows: [assembly] } = await storage.read('SELECT body FROM teaching_resolved_agents WHERE resolved_id=$1', [row.assemblyId]);
      // Accepted switches retain their assembly inside the transition until completion.
      if ((row.state === 'completed' && !assembly) || (assembly && row.resolvedAgent
        && canonicalDigest(assembly.body) !== canonicalDigest(row.resolvedAgent))) throw new StorageError('corrupt');
    }
    if (row.reason === 'model-switch') {
      const legacy = switches.find(item => item.activity_id === row.activityId && item.to_segment_id === row.toSegmentId);
      if (!legacy || legacy.from_segment_id !== row.fromSegmentId || legacy.close_request_id !== row.closeRequestId
        || legacy.create_request_id !== row.createRequestId || canonicalDigest(legacy.create_body) !== canonicalDigest(row.createBody)
        || (legacy.state === 'completed') !== (row.state === 'completed')) throw new StorageError('corrupt');
    }
  }
  for (const session of sessions) {
    if (!session.segment_transition_id) continue; // Sessions created before migration 9 keep their native segment.
    const transition = rows.find(row => row.transition_id === session.segment_transition_id);
    if (!transition || transition.state !== 'completed' || transition.activity_id !== session.activity_id
      || transition.to_segment_id !== session.segment_id || transition.fingerprint !== session.segment_fingerprint
      || transition.assembly_id !== session.segment_assembly_id || transition.selection_version !== session.selection_version) throw new StorageError('corrupt');
  }
}
