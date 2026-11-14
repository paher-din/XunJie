import { createHash } from 'node:crypto';
import { z } from 'zod';
import { StorageError, type Migration, type OwnedStorage } from '@xunjie/storage';
import { agentSessionSchema, createAgentSessionSchema, markAgentSessionReadySchema, updateAgentSessionSchema,
  type AgentSession, type AgentSessionScenario, type AgentSessionWorkspace } from '@xunjie/contracts/agent-sessions';
import { spaceIdentitySchema, type SpaceIdentity } from '@xunjie/contracts/spaces';
import { teachingAgentBindingSchema, type TeachingAgentBinding } from '@xunjie/contracts/teaching-agent';
import { activitySchema } from '@xunjie/contracts/learning-data';

export const agentSessionMigration: Migration = { version: 31, name: 'independent-agent-session-directory', sql: `
  CREATE TABLE agent_session_directory(session_id uuid PRIMARY KEY,
    space_environment_id uuid NOT NULL,space_id uuid NOT NULL,principal_id uuid NOT NULL,
    identity_kind text NOT NULL CHECK(identity_kind IN ('personal','school')),
    workspace_activity_id uuid REFERENCES activities(id),create_digest text NOT NULL,body jsonb NOT NULL);
  CREATE INDEX agent_session_directory_scope ON agent_session_directory(space_environment_id,space_id,principal_id,identity_kind);
  CREATE UNIQUE INDEX agent_session_directory_workspace ON agent_session_directory
    (space_environment_id,space_id,principal_id,identity_kind,workspace_activity_id) WHERE workspace_activity_id IS NOT NULL;
` };

export interface AgentSessionHost {
  authorize(identity: SpaceIdentity): Promise<unknown>;
  openActivity(identity: SpaceIdentity, activityId: string): Promise<unknown>;
  resolveOwner(identity: SpaceIdentity, scenario: AgentSessionScenario, workspace?: AgentSessionWorkspace): Promise<TeachingAgentBinding>;
}
const scope = (identity: SpaceIdentity) => [identity.environmentId, identity.spaceId, identity.principalId, identity.kind];
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sameSubject = (a: SpaceIdentity, b: SpaceIdentity) => scope(a).every((value, index) => value === scope(b)[index]);
function directorySession(row: Record<string, unknown>): AgentSession {
  const parsed = agentSessionSchema.safeParse(row.body);
  if (!parsed.success) throw new StorageError('corrupt');
  const session = parsed.data;
  if (session.sessionId !== row.session_id || session.identity.environmentId !== row.space_environment_id
    || session.identity.spaceId !== row.space_id || session.identity.principalId !== row.principal_id
    || session.identity.kind !== row.identity_kind || (session.workspace?.activityId ?? null) !== row.workspace_activity_id
    || typeof row.create_digest !== 'string' || !/^[a-f0-9]{64}$/.test(row.create_digest)) throw new StorageError('corrupt');
  return session;
}

