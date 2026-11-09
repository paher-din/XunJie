import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { StorageError } from '@xunjie/storage';
import { nativeChannelNodeSchema } from '@xunjie/learning-space';
import type { RuntimeEnvironment } from '@xunjie/contracts/product-runtime';
import type { NativeSessionHostOptions } from '@xunjie/learning-space';
import type { RuntimeResources } from './postgres.js';
import { verifyWindowsSessionHelper } from './prerequisites.js';
import { nativeChannelNode } from './native-channel-executor.js';
import { createNativeChannelWorker } from './native-channel-worker.js';
import { readJson } from './io.js';

type Operation = 'register' | 'claim' | 'report' | 'heartbeat' | 'cleanup';

/** 复用学校已批准连接；本机仅保管领取日志，不创建学习数据数据库。 */
export async function createNativeChannelClients(options: {
  root: string;
  environment: RuntimeEnvironment;
  resources: RuntimeResources;
  client: {
    list(): Promise<{ key: string; cleanupEndpoint?: string; directLocalExecution?: boolean }[]>;
    nativeChannelCall(connectionId: string, operation: Operation, input: unknown): Promise<unknown>;
  };
}) {
  const workers = new Map<string, ReturnType<typeof createNativeChannelWorker>>();
  let active = false, closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let pending: Promise<void> | undefined;
  let transition = Promise.resolve();
  const native: NativeSessionHostOptions = {
    nodePath: options.resources.nodePath,
    sessionRoot: join(options.root, 'native-sessions'),
    windowsHelper: await verifyWindowsSessionHelper(options.resources),
  };
  async function retryPersistedCleanup() {
    const root = join(options.root, 'native-channel');
    const directories = await readdir(root, { withFileTypes: true }).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    });
    for (const directory of directories) {
      if (!active || closed) return;
      const connectionId = directory.name;
      if (!directory.isDirectory() || !/^[0-9a-f-]{36}$/.test(connectionId) || workers.has(connectionId)) continue;
      for (const file of await readdir(join(root, connectionId))) {
        if (!/^[0-9a-f-]{36}\.json$/.test(file)) continue;
        const journal = await readJson<{ pendingCleanup?: unknown; command?: { node?: unknown } }>(join(root, connectionId, file));
        if (!journal.pendingCleanup) continue;
        const node = nativeChannelNodeSchema.parse(journal.command?.node);
        if (node.connectionId !== connectionId) throw new StorageError('corrupt');
        // A recovery relay needs neither a current grant nor a local adapter. It can only
        // submit existing cleanup proofs; it never registers or claims an executable action.
        const relay = createNativeChannelWorker({ root: options.root, node,
          call: (operation, input) => {
            if (operation !== 'cleanup') throw new StorageError('forbidden');
            return options.client.nativeChannelCall(connectionId, 'cleanup', input);
          } });
        await relay.retryCleanup();
        break;
      }
    }
  }
  async function reconcile() {
    await retryPersistedCleanup();
    const connections = await options.client.list();
    if (!active || closed) return;
    const ids = new Set(connections.filter(item => !item.directLocalExecution).map(item => item.key).filter(key => /^school:[0-9a-f-]{36}$/.test(key))
      .map(key => key.slice('school:'.length)));
    for (const [id, worker] of workers) {
      if (ids.has(id)) continue;
      await worker.stop();
      workers.delete(id);
    }
    for (const connectionId of ids) {
      if (!active || closed) return;
      if (workers.has(connectionId)) continue;
      const node = await nativeChannelNode({ ...native, connectionId, installationId: options.environment.installationId,
        supervisorEpoch: randomUUID() }).catch(() => undefined);
      if (!node?.adapters.length || !active || closed) continue;
      const worker = createNativeChannelWorker({ root: options.root, node, native,
        cleanupEndpoint: connections.find(item => item.key === `school:${connectionId}`)?.cleanupEndpoint,
        call: (operation, input) => options.client.nativeChannelCall(connectionId, operation, input) });
      workers.set(connectionId, worker);
      worker.start();
    }
  }
  function poll() {
    if (!active || closed || pending) return;
    pending = reconcile().finally(() => { pending = undefined; });
    void pending.catch(() => undefined);
  }
  async function pause() {
    active = false;
    if (timer) clearInterval(timer);
    timer = undefined;
    await pending?.catch(() => undefined);
    const results = await Promise.allSettled([...workers.values()].map(worker => worker.stop()));
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), '原生领取会话尚未确认清理。');
    workers.clear();
  }
  function serialize(action: () => Promise<void>) {
    const result = transition.then(action);
    transition = result.catch(() => undefined);
    return result;
  }
  return {
    pause: () => serialize(pause),
    resume: () => serialize(async () => {
      if (active || closed) return;
      active = true;
      poll();
      timer = setInterval(poll, 1000);
      timer.unref();
    }),
    close: () => serialize(async () => { closed = true; await pause(); }),
  };
}
