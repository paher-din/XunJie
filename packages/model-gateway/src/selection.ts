import { z } from 'zod';
import { modelDeviceBindingSchema, deviceModelChoiceSchema, deviceRawChoiceSchema } from './device-choices.js';
import { createHash } from 'node:crypto';
import { StorageError, type OwnedStorage } from '@xunjie/storage';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import { modelGrantInputSchema, modelGrantSchema, revokeModelGrantSchema, selectModelSchema, modelSelectionSchema, modelSelectionSourceSchema, modelAttemptSchema } from '@xunjie/contracts/model-connections';
import type { ModelAttempt, ModelConnection, ModelCheckPolicy } from '@xunjie/contracts/model-connections';

export const selectionMigrations = [{ version: 5, name: 'explicit-model-use-and-selection', sql: `
  CREATE TABLE model_use_grants(id uuid PRIMARY KEY,owner_scope text NOT NULL,recipient_scope text NOT NULL,body jsonb NOT NULL);
  CREATE INDEX model_grant_recipient ON model_use_grants(recipient_scope);
  CREATE TABLE model_selections(scope text PRIMARY KEY,body jsonb NOT NULL);
` }];
export const modelScopeOf = (identity: SpaceIdentity) => [identity.environmentId, identity.spaceId, identity.principalId].join('.');
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const personalPolicy: ModelCheckPolicy = { checksAllowed: true, maxChecksPerHour: 6, maxOutputTokens: 2048, timeoutMs: 30000 };
type School = { kind: 'school'; connection: ModelConnection; policy: ModelCheckPolicy };
type Personal = { kind: 'personal'; connection: ModelConnection; policy: ModelCheckPolicy; origin: 'self' | 'device' | 'grant'; grantId?: string | undefined };
type Source = z.infer<typeof selectModelSchema>['source'];
const savedSelectionSchema = selectModelSchema.omit({ requestId: true, expectedVersion: true }).extend({
  version: z.number().int().nonnegative(), device: modelDeviceBindingSchema.optional() });
