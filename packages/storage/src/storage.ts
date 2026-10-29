import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { resourceReferenceSchema } from '@xunjie/contracts/storage';
import type { ResourceReference, StorageManifest, StorageReceipt } from '@xunjie/contracts/storage';
import type { BlobBackend } from './blobs.js';
import { BlobError } from './blobs.js';
import { identifier, migrationPlan, verifyBinding } from './database.js';
import { StorageError, storageFailure } from './errors.js';
import type { Migration, OwnedStorage, OwnedTransaction, QueryResult, StorageBinding } from './types.js';

const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const resourceHeader = (reference: ResourceReference): Buffer => Buffer.from(`xunjie-resource/1 ${reference.locator.writeId}\n`, 'ascii');
const validId = (value: string): void => { if (!value || value.length > 200) throw new StorageError('invalid'); };
const json = (value: unknown): string => {
  try { const result = JSON.stringify(value); if (result !== undefined) return result; } catch { /* reject non-JSON values */ }
  throw new StorageError('invalid');
};
function receipt(row: Record<string, unknown>): StorageReceipt {
  return { requestId: row.request_id as string, result: row.result, committedAt: (row.committed_at as Date).toISOString() };
}
function blobFailure(error: unknown): StorageError {
  return error instanceof BlobError ? new StorageError(error.code) : storageFailure(error);
}

