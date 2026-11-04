import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createFileBackend, openStorage, provisionStorage, StorageError } from '@xunjie/storage';
import pg from 'pg';
import type { OwnedStorage, StorageBinding, DatabaseConnection } from '@xunjie/storage';
import { createSpaces, spaceMigrations, createLearningData, learningMigrations, createLearningEntry, validateLearningData,
  createCourses, spaceCourseMigrations, createLearningAuthority, linuxSessionEntry, productNativeAdapters, createNativeChannel } from '@xunjie/learning-space';
import type { RuntimeEnvironment } from '@xunjie/contracts/product-runtime';
import type { ExecutionDevice } from '@xunjie/contracts/execution';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import type { ActionIntentOptions, NativeSessionIsolation } from '@xunjie/learning-space';
import type { InstalledConfiguration } from './runtime.js';
import { databaseBinding, resolveCredential, storeCredential } from './postgres.js';
import { atomicJson, exists } from './io.js';
import { createStorageRecoveryOwner } from './storage-recovery.js';
import { createStorageRecoveryTarget } from './storage-recovery.js';
import type { RuntimeResources } from './postgres.js';
import { RecoveryError } from './recovery.js';
import type { RecoveryOwner } from './recovery-types.js';
import { createSchoolClient } from './school-client.js';
import { verifyWindowsSessionHelper } from './prerequisites.js';
import { createNativeChannelClients } from './native-channel-clients.js';

