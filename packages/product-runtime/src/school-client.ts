import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { join } from 'node:path';
import { z } from 'zod';
import { StorageError } from '@xunjie/storage';
import { spaceIdentitySchema, learningTargetSchema } from '@xunjie/contracts/spaces';
import { activitySchema, courseActivityResultSchema } from '@xunjie/contracts/learning-data';
import { courseCatalogSchema, courseMaterialContentSchema, courseReleaseSchema } from '@xunjie/contracts/courses';
import { componentAlgorithmBundleSchema, componentBundleSchema, componentDependencyContentSchema, componentPreparationReportsSchema,
  componentPreparationReportReceiptSchema } from '@xunjie/contracts/components';
import { executionQuerySchema, executionControlReceiptSchema, checkpointPageSchema, executionHistoryPageSchema,
  executionArtifactSchema, type ExecutionQuery } from '@xunjie/contracts/execution';
import { questionDraftViewSchema } from '@xunjie/contracts/question-drafts';
import { actionViewSchema, actionReceiverSchema } from '@xunjie/contracts/action-intents';
import { courseBindingStateSchema } from '@xunjie/contracts/courses';
import type { SpaceAuthority, LearningTarget } from '@xunjie/contracts/spaces';
import type { CourseBindingAuthority } from '@xunjie/contracts/courses';
import type { createLearningData } from '@xunjie/learning-space';
import { modelDeviceTaskSchema, routeModels, ModelCapabilityError } from '@xunjie/learning-space';
import type { createModelGateway } from '@xunjie/learning-space';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import { modelSelectionSchema, modelAttemptSchema, schoolModelSchema, modelCheckInputSchema, modelSegmentInputSchema, modelChatInputSchema, modelImageInputSchema,
  modelPortableResultSchema, modelSegmentBoundarySchema, modelSegmentProvenanceSchema, modelCapabilityInputSchema, modelCapabilityFailureSchema } from '@xunjie/contracts/model-connections';
import { storageErrorCodes } from '@xunjie/contracts/storage';
import type { RuntimeEnvironment } from '@xunjie/contracts/product-runtime';
import { acquireLock, atomicJson, exists, readJson } from './io.js';
import { createOutboundConnection, RuntimeConnectionError } from './connections.js';
import type { InstalledConfiguration } from './runtime.js';
import { resolveCredential } from './postgres.js';

const grantSchema = z.object({ token: z.string().min(40).max(200), identity: spaceIdentitySchema,
  target: learningTargetSchema, connectionId: z.uuid(), capabilities: z.tuple([z.literal('activity:read'), z.literal('activity:write')]) });
const connectionSchema = z.object({ requestId: z.uuid(), schoolEndpoint: z.url(), verifier: z.string(),
  clientId: z.uuid(), clientNamespace: z.string(), grant: grantSchema.optional(),
  localBinding: z.object({ runtimeConnectionId: z.uuid(), target: learningTargetSchema }).strict().optional() });
type Connection = z.infer<typeof connectionSchema>;
const cleanupDestinationSchema = z.object({ connectionId: z.uuid(), schoolEndpoint: z.url().refine(value => {
  const url = new URL(value);
  return value === url.origin && (url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname));
}) }).strict();
const modelTaskAuthorization = new AsyncLocalStorage<() => Promise<void>>();

