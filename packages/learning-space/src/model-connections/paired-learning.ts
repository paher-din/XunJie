import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { StorageError, type Migration, type OwnedStorage } from '@xunjie/storage';
import { storageOwnerSchema } from '@xunjie/contracts/storage';
import { createPairedModelGrants, validatePairedModelGrants } from './paired-grants.js';
import { modelSelectionSchema } from '@xunjie/contracts/model-connections';
import { spaceIdentitySchema, type SpaceIdentity } from '@xunjie/contracts/spaces';
import { modelDeviceIdentitySchema as deviceSchema, modelDeviceBindingSchema } from './device-choices.js';
export { modelDeviceBindingSchema } from './device-choices.js';
import { modelScopeOf } from './selection.js';
import { modelOriginRecoveryOperationSchema, modelOriginSuccessionSchema } from './origins.js';
import { modelDeviceTaskSchema, modelRunAuthoritySchema } from './device-tasks.js';
import { learningModelRequestSchema, learningModelReplySchema, parseLearningModelResult,
  createLearningModelService, type LearningModelRequest, type LearningModelReply } from './service.js';
import type { createModelGateway } from './index.js';

type Models = Awaited<ReturnType<typeof createModelGateway>>;
export const pairedLearningMigration: Migration = { version: 12, name: 'independent-member-model-devices', sql: `
  CREATE TABLE model_member_devices(scope text NOT NULL,version integer NOT NULL,body jsonb NOT NULL,PRIMARY KEY(scope,version));
  CREATE TABLE model_paired_requests(id uuid PRIMARY KEY,scope text NOT NULL,body jsonb NOT NULL);
  CREATE TABLE model_paired_routes(scope text NOT NULL,kind text NOT NULL,id uuid NOT NULL,body jsonb NOT NULL,PRIMARY KEY(scope,kind,id));
` };
export type ModelDeviceBinding = z.infer<typeof modelDeviceBindingSchema>;
export const bindModelDeviceSchema = deviceSchema.extend({ requestId: z.uuid(), expectedVersion: z.number().int().nonnegative() });
export const pairedModelOriginSchema = z.object({ operationId: z.uuid(), service: storageOwnerSchema, installationId: z.uuid(), grantId: z.uuid(), activityId: z.uuid().optional(),
  authority: modelRunAuthoritySchema.optional(), segmentId: z.uuid().optional() }).strict().refine(
  origin => !origin.activityId || !origin.authority || origin.activityId === origin.authority.activityId, { message: 'Activity authority mismatch' });
export type PairedModelOrigin = z.infer<typeof pairedModelOriginSchema>;
const sourceSchema = z.object({ sourceEnvironmentId: z.uuid(), sourceServiceId: z.uuid(), sourceInstallationId: z.uuid(),
  grantId: z.uuid(), connectionId: z.uuid() }).strict();
export interface PairedLearningOptions {
  authorize(identity: SpaceIdentity): Promise<void>;
  /** Host verifies WP01 grant, installation and school member connection. No learningTarget rebinding. */
  authorizeBinding(identity: SpaceIdentity, binding: ModelDeviceBinding | z.infer<typeof bindModelDeviceSchema>): Promise<void>;
  /** Host verifies authenticated Agent service/installation/runtime grant and real lease authority for receive/dispatch. */
  authorizeOrigin(identity: SpaceIdentity, origin: PairedModelOrigin, request: LearningModelRequest): Promise<void>;
  /** Trusted host returns its fenced recipient chain only after current member/WP01 authorization. */
  recipientSuccessions?(identity: SpaceIdentity, original: ModelDeviceBinding, current: ModelDeviceBinding): Promise<z.infer<typeof modelOriginSuccessionSchema>[] | null>;
  assertWritable(): void;
  timeoutMs?: number;
  pollIntervalMs?: number;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)).digest('hex');
const idFor = (value: unknown) => { const d = hash(value); return `${d.slice(0,8)}-${d.slice(8,12)}-4${d.slice(13,16)}-a${d.slice(17,20)}-${d.slice(20,32)}`; };
const destinationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('device'), binding: modelDeviceBindingSchema }).strict(),
  z.object({ kind: z.literal('school') }).strict(),
]);
type Destination = z.infer<typeof destinationSchema>;
type RouteKind = 'segment' | 'attempt' | 'image' | 'result' | 'pin';
const recipientRecoverySchema = z.object({ requestId: z.uuid(), binding: modelDeviceBindingSchema,
  successions: z.array(modelOriginSuccessionSchema).min(1).max(64) }).strict();
