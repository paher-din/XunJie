import { randomBytes, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { createFileBackend, openStorage, provisionStorage, StorageError } from '@xunjie/storage';
import pg from 'pg';
import { z } from 'zod';
import type { OwnedStorage, StorageBinding, DatabaseConnection } from '@xunjie/storage';
import { createSpaces, spaceMigrations, createLearningData, learningMigrations, validateLearningData, createCourses, spaceCourseMigrations, linuxSessionEntry, productNativeAdapters, createNativeChannel, collectExecutionBoundary, validateExecutionBoundary, collectLearningSources, validateLearningSources } from '@xunjie/learning-space';
import { createLearningEntry } from './learning-http/index.js';
import { createLearningAuthority } from './learning-http/authority.js';
import type { RuntimeEnvironment } from '@xunjie/contracts/product-runtime';
import type { ExecutionDevice } from '@xunjie/contracts/execution';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import type { ActionIntentOptions, NativeSessionIsolation } from '@xunjie/learning-space';
import { createModelGateway, modelMigrations } from '@xunjie/model-gateway';
import { modelDeviceTaskSchema } from '@xunjie/model-gateway/device-tasks';
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
import { createSchoolDeviceSetup, createSchoolExecutionRecordSource, authorizeSchoolDeviceGrant } from './school-device-setup.js';
import { verifyWindowsSessionHelper } from './prerequisites.js';
import { createNativeChannelClients } from './native-channel-clients.js';
import { isInstallationRetired } from './retired-installations.js';
import { isRecoverySuccessor, hasRecoverySuccession } from './recovery-successions.js';
import { withModelOriginRecovery, createModelRecipientRecovery } from './model-origin-authority.js';
import { createStandaloneAgentApplication } from './agent-application.js';
import { createAgentConnection } from './agent-connections.js';
import type { CapabilityHandler } from './connections.js';
import { createConnectionAuthority, RuntimeConnectionError } from './connections.js';
import { createMemberAgentBindings } from '@xunjie/learning-space';
import { learningModelRequestSchema, createLearningModelService, createLearningModelClient } from '@xunjie/model-gateway/service';
import { createPairedLearningModels } from '@xunjie/model-gateway/paired-learning';
import { createExecutionOwner, executionOwnerMigrations, validateExecutionOwner, createCourseExecutionDesign } from '@xunjie/learning-space';
import type { PairedModelOrigin } from '@xunjie/model-gateway/paired-learning';
import { teachingAgentBindingInputSchema } from '@xunjie/contracts/teaching-agent';
import { AsyncLocalStorage } from 'node:async_hooks';
import { validateDeployment } from './deployment.js';
import { createExecutionRouting, createSchoolExecutionHandler, executionRoutingRequestSchema } from './execution-routing.js';
import { collectAgentRuntimeBoundary, collectAgentRuntimeReceiverBoundary, validateAgentRuntimeBoundary } from '@xunjie/agent-runtime/maintenance';
import { createAgentSessions } from '@xunjie/learning-space/learning-data/agent-sessions';
import { createSessionMaterials } from '@xunjie/learning-space/learning-data/session-materials';
import { createPersonalProjects } from '@xunjie/learning-space/learning-data/personal-projects';
import { createProjectMaterials } from '@xunjie/learning-space/learning-data/project-materials';
import { createLearningQuery, learningObjectVersion, type LearningQuerySource, type LearningQuerySourceResult, type OwnerConversationRead, type OwnerConversation } from '@xunjie/learning-space/learning-data/learning-query';
import { createProductAgent } from './product-agent.js';
import { createAgentSessionClient, createAgentSessionService } from '@xunjie/agents/transport/session-service';
import { agentSessionsCapability } from '@xunjie/contracts/agent-service';
import { canonicalDigest, operationId } from '@xunjie/storage/identity';
import type { AgentDispatchPermit } from '@xunjie/contracts/agent-runtime';
import { isTerminalExecutionState, agentExecutionAssociationSchema } from '@xunjie/contracts/execution';
import { authorizePersonalProjectCreation } from '@xunjie/agents/student-assistant/creation-policy';
import { agentServiceMigrations, validateAgentServiceStorage, collectAgentServiceSources, validateAgentServiceSources } from '@xunjie/agents/transport/session-storage';
import { createAgentSessionHandler } from './session-handler.js';
import { createWorkspaceAgentAuthority } from './workspace-agent-authority.js';
import { readWorkspaceAgentWait } from './workspace-agent-waits.js';
import { createSkills } from '@xunjie/learning-space/learning-data/skills';
import { createSkillTools } from '@xunjie/agents/capabilities/skills/index';
import { createAgentSessionApplication, type AgentSessionDirectory } from './agent-sessions.js';
import { createAgentDependencyChannel, createAgentDependencyClient, type AgentSessionDependencies } from '@xunjie/agents/transport/session-dependencies';
import { workFileSchema } from '@xunjie/contracts/learning-data';
import type { AgentSession } from '@xunjie/contracts/agent-sessions';
import { agentDependenciesCapability, isAgentDependencyRead, type AgentDependencyCall } from '@xunjie/contracts/agent-dependencies';
import { createWorkspaceToolModule, type WorkspaceToolOptions } from '@xunjie/agents/workspace-assistant/index';
import { createLearningTools, type LearningToolsHost } from '@xunjie/agents/student-assistant/tools/learning-tools';
import { createUserQuestions } from '@xunjie/agents/capabilities/user-questions/index';
import { createDocumentTools } from '@xunjie/agents/capabilities/documents/index';
import { createStudentFacts } from '@xunjie/agents/capabilities/student-facts/index';
import type { ChunkConnectionSource } from '@xunjie/storage/chunk-channel';
import { sameAgentSubject } from '@xunjie/contracts/agent-service';

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
  const sessionAuthority = new AsyncLocalStorage<AgentDispatchPermit>();
  const sessionDependencies = new Map<string, AgentSessionDependencies>();
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
  const lifecycle = client && enabled.has('tool-execution') ? await createNativeChannelClients({ root, environment, resources: configuration.resources,
    client: { list: () => (schoolClient ?? client).list(),
      nativeChannelCall: (id, operation, input) => (schoolClient ?? client).nativeChannelCall(id, operation, input) } }) : undefined;
  const database = await databaseBinding(root, configuration.database);
  if (!database && (environment.profile === 'school' || environment.profile === 'agent' || modelOnly)) throw new Error('This product profile requires PostgreSQL.');
  if (!database) return { owners: [], isolatedReads: true as const, ...(lifecycle ? { lifecycle } : {}), handle: createLearningEntry({ environment,
    administratorToken: await resolveCredential(root, 'control'), client, readOnly, requiresNamespace }) };
  const { credentialRef, ...connection } = database;
  const admin = { ...connection, password: await resolveCredential(root, credentialRef) };
  const opened: OwnedStorage[] = [];
  const owners: RecoveryOwner[] = [];
  let sessionAgent: ReturnType<typeof createProductAgent> | undefined;
  let standaloneAgent: ReturnType<typeof createStandaloneAgentApplication> | undefined;
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
      const module = await owner('teaching-agent', agentServiceMigrations);
      const application = createStandaloneAgentApplication({ root, environment, configuration,
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
        if (identity.environmentId === environment.environmentId) return spaces.authorize(identity);
        if (!client || identity.kind !== 'school') throw new StorageError('forbidden');
        await (schoolClient ?? client).authorizeModel(identity);
      },
      async authorizeDispatch(identity) {
        if (identity.environmentId === environment.environmentId) return spaces.authorize(identity);
        if (!client || identity.kind !== 'school') throw new StorageError('forbidden');
        await (schoolClient ?? client).authorizeModelDispatch(identity);
      },
      async authorizePermit(identity, permit, context) {
        if (client && await (schoolClient ?? client).authorizePermit(identity, permit, context.attemptId, context.phase)) return;
        await assertSessionModel(identity, permit, context.attemptId);
      },
      async schoolDefault(identity) { return client ? (schoolClient ?? client).schoolModel(identity) : null; }, dispatcher: {
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
    function connectedSchool() { if (!client) throw new StorageError('unavailable'); return schoolClient ?? client; }
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
        ? learning!.open(identity, id) : connectedSchool().openActivity(identity, id),
      migratedActivity: async (identity, id) => learning?.studyCopies.sourceActivity(identity, id) ?? null,
      sourceFile: async (identity, id, contentId) => {
        if (identity.environmentId === environment.environmentId) return learning!.works.content(identity, id, contentId);
        const source = await connectedSchool().querySource(identity);
        if (!source.learning.works) throw new StorageError('unavailable');
        return workFileSchema.omit({ name: true }).parse(await source.learning.works.content(identity, id, contentId));
      },
      ...(native ? { native } : {}),
    }) : undefined;
    const nativeChannel = data && enabled.has('learning-data') && enabled.has('tool-execution')
      && !configuration.deployment && environment.profile === 'school' ? createNativeChannel(data.storage, {
      installationActive: async installationId => !await isInstallationRetired(root, installationId),
      authenticate: (token, connectionId) => spaces.authenticateConnection(token, connectionId),
      authorizeConnection: (identity, connectionId) => spaces.authorizeConnection(identity, connectionId),
      authorize: (identity, activityId) => learning!.open(identity, activityId),
      assertAgentDispatch: async (identity, activityId, association) => {
        return assertWorkspaceCommand(identity, activityId, association);
      },
    }) : undefined;
    const agent = retained('teaching-agent') ? await owner('teaching-agent', agentServiceMigrations) : undefined;
    const deviceExecutions = independentExecution ? createExecutionRouting({ local: independentExecution.executions,
      call: async (identity, activityId, args) => {
        if (!directory) throw new StorageError('unavailable');
        const session = (await directory.list(identity)).find(item => item.workspace?.activityId === activityId);
        if (!session) throw new StorageError('forbidden');
        const dependencies = await connectedSchool().dependenciesForSession(identity, session.sessionId);
        const request = executionRoutingRequestSchema.parse({ ...z.record(z.string(), z.unknown()).parse(args[1]), method: args[0] });
        const invoke = async () => {
          const owner = dependencies.learning.executions;
          if (request.method === 'read') return owner.read(identity, activityId, request.requestId);
          if (request.method === 'artifact') return owner.artifact(identity, activityId, request.requestId);
          if (request.method === 'controlReceipt') return owner.controlReceipt(identity, activityId, request.requestId, request.controlId);
          const scope = { ...request.context, assertDispatch: async () => {
            if ('dispatchAuthorized' in request && request.dispatchAuthorized) return assertWorkspaceCommand(identity, activityId, request.context);
            throw new StorageError('forbidden');
          } };
          if (request.method === 'agent.dispatch') return owner.agent.dispatch(identity, activityId, scope, request.action);
          if (request.method === 'agent.control') return owner.agent.control(identity, activityId, scope, request.requestId, request.control);
          if (request.method === 'agent.read') return owner.agent.read(identity, activityId, scope, request.requestId);
          if (request.method === 'agent.original') return owner.agent.original(identity, activityId, scope, request.requestId);
          if (request.method === 'agent.status') return owner.agent.status(identity, activityId, scope, request.requestId);
          if (request.method === 'agent.cleanupStatus') return owner.agent.cleanupStatus(identity, activityId, scope, request.requestId);
          return owner.agent.cleanup(identity, activityId, scope, request.requestId, request.stop);
        };
        const permit = sessionAuthority.getStore();
        return permit ? dependencies.withAuthority(permit, invoke) : invoke();
      } }) : undefined;
    const workspaceAuthority = createWorkspaceAgentAuthority({
      async sessions(identity) { if (!directory) throw new StorageError('unavailable'); return directory.list(identity); },
      agent: sessionRuntimeFor, activity: (identity, activityId) => workspaceOpen(identity, activityId),
    });
    const assertWorkspaceCommand = workspaceAuthority.assertDispatch;
    async function assertSessionModel(identity: SpaceIdentity, permit: AgentDispatchPermit, attemptId: string) {
      if (permit.operationId !== attemptId) throw new StorageError('forbidden');
      return assertSessionPermit(identity, permit);
    }
    async function assertSessionPermit(identity: SpaceIdentity, permit: AgentDispatchPermit) {
      if (!directory) throw new StorageError('forbidden');
      const session = await directory.read(identity, permit.sessionId);
      if (session.workspace) {
        const activity = await workspaceOpen(identity, session.workspace.activityId);
        if (activity.status !== 'open' || activity.course?.helpPolicy?.questions === 'disabled') throw new StorageError('forbidden');
      }
      const port = sessionAgent ? await sessionAgent.agent(identity, session.sessionId)
        : createAgentSessionClient(createAgentConnection(root, session.owner.connectionId, agentSessionsCapability, session.owner.target));
      await port.assertDispatch(identity, permit);
    }
    const receivers = [...(actions.receivers ?? [])];
    const assertArtifactAdoption = workspaceAuthority.assertArtifactAdoption;
    learning = data && enabled.has('learning-data') ? createLearningData(data.storage, spaces, courses,
      { ...actions, receivers }, executionModule ? undefined : native, executionModule ? undefined : nativeChannel, assertArtifactAdoption) : undefined;
    const dataDescriptor = data ? environment.services.find(item => item.serviceId === data.storage.owner.serviceId)! : undefined;
    const sourceAuthority = dataDescriptor ? createConnectionAuthority({ root, service: { ...dataDescriptor,
      capabilities: [agentDependenciesCapability] }, handlers: {} }) : undefined;
    let modelDispatchOpen = !isolatedAtStartup;
    const paired = model && models ? createPairedLearningModels(model.storage, models, {
      authorize: spaces.authorize,
      authorizeBinding: async (identity, binding) => { await spaces.authorizeConnection(identity, binding.connectionId); },
      recipientSuccessions: createModelRecipientRecovery(root, environment.services[0]!, async (identity, connectionId) => {
        await spaces.authorizeConnection(identity, connectionId);
      }),
      async authorizeOrigin(identity, origin, request) {
        await spaces.authorize(identity);
        if (origin.formatVersion !== 3) throw new StorageError('incompatible');
        if (!sourceAuthority || !directory) throw new StorageError('unavailable');
        try { await sourceAuthority.assertSourceAuthorized({ sourceEnvironmentId: origin.service.environmentId,
          sourceServiceId: origin.service.serviceId, sourceInstallationId: origin.installationId, grantId: origin.grantId }, 'agent.dependencies.v2'); }
        catch { throw new StorageError('forbidden'); }
        const session = await directory.read(identity, origin.sessionId), fixed = session.owner;
        if (fixed.target.environmentId !== origin.service.environmentId || fixed.target.serviceId !== origin.service.serviceId
          || !await matchesInstallation(fixed, origin.installationId)) throw new StorageError('forbidden');
        const read = ['selection.read', 'selection.snapshot', 'selection.resolve', 'selection.pinned', 'segments.read', 'checks.read',
          'checks.progress', 'checks.summary', 'checks.requestPayload', 'images.read', 'checks.cancel'].includes(request.operation);
        if (!read) {
          if (!origin.authority || origin.authority.sessionId !== session.sessionId) throw new StorageError('forbidden');
          await assertSessionPermit(identity, origin.authority);
        }
        if (request.operation === 'checks.receive' || request.operation === 'checks.dispatch') {
          if (!origin.authority) throw new StorageError('forbidden');
          const attemptId = request.operation === 'checks.receive' ? (request.args[0] as { attemptId: string }).attemptId : String(request.args[0]);
          await assertSessionModel(identity, origin.authority, attemptId);
        }
      },
      assertWritable() { if (!modelDispatchOpen) throw new StorageError('maintenance'); },
    }) : undefined;
    const localModelService = models ? createLearningModelService(models, spaces.authorize) : undefined;
    function modelsForPeer(identity: SpaceIdentity, session: AgentSession, source: Readonly<ChunkConnectionSource>, call: Readonly<AgentDependencyCall>) {
      if (!models || !localModelService) throw new StorageError('unavailable');
      return createLearningModelClient(async request => {
        if (identity.kind !== 'school' || !paired) return localModelService(request);
        if (!source.sourceInstallationId) throw new StorageError('forbidden');
        const read = ['selection.read', 'selection.snapshot', 'selection.resolve', 'selection.pinned', 'segments.read', 'checks.read',
          'checks.progress', 'checks.summary', 'checks.requestPayload', 'images.read'].includes(request.operation);
        const stable = { request, source: { environmentId: source.sourceEnvironmentId, serviceId: source.sourceServiceId,
          installationId: source.sourceInstallationId, grantId: source.grantId }, sessionId: session.sessionId };
        const authority = 'permit' in call ? call.permit : undefined;
        const origin: PairedModelOrigin = { formatVersion: 3, operationId: read ? randomUUID() : operationId('agent-paired-model:' + canonicalDigest(stable)),
          service: { environmentId: source.sourceEnvironmentId, serviceId: source.sourceServiceId },
          installationId: source.sourceInstallationId, grantId: source.grantId, sessionId: session.sessionId,
          ...(authority ? { authority } : {}) };
        return paired.request(request, origin);
      });
    }
    async function authorizeSessionIdentity(identity: SpaceIdentity) {
      if (identity.environmentId === environment.environmentId) await spaces.authorize(identity);
      else {
        if (!client) throw new StorageError('forbidden');
        await (schoolClient ?? client).authorizeModel(identity);
      }
    }
    const workspaceOpen = (identity: SpaceIdentity, activityId: string) => identity.environmentId === environment.environmentId
      ? learning!.open(identity, activityId) : connectedSchool().openActivity(identity, activityId);
    async function resolveSessionOwner(identity: SpaceIdentity): Promise<AgentSession['owner']> {

        const selected = identity.environmentId === environment.environmentId ? await agentBindings.read(identity) : null;
        if (selected) {
          if (agent && selected.target.environmentId === agent.storage.owner.environmentId && selected.target.serviceId === agent.storage.owner.serviceId)
            return { ...selected, target: { ...selected.target, capabilities: [...new Set([...selected.target.capabilities, agentSessionsCapability])] } };
          if (!selected.target.capabilities.includes(agentSessionsCapability)) throw new StorageError('incompatible');
          return selected;
        }
        if (!agent || !enabled.has('teaching-agent')) throw new StorageError('unavailable');
        const descriptor = environment.services.find(item => item.serviceId === agent.storage.owner.serviceId)!;
        return { version: 1, connectionId: agent.storage.owner.serviceId, installationId: environment.installationId,
          target: { ...descriptor, capabilities: [...new Set([...descriptor.capabilities, agentSessionsCapability])] } };
    }
    const localDirectory = data ? createAgentSessions(data.storage, { authorize: authorizeSessionIdentity,
      openActivity: workspaceOpen, resolveOwner: resolveSessionOwner }) : undefined;
    async function directoryFor(identity: SpaceIdentity): Promise<AgentSessionDirectory> {
      if (identity.environmentId === environment.environmentId) {
        if (!localDirectory) throw new StorageError('unavailable');
        return localDirectory;
      }
      const source = await connectedSchool().querySource(identity);
      if (localDirectory && data && source.target.environmentId === data.storage.owner.environmentId && source.target.serviceId === data.storage.owner.serviceId)
        return localDirectory;
      return connectedSchool().sessionDirectory(identity);
    }
    const directory: AgentSessionDirectory | undefined = localDirectory || client && agent ? {
      create: async (identity, input) => (await directoryFor(identity)).create(identity, input),
      read: async (identity, id) => (await directoryFor(identity)).read(identity, id),
      list: async identity => (await directoryFor(identity)).list(identity),
      update: async (identity, input) => (await directoryFor(identity)).update(identity, input),
      markReady: async (identity, input) => (await directoryFor(identity)).markReady(identity, input),
    } : undefined;
    const sessionMaterials = data && directory ? createSessionMaterials(data.storage, { courses,
      openScope: (identity, scope) => scope.kind === 'session' ? directory.read(identity, scope.sessionId) : workspaceOpen(identity, scope.activityId),
    }) : undefined;
    const sessionSkills = data && directory ? createSkills(data.storage, { authorize: authorizeSessionIdentity,
      activity: workspaceOpen, session: directory.read,
      async assertWritable() { if (!enabled.has('learning-data') || await readOnly()) throw new StorageError('maintenance'); },
      async personalOwners(identity) {
        if (environment.profile === 'school' || identity.kind === 'school' && identity.environmentId === environment.environmentId) return [identity];
        const personal = await spaces.readPersonal();
        if (!personal) throw new StorageError('unavailable');
        const connected = client ? await (schoolClient ?? client).list({ rememberCleanup: false }) : [];
        return [personal, ...connected.map(item => item.identity)];
      },
    }) : undefined;
    const personalProjects = data && learning ? createPersonalProjects(data.storage, { authorize: spaces.authorize, learning }) : undefined;
    async function projectWorkspaceRequest(identity: SpaceIdentity, activityId: string, target: import('@xunjie/contracts/spaces').LearningTarget) {
      if (identity.kind !== 'personal' || !personalProjects) return undefined;
      const project = await personalProjects.readForActivity(identity, activityId);
      if (!project) return undefined;
      if (canonicalDigest(project.target) !== canonicalDigest(target)) throw new StorageError('identity-conflict');
      return { requestId: operationId('personal-project-session:' + project.operationId), sessionId: project.workspaceSessionId,
        scenario: 'workspace-assistant' as const, workspace: { activityId, target }, title: project.content.title };
    }
    async function conversationEntry(identity: SpaceIdentity, session: AgentSession): Promise<OwnerConversation> {
      const port = await sessionRuntimeFor(session), conversation = await port.conversation(identity, session.sessionId);
      const activity = session.workspace ? await workspaceOpen(identity, session.workspace.activityId) : undefined;
      const provenance = activity ? { activity: { activityId: activity.activityId, target: activity.target }, ...(activity.course ? { course: {
        courseId: activity.course.courseId, courseName: activity.course.courseName, taskId: activity.course.taskId, taskTitle: activity.course.taskTitle,
        releaseId: activity.course.releaseId, contentDigest: activity.course.contentDigest, helpPolicy: activity.course.helpPolicy,
      } } : {}) } : undefined;
      const text = conversation.messages.map(message => `${message.role}: ${message.text}`).join('\n');
      return { objectId: session.sessionId, owner: { environmentId: session.owner.target.environmentId, serviceId: session.owner.target.serviceId, version: 1 },
        version: learningObjectVersion({ conversation, provenance }), title: session.title ?? text.slice(0, 80), text,
        ...(provenance ? { provenance } : {}) };
    }
    function conversationProvider(): OwnerConversationRead {
      return { owner: { ...(agent ?? data)!.storage.owner, version: 1 },
        async list(identity) {
          if (!directory) throw new StorageError('unavailable');
          const entries = [];
          for (const session of await directory.list(identity)) {
            if (session.deleted || session.state !== 'ready') continue;
            entries.push(await conversationEntry(identity, session));
          }
          return { entries, nextCursor: null };
        },
        async read(identity, objectId, version) {
          if (!directory) throw new StorageError('unavailable');
          const entry = await conversationEntry(identity, await directory.read(identity, objectId));
          if (entry.version !== version) throw new StorageError('conflict');
          return entry;
        },
      };
    }
    async function localQuerySource(identity: SpaceIdentity, sourceId: string): Promise<LearningQuerySource> {
      if (!data || !learning || !personalProjects) throw new StorageError('unavailable');
      await authorizeSessionIdentity(identity);
      return { sourceId, identity, target: { ...data.storage.owner, version: 1 }, learning, personalProjects,
        courses: { owner: { ...space!.storage.owner, version: 1 }, listCourses: courses.listCourses, readRelease: courses.readRelease },
        ownerConversationRead: conversationProvider() };
    }
    async function querySources(): Promise<LearningQuerySourceResult> {
      const personal = await spaces.readPersonal();
      if (!personal || !data || !learning || !personalProjects) throw new StorageError('unavailable');
      await spaces.authorize(personal);
      const owner = { ...data.storage.owner, version: 1 as const };
      const sources: LearningQuerySource[] = [{ sourceId: 'local-personal', identity: personal, target: owner, learning, personalProjects,
        courses: { owner: { ...space!.storage.owner, version: 1 }, listCourses: courses.listCourses, readRelease: courses.readRelease },
        ownerConversationRead: conversationProvider(),
      }];
      const unavailable: LearningQuerySourceResult['unavailable'][number][] = [];
      for (const account of client ? await connectedSchool().list({ rememberCleanup: false }) : []) {
        try {
          const source = await connectedSchool().querySource(account.identity);
          sources.push(source.target.environmentId === data.storage.owner.environmentId && source.target.serviceId === data.storage.owner.serviceId
            ? { ...source, ownerConversationRead: conversationProvider() } : source);
        }
        catch (error) {
          if (!(error instanceof StorageError)) throw error;
          for (const kind of ['activity', 'course', 'personal-project', 'work', 'record', 'conversation'] as const)
            unavailable.push({ sourceId: account.key, kind, code: error.code });
        }
      }
      return { sources, unavailable };
    }
    const learningQuery = createLearningQuery({ sources: querySources });
    const projectMaterials = data && sessionMaterials ? createProjectMaterials(data.storage, {
      openActivity: workspaceOpen, materials: sessionMaterials,
      async assertDispatch() {
        const permit = sessionAuthority.getStore();
        if (!permit || !sessionAgent || !directory) throw new StorageError('forbidden');
        const session = await sessionAgent.runtime.sessionSnapshot((await spaces.readPersonal())!, permit.sessionId);
        await sessionAgent.assertDispatch(session.session.identity, permit);
      },
      async authorizeReference(identity, reference) {
        if (reference.kind !== 'personal-material' && reference.kind !== 'pdf') {
          await learningQuery.readLearning({ reference, range: { offset: 0, length: 1 } }); return;
        }
        if (reference.owner.environmentId !== data.storage.owner.environmentId || reference.owner.serviceId !== data.storage.owner.serviceId
          || canonicalDigest([identity.environmentId, identity.spaceId, identity.principalId, identity.kind])
            !== canonicalDigest([reference.identity.environmentId, reference.identity.spaceId, reference.identity.principalId, reference.identity.kind]))
          throw new StorageError('forbidden');
        if (reference.kind === 'personal-material') {
          const original = await sessionMaterials.personal.original(identity, reference.scope, reference.objectId, Number(reference.version));
          if (original.version.sha256 !== reference.sha256) throw new StorageError('identity-conflict');
        } else {
          const original = await sessionMaterials.pdf.document(identity, reference.scope, reference.objectId);
          if (original.sha256 !== reference.sha256) throw new StorageError('identity-conflict');
        }
      },
    }) : undefined;
    async function studentToolsHost(): Promise<LearningToolsHost> {

          const personal = await spaces.readPersonal();
          if (!personal || !data || !directory || !personalProjects || !projectMaterials) throw new StorageError('unavailable');
          return { localPersonalIdentity: personal, localLearningTarget: { ...data.storage.owner, version: 1 }, query: learningQuery,
            projects: personalProjects, authorizeCreation: authorizePersonalProjectCreation,
            workspaceSessions: {
              async ensure(identity, input) {
                const session = await sessionAgent!.sessions.create(identity, { requestId: input.requestId, sessionId: input.sessionId,
                  scenario: 'workspace-assistant', workspace: { activityId: input.activityId, target: input.target }, title: input.title });
                return { sessionId: session.sessionId, activityId: session.workspace!.activityId, target: session.workspace!.target, ready: session.state === 'ready' };
              },
              async receipt(identity, sessionId) {
                try {
                  const session = await directory.read(identity, sessionId);
                  return session.workspace ? { sessionId, activityId: session.workspace.activityId, target: session.workspace.target, ready: session.state === 'ready' } : null;
                } catch (error) { if (error instanceof StorageError && error.code === 'missing') return null; throw error; }
              },
            }, materials: projectMaterials };
    }
    const studentFacts = learning && directory ? createStudentFacts({ activity: workspaceOpen,
      async sources(identity) {
        const source = identity.environmentId === environment.environmentId ? await localQuerySource(identity, 'local-owner')
          : await connectedSchool().querySource(identity);
        return [{ sourceId: source.sourceId, identity, target: source.target, learning: source.learning,
          sessions: directory, core: sessionRuntimeFor }];
      },
    }) : undefined;
    async function workspaceOptions(session: AgentSession, source?: Readonly<ChunkConnectionSource>): Promise<WorkspaceToolOptions> {

          if (!session.workspace) throw new StorageError('forbidden');
          const identity = session.identity;
          const dependencies = identity.environmentId === environment.environmentId ? undefined
            : await connectedSchool().dependenciesForSession(identity, session.sessionId);
          if (dependencies) sessionDependencies.set(session.sessionId, dependencies);
          return { workspace: async () => workspaceOpen(identity, session.workspace!.activityId),
            learning: identity.environmentId === environment.environmentId ? { ...learning!, executions: independentExecution?.executions ?? learning!.executions }
              : { ...dependencies!.learning, executions: deviceExecutions ?? dependencies!.learning.executions },
            courses: identity.environmentId === environment.environmentId ? courses : dependencies!.courses,
            ...(studentFacts ? { studentFacts } : {}),
            ...(identity.kind === 'personal' && personalProjects ? { project: personalProjects.readForActivity } : {}),
            executionOrigin: () => source ? (() => {
              if (!source.sourceInstallationId) throw new StorageError('forbidden');
              return { sourceEnvironmentId: source.sourceEnvironmentId, sourceServiceId: source.sourceServiceId,
                sourceInstallationId: source.sourceInstallationId, grantId: source.grantId };
            })() : undefined, environment: () => executionEnvironment(identity) };
    }
    if (agent && !data) {
      const dependencies = createAgentDependencyClient(call => connectedSchool().agentDependency(call.identity, call));
      standaloneAgent = createStandaloneAgentApplication({ root, environment, configuration,
        storage: agent.storage, binding: agent.binding, enabled: enabled.has('teaching-agent'), dependencies,
        ...(models ? { models } : {}) });
      if (enabled.has('teaching-agent')) sessionAgent = standaloneAgent.agent;
    }
    if (agent && models && directory && sessionMaterials && personalProjects && projectMaterials && enabled.has('teaching-agent')) {
      sessionAgent = createProductAgent({ storage: agent.storage, directory, models, authorize: authorizeSessionIdentity,
        async modelsForSession(session) {
          if (session.identity.environmentId === environment.environmentId) return models;
          const dependencies = await connectedSchool().dependenciesForSession(session.identity, session.sessionId);
          sessionDependencies.set(session.sessionId, dependencies);
          return dependencies.models;
        },
        workspaceRequest: projectWorkspaceRequest,
        readOnly: true, withAuthority: (permit, work) => sessionAuthority.run(permit, () => {
          const dependencies = sessionDependencies.get(permit.sessionId);
          return dependencies ? dependencies.withAuthority(permit, work) : work();
        }),
        async materials(session) {
          if (session.identity.environmentId === environment.environmentId) return sessionMaterials;
          const source = await connectedSchool().querySource(session.identity);
          if (source.target.environmentId === data!.storage.owner.environmentId && source.target.serviceId === data!.storage.owner.serviceId) return sessionMaterials;
          const dependencies = await connectedSchool().dependenciesForSession(session.identity, session.sessionId);
          sessionDependencies.set(session.sessionId, dependencies); return dependencies.materials;
        },
        async materialSource(session) {
          if (session.identity.environmentId === environment.environmentId) return { sourceId: 'local-personal', owner: { ...data!.storage.owner, version: 1 } };
          const source = await connectedSchool().querySource(session.identity);
          return { sourceId: source.sourceId, owner: source.target };
        },
        ...(sessionSkills ? { async skills(_session, companions) {
          if (_session.identity.environmentId !== environment.environmentId) {
            const source = await connectedSchool().querySource(_session.identity);
            if (source.target.environmentId !== data!.storage.owner.environmentId || source.target.serviceId !== data!.storage.owner.serviceId) {
              const dependencies = await connectedSchool().dependenciesForSession(_session.identity, _session.sessionId);
              sessionDependencies.set(_session.sessionId, dependencies);
              const module = (await dependencies.tools()).find(module => module.id === 'skills');
              if (!module) throw new StorageError('incompatible');
              return module;
            }
          }
          return createSkillTools({ owner: { ...data!.storage.owner, version: 1 }, skills: sessionSkills,
            async toolNames(context) { return (await Promise.all(companions.map(module => module.list(context)))).flat().map(offer => offer.definition.name); } });
        } } : {}),
        remote: sessionRuntimeFor,
        async deleted(session) {
          await sessionMaterials.releaseDeleted(session.identity, { requestId: operationId('delete-session-materials:' + session.sessionId), sessionId: session.sessionId });
        },
        student: studentToolsHost,
        workspace: workspaceOptions,
        waits: { async read(session, wait) {
          const owner = session.identity.environmentId === environment.environmentId ? independentExecution?.executions ?? learning!.executions
            : deviceExecutions ?? (await connectedSchool().dependenciesForSession(session.identity, session.sessionId)).learning.executions;
          if (!owner) throw new StorageError('unavailable');
          return readWorkspaceAgentWait(owner, session, wait);
        } },
      });
    }
    async function sessionRuntimeFor(session: AgentSession) {
      if (sessionAgent && agent && session.owner.target.environmentId === agent.storage.owner.environmentId
        && session.owner.target.serviceId === agent.storage.owner.serviceId) return sessionAgent.local;
      if (session.identity.environmentId !== environment.environmentId && data) {
        const source = await connectedSchool().querySource(session.identity);
        if (source.target.environmentId !== data.storage.owner.environmentId || source.target.serviceId !== data.storage.owner.serviceId)
          return connectedSchool().sessionAgent(session.identity, session.sessionId);
      }
      if (session.owner.delivery === 'client') throw new StorageError('unavailable');
      if (!session.owner.target.capabilities.includes(agentSessionsCapability)) throw new StorageError('incompatible');
      return createAgentSessionClient(createAgentConnection(root, session.owner.connectionId, agentSessionsCapability, session.owner.target));
    }
    const directoryApplication = directory ? createAgentSessionApplication({ directory, runtime: sessionRuntimeFor,
      deferInitialization: session => session.owner.delivery === 'client',
      workspaceRequest: projectWorkspaceRequest,
    }) : undefined;
    const sessionHttp = directory && directoryApplication ? {
      sessions: sessionAgent?.sessions ?? directoryApplication,
      async agent(identity: SpaceIdentity, id: string) {
        const session = await directory.read(identity, id);
        if (session.deleted) throw new StorageError('missing');
        if (session.state !== 'ready') throw new StorageError('unavailable');
        return sessionRuntimeFor(session);
      },
      ...(sessionMaterials ? { materials: async () => sessionMaterials } : {}),
      ...(sessionSkills ? { async skills(identity: SpaceIdentity, sessionId: string) {
        if (identity.environmentId !== environment.environmentId) {
          const source = await connectedSchool().querySource(identity);
          if (source.target.environmentId !== data!.storage.owner.environmentId || source.target.serviceId !== data!.storage.owner.serviceId)
            return connectedSchool().sessionSkills(identity, sessionId);
        }
        return sessionSkills;
      } } : {}),
    } : undefined;
    const dependencyChannel = data && learning && localDirectory && sessionMaterials ? createAgentDependencyChannel(data.storage, {
      sessions: localDirectory, learning: { ...learning, executions: independentExecution?.executions ?? learning.executions }, courses,
      materials: sessionMaterials,
      executionRecordSource: createSchoolExecutionRecordSource({ root, spaces, bindings: agentBindings }),
      async authorize(identity, source) {
        await source.assertAuthorized?.();
        await authorizeSchoolDeviceGrant(root, spaces, identity, source.grantId);
        await spaces.authorize(identity);
      },
      resolveOwner: resolveSessionOwner,
      isOwnerSuccessor: (owner, source) => matchesInstallation(owner, source.sourceInstallationId),
      async assertDispatch(identity, permit) {
        const saved = await localDirectory.read(identity, permit.sessionId), port = await sessionRuntimeFor(saved);
        await port.assertDispatch(identity, permit);
      },
      async source(identity) { return localQuerySource(identity, 'owner:' + data.storage.owner.serviceId); },
      modelsForSession: modelsForPeer,
      async tools(identity, session, source, call) {
        const peerModels = models ? modelsForPeer(identity, session, source, call) : undefined;
        const companions = [session.scenario === 'workspace-assistant'
          ? createWorkspaceToolModule({ ...await workspaceOptions(session, source), ...(peerModels ? { models: peerModels } : {}) })
          : createLearningTools(await studentToolsHost()), createUserQuestions(),
          createDocumentTools({ materials: sessionMaterials, ...(peerModels ? { models: peerModels } : {}),
            source: { sourceId: 'owner:' + data.storage.owner.serviceId, owner: { ...data.storage.owner, version: 1 } } })];
        return [...companions, ...(sessionSkills ? [createSkillTools({ owner: { ...data.storage.owner, version: 1 }, skills: sessionSkills,
          async toolNames(context) { return (await Promise.all(companions.map(module => module.list(context)))).flat().map(offer => offer.definition.name); } })] : [])];
      },
    }, { successor: async (original, current) => !!original.sourceInstallationId && !!current.sourceInstallationId
      && isRecoverySuccessor(root, { ...original, sourceInstallationId: original.sourceInstallationId }, current.sourceInstallationId) }) : undefined;
    const modules = [[space, async () => { await spaces.validate(); await courses.validate(); await agentBindings.validate(); }],
      ...(data ? [[data, () => validateLearningData(data.storage)] as const] : []),
      ...(model && modelGateway ? [[model, modelGateway.validate] as const] : []),
      ...(agent && !standaloneAgent ? [[agent, () => validateAgentServiceStorage(agent.storage)] as const] : []),
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
        } } : module === agent ? { boundary: collectAgentRuntimeBoundary, receiverBoundary: collectAgentRuntimeReceiverBoundary } : {}),
        // #221: every business owner emits a read-only fixed-source closure at this same closed
        // boundary, so an isolated restore can prove it holds the originals without recomputation.
        ...(module === data ? { sources: collectLearningSources }
          : module === agent ? { sources: collectAgentServiceSources } : {}),
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
      } } : module === agent && sessionAgent ? (() => {
        const activeAgent = sessionAgent;
        return { ...recoveryOwner, participant: { ...participant,
          async closeWrites() { activeAgent.closeWrites(); await participant.closeWrites(); },
          async closeDispatch() { activeAgent.closeDispatch(); await participant.closeDispatch(); },
          async drain() { await activeAgent.drain(); await participant.drain(); },
          async resume() { await participant.resume(); await activeAgent.resume(); },
        } };
      })() : recoveryOwner);
    }
    if (standaloneAgent) owners.push(...standaloneAgent.owners);
    const targetOwner = data ?? model ?? space;
    if (!targetOwner) throw new RecoveryError('missing-business-owner');
    const localTarget = { ...targetOwner.storage.owner, version: 1 as const };
    schoolClient = environment.profile === 'school' ? undefined : createSchoolClient(root, environment, {
      target: localTarget, ...(model ? { modelTarget: { ...model.storage.owner, version: 1 as const } } : {}), ...(data ? { create: (authority, courseAuthority) => createLearningData(data.storage, authority, courseAuthority,
        actions, undefined, undefined, assertArtifactAdoption) } : {}),
      ...(environment.profile === 'local' && learning ? { studyCopies: learning.studyCopies } : {}),
      models, personal: spaces.personal,
      ...(sessionHttp ? { sessions: sessionHttp } : {}),
      executionCommandAuthorization: assertWorkspaceCommand,
      ...(independentExecution ? { executions: independentExecution.executions } : {}),
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
    if (standaloneAgent) await standaloneAgent.start();
    else if (sessionAgent && !isolatedAtStartup) await sessionAgent.start();
    const dependencyCapability: CapabilityHandler = async (value, source) => {
      if (!dependencyChannel) throw new StorageError('unavailable');
      try { return await dependencyChannel.handle(value, source); }
      catch (error) { return { error: error instanceof StorageError ? error.code : 'invalid' }; }
    };
    const serviceCapabilities: Record<string, Record<string, CapabilityHandler>> = {
      ...standaloneAgent?.serviceCapabilities,
      [space.storage.owner.serviceId]: { 'courses.execution-design': (value, source) => {
        const input = z.object({ operation: z.enum(['compile', 'prepare', 'read']), request: z.unknown() }).strict().parse(value);
        return courseDesignAuthority.run(async () => { await source.assertAuthorized?.(); }, () => courseExecutionDesign(input.operation, input.request));
      } },
    };
    if (data && dependencyChannel) serviceCapabilities[data.storage.owner.serviceId] = { [agentDependenciesCapability]: dependencyCapability };
    if (agent && data && directory && sessionAgent) serviceCapabilities[agent.storage.owner.serviceId] = {
      [agentSessionsCapability]: createAgentSessionHandler({ storage: agent.storage, agent: sessionAgent.local,
        async authorize(call, source) {
          if (source.sourceEnvironmentId !== data.storage.owner.environmentId || source.sourceServiceId !== data.storage.owner.serviceId)
            throw new StorageError('forbidden');
          const session = await directory.read(call.identity, call.sessionId);
          if (session.owner.target.environmentId !== agent.storage.owner.environmentId || session.owner.target.serviceId !== agent.storage.owner.serviceId)
            throw new StorageError('forbidden');
        },
        successor: async (original, current) => !!original.sourceInstallationId && !!current.sourceInstallationId
          && isRecoverySuccessor(root, { ...original, sourceInstallationId: original.sourceInstallationId }, current.sourceInstallationId),
      }),
    };
    const deviceSetup = environment.profile === 'school' && dataDescriptor && enabled.has('learning-data')
      && !enabled.has('teaching-agent') && !enabled.has('model-connection') && !enabled.has('tool-execution')
      ? createSchoolDeviceSetup({ root, spaces, bindings: agentBindings,
        target: { ...dataDescriptor, capabilities: ['runtime.status', agentDependenciesCapability] },
        authority: createConnectionAuthority({ root, service: { ...dataDescriptor, capabilities: [agentDependenciesCapability] },
          handlers: { [agentDependenciesCapability]: dependencyCapability } }),
        assertWritable: async () => { if (await readOnly()) throw new StorageError('maintenance'); },
      }) : undefined;
    return { owners, isolatedReads: true as const, lifecycle: {
      async pause() {
        if (standaloneAgent) await standaloneAgent.lifecycle.pause(); else sessionAgent?.closeDispatch();
        await lifecycle?.pause();
      },
      async resume() {
        await lifecycle?.resume();
        if (standaloneAgent) await standaloneAgent.lifecycle.resume(); else await sessionAgent?.resume();
      },
      async close() {
        if (standaloneAgent) await standaloneAgent.lifecycle.close(); else await sessionAgent?.close();
        await lifecycle?.close();
      },
    },
      async authorizedSource(targetServiceId: string, source: { sourceEnvironmentId: string; sourceServiceId: string; sourceInstallationId?: string; grantId: string; capabilities: readonly string[] }) {
        if (!learning || targetServiceId !== dataDescriptor?.serviceId || !source.sourceInstallationId || !source.capabilities.includes(agentDependenciesCapability)) return;
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
          try { await sourceAuthority.assertSourceAuthorized(origin, agentDependenciesCapability); }
          catch (error) {
            if (error instanceof RuntimeConnectionError && error.code === 'unauthorized') {
              if (await hasRecoverySuccession(root, origin)) throw new StorageError('unavailable');
              throw new StorageError('forbidden');
            }
            throw error;
          }
          const session = (await directory?.list(identity))?.find(item => item.workspace?.activityId === activityId);
          const fixed = session?.owner;
          if (!session || session.deleted || session.archived || !fixed || fixed.target.environmentId !== origin.sourceEnvironmentId
            || fixed.target.serviceId !== origin.sourceServiceId || !await matchesInstallation(fixed, origin.sourceInstallationId))
            throw new StorageError('forbidden');
        }, isOpen);
        if (schoolClient && models && isOpen()) await schoolClient.pollModelTasks(isOpen);
      },
      handle: createLearningEntry({ environment, spaces, ...(learning ? { learning } : {}), courses,
        ...(sessionHttp ? { agentSessions: async () => sessionHttp } : {}),
        async agentSources(identity) {
          if (identity.environmentId !== environment.environmentId) {
            const source = await connectedSchool().querySource(identity);
            if (!source.courses) throw new StorageError('unavailable');
            return { identity: source.identity, learningTarget: source.target, courseTarget: source.courses.owner };
          }
          await spaces.authorize(identity);
          return { identity, learningTarget: await spaces.resolveBinding(identity), courseTarget: { ...space!.storage.owner, version: 1 } };
        },
        ...(sessionSkills ? { skills: async () => sessionSkills } : {}),
        ...(personalProjects ? { projects: personalProjects } : {}),
        assertAgentCommand: assertWorkspaceCommand,
        localStudyAllowed: async identity => {
          await spaces.authorize(identity);
          if (environment.profile !== 'school' || !enabled.has('space-course') || !enabled.has('learning-data')
            || enabled.has('teaching-agent') || enabled.has('model-connection') || enabled.has('tool-execution')
            || Object.values(deployment.dependencies).some(dependency => dependency.kind === 'connection')) return false;
          const member = await agentBindings.read(identity);
          // A client delivery identifies the already-local Agent. A server/independent service binding
          // must keep its original data/Agent path even when no Agent module is enabled on this school.
          if (member && member.delivery !== 'client') return false;
          const sessions = await localDirectory?.list(identity) ?? [];
          return sessions.every(session => session.owner.delivery === 'client');
        },
        ...(deviceSetup ? { deviceSetup } : {}),
        ...(independentExecution ? { executions: independentExecution.executions } : {}),
        courseExecutionDesign,
        ...(models ? { models } : {}), client: schoolClient, readOnly, requiresNamespace,
        async bindAgent(value) {
          const input = teachingAgentBindingInputSchema.parse(value);
          if (input.delivery === 'client') {
            if (!sourceAuthority || !input.grantId) throw new StorageError('forbidden');
            await spaces.authorizeConnection(input.identity, input.connectionId);
            if (input.deviceModules?.some(module => module.environmentId !== input.target.environmentId)
              || input.deviceModules && new Set(input.deviceModules.map(module => module.unit)).size !== input.deviceModules.length)
              throw new StorageError('forbidden');
            await sourceAuthority.assertSourceAuthorized({ sourceEnvironmentId: input.target.environmentId,
              sourceServiceId: input.target.serviceId, sourceInstallationId: input.installationId, grantId: input.grantId }, agentDependenciesCapability);
            if (input.executionGrantId) {
              const execution = input.deviceModules?.find(module => module.unit === 'tool-execution');
              if (!execution || input.executionGrantId === input.grantId) throw new StorageError('forbidden');
              await sourceAuthority.assertSourceAuthorized({ sourceEnvironmentId: execution.environmentId,
                sourceServiceId: execution.serviceId, sourceInstallationId: input.installationId,
                grantId: input.executionGrantId }, agentDependenciesCapability);
            }
            return agentBindings.bind(input);
          }
          const config = await readJson<InstalledConfiguration>(join(root, 'installation.json'));
          const connection = config.connections.find(item => item.connectionId === input.connectionId);
          if (!connection || connection.sourceEnvironmentId !== environment.environmentId || connection.sourceServiceId !== data?.storage.owner.serviceId
            || connection.target.environmentId !== input.target.environmentId || connection.target.serviceId !== input.target.serviceId
            || !connection.requiredCapabilities.includes(agentSessionsCapability)) throw new StorageError('forbidden');
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
    if (standaloneAgent) await standaloneAgent.lifecycle.close(); else await sessionAgent?.close();
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
        : unit === 'teaching-agent' ? agentServiceMigrations : unit === 'tool-execution' ? executionOwnerMigrations : learningMigrations,
      ...(unit === 'tool-execution' ? { validateMaterial: async (storage: OwnedStorage, material: OwnerBoundaryMaterial) =>
        validateExecutionBoundary(storage, material.evidence) } : unit === 'learning-data' ? { validateMaterial: async (storage: OwnedStorage, material: OwnerBoundaryMaterial) =>
        validateExecutionBoundary(storage, material.evidence), sources: collectLearningSources, validateSources: validateLearningSources }
        : unit === 'teaching-agent' ? {
          boundary: collectAgentRuntimeBoundary, receiverBoundary: collectAgentRuntimeReceiverBoundary, validateMaterial: validateAgentRuntimeBoundary,
          sources: collectAgentServiceSources, validateSources: validateAgentServiceSources,
        } : {}),
      validateService: async storage => {
        if (unit === 'learning-data') return validateLearningData(storage);
        if (unit === 'teaching-agent') return validateAgentServiceStorage(storage);
        if (unit === 'tool-execution') return validateExecutionOwner(storage);
        if (unit === 'model-connection') return (await createModelGateway(storage, { authorize: async () => {} })).validate();
        const spaces = createSpaces(storage);
        await spaces.validate();
        await createCourses(storage, spaces).validate();
        await createMemberAgentBindings(storage, spaces.authorize).validate();
      } });
  }).filter((target): target is NonNullable<typeof target> => target !== null);
}
