import { createHash } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { StorageError } from '@xunjie/storage';
import { canonicalValue, executionQuerySchema, isTerminalExecutionState } from '@xunjie/contracts/execution';
import { nativeChannelNodeSchema } from '@xunjie/learning-space';
import type { NativeChannelCommand, NativeChannelNode, NativeSessionHostOptions } from '@xunjie/learning-space';
import { createNativeChannelExecutor } from './native-channel-executor.js';
import { acquireLock, atomicJson, exists, readJson } from './io.js';

const nodeSchema = nativeChannelNodeSchema;
const ownerSchema = z.object({ environmentId: z.uuid(), serviceId: z.uuid() });
const registrationSchema = nodeSchema.extend({ owner: ownerSchema, generation: z.string().min(1).max(128), leaseMs: z.number().int().min(1000).max(60000) });
const claimedSchema = z.object({ commandId: z.uuid(), activityId: z.uuid(), sessionId: z.uuid(), operation: z.enum(['submit', 'control', 'stop']),
  payload: z.json(), claimId: z.uuid(), node: nodeSchema, owner: ownerSchema, generation: z.string().min(1).max(128) }).strict();
const cleanupQuerySchema = executionQuerySchema.refine(query => query.statusKnowledge === 'confirmed' && isTerminalExecutionState(query.state));
const cleanupEndpointSchema = z.url().refine(value => {
  const url = new URL(value);
  return value === url.origin && (url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname));
});
const journalSchema = z.object({ command: claimedSchema, state: z.enum(['dispatching', 'reported']), result: z.json().optional(),
  cleanupEndpoint: cleanupEndpointSchema.optional(), pendingCleanup: cleanupQuerySchema.optional(), cleaned: z.literal(true).optional() }).strict();
type Journal = z.infer<typeof journalSchema>;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonicalValue(value))).digest('hex');