const savedRequestSchema = z.object({ kind: z.literal('device-options').optional(), identity: spaceIdentitySchema, request: learningModelRequestSchema,
  origin: pairedModelOriginSchema, destination: destinationSchema, forwarded: learningModelRequestSchema, localReply: learningModelReplySchema.optional(),
  recipientRecovery: recipientRecoverySchema.optional() }).strict();
type SavedRequest = z.infer<typeof savedRequestSchema>;
function recipientChain(original: ModelDeviceBinding, current: ModelDeviceBinding, value: unknown) {
  const facts = recipientRecoverySchema.shape.successions.parse(value);
  if (hash(original.owner) !== hash(current.owner) || original.installationId === current.installationId) throw new StorageError('identity-conflict');
  let installation = original.installationId;
  const seen = new Set([installation]);
  for (const fact of facts) {
    if (fact.sourceEnvironmentId !== original.owner.environmentId || fact.sourceServiceId !== original.owner.serviceId
      || fact.sourceInstallationId !== installation || seen.has(fact.targetInstallationId)) throw new StorageError('identity-conflict');
    installation = fact.targetInstallationId; seen.add(installation);
  }
  if (installation !== current.installationId) throw new StorageError('identity-conflict');
  return facts;
}
function validateRecipientRequest(saved: SavedRequest, original: SavedRequest) {
  const recovery = saved.recipientRecovery;
  if (!recovery || original.recipientRecovery || original.kind || original.localReply || saved.kind || saved.localReply
    || saved.destination.kind !== 'device' || original.destination.kind !== 'device'
    || !modelOriginRecoveryOperationSchema.safeParse(saved.request.operation).success
    || recovery.requestId !== original.origin.operationId || saved.origin.operationId === recovery.requestId
    || hash(saved.identity) !== hash(original.identity) || hash(saved.request) !== hash(original.request)
    || hash(saved.forwarded) !== hash(original.forwarded) || hash(saved.destination) !== hash(original.destination)
    || hash({ ...saved.origin, operationId: recovery.requestId }) !== hash(original.origin)) throw new StorageError('corrupt');
  recipientChain(original.destination.binding, recovery.binding, recovery.successions);
}

/** School hub outbox. All device work is consumed by its authenticated active poller.
 * Each invocation has its own operationId: retry it unchanged after an unavailable result;
 * use a new id to refresh read/progress. images.upload may carry origin.segmentId to keep
 * tool-produced images at an existing segment's owner after model selection changes.
 * Foreign-owner result/image references must be explicitly imported as portable content.
 */