/** Normal product composition; no test hosts, account fixtures or legacy SQLite dependencies. */
export async function createProductLearningApplication(context: {
  root: string; environment: RuntimeEnvironment; configuration: InstalledConfiguration;
}, actions: ActionIntentOptions = {}) {
  const { root, environment, configuration } = context;
  const client = environment.profile === 'school' ? undefined : createSchoolClient(root, environment);
  const lifecycle = client ? await createNativeChannelClients({ root, environment, resources: configuration.resources, client }) : undefined;
  const database = await databaseBinding(root, configuration.database);
  if (!database && environment.profile === 'school') throw new Error('School identity requires PostgreSQL.');
  if (!database) return { owners: [], ...(lifecycle ? { lifecycle } : {}), handle: createLearningEntry({ environment,
    administratorToken: await resolveCredential(root, 'control'), client }) };
  const { credentialRef, ...connection } = database;
  const admin = { ...connection, password: await resolveCredential(root, credentialRef) };
  const opened: OwnedStorage[] = [];
  const owners: RecoveryOwner[] = [];
  try {
    async function owner(unit: 'space-course' | 'learning-data', migrations: typeof spaceMigrations) {
      let descriptor = environment.services.find(item => item.unit === unit);
      if (!descriptor) {
        descriptor = { environmentId: environment.environmentId, serviceId: randomUUID(), unit,
          endpoint: environment.services[0]!.endpoint, protocolVersion: 1, capabilities: unit === 'space-course'
            ? ['spaces.access'] : ['activity:read', 'activity:write'] };
        environment.services.push(descriptor);
        await atomicJson(join(root, 'environment.json'), environment);
      }
      if (!configuration.requiredServiceIds.includes(descriptor.serviceId)) {
        configuration.requiredServiceIds.push(descriptor.serviceId);
        await atomicJson(join(root, 'installation.json'), configuration);
      }
      if (descriptor.endpoint !== environment.services[0]!.endpoint) {
        descriptor.endpoint = environment.services[0]!.endpoint;
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
    const space = await owner('space-course', spaceCourseMigrations);
    const data = await owner('learning-data', learningMigrations);
    const spaces = createSpaces(space.storage, { credentialNamespace: environment.installationId });
    const courses = createCourses(space.storage, spaces);
    // A personal install supervises real local sessions. A school host also supervises them: the
    // same native contract runs on the school execution node, and the node identity is derived from
    // the installation so a restart or an address change never reassigns an existing run. On Linux
    // the owner only starts a session through the installed restricted entry; without a passing
    // probe it refuses the run instead of calling a plain child process "confined".
    const windowsHelper = environment.profile === 'local' ? await verifyWindowsSessionHelper(configuration.resources) : undefined;
    let linuxEntry: ReturnType<typeof linuxSessionEntry> | undefined;
    if (environment.profile === 'school' && process.platform === 'linux') {
      try { linuxEntry = linuxSessionEntry(); }
      catch {
        // Invalid native configuration disables that entry while browser work remains available.
        linuxEntry = { entry: '/usr/local/lib/xunjie/native-session-unavailable', sudo: '/usr/bin/sudo',
          workRoot: '/var/lib/xunjie-native', runUser: 'xunjie', nodeRoot: '/opt/xunjie' };
      }
    }
    const supervised = environment.profile === 'local' || environment.profile === 'school';
    const placement = { nodeClass: environment.profile === 'school' ? 'school-execution-node' as const : 'device' as const,
      secureTransport: new URL(environment.services[0]!.endpoint).protocol === 'https:' };
    const native = supervised ? { nodePath: process.execPath, placement,
      ...(windowsHelper ? { windowsHelper } : {}),
      ...(linuxEntry ? { linuxEntry } : {}),
      sessionRoot: join(root, 'native-sessions'),
      nodeId: environment.profile === 'school' ? `school-${environment.installationId}` : `local-${process.platform}` } : undefined;
    let learning: ReturnType<typeof createLearningData>;
    const nativeChannel = environment.profile === 'school' ? createNativeChannel(data.storage, {
      authenticate: (token, connectionId) => spaces.authenticateConnection(token, connectionId),
      authorizeConnection: (identity, connectionId) => spaces.authorizeConnection(identity, connectionId),
      authorize: (identity, activityId) => learning.open(identity, activityId),
    }) : undefined;
    learning = createLearningData(data.storage, spaces, courses, actions, native, nativeChannel);
    for (const [module, validate] of [[space, async () => { await spaces.validate(); await courses.validate(); }],
      [data, learning.validate]] as const) {
      const recoveryOwner = createStorageRecoveryOwner({ storage: module.storage, binding: module.binding, migrations: module.migrations,
        resources: configuration.resources, resourceRoots: [join(root, 'learning-resources', module === space ? 'space-course' : 'learning-data')],
        validateService: validate });
      const participant = recoveryOwner.participant;
      let dispatchClosing: Promise<void> | undefined;
      function closeDispatch() {
        nativeChannel?.closeDispatch();
        learning.intents.closeDispatch();
        // Both coordinator actions join one storage gate. A second queued close could occupy
        // the bound connection while channel drain opens another connection to a changed endpoint.
        return dispatchClosing ??= participant.closeDispatch().catch(error => { dispatchClosing = undefined; throw error; });
      }
      owners.push(module === data ? { ...recoveryOwner, participant: { ...participant,
        async closeWrites() {
          // The coordinator closes writes and dispatch concurrently. Keep this owner's generation
          // and acknowledgement writes open until every claimed device instance has exited.
          try {
            await closeDispatch();
            await nativeChannel?.drain();
            await participant.closeWrites();
          } finally { dispatchClosing = undefined; }
        },
        closeDispatch,
        async drain() { await learning.intents.drain(); await learning.executions.shutdown(); await participant.drain(); },
        async resume() {
          try { await participant.resume(); nativeChannel?.resume(); learning.intents.resume(); await learning.executions.recoverNative(); }
          finally { dispatchClosing = undefined; }
        },
      } } : recoveryOwner);
    }
    const localTarget = { ...data.storage.owner, version: 1 as const };
    const schoolClient = environment.profile === 'school' ? undefined : createSchoolClient(root, environment, {
      target: localTarget, create: (authority, courseAuthority) => createLearningData(data.storage, authority, courseAuthority, actions) });
    // The isolation answer is host-wide, so the owner measures it once. Status reports the state
    // machine rather than a prose message: `starting` until the unit answers, then `ready` with a
    // structured fact or `unavailable` when this host must refuse native sessions.
    const measured = linuxEntry ? learning.executions.linuxEntryIsolation() : undefined;
    const probeState: { value?: NativeSessionIsolation | null } = {};
    if (measured) void measured.then(value => { probeState.value = value; }, () => { probeState.value = null; });
    const localIsolationReady = environment.profile === 'local' && (process.platform === 'darwin'
      ? await exists('/usr/bin/sandbox-exec') : process.platform === 'win32' && windowsHelper !== undefined);
    const executionEnvironment = async (identity: SpaceIdentity) => {
      const registered = nativeChannel ? (await nativeChannel.nodes(identity)).sort((left, right) => left.nodeId.localeCompare(right.nodeId))[0] : undefined;
      if (registered) return { nodeClass: 'device' as const, secureTransport: placement.secureTransport,
        remoteAvailable: placement.secureTransport && probeState.value !== undefined && probeState.value !== null, device: { platform: registered.platform,
          browser: { worker: false, webassembly: false, sandboxedFrame: false },
          native: { supported: true, installed: true, authorized: true, prepared: 'ready' as const } },
        adapters: productNativeAdapters.map(adapter => ({ adapterId: adapter.adapterId,
          adapterVersion: adapter.adapterVersion, platforms: adapter.platforms ?? [],
          available: registered.adapters.some(declaration => declaration.adapterId === adapter.adapterId
            && declaration.adapterVersion === adapter.adapterVersion) })) };
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
    return { owners, ...(lifecycle ? { lifecycle } : {}), capabilities: { 'learning.authority': createLearningAuthority(spaces, courses) }, handle: createLearningEntry({ environment, spaces, learning, courses, client: schoolClient,
      executionEnvironment, ...(nativeChannel ? { nativeChannel } : {}), target: { ...data.storage.owner, version: 1 }, administratorToken: await resolveCredential(root, 'control') }),
      ...(linuxEntry ? { facts: async () => {
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
  } catch (error) { await lifecycle?.close(); await Promise.allSettled(opened.map(storage => storage.close())); throw error; }
}

/** Both real owners register native restore targets and validate only their own domain facts. */
export function createLearningRecoveryTargets(options: {
  root: string; environment: RuntimeEnvironment; resources: RuntimeResources;
  admin(): Promise<DatabaseConnection | null>;
}) {
  return (['space-course', 'learning-data'] as const).map(unit => {
    const descriptors = options.environment.services.filter(service => service.unit === unit);
    if (descriptors.length !== 1) throw new RecoveryError('missing-business-owner');
    const descriptor = descriptors[0]!;
    const resourceRoot = join(options.root, 'learning-resources', unit);
    return createStorageRecoveryTarget({ owner: { environmentId: options.environment.environmentId, serviceId: descriptor.serviceId },
      admin: async () => { const value = await options.admin(); if (!value) throw new RecoveryError('target-database-required'); return value; },
      resources: options.resources, backend: createFileBackend({ id: unit, root: resourceRoot }), resourceRoots: [resourceRoot],
      migrations: unit === 'space-course' ? spaceCourseMigrations : learningMigrations,
      validateService: async storage => {
        if (unit === 'learning-data') return validateLearningData(storage);
        const spaces = createSpaces(storage);
        await spaces.validate();
        await createCourses(storage, spaces).validate();
      } });
  });
}
