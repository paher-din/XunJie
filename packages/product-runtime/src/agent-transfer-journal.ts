import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { StorageError } from '@xunjie/storage';
import { runtimeConnectionSchema, fixedRuntimeConnectionDescriptor, type RuntimeConnection } from '@xunjie/contracts/product-runtime';
import { agentSessionCallSchema, type AgentSessionCall } from '@xunjie/contracts/agent-service';
import { agentDependencyCallSchema, isAgentDependencyRead, type AgentDependencyCall } from '@xunjie/contracts/agent-dependencies';
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
/** Only dispatch generations vary; the original operation and request bytes remain fixed. */
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
function modern(value: unknown, capability: string): AgentSessionCall | AgentDependencyCall {
  if (!['agent.sessions.v2', 'agent.dependencies.v2'].includes(capability)) throw new StorageError('incompatible');
  if (object(value).version !== 2) throw new StorageError('incompatible');
  const parsed = capability === 'agent.sessions.v2' ? agentSessionCallSchema.safeParse(value) : agentDependencyCallSchema.safeParse(value);
  if (!parsed.success) throw new StorageError('invalid');
  return parsed.data;
}
function fixed(value: unknown, capability: string): unknown {
  const call = modern(value, capability);
  const copy = JSON.parse(JSON.stringify(call)) as Record<string, unknown>;
  delete object(copy.identity).name;
  if (copy.permit) delete object(copy.permit).generation;
  // Model authority embeds the same permit in these fixed protocol positions.
  if (call.operation === 'model') {
    const args = object(copy.args).args as unknown[];
    const slot = call.args.method === 'checks.receive' ? 0 : call.args.method === 'checks.dispatch' ? 1 : -1;
    if (slot >= 0) {
      const authority = slot === 0 ? object(object(args[slot]).authority) : object(args[slot]);
      if (authority.permit) delete object(authority.permit).generation;
    }
  }
  return copy;
}

function semantics(payload: unknown, capability: string) {
  const call = modern(payload, capability);
  const args = object(call.args), normalized = object(fixed(payload, capability));
  const dynamic = capability === 'agent.dependencies.v2' ? isAgentDependencyRead(call as AgentDependencyCall)
    : ['run', 'events', 'snapshot', 'request', 'conversation', 'assertDispatch'].includes(call.operation);
  const method = typeof args.method === 'string' ? args.method : undefined;
  let request: unknown = args.requestId;
  if (call.operation === 'initialize') request = object(args.session).sessionId;
  for (const key of ['input', 'response', 'resolution', 'control']) request ??= object(args[key]).requestId;
  if ('permit' in call) request ??= call.permit?.operationId;
  const nested = Array.isArray(args.args) ? args.args : [];
  request ??= object(nested[0]).requestId ?? object(nested[0]).attemptId ?? object(nested[1]).commandId
    ?? (typeof nested[0] === 'string' ? nested[0] : undefined);
  return { dynamic, association: { version: 2, operation: call.operation, ...(method ? { method } : {}),
    ...(dynamic ? { identity: normalized.identity, sessionId: 'sessionId' in call ? call.sessionId : null, args }
      : { requestId: request ?? normalized }) } };
}

function validateEntry(value: unknown) {
  const entry = schema.parse(value);
  if (sha(canonical(fixed(entry.payload, entry.capability))) !== entry.digest || entry.state !== 'pending' && !Object.hasOwn(entry, 'result'))
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
  const meaning = semantics(payload, capability), digest = sha(canonical(fixed(payload, capability)));
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
