import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { storageErrorCodes } from '@xunjie/contracts/storage';
import type { ResourceReference, StorageErrorCode, StorageReceipt } from '@xunjie/contracts/storage';
import { StorageError } from '@xunjie/storage';
import type { Migration, OwnedStorage } from '@xunjie/storage';

/** This module owns its schema; hosts pass these migrations to provisionStorage/openStorage. */
export const sampleMigrations: Migration[] = [{
  version: 1,
  name: 'storage-sample-records',
  sql: `CREATE TABLE sample_records (
    id text PRIMARY KEY,
    version integer NOT NULL CHECK (version > 0),
    body jsonb NOT NULL,
    resource_id uuid
  );`,
}];

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const requestIdSchema = z.string().min(1).max(200);
const saveSchema = z.object({
  requestId: requestIdSchema,
  id: idSchema,
  expectedVersion: z.number().int().min(0).max(2_147_483_646),
  body: z.json(),
  uploadId: z.string().uuid().optional(),
  bytes: z.instanceof(Uint8Array).optional(),
}).strict().refine(value => (value.uploadId === undefined) === (value.bytes === undefined));

export type StorageSampleSave = z.infer<typeof saveSchema>;
type Json = StorageSampleSave['body'];
export interface StorageSampleRecord {
  id: string;
  version: number;
  body: Json;
  resource: ResourceReference | null;
}
type RecordRow = { id: string; version: number; body: Json; resource_id: string | null };

function fail(code: StorageErrorCode): never {
  throw new StorageError(code);
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) fail('invalid');
  return result.data;
}

function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const scopeFor = (id: string) => `storage-sample/records/${id}`;
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

export function createStorageSample(storage: OwnedStorage) {
  function validateScope(reference: ResourceReference, id: string) {
    if (reference.scope !== scopeFor(id)
      || reference.owner.environmentId !== storage.owner.environmentId
      || reference.owner.serviceId !== storage.owner.serviceId) fail('forbidden');
  }

  async function read(id: string): Promise<StorageSampleRecord | null> {
    parse(idSchema, id);
    const { rows } = await storage.read<RecordRow>('SELECT id, version, body, resource_id FROM sample_records WHERE id = $1', [id]);
    const row = rows[0];
    if (!row) return null;
    const resource = row.resource_id === null ? null : await storage.resource(row.resource_id);
    if (resource) validateScope(resource, id);
    return { id: row.id, version: row.version, body: row.body, resource };
  }

  async function save(input: StorageSampleSave): Promise<StorageReceipt> {
    const parsed = parse(saveSchema, input);
    // Snapshot caller-owned objects before staging or entering an async transaction.
    const body = JSON.parse(canonical(parsed.body)) as Json;
    const bytes = parsed.bytes === undefined ? undefined : Uint8Array.from(parsed.bytes);
    const fingerprint = digest(canonical({
      id: parsed.id, expectedVersion: parsed.expectedVersion, body,
      uploadId: parsed.uploadId ?? null, bytes: bytes === undefined ? null : digest(bytes),
    }));
    // A confirmed retry needs only the receipt store, even while writes/blobs are unavailable.
    const confirmed = await storage.receipt(parsed.requestId, fingerprint);
    if (confirmed) return confirmed;
    // The blob must be durable before the SQL request can commit a reference to it.
    const staged = bytes === undefined ? undefined : await storage.stageResource({
      uploadId: parsed.uploadId!, scope: scopeFor(parsed.id), bytes,
      mediaType: 'application/octet-stream', contentVersion: parsed.expectedVersion + 1,
    });
    if (staged) validateScope(staged, parsed.id);
    return storage.request({ requestId: parsed.requestId, fingerprint }, async tx => {
      const { rows } = await tx.query<RecordRow>(
        'SELECT id, version, body, resource_id FROM sample_records WHERE id = $1 FOR UPDATE', [parsed.id]);
      const previous = rows[0];
      const referenceId = `record:${parsed.id}`;
      let resource: ResourceReference | null = null;
      if (staged) {
        await tx.unreference(referenceId);
        resource = await tx.reference(referenceId, staged.resourceId);
      } else if (previous?.resource_id) {
        resource = await tx.reference(referenceId, previous.resource_id);
      }
      if (resource) {
        validateScope(resource, parsed.id);
        // Receipts outlive the mutable record binding and keep their own bytes reachable.
        await tx.reference(`request:${digest(parsed.requestId)}`, resource.resourceId);
      }
      const version = parsed.expectedVersion + 1;
      const result = { id: parsed.id, version, resource };
      await tx.enqueue(`save:${digest(parsed.requestId)}`, result);
      const changed = parsed.expectedVersion === 0
        ? await tx.query(`INSERT INTO sample_records (id, version, body, resource_id) VALUES ($1, 1, $2::jsonb, $3)
            ON CONFLICT (id) DO NOTHING RETURNING id`, [parsed.id, JSON.stringify(body), resource?.resourceId ?? null])
        : await tx.query(`UPDATE sample_records SET version = $2, body = $3::jsonb, resource_id = $4
            WHERE id = $1 AND version = $5 RETURNING id`,
          [parsed.id, version, JSON.stringify(body), resource?.resourceId ?? null, parsed.expectedVersion]);
      // Throw inside the request: references, receipt and outbox all roll back with the failed CAS.
      if (changed.rowCount !== 1) fail('conflict');
      return result;
    });
  }

  async function receipt(requestId: string): Promise<StorageReceipt | null> {
    return storage.receipt(parse(requestIdSchema, requestId));
  }

  async function resource(resourceId: string, recordId: string) {
    parse(z.string().uuid(), resourceId);
    const record = await read(recordId);
    if (!record) fail('missing');
    if (record.resource?.resourceId !== resourceId) fail('forbidden');
    validateScope(record.resource, recordId);
    return { reference: record.resource, bytes: await storage.readResource(resourceId) };
  }

  return { save, read, receipt, resource };
}

