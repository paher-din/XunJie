import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Migration, OwnedStorage } from '@xunjie/storage';
import { StorageError } from '@xunjie/storage';
import { z } from 'zod';
import { spaceIdentitySchema, learningTargetSchema } from '@xunjie/contracts/spaces';
import type { SpaceIdentity, LearningTarget } from '@xunjie/contracts/spaces';
export type { SpaceIdentity } from '@xunjie/contracts/spaces';

export const spaceMigrations: readonly Migration[] = [{ version: 1, name: 'spaces-and-principals', sql: `
  CREATE TABLE spaces (id uuid PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('personal','school')), name text NOT NULL);
  CREATE TABLE principals (id uuid PRIMARY KEY, space_id uuid NOT NULL REFERENCES spaces(id), name text NOT NULL,
    UNIQUE(space_id,id));
  CREATE TABLE memberships (space_id uuid NOT NULL, principal_id uuid NOT NULL, active boolean NOT NULL DEFAULT true,
    PRIMARY KEY(space_id,principal_id), FOREIGN KEY(space_id,principal_id) REFERENCES principals(space_id,id));
` }, { version: 2, name: 'school-accounts-and-sessions', sql: `
  ALTER TABLE spaces ADD UNIQUE(kind);
  CREATE TABLE accounts (login_name text PRIMARY KEY, principal_id uuid NOT NULL UNIQUE REFERENCES principals(id),
    salt text NOT NULL, verifier text NOT NULL);
  CREATE TABLE sessions (token_hash text PRIMARY KEY, principal_id uuid NOT NULL REFERENCES principals(id),
    expires_at timestamptz NOT NULL, revoked boolean NOT NULL DEFAULT false);
` }, { version: 3, name: 'member-learning-bindings', sql: `
  CREATE TABLE learning_bindings (space_id uuid NOT NULL,principal_id uuid NOT NULL,target jsonb NOT NULL,
    PRIMARY KEY(space_id,principal_id),FOREIGN KEY(space_id,principal_id) REFERENCES memberships(space_id,principal_id));
` }, { version: 4, name: 'client-authorization', sql: `
  ALTER TABLE sessions ADD COLUMN kind text NOT NULL DEFAULT 'session' CHECK(kind IN ('session','connection'));
  ALTER TABLE sessions ADD COLUMN connection_id uuid UNIQUE;
  CREATE TABLE authorizations (id uuid PRIMARY KEY,client_id uuid NOT NULL,challenge text NOT NULL,
    principal_id uuid REFERENCES principals(id),expires_at timestamptz NOT NULL);
` }];

