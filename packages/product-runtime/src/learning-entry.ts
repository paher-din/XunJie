import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { createFileBackend, openStorage, provisionStorage, StorageError } from '@xunjie/storage';
import pg from 'pg';
import { z } from 'zod';
import type { OwnedStorage, StorageBinding, DatabaseConnection } from '@xunjie/storage';
import { createSpaces, spaceMigrations, createLearningData, learningMigrations, createLearningEntry, validateLearningData,
  createCourses, spaceCourseMigrations, createLearningAuthority, linuxSessionEntry, productNativeAdapters, createNativeChannel,
  collectExecutionBoundary, validateExecutionBoundary, createTeachingAgent, createTeachingTools, teachingAgentMigrations, validateTeachingAgent,
  collectLearningSources, validateLearningSources, collectTeachingSources, validateTeachingSources } from '@xunjie/learning-space';
import type { RuntimeEnvironment } from '@xunjie/contracts/product-runtime';
import type { ExecutionDevice } from '@xunjie/contracts/execution';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import type { ActionIntentOptions, NativeSessionIsolation } from '@xunjie/learning-space';
import { createModelGateway, modelDeviceTaskSchema, modelMigrations } from '@xunjie/learning-space';
import { spaceIdentitySchema } from '@xunjie/contracts/spaces';
import type { InstalledConfiguration } from './runtime.js';
import { databaseBinding, resolveCredential, storeCredential } from './postgres.js';
import { atomicJson, exists, alive, processIdentity, readJson } from './io.js';
import { createStorageRecoveryOwner } from './storage-recovery.js';
import { createStorageRecoveryTarget } from './storage-recovery.js';
import type { RuntimeResources } from './postgres.js';
import { RecoveryError } from './recovery.js';
import type { OwnerBoundaryMaterial, RecoveryOwner } from './recovery-types.js';
import { createSchoolClient } from './school-client.js';
import { createSchoolDeviceSetup, authorizeSchoolDeviceGrant } from './school-device-setup.js';
import { verifyWindowsSessionHelper } from './prerequisites.js';
import { createNativeChannelClients } from './native-channel-clients.js';
import { isInstallationRetired } from './retired-installations.js';
import { isRecoverySuccessor, hasRecoverySuccession } from './recovery-successions.js';
import { withModelOriginRecovery, createModelRecipientRecovery } from './model-origin-authority.js';
import { createStandaloneAgentApplication } from './agent-application.js';
import { createAgentConnection } from './agent-connections.js';
import type { CapabilityHandler } from './connections.js';
import { createConnectionAuthority, RuntimeConnectionError } from './connections.js';
import { createMemberAgentBindings, createActivityAgentRoutes, createTeachingAgentClient,
  createTeachingDependencyService, teachingDependencyCallSchema, learningModelRequestSchema, createChunkChannel,
  createPairedLearningModels, createLearningModelService, createLearningModelClient } from '@xunjie/learning-space';
import { createTeachingDataClient, createTeachingDataService, createExecutionOwner, executionOwnerMigrations,
  validateExecutionOwner, createCourseExecutionDesign } from '@xunjie/learning-space';
import { isTeachingDependencyRead } from '@xunjie/learning-space';
import type { TeachingDispatchAuthority, TeachingToolData } from '@xunjie/learning-space';
import type { PairedModelOrigin } from '@xunjie/learning-space';
import type { TeachingAgentPort } from '@xunjie/learning-space';
import { teachingAgentBindingInputSchema, teachingAgentReceiverId } from '@xunjie/contracts/teaching-agent';
import { collectTeachingBoundary, collectTeachingReceiverBoundary, validateTeachingBoundary } from '@xunjie/learning-space';
import { AsyncLocalStorage } from 'node:async_hooks';
import { validateDeployment } from './deployment.js';
import { createExecutionRouting, createSchoolExecutionHandler } from './execution-routing.js';

const agentDependencyAuthorization = new AsyncLocalStorage<(identity: SpaceIdentity) => Promise<void>>();
const agentDependencyFreshAuthorization = new AsyncLocalStorage<() => Promise<void>>();
const agentDependencyContext = new AsyncLocalStorage<{
  input: z.infer<typeof teachingDependencyCallSchema>; source: Parameters<CapabilityHandler>[1];
}>();

function currentExecutionOrigin() {
  const source = agentDependencyContext.getStore()?.source;
  if (!source) return undefined;
  if (!source.sourceInstallationId) throw new StorageError('forbidden');
  return { sourceEnvironmentId: source.sourceEnvironmentId, sourceServiceId: source.sourceServiceId,
    sourceInstallationId: source.sourceInstallationId, grantId: source.grantId };
}

const modelTaskContext = { identity: spaceIdentitySchema,
  binding: z.object({ grantId: z.uuid(), installationId: z.uuid() }).strict() };
const modelTaskRequest = z.discriminatedUnion('operation', [
  z.object({ ...modelTaskContext, operation: z.literal('enqueue'), task: modelDeviceTaskSchema }).strict(),
  z.object({ ...modelTaskContext, operation: z.literal('read'), taskId: z.uuid() }).strict(),
]);

