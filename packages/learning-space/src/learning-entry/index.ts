import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { componentBundleSchema } from '@xunjie/contracts/components';
import type { ExecutionDevice, ExecutionPlatform } from '@xunjie/contracts/execution';
import { StorageError } from '@xunjie/storage';
import type { RuntimeEnvironment } from '@xunjie/contracts/product-runtime';
import type { LearningTarget, SpaceIdentity } from '@xunjie/contracts/spaces';
import { modelSelectionSchema } from '@xunjie/contracts/model-connections';
import type { createSpaces } from '../spaces/index.js';
import type { createLearningData } from '../learning-data/index.js';
import type { createCourses } from '../courses/index.js';
import type { createNativeChannel } from '../learning-data/native-channel.js';
import type { createModelGateway } from '../model-connections/index.js';
import { routeModels } from '../model-connections/wire.js';
import { ModelCapabilityError } from '../model-connections/capabilities.js';
export { createSpaces, spaceMigrations } from '../spaces/index.js';
export { createCourses, courseMigrations, spaceCourseMigrations } from '../courses/index.js';
export { createLearningData, learningMigrations, validateLearningData } from '../learning-data/index.js';
export type { ActionIntentOptions, NativeSessionHostOptions } from '../learning-data/index.js';
export { SupervisedSession, productNativeAdapters, fourStateAccumulatorSource } from '../learning-data/native-process.js';
export type { NativeAdapter, NativeObservation, NativeSessionExit, NativeSessionLimits } from '../learning-data/native-process.js';
export { planSeatbelt, seatbeltLauncherPath, seatbeltProfileVersion, supervisorWatchdogSource } from '../learning-data/native-sandbox.js';
export type { NativeSessionIsolation, SeatbeltPlan } from '../learning-data/native-sandbox.js';
export { linuxSessionEntry, linuxSessionUnit, probeLinuxIsolation } from '../learning-data/linux-isolation.js';
export type { LinuxSessionEntry } from '../learning-data/linux-isolation.js';

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
  if (error instanceof ModelCapabilityError) {
    sendLearning(response, 422, { error: error.code, decision: error.decision });
    return;
  }
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
  nativeChannel?: ReturnType<typeof createNativeChannel>;
  models?: Awaited<ReturnType<typeof createModelGateway>>;
  restoredInstallation?(): Promise<boolean>;
  administratorToken: string;
  readOnly?: () => Promise<boolean>;
  /** Recovered installations require the current browser handshake for new member writes. */
  requiresNamespace?: boolean;
  executionEnvironment?: (identity: SpaceIdentity) => Promise<{ nodeClass: 'device' | 'school-execution-node';
    secureTransport: boolean; remoteAvailable: boolean; device: ExecutionDevice;
    adapters: { adapterId: string; adapterVersion: number; platforms: readonly ExecutionPlatform[] }[] }>;
  client?: {
    list(): Promise<{ key: string; identity: SpaceIdentity }[]>;
    start(input: { requestId: string; schoolEndpoint: string }): Promise<unknown>;
    complete(requestId: string): Promise<unknown>;
    configureLocal?(input: unknown): Promise<unknown>;
    forward(connectionId: string, route: string, body?: unknown, expectedSubject?: string): Promise<unknown>;
  };
}) {
  const { spaces, learning, environment } = options;
  const isReadOnly = options.readOnly ?? (async () => false);
  // Recovery credentials are process-local, short-lived read capabilities. They cannot become
  // normal sessions after takeover and never mutate the restored account/session tables.
  const recoverySessions = new Map<string, { identity: SpaceIdentity; expiresAt: number }>();
  const personalProfile = environment.profile === 'local' || environment.profile === 'model';
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
      if (!personalProfile || !options.target) throw new StorageError('forbidden');
      const readOnly = await isReadOnly();
      const personal = readOnly ? await spaces.readPersonal() : await spaces.personal();
      if (!readOnly) await spaces.bindMember(personal, options.target);
      return personal;
    }
    if (await isReadOnly()) {
      const saved = recoverySessions.get(session(request));
      if (!saved || saved.expiresAt <= Date.now()) throw new StorageError('forbidden');
      await spaces.authorize(saved.identity);
      return saved.identity;
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
      let route = pathname.slice('/api/learning/'.length);
      const readOnly = await isReadOnly();
      if (readOnly && (request.method !== 'GET' && !['login', 'logout'].includes(route)
        || /^(?:native-channel|client|connections|manage)(?:\/|$)/.test(route)
        || route === 'execution-environment' || /\/(?:algorithm|dependencies)(?:\/|$)/.test(route)))
        throw new StorageError('maintenance');
      if (options.requiresNamespace && request.method === 'POST'
        && !['login', 'logout'].includes(route) && !/^(?:manage|connections|native-channel)\//.test(route)
        && request.headers['x-xj-namespace'] !== environment.clientNamespace) throw new StorageError('forbidden');
      const componentView = request.method === 'GET' && /^releases\/[0-9a-f-]{36}\/components\/[a-z][a-z0-9-]{0,47}\/view$/.test(route);
      // Fixed dependency and diagnostic routes only: no arbitrary path reaches a resource backend through these.
      const componentDependency = request.method === 'GET' && /^releases\/[0-9a-f-]{36}\/components\/[a-z][a-z0-9-]{0,47}\/dependencies\/[a-z][a-z0-9-]{0,47}$/.test(route);
      const componentReports = request.method === 'GET' && /^releases\/[0-9a-f-]{36}\/components\/[a-z][a-z0-9-]{0,47}\/preparation-reports$/.test(route);
      const componentReport = request.method === 'POST' && /^releases\/[0-9a-f-]{36}\/components\/[a-z][a-z0-9-]{0,47}\/preparation-report$/.test(route);
      if (componentView) {
        const query = new URL(request.url!, endpoint).searchParams;
        request.headers['x-xj-space'] = z.string().regex(/^(?:personal|school|school:[0-9a-f-]{36})$/).parse(query.get('space'));
        const expected = query.get('subject');
        if (!expected || !/^[0-9a-f.-]{110}$/.test(expected)) throw new StorageError('invalid');
        request.headers['x-xj-expected-subject'] = expected;
        route = route.slice(0, -5);
      }
      if ((route.startsWith('workspaces/') || route.startsWith('drafts/') || route.startsWith('intents/')
        || route.startsWith('executions/') || route.startsWith('models/')) && request.headers['x-xj-namespace']
        && request.headers['x-xj-namespace'] !== environment.clientNamespace) throw new StorageError('forbidden');
      const method = request.method;
      let result: unknown;
      const remote = request.headers['x-xj-space'];
      if (readOnly && typeof remote === 'string' && remote.startsWith('school:')) throw new StorageError('forbidden');
      if (environment.profile === 'school' && (route.startsWith('client/') || typeof remote === 'string' && remote.startsWith('school:'))) throw new StorageError('forbidden');
      if (typeof remote === 'string' && remote.startsWith('school:') && options.client) {
        const expected = request.headers['x-xj-expected-subject'];
        if (expected !== undefined && typeof expected !== 'string') throw new StorageError('forbidden');
        result = await options.client.forward(remote.slice(7), route, method === 'POST' ? await readLearningBody(request,
          route === 'models/images' ? 360000 : route.startsWith('intents/') || route.startsWith('executions/') ? 16000000
            : route.startsWith('workspaces/') || route.startsWith('drafts/') ? 8000000 : 65536) : undefined, expected);
      } else if (route === 'client/start' && method === 'POST' && options.client) {
        result = await options.client.start(z.object({ requestId: z.uuid(), schoolEndpoint: z.url() }).strict().parse(await readLearningBody(request)));
      } else if (route === 'client/complete' && method === 'POST' && options.client) {
        result = await options.client.complete(z.object({ requestId: z.uuid() }).strict().parse(await readLearningBody(request)).requestId);
      } else if (route === 'manage/local-binding' && method === 'POST' && options.client?.configureLocal) {
        if (request.headers.authorization !== `Bearer ${options.administratorToken}`) throw new StorageError('forbidden');
        result = await options.client.configureLocal(await readLearningBody(request));
      } else if (route === 'native-channel/cleanup' && method === 'POST') {
        if (!options.nativeChannel) throw new StorageError('forbidden');
        result = await options.nativeChannel.cleanup(await readLearningBody(request, 16000000));
      } else if (/^native-channel\/(register|claim|report|heartbeat)$/.test(route) && method === 'POST') {
        if (!options.nativeChannel || !request.headers.authorization?.startsWith('Bearer ')) throw new StorageError('forbidden');
        const token = request.headers.authorization.slice(7);
        const body = await readLearningBody(request, 16000000);
        result = route.endsWith('/register') ? await options.nativeChannel.register(token, body)
          : route.endsWith('/claim') ? await options.nativeChannel.claim(token, body)
          : route.endsWith('/heartbeat') ? await options.nativeChannel.heartbeat(token, body)
          : await options.nativeChannel.report(token, body);
      } else if (route === 'native-channel/nodes' && method === 'GET') {
        if (!options.nativeChannel) throw new StorageError('unavailable');
        result = await options.nativeChannel.nodes(await current(request));
      } else if (route === 'execution-environment' && method === 'GET') {
        const identity = await current(request);
        if (!options.executionEnvironment) throw new StorageError('unavailable');
        result = await options.executionEnvironment(identity);
      } else if (route === 'context' && method === 'GET') {
        const identities: { key: string; identity: SpaceIdentity }[] = [];
        if (personalProfile) {
          if (!spaces || !options.target) throw new StorageError('unavailable');
          const personal = readOnly ? await spaces.readPersonal() : await spaces.personal();
          if (!readOnly) await spaces.bindMember(personal, options.target);
          identities.push({ key: 'personal', identity: personal });
        }
        if (session(request) && spaces) {
          try { identities.push({ key: 'school', identity: readOnly ? await current(request) : await spaces.authenticate(session(request), 'session') }); }
          catch (error) { if (!(error instanceof StorageError) || error.code !== 'forbidden') throw error; }
        }
        result = { profile: environment.profile, clientNamespace: environment.clientNamespace, readOnly,
          identities: [...identities, ...(!readOnly ? await options.client?.list() ?? [] : [])] };
      } else if (!spaces || !options.target) throw new StorageError('forbidden');
      else if (route === 'access' && method === 'GET') {
        const identity = await current(request);
        result = { identity, target: await spaces.resolveBinding(identity) };
      } else if (route === 'login' && method === 'POST') {
        const input = z.object({ loginName: z.string(), password: z.string() }).strict().parse(await readLearningBody(request));
        let login;
        if (readOnly) {
          const identity = await spaces.verifyPassword(input.loginName, input.password);
          for (const [token, saved] of recoverySessions) if (saved.expiresAt <= Date.now()) recoverySessions.delete(token);
          if (recoverySessions.size >= 1000) throw new StorageError('unavailable');
          login = { token: randomBytes(32).toString('base64url'), identity };
          recoverySessions.set(login.token, { identity, expiresAt: Date.now() + 8 * 3600000 });
        } else login = await spaces.login(input.loginName, input.password);
        response.setHeader('set-cookie', `${cookieName}=${login.token}${cookieFlags}; Max-Age=28800`);
        result = { identity: login.identity };
      } else if (route === 'logout' && method === 'POST') {
        await readLearningBody(request);
        if (readOnly) recoverySessions.delete(session(request));
        else await spaces.logout(session(request));
        response.setHeader('set-cookie', `${cookieName}=${cookieFlags}; Max-Age=0`);
        result = { loggedOut: true };
      } else if (route.startsWith('manage/') && method === 'POST') {
        if (request.headers.authorization !== `Bearer ${options.administratorToken}`) throw new StorageError('forbidden');
        if (route === 'manage/component-import') {
          if (!options.courses) throw new StorageError('forbidden');
          result = await options.courses.components.register(await readLearningBody(request, 2000000));
        } else if (route === 'manage/component-status') {
          if (!options.courses) throw new StorageError('forbidden');
          result = await options.courses.components.setStatus(await readLearningBody(request));
        } else if (route === 'manage/component-read') {
          if (!options.courses) throw new StorageError('forbidden');
          const input = z.object({ componentId: z.uuid(), version: z.number().int().positive() }).strict().parse(await readLearningBody(request));
          result = await options.courses.components.read(input.componentId, input.version);
        } else if (route === 'manage/model-default') {
          if (!options.models) throw new StorageError('unavailable');
          result = await options.models.school.save(await spaces.schoolSpace(), await readLearningBody(request));
        } else if (route === 'manage/course-import') {
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
          } else if (route === 'manage/native-reclaim') {
            if (!options.learning) throw new StorageError('forbidden');
            const input = z.object({ sessionRef: z.uuid() }).strict().parse(body);
            result = await options.learning.executions.reclaim(input.sessionRef);
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
      } else if (route.startsWith('releases/') && (method === 'GET' || componentReport)) {
        if (!options.courses) throw new StorageError('forbidden');
        const identity = await current(request);
        const expectedSubject = request.headers['x-xj-expected-subject'];
        if ((componentView || expectedSubject !== undefined)
          && expectedSubject !== [identity.environmentId, identity.spaceId, identity.principalId].join('.')) throw new StorageError('forbidden');
        const parts = route.slice('releases/'.length).split('/');
        if (parts.length === 1) result = await options.courses.readRelease(await current(request), parts[0]!);
        else if (parts.length === 3 && parts[1] === 'components') {
          result = await options.courses.readComponent(await current(request), parts[0]!, parts[2]!);
        }
        else if (parts.length === 4 && parts[1] === 'components' && parts[3] === 'algorithm') {
          result = await options.courses.readComponentAlgorithm(await current(request), parts[0]!, parts[2]!);
        }
        else if (parts.length === 3 && parts[1] === 'materials') {
          result = await options.courses.readMaterial(await current(request), parts[0]!, parts[2]!);
        } else if (componentDependency && parts.length === 5 && parts[1] === 'components' && parts[3] === 'dependencies') {
          result = await options.courses.readComponentDependency(identity, parts[0]!, parts[2]!, parts[4]!);
        } else if (componentReports && parts.length === 4 && parts[1] === 'components') {
          result = await options.courses.readComponentReports(identity, parts[0]!, parts[2]!);
        } else if (componentReport && parts.length === 4 && parts[1] === 'components') {
          result = await options.courses.submitComponentReport(identity, parts[0]!, parts[2]!, await readLearningBody(request));
        } else throw new StorageError('missing');
      } else if (route.startsWith('models/')) {
        const identity = await current(request);
        if (request.headers['x-xj-expected-subject'] && request.headers['x-xj-expected-subject'] !==
          [identity.environmentId, identity.spaceId, identity.principalId].join('.')) throw new StorageError('forbidden');
        if (!options.models) throw new StorageError('unavailable');
        if (method !== 'GET' && method !== 'POST') throw new StorageError('missing');
        result = await routeModels(options.models, identity, route, method === 'POST'
          ? await readLearningBody(request, route === 'models/images' ? 360000 : 65536) : undefined,
          personalProfile ? await (readOnly ? spaces.readPersonal() : spaces.personal()) : undefined);
      } else if (!learning) throw new StorageError('forbidden');
      else if (route === 'course-activities' && method === 'POST') {
        result = await learning.createCourse(await current(request), await readLearningBody(request));
      } else if (route.startsWith('course-activity-results/') && method === 'GET') {
        result = await learning.courseResult(await current(request), route.slice('course-activity-results/'.length));
      } else if (route.startsWith('executions/')) {
        // The execution owner answers accept, query, report, stop and result under one identity.
        const identity = await current(request);
        if (request.headers['x-xj-expected-subject'] && request.headers['x-xj-expected-subject'] !==
          [identity.environmentId, identity.spaceId, identity.principalId].join('.')) throw new StorageError('forbidden');
        const parts = route.split('/');
        if (parts.length === 2 && method === 'POST')
          result = await learning.executions.accept(identity, parts[1]!, await readLearningBody(request, 8000000));
        else if ((parts.length === 3 || parts.length === 4) && parts[2] === 'history' && method === 'GET')
          result = await learning.executions.history(identity, parts[1]!, parts[3]);
        else if (parts.length === 4 && parts[3] === 'artifact' && method === 'GET')
          result = await learning.executions.artifact(identity, parts[1]!, parts[2]!);
        else if (parts.length === 3 && parts[2] === 'sessions' && method === 'GET')
          result = await learning.executions.sessions(identity, parts[1]!);
        else if ((parts.length === 3 || parts.length === 4) && parts[2] === 'checkpoints' && method === 'GET')
          result = await learning.executions.checkpoints(identity, parts[1]!, parts[3]);
        else if (parts.length === 3 && method === 'GET') result = await learning.executions.read(identity, parts[1]!, parts[2]!);
        else if (parts.length === 5 && parts[3] === 'controls' && method === 'GET')
          result = await learning.executions.controlReceipt(identity, parts[1]!, parts[2]!, parts[4]!);
        else if (parts.length === 4 && parts[3] === 'control' && method === 'POST')
          result = await learning.executions.control(identity, parts[1]!, parts[2]!, await readLearningBody(request, 65536));
        else if (parts.length === 4 && parts[3] === 'report' && method === 'POST')
          result = await learning.executions.report(identity, parts[1]!, parts[2]!, await readLearningBody(request, 65536));
        else if (parts.length === 4 && parts[3] === 'stop' && method === 'POST')
          result = await learning.executions.stop(identity, parts[1]!, parts[2]!, await readLearningBody(request));
        else if (parts.length === 4 && parts[3] === 'result' && method === 'POST')
          result = await learning.executions.result(identity, parts[1]!, parts[2]!, await readLearningBody(request, 8000000));
        else throw new StorageError('missing');
      } else if (route.startsWith('intents/')) {
        const identity = await current(request);
        if (request.headers['x-xj-expected-subject'] && request.headers['x-xj-expected-subject'] !==
          [identity.environmentId, identity.spaceId, identity.principalId].join('.')) throw new StorageError('forbidden');
        const parts = route.split('/');
        if (parts.length === 2 && method === 'GET') result = await learning.intents.list(identity, parts[1]!);
        else if (parts.length === 2 && method === 'POST') result = await learning.intents.prepare(identity, parts[1]!, await readLearningBody(request, 16000000));
        else if (parts.length === 3 && parts[2] === 'capabilities' && method === 'GET') result = await learning.intents.capabilities(identity, parts[1]!);
        else if (parts.length === 3 && method === 'GET') result = await learning.intents.read(identity, parts[1]!, parts[2]!);
        else if (parts.length === 4 && parts[3] === 'dispatch' && method === 'POST') result = await learning.intents.dispatch(identity, parts[1]!, parts[2]!);
        else if (parts.length === 4 && parts[3] === 'cancel' && method === 'POST') result = await learning.intents.cancel(identity, parts[1]!, parts[2]!);
        else throw new StorageError('missing');
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
      if (route === 'models/selection' && method === 'GET' && await options.restoredInstallation?.())
        result = { ...modelSelectionSchema.parse(result), restoredInstallation: true };
      if (componentView) {
        const bundle = componentBundleSchema.parse(result);
        if (new URL(request.url!, endpoint).searchParams.get('digest') !== bundle.definition.digest) throw new StorageError('conflict');
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
          'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
          'permissions-policy': 'camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=()',
          'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src data:; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; sandbox allow-scripts; frame-ancestors 'self'" });
        response.end(Buffer.from(bundle.contentBase64, 'base64'));
      } else sendLearning(response, 200, result);
    } catch (error) { learningFailure(response, error); }
    return true;
  };
}
