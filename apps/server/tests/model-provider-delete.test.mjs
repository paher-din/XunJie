import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { StorageError } from '@xunjie/storage';
import { createModelGateway } from '../../../packages/learning-space/dist/model-connections/index.js';

// Existing saved route whose DNS is no longer usable. Deletion must stay local.
async function fixture() {
  const identity = { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), kind: 'personal', name: 'owner' };
  const scope = [identity.environmentId, identity.spaceId, identity.principalId].join('.');
  const providerId = randomUUID(), connectionId = randomUUID();
  let group = { version: 1, connectionIds: [connectionId] };
  let head = { version: 1, routeId: randomUUID(), credentialRef: randomUUID(), configuration: {
    connectionId, providerId, name: 'Offline supplier', protocol: 'chat-completions', baseUrl: 'https://deleted-supplier.invalid/v1',
    path: '/chat/completions', modelId: 'offline', dialect: 'standard', parameterMode: 'plain',
    enabled: true, modelEnabled: true, providerEnabled: true,
  } };
  const versions = [structuredClone(head)], queries = [];
  let allowed = true, requests = 0;
  const storage = {
    async read(sql) {
      if (sql.includes('FROM model_vault')) return { rows: [{ resource_id: randomUUID() }] };
      if (sql.includes('FROM model_directory_cache')) return { rows: [] };
      throw new Error('Unexpected read: ' + sql);
    },
    async readResource() { return new Uint8Array(32); },
    async request(_input, run) {
      requests++;
      const result = await run({ async query(sql, args) {
        queries.push({ sql, args });
        if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
        if (sql.startsWith('SELECT body FROM model_providers')) return { rows: args[0] === scope ? [{ body: structuredClone(group) }] : [] };
        if (sql.startsWith('SELECT body FROM model_connections')) return { rows: args[0] === scope ? [{ body: structuredClone(head) }] : [] };
        if (sql.startsWith('INSERT INTO model_connections')) head = structuredClone(args[3]);
        else if (sql.startsWith('INSERT INTO model_versions')) versions.push(structuredClone(args[3]));
        else if (sql.startsWith('INSERT INTO model_providers')) group = structuredClone(args[2]);
        else throw new Error('Unexpected mutation: ' + sql);
        return { rows: [] };
      } });
      return { result };
    },
  };
  const gateway = await createModelGateway(storage, { holder: 'school',
    async authorize() { if (!allowed) throw new StorageError('forbidden'); } });
  return { identity, scope, providerId, gateway, versions, queries, head: () => head, group: () => group,
    deny() { allowed = false; }, requests: () => requests };
}

test('supplier deletion clears a saved credential through the owner without resolving an offline public route', async () => {
  const f = await fixture();
  const before = structuredClone(f.head());
  const result = await f.gateway.providers.remove(f.identity, f.providerId, { requestId: randomUUID(), expectedVersion: 1 });
  assert.deepEqual(result, { providerId: f.providerId });
  assert.deepEqual(f.versions[0], before, 'original configuration and credential reference remain historical facts');
  assert.equal(f.versions.length, 2);
  assert.equal(f.head().version, 2); assert.equal(f.head().routeId, before.routeId);
  assert.equal(f.head().retired, true); assert.equal(f.head().credentialRef, null);
  assert.equal(f.head().configuration.enabled, false);
  assert.deepEqual(f.group(), { version: 2, connectionIds: [], deleted: true });
  assert.match(f.queries[0].sql, /pg_advisory_xact_lock/);
  assert.deepEqual(f.queries[0].args, ['model-config:' + f.scope]);
});

test('supplier deletion authorizes before accessing receipts and scopes all reads to the authenticated owner', async () => {
  const f = await fixture(), input = { requestId: randomUUID(), expectedVersion: 0 };
  const foreign = { ...f.identity, principalId: randomUUID() };
  await assert.rejects(f.gateway.providers.remove(foreign, f.providerId, input), { code: 'missing' });
  assert.equal(f.versions.length, 1);
  const foreignScope = [foreign.environmentId, foreign.spaceId, foreign.principalId].join('.');
  for (const query of f.queries.slice(1)) assert.equal(query.args[0], foreignScope);
  f.deny();
  const requests = f.requests();
  await assert.rejects(f.gateway.providers.remove(f.identity, f.providerId, input), { code: 'forbidden' });
  assert.equal(f.requests(), requests);
});

test('supplier deletion respects closed owner writes before creating a receipt', async () => {
  const f = await fixture();
  f.gateway.closeWrites();
  await assert.rejects(f.gateway.providers.remove(f.identity, f.providerId, { requestId: randomUUID(), expectedVersion: 1 }), { code: 'maintenance' });
  assert.equal(f.requests(), 0);
});