export function createModelSelections(storage: OwnedStorage, owner: {
  authorize(identity: SpaceIdentity): Promise<void>;
  school(identity: SpaceIdentity): Promise<School | null>;
  connection(scope: string, connectionId: string): Promise<ModelConnection>;
  list(identity: SpaceIdentity): Promise<ModelConnection[]>;
  deviceOwner?(identity: SpaceIdentity): Promise<SpaceIdentity | null>;
  assertWritable(): void;
}) {
  let deviceRevoker: ((identity: SpaceIdentity, id: string, value: unknown) => Promise<unknown>) | undefined;
  let deviceGranter: ((identity: SpaceIdentity, value: unknown) => Promise<unknown>) | undefined;
  async function grant(id: string) {
    const { rows: [row] } = await storage.read('SELECT body FROM model_use_grants WHERE id=$1', [id]);
    if (!row) throw new StorageError('forbidden');
    return modelGrantSchema.parse(row.body);
  }
  async function resolve(identity: SpaceIdentity, source?: Source) {
    if (!source || source.kind === 'school') {
      const choice = await owner.school(identity);
      if (!choice || source && choice.connection.connectionId !== source.connectionId) return null;
      return { choice, source: { kind: 'school' as const, ownerScope: 'school:' + identity.environmentId + ':' + identity.spaceId,
        feeSource: 'school:' + identity.environmentId + ':' + identity.spaceId } };
    }
    if (!source.grantId) {
      const actor = source.owner === 'device' ? await owner.deviceOwner?.(identity) : identity;
      if (!actor) throw new StorageError('forbidden');
      await owner.authorize(actor);
      const ownerScope = modelScopeOf(actor), connection = await owner.connection(ownerScope, source.connectionId);
      return { choice: { kind: 'personal' as const, connection, policy: personalPolicy, origin: source.owner ?? 'self' },
        source: { kind: 'personal' as const, ownerScope, feeSource: ownerScope } };
    }
    const authorization = await grant(source.grantId);
    if (modelScopeOf(authorization.recipient) !== modelScopeOf(identity) || authorization.connectionId !== source.connectionId) throw new StorageError('forbidden');
    if (!authorization.active) throw new StorageError('forbidden');
    await owner.authorize(authorization.owner);
    const ownerScope = modelScopeOf(authorization.owner);
    const connection = await owner.connection(ownerScope, authorization.connectionId);
    return { choice: { kind: 'personal' as const, connection, policy: personalPolicy, origin: 'grant' as const, grantId: authorization.grantId },
      source: { kind: 'personal' as const, ownerScope, feeSource: ownerScope, grantId: authorization.grantId, grantVersion: authorization.version } };
  }
  async function current(identity: SpaceIdentity) {
    const { rows: [row] } = await storage.read('SELECT body FROM model_selections WHERE scope=$1', [modelScopeOf(identity)]);
    return row ? savedSelectionSchema.parse(row.body) : undefined;
  }
  async function deviceChoice(identity: SpaceIdentity, source: Source, binding: z.infer<typeof modelDeviceBindingSchema>) {
    if (source.kind !== 'personal') throw new StorageError('corrupt');
    if (!source.grantId) {
      const { rows: [row] } = await storage.read('SELECT body FROM model_device_connection_choices WHERE scope=$1 AND connection_id=$2 AND binding_version=$3',
        [modelScopeOf(identity), source.connectionId, binding.version]);
      if (!row) throw new StorageError('forbidden');
      const item = deviceRawChoiceSchema.parse(row.body);
      if (!item.active || fingerprint(item.binding) !== fingerprint(binding)) throw new StorageError('forbidden');
      return item.choice;
    }
    const { rows: [row] } = await storage.read('SELECT body FROM model_device_choices WHERE scope=$1 AND grant_id=$2 AND binding_version=$3',
      [modelScopeOf(identity), source.grantId, binding.version]);
    if (!row) throw new StorageError('forbidden');
    const item = deviceModelChoiceSchema.parse(row.body);
    await assertDeviceGrantActive(identity, source.grantId);
    if (fingerprint(item.binding) !== fingerprint(binding) || !item.active || item.choice.connection.connectionId !== source.connectionId) throw new StorageError('forbidden');
    return item.choice;
  }
  /** Trusted owner receipt import. Metadata never grants local SDK access or changes the Root pointer. */
  async function importDeviceChoices(identity: SpaceIdentity, value: z.infer<typeof modelDeviceBindingSchema>, projection: unknown, operationId: string) {
    owner.assertWritable(); await owner.authorize(identity);
    const binding = modelDeviceBindingSchema.parse(value), selection = modelSelectionSchema.parse(projection), scope = modelScopeOf(identity);
    const { rows: [record] } = await storage.read('SELECT body FROM model_member_devices WHERE scope=$1 AND version=$2', [scope, binding.version]);
    if (!record || fingerprint(modelDeviceBindingSchema.parse(record.body)) !== fingerprint(binding)) throw new StorageError('forbidden');
    const { rows: [refresh] } = await storage.read('SELECT ordinal FROM model_paired_requests WHERE scope=$1 AND id=$2', [scope, z.uuid().parse(operationId)]);
    if (!refresh) throw new StorageError('missing');
    const choices = selection.options.filter((item): item is Personal & { grantId: string } => item.kind === 'personal' && !!item.grantId);
    if (new Set(choices.map(choice => choice.grantId)).size !== choices.length) throw new StorageError('identity-conflict');
    await storage.request({ requestId: 'device-choices:' + operationId, fingerprint: fingerprint([scope, binding, selection]) }, async tx => {
      owner.assertWritable();
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['device-choices:' + scope]);
      const { rows: [head] } = await tx.query('SELECT ordinal FROM model_device_choice_heads WHERE scope=$1 AND binding_version=$2', [scope, binding.version]);
      if (head && BigInt(String(head.ordinal)) > BigInt(String(refresh.ordinal))) return null;
      for (const choice of [...choices].sort((a, b) => a.grantId.localeCompare(b.grantId))) {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['model-choice-grant:' + choice.grantId]);
        const { rows } = await tx.query('SELECT id FROM model_use_grants WHERE id=$1', [choice.grantId]);
        if (rows.length) throw new StorageError('identity-conflict');
        const { rows: previous } = await tx.query('SELECT body FROM model_device_choices WHERE scope=$1 AND grant_id=$2', [scope, choice.grantId]);
        for (const row of previous) if (fingerprint(deviceModelChoiceSchema.parse(row.body).binding.owner) !== fingerprint(binding.owner)) throw new StorageError('identity-conflict');
        const { rows: [old] } = await tx.query('SELECT body FROM model_device_choices WHERE scope=$1 AND grant_id=$2 AND binding_version=$3',
          [scope, choice.grantId, binding.version]);
        if (old && deviceModelChoiceSchema.parse(old.body).choice.connection.connectionId !== choice.connection.connectionId)
          throw new StorageError('identity-conflict');
      }
      await tx.query("UPDATE model_device_connection_choices SET body=jsonb_set(body,'{active}','false') WHERE scope=$1 AND binding_version=$2", [scope, binding.version]);
      for (const choice of selection.options) if (choice.kind === 'personal' && !choice.grantId && ['self', 'device'].includes(choice.origin)) {
        await tx.query(`INSERT INTO model_device_connection_choices VALUES($1,$2,$3,$4) ON CONFLICT(scope,binding_version,connection_id) DO UPDATE SET body=EXCLUDED.body`,
          [scope, binding.version, choice.connection.connectionId, { binding, ownerKind: choice.origin, choice: { ...choice, origin: 'device' }, active: true }]);
      }
      await tx.query("UPDATE model_device_choices SET body=jsonb_set(body,'{active}','false') WHERE scope=$1 AND binding_version=$2", [scope, binding.version]);
      for (const choice of choices) await tx.query(`INSERT INTO model_device_choices VALUES($1,$2,$3,$4)
        ON CONFLICT(scope,grant_id,binding_version) DO UPDATE SET body=EXCLUDED.body`,
        [scope, choice.grantId, binding.version, { binding, choice: { ...choice, origin: 'device' }, active: true }]);
      await tx.query(`INSERT INTO model_device_choice_heads VALUES($1,$2,$3) ON CONFLICT(scope,binding_version) DO UPDATE SET ordinal=EXCLUDED.ordinal`,
        [scope, binding.version, refresh.ordinal]);
      return null;
    });
  }
  async function read(identity: SpaceIdentity, deviceOwner?: SpaceIdentity) {
    await owner.authorize(identity);
    deviceOwner ??= await owner.deviceOwner?.(identity) ?? undefined;
    const saved = await current(identity);
    const options: (School | Personal)[] = [];
    const school = await owner.school(identity); if (school) options.push(school);
    for (const [actor, origin] of [[identity, 'self'], ...(deviceOwner && modelScopeOf(deviceOwner) !== modelScopeOf(identity) ? [[deviceOwner, 'device']] : [])] as [SpaceIdentity, 'self' | 'device'][]) {
      await owner.authorize(actor);
      for (const connection of await owner.list(actor)) options.push({ kind: 'personal', connection, policy: personalPolicy, origin });
    }
    const { rows } = await storage.read('SELECT body FROM model_use_grants WHERE recipient_scope=$1', [modelScopeOf(identity)]);
    for (const row of rows) {
      const item = modelGrantSchema.parse(row.body);
      if (!item.active) continue;
      try { const value = await resolve(identity, { kind: 'personal', grantId: item.grantId, connectionId: item.connectionId }); if (value) options.push(value.choice); }
      catch (error) { if (!(error instanceof StorageError) || !['forbidden', 'missing'].includes(error.code)) throw error; }
    }
    const { rows: devices } = await storage.read(`SELECT body FROM model_device_choices c WHERE scope=$1 AND NOT EXISTS
      (SELECT 1 FROM model_device_grant_revocations r WHERE r.scope=c.scope AND r.grant_id=c.grant_id) AND binding_version=
      (SELECT max(version) FROM model_member_devices WHERE scope=$1)`, [modelScopeOf(identity)]);
    const { rows: raw } = await storage.read(`SELECT body FROM model_device_connection_choices WHERE scope=$1 AND binding_version=
      (SELECT max(version) FROM model_member_devices WHERE scope=$1)`, [modelScopeOf(identity)]);
    for (const row of raw) { const item = deviceRawChoiceSchema.parse(row.body); if (item.active) options.push(item.choice); }
    for (const row of devices) { const item = deviceModelChoiceSchema.parse(row.body); if (item.active) options.push(item.choice); }
    try {
      const resolved = saved?.device ? { choice: await deviceChoice(identity, saved.source, saved.device) } : await resolve(identity, saved?.source);
      return { version: saved?.version ?? 0, selected: resolved?.choice ?? null, options };
    } catch (error) {
      if (!(error instanceof StorageError) || !['forbidden', 'missing'].includes(error.code)) throw error;
      return { version: saved?.version ?? 0, selected: null, options, unavailableReason: saved?.source.kind === 'personal' && !saved.source.grantId ? 'connection-unavailable' : 'grant-revoked' };
    }
  }
  async function save(identity: SpaceIdentity, value: unknown) {
    owner.assertWritable(); await owner.authorize(identity);
    const input = selectModelSchema.parse(value), scope = modelScopeOf(identity), hash = fingerprint({ scope, input });
    const prior = await storage.receipt('model-selection:' + input.requestId, hash); if (prior) return prior.result;
    let device: z.infer<typeof modelDeviceBindingSchema> | undefined;
    if (input.source.kind === 'personal' && input.source.grantId) {
      const { rows: [row] } = await storage.read(`SELECT body FROM model_device_choices WHERE scope=$1 AND grant_id=$2 AND binding_version=
        (SELECT max(version) FROM model_member_devices WHERE scope=$1)`, [scope, input.source.grantId]);
      if (row) device = deviceModelChoiceSchema.parse(row.body).binding;
    }
    if (input.source.kind === 'personal' && !input.source.grantId && input.source.owner === 'device') {
      const { rows: [row] } = await storage.read(`SELECT body FROM model_device_connection_choices WHERE scope=$1 AND connection_id=$2 AND binding_version=
        (SELECT max(version) FROM model_member_devices WHERE scope=$1)`, [scope, input.source.connectionId]);
      if (row) device = deviceRawChoiceSchema.parse(row.body).binding;
    }
    const resolved = device ? { choice: await deviceChoice(identity, input.source, device) } : await resolve(identity, input.source);
    if (!resolved || !resolved.choice.connection.enabled) throw new StorageError('unavailable');
    const projection = await read(identity);
    return (await storage.request({ requestId: 'model-selection:' + input.requestId, fingerprint: hash }, async tx => {
      if ('source' in resolved) {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['model-config:' + resolved.source.ownerScope]);
        if (resolved.source.kind === 'school') {
          // The installed client's school model may live entirely at the remote owner.
          const currentSchool = await owner.school(identity);
          if (!currentSchool || currentSchool.connection.connectionId !== input.source.connectionId
            || !currentSchool.connection.enabled) throw new StorageError('unavailable');
          resolved.choice = currentSchool;
        } else {
          const currentConnection = await owner.connection(resolved.source.ownerScope, resolved.choice.connection.connectionId);
          if (!currentConnection.enabled) throw new StorageError('unavailable');
          resolved.choice = { ...resolved.choice, connection: currentConnection };
        }
      }
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['model-selection:' + scope]);
      const { rows: [row] } = await tx.query('SELECT body FROM model_selections WHERE scope=$1 FOR UPDATE', [scope]);
      const old = row?.body as { version: number } | undefined;
      if ((old?.version ?? 0) !== input.expectedVersion) throw new StorageError('conflict');
      const saved = { version: input.expectedVersion + 1, source: input.source, ...(device ? { device } : {}) };
      await tx.query('INSERT INTO model_selections VALUES($1,$2) ON CONFLICT(scope) DO UPDATE SET body=EXCLUDED.body', [scope, saved]);
      return { ...projection, version: saved.version, selected: resolved.choice };
    })).result;
  }
  async function createGrant(identity: SpaceIdentity, grantOwner: SpaceIdentity, value: unknown) {
    owner.assertWritable(); await owner.authorize(identity); await owner.authorize(grantOwner);
    const input = modelGrantInputSchema.parse(value), ownerScope = modelScopeOf(grantOwner), recipientScope = modelScopeOf(identity);
    await owner.connection(ownerScope, input.connectionId);
    const saved = modelGrantSchema.parse({ grantId: input.grantId, connectionId: input.connectionId, owner: grantOwner, recipient: identity, version: 1, active: true });
    return (await storage.request({ requestId: 'model-grant:' + input.requestId, fingerprint: fingerprint({ ownerScope, recipientScope, input }) }, async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['model-choice-grant:' + input.grantId]);
      const { rows: existing } = await tx.query('SELECT 1 FROM model_device_choices WHERE grant_id=$1 UNION ALL SELECT 1 FROM model_device_grant_creations WHERE grant_id=$1 LIMIT 1', [input.grantId]);
      if (existing.length) throw new StorageError('identity-conflict');
      await tx.query('INSERT INTO model_use_grants VALUES($1,$2,$3,$4)', [input.grantId, ownerScope, recipientScope, saved]); return saved;
    })).result;
  }
  async function revoke(identity: SpaceIdentity, id: string, value: unknown) {
    owner.assertWritable(); await owner.authorize(identity);
    const input = revokeModelGrantSchema.parse(value), scope = modelScopeOf(identity);
    const { rows: [local] } = await storage.read('SELECT body FROM model_use_grants WHERE id=$1', [z.uuid().parse(id)]);
    if (!local) {
      const { rows } = await storage.read('SELECT 1 FROM model_device_choices WHERE scope=$1 AND grant_id=$2 LIMIT 1', [scope, id]);
      if (!rows.length) throw new StorageError('forbidden');
      if (!deviceRevoker) throw new StorageError('unavailable');
      return deviceRevoker(identity, id, input);
    }
    const authorization = modelGrantSchema.parse(local.body);
    if (![modelScopeOf(authorization.owner), modelScopeOf(authorization.recipient)].includes(scope)) throw new StorageError('forbidden');
    return (await storage.request({ requestId: 'model-grant-revoke:' + input.requestId, fingerprint: fingerprint({ scope, id, input }) }, async tx => {
      const { rows: [row] } = await tx.query('SELECT body FROM model_use_grants WHERE id=$1 FOR UPDATE', [id]);
      const previous = modelGrantSchema.parse(row!.body);
      if (previous.version !== input.expectedVersion) throw new StorageError('conflict');
      const next = { ...previous, active: false, version: previous.version + 1 };
      await tx.query('UPDATE model_use_grants SET body=$2 WHERE id=$1', [id, next]); return next;
    })).result;
  }
  async function readGrant(identity: SpaceIdentity, id: string) {
    await owner.authorize(identity);
    const value = await grant(z.uuid().parse(id)), scope = modelScopeOf(identity);
    if (![modelScopeOf(value.owner), modelScopeOf(value.recipient)].includes(scope)) throw new StorageError('forbidden');
    return value;
  }
  /** Trusted checks for an original task, independent of the current selection pointer. */
  async function assertDeviceGrantActive(identity: SpaceIdentity, id: string) {
    const { rows } = await storage.read('SELECT 1 FROM model_device_grant_revocations WHERE scope=$1 AND grant_id=$2', [modelScopeOf(identity), z.uuid().parse(id)]);
    if (rows.length) throw new StorageError('forbidden');
  }
  async function schoolSnapshot(identity: SpaceIdentity) {
    await owner.authorize(identity);
    const fixed = await resolve(identity);
    if (!fixed) throw new StorageError('unavailable');
    return fixed;
  }
  async function snapshot(identity: SpaceIdentity, expectedVersion: number) {
    await owner.authorize(identity);
    const saved = await current(identity);
    if ((saved?.version ?? 0) !== expectedVersion) throw new StorageError('conflict');
    if (saved?.device) throw new StorageError('unavailable'); // The paired adapter resolves at the actual credential owner.
    const result = await resolve(identity, saved?.source);
    if (!result) throw new StorageError('unavailable'); return result;
  }
  async function pin(identity: SpaceIdentity, pinId: string, expectedVersion: number) {
    owner.assertWritable(); await owner.authorize(identity);
    const scope = modelScopeOf(identity);
    const { rows: [prior] } = await storage.read('SELECT * FROM model_selection_pins WHERE id=$1 AND scope=$2', [pinId, scope]);
    if (prior) {
      if (Number(prior.selection_version) !== expectedVersion) throw new StorageError('conflict');
      return pinned(identity, pinId, expectedVersion);
    }
    const selected = await current(identity);
    if ((selected?.version ?? 0) !== expectedVersion) throw new StorageError('conflict');
    if (selected?.device) throw new StorageError('unavailable');
    const source = selected?.source ?? { kind: 'school' as const, connectionId: (await snapshot(identity, expectedVersion)).choice.connection.connectionId };
    return pinSource(identity, pinId, expectedVersion, source);
  }
  /** The authenticated paired adapter supplies a fixed Root source, never the device's current pointer. */
  async function pinSource(identity: SpaceIdentity, pinId: string, expectedVersion: number, value: unknown) {
    owner.assertWritable(); await owner.authorize(identity);
    z.uuid().parse(pinId); z.number().int().nonnegative().parse(expectedVersion);
    const scope = modelScopeOf(identity), source = modelSelectionSourceSchema.parse(value);
    const { rows: [prior] } = await storage.read('SELECT * FROM model_selection_pins WHERE id=$1 AND scope=$2', [pinId, scope]);
    if (prior) {
      if (Number(prior.selection_version) !== expectedVersion || fingerprint(modelSelectionSourceSchema.parse(prior.source)) !== fingerprint(source))
        throw new StorageError('identity-conflict');
      return pinned(identity, pinId, expectedVersion);
    }
    const fixed = await resolveChoice(identity, source);
    await storage.request({ requestId: 'model-selection-pin:' + pinId, fingerprint: fingerprint([scope, pinId, expectedVersion]) }, async tx => {
      await tx.query('INSERT INTO model_selection_pins(id,scope,selection_version,source,body) VALUES($1,$2,$3,$4,$5)',
        [pinId, scope, expectedVersion, source, fixed]);
      return null;
    });
    return pinned(identity, pinId, expectedVersion);
  }
  async function pinned(identity: SpaceIdentity, pinId: string, expectedVersion: number) {
    await owner.authorize(identity);
    const { rows: [row] } = await storage.read('SELECT * FROM model_selection_pins WHERE id=$1 AND scope=$2', [pinId, modelScopeOf(identity)]);
    if (!row || Number(row.selection_version) !== expectedVersion) throw new StorageError('forbidden');
    const fixed = row.body as Awaited<ReturnType<typeof snapshot>>;
    const live = await resolve(identity, row.source as Source);
    if (!live || live.source.kind !== fixed.source.kind || live.source.ownerScope !== fixed.source.ownerScope
      || live.source.feeSource !== fixed.source.feeSource
      || ('grantId' in live.source ? live.source.grantId : undefined) !== ('grantId' in fixed.source ? fixed.source.grantId : undefined)
      || ('grantVersion' in live.source ? live.source.grantVersion : undefined) !== ('grantVersion' in fixed.source ? fixed.source.grantVersion : undefined)) throw new StorageError('forbidden');
    if (live.choice.connection.connectionId !== fixed.choice.connection.connectionId
      || live.choice.connection.version !== fixed.choice.connection.version
      || live.choice.connection.routeId !== fixed.choice.connection.routeId) throw new StorageError('conflict');
    return fixed;
  }
  async function destination(identity: SpaceIdentity, expectedVersion?: number) {
    await owner.authorize(identity);
    const saved = await current(identity);
    if (expectedVersion !== undefined && (saved?.version ?? 0) !== expectedVersion) throw new StorageError('conflict');
    if (saved?.device) {
      await deviceChoice(identity, saved.source, saved.device);
      let source = saved.source;
      if (source.kind === 'personal' && !source.grantId) {
        const { rows: [row] } = await storage.read('SELECT body FROM model_device_connection_choices WHERE scope=$1 AND connection_id=$2 AND binding_version=$3',
          [modelScopeOf(identity), source.connectionId, saved.device.version]);
        if (!row) throw new StorageError('forbidden');
        source = { ...source, owner: deviceRawChoiceSchema.parse(row.body).ownerKind };
      }
      return { binding: saved.device, source };
    }
    return null;
  }
  async function resolveChoice(identity: SpaceIdentity, value: unknown) {
    await owner.authorize(identity);
    const fixed = await resolve(identity, modelSelectionSourceSchema.parse(value));
    if (!fixed) throw new StorageError('unavailable');
    return fixed;
  }
  async function authorizeAttempt(identity: SpaceIdentity, source: ModelAttempt['source'], connectionId: string) {
    if (!source?.grantId) {
      if (source?.kind === 'personal' && source.ownerScope !== modelScopeOf(identity)) {
        const actor = await owner.deviceOwner?.(identity);
        if (!actor || modelScopeOf(actor) !== source.ownerScope) throw new StorageError('forbidden');
        await owner.authorize(actor);
      }
      return;
    }
    const authorization = await grant(source.grantId);
    if (!authorization.active || authorization.connectionId !== connectionId || authorization.version !== source.grantVersion || modelScopeOf(authorization.recipient) !== modelScopeOf(identity)
      || modelScopeOf(authorization.owner) !== source.ownerScope) throw new StorageError('forbidden');
    await owner.authorize(authorization.owner);
  }
  async function validate() {
    const { rows: grants } = await storage.read('SELECT * FROM model_use_grants');
    for (const row of grants) {
      const item = modelGrantSchema.parse(row.body);
      if (item.grantId !== row.id || modelScopeOf(item.owner) !== row.owner_scope || modelScopeOf(item.recipient) !== row.recipient_scope) throw new StorageError('corrupt');
      await owner.connection(modelScopeOf(item.owner), item.connectionId);
    }
    const { rows: selections } = await storage.read('SELECT * FROM model_selections');
    for (const row of selections) {
      const item = savedSelectionSchema.parse(row.body);
      if (item.device) {
        if (item.source.kind !== 'personal') throw new StorageError('corrupt');
        const legacy = !!item.source.grantId;
        const { rows: [choice] } = await storage.read(legacy
          ? 'SELECT body FROM model_device_choices WHERE scope=$1 AND grant_id=$2 AND binding_version=$3'
          : 'SELECT body FROM model_device_connection_choices WHERE scope=$1 AND connection_id=$2 AND binding_version=$3',
          [row.scope, legacy ? item.source.grantId : item.source.connectionId, item.device.version]);
        const parsed = choice && (legacy ? deviceModelChoiceSchema : deviceRawChoiceSchema).parse(choice.body);
        if (!parsed || fingerprint(parsed.binding) !== fingerprint(item.device)
          || parsed.choice.connection.connectionId !== item.source.connectionId) throw new StorageError('corrupt');
        continue;
      }
      if (item.source.kind === 'personal' && !item.source.grantId && item.source.owner === 'self')
        await owner.connection(String(row.scope), item.source.connectionId);
      if (item.source.kind === 'personal' && item.source.grantId) {
        const authorization = await grant(item.source.grantId);
        if (authorization.connectionId !== item.source.connectionId || modelScopeOf(authorization.recipient) !== row.scope) throw new StorageError('corrupt');
      }
    }
    const { rows: pins } = await storage.read('SELECT * FROM model_selection_pins');
    for (const row of pins) {
      const fixed = row.body as Awaited<ReturnType<typeof snapshot>>;
      modelSelectionSchema.parse({ version: Number(row.selection_version), selected: fixed.choice, options: [] });
      const source = modelAttemptSchema.shape.source.unwrap().parse(fixed.source);
      const original = selectModelSchema.shape.source.parse(row.source);
      if (source.kind !== original.kind || fixed.choice.connection.connectionId !== original.connectionId) throw new StorageError('corrupt');
      if (original.kind === 'personal' && !original.grantId) {
        if (source.grantId || source.grantVersion || source.feeSource !== source.ownerScope
          || original.owner === 'self' && source.ownerScope !== row.scope) throw new StorageError('corrupt');
        await owner.connection(source.ownerScope, original.connectionId);
      }
      if (original.kind === 'personal' && original.grantId) {
        const authorization = await grant(original.grantId);
        if (modelScopeOf(authorization.recipient) !== row.scope || authorization.connectionId !== original.connectionId
          || source.grantId !== original.grantId || source.ownerScope !== modelScopeOf(authorization.owner)) throw new StorageError('corrupt');
      }
    }
    const { rows: heads } = await storage.read(`SELECT h.scope,h.binding_version,r.body FROM model_device_choice_heads h
      LEFT JOIN model_paired_requests r ON r.ordinal=h.ordinal AND r.scope=h.scope`);
    for (const head of heads) {
      const value = z.object({ request: z.object({ operation: z.literal('selection.read') }), destination: z.object({ kind: z.literal('device'), binding: modelDeviceBindingSchema }) }).safeParse(head.body);
      if (!value.success || value.data.destination.binding.version !== head.binding_version) throw new StorageError('corrupt');
    }
    const { rows: raw } = await storage.read('SELECT scope,binding_version,connection_id,body FROM model_device_connection_choices');
    for (const row of raw) {
      const item = deviceRawChoiceSchema.parse(row.body);
      const { rows: [binding] } = await storage.read('SELECT body FROM model_member_devices WHERE scope=$1 AND version=$2', [row.scope, row.binding_version]);
      if (item.choice.connection.connectionId !== row.connection_id || item.choice.grantId || item.binding.version !== row.binding_version
        || !binding || fingerprint(modelDeviceBindingSchema.parse(binding.body)) !== fingerprint(item.binding)) throw new StorageError('corrupt');
    }
    const { rows: choices } = await storage.read('SELECT scope,grant_id,binding_version,body FROM model_device_choices');
    for (const row of choices) {
      const item = deviceModelChoiceSchema.parse(row.body);
      const { rows: [binding] } = await storage.read('SELECT body FROM model_member_devices WHERE scope=$1 AND version=$2', [row.scope, row.binding_version]);
      if (item.choice.grantId !== row.grant_id || item.binding.version !== row.binding_version || !binding
        || fingerprint(modelDeviceBindingSchema.parse(binding.body)) !== fingerprint(item.binding)) throw new StorageError('corrupt');
    }
  }
  return { read, save, createGrant, revoke, readGrant, assertDeviceGrantActive,
    createDeviceGrant(identity: SpaceIdentity, value: unknown) { if (!deviceGranter) throw new StorageError('unavailable'); return deviceGranter(identity, value); },
    onDeviceGrant(handler: NonNullable<typeof deviceGranter>) { deviceGranter = handler; },
    onDeviceRevoke(handler: NonNullable<typeof deviceRevoker>) { deviceRevoker = handler; }, snapshot, pin, pinSource, pinned, schoolSnapshot, resolveChoice, destination, importDeviceChoices, authorizeAttempt, validate };
}
