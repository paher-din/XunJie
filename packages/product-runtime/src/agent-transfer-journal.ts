import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { StorageError } from '@xunjie/storage';
import { runtimeConnectionSchema, fixedRuntimeConnectionDescriptor, type RuntimeConnection } from '@xunjie/contracts/product-runtime';
import { teachingDispatchAuthoritySchema } from '@xunjie/contracts/teaching-agent';
import { acquireLock, atomicJson, exists, readJson } from './io.js';

const source = z.object({ grantId: z.uuid(), sourceEnvironmentId: z.uuid(), sourceServiceId: z.uuid(), sourceInstallationId: z.uuid() }).strict();
const schema = z.object({ version: z.literal(1), key: z.string().regex(/^[a-f0-9]{64}$/), transferId: z.uuid(),
  connection: runtimeConnectionSchema.omit({ credentialRef: true }), capability: z.string().min(1), origin: source,
  digest: z.string().regex(/^[a-f0-9]{64}$/), payload: z.json(), dynamic: z.boolean(),
  state: z.enum(['pending', 'received', 'consumed']), result: z.json().optional() }).strict();
type Entry = z.infer<typeof schema>;
const directory = (root: string) => join(root, 'private', 'agent-transfers');
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
/** Only top-level dispatch leases vary; fixed inputs and all other authority fields stay bound. */
function fixed(value: unknown): unknown {
  if (value && typeof value === 'object' && 'operation' in value && 'args' in value && Array.isArray(value.args)) {
    const argument = value.args[0];
    if (value.operation === 'assertModelDispatch' && argument && typeof argument === 'object') {
      const { driverId: _driver, generation: _generation, ...association } = argument;
      return { ...value, args: [association, ...value.args.slice(1)] };
    }
    if (value.operation === 'assertCommandDispatch' && argument && typeof argument === 'object')
      return { ...value, args: [fixed(argument), ...value.args.slice(1)] };
  }
  if (!value || typeof value !== 'object' || !('authority' in value) || value.authority === undefined) return value;
  const authority = teachingDispatchAuthoritySchema.parse(value.authority);
  const { driverId: _driver, generation: _generation, ...association } = authority;
  return { ...value, authority: association };
}
function semantics(payload: unknown) {
  const item = payload as { operation?: string; args?: unknown[]; identity?: unknown; scope?: unknown; activityId?: unknown };
  const nested = item.operation === 'model' ? item.args?.[0] as typeof item : item;
  const operation = nested?.operation ?? '';
  // These domain operations explicitly query/reconcile their original identity. Reissuing them
  // after durable consumption is safe; an unknown transport is never consumed or reissued.
  const dynamic = item.operation === 'model'
    ? /^(selection\.(read|snapshot|resolve|pin|pinned)|checks\.(read|list|progress|summary|requestPayload|dispatch)|segments\.read|images\.read|results\.(read|native)|capabilities\.decide)$/.test(operation)
    : ['authorize', 'identityFor', 'activity', 'tool.definitions', 'tool.reconcile', 'tool.stop', 'conversation', 'events',
      'capabilities', 'run', 'request', 'snapshot', 'query', 'response', 'inputControlReceipt', 'switchModel', 'assertCommandDispatch', 'assertModelDispatch'].includes(operation);
  const identifiers: Array<[string, unknown]> = [];
  const collect = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, entry] of Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      if (['requestId', 'attemptId', 'commandId', 'segmentId', 'runId', 'stepId', 'snapshotId', 'callId'].includes(key)) identifiers.push([key, entry]);
      else if (key !== 'authority' && entry && typeof entry === 'object') collect(entry);
    }
  };
  collect(nested?.args);
  // Scalar command/attempt arguments (dispatch, cancel, read) are identities as well.
  for (const arg of nested?.args ?? []) if (typeof arg === 'string') identifiers.push(['argument', arg]);
  return { dynamic, association: { operation: item.operation, nested: operation, identity: item.identity ?? item.scope,
    activityId: item.activityId, identifiers: identifiers.length ? identifiers : fixed(payload) } };
}

