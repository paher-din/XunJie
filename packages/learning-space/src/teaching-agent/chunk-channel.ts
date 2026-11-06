import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { StorageError, type OwnedStorage, type OwnedTransaction } from '@xunjie/storage';

export const chunkChannelLimits = Object.freeze({ controlBytes: 1024 * 1024, chunkBytes: 256 * 1024,
  messageBytes: 16 * 1024 * 1024, sourceTransfers: 16, sourceBytes: 64 * 1024 * 1024 });
/** Register this SQL with each receiving owner, using that owner's next migration version. */
export const chunkChannelMigrationSql = `
CREATE TABLE agent_chunk_transfers (
  source_key text NOT NULL, transfer_id uuid NOT NULL,
  input_bytes integer NOT NULL CHECK(input_bytes BETWEEN 1 AND 16777216), input_sha text NOT NULL,
  state text NOT NULL CHECK(state IN ('receiving','unknown','completed','acknowledged')),
  reserved_bytes integer NOT NULL, reply_bytes integer, reply_sha text,
  PRIMARY KEY(source_key,transfer_id)
);
CREATE TABLE agent_chunk_parts (
  source_key text NOT NULL, transfer_id uuid NOT NULL, direction text NOT NULL CHECK(direction IN ('input','reply')),
  part_index integer NOT NULL CHECK(part_index BETWEEN 0 AND 63), byte_length integer NOT NULL,
  sha256 text NOT NULL, resource_id text,
  PRIMARY KEY(source_key,transfer_id,direction,part_index),
  FOREIGN KEY(source_key,transfer_id) REFERENCES agent_chunk_transfers(source_key,transfer_id)
);`;

/** Structural equivalent of the host's trusted ConnectionSource plus grant; never read from payload. */
export interface ChunkConnectionSource {
  grantId: string; sourceEnvironmentId: string; sourceServiceId: string; sourceInstallationId?: string;
  assertAuthorized?(): Promise<void>;
}
export type ChunkHandler = (payload: unknown, source: Readonly<ChunkConnectionSource>) => unknown | Promise<unknown>;
export type ChunkCall = (payload: unknown) => Promise<unknown>;
export interface ChunkChannelOptions {
  authorize?: (payload: unknown, source: Readonly<ChunkConnectionSource>) => Promise<void>;
}
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const sourceSchema = z.object({ grantId: z.uuid(), sourceEnvironmentId: z.uuid(), sourceServiceId: z.uuid(), sourceInstallationId: z.uuid().optional() });
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const sizeSchema = z.number().int().min(1).max(chunkChannelLimits.messageBytes);
const indexSchema = z.number().int().min(0).max(63);
const base = { chunkChannel: z.literal(1), transferId: z.uuid() };
const wireSchema = z.discriminatedUnion('operation', [
  z.object({ ...base, operation: z.literal('begin'), byteLength: sizeSchema, sha256: digestSchema }).strict(),
  z.object({ ...base, operation: z.literal('put'), index: indexSchema, data: z.string().max(349528) }).strict(),
  z.object({ ...base, operation: z.literal('get'), index: indexSchema }).strict(),
  ...(['execute', 'metadata', 'ack'] as const).map(operation => z.object({ ...base, operation: z.literal(operation) }).strict()),
]);
const replySchema = z.object({ byteLength: sizeSchema, sha256: digestSchema });
const metadataSchema = z.object({ chunkChannel: z.literal(1), transferId: z.uuid(),
  state: z.enum(['receiving', 'unknown', 'completed', 'acknowledged']), reply: replySchema.optional() });
type Row = Record<string, unknown> & { state: 'receiving' | 'unknown' | 'completed' | 'acknowledged'; input_bytes: number;
  input_sha: string; reserved_bytes: number; reply_bytes: number | null; reply_sha: string | null };
