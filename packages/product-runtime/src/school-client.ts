import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { StorageError } from '@xunjie/storage';
import { spaceIdentitySchema, learningTargetSchema } from '@xunjie/contracts/spaces';
import { activitySchema, courseActivityResultSchema } from '@xunjie/contracts/learning-data';
import { courseCatalogSchema, courseMaterialContentSchema, courseReleaseSchema } from '@xunjie/contracts/courses';
import { storageErrorCodes } from '@xunjie/contracts/storage';
import type { RuntimeEnvironment } from '@xunjie/contracts/product-runtime';
import { acquireLock, atomicJson, exists } from './io.js';
import { resolveCredential } from './postgres.js';

const grantSchema = z.object({ token: z.string().min(40).max(200), identity: spaceIdentitySchema,
  target: learningTargetSchema, connectionId: z.uuid(), capabilities: z.tuple([z.literal('activity:read'), z.literal('activity:write')]) });
const connectionSchema = z.object({ requestId: z.uuid(), schoolEndpoint: z.url(), verifier: z.string(),
  clientId: z.uuid(), clientNamespace: z.string(), grant: grantSchema.optional() });
type Connection = z.infer<typeof connectionSchema>;

/** Installed client retains only its own verifier and scoped grant, never the school's account database. */
export function createSchoolClient(root: string, environment: RuntimeEnvironment) {
  const ref = (id: string) => `school-client-${z.uuid().parse(id)}`;
  const path = (id: string) => join(root, 'credentials', ref(id));
  async function update<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const release = await acquireLock(root, ref(id));
    try { return await operation(); } finally { await release(); }
  }
  async function read(id: string) {
    let stored: string;
    try { stored = await resolveCredential(root, ref(id)); }
    catch { throw new StorageError('forbidden'); }
    const connection = connectionSchema.parse(JSON.parse(stored));
    if (connection.clientNamespace !== environment.clientNamespace) throw new StorageError('forbidden');
    return connection;
  }
  async function call(connection: Connection, route: string, body?: unknown, authorized = false) {
    let response: Response;
    try {
      response = await fetch(new URL('/api/learning/' + route, connection.schoolEndpoint), {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { 'content-type': 'application/json', ...(authorized ? { authorization: `Bearer ${connection.grant!.token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new StorageError('unavailable'); }
    if (!response.ok) {
      const failure = z.object({ error: z.enum(storageErrorCodes) }).safeParse(await response.json().catch(() => null));
      if (failure.success) throw new StorageError(failure.data.error);
      const code = response.status === 403 ? 'forbidden' : response.status === 404 ? 'missing'
        : 'unavailable';
      throw new StorageError(code);
    }
    return response.json() as Promise<unknown>;
  }
  const view = (connection: Connection) => ({ connectionId: connection.requestId,
    requestId: connection.requestId, schoolEndpoint: connection.schoolEndpoint,
    authorizationUrl: new URL(`/?authorize=${connection.requestId}`, connection.schoolEndpoint).href,
    ...(connection.grant ? { identity: connection.grant.identity, target: connection.grant.target } : {}) });
  async function list() {
    const files = await readdir(join(root, 'credentials'));
    const result = [];
    for (const file of files.filter(name => /^school-client-[0-9a-f-]{36}$/.test(name))) {
      const connection = await read(file.slice('school-client-'.length));
      if (connection.grant) result.push({ key: `school:${connection.requestId}`, identity: connection.grant.identity });
    }
    return result;
  }
  async function start(value: { requestId: string; schoolEndpoint: string }) {
    const input = z.object({ requestId: z.uuid(), schoolEndpoint: z.url() }).strict().parse(value);
    const endpoint = new URL(input.schoolEndpoint);
    if (endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash
      || endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(endpoint.hostname))) throw new StorageError('invalid');
    const connection = await update(input.requestId, async () => {
      if (await exists(path(input.requestId))) {
        const existing = await read(input.requestId);
        if (existing.schoolEndpoint !== endpoint.origin) throw new StorageError('identity-conflict');
        return existing;
      }
      const created: Connection = { requestId: input.requestId, schoolEndpoint: endpoint.origin, verifier: randomBytes(48).toString('base64url'),
        clientId: randomUUID(), clientNamespace: environment.clientNamespace };
      await atomicJson(path(input.requestId), created);
      return created;
    });
    await call(connection, 'connections/start', { requestId: connection.requestId, clientId: connection.clientId,
      challenge: createHash('sha256').update(connection.verifier).digest('base64url') });
    return view(connection);
  }
  async function complete(requestId: string) {
    const connection = await read(requestId);
    const grant = grantSchema.parse(await call(connection, 'connections/exchange', { requestId, verifier: connection.verifier }));
    if (grant.connectionId !== requestId) throw new StorageError('forbidden');
    if (connection.grant && (JSON.stringify(connection.grant.identity) !== JSON.stringify(grant.identity)
      || JSON.stringify(connection.grant.target) !== JSON.stringify(grant.target))) throw new StorageError('forbidden');
    return update(requestId, async () => {
      // Network exchange is outside the lock. Revocation or a new proof may have won while it was in flight.
      const current = await read(requestId);
      if (current.verifier !== connection.verifier) throw new StorageError('forbidden');
      current.grant = grant;
      await atomicJson(path(requestId), current);
      return view(current);
    });
  }
  async function forward(connectionId: string, route: string, body?: unknown) {
    const id = '[0-9a-f-]{36}';
    if (!new RegExp(`^(?:activities(?:/${id})?|activity-status|receipts/${id}|courses|releases/${id}` +
      `|releases/${id}/materials/${id}|course-activities|course-activity-results/${id}|workspaces/${id}(?:/(?:receipts|contents)/${id})?|connections/revoke)$`).test(route)) {
      throw new StorageError('forbidden');
    }
    const connection = await read(connectionId);
    if (!connection.grant) throw new StorageError('forbidden');
    let value: unknown;
    try { value = await call(connection, route, body, true); }
    catch (error) {
      // The school may already have revoked this grant (or the membership): drop the local copy too.
      if (route !== 'connections/revoke' || !(error instanceof StorageError) || error.code !== 'forbidden') throw error;
      await update(connectionId, () => rm(path(connectionId), { force: true }));
      return { revoked: true };
    }
    if (route === 'connections/revoke') {
      // A revoked grant must stop appearing as an available space; keep no local copy that could be replayed.
      await update(connectionId, () => rm(path(connectionId), { force: true }));
      return value;
    }
    if (route.startsWith('workspaces/')) return value;
    const parsed = <T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, candidate: unknown) => {
      const result = schema.safeParse(candidate);
      // A malformed school response is an upstream failure, not a user input error.
      if (!result.success) throw new StorageError('unavailable');
      return result.data;
    };
    const check = (candidate: unknown) => {
      const activity = parsed(activitySchema, candidate);
      if (JSON.stringify(activity.identity) !== JSON.stringify(connection.grant!.identity)
        || JSON.stringify(activity.target) !== JSON.stringify(connection.grant!.target)) throw new StorageError('forbidden');
      return activity;
    };
    if (route === 'courses') return parsed(courseCatalogSchema, value);
    if (route.startsWith('releases/')) {
      return route.split('/').length === 2 ? parsed(courseReleaseSchema, value) : parsed(courseMaterialContentSchema, value);
    }
    if (route.startsWith('course-activity-results/')) {
      if (value === null) return null;
      const result = parsed(courseActivityResultSchema, value);
      if (result.activity) check(result.activity);
      return result;
    }
    if (route === 'course-activities' || route === 'activity-status' || route.startsWith('activities/')) return check(value);
    if (route === 'activities') return Array.isArray(value) ? value.map(check) : check(value);
    if (route.startsWith('receipts/')) return value === null ? null : check(value);
    return value;
  }
  return { list, start, complete, forward };
}
