import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { StorageError } from '@xunjie/storage';
import type { RuntimeEnvironment } from '@xunjie/contracts/product-runtime';
import type { LearningTarget, SpaceIdentity } from '@xunjie/contracts/spaces';
import type { createSpaces } from '../spaces/index.js';
import type { createLearningData } from '../learning-data/index.js';
import type { createCourses } from '../courses/index.js';
export { createSpaces, spaceMigrations } from '../spaces/index.js';
export { createCourses, courseMigrations, spaceCourseMigrations } from '../courses/index.js';
export { createLearningData, learningMigrations, validateLearningData } from '../learning-data/index.js';

export async function readLearningBody(request: IncomingMessage, limit = 65536): Promise<Record<string, unknown>> {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new StorageError('invalid');
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new StorageError('invalid');
    chunks.push(Buffer.from(chunk));
  }
  try { return z.record(z.string(), z.unknown()).parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
  catch { throw new StorageError('invalid'); }
}
export function sendLearning(response: ServerResponse, code: number, value: unknown) {
  response.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}
export function learningFailure(response: ServerResponse, error: unknown) {
  const code = error instanceof StorageError ? error.code : error instanceof z.ZodError ? 'invalid' : 'unavailable';
  const status = code === 'forbidden' ? 403 : code === 'missing' ? 404 : code === 'invalid' ? 400
    : ['conflict', 'identity-conflict', 'commit-unknown'].includes(code) ? 409 : 503;
  sendLearning(response, status, { error: code });
}