const derive = promisify(scrypt);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const id = z.uuid();
const fail = (code: 'forbidden' | 'invalid' | 'missing'): never => { throw new StorageError(code); };
async function passwordKey(password: string, salt: string) {
  return (await derive(password, salt, 32)) as Buffer;
}
const proof = (value: string) => createHash('sha256').update(value).digest('base64url');
function operationId(value: string) {
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 64; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

/** Space facts and identities belong to this owner, independently of learning records. */
export function createSpaces(storage: OwnedStorage, options: { sessionLifetimeMs?: number; credentialNamespace?: string } = {}) {
  const sessionLifetimeMs = z.number().int().positive().max(8 * 3600000).parse(options.sessionLifetimeMs ?? 8 * 3600000);
  const sessionDigest = (token: string) => digest({ namespace: options.credentialNamespace ?? storage.owner.environmentId, token });
  function identity(row: Record<string, unknown>): SpaceIdentity {
    return { environmentId: storage.owner.environmentId, spaceId: row.space_id as string,
      principalId: row.principal_id as string, kind: row.kind as SpaceIdentity['kind'], name: row.name as string };
  }
  async function personal(): Promise<SpaceIdentity> {
    const receipt = await storage.request({ requestId: storage.owner.serviceId, fingerprint: 'personal-space-v1' }, async tx => {
      const spaceId = randomUUID();
      const principalId = randomUUID();
      await tx.query("INSERT INTO spaces VALUES ($1,'personal','个人学习空间')", [spaceId]);
      await tx.query("INSERT INTO principals VALUES ($1,$2,'本人')", [principalId, spaceId]);
      await tx.query('INSERT INTO memberships(space_id,principal_id) VALUES ($1,$2)', [spaceId, principalId]);
      return { environmentId: storage.owner.environmentId, spaceId, principalId, kind: 'personal', name: '个人学习空间' };
    });
    return receipt.result as SpaceIdentity;
  }
  async function createMember(input: { requestId: string; loginName: string; password: string }): Promise<SpaceIdentity> {
    id.parse(input.requestId);
    z.string().min(1).max(100).regex(/^[a-zA-Z0-9_.@-]+$/).parse(input.loginName);
    z.string().min(12).max(256).parse(input.password);
    const verifier = (await passwordKey(input.password, input.requestId)).toString('hex');
    const receipt = await storage.request({ requestId: input.requestId,
      fingerprint: digest({ loginName: input.loginName, verifier }) }, async tx => {
      const proposed = randomUUID();
      await tx.query("INSERT INTO spaces VALUES ($1,'school','学校学习空间') ON CONFLICT(kind) DO NOTHING", [proposed]);
      const { rows: [space] } = await tx.query("SELECT id FROM spaces WHERE kind='school'");
      if (!space) return fail('missing');
      const principalId = randomUUID();
      await tx.query('INSERT INTO principals VALUES ($1,$2,$3)', [principalId, space.id, input.loginName]);
      await tx.query('INSERT INTO memberships(space_id,principal_id) VALUES ($1,$2)', [space.id, principalId]);
      await tx.query('INSERT INTO accounts VALUES ($1,$2,$3,$4)', [input.loginName, principalId, input.requestId, verifier]);
      return { environmentId: storage.owner.environmentId, spaceId: space.id, principalId, kind: 'school', name: '学校学习空间' };
    });
    return receipt.result as SpaceIdentity;
  }
  async function setMembership(input: { requestId: string; principalId: string; active: boolean }) {
    id.parse(input.requestId); id.parse(input.principalId); z.boolean().parse(input.active);
    await storage.request({ requestId: input.requestId, fingerprint: digest(input) }, async tx => {
      const result = await tx.query(`UPDATE memberships SET active=$2 WHERE principal_id=$1
        AND principal_id IN (SELECT principal_id FROM accounts)`, [input.principalId, input.active]);
      if (result.rowCount !== 1) fail('missing');
      if (!input.active) await tx.query('UPDATE sessions SET revoked=true WHERE principal_id=$1', [input.principalId]);
      return { principalId: input.principalId, active: input.active };
    });
  }
  async function authenticate(token: string, kind?: 'session' | 'connection'): Promise<SpaceIdentity> {
    if (typeof token !== 'string' || token.length > 200 || !token) fail('forbidden');
    const { rows: [row] } = await storage.read(`SELECT p.id AS principal_id,p.space_id,s.kind,s.name
      FROM sessions a JOIN principals p ON p.id=a.principal_id JOIN spaces s ON s.id=p.space_id
      JOIN memberships m ON m.space_id=p.space_id AND m.principal_id=p.id
      WHERE a.token_hash=$1 AND NOT a.revoked AND a.expires_at>clock_timestamp() AND m.active
      AND ($2::text IS NULL OR a.kind=$2)`, [sessionDigest(token), kind ?? null]);
    if (!row) return fail('forbidden');
    return identity(row);
  }
  async function login(loginName: string, password: string) {
    z.string().min(1).max(100).parse(loginName); z.string().min(1).max(256).parse(password);
    const { rows: [account] } = await storage.read('SELECT salt,verifier,principal_id FROM accounts WHERE login_name=$1', [loginName]);
    // Do comparable password work for an unknown account as for a wrong password.
    const key = await passwordKey(password, account?.salt as string ?? 'unknown-account');
    if (!account || !timingSafeEqual(key, Buffer.from(account.verifier as string, 'hex'))) return fail('forbidden');
    const token = randomBytes(32).toString('base64url');
    await storage.request({ requestId: randomUUID(), fingerprint: digest(token) }, async tx => {
      await tx.query("INSERT INTO sessions(token_hash,principal_id,expires_at) VALUES ($1,$2,clock_timestamp()+$3*interval '1 millisecond')",
        [sessionDigest(token), account.principal_id, sessionLifetimeMs]);
      return null;
    });
    return { token, identity: await authenticate(token) };
  }
  async function authorize(value: SpaceIdentity) {
    const identity = spaceIdentitySchema.parse(value);
    if (identity.environmentId !== storage.owner.environmentId) fail('forbidden');
    const { rows } = await storage.read(`SELECT m.principal_id FROM memberships m JOIN spaces s ON s.id=m.space_id
      WHERE m.space_id=$1 AND m.principal_id=$2 AND m.active AND s.kind=$3`, [identity.spaceId, identity.principalId, identity.kind]);
    if (!rows.length) fail('forbidden');
  }
  async function bindMember(identity: SpaceIdentity, target: LearningTarget) {
    await authorize(identity); learningTargetSchema.parse(target);
    await storage.request({ requestId: identity.principalId, fingerprint: digest({ identity, target }) }, async tx => {
      await tx.query('INSERT INTO learning_bindings VALUES ($1,$2,$3)', [identity.spaceId, identity.principalId, JSON.stringify(target)]);
      return { identity, target };
    });
  }
  async function resolveBinding(identity: SpaceIdentity): Promise<LearningTarget> {
    await authorize(identity);
    const { rows: [row] } = await storage.read('SELECT target FROM learning_bindings WHERE space_id=$1 AND principal_id=$2',
      [identity.spaceId, identity.principalId]);
    if (!row) return fail('missing');
    return learningTargetSchema.parse(row.target);
  }
  async function logout(token: string) {
    await storage.request({ requestId: randomUUID(), fingerprint: digest({ logout: digest(token) }) }, async tx => {
      await tx.query('UPDATE sessions SET revoked=true WHERE token_hash=$1', [sessionDigest(token)]);
      return null;
    });
  }
  async function beginConnection(value: { requestId: string; clientId: string; challenge: string }) {
    const input = z.object({ requestId: z.uuid(), clientId: z.uuid(), challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict().parse(value);
    await storage.request({ requestId: input.requestId, fingerprint: digest(input) }, async tx => {
      await tx.query("INSERT INTO authorizations(id,client_id,challenge,expires_at) VALUES ($1,$2,$3,clock_timestamp()+interval '5 minutes')",
        [input.requestId, input.clientId, input.challenge]);
      return null;
    });
    return { requestId: input.requestId };
  }
  async function approveConnection(token: string, requestId: string) {
    const member = await authenticate(token, 'session'); id.parse(requestId);
    await storage.request({ requestId: randomUUID(), fingerprint: digest({ requestId, member }) }, async tx => {
      const result = await tx.query(`UPDATE authorizations SET principal_id=$2 WHERE id=$1
        AND expires_at>clock_timestamp() AND (principal_id IS NULL OR principal_id=$2)`, [requestId, member.principalId]);
      if (!result.rowCount) fail('forbidden');
      return null;
    });
  }
  async function exchangeConnection(requestId: string, verifier: string) {
    id.parse(requestId); z.string().regex(/^[A-Za-z0-9_-]{43,128}$/).parse(verifier);
    const { rows: [row] } = await storage.read(`SELECT principal_id FROM authorizations
      WHERE id=$1 AND challenge=$2 AND principal_id IS NOT NULL AND expires_at>clock_timestamp()`, [requestId, proof(verifier)]);
    if (!row) return fail('forbidden');
    const token = proof(`connection:${requestId}:${verifier}`);
    await storage.request({ requestId: operationId(`exchange:${requestId}`), fingerprint: digest({ requestId, token: digest(token) }) }, async tx => {
      await tx.query(`INSERT INTO sessions(token_hash,principal_id,expires_at,kind,connection_id)
        VALUES ($1,$2,clock_timestamp()+interval '30 days','connection',$3)`, [sessionDigest(token), row.principal_id, requestId]);
      return null;
    });
    return { token, identity: await authenticate(token, 'connection'), connectionId: requestId,
      capabilities: ['activity:read', 'activity:write'] };
  }
  async function revokeConnection(member: SpaceIdentity, connectionId: string) {
    await authorize(member); id.parse(connectionId);
    await storage.request({ requestId: randomUUID(), fingerprint: digest({ member, connectionId }) }, async tx => {
      const result = await tx.query("UPDATE sessions SET revoked=true WHERE connection_id=$1 AND principal_id=$2 AND kind='connection'",
        [connectionId, member.principalId]);
      if (!result.rowCount) fail('missing');
      return null;
    });
  }
  async function adminRevokeConnection(connectionId: string) {
    id.parse(connectionId);
    await storage.request({ requestId: randomUUID(), fingerprint: digest({ connectionId }) }, async tx => {
      const result = await tx.query("UPDATE sessions SET revoked=true WHERE connection_id=$1 AND kind='connection'", [connectionId]);
      if (!result.rowCount) fail('missing');
      return { revoked: true };
    });
  }
  async function validate() {
    const { rows } = await storage.read('SELECT target FROM learning_bindings');
    for (const row of rows) learningTargetSchema.parse(row.target);
    await storage.read('SELECT a.principal_id FROM accounts a JOIN memberships m ON m.principal_id=a.principal_id');
  }
  return { personal, createMember, setMembership, login, authenticate, bindMember, resolveBinding,
    logout, beginConnection, approveConnection, exchangeConnection, revokeConnection, adminRevokeConnection, validate };
}