/** Normal product composition; no test hosts, account fixtures or legacy SQLite dependencies. */
export async function createProductLearningApplication(context: {
  root: string; environment: RuntimeEnvironment; configuration: InstalledConfiguration;
  readOnly?: () => Promise<boolean>;
}, actions: ActionIntentOptions = {}) {
  const { root, environment, configuration } = context;
  const deployment = validateDeployment(environment, configuration);
  const enabled = new Set(deployment.modules);
  const localAuthority = new AsyncLocalStorage<TeachingDispatchAuthority>();
  const courseDesignAuthority = new AsyncLocalStorage<() => Promise<void>>();
  const retained = (unit: import('@xunjie/contracts/product-runtime').RuntimeModule) =>
    enabled.has(unit) || environment.services.some(service => service.unit === unit);
  const matchesInstallation = (binding: { installationId: string; target: { environmentId: string; serviceId: string } }, installationId?: string) =>
    installationId ? isRecoverySuccessor(root, { sourceEnvironmentId: binding.target.environmentId,
      sourceServiceId: binding.target.serviceId, sourceInstallationId: binding.installationId }, installationId) : Promise.resolve(false);
  const readOnly = context.readOnly ?? (async () => await exists(join(root, 'recovery-state.json'))
    && (await readJson<{ phase: string }>(join(root, 'recovery-state.json'))).phase !== 'active');
  const isolatedAtStartup = await readOnly();
  const requiresNamespace = await exists(join(root, 'recovery-state.json'));
  const modelOnly = environment.profile === 'model';
  const client = environment.profile === 'school' || environment.profile === 'agent' ? undefined : createSchoolClient(root, environment);
  let schoolClient: ReturnType<typeof createSchoolClient> | undefined;
  const lifecycle = client && enabled.has('tool-execution') ? await createNativeChannelClients({ root, environment, resources: configuration.resources, client }) : undefined;
  const database = await databaseBinding(root, configuration.database);
  if (!database && (environment.profile === 'school' || environment.profile === 'agent' || modelOnly)) throw new Error('This product profile requires PostgreSQL.');
  if (!database) return { owners: [], isolatedReads: true as const, ...(lifecycle ? { lifecycle } : {}), handle: createLearningEntry({ environment,
    administratorToken: await resolveCredential(root, 'control'), client, readOnly, requiresNamespace }) };
  const { credentialRef, ...connection } = database;
  const admin = { ...connection, password: await resolveCredential(root, credentialRef) };
  const opened: OwnedStorage[] = [];
  const owners: RecoveryOwner[] = [];
  let teaching: ReturnType<typeof createTeachingAgent> | undefined;
  try {
    async function owner(unit: 'space-course' | 'learning-data' | 'model-connection' | 'teaching-agent' | 'tool-execution', migrations: typeof spaceMigrations) {
      let descriptor = environment.services.find(item => item.unit === unit);
      if (!descriptor) {
        descriptor = { environmentId: environment.environmentId, serviceId: randomUUID(), unit,
          endpoint: environment.services[0]!.endpoint, protocolVersion: 1, capabilities: unit === 'space-course'
            ? ['spaces.access'] : unit === 'learning-data' ? ['activity:read', 'activity:write'] : [] };
        environment.services.push(descriptor);
        await atomicJson(join(root, 'environment.json'), environment);
      }
      if (!configuration.requiredServiceIds.includes(descriptor.serviceId)) {
        configuration.requiredServiceIds.push(descriptor.serviceId);
        await atomicJson(join(root, 'installation.json'), configuration);
      }
      if (descriptor.endpoint !== environment.services[0]!.endpoint || (unit === 'model-connection' && descriptor.capabilities.length)) {
        descriptor.endpoint = environment.services[0]!.endpoint;
        if (unit === 'model-connection') descriptor.capabilities = [];
        await atomicJson(join(root, 'environment.json'), environment);
      }
      const ref = `storage-${descriptor.serviceId}`;
      const backend = createFileBackend({ id: unit, root: join(root, 'learning-resources', unit) });
      let binding: StorageBinding;
      if (await exists(join(root, 'credentials', ref))) {
        binding = JSON.parse(await resolveCredential(root, ref)) as StorageBinding;
        if (binding.owner.environmentId !== environment.environmentId || binding.owner.serviceId !== descriptor.serviceId)
          throw new Error('Business owner identity mismatch.');
        // An existing binding is opened with its restricted credentials. Privileged provisioning
        // is reserved for a missing migration suffix, never a normal reopen or an identity change.
      } else {
        const passwordRef = `owner-${descriptor.serviceId}`;
        if (!await exists(join(root, 'credentials', passwordRef))) await storeCredential(root, passwordRef, randomBytes(32).toString('base64url'));
        binding = await provisionStorage({ admin, owner: { environmentId: environment.environmentId, serviceId: descriptor.serviceId },
          password: await resolveCredential(root, passwordRef), migrations });
        await storeCredential(root, ref, JSON.stringify(binding));
      }
      if (binding.owner.environmentId !== environment.environmentId || binding.owner.serviceId !== descriptor.serviceId) throw new Error('Business owner identity mismatch.');
      let storage: OwnedStorage;
      try { storage = await openStorage({ binding, backend, migrations }); }
      catch (error) {
        if (!(error instanceof StorageError) || error.code !== 'incompatible') throw error;
        const probe = new pg.Client(binding.connection);
        let missingSuffix = false;
        try {
          await probe.connect();
          const schema = '"' + binding.schema.replaceAll('"', '""') + '"';
          const { rows: [state] } = await probe.query(`SELECT environment_id,service_id FROM ${schema}._storage_identity`);
          const { rows } = await probe.query(`SELECT version FROM ${schema}._storage_migrations ORDER BY version`);
          missingSuffix = state?.environment_id === binding.owner.environmentId && state?.service_id === binding.owner.serviceId
            && rows.length > 0 && rows.length < migrations.length && rows.every((row, index) => row.version === index + 1);
        } finally { await probe.end(); }
        if (!missingSuffix) throw error;
        // Provisioning verifies every recorded checksum and requires closed writes and dispatch.
        binding = await provisionStorage({ admin, owner: binding.owner, password: binding.connection.password, migrations });
        storage = await openStorage({ binding, backend, migrations });
      }
      opened.push(storage);
      return { storage, binding, backend, migrations };
    }
    if (environment.profile === 'agent' && !enabled.has('space-course')) {
      if (!retained('teaching-agent')) return { owners: [], isolatedReads: true as const, async handle() { return false; } };
      const module = await owner('teaching-agent', teachingAgentMigrations);
      const application = createStandaloneAgentApplication({ root, environment, configuration, readOnly,
        storage: module.storage, binding: module.binding, enabled: enabled.has('teaching-agent') });
      await application.start();
      return application;
    }
    const space = retained('space-course') ? await owner('space-course', spaceCourseMigrations) : undefined;
    if (!space) throw new Error('This composition requires a configured identity/course dependency.');
    const data = retained('learning-data') ? await owner('learning-data', learningMigrations) : undefined;
    // An isolated pre-WP06 restore must keep exactly the authenticated backup's owner set through takeover.
    // Its first normal restart after activation initializes the new, empty model owner.
    const deferModel = !environment.services.some(service => service.unit === 'model-connection')
      && await exists(join(root, 'recovery-state.json'))
      && (await readJson<{ phase: string }>(join(root, 'recovery-state.json'))).phase !== 'active';
    const model = deferModel || !retained('model-connection') ? undefined : await owner('model-connection', modelMigrations);
    const spaces = createSpaces(space.storage, { credentialNamespace: environment.installationId });
    const agentBindings = createMemberAgentBindings(space.storage, spaces.authorize);
    const modelGateway = model ? await createModelGateway(model.storage, {
      ...(configuration.learningAdmissionPolicy ? { learningAdmissionPolicy: configuration.learningAdmissionPolicy } : {}),
      holder: environment.profile === 'school' ? 'school' : 'device',
      ...(environment.profile === 'school' ? {} : { deviceOwner: (identity: SpaceIdentity) => identity.kind === 'school' && identity.environmentId === environment.environmentId
        ? Promise.resolve(null) : spaces.readPersonal() }),
      async authorize(identity) {
        await agentDependencyAuthorization.getStore()?.(identity);
        if (identity.environmentId === environment.environmentId) return spaces.authorize(identity);
        if (!client || identity.kind !== 'school') throw new StorageError('forbidden');
        await client.authorizeModel(identity);
      },
      async authorizeDispatch(identity) {
        await agentDependencyFreshAuthorization.getStore()?.();
        if (identity.environmentId === environment.environmentId) return spaces.authorize(identity);
        if (!client || identity.kind !== 'school') throw new StorageError('forbidden');
        await client.authorizeModelDispatch(identity);
        const authority = localAuthority.getStore();
        if (authority) await (schoolClient ?? client).agentDependency(identity, { version: 1, operation: 'authorize', identity,
          activityId: authority.activityId, args: [] });
      },
      async schoolDefault(identity) { return client ? client.schoolModel(identity) : null; }, dispatcher: {
      id: JSON.stringify([hostname(), process.pid, await processIdentity(process.pid), environment.installationId]),
      async hasEnded(id) {
        const [host, pid, birth, installationId] = JSON.parse(id) as [string, number, string | null, string?];
        if (host !== hostname() || (installationId !== undefined && installationId !== environment.installationId)
          || !Number.isSafeInteger(pid) || pid < 1) return false;
        if (!alive(pid)) return true;
        const current = await processIdentity(pid);
        return birth !== null && current !== null && current !== birth;
      },
    } }) : undefined;
    const checkSchoolExecutionRuntime = async ({ placement: planned, binding }: Pick<Parameters<
      NonNullable<Parameters<typeof createCourseExecutionDesign>[1]['prepareSchoolRuntime']>>[0], 'placement' | 'binding'>) => {
        if (!enabled.has('tool-execution') || environment.profile !== 'school' || !independentExecution)
          return { ready: false, detail: '本部署未提供学校执行模块。' };
        const isolation = await independentExecution.executions.linuxEntryIsolation();
        const manifest = binding.definition.manifest;
        const declared = manifest.formatVersion === 1 ? manifest.session : undefined;
        const ready = isolation !== null && new URL(environment.services[0]!.endpoint).protocol === 'https:';
        return { ready: !!declared && ready && planned.target === 'school-runtime'
          && productNativeAdapters.some(item => item.adapterId === declared.adapterId && item.adapterVersion === declared.adapterVersion),
        detail: ready ? '学校执行模块已核验运行资源与隔离入口。' : '学校执行模块尚未完成运行资源和隔离入口准备。' };
      };
    const courses = createCourses(space.storage, spaces, { checkSchoolRuntime: checkSchoolExecutionRuntime });
    const executionDesign = createCourseExecutionDesign(space.storage, {
      authorize: async identity => { await courseDesignAuthority.getStore()?.(); await spaces.authorize(identity); },
      prepareSchoolRuntime: checkSchoolExecutionRuntime,
    });
    const courseExecutionDesign = async (operation: 'compile' | 'prepare' | 'read', value: unknown) => {
      const input = z.object({ identity: spaceIdentitySchema, input: z.unknown().optional(), requestId: z.uuid().optional() }).strict().parse(value);
      if (operation === 'compile') return executionDesign.compileExecutionDesign(input.identity, input.input);
      if (operation === 'prepare') return executionDesign.prepareCourseDeployment(input.identity, input.input);
      return executionDesign.readCourseDeployment(input.identity, z.uuid().parse(input.requestId));
    };
    // A personal install supervises real local sessions. A school host also supervises them: the
    // same native contract runs on the school execution node, and the node identity is derived from
    // the installation so a restart or an address change never reassigns an existing run. On Linux
    // the owner only starts a session through the installed restricted entry; without a passing
    // probe it refuses the run instead of calling a plain child process "confined".
    const models = enabled.has('model-connection') ? modelGateway : undefined;
    if (!enabled.has('model-connection')) modelGateway?.closeWrites();
    const windowsHelper = enabled.has('tool-execution') && environment.profile === 'local' ? await verifyWindowsSessionHelper(configuration.resources) : undefined;
    let linuxEntry: ReturnType<typeof linuxSessionEntry> | undefined;
    if (enabled.has('tool-execution') && environment.profile === 'school' && process.platform === 'linux') {
      try { linuxEntry = linuxSessionEntry(); }
      catch {
        // Invalid native configuration disables that entry while browser work remains available.
        linuxEntry = { entry: '/usr/local/lib/xunjie/native-session-unavailable', sudo: '/usr/bin/sudo',
          workRoot: '/var/lib/xunjie-native', runUser: 'xunjie', nodeRoot: '/opt/xunjie' };
      }
    }
    const supervised = enabled.has('tool-execution') && (environment.profile === 'local' || environment.profile === 'school');
    const placement = { nodeClass: environment.profile === 'school' ? 'school-execution-node' as const : 'device' as const,
      secureTransport: new URL(environment.services[0]!.endpoint).protocol === 'https:' };
    const native = supervised ? { nodePath: process.execPath, placement, readOnly,
      ...(windowsHelper ? { windowsHelper } : {}),
      ...(linuxEntry ? { linuxEntry } : {}),
      sessionRoot: join(root, 'native-sessions'),
      nodeId: environment.profile === 'school' ? `school-${environment.installationId}` : `local-${process.platform}` } : undefined;
    let learning: ReturnType<typeof createLearningData> | undefined;
    const schoolData = createTeachingDataClient(async input => {
      if (!client || !input.identity) throw new StorageError('unavailable');
      return (schoolClient ?? client).agentDependency(input.identity, { ...input,
        ...(localAuthority.getStore() ? { authority: localAuthority.getStore() } : {}) });
    });
    const executionModule = retained('tool-execution') && configuration.deployment
      ? await owner('tool-execution', executionOwnerMigrations) : undefined;
    const independentExecution = executionModule && enabled.has('tool-execution') ? createExecutionOwner(executionModule.storage, {
      installationId: environment.installationId,
      publishRecord: async (identity, activityId, event) => {
        if (identity.environmentId === environment.environmentId) {
          if (!learning) throw new StorageError('unavailable');
          await learning.executionRecords.sync(identity, activityId, event, { sourceOwner: executionModule.storage.owner,
            installationId: environment.installationId, role: 'tool-execution', nodeClass: placement.nodeClass });
        } else {
          if (!schoolClient) throw new StorageError('unavailable');
          await schoolClient.publishExecutionRecord(identity, activityId, event);
        }
      },
      activity: (identity, id) => identity.environmentId === environment.environmentId
        ? learning!.open(identity, id) : schoolData.data.open(identity, id),
      sourceFile: (identity, id, contentId) => identity.environmentId === environment.environmentId
        ? learning!.works.content(identity, id, contentId) : schoolData.data.works.content(identity, id, contentId),
      ...(native ? { native } : {}),
    }) : undefined;
    const nativeChannel = data && enabled.has('learning-data') && enabled.has('tool-execution')
      && !configuration.deployment && environment.profile === 'school' ? createNativeChannel(data.storage, {
      installationActive: async installationId => !await isInstallationRetired(root, installationId),
      authenticate: (token, connectionId) => spaces.authenticateConnection(token, connectionId),
      authorizeConnection: (identity, connectionId) => spaces.authorizeConnection(identity, connectionId),
      authorize: (identity, activityId) => learning!.open(identity, activityId),
      assertAgentDispatch: async (identity, activityId, association) => {
        return (await teachingFor(identity, activityId)).assertCommandDispatch(identity, activityId, association);
      },
    }) : undefined;
    // Activity facts and Skill attachments belong to the activity's fixed Agent owner. The local
    // teaching client and the dependency service must reach that owner through this single seam;
    // changing one without the other would make local and independent Agents diverge again.
    const activityAgentReads: Pick<Parameters<typeof createTeachingTools>[0], 'studentFacts' | 'skillRead'> = {
      studentFacts: { read: async (identity, activityId, input) =>
        (await teachingFor(identity, activityId)).studentFacts.read(identity, activityId, input) },
      skillRead: async (scope, skillId, version, path) =>
        (await teachingFor(scope.identity, scope.activity.activityId)).skills.read(
          scope.identity, scope.activity.activityId, skillId, version, path,
          { references: scope.input.draft.skills }),
    };
    const agent = retained('teaching-agent') ? await owner('teaching-agent', teachingAgentMigrations) : undefined;
    const deviceExecutions = independentExecution ? createExecutionRouting({ local: independentExecution.executions,
      call: async (identity, activityId, args) => {
        if (!schoolClient) throw new StorageError('unavailable');
        return schoolClient.agentDependency(identity, { version: 1, operation: 'execution', identity, activityId, args });
      } }) : undefined;
    const localTools = createTeachingTools({ learning: () => ({ ...learning!,
      executions: independentExecution?.executions ?? learning!.executions }), courses, models, executionOrigin: currentExecutionOrigin,
      ...activityAgentReads,
      authorizeDispatch: async (scope, command) => {
        await agentDependencyFreshAuthorization.getStore()?.();
        await (await teachingFor(scope.identity, scope.activity.activityId)).assertCommandDispatch(scope.identity, scope.activity.activityId,
          { runId: scope.runId, stepId: scope.stepId, snapshotId: scope.snapshotId, commandId: command.commandId,
            ...(scope.authority ? { authority: scope.authority } : {}) });
      }, environment: scope => executionEnvironment(scope.identity) });
    const deviceTools = createTeachingTools({ learning: (): TeachingToolData => ({ ...schoolData.data,
      get executions() { if (!deviceExecutions) throw new StorageError('unavailable'); return deviceExecutions; } }),
      courses: schoolData.courses, models,
      ...activityAgentReads,
      authorizeDispatch: async (scope, command) => {
        if (!teaching) throw new StorageError('unavailable');
        await teaching.assertCommandDispatch(scope.identity, scope.activity.activityId,
          { runId: scope.runId, stepId: scope.stepId, snapshotId: scope.snapshotId, commandId: command.commandId,
            ...(scope.authority ? { authority: scope.authority } : {}) });
      }, environment: scope => schoolClient ? schoolClient.executionEnvironmentFor(scope.identity) : executionEnvironment(scope.identity) });
    const toolsFor = (scope: { identity: SpaceIdentity }) => scope.identity.environmentId === environment.environmentId ? localTools : deviceTools;
    teaching = agent && models && enabled.has('teaching-agent') ? createTeachingAgent(agent.storage, {
      authorize: async identity => {
        if (identity.environmentId === environment.environmentId) return spaces.authorize(identity);
        if (!client) throw new StorageError('forbidden');
        await (schoolClient ?? client).agentDependency(identity, { version: 1, operation: 'authorize', identity, args: [] });
      },
      async identityFor(scope) {
        if (scope.environmentId !== environment.environmentId) {
          if (!client) throw new StorageError('forbidden');
          return (schoolClient ?? client).identityForAgent(scope);
        }
        const identity = await spaces.lookup(scope.spaceId, scope.principalId);
        if (identity.environmentId !== scope.environmentId) throw new StorageError('forbidden');
        return identity;
      },
      activity: (identity, activityId) => identity.environmentId === environment.environmentId
        ? learning!.open(identity, activityId) : schoolData.data.open(identity, activityId),
      models, tools: {
        contributions: scope => toolsFor(scope).contributions!(scope), definitions: scope => toolsFor(scope).definitions(scope),
        prepare: (scope, intent, id) => toolsFor(scope).prepare(scope, intent, id),
        dispatch: (scope, command) => toolsFor(scope).dispatch(scope, command),
        reconcile: (scope, command) => toolsFor(scope).reconcile(scope, command),
        stop: (scope, command) => toolsFor(scope).stop(scope, command),
      }, withAuthority: (authority, work) => localAuthority.run(authority, work), start: false,
    }) : undefined;
    const routes = data ? createActivityAgentRoutes(data.storage, (identity, activityId) => learning!.open(identity, activityId), readOnly) : undefined;
    async function resolveTeachingBinding(identity: SpaceIdentity, activityId: string) {
      if (!routes) throw new StorageError('unavailable');
      const localTeaching = teaching;
      return routes.resolve(identity, activityId, async () => {
        const local = agent && localTeaching ? { version: 1 as const, connectionId: agent.storage.owner.serviceId, installationId: environment.installationId,
          target: environment.services.find(item => item.serviceId === agent.storage.owner.serviceId)! } : undefined;
        // Pre-deployment activities have Agent facts but no route row yet. Consult that owner
        // through its public read interface before applying a new member configuration.
        const existing = localTeaching ? await localTeaching.conversation(identity, activityId) : undefined;
        const selected = existing && (existing.runs.length || existing.messages.length) ? local : await agentBindings.read(identity) ?? local;
        if (!selected) throw new StorageError('unavailable');
        return selected;
      });
    }
    async function teachingFor(identity: SpaceIdentity, activityId: string): Promise<TeachingAgentPort> {
      if (identity.environmentId !== environment.environmentId) {
        if (!teaching) throw new StorageError('unavailable');
        await schoolData.data.open(identity, activityId);
        return teaching;
      }
      const binding = await resolveTeachingBinding(identity, activityId);
      if (binding.delivery === 'client') throw new StorageError('unavailable');
      if (binding.target.environmentId === environment.environmentId && binding.target.serviceId === agent?.storage.owner.serviceId) {
        if (!teaching) throw new StorageError('unavailable');
        return teaching;
      }
      return createTeachingAgentClient(binding.target.serviceId, identity, activityId,
        createAgentConnection(root, binding.connectionId, 'teaching.agent', binding.target));
    }
    async function teachingSettingsFor(identity: SpaceIdentity): Promise<TeachingAgentPort> {
      if (identity.environmentId !== environment.environmentId) {
        if (!teaching || !client) throw new StorageError('unavailable');
        await (schoolClient ?? client).agentDependency(identity, { version: 1, operation: 'authorize', identity, args: [] });
        return teaching;
      }
      const binding = await agentBindings.read(identity);
      if (!binding || binding.target.environmentId === environment.environmentId && binding.target.serviceId === agent?.storage.owner.serviceId) {
        if (!teaching) throw new StorageError('unavailable');
        return teaching;
      }
      return createTeachingAgentClient(binding.target.serviceId, identity, undefined,
        createAgentConnection(root, binding.connectionId, 'teaching.agent', binding.target));
    }
    const receivers = [...(actions.receivers ?? [])];
    const assertArtifactAdoption: NonNullable<Parameters<typeof createLearningData>[6]> = async (identity, activityId, origin, candidate) => {
      if (identity.environmentId !== environment.environmentId) {
        if (!teaching) throw new StorageError('unavailable');
        return teaching.assertCommandDispatch(identity, activityId, { runId: origin.runId, stepId: origin.stepId,
          snapshotId: origin.snapshotId, commandId: origin.commandId, adoption: { artifactId: candidate.artifactId,
            revisionId: candidate.revisionId, candidateId: candidate.candidateId, ...(origin.attemptId ? { attemptId: origin.attemptId } : {}) } });
      }
      if ((await agentBindings.read(identity))?.delivery === 'client') {
        const receipt = await learning!.artifacts.receipt(identity, activityId, origin.commandId);
        if (!receipt || receipt.kind !== 'publish' || receipt.artifactId !== candidate.artifactId
          || receipt.revisionId !== candidate.revisionId || receipt.candidateId !== candidate.candidateId) throw new StorageError('forbidden');
        return;
      }
      await (await teachingFor(identity, activityId)).assertCommandDispatch(identity, activityId, {
        runId: origin.runId, stepId: origin.stepId, snapshotId: origin.snapshotId, commandId: origin.commandId,
        adoption: { artifactId: candidate.artifactId, revisionId: candidate.revisionId, candidateId: candidate.candidateId,
          ...(origin.attemptId ? { attemptId: origin.attemptId } : {}) },
      });
    };
    learning = data && enabled.has('learning-data') ? createLearningData(data.storage, spaces, courses,
      { ...actions, receivers, authorizeExternal: async (identity, activityId, action) => {
        const context = agentDependencyContext.getStore(), source = context?.source;
        if (!source || !context.input.operation.startsWith('intent.') || context.input.activityId !== activityId
          || JSON.stringify(context.input.identity) !== JSON.stringify(identity)) throw new StorageError('forbidden');
        await source.assertAuthorized?.();
        // The capability admission already verified the activity's immutable owner and current
        // membership. Do not acquire another data-owner connection inside the receipt transaction.
        if (action.input.receiver.receiverId !== teachingAgentReceiverId(source.sourceServiceId)) throw new StorageError('forbidden');
      }, receiversFor: async (identity, activityId) => {
        const binding = await resolveTeachingBinding(identity, activityId);
        if (binding?.delivery === 'client') return [{ identity: { receiverId: teachingAgentReceiverId(binding.target.serviceId), kind: 'question', location: 'remote' },
          accept: async () => { throw new StorageError('unavailable'); }, query: async () => { throw new StorageError('unavailable'); }, cancel: async () => { throw new StorageError('unavailable'); } }];
        return [(await teachingFor(identity, activityId)).receiver];
      } }, executionModule ? undefined : native, executionModule ? undefined : nativeChannel, assertArtifactAdoption) : undefined;
    const dataDescriptor = data ? environment.services.find(item => item.serviceId === data.storage.owner.serviceId)! : undefined;
    const sourceAuthority = dataDescriptor ? createConnectionAuthority({ root, service: { ...dataDescriptor,
      capabilities: ['teaching.dependencies'] }, handlers: {} }) : undefined;
    let modelDispatchOpen = !isolatedAtStartup;
    const paired = model && models ? createPairedLearningModels(model.storage, models, {
      authorize: spaces.authorize,
      authorizeBinding: async (identity, binding) => { await spaces.authorizeConnection(identity, binding.connectionId); },
      recipientSuccessions: createModelRecipientRecovery(root, environment.services[0]!, async (identity, connectionId) => {
        await spaces.authorizeConnection(identity, connectionId);
      }),
      async authorizeOrigin(identity, origin, request) {
        await spaces.authorize(identity);
        if (!sourceAuthority) throw new StorageError('unavailable');
        try { await sourceAuthority.assertSourceAuthorized({ sourceEnvironmentId: origin.service.environmentId,
          sourceServiceId: origin.service.serviceId, sourceInstallationId: origin.installationId, grantId: origin.grantId }, 'teaching.dependencies'); }
        catch { throw new StorageError('forbidden'); }
        const activityId = origin.authority?.activityId ?? origin.activityId;
        const fixed = activityId ? await routes?.read(identity, activityId) : null;
        if (!fixed || fixed.target.environmentId !== origin.service.environmentId || fixed.target.serviceId !== origin.service.serviceId
          || !await matchesInstallation(fixed, origin.installationId)) throw new StorageError('forbidden');
        if (request.operation === 'checks.receive' || request.operation === 'checks.dispatch') {
          if (!origin.authority) throw new StorageError('forbidden');
          const attemptId = request.operation === 'checks.receive' ? (request.args[0] as { attemptId: string }).attemptId : String(request.args[0]);
          await (await teachingFor(identity, activityId!)).assertModelDispatch(identity, activityId!, {
            ...origin.authority, attemptId, dispatch: request.operation === 'checks.dispatch' });
        }
      },
      assertWritable() { if (!modelDispatchOpen) throw new StorageError('maintenance'); },
    }) : undefined;
    const localModelService = models ? createLearningModelService(models, spaces.authorize) : undefined;
    const modelRequest = async (request: z.infer<typeof learningModelRequestSchema>) => {
      const context = agentDependencyContext.getStore();
      if (!localModelService) throw new StorageError('unavailable');
      if (!context || request.identity.kind !== 'school' || !paired) return localModelService(request);
      if (!context.source.sourceInstallationId) throw new StorageError('forbidden');
      const operation = request.operation;
      const read = ['selection.read', 'selection.snapshot', 'selection.pinned', 'segments.read', 'checks.read', 'checks.progress', 'checks.summary',
        'checks.requestPayload', 'images.read'].includes(operation);
      const fingerprint = createHash('sha256').update(JSON.stringify([request, context.source.grantId, context.input.authority ?? null])).digest('hex');
      const operationId = read ? randomUUID() : `${fingerprint.slice(0, 8)}-${fingerprint.slice(8, 12)}-4${fingerprint.slice(13, 16)}-a${fingerprint.slice(17, 20)}-${fingerprint.slice(20, 32)}`;
      const scope = context.input.operation.startsWith('tool.') ? z.object({ segmentId: z.uuid().optional() }).parse(context.input.args[0]) : undefined;
      const origin: PairedModelOrigin = { operationId, service: { environmentId: context.source.sourceEnvironmentId, serviceId: context.source.sourceServiceId },
        installationId: context.source.sourceInstallationId, grantId: context.source.grantId,
        ...(context.input.activityId ? { activityId: context.input.activityId } : {}),
        ...(context.input.authority ? { authority: context.input.authority } : {}), ...(scope?.segmentId ? { segmentId: scope.segmentId } : {}) };
      return paired.request(request, origin);
    };
    const toolModels = models ? createLearningModelClient(modelRequest) : undefined;
    const dependencyService = learning ? createTeachingDependencyService({
      authorize: async identity => { await spaces.authorize(identity); await agentDependencyAuthorization.getStore()?.(identity); },
      identityFor: async scope => {
        const identity = await spaces.lookup(scope.spaceId, scope.principalId);
        if (identity.environmentId !== scope.environmentId) throw new StorageError('forbidden');
        return identity;
      },
      activity: learning.open, ...(models ? { models, modelRequest } : {}),
      dataRequest: createTeachingDataService({ learning, courses, executionSource: async (identity, activityId) => {
        const context = agentDependencyContext.getStore();
        if (!context?.source || context.input.operation !== 'execution.record') throw new StorageError('forbidden');
        return { source: context.source, binding: await routes?.read(identity, activityId) ?? await agentBindings.read(identity) };
      }, assertWritable: async () => {
        await agentDependencyFreshAuthorization.getStore()?.();
      } }),
      executionRequest: async input => {
        const context = agentDependencyContext.getStore();
        if (environment.profile !== 'school' || !independentExecution || !context?.source) throw new StorageError('unavailable');
        return createSchoolExecutionHandler({ executions: independentExecution.executions,
          authorize: async ({ identity, activityId, phase }) => {
            await agentDependencyFreshAuthorization.getStore()?.();
            if (phase === 'cleanup') return;
            const activity = await learning!.open(identity, activityId);
            if (phase === 'dispatch' && activity.status !== 'open') throw new StorageError('forbidden');
          } })(spaceIdentitySchema.parse(input.identity), z.uuid().parse(input.activityId), input.args, context.source);
      },
      intentRequest: async input => {
        const identity = spaceIdentitySchema.parse(input.identity), activityId = z.uuid().parse(input.activityId), requestId = z.uuid().parse(input.args[0]);
        if (input.operation === 'intent.begin') return learning!.intents.beginExternalDispatch(identity, activityId, requestId);
        if (input.operation === 'intent.cancel') return learning!.intents.requestExternalCancellation(identity, activityId, requestId);
        return learning!.intents.recordExternalReceipt(identity, activityId, requestId, input.args[1]);
      },
      tools: createTeachingTools({ learning: () => learning!, courses, ...(toolModels ? { models: toolModels } : {}), executionOrigin: currentExecutionOrigin,
        ...activityAgentReads,
        authorizeDispatch: async (scope, command) => {
          await agentDependencyFreshAuthorization.getStore()?.();
          return (await teachingFor(scope.identity, scope.activity.activityId)).assertCommandDispatch(
            scope.identity, scope.activity.activityId, { runId: scope.runId, stepId: scope.stepId, snapshotId: scope.snapshotId,
              commandId: command.commandId, ...(scope.authority ? { authority: scope.authority } : {}) });
        },
        environment: scope => executionEnvironment(scope.identity) }),
    }) : undefined;
    const modules = [[space, async () => { await spaces.validate(); await courses.validate(); await agentBindings.validate(); }],
      ...(data ? [[data, () => validateLearningData(data.storage)] as const] : []),
      ...(model && modelGateway ? [[model, modelGateway.validate] as const] : []),
      ...(agent ? [[agent, () => validateTeachingAgent(agent.storage)] as const] : []),
      ...(executionModule ? [[executionModule, () => validateExecutionOwner(executionModule.storage)] as const] : [])] as const;
    for (const [module, validate] of modules) {
      const recoveryOwner = createStorageRecoveryOwner({ storage: module.storage, binding: module.binding, migrations: module.migrations,
        resources: configuration.resources, resourceRoots: [join(root, 'learning-resources',
          module === space ? 'space-course' : module === data ? 'learning-data' : module === model ? 'model-connection'
            : module === executionModule ? 'tool-execution' : 'teaching-agent')],
        installationId: environment.installationId,
        // Only the learning-data owner holds execution facts; the component owner reports its own
        // fixed material through the generic storage boundary.
        ...(module === data || module === executionModule ? { boundary: async (storage: OwnedStorage, { boundaryAt }: { boundaryAt: string }) => {
          const boundary = await collectExecutionBoundary(storage);
          return { kind: boundary.kind, settled: boundary.commands.settled,
            unresolved: boundary.unresolved.map(command => ({ requestId: command.requestId, inputDigest: command.inputDigest,
              executionRef: command.executionRef, activityId: command.activityId, location: command.location,
              state: command.state, statusKnowledge: command.statusKnowledge, stopRequested: command.stopRequested,
              disposition: command.disposition,
              ...(command.node?.nodeId ? { nodeId: command.node.nodeId } : {}),
              ...(command.node?.executorInstanceId ? { executorInstanceId: command.node.executorInstanceId } : {}) })),
            blocking: boundary.blocking, retained: { resources: 0, checkpoints: boundary.checkpoints },
            evidence: boundary };
        } } : module === agent ? { boundary: collectTeachingBoundary, receiverBoundary: collectTeachingReceiverBoundary } : {}),
        // #221: every business owner emits a read-only fixed-source closure at this same closed
        // boundary, so an isolated restore can prove it holds the originals without recomputation.
        ...(module === data ? { sources: collectLearningSources }
          : module === agent ? { sources: collectTeachingSources } : {}),
        validateService: validate });
      const participant = recoveryOwner.participant;
      let dispatchClosing: Promise<void> | undefined;
      function closeDispatch() {
        nativeChannel?.closeDispatch();
        learning?.executions.closeNativeDispatch();
        learning?.intents.closeDispatch();
        // Both coordinator actions join one storage gate. A second queued close could occupy
        // the bound connection while channel drain opens another connection to a changed endpoint.
        return dispatchClosing ??= participant.closeDispatch().catch(error => { dispatchClosing = undefined; throw error; });
      }
      owners.push(module === executionModule && independentExecution ? { ...recoveryOwner, participant: { ...participant,
        async closeWrites() { await independentExecution.executions.shutdown(); await participant.closeWrites(); },
        async closeDispatch() { independentExecution.executions.closeNativeDispatch(); await participant.closeDispatch(); },
        async drain() { await independentExecution.executions.shutdown(); await participant.drain(); },
        async resume() { await participant.resume(); await independentExecution.executions.recoverNative(); },
      } } : module === data && learning ? { ...recoveryOwner, participant: { ...participant,
        async closeWrites() {
          // The coordinator closes writes and dispatch concurrently. Keep this owner's generation
          // and acknowledgement writes open until every claimed device instance has exited.
          try {
            await closeDispatch();
            await nativeChannel?.drain();
            learning!.executions.closeNativeDispatch();
            await learning!.executions.shutdown();
            await participant.closeWrites();
          } finally { dispatchClosing = undefined; }
        },
        closeDispatch,
        async drain() { await learning!.intents.drain(); await learning!.executions.shutdown(); await participant.drain(); },
        async resume() {
          try { await participant.resume(); nativeChannel?.resume(); learning!.intents.resume(); await learning!.executions.recoverNative(); }
          finally { dispatchClosing = undefined; }
        },
      } } : module === model && models ? { ...recoveryOwner, participant: { ...participant,
        async closeWrites() { modelDispatchOpen = false; models.closeWrites(); await models.checks.drain(); await participant.closeWrites(); await participant.closeDispatch(); },
        async closeDispatch() { modelDispatchOpen = false; models.checks.closeDispatch(); },
        async drain() { await models.checks.drain(); await participant.drain(); },
        async resume() { await participant.resume(); models.resume(); modelDispatchOpen = true; },
      } } : module === agent && teaching ? (() => {
        const activeTeaching = teaching;
        return { ...recoveryOwner, participant: { ...participant,
          async closeWrites() { activeTeaching.closeWrites(); await participant.closeWrites(); },
          async closeDispatch() { activeTeaching.closeDispatch(); await participant.closeDispatch(); },
          async drain() { await activeTeaching.drain(); await participant.drain(); },
          async resume() { await participant.resume(); activeTeaching.resume(); },
        } };
      })() : recoveryOwner);
    }
    const targetOwner = data ?? model ?? space;
    if (!targetOwner) throw new RecoveryError('missing-business-owner');
    const localTarget = { ...targetOwner.storage.owner, version: 1 as const };
    schoolClient = environment.profile === 'school' ? undefined : createSchoolClient(root, environment, {
      target: localTarget, ...(model ? { modelTarget: { ...model.storage.owner, version: 1 as const } } : {}), ...(data ? { create: (authority, courseAuthority) => createLearningData(data.storage, authority, courseAuthority,
        { ...actions, receiversFor: async () => teaching ? [teaching.receiver] : [] }, undefined, undefined, assertArtifactAdoption) } : {}),
      models, personal: spaces.personal, ...(teaching ? { teaching } : {}),
      ...(independentExecution ? { executions: independentExecution.executions } : {}), authority: () => localAuthority.getStore(),
      executionEnvironment: identity => executionEnvironment(identity) });
    // The isolation answer is host-wide, so the owner measures it once. Status reports the state
    // machine rather than a prose message: `starting` until the unit answers, then `ready` with a
    // structured fact or `unavailable` when this host must refuse native sessions.
    const probeState: { value?: NativeSessionIsolation | null } = {};
    let measuring = false;
    function measureIsolation() {
      const executor = independentExecution?.executions ?? learning?.executions;
      if (!linuxEntry || !executor || measuring) return;
      measuring = true;
      void executor.linuxEntryIsolation().then(value => { probeState.value = value; }, () => { probeState.value = null; });
    }
    if (!isolatedAtStartup) measureIsolation();
    const localIsolationReady = environment.profile === 'local' && (process.platform === 'darwin'
      ? await exists('/usr/bin/sandbox-exec') : process.platform === 'win32' && windowsHelper !== undefined);
    const executionEnvironment = async (identity: SpaceIdentity) => {
      if (!await readOnly()) measureIsolation();
      const registered = nativeChannel ? (await nativeChannel.nodes(identity)).sort((left, right) => left.nodeId.localeCompare(right.nodeId))[0] : undefined;
      if (registered) return { nodeClass: 'device' as const, secureTransport: placement.secureTransport,
        remoteAvailable: placement.secureTransport && probeState.value !== undefined && probeState.value !== null, device: { platform: registered.platform,
          browser: { worker: false, webassembly: false, sandboxedFrame: false },
          native: { supported: true, installed: true, authorized: true, prepared: 'ready' as const } },
        adapters: productNativeAdapters.map(adapter => ({ adapterId: adapter.adapterId,
          adapterVersion: adapter.adapterVersion, platforms: adapter.platforms ?? [],
          available: registered.adapters.some(declaration => declaration.adapterId === adapter.adapterId
            && declaration.adapterVersion === adapter.adapterVersion) })),
        placements: productNativeAdapters.flatMap(adapter => [{ target: 'student-runtime' as const,
          adapterId: adapter.adapterId, adapterVersion: adapter.adapterVersion,
          available: registered.adapters.some(item => item.adapterId === adapter.adapterId && item.adapterVersion === adapter.adapterVersion) },
        { target: 'school-runtime' as const, adapterId: adapter.adapterId, adapterVersion: adapter.adapterVersion,
          available: placement.secureTransport && probeState.value !== undefined && probeState.value !== null }]) };
      const device: ExecutionDevice = { platform: null,
        browser: { worker: false, webassembly: false, sandboxedFrame: false }, native: null };
      // A school host cannot observe a browser client's native installation or architecture.
      if (environment.profile === 'local') {
        device.platform = process.platform === 'darwin' && process.arch === 'arm64' ? 'macos-arm64'
          : process.platform === 'win32' && process.arch === 'x64' ? 'windows-x64'
          : process.platform === 'linux' && process.arch === 'x64' ? 'linux-x64' : null;
        device.native = { supported: localIsolationReady, installed: true, authorized: true,
          prepared: localIsolationReady ? 'ready' : 'none' };
      }
      return { ...placement, remoteAvailable: placement.nodeClass === 'school-execution-node'
        && placement.secureTransport && probeState.value !== undefined && probeState.value !== null, device,
        adapters: productNativeAdapters.map(adapter => ({ adapterId: adapter.adapterId,
          adapterVersion: adapter.adapterVersion, platforms: adapter.platforms ?? [] })) };
    };
    if (teaching && !isolatedAtStartup) teaching.resume();
    const dependencyChunks = data ? createChunkChannel(data.storage) : undefined;
    const dependencyCapability: CapabilityHandler = async (value, source) => {
      if (!dependencyService || !dependencyChunks) throw new StorageError('unavailable');
      const authorize = async (payload: unknown) => {
        const input = teachingDependencyCallSchema.parse(payload);
        const identity = input.identity ?? (input.scope ? await spaces.lookup(input.scope.spaceId, input.scope.principalId) : null);
        if (!identity) throw new StorageError('invalid');
        const guard = async () => {
          try { await source.assertAuthorized?.(); }
          catch (error) { throw new StorageError(error instanceof RuntimeConnectionError && error.code === 'unauthorized' ? 'forbidden' : 'unavailable'); }
          await authorizeSchoolDeviceGrant(root, spaces, identity, source.grantId);
          const activityIds = [input.activityId, input.authority?.activityId,
            input.operation === 'activity' ? z.uuid().parse(input.args[0]) : undefined,
            input.operation.startsWith('tool.') ? z.object({ activity: z.object({ activityId: z.uuid() }) }).parse(input.args[0]).activity.activityId : undefined]
            .filter((id): id is string => id !== undefined);
          if (new Set(activityIds).size > 1) throw new StorageError('forbidden');
          const cleanup = input.operation === 'execution' && ['agent.cleanup','agent.cleanupStatus'].includes(String(input.args[0]));
          const pinned = activityIds[0] ? cleanup ? await routes?.readForCleanup(identity, activityIds[0])
            : await routes?.read(identity, activityIds[0]) : null;
          if (input.operation === 'execution.record') {
            const fixed = pinned ?? await agentBindings.read(identity);
            const executor = fixed?.deviceModules?.find(module => module.unit === 'tool-execution');
            if (fixed?.delivery !== 'client' || !executor || source.grantId !== fixed.executionGrantId
              || source.sourceEnvironmentId !== executor.environmentId || source.sourceServiceId !== executor.serviceId
              || !await matchesInstallation(fixed, source.sourceInstallationId)) throw new StorageError('forbidden');
          } else if (pinned) {
            if (pinned.target.environmentId !== source.sourceEnvironmentId || pinned.target.serviceId !== source.sourceServiceId
              || !await matchesInstallation(pinned, source.sourceInstallationId)) throw new StorageError('forbidden');
          } else {
            const member = await agentBindings.read(identity);
            if (!member || member.target.environmentId !== source.sourceEnvironmentId || member.target.serviceId !== source.sourceServiceId
              || !await matchesInstallation(member, source.sourceInstallationId)) throw new StorageError('forbidden');
          }
          const fixed = pinned ?? await agentBindings.read(identity);
          if (input.operation.startsWith('intent.') && fixed?.delivery !== 'client') throw new StorageError('forbidden');
          if (fixed?.delivery === 'client' && (input.operation === 'model' || input.operation.startsWith('tool.')))
            throw new StorageError('forbidden');
          if (input.operation === 'model') {
            const model = learningModelRequestSchema.parse(input.args[0]);
            if (model.operation === 'checks.receive' || model.operation === 'checks.dispatch') {
              if (!input.authority) throw new StorageError('forbidden');
              const attemptId = model.operation === 'checks.receive' ? (model.args[0] as { attemptId: string }).attemptId : String(model.args[0]);
              await (await teachingFor(identity, input.authority.activityId)).assertModelDispatch(identity, input.authority.activityId,
                { ...input.authority, attemptId, dispatch: model.operation === 'checks.dispatch' });
            }
          }
        };
        await guard();
        return { guard, identity };
      };
      let admission: { key: string; guard: () => Promise<void>; identity: SpaceIdentity } | undefined;
      const payloadKey = (payload: unknown) => createHash('sha256').update(JSON.stringify(payload)).digest('hex');
      const invoke = async (payload: unknown) => {
          try {
            const key = payloadKey(payload);
            const admitted = admission?.key === key ? admission : { key, ...await authorize(payload) };
            const scopedAdmission = async (identity: SpaceIdentity) => {
              // A different actor must not inherit this request's admission. Ordinary actor authorization still runs in Gateway.
              if (JSON.stringify(identity) !== JSON.stringify(admitted.identity)) await admitted.guard();
            };
            return await agentDependencyContext.run({ input: teachingDependencyCallSchema.parse(payload), source },
              () => agentDependencyAuthorization.run(scopedAdmission,
                () => agentDependencyFreshAuthorization.run(admitted.guard, () => dependencyService(payload))));
          } catch (error) { return { error: error instanceof StorageError ? error.code : 'invalid' }; }
      };
      try {
        const direct = z.object({ directRead: z.literal(1), input: teachingDependencyCallSchema }).strict().safeParse(value);
        if (direct.success) {
          if (!['activity','data','course'].includes(direct.data.input.operation) || !isTeachingDependencyRead(direct.data.input))
            throw new StorageError('forbidden');
          const result = await invoke(direct.data.input);
          if (result && typeof result === 'object' && 'error' in result) return result;
          return Buffer.byteLength(JSON.stringify(result)) <= 512*1024
            ? { directRead: 1, value: result } : { directRead: 1, chunked: true };
        }
        return await dependencyChunks.wrap(invoke, { readOnly: value => isTeachingDependencyRead(teachingDependencyCallSchema.parse(value)),
        successor: async (from, to) => !!from.sourceInstallationId && !!to.sourceInstallationId
          && isRecoverySuccessor(root, { ...from, sourceInstallationId: from.sourceInstallationId }, to.sourceInstallationId),
        authorize: async payload => {
          // Initial admission and reply/chunk reads always perform a fresh authorization.
          admission = { key: payloadKey(payload), ...await authorize(payload) };
        } })(value, source);
      } catch (error) { return { error: error instanceof StorageError ? error.code : 'invalid' }; }
    };
    const serviceCapabilities: Record<string, Record<string, CapabilityHandler>> = {
      [space.storage.owner.serviceId]: { 'courses.execution-design': (value, source) => {
        const input = z.object({ operation: z.enum(['compile', 'prepare', 'read']), request: z.unknown() }).strict().parse(value);
        return courseDesignAuthority.run(async () => { await source.assertAuthorized?.(); }, () => courseExecutionDesign(input.operation, input.request));
      } },
    };
    if (data && dependencyService) serviceCapabilities[data.storage.owner.serviceId] = { 'teaching.dependencies': dependencyCapability };
    const deviceSetup = environment.profile === 'school' && dataDescriptor && enabled.has('learning-data')
      && !enabled.has('teaching-agent') && !enabled.has('model-connection') && !enabled.has('tool-execution')
      ? createSchoolDeviceSetup({ root, spaces, bindings: agentBindings,
        target: { ...dataDescriptor, capabilities: ['runtime.status', 'teaching.dependencies'] },
        authority: createConnectionAuthority({ root, service: { ...dataDescriptor, capabilities: ['teaching.dependencies'] },
          handlers: { 'teaching.dependencies': dependencyCapability } }),
        assertWritable: async () => { if (await readOnly()) throw new StorageError('maintenance'); },
      }) : undefined;
    return { owners, isolatedReads: true as const, ...(lifecycle ? { lifecycle } : {}),
      async authorizedSource(targetServiceId: string, source: { sourceEnvironmentId: string; sourceServiceId: string; sourceInstallationId?: string; grantId: string; capabilities: readonly string[] }) {
        if (!learning || targetServiceId !== dataDescriptor?.serviceId || !source.sourceInstallationId || !source.capabilities.includes('teaching.dependencies')) return;
        await learning.executions.agent.adoptAuthorization({ sourceEnvironmentId: source.sourceEnvironmentId, sourceServiceId: source.sourceServiceId,
          sourceInstallationId: source.sourceInstallationId, grantId: source.grantId }, (from, to) => isRecoverySuccessor(root, from, to.sourceInstallationId));
      },
      serviceCapabilities,
      capabilities: { 'learning.authority': createLearningAuthority(spaces, courses, models?.deviceTasks,
        paired && models ? withModelOriginRecovery(root, paired, models) : paired) },
      ...(learning || independentExecution ? { hasReceivedBrowserExecution: async (activityId: string, requestId: string) =>
        !!(await independentExecution?.executions.hasReceivedBrowserCommand(activityId, requestId))
          || !!(await learning?.executions.hasReceivedBrowserCommand(activityId, requestId)) } : {}),
      ...(models ? { async modelTask(value: unknown) {
        const input = modelTaskRequest.parse(value);
        return input.operation === 'enqueue' ? models.deviceTasks.enqueue(input.identity, input.binding, input.task)
          : models.deviceTasks.read(input.identity, input.binding, input.taskId);
      } } : {}),
      async poll(isOpen: () => boolean) {
        if (independentExecution && isOpen()) await independentExecution.poll(isOpen);
        if (learning && isOpen()) await learning.executions.agent.reconcileAuthorization(async (identity, activityId, origin) => {
          const activity = await learning!.open(identity, activityId);
          if (activity.status !== 'open') throw new StorageError('forbidden');
          if (!origin) return;
          if (!sourceAuthority) throw new StorageError('unavailable');
          try { await sourceAuthority.assertSourceAuthorized(origin, 'teaching.dependencies'); }
          catch (error) {
            if (error instanceof RuntimeConnectionError && error.code === 'unauthorized') {
              if (await hasRecoverySuccession(root, origin)) throw new StorageError('unavailable');
              throw new StorageError('forbidden');
            }
            throw error;
          }
          const pinned = await routes?.read(identity, activityId);
          if (!pinned || pinned.target.environmentId !== origin.sourceEnvironmentId
            || pinned.target.serviceId !== origin.sourceServiceId || !await matchesInstallation(pinned, origin.sourceInstallationId))
            throw new StorageError('forbidden');
        }, isOpen);
        if (schoolClient && models && isOpen()) await schoolClient.pollModelTasks(isOpen);
      },
      handle: createLearningEntry({ environment, spaces, ...(learning ? { learning } : {}), courses,
        ...(deviceSetup ? { deviceSetup } : {}),
        ...(independentExecution ? { executions: independentExecution.executions } : {}),
        courseExecutionDesign,
        ...(models ? { models } : {}), ...(teaching ? { teaching } : {}), teachingFor, teachingSettingsFor, client: schoolClient, readOnly, requiresNamespace,
        async bindAgent(value) {
          const input = teachingAgentBindingInputSchema.parse(value);
          if (input.delivery === 'client') {
            if (!sourceAuthority || !input.grantId) throw new StorageError('forbidden');
            await spaces.authorizeConnection(input.identity, input.connectionId);
            if (input.deviceModules?.some(module => module.environmentId !== input.target.environmentId)
              || input.deviceModules && new Set(input.deviceModules.map(module => module.unit)).size !== input.deviceModules.length)
              throw new StorageError('forbidden');
            await sourceAuthority.assertSourceAuthorized({ sourceEnvironmentId: input.target.environmentId,
              sourceServiceId: input.target.serviceId, sourceInstallationId: input.installationId, grantId: input.grantId }, 'teaching.dependencies');
            if (input.executionGrantId) {
              const execution = input.deviceModules?.find(module => module.unit === 'tool-execution');
              if (!execution || input.executionGrantId === input.grantId) throw new StorageError('forbidden');
              await sourceAuthority.assertSourceAuthorized({ sourceEnvironmentId: execution.environmentId,
                sourceServiceId: execution.serviceId, sourceInstallationId: input.installationId,
                grantId: input.executionGrantId }, 'teaching.dependencies');
            }
            return agentBindings.bind(input);
          }
          const config = await readJson<InstalledConfiguration>(join(root, 'installation.json'));
          const connection = config.connections.find(item => item.connectionId === input.connectionId);
          if (!connection || connection.sourceEnvironmentId !== environment.environmentId || connection.sourceServiceId !== data?.storage.owner.serviceId
            || connection.target.environmentId !== input.target.environmentId || connection.target.serviceId !== input.target.serviceId
            || !connection.requiredCapabilities.includes('teaching.agent')) throw new StorageError('forbidden');
          return agentBindings.bind(input);
        },
        async bindModelDevice(value) {
          if (!paired) throw new StorageError('unavailable');
          const input = z.object({ identity: spaceIdentitySchema, binding: z.unknown() }).strict().parse(value);
          return paired.bind(input.identity, input.binding as Parameters<typeof paired.bind>[1]);
        },
        executionEnvironment, ...(nativeChannel ? { nativeChannel } : {}), target: localTarget,
        async restoredInstallation() {
          const path = join(root, 'recovery-state.json');
          return await exists(path) && (await readJson<{ phase: string }>(path)).phase === 'active';
        }, administratorToken: await resolveCredential(root, 'control') }),
      ...(linuxEntry ? { facts: async () => {
        if (!await readOnly()) measureIsolation();
        if (probeState.value === undefined) return [{ name: 'native-sessions', required: false,
          state: 'starting' as const, detail: 'measuring-restricted-entry' }];
        const isolation = probeState.value;
        return [isolation
          ? { name: 'native-sessions', required: false, state: 'ready' as const,
            detail: JSON.stringify({ kind: isolation.kind, network: isolation.network, writes: isolation.writes,
              reads: isolation.reads, processes: isolation.processes, memory: isolation.memory,
              supervisor: isolation.supervisorDeath }) }
          : { name: 'native-sessions', required: false, state: 'unavailable' as const,
            detail: 'restricted-entry-not-measured' }];
      } } : {}) };
  } catch (error) {
    if (typeof teaching !== 'undefined') teaching.close();
    await lifecycle?.close(); await Promise.allSettled(opened.map(storage => storage.close())); throw error;
  }
}