export async function openStorage(options: {
  binding: StorageBinding; migrations: readonly Migration[]; backend: BlobBackend; drainTimeoutMs?: number; queryTimeoutMs?: number;
}): Promise<OwnedStorage> {
  const binding = structuredClone(options.binding);
  const migrations = options.migrations.map(item => ({ ...item }));
  const sourceBackend = options.backend;
  const backend: BlobBackend = { id: sourceBackend.id, put: sourceBackend.put.bind(sourceBackend),
    get: sourceBackend.get.bind(sourceBackend), remove: sourceBackend.remove.bind(sourceBackend) };
  if (options.queryTimeoutMs !== undefined && (!Number.isInteger(options.queryTimeoutMs) || options.queryTimeoutMs < 1)) throw new StorageError('invalid');
  const pool = new pg.Pool({ ...binding.connection, max: 8, connectionTimeoutMillis: 5000,
    statement_timeout: 5000, query_timeout: options.queryTimeoutMs ?? 5000,
    idle_in_transaction_session_timeout: 10_000, application_name: 'xunjie-owned-storage' });
  pool.on('error', () => {});
  const observed = new WeakSet<pg.PoolClient>();
  function observe(client: pg.PoolClient) {
    if (!observed.has(client)) {
      // pg emits a connection-level event as well as rejecting an active query.
      // The query path below classifies the outcome and destroys the broken client.
      client.on('error', () => {});
      observed.add(client);
    }
    return client;
  }
  let generation: string;
  let initial: pg.PoolClient | undefined;
  try {
    initial = observe(await pool.connect());
    generation = await verifyBinding(initial, binding, migrations);
  } catch (error) {
    initial?.release(); await pool.end(); throw storageFailure(error);
  }
  initial.release();
  const owner = { ...binding.owner };
  const schemaVersion = migrationPlan(migrations).length;
  const ownerPrefix = `${owner.environmentId}/${owner.serviceId}`;

  async function transaction<T>(action: (client: pg.PoolClient) => Promise<T>, config: { write?: boolean; requestId?: string; readOnly?: boolean } = {}): Promise<T> {
    let client: pg.PoolClient | undefined;
    let committing = false;
    let broken = false;
    try {
      client = observe(await pool.connect());
      await client.query(config.readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
      await client.query(`SET LOCAL search_path TO ${identifier(binding.schema)}, pg_catalog`);
      if (config.write) {
        const { rows: [state] } = await client.query('SELECT generation,writes_open FROM _storage_identity FOR SHARE');
        if (state.generation !== generation) throw new StorageError('stale-generation');
        if (!state.writes_open) throw new StorageError('maintenance');
      }
      const result = await action(client);
      committing = true;
      await client.query('COMMIT');
      return result;
    } catch (error) {
      broken = committing;
      if (!committing) await client?.query('ROLLBACK').catch(() => { broken = true; });
      const known = storageFailure(error);
      if (committing && known.code === 'unavailable' && config.requestId) throw new StorageError('commit-unknown', config.requestId);
      throw known;
    } finally { client?.release(broken); }
  }

  async function resourceRow(client: pg.PoolClient, resourceId: string, lock = false) {
    const { rows: [row] } = await client.query(`SELECT reference,state FROM _storage_resources WHERE resource_id=$1${lock ? ' FOR UPDATE' : ''}`, [resourceId]);
    if (!row) throw new StorageError('missing');
    const reference = resourceReferenceSchema.parse(row.reference);
    if (reference.owner.environmentId !== owner.environmentId || reference.owner.serviceId !== owner.serviceId
      || reference.locator.backendId !== backend.id || reference.locator.key !== `${ownerPrefix}/${reference.resourceId}`) throw new StorageError('incompatible');
    return { reference, state: row.state as string };
  }
  function originalBytes(reference: ResourceReference, stored: Uint8Array): Uint8Array {
    const header = resourceHeader(reference);
    if (!Buffer.from(stored.subarray(0,header.length)).equals(header)) throw new StorageError('corrupt');
    const bytes = stored.subarray(header.length);
    if (bytes.byteLength !== reference.byteLength || hash(bytes) !== reference.sha256) throw new StorageError('corrupt');
    return bytes;
  }
  async function verifiedBytes(reference: ResourceReference): Promise<Uint8Array> {
    try {
      return originalBytes(reference, await backend.get(reference.locator.key));
    } catch (error) { throw blobFailure(error); }
  }
  async function getResource(resourceId: string): Promise<ResourceReference> {
    return transaction(async client => {
      const row = await resourceRow(client, resourceId);
      if (row.state !== 'ready') throw new StorageError(row.state === 'deleted' ? 'resource-gone' : 'resource-busy');
      return row.reference;
    }, { readOnly: true });
  }
  async function reconcileUpload(uploadId: string): Promise<ResourceReference> {
    const row = await transaction(client => resourceRow(client, uploadId), { readOnly: true });
    if (row.state === 'deleting' || row.state === 'deleted') throw new StorageError('resource-gone');
    try {
      await verifiedBytes(row.reference);
      await transaction(async client => {
        const current = await resourceRow(client, uploadId, true);
        if (current.state === 'deleting' || current.state === 'deleted') throw new StorageError('resource-gone');
        await client.query("UPDATE _storage_resources SET state='ready',error_code=NULL WHERE resource_id=$1", [uploadId]);
      });
      return row.reference;
    } catch (error) {
      await transaction(async client => {
        // A failed GET does not establish that a previous PUT has finished.
        // Keep admission/drain/GC aware of the unresolved original upload.
        await client.query("UPDATE _storage_resources SET error_code=$2 WHERE resource_id=$1 AND state='uploading'", [uploadId, blobFailure(error).code]);
      }).catch(() => {});
      throw error;
    }
  }
  async function deleteClaim(resourceId: string): Promise<void> {
    const row = await transaction(client => resourceRow(client, resourceId), { readOnly: true });
    if (row.state !== 'deleting') return;
    try { await backend.remove(row.reference.locator.key); } catch (error) { throw blobFailure(error); }
    await transaction(async client => {
      await client.query("UPDATE _storage_resources SET state='deleted',error_code=NULL WHERE resource_id=$1 AND state='deleting'", [resourceId]);
    });
  }

  function txInterface(client: pg.PoolClient, requestId: string): OwnedTransaction {
    return {
      async query<T extends Record<string, unknown>>(sql: string, values: readonly unknown[] = []): Promise<QueryResult<T>> {
        // Domain SQL cannot end/restart the encompassing receipt transaction. Extended
        // protocol also refuses multiple statements, including a hidden trailing COMMIT.
        if (!/^\s*(select|insert|update|delete|with)\b/i.test(sql)) throw new StorageError('invalid');
        const result = await client.query<T>({ text: sql, values: [...values], queryMode: 'extended' } as pg.QueryConfig);
        return { rows: result.rows, rowCount: result.rowCount ?? 0 };
      },
      async reference(referenceId, resourceId) {
        validId(referenceId);
        const row = await resourceRow(client, resourceId, true);
        if (row.state !== 'ready') throw new StorageError(row.state === 'deleted' ? 'resource-gone' : 'resource-busy');
        await client.query(`INSERT INTO _storage_references(reference_id,resource_id) VALUES($1,$2)
          ON CONFLICT(reference_id) DO UPDATE SET resource_id=EXCLUDED.resource_id`, [referenceId, resourceId]);
        return row.reference;
      },
      async unreference(referenceId) {
        validId(referenceId);
        await client.query('DELETE FROM _storage_references WHERE reference_id=$1', [referenceId]);
      },
      async enqueue(intentId, payload) {
        validId(intentId);
        await client.query('INSERT INTO _storage_outbox(intent_id,request_id,payload) VALUES($1,$2,$3)', [intentId, requestId, json(payload)]);
      },
      async completeIntent(intentId) {
        const { rows: [state] } = await client.query('SELECT dispatch_open FROM _storage_identity');
        if (!state.dispatch_open) throw new StorageError('maintenance');
        await client.query('UPDATE _storage_outbox SET completed_at=clock_timestamp() WHERE intent_id=$1 AND completed_at IS NULL', [intentId]);
      },
    };
  }
  async function findReceipt(requestId: string, fingerprint?: string): Promise<StorageReceipt | null> {
    validId(requestId);
    return transaction(async client => {
      const { rows: [row] } = await client.query('SELECT * FROM _storage_requests WHERE request_id=$1', [requestId]);
      if (row && fingerprint !== undefined && row.fingerprint !== fingerprint) throw new StorageError('identity-conflict');
      return row ? receipt(row) : null;
    }, { readOnly: true });
  }
  async function drain() {
    const deadline = Date.now() + (options.drainTimeoutMs ?? 5000);
    for (;;) {
      const { rows } = await transaction(client => client.query("SELECT resource_id,state FROM _storage_resources WHERE state IN ('uploading','deleting')"), { readOnly: true });
      for (const row of rows.filter(row => row.state === 'deleting')) await deleteClaim(row.resource_id);
      if (!rows.length) return;
      if (Date.now() >= deadline) throw new StorageError('resource-busy');
      await delay(25);
    }
  }
  async function validate() {
    await drain();
    const resources = await transaction(async client => {
      await verifyBinding(client, binding, migrations);
      const { rows } = await client.query(`SELECT DISTINCT r.reference,r.state FROM _storage_resources r
        WHERE EXISTS(SELECT 1 FROM _storage_references x WHERE x.resource_id=r.resource_id)
          OR EXISTS(SELECT 1 FROM _storage_pins p WHERE p.resource_id=r.resource_id)`);
      if (rows.some(row => row.state !== 'ready')) throw new StorageError('corrupt');
      return rows.map(row => resourceReferenceSchema.parse(row.reference));
    }, { readOnly: true });
    for (const reference of resources) {
      if (reference.owner.environmentId !== owner.environmentId || reference.owner.serviceId !== owner.serviceId || reference.locator.backendId !== backend.id
        || reference.locator.key !== `${ownerPrefix}/${reference.resourceId}`) throw new StorageError('incompatible');
      await verifiedBytes(reference);
    }
  }

  const storage: OwnedStorage = {
    get owner() { return { ...owner }; },
    get generation() { return generation; },
    async request(input, effect) {
      validId(input.requestId); validId(input.fingerprint);
      // Confirmed retries remain readable while new writes are closed.
      const existing = await transaction(async client => {
        const { rows: [row] } = await client.query('SELECT * FROM _storage_requests WHERE request_id=$1', [input.requestId]);
        if (row && row.fingerprint !== input.fingerprint) throw new StorageError('identity-conflict');
        return row ? receipt(row) : null;
      }, { readOnly: true });
      if (existing) return existing;
      return transaction(async client => {
        const inserted = await client.query('INSERT INTO _storage_requests(request_id,fingerprint) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING request_id', [input.requestId,input.fingerprint]);
        if (!inserted.rowCount) {
          const { rows: [row] } = await client.query('SELECT * FROM _storage_requests WHERE request_id=$1', [input.requestId]);
          if (row.fingerprint !== input.fingerprint) throw new StorageError('identity-conflict');
          return receipt(row);
        }
        const result = await effect(txInterface(client, input.requestId));
        const { rows: [row] } = await client.query(`UPDATE _storage_requests SET result=$2,committed_at=clock_timestamp()
          WHERE request_id=$1 RETURNING *`, [input.requestId,json(result)]);
        return receipt(row);
      }, { write: true, requestId: input.requestId });
    },
    receipt: findReceipt,
    async read<T extends Record<string, unknown>>(sql: string, values: readonly unknown[] = []): Promise<QueryResult<T>> {
      return transaction(async client => {
        const result = await client.query<T>({ text: sql, values: [...values], queryMode: 'extended' } as pg.QueryConfig);
        return { rows: result.rows, rowCount: result.rowCount ?? 0 };
      }, { readOnly: true });
    },
    async pendingIntents() {
      return transaction(async client => {
        const { rows: [state] } = await client.query('SELECT dispatch_open,generation FROM _storage_identity');
        if (!state.dispatch_open) throw new StorageError('maintenance');
        if (state.generation !== generation) throw new StorageError('stale-generation');
        return (await client.query('SELECT intent_id,payload FROM _storage_outbox WHERE completed_at IS NULL ORDER BY intent_id')).rows.map(row => ({ intentId: row.intent_id, payload: row.payload }));
      }, { readOnly: true });
    },
    async stageResource(input) {
      const parsed = resourceReferenceSchema.safeParse({ formatVersion: 1, resourceId: input.uploadId,
        owner, scope: input.scope, sha256: hash(input.bytes), byteLength: input.bytes.byteLength,
        mediaType: input.mediaType, contentVersion: input.contentVersion,
        locator: { backendId: backend.id, key: `${ownerPrefix}/${input.uploadId}`, writeId: randomUUID() } });
      if (!parsed.success) throw new StorageError('invalid');
      const proposed = parsed.data;
      const { reference, action } = await transaction(async client => {
        const inserted = await client.query("INSERT INTO _storage_resources(resource_id,reference,state) VALUES($1,$2,'uploading') ON CONFLICT DO NOTHING RETURNING resource_id", [input.uploadId,json(proposed)]);
        const row = await resourceRow(client, input.uploadId, true);
        // A duplicate supplies the same content identity, but must reuse the
        // original durable write receipt instead of manufacturing a new one.
        const expected = { ...proposed, locator: { ...proposed.locator, writeId: row.reference.locator.writeId } };
        if (json(row.reference) !== json(expected)) throw new StorageError('identity-conflict');
        if (row.state === 'deleting' || row.state === 'deleted') throw new StorageError('resource-gone');
        if (row.state === 'ready') return { reference: row.reference, action: 'ready' };
        // Only the transaction that created the durable identity can issue PUT.
        // A retry observes that one operation, including after a process crash.
        return { reference: row.reference, action: inserted.rowCount ? 'put' : 'observe' };
      }, { write: true });
      if (action === 'ready') { await verifiedBytes(reference); return reference; }
      if (action === 'observe') {
        const deadline = Date.now() + 15_000;
        for (;;) {
          try { return await reconcileUpload(input.uploadId); }
          catch (error) {
            const current = await transaction(client => resourceRow(client, input.uploadId), { readOnly: true });
            if (current.state !== 'uploading' || !['missing','unavailable'].includes(blobFailure(error).code)) throw error;
            if (Date.now() >= deadline) throw new StorageError('upload-unknown');
            await delay(25);
          }
        }
      }
      try {
        // The fresh durable receipt distinguishes this PUT from identical bytes
        // left by any older object. A matching envelope proves that the unique
        // original PUT committed, even if its network acknowledgement was lost.
        await backend.put(reference.locator.key, Buffer.concat([resourceHeader(reference), input.bytes]));
        return await reconcileUpload(input.uploadId);
      } catch (error) {
        // Keep the original identity and locator. The caller can inspect/reconcile
        // an unknown PUT without replaying any upstream model/tool effect.
        const code = blobFailure(error).code;
        // Only the unique original PUT can establish a definitive failure.
        // Connection uncertainty stays unresolved; observers cannot retire it.
        const definitive = ['identity-conflict','forbidden','corrupt','invalid'].includes(code);
        await transaction(async client => { await client.query("UPDATE _storage_resources SET state=CASE WHEN $3 THEN 'failed' ELSE state END,error_code=$2 WHERE resource_id=$1 AND state='uploading'", [input.uploadId,code,definitive]); }).catch(() => {});
        throw blobFailure(error);
      }
    },
    reconcileUpload,
    resource: getResource,
    async readResource(resourceId) { return verifiedBytes(await getResource(resourceId)); },
    async readResourceObject(resourceId) {
      const reference = await getResource(resourceId);
      try {
        const stored = await backend.get(reference.locator.key);
        originalBytes(reference,stored);
        return stored;
      } catch (error) { throw blobFailure(error); }
    },
    async collect(config) {
      const limit = config.limit ?? 100;
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isFinite(config.olderThan.getTime())) throw new StorageError('invalid');
      // Row locks serialize the claim with every reference/pin creation. Once
      // deleting is committed, publication refuses this identity permanently.
      const claims = await transaction(async client => {
        const { rows } = await client.query(`SELECT r.resource_id FROM _storage_resources r
          WHERE r.state IN ('ready','failed','deleting') AND r.created_at<$1
            AND NOT EXISTS(SELECT 1 FROM _storage_references x WHERE x.resource_id=r.resource_id)
            AND NOT EXISTS(SELECT 1 FROM _storage_pins p WHERE p.resource_id=r.resource_id)
          ORDER BY r.resource_id LIMIT $2 FOR UPDATE OF r SKIP LOCKED`, [config.olderThan,limit]);
        const claimed: string[] = [];
        for (const row of rows) {
          // This is a fresh READ COMMITTED statement *after* the object lock.
          // A reference may have committed after candidate selection began.
          const retained = (await client.query(`SELECT 1 FROM _storage_references WHERE resource_id=$1
            UNION ALL SELECT 1 FROM _storage_pins WHERE resource_id=$1 LIMIT 1`, [row.resource_id])).rowCount;
          if (retained) continue;
          await client.query("UPDATE _storage_resources SET state='deleting' WHERE resource_id=$1", [row.resource_id]);
          claimed.push(row.resource_id as string);
        }
        return claimed;
      }, { write: true });
      for (const id of claims) await deleteClaim(id);
      return claims;
    },
    participant() {
      return {
        descriptor: { serviceId: owner.serviceId, schemaVersion: `storage/1;owner/${schemaVersion}`,
          resourceRoots: [backend.id], configurationRefs: [`storage:${owner.environmentId}:${owner.serviceId}`] },
        async closeWrites() {
          await transaction(async client => {
            await client.query('UPDATE _storage_identity SET writes_open=false,generation=generation+1 WHERE writes_open');
          });
        },
        async closeDispatch() { await transaction(async client => { await client.query('UPDATE _storage_identity SET dispatch_open=false'); }); },
        drain,
        validate,
        async resume() {
          await validate();
          generation = await transaction(async client => {
            const { rows: [row] } = await client.query('UPDATE _storage_identity SET writes_open=true,dispatch_open=true RETURNING generation');
            return row.generation as string;
          });
        },
      };
    },
    async snapshot(backupId, consume) {
      validId(backupId);
      await drain();
      const manifest = await transaction(async client => {
        const { rows: [state] } = await client.query('SELECT * FROM _storage_identity FOR UPDATE');
        if (state.writes_open || state.dispatch_open) throw new StorageError('maintenance');
        const existing = (await client.query('SELECT manifest FROM _storage_backups WHERE backup_id=$1', [backupId])).rows[0];
        if (existing) return existing.manifest as StorageManifest;
        const { rows } = await client.query(`SELECT r.resource_id,r.reference FROM _storage_resources r
          WHERE (EXISTS(SELECT 1 FROM _storage_references x WHERE x.resource_id=r.resource_id)
            OR EXISTS(SELECT 1 FROM _storage_pins p WHERE p.resource_id=r.resource_id)) AND r.state='ready'
          ORDER BY r.resource_id FOR UPDATE OF r`);
        const value: StorageManifest = { formatVersion: 1, backupId, owner, schemaVersion,
          generation: state.generation, resources: rows.map(row => resourceReferenceSchema.parse(row.reference)) };
        await client.query('INSERT INTO _storage_backups(backup_id,manifest) VALUES($1,$2)', [backupId,json(value)]);
        for (const row of rows) await client.query('INSERT INTO _storage_pins VALUES($1,$2)', [backupId,row.resource_id]);
        return value;
      });
      // Only maintenance uses a long-lived snapshot; uploads and regular requests
      // never wait for network inside a database transaction.
      const client = observe(await pool.connect());
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await client.query('SET LOCAL idle_in_transaction_session_timeout=0');
        await client.query(`SET LOCAL search_path TO ${identifier(binding.schema)}, pg_catalog`);
        const { rows: [state] } = await client.query('SELECT writes_open,dispatch_open,generation FROM _storage_identity');
        if (state.writes_open || state.dispatch_open || state.generation !== manifest.generation) throw new StorageError('maintenance');
        const { rows: [row] } = await client.query('SELECT pg_export_snapshot() AS snapshot');
        const result = await consume({ databaseSnapshot: row.snapshot as string, manifest });
        await client.query('COMMIT');
        return result;
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw storageFailure(error); }
      finally { client.release(); }
    },
    async releaseBackup(backupId) { validId(backupId); await transaction(async client => { await client.query('DELETE FROM _storage_backups WHERE backup_id=$1', [backupId]); }); },
    async validateManifest(manifest) {
      if (manifest.formatVersion !== 1 || manifest.owner.environmentId !== owner.environmentId || manifest.owner.serviceId !== owner.serviceId || manifest.schemaVersion !== schemaVersion) throw new StorageError('incompatible');
      const ids = new Set(manifest.resources.map(reference => reference.resourceId));
      const required = await transaction(async client => (await client.query('SELECT resource_id FROM _storage_references UNION SELECT resource_id FROM _storage_pins')).rows.map(row => row.resource_id as string), { readOnly: true });
      if (ids.size !== manifest.resources.length || required.some(id => !ids.has(id))) throw new StorageError('corrupt');
      for (const reference of manifest.resources) {
        const actual = await getResource(reference.resourceId);
        if (json(actual) !== json(resourceReferenceSchema.parse(reference))) throw new StorageError('corrupt');
        await verifiedBytes(actual);
      }
    },
    async close() { await pool.end(); },
  };
  return storage;
}
