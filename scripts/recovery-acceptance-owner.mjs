// Standalone acceptance service. Its only persistence boundary is OwnedStorage.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const migrations = [{ version: 1, name: 'acceptance-records', sql: `
  CREATE TABLE records (
    id text PRIMARY KEY,
    value jsonb NOT NULL CHECK (jsonb_typeof(value) = 'object'),
    seq bigserial UNIQUE
  );
` }];
export const upgradedMigrations = [...migrations, {
  version: 2, name: 'acceptance-records-note',
  sql: "ALTER TABLE records ADD COLUMN upgrade_note text NOT NULL DEFAULT 'schema-v2';",
}];

export function acceptanceService(storage) {
  return {
    async stage(uploadId, bytes) {
      return storage.stageResource({ uploadId, bytes, scope: 'recovery-acceptance',
        mediaType: 'application/octet-stream', contentVersion: 1 });
    },
    async save({ requestId, id, value, references = [], intentId, seq }) {
      const fingerprint = createHash('sha256').update(JSON.stringify({ id, value, references, intentId, seq })).digest('hex');
      return storage.request({ requestId, fingerprint }, async tx => {
        const { rows: [record] } = seq === undefined
          ? await tx.query('INSERT INTO records(id,value) VALUES($1,$2) RETURNING id,seq::text', [id, JSON.stringify(value)])
          : await tx.query('INSERT INTO records(id,value,seq) VALUES($1,$2,$3) RETURNING id,seq::text', [id, JSON.stringify(value), seq]);
        const resources = [];
        for (const [index, reference] of references.entries()) {
          resources.push(await tx.reference(`${id}/${index}`, reference.resourceId));
        }
        if (intentId) await tx.enqueue(intentId, { requestId, recordId: id, externalRequestId: intentId, state: 'unknown' });
        return { ...record, resources, ...(intentId ? { effectRequestId: intentId, effectState: 'unknown' } : {}) };
      });
    },
    async read(id) { return (await storage.read('SELECT id,value,seq::text FROM records WHERE id=$1', [id])).rows[0] ?? null; },
    receipt: requestId => storage.receipt(requestId),
    async resource(id) {
      return { reference: await storage.resource(id), bytes: Buffer.from(await storage.readResource(id)),
        opaque: Buffer.from(await storage.readResourceObject(id)) };
    },
    pending: () => storage.pendingIntents(),
    async engine() { return (await storage.read("SELECT current_setting('server_version') AS version")).rows[0].version.split(' ')[0]; },
    async structure() {
      return {
        sequence: (await storage.read('SELECT last_value::text,is_called FROM records_seq_seq')).rows[0],
        constraints: (await storage.read("SELECT contype::text AS kind FROM pg_constraint WHERE conrelid='records'::regclass AND contype IN ('c','p','u') ORDER BY contype::text")).rows,
      };
    },
    async schemaUpgrade() { return (await storage.read('SELECT DISTINCT upgrade_note FROM records')).rows; },
  };
}

export async function validateAcceptanceService(service, expected) {
  if (!expected) return;
  for (const item of expected.records) assert.deepEqual(await service.read(item.id), item);
  for (const receipt of expected.receipts) assert.deepEqual(await service.receipt(receipt.requestId), receipt);
  for (const resource of expected.resources) assert.deepEqual(await service.resource(resource.reference.resourceId), resource);
  const structure = await service.structure();
  assert.deepEqual(structure.constraints, [{ kind: 'c' }, { kind: 'p' }, { kind: 'u' }]);
  assert.deepEqual(structure.sequence, expected.sequence);
}

export function portableExpected(expected) {
  return { ...expected, resources: expected.resources.map(({ reference, bytes, opaque }) => ({
    reference, bytesBase64: bytes.toString('base64'), opaqueBase64: opaque.toString('base64'),
  })) };
}
export function restoreExpected(expected) {
  const decode = value => {
    assert.equal(typeof value, 'string');
    const bytes = Buffer.from(value, 'base64');
    assert.equal(bytes.toString('base64'), value);
    return bytes;
  };
  return { ...expected, resources: expected.resources.map(({ reference, bytesBase64, opaqueBase64 }) => ({
    reference, bytes: decode(bytesBase64), opaque: decode(opaqueBase64),
  })) };
}