export function createPairedLearningModels(storage: OwnedStorage, models: Models, options: PairedLearningOptions) {
  const local = createLearningModelService(models, options.authorize);
  const timeoutMs = options.timeoutMs ?? 5000, interval = options.pollIntervalMs ?? 25;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(interval) || interval < 1) throw new StorageError('invalid');
  const grants = createPairedModelGrants(storage, models, { ...options, timeoutMs, pollIntervalMs: interval });
  models.selection.onDeviceGrant(grants.create);
  models.selection.onDeviceRevoke(grants.revoke);
  async function readBinding(identity: SpaceIdentity): Promise<ModelDeviceBinding | null> {
    await options.authorize(identity);
    if (spaceIdentitySchema.parse(identity).kind !== 'school') throw new StorageError('forbidden');
    const { rows: [row] } = await storage.read('SELECT body FROM model_member_devices WHERE scope=$1 ORDER BY version DESC LIMIT 1', [modelScopeOf(identity)]);
    return row ? modelDeviceBindingSchema.parse(row.body) : null;
  }
  async function bind(identity: SpaceIdentity, value: z.input<typeof bindModelDeviceSchema>) {
    options.assertWritable(); await options.authorize(identity);
    const actor = spaceIdentitySchema.parse(identity), input = bindModelDeviceSchema.parse(value);
    if (actor.kind !== 'school') throw new StorageError('forbidden');
    await options.authorizeBinding(actor, input);
    const { requestId, expectedVersion, ...device } = input, scope = modelScopeOf(actor);
    const receipt = await storage.request({ requestId: 'member-model-device:' + requestId, fingerprint: hash([scope, input]) }, async tx => {
      options.assertWritable();
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['member-model-device:' + scope]);
      const { rows: [head] } = await tx.query('SELECT version FROM model_member_devices WHERE scope=$1 ORDER BY version DESC LIMIT 1', [scope]);
      if (Number(head?.version ?? 0) !== expectedVersion) throw new StorageError('conflict');
      const body = { ...device, version: expectedVersion + 1 };
      await tx.query('INSERT INTO model_member_devices VALUES($1,$2,$3)', [scope, body.version, body]);
      return body;
    });
    return modelDeviceBindingSchema.parse(receipt.result);
  }
  async function currentRecipient(identity: SpaceIdentity, saved: SavedRequest): Promise<SavedRequest> {
    if (saved.destination.kind !== 'device' || !modelOriginRecoveryOperationSchema.safeParse(saved.request.operation).success
      || !options.recipientSuccessions) return saved;
    const original = saved.destination.binding;
    const { rows } = await storage.read('SELECT body FROM model_member_devices WHERE scope=$1 ORDER BY version DESC', [modelScopeOf(identity)]);
    for (const row of rows) {
      const binding = modelDeviceBindingSchema.parse(row.body);
      if (hash(binding.owner) !== hash(original.owner) || binding.installationId === original.installationId) continue;
      let facts;
      try {
        facts = await options.recipientSuccessions(identity, original, binding);
        if (!facts) continue;
        await options.authorizeBinding(identity, binding);
      } catch (error) {
        // A revoked historical candidate cannot hide a different currently authorized successor.
        if (error instanceof StorageError && error.code === 'forbidden') continue;
        throw error;
      }
      const successions = recipientChain(original, binding, facts);
      const taskId = idFor(['paired-recipient-recovery', saved.origin.operationId, binding]);
      const recovered = savedRequestSchema.parse({ ...saved, origin: { ...saved.origin, operationId: taskId },
        recipientRecovery: { requestId: saved.origin.operationId, binding, successions } });
      validateRecipientRequest(recovered, saved);
      const accepted = await storage.request({ requestId: 'paired-recipient-recovery:' + taskId, fingerprint: hash(recovered) }, async tx => {
        options.assertWritable();
        // Original request, route, authorization and any uncertain old task remain immutable.
        // This separate access task cannot dispatch; cancellation still names the original attempt.
        await tx.query('INSERT INTO model_paired_requests VALUES($1,$2,$3)', [taskId, modelScopeOf(identity), recovered]);
        return recovered;
      });
      return savedRequestSchema.parse(accepted.result);
    }
    return saved;
  }
  async function authorizeRecipient(identity: SpaceIdentity, saved: SavedRequest) {
    if (saved.destination.kind !== 'device') throw new StorageError('corrupt');
    const recovery = saved.recipientRecovery;
    if (!recovery) { await options.authorizeBinding(identity, saved.destination.binding); return saved.destination.binding; }
    const { rows: [row] } = await storage.read('SELECT body FROM model_paired_requests WHERE id=$1 AND scope=$2',
      [recovery.requestId, modelScopeOf(identity)]);
    if (!row) throw new StorageError('corrupt');
    validateRecipientRequest(saved, savedRequestSchema.parse(row.body));
    const facts = await options.recipientSuccessions?.(identity, saved.destination.binding, recovery.binding);
    if (!facts || hash(recipientChain(saved.destination.binding, recovery.binding, facts)) !== hash(recovery.successions))
      throw new StorageError('forbidden');
    await options.authorizeBinding(identity, recovery.binding);
    return recovery.binding;
  }
  async function bindingForSource(identity: SpaceIdentity, value: z.input<typeof sourceSchema>) {
    await options.authorize(identity); const source = sourceSchema.parse(value);
    const { rows } = await storage.read('SELECT body FROM model_member_devices WHERE scope=$1 ORDER BY version DESC', [modelScopeOf(identity)]);
    for (const row of rows) {
      const binding = modelDeviceBindingSchema.parse(row.body);
      if (binding.owner.environmentId !== source.sourceEnvironmentId || binding.owner.serviceId !== source.sourceServiceId
        || binding.installationId !== source.sourceInstallationId || binding.grantId !== source.grantId || binding.connectionId !== source.connectionId) continue;
      await options.authorizeBinding(identity, binding);
      return binding;
    }
    throw new StorageError('forbidden');
  }
  async function authorizePoll(identity: SpaceIdentity, value: z.input<typeof sourceSchema>) {
    const binding = await bindingForSource(identity, value);
    return { grantId: binding.grantId, installationId: binding.installationId };
  }
  /** A model device publishes public grant metadata under its own authenticated source.
   * This is not an Agent task, has no synthetic Run, and can never obtain an SDK permit.
   */
  async function publishChoices(identity: SpaceIdentity, source: z.input<typeof sourceSchema>, value: unknown) {
    options.assertWritable();
    const binding = await bindingForSource(identity, source);
    const input = z.object({ requestId: z.uuid(), projection: modelSelectionSchema }).strict().parse(value);
    const origin = { operationId: input.requestId, service: binding.owner, installationId: binding.installationId, grantId: binding.grantId };
    const request = learningModelRequestSchema.parse({ identity, operation: 'selection.read', args: [] });
    const body = savedRequestSchema.parse({ kind: 'device-options', identity, origin, request, forwarded: request,
      destination: { kind: 'device', binding }, localReply: { ok: true, value: input.projection } });
    await storage.request({ requestId: 'paired-device-options:' + input.requestId, fingerprint: hash(body) }, async tx => {
      options.assertWritable(); await tx.query('INSERT INTO model_paired_requests VALUES($1,$2,$3)', [input.requestId, modelScopeOf(identity), body]);
      return null;
    });
    await models.selection.importDeviceChoices(identity, binding, input.projection, input.requestId);
    return { published: true as const };
  }
  /** Recheck the original Agent grant/lease from the school outbox, including after task completion.
   * The device supplies only its authenticated poll binding and task id, never a new origin.
   */
  async function authorizeTask(identity: SpaceIdentity, value: { grantId: string; installationId: string }, taskId: string) {
    await options.authorize(identity);
    const binding = z.object({ grantId: z.uuid(), installationId: z.uuid() }).strict().parse(value);
    const id = z.uuid().parse(taskId);
    const { rows: [row] } = await storage.read('SELECT body FROM model_paired_requests WHERE id=$1 AND scope=$2', [id, modelScopeOf(identity)]);
    if (!row) throw new StorageError('missing');
    const original = savedRequestSchema.parse(row.body);
    if (original.origin.operationId !== id || modelScopeOf(original.identity) !== modelScopeOf(identity)
      || hash(original.identity) !== hash(original.request.identity) || hash(original.identity) !== hash(original.forwarded.identity)
      || original.request.operation !== original.forwarded.operation && !(original.request.operation === 'selection.snapshot' && original.forwarded.operation === 'selection.resolve')
        && !(original.request.operation === 'selection.pin' && original.forwarded.operation === 'selection.pinSource')) throw new StorageError('corrupt');
    if (original.kind === 'device-options' || identity.kind !== 'school' || original.destination.kind !== 'device') throw new StorageError('forbidden');
    const recipient = await authorizeRecipient(identity, original);
    if (recipient.grantId !== binding.grantId || recipient.installationId !== binding.installationId) throw new StorageError('forbidden');
    const { task } = await models.deviceTasks.read(identity, binding, id);
    const expectedOrigin = { service: original.origin.service, installationId: original.origin.installationId,
      grantId: original.origin.grantId, identity: original.identity, recoveryGeneration: binding.installationId,
      ...(original.origin.activityId ? { activityId: original.origin.activityId } : {}),
      ...(original.origin.authority ? { authority: original.origin.authority } : {}) };
    if (task.operation !== 'learning' || task.formatVersion !== 2
      || hash(task.request) !== hash(original.forwarded) || hash(task.origin) !== hash(expectedOrigin)) throw new StorageError('corrupt');
    await assertRequestGrant(identity, original.request, original.destination);
    await options.authorizeOrigin(identity, original.origin, original.request);
    return { authorized: true as const };
  }
  async function route(identity: SpaceIdentity, kind: RouteKind, id: string): Promise<Destination> {
    const { rows: [row] } = await storage.read('SELECT body FROM model_paired_routes WHERE scope=$1 AND kind=$2 AND id=$3', [modelScopeOf(identity), kind, z.uuid().parse(id)]);
    if (!row) throw new StorageError('missing');
    return destinationSchema.parse(row.body);
  }
  async function fixRoute(identity: SpaceIdentity, kind: RouteKind, id: string, destination: Destination) {
    const scope = modelScopeOf(identity);
    await storage.request({ requestId: `paired-model-route:${scope}:${kind}:${id}`, fingerprint: hash(destination) }, async tx => {
      options.assertWritable();
      await tx.query('INSERT INTO model_paired_routes VALUES($1,$2,$3,$4)', [scope, kind, id, destination]);
      return destination;
    });
  }
  async function fixGrant(identity: SpaceIdentity, kind: 'segment' | 'attempt' | 'pin', id: string, grantId: string, version: number) {
    const scope = modelScopeOf(identity);
    await storage.request({ requestId: 'paired-grant:' + hash([scope, kind, id]), fingerprint: hash([grantId, version]) }, async tx => {
      options.assertWritable();
      await tx.query('INSERT INTO model_paired_grants VALUES($1,$2,$3,$4,$5)', [scope, kind, id, grantId, version]); return null;
    });
  }
  async function grantRoute(identity: SpaceIdentity, kind: 'segment' | 'attempt' | 'pin', id: string) {
    const { rows: [row] } = await storage.read('SELECT grant_id,binding_version FROM model_paired_grants WHERE scope=$1 AND kind=$2 AND id=$3', [modelScopeOf(identity), kind, id]);
    return row;
  }
  async function assertRequestGrant(identity: SpaceIdentity, request: LearningModelRequest, destination: Destination) {
    if (destination.kind !== 'device') return;
    const operation = request.operation;
    if (!['segments.create', 'checks.receive', 'checks.dispatch', 'selection.pin', 'selection.pinned'].includes(operation)) return;
    const kind = operation.startsWith('selection.') ? 'pin' : operation === 'checks.dispatch' ? 'attempt' : 'segment';
    const id = operation.startsWith('selection.') || operation === 'checks.dispatch' ? String(request.args[0])
      : String((request.args[0] as { segmentId: string }).segmentId);
    const fixed = await grantRoute(identity, kind, id);
    if (fixed) {
      if (fixed.binding_version !== destination.binding.version) throw new StorageError('corrupt');
      await models.selection.assertDeviceGrantActive(identity, String(fixed.grant_id));
    } else {
      // Pre-pointer segments without a recoverable source remain readable, but cannot
      // bypass an explicit revocation at their original device using an unknown grant.
      const { rows } = await storage.read(`SELECT 1 FROM model_device_grant_revocations WHERE scope=$1
        AND (body->'binding'->>'version')::integer=$2 LIMIT 1`, [modelScopeOf(identity), destination.binding.version]);
      if (rows.length) throw new StorageError('forbidden');
    }
  }
  async function current(identity: SpaceIdentity): Promise<Destination> {
    const selected = await models.selection.destination(identity);
    return selected ? { kind: 'device', binding: selected.binding } : { kind: 'school' };
  }
  async function request(value: LearningModelRequest, context: PairedModelOrigin): Promise<LearningModelReply> {
    const input = learningModelRequestSchema.parse(value), origin = pairedModelOriginSchema.parse(context), { identity, operation, args } = input;
    options.assertWritable(); await options.authorize(identity);
    if (identity.kind !== 'school') throw new StorageError('forbidden');
    if ((operation === 'checks.receive' || operation === 'checks.dispatch') && !origin.authority) throw new StorageError('forbidden');
    await options.authorizeOrigin(identity, origin, input);
    const scope = modelScopeOf(identity), fingerprint = hash([input, origin]);
    const { rows: [existing] } = await storage.read('SELECT scope,body FROM model_paired_requests WHERE id=$1', [origin.operationId]);
    let saved: z.infer<typeof savedRequestSchema>;
    if (existing) {
      saved = savedRequestSchema.parse(existing.body);
      if (saved.kind || saved.recipientRecovery || existing.scope !== scope || hash([saved.request, saved.origin]) !== fingerprint) throw new StorageError('identity-conflict');
    } else {
      let destination: Destination;
      let forwarded = input;
      if (operation === 'segments.create') {
        const segment = args[0] as { segmentId: string; source: Record<string, unknown> };
        // Selection is resolved once, before the segment's owner is fixed.
        if ('school' in segment.source) destination = { kind: 'school' };
        else if ('selected' in segment.source) {
          const selectionId = hash([origin.operationId, 'selection']).slice(0, 32);
          const operationId = `${selectionId.slice(0,8)}-${selectionId.slice(8,12)}-4${selectionId.slice(13,16)}-a${selectionId.slice(17,20)}-${selectionId.slice(20)}`;
          const pinId = segment.source.pinId;
          const snapshot = await request({ operation: pinId ? 'selection.pinned' : 'selection.snapshot', identity,
            args: pinId ? [pinId, segment.source.selectionVersion] : [segment.source.selectionVersion] }, { ...origin, operationId });
          if (!snapshot.ok) return snapshot;
          const choice = (snapshot.value as { choice: { kind: string; connection: { connectionId: string; version: number } } }).choice;
          const { rows: [selectionRequest] } = await storage.read('SELECT body FROM model_paired_requests WHERE id=$1 AND scope=$2', [operationId, scope]);
          if (!selectionRequest) throw new StorageError('corrupt');
          destination = choice.kind === 'school' ? { kind: 'school' } : savedRequestSchema.parse(selectionRequest.body).destination;
          if (destination.kind === 'device' && !pinId) {
            const original = savedRequestSchema.parse(selectionRequest.body);
            if (original.forwarded.operation !== 'selection.resolve') throw new StorageError('corrupt');
            forwarded = { ...input, args: [segment, original.forwarded.args[0]] };
          } else if (destination.kind === 'device' && pinId) {
            const grant = await grantRoute(identity, 'pin', String(pinId));
            if (!grant) throw new StorageError('corrupt');
            await fixGrant(identity, 'segment', segment.segmentId, String(grant.grant_id), Number(grant.binding_version));
          }
          if (choice.kind === 'school') forwarded = { ...input, args: [{ ...segment, source: { school: { connectionId: choice.connection.connectionId, version: choice.connection.version } } }] };
        } else {
          // An explicit connection id is local to Root. Device learning uses its approved grant.
          destination = { kind: 'school' };
        }
        const history = args[0] as { previousSegmentId?: string; portable: { resultRef?: string }[] };
        if (history.previousSegmentId && hash(await route(identity, 'segment', history.previousSegmentId)) !== hash(destination)) {
          const predecessor = await request({ operation: 'segments.read', identity, args: [history.previousSegmentId] },
            { ...origin, operationId: idFor([origin.operationId, 'predecessor']) });
          if (!predecessor.ok) return predecessor;
          const previous = predecessor.value as { closed: boolean; pending: boolean; pendingTools: unknown[] };
          if (previous.pending || previous.pendingTools.length) throw new StorageError('resource-busy');
          if (!previous.closed) throw new StorageError('conflict');
          const value = { ...(forwarded.args[0] as Record<string, unknown>) };
          delete value.previousSegmentId;
          forwarded = { ...forwarded, args: [value, ...forwarded.args.slice(1)] };
        }
        for (const entry of history.portable) if (entry.resultRef && hash(await route(identity, 'result', entry.resultRef)) !== hash(destination)) throw new StorageError('conflict');
        await fixRoute(identity, 'segment', segment.segmentId, destination);
        const source = forwarded.args[1] as { kind?: string; grantId?: string } | undefined;
        if (destination.kind === 'device' && source?.kind === 'personal' && source.grantId)
          await fixGrant(identity, 'segment', segment.segmentId, source.grantId, destination.binding.version);
      } else if (operation.startsWith('segments.')) {
        destination = await route(identity, 'segment', args[0] as string);
        if (operation === 'segments.settle') for (const result of (args[1] as { results: { images: { imageId: string }[] }[] }).results)
          for (const image of result.images) if (hash(await route(identity, 'image', image.imageId)) !== hash(destination)) throw new StorageError('conflict');
      }
      else if (operation === 'checks.receive') {
        const attempt = args[0] as { segmentId: string; attemptId: string; input: { images: { imageId: string }[]; toolResults: { images: { imageId: string }[] }[] } };
        destination = await route(identity, 'segment', attempt.segmentId);
        for (const image of [...attempt.input.images, ...attempt.input.toolResults.flatMap(result => result.images)])
          if (hash(await route(identity, 'image', image.imageId)) !== hash(destination)) throw new StorageError('conflict');
        await fixRoute(identity, 'attempt', attempt.attemptId, destination);
        const fixed = await grantRoute(identity, 'segment', attempt.segmentId);
        if (destination.kind === 'device' && fixed) await fixGrant(identity, 'attempt', attempt.attemptId, String(fixed.grant_id), Number(fixed.binding_version));
      } else if (operation.startsWith('checks.')) destination = await route(identity, 'attempt', args[0] as string);
      else if (operation === 'results.retain') destination = await route(identity, 'result', (args[0] as { resultRef: string }).resultRef);
      else if (operation === 'images.read') destination = await route(identity, 'image', (args[0] as { imageId: string }).imageId);
      else if (operation === 'images.upload') {
        const source = (args[0] as { source?: { imageId: string } }).source;
        destination = origin.segmentId ? await route(identity, 'segment', origin.segmentId) : source ? await route(identity, 'image', source.imageId) : await current(identity);
        if (source && hash(await route(identity, 'image', source.imageId)) !== hash(destination)) throw new StorageError('conflict');
        await fixRoute(identity, 'image', (args[0] as { imageId: string }).imageId, destination);
      } else if (operation === 'selection.read') {
        // Refresh only public options. The device's own selected pointer is never imported.
        const binding = await readBinding(identity);
        destination = binding ? { kind: 'device', binding } : { kind: 'school' };
      } else if (operation === 'selection.pin') {
        const selected = await models.selection.destination(identity, args[1] as number);
        destination = selected ? { kind: 'device', binding: selected.binding } : { kind: 'school' };
        await fixRoute(identity, 'pin', args[0] as string, destination);
        if (selected) {
          if (selected.source.kind !== 'personal') throw new StorageError('corrupt');
          await fixGrant(identity, 'pin', args[0] as string, selected.source.grantId, selected.binding.version);
          forwarded = { ...input, operation: 'selection.pinSource', args: [args[0], args[1], selected.source] };
        }
      } else if (operation === 'selection.pinned') {
        destination = await route(identity, 'pin', args[0] as string);
      } else if (operation === 'selection.pinSource') {
        throw new StorageError('forbidden'); // Only the Root adapter constructs this fixed-source device request.
      } else if (operation === 'selection.snapshot') {
        const selected = await models.selection.destination(identity, args[0] as number);
        destination = selected ? { kind: 'device', binding: selected.binding } : { kind: 'school' };
        if (selected) forwarded = { ...input, operation: 'selection.resolve', args: [selected.source] };
      } else destination = { kind: 'school' };
      const body = { identity, request: input, origin, destination, forwarded };
      const accepted = await storage.request({ requestId: 'paired-model-request:' + origin.operationId, fingerprint }, async tx => {
        options.assertWritable(); await tx.query('INSERT INTO model_paired_requests VALUES($1,$2,$3)', [origin.operationId, scope, body]); return body;
      });
      saved = savedRequestSchema.parse(accepted.result);
    }
    await assertRequestGrant(identity, input, saved.destination);
    let reply: LearningModelReply;
    if (saved.destination.kind === 'school') {
      if (operation === 'selection.pinned') reply = await local(saved.forwarded);
      else if (saved.localReply) reply = saved.localReply;
      else {
        const value = await local(saved.forwarded);
        const receipt = await storage.request({ requestId: 'paired-model-local-reply:' + origin.operationId, fingerprint }, async tx => {
          options.assertWritable();
          const { rows: [row] } = await tx.query('SELECT body FROM model_paired_requests WHERE id=$1 AND scope=$2 FOR UPDATE', [origin.operationId, scope]);
          if (!row) throw new StorageError('corrupt');
          const original = savedRequestSchema.parse(row.body);
          if (original.localReply) return original.localReply;
          await tx.query('UPDATE model_paired_requests SET body=$2 WHERE id=$1', [origin.operationId, { ...original, localReply: value }]);
          return value;
        });
        reply = learningModelReplySchema.parse(receipt.result);
      }
    }
    else {
      try {
      const delivery = await currentRecipient(identity, saved);
      const binding = await authorizeRecipient(identity, delivery);
      const check = operation.startsWith('checks.');
      const attemptId = check ? operation === 'checks.receive' ? (args[0] as { attemptId: string }).attemptId : args[0] as string : undefined;
      const task = modelDeviceTaskSchema.parse({ taskId: delivery.origin.operationId, operation: 'learning', formatVersion: 2,
        ...(attemptId ? { attemptId } : {}), request: saved.forwarded,
        origin: { service: origin.service, installationId: origin.installationId, grantId: origin.grantId, identity, recoveryGeneration: binding.installationId,
          ...(origin.activityId ? { activityId: origin.activityId } : {}),
          ...(origin.authority ? { authority: origin.authority } : {}) } });
      const taskBinding = { grantId: binding.grantId, installationId: binding.installationId };
      await models.deviceTasks.enqueue(identity, taskBinding, task);
      const until = Date.now() + timeoutMs;
      while (true) {
        await options.authorize(identity); await authorizeRecipient(identity, delivery);
        const record = await models.deviceTasks.read(identity, taskBinding, delivery.origin.operationId);
        if (record.receipt) { reply = learningModelReplySchema.parse(record.receipt); break; }
        if (Date.now() >= until) throw new StorageError('unavailable');
        await new Promise(resolve => setTimeout(resolve, interval));
      }
      if (operation === 'selection.read' && !reply.ok
        && ['unavailable', 'forbidden', 'missing', 'stale-generation'].includes(reply.code)) throw new StorageError(reply.code);
      } catch (error) {
        // An unselected or replacement device is optional metadata. Its outage cannot
        // disable an explicit Root choice or redirect a pointer fixed to an older device.
        if (operation !== 'selection.read' || !(error instanceof StorageError)
          || !['unavailable', 'forbidden', 'missing', 'stale-generation'].includes(error.code)) throw error;
        await options.authorizeOrigin(identity, origin, input);
        const selected = await models.selection.destination(identity);
        const view = await models.selection.read(identity);
        if (!view.selected || selected && hash(selected.binding) === hash(saved.destination.binding)) throw error;
        return { ok: true, value: view };
      }
    }
    if (reply.ok) {
      parseLearningModelResult(operation, reply.value);
      if (operation.startsWith('checks.') && ['checks.receive', 'checks.read', 'checks.dispatch', 'checks.cancel'].includes(operation)) {
        const resultRef = (reply.value as { resultRef: string | null }).resultRef;
        if (resultRef) await fixRoute(identity, 'result', resultRef, saved.destination);
      }
      if (operation === 'selection.read' && saved.destination.kind === 'device') {
        await models.selection.importDeviceChoices(identity, saved.destination.binding, reply.value, origin.operationId);
        reply = { ok: true, value: await models.selection.read(identity) };
      }
    }
    if (operation === 'selection.pin' && reply.ok) return request({ operation: 'selection.pinned', identity, args },
      { ...origin, operationId: randomUUID() });
    return reply;
  }
  async function validate() { await validatePairedLearning(storage); await models.deviceTasks.validate(); }
  return { bind, readBinding, authorizePoll, publishChoices, authorizeTask, enqueueGrantChanges: grants.enqueue, authorizeGrantTask: grants.authorizeTask, request, validate };
}