/** The data owner retains the directory; initialization and Agent execution belong to the host. */
export function createAgentSessions(storage: OwnedStorage, host: AgentSessionHost) {
  async function authorize(value: SpaceIdentity) {
    const identity = spaceIdentitySchema.parse(value);
    await host.authorize(identity);
    return identity;
  }
  async function checkWorkspace(identity: SpaceIdentity, workspace?: AgentSessionWorkspace) {
    if (!workspace) return;
    const activity = activitySchema.parse(await host.openActivity(identity, workspace.activityId));
    if (activity.activityId !== workspace.activityId || !sameSubject(activity.identity, identity)
      || activity.target.environmentId !== workspace.target.environmentId || activity.target.serviceId !== workspace.target.serviceId
      || activity.target.version !== workspace.target.version || activity.target.environmentId !== storage.owner.environmentId
      || activity.target.serviceId !== storage.owner.serviceId) throw new StorageError('forbidden');
  }
  function stored(row: Record<string, unknown>, identity: SpaceIdentity): AgentSession {
    const session = directorySession(row);
    if (!sameSubject(session.identity, identity)) throw new StorageError('forbidden');
    return session;
  }
  async function read(value: SpaceIdentity, sessionId: string): Promise<AgentSession> {
    const identity = await authorize(value); z.uuid().parse(sessionId);
    const { rows: [row] } = await storage.read('SELECT * FROM agent_session_directory WHERE session_id=$1', [sessionId]);
    if (!row) throw new StorageError('missing');
    const session = stored(row, identity);
    await checkWorkspace(identity, session.workspace);
    return session;
  }
  /** Includes metadata tombstones; only currently authorized workspace references are visible. */
  async function list(value: SpaceIdentity): Promise<AgentSession[]> {
    const identity = await authorize(value);
    const { rows } = await storage.read(`SELECT * FROM agent_session_directory WHERE space_environment_id=$1
      AND space_id=$2 AND principal_id=$3 AND identity_kind=$4 ORDER BY session_id`, scope(identity));
    const visible: AgentSession[] = [];
    for (const row of rows) {
      const session = stored(row, identity);
      try { await checkWorkspace(identity, session.workspace); }
      catch (error) {
        if (error instanceof StorageError && ['forbidden', 'missing'].includes(error.code)) continue;
        throw error;
      }
      visible.push(session);
    }
    return visible;
  }
  async function create(value: SpaceIdentity, valueInput: unknown): Promise<AgentSession> {
    const identity = await authorize(value), input = createAgentSessionSchema.parse(valueInput);
    const request = { requestId: `agent-session:${digest(scope(identity))}:${input.requestId}`,
      fingerprint: digest({ scope: scope(identity), action: 'create', input }) };
    if (await storage.receipt(request.requestId, request.fingerprint)) return read(identity, input.sessionId);
    const { rows: [existing] } = await storage.read('SELECT * FROM agent_session_directory WHERE session_id=$1', [input.sessionId]);
    if (existing) {
      stored(existing, identity);
      if (existing.create_digest !== request.fingerprint) throw new StorageError('identity-conflict');
      return read(identity, input.sessionId);
    }
    await checkWorkspace(identity, input.workspace);
    const owner = teachingAgentBindingSchema.parse(await host.resolveOwner(identity, input.scenario, input.workspace));
    const now = new Date().toISOString();
    const proposed = agentSessionSchema.parse({ ...input, identity, owner, title: input.title ?? null,
      pinned: false, archived: false, deleted: false, state: 'initializing', readyAt: null, createdAt: now, updatedAt: now });
    await storage.request(request, async tx => {
      await tx.query(`INSERT INTO agent_session_directory VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
        [input.sessionId, ...scope(identity), input.workspace?.activityId ?? null, request.fingerprint, proposed]);
      const { rows: [row] } = await tx.query('SELECT * FROM agent_session_directory WHERE session_id=$1', [input.sessionId]);
      if (!row) throw new StorageError('conflict');
      stored(row, identity);
      if (row.create_digest !== request.fingerprint) throw new StorageError('identity-conflict');
      return null;
    });
    return read(identity, input.sessionId);
  }
  async function mutate(identity: SpaceIdentity, action: string, input: { requestId: string; sessionId: string },
    change: (session: AgentSession) => AgentSession): Promise<AgentSession> {
    const request = { requestId: `agent-session:${digest(scope(identity))}:${input.requestId}`,
      fingerprint: digest({ scope: scope(identity), action, input }) };
    const receipt = await storage.receipt(request.requestId, request.fingerprint);
    const current = await read(identity, input.sessionId);
    if (receipt) return current;
    await storage.request(request, async tx => {
      const { rows: [row] } = await tx.query('SELECT * FROM agent_session_directory WHERE session_id=$1 FOR UPDATE', [input.sessionId]);
      if (!row) throw new StorageError('missing');
      const next = change(stored(row, identity));
      await tx.query('UPDATE agent_session_directory SET body=$2 WHERE session_id=$1', [input.sessionId, next]);
      return null;
    });
    return read(identity, input.sessionId);
  }
  async function update(value: SpaceIdentity, valueInput: unknown): Promise<AgentSession> {
    const identity = await authorize(value), input = updateAgentSessionSchema.parse(valueInput);
    const { requestId: _requestId, sessionId: _sessionId, ...patch } = input;
    return mutate(identity, 'update', input, session => agentSessionSchema.parse({ ...session, ...patch, updatedAt: new Date().toISOString() }));
  }
  async function markReady(value: SpaceIdentity, valueInput: unknown): Promise<AgentSession> {
    const identity = await authorize(value), input = markAgentSessionReadySchema.parse(valueInput);
    return mutate(identity, 'ready', input, session => {
      if (session.state === 'ready') return session;
      const now = new Date().toISOString();
      return agentSessionSchema.parse({ ...session, state: 'ready', readyAt: now, updatedAt: now });
    });
  }
  return { create, read, list, update, markReady, validate: () => validateAgentSessions(storage) };
}

/** Pure recovery check: no current member binding, host authorization or Agent calls. */
export async function validateAgentSessions(storage: OwnedStorage) {
  const { rows } = await storage.read('SELECT * FROM agent_session_directory');
  const creations = new Set<string>(), workspaces = new Set<string>();
  for (const row of rows) {
    const session = directorySession(row), subject = digest(scope(session.identity));
    const requestKey = `agent-session:${subject}:${session.requestId}`;
    if (creations.has(requestKey)) throw new StorageError('corrupt');
    creations.add(requestKey);
    let receipt;
    try { receipt = await storage.receipt(requestKey, String(row.create_digest)); }
    catch (error) { if (error instanceof StorageError && error.code === 'identity-conflict') throw new StorageError('corrupt'); throw error; }
    if (!receipt || receipt.result !== null || Date.parse(session.updatedAt) < Date.parse(session.createdAt)
      || (session.readyAt !== null && (Date.parse(session.readyAt) < Date.parse(session.createdAt)
        || Date.parse(session.readyAt) > Date.parse(session.updatedAt)))) throw new StorageError('corrupt');
    if (!session.workspace) continue;
    const key = subject + ':' + session.workspace.activityId;
    if (workspaces.has(key)) throw new StorageError('corrupt');
    workspaces.add(key);
    const { rows: [parent] } = await storage.read('SELECT body FROM activities WHERE id=$1', [session.workspace.activityId]);
    const parsed = activitySchema.safeParse(parent?.body);
    if (!parsed.success) throw new StorageError('corrupt');
    const activity = parsed.data;
    if (activity.activityId !== session.workspace.activityId || !sameSubject(activity.identity, session.identity)
      || activity.target.environmentId !== session.workspace.target.environmentId || activity.target.serviceId !== session.workspace.target.serviceId
      || activity.target.version !== session.workspace.target.version || activity.target.environmentId !== storage.owner.environmentId
      || activity.target.serviceId !== storage.owner.serviceId) throw new StorageError('corrupt');
  }
}