function encode(value: unknown): Buffer {
  let text: string | undefined;
  try { text = JSON.stringify(value); } catch { throw new StorageError('invalid'); }
  if (text === undefined) throw new StorageError('invalid');
  const bytes = Buffer.from(text);
  if (bytes.length > chunkChannelLimits.messageBytes) throw new StorageError('invalid');
  return bytes;
}
function control(value: unknown) {
  if (encode(value).length > chunkChannelLimits.controlBytes) throw new StorageError('invalid');
}
function decode(bytes: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new StorageError('corrupt'); }
}
function decodePart(text: string): Buffer {
  const bytes = Buffer.from(text, 'base64');
  if (!bytes.length || bytes.length > chunkChannelLimits.chunkBytes || bytes.toString('base64') !== text) throw new StorageError('invalid');
  return bytes;
}
const partCount = (size: number) => Math.ceil(size / chunkChannelLimits.chunkBytes);
function metadata(id: string, row: Row) {
  return { chunkChannel: 1 as const, transferId: id, state: row.state,
    ...(row.state === 'completed' ? { reply: { byteLength: row.reply_bytes!, sha256: row.reply_sha! } } : {}) };
}

/** Authenticate/authorize EVERY wire call before entering wrap, including get/metadata/ack.
 * Normalize definitive business errors inside the wrapped handler. Unhandled throws are unknown
 * because this layer cannot prove that an external effect did not already happen.
 */