export async function validatePairedLearning(storage: OwnedStorage) {
  await validatePairedModelGrants(storage);
  const { rows: grants } = await storage.read(`SELECT g.*,r.body FROM model_paired_grants g LEFT JOIN model_paired_routes r USING(scope,kind,id)`);
  for (const row of grants) {
    const destination = destinationSchema.safeParse(row.body);
    if (!destination.success || destination.data.kind !== 'device' || destination.data.binding.version !== row.binding_version) throw new StorageError('corrupt');
  }
  const { rows: bindings } = await storage.read('SELECT version,body FROM model_member_devices');
  for (const row of bindings) if (modelDeviceBindingSchema.parse(row.body).version !== row.version) throw new StorageError('corrupt');
  async function validateDestination(scope: string, destination: Destination) {
    if (destination.kind !== 'device') return;
    const { rows: [row] } = await storage.read('SELECT body FROM model_member_devices WHERE scope=$1 AND version=$2', [scope, destination.binding.version]);
    if (!row || hash(modelDeviceBindingSchema.parse(row.body)) !== hash(destination.binding)) throw new StorageError('corrupt');
  }
  const { rows: requests } = await storage.read('SELECT id,scope,body FROM model_paired_requests');
  for (const row of requests) {
    const saved = savedRequestSchema.parse(row.body);
    await validateDestination(row.scope as string, saved.destination);
    if (saved.recipientRecovery) {
      await validateDestination(row.scope as string, { kind: 'device', binding: saved.recipientRecovery.binding });
      const { rows: [original] } = await storage.read('SELECT body FROM model_paired_requests WHERE id=$1 AND scope=$2',
        [saved.recipientRecovery.requestId, row.scope]);
      if (!original) throw new StorageError('corrupt');
      try { validateRecipientRequest(saved, savedRequestSchema.parse(original.body)); }
      catch { throw new StorageError('corrupt'); }
    }
    if (saved.localReply?.ok) parseLearningModelResult(saved.request.operation, saved.localReply.value);
    if (saved.origin.operationId !== row.id || modelScopeOf(saved.identity) !== row.scope || modelScopeOf(saved.request.identity) !== row.scope) throw new StorageError('corrupt');
  }
  const { rows: routes } = await storage.read('SELECT scope,kind,id,body FROM model_paired_routes');
  for (const row of routes) { z.enum(['segment', 'attempt', 'image', 'result', 'pin']).parse(row.kind); z.uuid().parse(row.id); await validateDestination(row.scope as string, destinationSchema.parse(row.body)); }

}