/** 本机仅发起出站请求；文件日志在执行前落盘，重启后的不确定动作只报告未知，绝不重放。 */
export function createNativeChannelWorker(options: {
  root: string;
  node: NativeChannelNode;
  /** Fixed by the approved school connection, never by a command or an outbox caller. */
  cleanupEndpoint?: string;
  call(operation: 'register' | 'claim' | 'report' | 'heartbeat' | 'cleanup', input: unknown): Promise<unknown>;
  native?: NativeSessionHostOptions;
  execute?(command: NativeChannelCommand): Promise<unknown>;
  cleanup?(): Promise<void>;
}) {
  const node = nodeSchema.parse(options.node);
  const cleanupEndpoint = options.cleanupEndpoint === undefined ? undefined : cleanupEndpointSchema.parse(options.cleanupEndpoint);
  const executor = createNativeChannelExecutor({ ...options.native, node });
  const execute = options.execute ?? executor.execute;
  const cleanup = options.cleanup ?? executor.cleanup;
  const directory = join(options.root, 'native-channel', node.connectionId);
  let closed = false, deadline = 0, cleanupNeeded = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setInterval> | undefined;
  let inflight: Promise<void> | undefined;
  let registration: z.infer<typeof registrationSchema> | undefined;
  const acknowledgedObservations = new Map<string, string>();
  const observationGenerations = new Map<string, string>();
  let journalWrites = Promise.resolve();
  function changeJournal(path: string, update: (current: Journal | undefined) => Journal) {
    const saved = journalWrites.then(async () => {
      const current = await exists(path) ? journalSchema.parse(await readJson(path)) : undefined;
      await atomicJson(path, update(current));
    });
    journalWrites = saved.catch(() => undefined);
    return saved;
  }
  function saveJournal(path: string, value: Journal) {
    const { pendingCleanup: _pending, cleaned: _cleaned, ...content } = value;
    return changeJournal(path, current => ({ ...(cleanupEndpoint ? { cleanupEndpoint } : {}), ...current, ...content }));
  }
  async function persistCleanup() {
    const terminal = executor.snapshots().filter(query => query.statusKnowledge === 'confirmed' && isTerminalExecutionState(query.state));
    if (!terminal.length) return;
    for (const file of await readdir(directory)) {
      if (!/^[0-9a-f-]{36}\.json$/.test(file)) continue;
      const path = join(directory, file);
      await changeJournal(path, current => {
        if (!current) throw new StorageError('corrupt');
        if (current.command.operation !== 'submit' || current.cleaned) return current;
        const query = terminal.find(item => item.executionRef === current.command.sessionId);
        return query ? { ...current, pendingCleanup: current.pendingCleanup ?? query } : current;
      });
    }
  }
  let cleaning: Promise<void> | undefined;
  async function clean() {
    if (cleaning) return cleaning;
    if (!cleanupNeeded) return;
    cleanupNeeded = false;
    cleaning = (async () => {
      try { await cleanup(); }
      finally { await persistCleanup(); }
    })().catch(error => { cleanupNeeded = true; throw error; }).finally(() => { cleaning = undefined; });
    return cleaning;
  }
  async function checkLease() {
    if (deadline && Date.now() >= deadline) { deadline = 0; await clean(); await acknowledgeCleanup(); }
  }
  async function report(command: z.infer<typeof claimedSchema>, result: z.infer<typeof journalSchema>['result']) {
    const acknowledged = z.object({ commandId: z.uuid(), state: z.literal('reported') }).parse(await options.call('report', {
      node, commandId: command.commandId, claimId: command.claimId, result,
    }));
    if (acknowledged.commandId !== command.commandId) throw new StorageError('forbidden');
    const observation = executionQuerySchema.safeParse(result);
    if (observation.success) acknowledgedObservations.set(observation.data.executionRef, digest(observation.data));
  }
  async function sendHeartbeat() {
    const queries = executor.snapshots().filter(query => observationGenerations.get(query.executionRef) === registration?.generation
      && acknowledgedObservations.get(query.executionRef) !== digest(query));
    if (!queries.length) return options.call('heartbeat', node);
    let reply: unknown;
    for (let index = 0; index < queries.length; index += 2) {
      const batch = queries.slice(index, index + 2);
      reply = z.object({ leaseMs: z.number().int().min(1000).max(60000) }).parse(await options.call('heartbeat', { node, queries: batch }));
      for (const observation of batch) acknowledgedObservations.set(observation.executionRef, digest(observation));
    }
    return reply;
  }
  async function acknowledgeCleanup() {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // Recovered reported journals still own their cleanup proof. Replay it before trying a
    // new epoch's registration, including when the current connection has been revoked.
    for (const file of await readdir(directory)) {
      if (!/^[0-9a-f-]{36}\.json$/.test(file)) continue;
      const path = join(directory, file), journal = journalSchema.parse(await readJson(path));
      if (!journal.pendingCleanup || journal.command.operation !== 'submit') continue;
      const { command, pendingCleanup: query } = journal;
      try {
        const reply = z.object({ commandId: z.uuid(), state: z.literal('cleaned') }).strict().parse(await options.call('cleanup', {
          node: command.node, commandId: command.commandId, claimId: command.claimId,
          owner: command.owner, generation: command.generation, query,
        }));
        if (reply.commandId !== command.commandId) throw new StorageError('forbidden');
        await changeJournal(path, current => {
          if (!current) throw new StorageError('corrupt');
          if (!current.pendingCleanup || digest(current.pendingCleanup) !== digest(query)) return current;
          const { pendingCleanup: _pending, ...acknowledged } = current;
          return { ...acknowledged, cleaned: true };
        });
      } catch { /* Retry without extending the local execution deadline. */ }
    }
  }
  async function tick() {
    if (closed) return;
    if (cleanupNeeded && !deadline) await clean();
    await persistCleanup();
    await acknowledgeCleanup();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const release = await acquireLock(options.root, `native-channel-${node.connectionId}`);
    try {
      const current = registrationSchema.parse(await options.call('register', node));
      if (digest({ connectionId: current.connectionId, nodeId: current.nodeId, installationId: current.installationId,
        platform: current.platform, supervisorEpoch: current.supervisorEpoch, adapters: current.adapters }) !== digest(node)
        || registration && digest(current.owner) !== digest(registration.owner)) {
        throw new StorageError('forbidden');
      }
      if (registration && current.generation !== registration.generation) { deadline = 0; await clean(); }
      registration = current;
      const renewed = z.object({ leaseMs: z.number().int().min(1000).max(60000) }).parse(await sendHeartbeat());
      deadline = Date.now() + renewed.leaseMs;
      for (const file of await readdir(directory)) {
        if (!/^[0-9a-f-]{36}\.json$/.test(file)) continue;
        const path = join(directory, file), journal = journalSchema.parse(await readJson(path));
        if (journal.state === 'reported') continue;
        if (digest(journal.command.owner) !== digest(current.owner) || journal.command.generation !== current.generation
          || digest(journal.command.node) !== digest(node)) {
          cleanupNeeded = true; await clean();
          await saveJournal(path, { ...journal, state: 'reported', result: { statusKnowledge: 'unknown', reason: 'owner-generation-changed' } });
          continue;
        }
        // 前一实例可能已经执行，或报告回包已丢失。沿用原 claim，只查询/报告原动作的未知状态。
        const result = journal.result ?? { statusKnowledge: 'unknown', reason: 'worker-restarted-after-dispatch' };
        await report(journal.command, result);
        await saveJournal(path, { ...journal, state: 'reported', result });
      }
      const reply = z.object({ command: claimedSchema.nullable(), leaseMs: z.number().int().min(1000).max(60000) })
        .parse(await options.call('claim', node));
      deadline = Date.now() + reply.leaseMs;
      if (!reply.command) return;
      const command = reply.command;
      if (digest(command.node) !== digest(node) || digest(command.owner) !== digest(current.owner)
        || command.generation !== current.generation) throw new StorageError('forbidden');
      const path = join(directory, `${command.commandId}.json`);
      if (await exists(path)) {
        const existing = journalSchema.parse(await readJson(path));
        if (digest(existing.command) !== digest(command)) throw new StorageError('identity-conflict');
        await report(command, existing.result ?? { statusKnowledge: 'unknown', reason: 'dispatch-already-recorded' });
        return;
      }
      await saveJournal(path, { command, state: 'dispatching' });
      // 登记/领取与实际派发之间再次检查批准连接及恢复代际。
      const checked = registrationSchema.parse(await options.call('register', node));
      if (digest(checked.owner) !== digest(current.owner) || checked.generation !== current.generation || closed) throw new StorageError('forbidden');
      const eligibility = z.object({ leaseMs: z.number().int().min(1000).max(60000) }).parse(await sendHeartbeat());
      if (closed) throw new StorageError('forbidden');
      deadline = Date.now() + eligibility.leaseMs;
      cleanupNeeded = true;
      observationGenerations.set(command.sessionId, current.generation);
      const { claimId: _claimId, node: _node, owner: _owner, generation: _generation, ...input } = command;
      let result: z.infer<typeof journalSchema>['result'];
      let renewing = false;
      const heartbeat = setInterval(() => {
        if (renewing || closed || !deadline) return;
        renewing = true;
        void sendHeartbeat().then(value => {
          if (closed || !deadline) return;
          const reply = z.object({ leaseMs: z.number().int().min(1000).max(60000) }).parse(value);
          deadline = Date.now() + reply.leaseMs;
        }).catch(async error => {
          if (error instanceof StorageError && error.code === 'forbidden') { deadline = 0; await clean(); }
          else await checkLease();
        }).finally(() => { renewing = false; });
      }, Math.max(250, Math.floor(checked.leaseMs / 3)));
      try { result = z.json().parse(await execute(input)); }
      catch { result = { statusKnowledge: 'unknown', reason: 'native-dispatch-unconfirmed' }; }
      finally { clearInterval(heartbeat); }
      result ??= { statusKnowledge: 'unknown', reason: 'native-dispatch-unconfirmed' };
      await saveJournal(path, { command, state: 'dispatching', result });
      await report(command, result);
      await saveJournal(path, { command, state: 'reported', result });
    } catch (error) {
      if (error instanceof StorageError && error.code === 'forbidden') { deadline = 0; await clean(); }
      else await checkLease();
      throw error;
    } finally { await release(); }
  }
  function cycle() {
    if (closed || inflight) return;
    inflight = tick().catch(() => undefined).finally(() => {
      inflight = undefined;
      if (!closed) timer = setTimeout(cycle, 500);
    });
  }
  return {
    tick,
    retryCleanup: acknowledgeCleanup,
    start() {
      if (watchdog || closed) return;
      watchdog = setInterval(() => { void checkLease().catch(() => undefined); }, 250);
      cycle();
    },
    async stop() {
      closed = true;
      if (timer) clearTimeout(timer);
      if (watchdog) clearInterval(watchdog);
      deadline = 0;
      await clean();
      await inflight;
      await clean();
      await acknowledgeCleanup();
    },
  };
}