/** Installed client retains only its own verifier and scoped grant, never the school's account database. */
export function createSchoolClient(root: string, environment: RuntimeEnvironment, local?: {
  target: LearningTarget;
  create?(authority: SpaceAuthority, courses: CourseBindingAuthority): ReturnType<typeof createLearningData>;
  models?: Awaited<ReturnType<typeof createModelGateway>> | undefined;
  personal?(): Promise<SpaceIdentity>;
}) {
  const ref = (id: string) => `school-client-${z.uuid().parse(id)}`;
  const path = (id: string) => join(root, 'credentials', ref(id));
  const cleanupPath = (id: string) => join(root, 'native-channel', z.uuid().parse(id), 'endpoint.json');
  async function rememberCleanupDestination(connection: Connection) {
    const destination = cleanupDestinationSchema.parse({ connectionId: connection.requestId, schoolEndpoint: connection.schoolEndpoint });
    const path = cleanupPath(connection.requestId);
    if (await exists(path)) {
      const original = cleanupDestinationSchema.parse(await readJson(path));
      if (original.connectionId !== destination.connectionId || original.schoolEndpoint !== destination.schoolEndpoint)
        throw new StorageError('identity-conflict');
      return;
    }
    await mkdir(join(root, 'native-channel', connection.requestId), { recursive: true, mode: 0o700 });
    await atomicJson(path, destination);
  }
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
  async function call(connection: Pick<Connection, 'schoolEndpoint' | 'grant'>, route: string, body?: unknown, authorized = false) {
    let response: Response;
    try {
      response = await fetch(new URL('/api/learning/' + route, connection.schoolEndpoint), {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { 'content-type': 'application/json', ...(authorized ? { authorization: `Bearer ${connection.grant!.token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new StorageError('unavailable'); }
    if (!response.ok) {
      const value = await response.json().catch(() => null);
      const capability = modelCapabilityFailureSchema.safeParse(value);
      if (capability.success) throw new ModelCapabilityError(capability.data.decision);
      const failure = z.object({ error: z.enum(storageErrorCodes) }).safeParse(value);
      if (failure.success) throw new StorageError(failure.data.error);
      const code = response.status === 403 ? 'forbidden' : response.status === 404 ? 'missing'
        : 'unavailable';
      throw new StorageError(code);
    }
    return response.json() as Promise<unknown>;
  }
  const subject = (identity: SpaceIdentity) => [identity.environmentId, identity.spaceId, identity.principalId, identity.kind].join('.');
  async function modelAccess(connection: Connection) {
    if (!connection.grant) throw new StorageError('forbidden');
    const value = z.object({ identity: spaceIdentitySchema, target: learningTargetSchema }).strict().parse(await call(connection, 'access', undefined, true));
    if (subject(value.identity) !== subject(connection.grant.identity)
      || JSON.stringify(value.target) !== JSON.stringify(connection.grant.target)) throw new StorageError('forbidden');
    return value.identity;
  }
  async function identityConnection(identity: SpaceIdentity) {
    for (const item of await list()) {
      if (subject(item.identity) !== subject(identity)) continue;
      const connection = await read(item.key.slice('school:'.length));
      await modelAccess(connection); return connection;
    }
    throw new StorageError('forbidden');
  }
  async function authorizeModel(identity: SpaceIdentity) {
    await identityConnection(identity);
    await modelTaskAuthorization.getStore()?.();
  }
  async function schoolModel(identity: SpaceIdentity) {
    const connection = await identityConnection(identity);
    const selection = modelSelectionSchema.parse(await call(connection, 'models/selection', undefined, true));
    const school = selection.options.find(item => item.kind === 'school');
    return school ? schoolModelSchema.parse(school) : null;
  }
  async function modelForward(connection: Connection, route: string, body?: unknown) {
    const identity = await modelAccess(connection), models = local?.models;
    if (!models) return call(connection, route, body, true);
    const personal = await local?.personal?.();
    const localCall = (input = body) => routeModels(models, identity, route, input, personal);
    const remoteCall = (input = body) => call(connection, route, input, true);
    if (route === 'models/capabilities' && body !== undefined) {
      const input = modelCapabilityInputSchema.parse(body);
      if ('school' in input.source) return remoteCall(input);
      if ('selected' in input.source) {
        const selected = modelSelectionSchema.parse(await models.selection.read(identity, personal));
        if (selected.version !== input.source.selectionVersion) throw new StorageError('conflict');
        if (selected.selected?.kind === 'school') return remoteCall({ ...input, source: { school: {
          connectionId: selected.selected.connection.connectionId, version: selected.selected.connection.version } } });
      }
      return localCall(input);
    }
    type Binding = Awaited<ReturnType<typeof models.routing.bind>>;
    async function portableResult(resultRef: string) {
      try { return { ...await models!.results.read(identity, resultRef), destination: 'local' as const }; }
      catch (error) { if (!(error instanceof StorageError) || error.code !== 'missing') throw error; }
      return { ...modelPortableResultSchema.parse(await call(connection, 'models/results/' + resultRef, undefined, true)), destination: 'school' as const };
    }
    async function portableSegment(input: z.infer<typeof modelSegmentInputSchema>, binding: Binding) {
      let provenance = binding.provenance;
      if (!provenance) {
        const results = [];
        for (const item of input.portable) if (item.resultRef) {
          const { text: _text, ...reference } = await portableResult(item.resultRef); results.push(reference);
        }
        let boundary;
        if (input.previousSegmentId) {
          const old = await models!.routing.read(identity, 'segment', input.previousSegmentId);
          if (!old) throw new StorageError('missing');
          if (old.destination !== binding.destination) {
            const view = old.destination === 'local' ? await models!.segments.read(identity, input.previousSegmentId)
              : z.object({ sequence: z.number().int().nonnegative() }).parse(await call(connection, 'models/segments/' + input.previousSegmentId, undefined, true));
            const close = { requestId: input.requestId, expectedSequence: view.sequence };
            const closed = old.destination === 'local' ? await models!.segments.close(identity, input.previousSegmentId, close)
              : z.object({ boundary: modelSegmentBoundarySchema }).parse(await call(connection, 'models/segments/' + input.previousSegmentId + '/close', close, true));
            boundary = { ...closed.boundary, destination: old.destination };
          }
        }
        provenance = modelSegmentProvenanceSchema.parse({ ...(boundary ? { boundary } : {}), results });
        await models!.routing.provenance(identity, input.segmentId, provenance);
      }
      const forwarded = { ...input, portable: input.portable.map(item => provenance!.results.some(reference => reference.resultRef === item.resultRef && reference.destination !== binding.destination)
        ? { text: item.text } : item) };
      if (provenance.boundary && provenance.boundary.destination !== binding.destination) delete forwarded.previousSegmentId;
      return { provenance, input: forwarded };
    }
    async function routeBound(kind: 'attempt' | 'segment' | 'image', id: string, input: unknown,
      choose: () => Promise<Omit<Binding, 'fingerprint'>>) {
      const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      let binding = await models!.routing.read(identity, kind, id);
      if (binding && binding.fingerprint !== fingerprint) throw new StorageError('identity-conflict');
      binding ??= await models!.routing.bind(identity, kind, id, { ...await choose(), fingerprint });
      const portable = kind === 'segment' ? await portableSegment(modelSegmentInputSchema.parse(input), binding) : null;
      const forwarded = portable?.input ?? input;
      const result = await (binding.destination === 'local' ? localCall(forwarded) : remoteCall(binding.schoolSource
        ? { ...(forwarded as Record<string, unknown>), source: binding.schoolSource } : forwarded));
      return portable ? { ...(result as Record<string, unknown>), provenance: portable.provenance } : result;
    }
    if (/^models\/results\/[^/]+$/.test(route) && body === undefined) {
      const { destination: _destination, ...result } = await portableResult(route.split('/')[2]!); return result;
    }
    if (route === 'models/checks' && body === undefined) {
      const remote = z.array(modelAttemptSchema).parse(await remoteCall());
      const own = (await models.checks.list(identity)).filter(item => item.purpose === 'connection-check');
      return [...own, ...remote].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50);
    }
    if (/^models\/(?:checks|calls)\/[^/]+(?:\/(?:dispatch|cancel))?$/.test(route)) {
      const binding = await models.routing.read(identity, 'attempt', route.split('/')[2]!);
      if (!binding) throw new StorageError('missing');
      return binding.destination === 'local' ? localCall() : remoteCall();
    }
    if (/^models\/segments\/[^/]+(?:\/(?:tool-results|close))?$/.test(route)) {
      const binding = await models.routing.read(identity, 'segment', route.split('/')[2]!);
      if (!binding) throw new StorageError('missing');
      const result = await (binding.destination === 'local' ? localCall() : remoteCall());
      return binding.provenance ? { ...(result as Record<string, unknown>), provenance: binding.provenance } : result;
    }
    if (route === 'models/calls' && body !== undefined) {
      const input = modelChatInputSchema.parse(body);
      return routeBound('attempt', input.attemptId, input, async () => {
        const segment = await models.routing.read(identity, 'segment', input.segmentId);
        if (!segment) throw new StorageError('missing'); return { destination: segment.destination };
      });
    }
    if ((route === 'models/checks' || route === 'models/segments') && body !== undefined) {
      const input = route === 'models/checks' ? modelCheckInputSchema.parse(body) : modelSegmentInputSchema.parse(body);
      return routeBound('attemptId' in input ? 'attempt' : 'segment', 'attemptId' in input ? input.attemptId : input.segmentId, input, async () => {
        if ('school' in input.source) return { destination: 'school', schoolSource: input.source };
        if ('selected' in input.source) {
          const selected = modelSelectionSchema.parse(await models.selection.read(identity, personal));
          if (selected.version !== input.source.selectionVersion) throw new StorageError('conflict');
          if (selected.selected?.kind === 'school') return { destination: 'school', schoolSource: { school: {
            connectionId: selected.selected.connection.connectionId, version: selected.selected.connection.version } } };
        }
        return { destination: 'local' };
      });
    }
    if (route === 'models/images') {
      const input = modelImageInputSchema.parse(body);
      return routeBound('image', input.imageId, input, async () => {
        const selected = modelSelectionSchema.parse(await models.selection.read(identity, personal));
        return { destination: selected.selected?.kind === 'school' ? 'school' : 'local' };
      });
    }
    return localCall();
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
      if (connection.grant) {
        await rememberCleanupDestination(connection);
        result.push({ key: `school:${connection.requestId}`, identity: connection.grant.identity, cleanupEndpoint: connection.schoolEndpoint });
      }
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
      await rememberCleanupDestination(current);
      current.grant = grant;
      await atomicJson(path(requestId), current);
      return view(current);
    });
  }
  async function authorityCall(connection: Connection, runtimeConnectionId: string, operation: string, input?: unknown) {
    const config = await readJson<InstalledConfiguration>(join(root, 'installation.json'));
    const transport = config.connections.find(item => item.connectionId === runtimeConnectionId);
    if (!local || !connection.grant || !transport || transport.sourceEnvironmentId !== local.target.environmentId
      || transport.sourceServiceId !== local.target.serviceId || transport.target.environmentId !== connection.grant.identity.environmentId
      || !transport.requiredCapabilities.includes('learning.authority')
      || new URL(transport.target.endpoint).origin !== connection.schoolEndpoint) throw new StorageError('forbidden');
    let value: unknown;
    try {
      value = await createOutboundConnection({ connection: transport, credential: () => resolveCredential(root, transport.credentialRef),
        allowInsecureLoopback: true, timeoutMs: 15000 }).request('learning.authority', { token: connection.grant.token, operation, input });
    } catch (error) {
      throw new StorageError(error instanceof RuntimeConnectionError && ['http_401', 'http_403', 'credential_unavailable'].includes(error.code) ? 'forbidden' : 'unavailable');
    }
    const failure = z.object({ error: z.enum(storageErrorCodes) }).safeParse(value);
    if (failure.success) throw new StorageError(failure.data.error);
    return value;
  }
  async function checkLocal(connection: Connection, runtimeConnectionId: string) {
    const result = z.object({ identity: spaceIdentitySchema, target: learningTargetSchema }).strict()
      .parse(await authorityCall(connection, runtimeConnectionId, 'access'));
    if (!local || JSON.stringify(result.identity) !== JSON.stringify(connection.grant!.identity)
      || JSON.stringify(result.target) !== JSON.stringify(local.target)
      || JSON.stringify(result.target) !== JSON.stringify(connection.grant!.target)) throw new StorageError('forbidden');
    return result;
  }
  async function pollModelTasks(isOpen: () => boolean) {
    if (!local?.models) return;
    for (const item of await list()) {
      if (!isOpen()) return;
      const connection = await read(item.key.slice('school:'.length));
      if (!connection.localBinding || !connection.grant) continue;
      const { runtimeConnectionId } = connection.localBinding;
      try {
        const tasks = z.array(modelDeviceTaskSchema).max(16)
          .parse(await authorityCall(connection, runtimeConnectionId, 'pollModelTasks'));
        const task = tasks[0];
        if (!task || !isOpen()) continue;
        const route = task.operation === 'receive' ? 'models/calls' : `models/calls/${task.attemptId}`
          + (task.operation === 'read' ? '' : `/${task.operation}`);
        let receipt;
        try {
          const input = task.operation === 'receive' ? task.input : task.operation === 'read' ? undefined : {};
          const identity = connection.grant.identity;
          const value = await modelTaskAuthorization.run(async () => {
            if (!isOpen()) throw new StorageError('maintenance');
            // The Gateway checks again immediately before SDK dispatch, including in its background task.
            await checkLocal(connection, runtimeConnectionId);
          }, () => routeModels(local.models!, identity, route, input));
          receipt = { ok: true, value: modelAttemptSchema.parse(value) };
        } catch (error) {
          const code = error instanceof StorageError ? error.code : 'invalid';
          if (code !== 'forbidden' && code !== 'missing' && code !== 'conflict' && code !== 'invalid' && code !== 'unavailable') continue;
          receipt = { ok: false, code };
        }
        if (!isOpen()) return;
        await authorityCall(connection, runtimeConnectionId, 'completeModelTask', { taskId: task.taskId, receipt });
      } catch {
        // An offline or fenced pairing leaves the task at the school for authenticated reconciliation.
      }
    }
  }
  async function configureLocal(value: unknown) {
    const input = z.object({ connectionId: z.uuid(), runtimeConnectionId: z.uuid(), target: learningTargetSchema }).strict().parse(value);
    if (!local || JSON.stringify(input.target) !== JSON.stringify(local.target)) throw new StorageError('forbidden');
    const connection = await read(input.connectionId);
    await checkLocal(connection, input.runtimeConnectionId);
    return update(input.connectionId, async () => {
      const current = await read(input.connectionId);
      if (current.grant?.token !== connection.grant?.token) throw new StorageError('forbidden');
      if (current.localBinding && JSON.stringify(current.localBinding) !== JSON.stringify({ runtimeConnectionId: input.runtimeConnectionId, target: input.target })) throw new StorageError('identity-conflict');
      current.localBinding = { runtimeConnectionId: input.runtimeConnectionId, target: input.target };
      await atomicJson(path(input.connectionId), current);
      return { identity: current.grant!.identity, target: input.target, configured: true };
    });
  }
  async function localForward(connection: Connection, route: string, body?: unknown) {
    const binding = connection.localBinding!;
    const sameIdentity = (identity: unknown) => {
      if (JSON.stringify(identity) !== JSON.stringify(connection.grant!.identity)) throw new StorageError('forbidden');
    };
    if (!local?.create) throw new StorageError('unavailable');
    const learning = local.create({ async resolveBinding(identity) {
      sameIdentity(identity); return (await checkLocal(connection, binding.runtimeConnectionId)).target;
    } }, {
      async prepare(input) { sameIdentity(input.identity);
        const { identity: _identity, target: _target, ...request } = input;
        return courseBindingStateSchema.parse(await authorityCall(connection, binding.runtimeConnectionId, 'prepare', request)); },
      async confirm(input) { return courseBindingStateSchema.parse(await authorityCall(connection, binding.runtimeConnectionId, 'confirm', input)); },
      async authorize(identity, pointer) { sameIdentity(identity); await authorityCall(connection, binding.runtimeConnectionId, 'authorize', {
        associationId: pointer.associationId, releaseId: pointer.releaseId, contentDigest: pointer.contentDigest }); },
      async verifyComponentReference(identity, reference) { sameIdentity(identity);
        z.object({ verified: z.literal(true) }).strict().parse(await authorityCall(connection, binding.runtimeConnectionId, 'verifyComponentReference', reference)); },
      async verifyReference(identity, reference) { sameIdentity(identity);
        z.object({ verified: z.literal(true) }).strict().parse(await authorityCall(connection, binding.runtimeConnectionId, 'verifyReference', reference)); },
    });
    const identity = connection.grant!.identity;
    if (route === 'activities') return body === undefined ? learning.list(identity) : learning.create(identity, body as never);
    if (route.startsWith('activities/')) return learning.open(identity, route.slice(11));
    if (route === 'activity-status') return learning.setStatus(identity, body as never);
    if (route.startsWith('receipts/')) return learning.receipt(identity, route.slice(9));
    if (route === 'course-activities') return learning.createCourse(identity, body);
    if (route.startsWith('course-activity-results/')) return learning.courseResult(identity, route.slice('course-activity-results/'.length));
    const parts = route.split('/');
    if (parts[0] === 'intents') {
      if (parts.length === 2) return body === undefined ? learning.intents.list(identity, parts[1]!) : learning.intents.prepare(identity, parts[1]!, body);
      if (parts.length === 3 && parts[2] === 'capabilities' && body === undefined) return learning.intents.capabilities(identity, parts[1]!);
      if (parts.length === 3 && body === undefined) return learning.intents.read(identity, parts[1]!, parts[2]!);
      if (parts.length === 4 && body !== undefined && parts[3] === 'dispatch') return learning.intents.dispatch(identity, parts[1]!, parts[2]!);
      if (parts.length === 4 && body !== undefined && parts[3] === 'cancel') return learning.intents.cancel(identity, parts[1]!, parts[2]!);
      throw new StorageError('forbidden');
    }
    if (parts[0] === 'drafts') {
      if (parts.length === 2) return body === undefined ? learning.drafts.read(identity, parts[1]!) : learning.drafts.sync(identity, parts[1]!, body);
      if (parts[2] === 'receipts') return learning.drafts.receipt(identity, parts[1]!, parts[3]!);
      return learning.drafts.revision(identity, parts[1]!, parts[3]!);
    }
    if (parts[0] === 'executions') {
      // A run is owned by the same activity the grant names; the fixed basis never travels elsewhere.
      if (parts.length === 2 && body !== undefined) return learning.executions.accept(identity, parts[1]!, body);
      if ((parts.length === 3 || parts.length === 4) && parts[2] === 'history' && body === undefined)
        return learning.executions.history(identity, parts[1]!, parts[3]);
      if (parts.length === 4 && parts[3] === 'artifact' && body === undefined)
        return learning.executions.artifact(identity, parts[1]!, parts[2]!);
      if (parts.length === 3 && parts[2] === 'sessions' && body === undefined) return learning.executions.sessions(identity, parts[1]!);
      if ((parts.length === 3 || parts.length === 4) && parts[2] === 'checkpoints' && body === undefined)
        return learning.executions.checkpoints(identity, parts[1]!, parts[3]);
      if (parts.length === 3 && body === undefined) return learning.executions.read(identity, parts[1]!, parts[2]!);
      if (parts.length === 5 && parts[3] === 'controls' && body === undefined) return learning.executions.controlReceipt(identity, parts[1]!, parts[2]!, parts[4]!);
      if (parts.length === 4 && parts[3] === 'control' && body !== undefined) return learning.executions.control(identity, parts[1]!, parts[2]!, body);
      if (parts.length === 4 && body !== undefined && parts[3] === 'report') return learning.executions.report(identity, parts[1]!, parts[2]!, body);
      if (parts.length === 4 && body !== undefined && parts[3] === 'stop') return learning.executions.stop(identity, parts[1]!, parts[2]!, body);
      if (parts.length === 4 && body !== undefined && parts[3] === 'result') return learning.executions.result(identity, parts[1]!, parts[2]!, body);
      throw new StorageError('forbidden');
    }
    if (parts[0] !== 'workspaces') throw new StorageError('forbidden');
    if (parts.length === 2) return body === undefined ? learning.works.read(identity, parts[1]!) : learning.works.sync(identity, parts[1]!, body as never);
    if (parts[2] === 'receipts') return learning.works.receipt(identity, parts[1]!, parts[3]!);
    return learning.works.content(identity, parts[1]!, parts[3]!);
  }
  async function forward(connectionId: string, route: string, body?: unknown, expectedSubject?: string) {
    const id = '[0-9a-f-]{36}';
    const key = '[a-z][a-z0-9-]{0,47}';
    if (!new RegExp(`^(?:execution-environment|activities(?:/${id})?|activity-status|receipts/${id}|courses|releases/${id}` +
      `|releases/${id}/materials/${id}|releases/${id}/components/${key}(?:/algorithm|/dependencies/${key}|/preparation-reports?)?` +
      `|course-activities|course-activity-results/${id}|workspaces/${id}(?:/(?:receipts|contents)/${id})?` +
      `|drafts/${id}(?:/(?:receipts|revisions)/${id})?|intents/${id}(?:/capabilities|/${id}(?:/(?:dispatch|cancel))?)?|executions/${id}(?:/(?:sessions|history(?:/${id})?|checkpoints(?:/${id})?|${id}(?:/(?:report|stop|result|control|artifact)|/controls/${id})?))?` +
      `|models/(?:selection|connections|capabilities|images|results/${id}|grants(?:/${id}/revoke)?|segments(?:/${id}(?:/(?:tool-results|close))?)?|checks(?:/${id}(?:/(?:dispatch|cancel))?)?|calls(?:/${id}(?:/(?:dispatch|cancel))?)?)|connections/revoke)$`).test(route)) {
      throw new StorageError('forbidden');
    }
    const connection = await read(connectionId);
    if (!connection.grant) throw new StorageError('forbidden');
    if (expectedSubject && expectedSubject !== [connection.grant.identity.environmentId, connection.grant.identity.spaceId,
      connection.grant.identity.principalId].join('.')) throw new StorageError('forbidden');
    if (route.startsWith('models/')) return modelForward(connection, route, body);
    if (connection.localBinding && /^(activities|activity-status|receipts|course-activities|course-activity-results|workspaces|drafts|intents|executions)(\/|$)/.test(route)) {
      if (!local) throw new StorageError('unavailable');
      return localForward(connection, route, body);
    }
    if (!connection.localBinding && local && JSON.stringify(connection.grant.target) === JSON.stringify(local.target)
      && !['connections/revoke', 'courses'].includes(route) && !route.startsWith('releases/')) throw new StorageError('unavailable');
    let value: unknown;
    try { value = await call(connection, route, body, true); }
    catch (error) {
      // The school may already have revoked this grant (or the membership).
      if (route !== 'connections/revoke' || !(error instanceof StorageError) || error.code !== 'forbidden') throw error;
      await update(connectionId, () => rm(path(connectionId), { force: true }));
      return { revoked: true };
    }
    if (route === 'connections/revoke') {
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
    if (route.startsWith('intents/')) {
      if (route.endsWith('/capabilities')) return parsed(z.array(actionReceiverSchema), value);
      const checkIntent = (candidate: unknown) => {
        const intent = parsed(actionViewSchema, candidate), scope = intent.input.scope, identity = connection.grant!.identity;
        if (scope.environmentId !== identity.environmentId || scope.spaceId !== identity.spaceId || scope.principalId !== identity.principalId
          || scope.activityId !== route.split('/')[1]) throw new StorageError('forbidden');
        return intent;
      };
      if (route.split('/').length === 2 && body === undefined) {
        if (!Array.isArray(value)) throw new StorageError('unavailable');
        return value.map(checkIntent);
      }
      return value === null ? null : checkIntent(value);
    }
    if (route.startsWith('drafts/')) return value === null ? null : parsed(questionDraftViewSchema, value);
    if (route === 'courses') return parsed(courseCatalogSchema, value);
    if (route.startsWith('executions/')) {
      if (value === null) return null;
      const identity = connection.grant!.identity;
      const checkScope = (scope: ExecutionQuery['scope']) => {
        if (scope.environmentId !== identity.environmentId || scope.spaceId !== identity.spaceId
          || scope.principalId !== identity.principalId || scope.activityId !== route.split('/')[1]) throw new StorageError('forbidden');
      };
      const checkQuery = (candidate: unknown) => {
        const query = parsed(executionQuerySchema, candidate);
        checkScope(query.scope);
        return query;
      };
      if (route.split('/')[2] === 'checkpoints') {
        const page = parsed(checkpointPageSchema, value);
        page.items.forEach(item => checkScope(item.scope));
        return page;
      }
      if (route.split('/')[2] === 'history') {
        const page = parsed(executionHistoryPageSchema, value);
        page.entries.forEach(item => { checkScope(item.action.scope); checkScope(item.query.scope); });
        return page;
      }
      if (route.endsWith('/artifact')) {
        const artifact = parsed(executionArtifactSchema, value);
        checkScope(artifact.scope);
        if (artifact.requestId !== route.split('/')[2]) throw new StorageError('forbidden');
        return artifact;
      }
      if (route.endsWith('/sessions')) return Array.isArray(value) ? value.map(checkQuery) : checkQuery(value);
      if (route.split('/')[3] === 'controls') {
        const receipt = parsed(executionControlReceiptSchema, value), parts = route.split('/');
        checkQuery(receipt.query);
        if (receipt.requestId !== parts[2] || receipt.controlId !== parts[4] || receipt.executionRef !== receipt.query.executionRef)
          throw new StorageError('forbidden');
        return receipt;
      }
      return checkQuery(value);
    }
    if (route.startsWith('releases/')) {
      const parts = route.split('/');
      if (parts[2] === 'components') {
        if (parts[4] === 'algorithm') return parsed(componentAlgorithmBundleSchema, value);
        if (parts[4] === 'dependencies') return parsed(componentDependencyContentSchema, value);
        if (parts[4] === 'preparation-reports') return parsed(componentPreparationReportsSchema, value);
        if (parts[4] === 'preparation-report') return parsed(componentPreparationReportReceiptSchema, value);
        return parsed(componentBundleSchema, value);
      }
      return parts.length === 2 ? parsed(courseReleaseSchema, value) : parsed(courseMaterialContentSchema, value);
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
  async function nativeChannelCall(connectionId: string, operation: 'register' | 'claim' | 'report' | 'heartbeat' | 'cleanup', input: unknown) {
    z.enum(['register', 'claim', 'report', 'heartbeat', 'cleanup']).parse(operation);
    if (operation === 'cleanup') {
      const destination = cleanupDestinationSchema.parse(await readJson(cleanupPath(connectionId)));
      if (destination.connectionId !== connectionId) throw new StorageError('forbidden');
      return call(destination, 'native-channel/cleanup', input);
    }
    const connection = await read(connectionId);
    if (!connection.grant) throw new StorageError('forbidden');
    await rememberCleanupDestination(connection);
    return call(connection, `native-channel/${operation}`, input, true);
  }
  return { list, start, complete, configureLocal, forward, nativeChannelCall, authorizeModel, schoolModel, pollModelTasks };
}