function validateEntry(value: unknown) {
  const entry = schema.parse(value);
  if (sha(canonical(fixed(entry.payload))) !== entry.digest || entry.state !== 'pending' && !Object.hasOwn(entry, 'result'))
    throw new StorageError('corrupt');
  return entry;
}
/** Visit bounded records individually; replies never accumulate in the backup envelope/heap. */
async function* entries(root: string) {
  const entries = await readdir(directory(root)).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  for (const name of entries.filter(name => name.endsWith('.json')).sort()) {
    const entry = validateEntry(await readJson(join(directory(root), name)));
    if (name !== entry.key + '.json') throw new StorageError('corrupt');
    yield entry;
  }
}
export async function agentTransferEntries(root: string): Promise<Entry[]> {
  const result: Entry[] = [];
  for await (const entry of entries(root)) result.push(entry);
  return result;
}
export async function validateAgentTransfers(root: string) {
  for await (const _entry of entries(root)) { /* validate one complete record at a time */ }
}
const backupSchema = z.object({ version: z.literal(1), entries: z.array(z.object({
  key: z.string().regex(/^[a-f0-9]{64}$/), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  byteLength: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict()) }).strict();
/** These files become ordinary authenticated/encrypted recovery artifacts. */
export async function exportAgentTransfers(root: string, backupDirectory: string, signal: AbortSignal) {
  const target = join(backupDirectory, 'agent-transfers');
  await mkdir(target, { recursive: true, mode: 0o700 });
  const records: z.infer<typeof backupSchema>['entries'] = [];
  for await (const entry of entries(root)) {
    signal.throwIfAborted();
    const path = join(target, entry.key + '.json');
    await atomicJson(path, entry);
    const bytes = await readFile(path);
    records.push({ key: entry.key, sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length });
  }
  return { version: 1 as const, entries: records };
}
export function parseAgentTransferBackup(value: unknown) {
  const manifest = backupSchema.parse(value);
  if (new Set(manifest.entries.map(item => item.key)).size !== manifest.entries.length) throw new StorageError('corrupt');
  return manifest;
}
export async function restoreAgentTransfers(root: string, backupDirectory: string, value: unknown): Promise<void> {
  const manifest = parseAgentTransferBackup(value);
  await mkdir(directory(root), { recursive: true, mode: 0o700 });
  for (const reference of manifest.entries) {
    const path = join(backupDirectory, 'agent-transfers', reference.key + '.json'), stat = await lstat(path);
    if (!stat.isFile() || stat.size !== reference.byteLength) throw new StorageError('corrupt');
    const bytes = await readFile(path);
    if (createHash('sha256').update(bytes).digest('hex') !== reference.sha256) throw new StorageError('corrupt');
    const entry = validateEntry(JSON.parse(bytes.toString('utf8')));
    if (entry.key !== reference.key) throw new StorageError('corrupt');
    await atomicJson(join(directory(root), entry.key + '.json'), entry);
  }
}

function retryableBusinessFailure(value: unknown) {
  if (!value || typeof value !== 'object') return false;
  const reply = value as { error?: unknown; ok?: unknown; code?: unknown };
  const code = typeof reply.error === 'string' ? reply.error : reply.ok === false ? reply.code : undefined;
  // A completed, durably consumed rejection can be explicitly retried at the SAME
  // domain identity. An uncertain transport or domain effect is never retried here.
  return ['unavailable', 'maintenance', 'resource-busy', 'forbidden', 'stale-generation'].includes(String(code));
}

export async function withAgentTransfer<T>(options: { root: string; connection: RuntimeConnection; capability: string;
  installationId: string; grantId: string; payload: unknown },
  work: (entry: Entry, receive: (result: unknown) => Promise<void>, context: {
    reused: boolean; rebindOrigin(origin: Entry['origin']): Promise<void>;
  }) => Promise<T>): Promise<T> {
  const { root, connection, capability, payload } = options;
  if (Buffer.byteLength(JSON.stringify(payload)) > 16 * 1024 * 1024) throw new StorageError('invalid');
  const descriptor = fixedRuntimeConnectionDescriptor(connection);
  const meaning = semantics(payload), digest = sha(canonical(fixed(payload)));
  const key = sha(canonical({ connectionId: connection.connectionId, capability, association: meaning.association }));
  const release = await acquireLock(root, 'agent-transfer-' + key);
  try {
    await mkdir(directory(root), { recursive: true, mode: 0o700 });
    const path = join(directory(root), key + '.json');
    let entry = await exists(path) ? validateEntry(await readJson(path)) : undefined;
    const fresh = !entry || entry.state === 'consumed' && (meaning.dynamic || retryableBusinessFailure(entry.result));
    if (entry && (canonical(entry.connection) !== canonical(descriptor)
      || entry.digest !== digest && !(fresh && meaning.dynamic))) throw new StorageError('identity-conflict');
    if (fresh) {
      entry = schema.parse({ version: 1, key, transferId: randomUUID(), connection: descriptor, capability,
        origin: { grantId: options.grantId, sourceEnvironmentId: connection.sourceEnvironmentId,
          sourceServiceId: connection.sourceServiceId, sourceInstallationId: options.installationId },
        digest, payload, dynamic: meaning.dynamic, state: 'pending' });
      // Publication must complete before any network call. An uncertain local commit is reread
      // by the same association on retry; it cannot result in a second transport identity.
      await atomicJson(path, entry);
    }
    const current = entry!;
    const receive = async (result: unknown) => {
      current.result = z.json().parse(result); current.state = 'received';
      await atomicJson(path, current);
    };
    const result = await work(current, receive, { reused: !fresh, async rebindOrigin(origin) {
      if (current.state !== 'pending') throw new StorageError('conflict');
      current.origin = source.parse(origin);
      await atomicJson(path, current);
    } });
    current.state = 'consumed';
    await atomicJson(path, current);
    return result;
  } finally { await release(); }
}