export function createChunkChannel(storage: OwnedStorage) {
  // All admission, claims and references use the real owner handle and its generation fence.
  async function mutate<T>(key: string, action: (tx: OwnedTransaction) => Promise<T>): Promise<T> {
    const receipt = await storage.request({ requestId: randomUUID(), fingerprint: 'chunk-channel/1' }, async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
      return action(tx);
    });
    return receipt.result as T;
  }
  async function read(key: string, id: string, tx?: OwnedTransaction): Promise<Row> {
    const sql = 'SELECT * FROM agent_chunk_transfers WHERE source_key=$1 AND transfer_id=$2';
    const { rows: [row] } = tx ? await tx.query<Row>(sql, [key, id]) : await storage.read<Row>(sql, [key, id]);
    if (!row) throw new StorageError('missing');
    return row;
  }
  async function budget(tx: OwnedTransaction, key: string, extra: number, newTransfer = false) {
    const { rows: [row] } = await tx.query(`SELECT COALESCE(sum(reserved_bytes),0)::bigint AS bytes,
      count(*) FILTER(WHERE state IN ('receiving','unknown'))::integer AS active FROM agent_chunk_transfers WHERE source_key=$1`, [key]);
    if (Number(row!.bytes) + extra > chunkChannelLimits.sourceBytes
      || (newTransfer && Number(row!.active) >= chunkChannelLimits.sourceTransfers)) throw new StorageError('conflict');
  }
  const refId = (key: string, id: string, direction: string, index: number) => `chunk:${key}:${id}:${direction}:${index}`;
  async function storePart(key: string, id: string, direction: 'input' | 'reply', index: number, bytes: Buffer, generatedReply = false) {
    const checksum = sha(bytes);
    const resourceHash = sha(Buffer.from(refId(key, id, direction, index)));
    const resourceId = `${resourceHash.slice(0, 8)}-${resourceHash.slice(8, 12)}-4${resourceHash.slice(13, 16)}-8${resourceHash.slice(17, 20)}-${resourceHash.slice(20, 32)}`;
    // Reserve immutable metadata before staging: a conflicting duplicate cannot consume extra resources.
    const needed = await mutate(key, async tx => {
      const row = await read(key, id, tx);
      const { rows: [old] } = await tx.query(`SELECT * FROM agent_chunk_parts WHERE source_key=$1 AND transfer_id=$2 AND direction=$3 AND part_index=$4`, [key, id, direction, index]);
      if (old && (old.sha256 !== checksum || old.byte_length !== bytes.length)) throw new StorageError('identity-conflict');
      if (old && (old.resource_id || row.state === 'acknowledged')) return false;
      if ((direction === 'input' && row.state !== 'receiving' && !(generatedReply && row.state === 'unknown')) || (direction === 'reply' && row.state !== 'unknown')) throw new StorageError('conflict');
      await tx.query(`INSERT INTO agent_chunk_parts(source_key,transfer_id,direction,part_index,byte_length,sha256)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [key, id, direction, index, bytes.length, checksum]);
      return true;
    });
    if (!needed) return;
    await storage.stageResource({ uploadId: resourceId, scope: `agent-chunk:${key}`, bytes, mediaType: 'application/octet-stream', contentVersion: 1 });
    await mutate(key, async tx => {
      const row = await read(key, id, tx);
      if (row.state === 'acknowledged') return null;
      await tx.reference(refId(key, id, direction, index), resourceId);
      await tx.query(`UPDATE agent_chunk_parts SET resource_id=$5 WHERE source_key=$1 AND transfer_id=$2 AND direction=$3 AND part_index=$4`, [key, id, direction, index, resourceId]);
      return null;
    });
  }
  async function assemble(key: string, id: string, direction: string, size: number, checksum: string) {
    const { rows } = await storage.read(`SELECT * FROM agent_chunk_parts WHERE source_key=$1 AND transfer_id=$2 AND direction=$3 ORDER BY part_index`, [key, id, direction]);
    if (rows.length !== partCount(size) || rows.some((row, index) => row.part_index !== index || !row.resource_id)) throw new StorageError('conflict');
    const buffers = [];
    for (const row of rows) buffers.push(await storage.readResource(row.resource_id as string));
    const bytes = Buffer.concat(buffers);
    if (bytes.length !== size || sha(bytes) !== checksum) throw new StorageError('corrupt');
    return decode(bytes);
  }
  function wrap(handler: ChunkHandler, options: ChunkChannelOptions = {}): ChunkHandler {
    async function wrapped(value: unknown, trusted: Readonly<ChunkConnectionSource>): Promise<unknown> {
      const parsedSource = sourceSchema.parse(trusted);
      // Whitelist only the durable identity; preserve the original trusted object (including
      // its non-enumerable live assertAuthorized hook) for every handler and authorization call.
      const source = trusted;
      const key = sha(Buffer.from(JSON.stringify([parsedSource.grantId, parsedSource.sourceEnvironmentId,
        parsedSource.sourceServiceId, parsedSource.sourceInstallationId ?? null])));
      control(value);
      if (!value || typeof value !== 'object' || !('chunkChannel' in value)) {
        // Compatibility calls use business Action/attempt/command identities for idempotency and
        // unknown-effect recovery. No transport claim exists before the handler: lost replies or
        // failed publication must be resolved by the business identity, never an automatic retry.
        const input = encode(value);
        await options.authorize?.(value, source);
        const reply = (await handler(value, source)) ?? null;
        const output = encode(reply);
        if (output.length <= chunkChannelLimits.controlBytes) {
          await options.authorize?.(decode(input), source);
          return reply;
        }
        // The reply already exists. Persist it for bounded download without invoking the handler
        // again. Start unknown so even interrupted publication can never enter explicit execute.
        const id = randomUUID();
        await mutate(key, async tx => {
          await budget(tx, key, input.length + output.length, true);
          await tx.query(`INSERT INTO agent_chunk_transfers(source_key,transfer_id,input_bytes,input_sha,state,reserved_bytes)
            VALUES($1,$2,$3,$4,'unknown',$5)`, [key, id, input.length, sha(input), input.length + output.length]);
          return null;
        });
        try {
          for (let index = 0; index < partCount(input.length); index++) await storePart(key, id, 'input', index,
            input.subarray(index * chunkChannelLimits.chunkBytes, (index + 1) * chunkChannelLimits.chunkBytes), true);
          for (let index = 0; index < partCount(output.length); index++) await storePart(key, id, 'reply', index,
            output.subarray(index * chunkChannelLimits.chunkBytes, (index + 1) * chunkChannelLimits.chunkBytes));
          return await mutate(key, async tx => {
            await tx.query(`UPDATE agent_chunk_transfers SET state='completed',reply_bytes=$3,reply_sha=$4
              WHERE source_key=$1 AND transfer_id=$2 AND state='unknown'`, [key, id, output.length, sha(output)]);
            return metadata(id, await read(key, id, tx));
          });
        } catch {
          return { chunkChannel: 1, transferId: id, state: 'unknown' };
        }
      }
      const parsed = wireSchema.safeParse(value);
      if (!parsed.success) throw new StorageError('invalid');
      const call = parsed.data, id = call.transferId;
      if (call.operation === 'begin') return mutate(key, async tx => {
        const { rows: [old] } = await tx.query<Row>('SELECT * FROM agent_chunk_transfers WHERE source_key=$1 AND transfer_id=$2', [key, id]);
        if (old) {
          if (old.input_bytes !== call.byteLength || old.input_sha !== call.sha256) throw new StorageError('identity-conflict');
          return metadata(id, old);
        }
        await budget(tx, key, call.byteLength, true);
        await tx.query(`INSERT INTO agent_chunk_transfers(source_key,transfer_id,input_bytes,input_sha,state,reserved_bytes)
          VALUES($1,$2,$3,$4,'receiving',$3)`, [key, id, call.byteLength, call.sha256]);
        return metadata(id, await read(key, id, tx));
      });
      const row = await read(key, id);
      if (call.operation === 'metadata') return metadata(id, row);
      if (call.operation === 'put') {
        const bytes = decodePart(call.data);
        const expected = Math.min(chunkChannelLimits.chunkBytes, row.input_bytes - call.index * chunkChannelLimits.chunkBytes);
        if (expected <= 0 || bytes.length !== expected) throw new StorageError('invalid');
        await storePart(key, id, 'input', call.index, bytes);
        return metadata(id, await read(key, id));
      }
      if (call.operation === 'get') {
        if (row.state !== 'completed') throw new StorageError('conflict');
        // Reconstruct the original authorization scope on every read, including after reopen.
        // A still-valid service grant does not establish the original member's current rights.
        await options.authorize?.(await assemble(key, id, 'input', row.input_bytes, row.input_sha), source);
        const { rows: [part] } = await storage.read(`SELECT resource_id FROM agent_chunk_parts WHERE source_key=$1 AND transfer_id=$2 AND direction='reply' AND part_index=$3`, [key, id, call.index]);
        if (!part?.resource_id) throw new StorageError('missing');
        return { chunkChannel: 1, transferId: id, index: call.index, data: Buffer.from(await storage.readResource(part.resource_id as string)).toString('base64') };
      }
      if (call.operation === 'ack') return mutate(key, async tx => {
        const current = await read(key, id, tx);
        if (current.state === 'unknown') throw new StorageError('conflict');
        const { rows } = await tx.query('SELECT direction,part_index FROM agent_chunk_parts WHERE source_key=$1 AND transfer_id=$2', [key, id]);
        for (const part of rows) await tx.unreference(refId(key, id, String(part.direction), Number(part.part_index)));
        await tx.query('UPDATE agent_chunk_parts SET resource_id=NULL WHERE source_key=$1 AND transfer_id=$2', [key, id]);
        await tx.query("UPDATE agent_chunk_transfers SET state='acknowledged',reserved_bytes=0 WHERE source_key=$1 AND transfer_id=$2", [key, id]);
        return metadata(id, await read(key, id, tx));
      });
      if (row.state !== 'receiving') return metadata(id, row);
      const input = await assemble(key, id, 'input', row.input_bytes, row.input_sha);
      // Definitive authorization rejection precedes the execution claim and the unknown catch.
      await options.authorize?.(input, source);
      const claimed = await mutate(key, async tx => {
        const current = await read(key, id, tx);
        if (current.state !== 'receiving') return false;
        // Reserve the largest possible reply before any external effects.
        await budget(tx, key, chunkChannelLimits.messageBytes);
        await tx.query("UPDATE agent_chunk_transfers SET state='unknown',reserved_bytes=reserved_bytes+$3 WHERE source_key=$1 AND transfer_id=$2", [key, id, chunkChannelLimits.messageBytes]);
        return true;
      });
      if (!claimed) return metadata(id, await read(key, id));
      try {
        const output = encode((await handler(input, source)) ?? null);
        for (let index = 0; index < partCount(output.length); index++) await storePart(key, id, 'reply', index,
          output.subarray(index * chunkChannelLimits.chunkBytes, (index + 1) * chunkChannelLimits.chunkBytes));
        return await mutate(key, async tx => {
          await tx.query(`UPDATE agent_chunk_transfers SET state='completed',reply_bytes=$3,reply_sha=$4,reserved_bytes=input_bytes+$3
            WHERE source_key=$1 AND transfer_id=$2 AND state='unknown'`, [key, id, output.length, sha(output)]);
          return metadata(id, await read(key, id, tx));
        });
      } catch {
        // Includes a lost commit acknowledgement. Query metadata to learn whether it committed;
        // never replay the handler, even after reopening or a generation change.
        return { chunkChannel: 1, transferId: id, state: 'unknown' };
      }
    }
    return wrapped;
  }
  /** Owner maintenance must run this before resource collection/snapshot validation.
   * Incomplete publication fails closed; it never retries an external handler or discards unknown work.
   */
  async function validate() {
    const { rows } = await storage.read(`SELECT p.*,t.state FROM agent_chunk_parts p JOIN agent_chunk_transfers t USING(source_key,transfer_id)
      WHERE t.state<>'acknowledged'`);
    for (const part of rows) {
      if (!part.resource_id) throw new StorageError('resource-busy');
      const bytes = await storage.readResource(String(part.resource_id));
      if (bytes.length !== part.byte_length || sha(bytes) !== part.sha256) throw new StorageError('corrupt');
    }
    const { rows: completed } = await storage.read<Row & { source_key: string; transfer_id: string }>(
      "SELECT * FROM agent_chunk_transfers WHERE state='completed'");
    for (const row of completed) {
      await assemble(row.source_key, row.transfer_id, 'input', row.input_bytes, row.input_sha);
      await assemble(row.source_key, row.transfer_id, 'reply', row.reply_bytes!, row.reply_sha!);
    }
  }
  return { wrap, validate };
}

/** No automatic transport retries. Keep transferId to query/recover an uncertain delivery.
 * Completed replies remain retained by default; explicitly ack after the consumer durably accepts
 * the reply (wire operation 'ack'), or opt into acknowledge for an ephemeral consumer.
 * Inline small calls rely on business idempotency; their large replies are downloaded and acked.
 */
export function createChunkClient(call: ChunkCall) {
  return async (value: unknown, options: { transferId?: string; acknowledge?: boolean; inline?: boolean } = {}): Promise<unknown> => {
    const bytes = encode(value);
    let transferId = z.uuid().parse(options.transferId ?? randomUUID());
    let status: z.infer<typeof metadataSchema> | undefined;
    const inlined = options.inline === true && bytes.length <= chunkChannelLimits.controlBytes;
    if (inlined) {
      let reply: unknown;
      try { reply = await call(value); }
      catch (error) {
        // The server generated the compatibility transfer ID; a lost reply cannot establish it.
        // Leave recovery to the caller's business identity instead of inventing a reusable ID.
        throw new StorageError(error instanceof StorageError ? error.code : 'commit-unknown');
      }
      control(reply);
      if (!reply || typeof reply !== 'object' || !('chunkChannel' in reply)) return reply;
      status = metadataSchema.parse(reply);
      transferId = status.transferId;
    }
    const send = async (operation: string, fields: Record<string, unknown> = {}) => {
      const payload = { chunkChannel: 1, operation, transferId, ...fields };
      control(payload);
      let reply: unknown;
      try { reply = await call(payload); }
      catch (error) {
        throw new StorageError(error instanceof StorageError ? error.code : operation === 'execute' ? 'commit-unknown' : 'unavailable', transferId);
      }
      control(reply);
      if (!reply || typeof reply !== 'object' || !('transferId' in reply) || reply.transferId !== transferId) throw new StorageError('corrupt');
      return reply;
    };
    status ??= metadataSchema.parse(await send('begin', { byteLength: bytes.length, sha256: sha(bytes) }));
    if (!inlined && status.state === 'receiving') {
      for (let index = 0; index < partCount(bytes.length); index++) await send('put', { index,
        data: bytes.subarray(index * chunkChannelLimits.chunkBytes, (index + 1) * chunkChannelLimits.chunkBytes).toString('base64') });
      status = metadataSchema.parse(await send('execute'));
    }
    if (status.state === 'unknown') throw new StorageError('commit-unknown', transferId);
    if (status.state !== 'completed' || !status.reply) throw new StorageError('conflict', transferId);
    const parts = [];
    for (let index = 0; index < partCount(status.reply.byteLength); index++) {
      const result = z.object({ chunkChannel: z.literal(1), transferId: z.literal(transferId), index: z.literal(index), data: z.string().max(349528) }).parse(await send('get', { index }));
      parts.push(decodePart(result.data));
    }
    const output = Buffer.concat(parts);
    if (output.length !== status.reply.byteLength || sha(output) !== status.reply.sha256) throw new StorageError('corrupt');
    const result = decode(output);
    if (inlined || options.acknowledge) await send('ack');
    return result;
  };
}