const statusByCode: Record<StorageErrorCode, number> = {
  invalid: 400, incompatible: 409, 'migration-busy': 503, conflict: 409, 'identity-conflict': 409,
  'commit-unknown': 503, unavailable: 503, forbidden: 403, missing: 404, corrupt: 500,
  'upload-unknown': 503, maintenance: 503, 'stale-generation': 409, 'resource-busy': 409, 'resource-gone': 410,
};
const wireSaveSchema = z.object({
  requestId: requestIdSchema,
  id: idSchema.optional(),
  expectedVersion: z.number().int().min(0).max(2_147_483_646),
  body: z.json(),
  uploadId: z.string().uuid().optional(),
  bytes: z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/).optional(),
}).strict();

/** No credentials/configuration routes, and no test-only hooks in the product module. */
export const storageSamplePlugin: FastifyPluginAsync<{ storage: OwnedStorage }> = async (app, { storage }) => {
  const service = createStorageSample(storage);
  app.setErrorHandler((error, _request, reply) => {
    const candidate = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    const code = storageErrorCodes.find(value => value === candidate);
    if (code) return reply.code(statusByCode[code]).send({ code });
    const clientError = typeof error === 'object' && error !== null && 'statusCode' in error
      && typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500;
    return reply.code(clientError ? error.statusCode as number : 503).send({ code: clientError ? 'invalid' : 'unavailable' });
  });
  app.put<{ Params: { id: string } }>('/records/:id', async request => {
    const id = parse(idSchema, request.params.id);
    const input = parse(wireSaveSchema, request.body);
    if (input.id !== undefined && input.id !== id) fail('invalid');
    const bytes = input.bytes === undefined ? undefined : Buffer.from(input.bytes, 'base64');
    if (bytes !== undefined && bytes.toString('base64') !== input.bytes) fail('invalid');
    const { bytes: _encoded, ...payload } = input;
    return service.save({ ...payload, id, ...(bytes === undefined ? {} : { bytes }) });
  });
  app.get<{ Params: { id: string } }>('/records/:id', async request => {
    const record = await service.read(request.params.id);
    if (!record) fail('missing');
    return record;
  });
  app.get<{ Params: { id: string } }>('/receipts/:id', async request => {
    const receipt = await service.receipt(request.params.id);
    if (!receipt) fail('missing');
    return receipt;
  });
  app.get<{ Params: { id: string }; Querystring: { recordId?: string } }>('/resources/:id', async (request, reply) => {
    const recordId = parse(idSchema, request.query.recordId);
    const resource = await service.resource(request.params.id, recordId);
    return reply.type(resource.reference.mediaType).send(Buffer.from(resource.bytes));
  });
};

/** The standalone acceptance host supplies storage and owns its shutdown lifecycle. */
export function createStorageSampleApp(storage: OwnedStorage) {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  app.register(storageSamplePlugin, { storage });
  return app;
}