/** Production HTTP boundary derives identity from a real session or the local device, never identity headers. */
export function createLearningEntry(options: {
  environment: RuntimeEnvironment;
  target?: LearningTarget;
  spaces?: ReturnType<typeof createSpaces>;
  learning?: ReturnType<typeof createLearningData>;
  courses?: ReturnType<typeof createCourses>;
  administratorToken: string;
  client?: {
    list(): Promise<{ key: string; identity: SpaceIdentity }[]>;
    start(input: { requestId: string; schoolEndpoint: string }): Promise<unknown>;
    complete(requestId: string): Promise<unknown>;
    configureLocal?(input: unknown): Promise<unknown>;
    forward(connectionId: string, route: string, body?: unknown, expectedSubject?: string): Promise<unknown>;
  };
}) {
  const { spaces, learning, environment } = options;
  const cookieName = `xj_${environment.environmentId.replaceAll('-', '')}`;
  const endpoint = new URL(environment.services[0]!.endpoint);
  // The same product may be opened as 127.0.0.1, localhost or [::1] on a loopback listener.
  const allowedOrigins = new Set([endpoint.origin]);
  if (['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname)) {
    const port = endpoint.port ? `:${endpoint.port}` : '';
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) allowedOrigins.add(`${endpoint.protocol}//${host}${port}`);
  }
  const cookieFlags = `; Path=/; HttpOnly; SameSite=Strict${endpoint.protocol === 'https:' ? '; Secure' : ''}`;
  function session(request: IncomingMessage) {
    return request.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(cookieName + '='))?.slice(cookieName.length + 1) ?? '';
  }
  async function current(request: IncomingMessage): Promise<SpaceIdentity> {
    if (!spaces) throw new StorageError('forbidden');
    if (request.headers['x-xj-space'] === 'personal') {
      if (environment.profile !== 'local' || !options.target) throw new StorageError('forbidden');
      const personal = await spaces.personal();
      await spaces.bindMember(personal, options.target);
      return personal;
    }
    const authorization = request.headers.authorization;
    return authorization?.startsWith('Bearer ')
      ? spaces.authenticate(authorization.slice(7), 'connection') : spaces.authenticate(session(request), 'session');
  }
  return async function handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const pathname = new URL(request.url ?? '/', endpoint).pathname;
    if (!pathname.startsWith('/api/learning/')) return false;
    try {
      if (request.headers.origin && !allowedOrigins.has(request.headers.origin) || request.headers['sec-fetch-site'] === 'cross-site') throw new StorageError('forbidden');
      const route = pathname.slice('/api/learning/'.length);
      if ((route.startsWith('workspaces/') || route.startsWith('drafts/')) && request.headers['x-xj-namespace']
        && request.headers['x-xj-namespace'] !== environment.clientNamespace) throw new StorageError('forbidden');
      const method = request.method;
      let result: unknown;
      const remote = request.headers['x-xj-space'];
      if (environment.profile === 'school' && (route.startsWith('client/') || typeof remote === 'string' && remote.startsWith('school:'))) throw new StorageError('forbidden');
      if (typeof remote === 'string' && remote.startsWith('school:') && options.client) {
        const expected = request.headers['x-xj-expected-subject'];
        if (expected !== undefined && typeof expected !== 'string') throw new StorageError('forbidden');
        result = await options.client.forward(remote.slice(7), route, method === 'POST' ? await readLearningBody(request, route.startsWith('workspaces/') || route.startsWith('drafts/') ? 8000000 : 65536) : undefined, expected);
      } else if (route === 'client/start' && method === 'POST' && options.client) {
        result = await options.client.start(z.object({ requestId: z.uuid(), schoolEndpoint: z.url() }).strict().parse(await readLearningBody(request)));
      } else if (route === 'client/complete' && method === 'POST' && options.client) {
        result = await options.client.complete(z.object({ requestId: z.uuid() }).strict().parse(await readLearningBody(request)).requestId);
      } else if (route === 'manage/local-binding' && method === 'POST' && options.client?.configureLocal) {
        if (request.headers.authorization !== `Bearer ${options.administratorToken}`) throw new StorageError('forbidden');
        result = await options.client.configureLocal(await readLearningBody(request));
      } else if (route === 'context' && method === 'GET') {
        const identities: { key: string; identity: SpaceIdentity }[] = [];
        if (environment.profile === 'local') {
          if (!spaces || !options.target) throw new StorageError('unavailable');
          const personal = await spaces.personal();
          await spaces.bindMember(personal, options.target);
          identities.push({ key: 'personal', identity: personal });
        }
        if (session(request) && spaces) {
          try { identities.push({ key: 'school', identity: await spaces.authenticate(session(request), 'session') }); }
          catch (error) { if (!(error instanceof StorageError) || error.code !== 'forbidden') throw error; }
        }
        result = { profile: environment.profile, clientNamespace: environment.clientNamespace,
          identities: [...identities, ...await options.client?.list() ?? []] };
      } else if (!spaces || !learning || !options.target) throw new StorageError('forbidden');
      else if (route === 'login' && method === 'POST') {
        const input = z.object({ loginName: z.string(), password: z.string() }).strict().parse(await readLearningBody(request));
        const login = await spaces.login(input.loginName, input.password);
        response.setHeader('set-cookie', `${cookieName}=${login.token}${cookieFlags}; Max-Age=28800`);
        result = { identity: login.identity };
      } else if (route === 'logout' && method === 'POST') {
        await readLearningBody(request);
        await spaces.logout(session(request));
        response.setHeader('set-cookie', `${cookieName}=${cookieFlags}; Max-Age=0`);
        result = { loggedOut: true };
      } else if (route.startsWith('manage/') && method === 'POST') {
        if (request.headers.authorization !== `Bearer ${options.administratorToken}`) throw new StorageError('forbidden');
        if (route === 'manage/course-import') {
          if (!options.courses) throw new StorageError('forbidden');
          result = await options.courses.registerRelease(await readLearningBody(request, 64 * 1024 * 1024));
        } else if (route === 'manage/course-result') {
          if (!options.courses) throw new StorageError('forbidden');
          const input = z.object({ requestId: z.uuid() }).strict().parse(await readLearningBody(request));
          result = await options.courses.registrationResult(input.requestId);
        } else if (route === 'manage/course-access') {
          if (!options.courses) throw new StorageError('forbidden');
          result = await options.courses.setAccess(await readLearningBody(request) as never);
        } else {
          const body = await readLearningBody(request);
          if (route === 'manage/members') {
            const input = z.object({ requestId: z.uuid(), loginName: z.string(), password: z.string(),
              target: z.object({ environmentId: z.uuid(), serviceId: z.uuid(), version: z.literal(1) }).strict().optional() }).strict().parse(body);
            const identity = await spaces.createMember(input);
            await spaces.bindMember(identity, input.target ?? options.target);
            result = identity;
          } else if (route === 'manage/membership') {
            const input = z.object({ requestId: z.uuid(), principalId: z.uuid(), active: z.boolean() }).strict().parse(body);
            await spaces.setMembership(input); result = { updated: true };
          } else if (route === 'manage/connection') {
            const input = z.object({ connectionId: z.uuid() }).strict().parse(body);
            await spaces.adminRevokeConnection(input.connectionId); result = { revoked: true };
          } else throw new StorageError('missing');
        }
      } else if (route === 'connections/start' && method === 'POST') {
        const input = z.object({ requestId: z.uuid(), clientId: z.uuid(), challenge: z.string() }).strict().parse(await readLearningBody(request));
        result = await spaces.beginConnection(input);
      } else if (route === 'connections/approve' && method === 'POST') {
        const input = z.object({ requestId: z.uuid() }).strict().parse(await readLearningBody(request));
        await spaces.approveConnection(session(request), input.requestId); result = { approved: true };
      } else if (route === 'connections/exchange' && method === 'POST') {
        const input = z.object({ requestId: z.uuid(), verifier: z.string() }).strict().parse(await readLearningBody(request));
        const grant = await spaces.exchangeConnection(input.requestId, input.verifier);
        result = { ...grant, target: await spaces.resolveBinding(grant.identity) };
      } else if (route === 'connections/revoke' && method === 'POST') {
        const input = z.object({ connectionId: z.uuid() }).strict().parse(await readLearningBody(request));
        await spaces.revokeConnection(await current(request), input.connectionId); result = { revoked: true };
      } else if (route === 'courses' && method === 'GET') {
        if (!options.courses) throw new StorageError('forbidden');
        result = await options.courses.listCourses(await current(request));
      } else if (route.startsWith('releases/') && method === 'GET') {
        if (!options.courses) throw new StorageError('forbidden');
        const parts = route.slice('releases/'.length).split('/');
        if (parts.length === 1) result = await options.courses.readRelease(await current(request), parts[0]!);
        else if (parts.length === 3 && parts[1] === 'materials') {
          result = await options.courses.readMaterial(await current(request), parts[0]!, parts[2]!);
        } else throw new StorageError('missing');
      } else if (route === 'course-activities' && method === 'POST') {
        result = await learning.createCourse(await current(request), await readLearningBody(request));
      } else if (route.startsWith('course-activity-results/') && method === 'GET') {
        result = await learning.courseResult(await current(request), route.slice('course-activity-results/'.length));
      } else if (route.startsWith('drafts/')) {
        const parts = route.split('/');
        const identity = await current(request);
        if (request.headers['x-xj-expected-subject'] && request.headers['x-xj-expected-subject'] !==
          [identity.environmentId, identity.spaceId, identity.principalId].join('.')) throw new StorageError('forbidden');
        if (parts.length === 2 && method === 'GET') result = await learning.drafts.read(identity, parts[1]!);
        else if (parts.length === 2 && method === 'POST') result = await learning.drafts.sync(identity, parts[1]!,
          await readLearningBody(request, 8000000) as never);
        else if (parts.length === 4 && parts[2] === 'receipts' && method === 'GET') result = await learning.drafts.receipt(identity, parts[1]!, parts[3]!);
        else if (parts.length === 4 && parts[2] === 'revisions' && method === 'GET') result = await learning.drafts.revision(identity, parts[1]!, parts[3]!);
        else throw new StorageError('missing');
      } else if (route.startsWith('workspaces/')) {
        const parts = route.split('/');
        const identity = await current(request);
        if (request.headers['x-xj-expected-subject'] && request.headers['x-xj-expected-subject'] !==
          [identity.environmentId, identity.spaceId, identity.principalId].join('.')) throw new StorageError('forbidden');
        if (parts.length === 2 && method === 'GET') result = await learning.works.read(identity, parts[1]!);
        else if (parts.length === 2 && method === 'POST') result = await learning.works.sync(identity, parts[1]!, await readLearningBody(request, 8000000) as never);
        else if (parts.length === 4 && parts[2] === 'receipts' && method === 'GET') result = await learning.works.receipt(identity, parts[1]!, parts[3]!);
        else if (parts.length === 4 && parts[2] === 'contents' && method === 'GET') result = await learning.works.content(identity, parts[1]!, parts[3]!);
        else throw new StorageError('missing');
      } else if (route === 'activities' && method === 'GET') result = await learning.list(await current(request));
      else if (route === 'activities' && method === 'POST') {
        result = await learning.create(await current(request), await readLearningBody(request) as never);
      } else if (route.startsWith('activities/') && method === 'GET') result = await learning.open(await current(request), route.slice(11));
      else if (route === 'activity-status' && method === 'POST') result = await learning.setStatus(await current(request),
        z.object({ requestId: z.uuid(), activityId: z.uuid(), status: z.enum(['open', 'closed']) }).strict().parse(await readLearningBody(request)));
      else if (route.startsWith('receipts/') && method === 'GET') result = await learning.receipt(await current(request), route.slice(9));
      else throw new StorageError('missing');
      sendLearning(response, 200, result);
    } catch (error) { learningFailure(response, error); }
    return true;
  };
}
