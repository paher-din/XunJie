import { randomBytes, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { createFileBackend, openStorage, provisionStorage } from '@xunjie/storage';
import type { OwnedStorage, StorageBinding, DatabaseConnection } from '@xunjie/storage';
import { createSpaces, spaceMigrations, createLearningData, learningMigrations, createLearningEntry, validateLearningData,
  createCourses, spaceCourseMigrations, createLearningAuthority } from '@xunjie/learning-space';
import type { RuntimeEnvironment } from '@xunjie/contracts/product-runtime';
import type { ActionIntentOptions } from '@xunjie/learning-space';
import { createModelGateway, modelMigrations } from '@xunjie/learning-space';
import type { InstalledConfiguration } from './runtime.js';
import { databaseBinding, resolveCredential, storeCredential } from './postgres.js';
import { atomicJson, exists, alive, processIdentity } from './io.js';
import { createStorageRecoveryOwner } from './storage-recovery.js';
import { createStorageRecoveryTarget } from './storage-recovery.js';
import type { RuntimeResources } from './postgres.js';
import { RecoveryError } from './recovery.js';
import type { RecoveryOwner } from './recovery-types.js';
import { createSchoolClient } from './school-client.js';

/** Normal product composition; no test hosts, account fixtures or legacy SQLite dependencies. */
export async function createProductLearningApplication(context: {
  root: string; environment: RuntimeEnvironment; configuration: InstalledConfiguration;
}, actions: ActionIntentOptions = {}) {
  const { root, environment, configuration } = context;
  const client = environment.profile === 'school' ? undefined : createSchoolClient(root, environment);
  const database = await databaseBinding(root, configuration.database);
  if (!database && environment.profile === 'school') throw new Error('School identity requires PostgreSQL.');
  if (!database) return { owners: [], handle: createLearningEntry({ environment,
    administratorToken: await resolveCredential(root, 'control'), client }) };
  const { credentialRef, ...connection } = database;
  const admin = { ...connection, password: await resolveCredential(root, credentialRef) };
  const opened: OwnedStorage[] = [];
  const owners: RecoveryOwner[] = [];
  try {
    async function owner(unit: 'space-course' | 'learning-data' | 'model-connection', migrations: typeof spaceMigrations) {
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
      if (await exists(join(root, 'credentials', ref))) binding = JSON.parse(await resolveCredential(root, ref)) as StorageBinding;
      else {
        const passwordRef = `owner-${descriptor.serviceId}`;
        if (!await exists(join(root, 'credentials', passwordRef))) await storeCredential(root, passwordRef, randomBytes(32).toString('base64url'));
        binding = await provisionStorage({ admin, owner: { environmentId: environment.environmentId, serviceId: descriptor.serviceId },
          password: await resolveCredential(root, passwordRef), migrations });
        await storeCredential(root, ref, JSON.stringify(binding));
      }
      if (binding.owner.environmentId !== environment.environmentId || binding.owner.serviceId !== descriptor.serviceId) throw new Error('Business owner identity mismatch.');
      const storage = await openStorage({ binding, backend, migrations });
      opened.push(storage);
      return { storage, binding, backend, migrations };
    }
    const space = await owner('space-course', spaceCourseMigrations);
    const data = await owner('learning-data', learningMigrations);
    const model = await owner('model-connection', modelMigrations);
    const spaces = createSpaces(space.storage, { credentialNamespace: environment.installationId });
    const models = await createModelGateway(model.storage, { authorize: spaces.authorize, dispatcher: {
      id: JSON.stringify([hostname(), process.pid, await processIdentity(process.pid)]),
      async hasEnded(id) {
        const [host, pid, birth] = JSON.parse(id) as [string, number, string];
        if (host !== hostname() || !Number.isSafeInteger(pid) || pid < 1) return false;
        if (!alive(pid)) return true;
        const current = await processIdentity(pid);
        return current !== null && current !== birth;
      },
    } });
    const courses = createCourses(space.storage, spaces);
    const learning = createLearningData(data.storage, spaces, courses, actions);
    for (const [module, validate] of [[space, async () => { await spaces.validate(); await courses.validate(); }],
      [data, learning.validate], [model, models.validate]] as const) {
      const recoveryOwner = createStorageRecoveryOwner({ storage: module.storage, binding: module.binding, migrations: module.migrations,
        resources: configuration.resources, resourceRoots: [join(root, 'learning-resources', module === space ? 'space-course' : module === data ? 'learning-data' : 'model-connection')],
        validateService: validate });
      const participant = recoveryOwner.participant;
      owners.push(module === data ? { ...recoveryOwner, participant: { ...participant,
        async closeDispatch() { learning.intents.closeDispatch(); await participant.closeDispatch(); },
        async drain() { await learning.intents.drain(); await participant.drain(); },
        async resume() { await participant.resume(); learning.intents.resume(); },
      } } : module === model ? { ...recoveryOwner, participant: { ...participant,
        async closeWrites() { models.closeWrites(); await models.checks.drain(); await participant.closeWrites(); await participant.closeDispatch(); },
        async closeDispatch() { models.checks.closeDispatch(); },
        async drain() { await models.checks.drain(); await participant.drain(); },
        async resume() { await participant.resume(); models.resume(); },
      } } : recoveryOwner);
    }
    const localTarget = { ...data.storage.owner, version: 1 as const };
    const schoolClient = environment.profile === 'school' ? undefined : createSchoolClient(root, environment, {
      target: localTarget, create: (authority, courseAuthority) => createLearningData(data.storage, authority, courseAuthority, actions) });
    return { owners, capabilities: { 'learning.authority': createLearningAuthority(spaces, courses) }, handle: createLearningEntry({ environment, spaces, learning, courses, models, client: schoolClient,
      target: { ...data.storage.owner, version: 1 }, administratorToken: await resolveCredential(root, 'control') }) };
  } catch (error) { await Promise.allSettled(opened.map(storage => storage.close())); throw error; }
}

/** Both real owners register native restore targets and validate only their own domain facts. */
export function createLearningRecoveryTargets(options: {
  root: string; environment: RuntimeEnvironment; resources: RuntimeResources;
  admin(): Promise<DatabaseConnection | null>;
}) {
  return (['space-course', 'learning-data', 'model-connection'] as const).map(unit => {
    const descriptors = options.environment.services.filter(service => service.unit === unit);
    if (unit === 'model-connection' && descriptors.length === 0) return null; // Pre-WP06 backups have no model facts to restore.
    if (descriptors.length !== 1) throw new RecoveryError('missing-business-owner');
    const descriptor = descriptors[0]!;
    const resourceRoot = join(options.root, 'learning-resources', unit);
    return createStorageRecoveryTarget({ owner: { environmentId: options.environment.environmentId, serviceId: descriptor.serviceId },
      admin: async () => { const value = await options.admin(); if (!value) throw new RecoveryError('target-database-required'); return value; },
      resources: options.resources, backend: createFileBackend({ id: unit, root: resourceRoot }), resourceRoots: [resourceRoot],
      migrations: unit === 'space-course' ? spaceCourseMigrations : unit === 'model-connection' ? modelMigrations : learningMigrations,
      validateService: async storage => {
        if (unit === 'learning-data') return validateLearningData(storage);
        if (unit === 'model-connection') return (await createModelGateway(storage, { authorize: async () => {} })).validate();
        const spaces = createSpaces(storage);
        await spaces.validate();
        await createCourses(storage, spaces).validate();
      } });
  }).filter((target): target is NonNullable<typeof target> => target !== null);
}