/** Both real owners register native restore targets and validate only their own domain facts. */
export function createLearningRecoveryTargets(options: {
  root: string; environment: RuntimeEnvironment; resources: RuntimeResources;
  admin(): Promise<DatabaseConnection | null>;
}) {
  return (['space-course', 'learning-data', 'model-connection', 'teaching-agent', 'tool-execution'] as const).map(unit => {
    const descriptors = options.environment.services.filter(service => service.unit === unit);
    if (descriptors.length === 0) return null;
    if (descriptors.length !== 1) throw new RecoveryError('missing-business-owner');
    const descriptor = descriptors[0]!;
    const resourceRoot = join(options.root, 'learning-resources', unit);
    return createStorageRecoveryTarget({ owner: { environmentId: options.environment.environmentId, serviceId: descriptor.serviceId },
      admin: async () => { const value = await options.admin(); if (!value) throw new RecoveryError('target-database-required'); return value; },
      resources: options.resources, backend: createFileBackend({ id: unit, root: resourceRoot }), resourceRoots: [resourceRoot],
      installationId: options.environment.installationId,
      migrations: unit === 'space-course' ? spaceCourseMigrations : unit === 'model-connection' ? modelMigrations
        : unit === 'teaching-agent' ? teachingAgentMigrations : unit === 'tool-execution' ? executionOwnerMigrations : learningMigrations,
      ...(unit === 'tool-execution' ? { validateMaterial: async (storage: OwnedStorage, material: OwnerBoundaryMaterial) =>
        validateExecutionBoundary(storage, material.evidence) } : unit === 'learning-data' ? { validateMaterial: async (storage: OwnedStorage, material: OwnerBoundaryMaterial) =>
        validateExecutionBoundary(storage, material.evidence), sources: collectLearningSources, validateSources: validateLearningSources }
        : unit === 'teaching-agent' ? {
          boundary: collectTeachingBoundary, receiverBoundary: collectTeachingReceiverBoundary, validateMaterial: validateTeachingBoundary,
          sources: collectTeachingSources, validateSources: validateTeachingSources,
        } : {}),
      validateService: async storage => {
        if (unit === 'learning-data') return validateLearningData(storage);
        if (unit === 'teaching-agent') return validateTeachingAgent(storage);
        if (unit === 'tool-execution') return validateExecutionOwner(storage);
        if (unit === 'model-connection') return (await createModelGateway(storage, { authorize: async () => {} })).validate();
        const spaces = createSpaces(storage);
        await spaces.validate();
        await createCourses(storage, spaces).validate();
        await createMemberAgentBindings(storage, spaces.authorize).validate();
      } });
  }).filter((target): target is NonNullable<typeof target> => target !== null);
}
