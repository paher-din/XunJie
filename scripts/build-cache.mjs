import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import { mkdir, open, readdir, readFile, rename, rm, stat, lstat, readlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const schema = 1;
const slash = path => path.split('\\').join('/');
export const digest = value => createHash('sha256').update(value).digest('hex');

// Names as well as bytes are hashed: additions, deletions and empty directories
// are observable. Neither checkout paths nor mtimes enter persisted identities.
export async function contentManifest(root, paths, { exclude = () => false, required = false } = {}) {
  const entries = [];
  async function visit(path) {
    const name = slash(relative(root, path)) || '.';
    if (exclude(name)) return;
    let info;
    try { info = await lstat(path); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (required) throw new Error(`Missing build output: ${name}`);
      entries.push([name, 'missing']);
      return;
    }
    if (info.isSymbolicLink()) {
      entries.push([name, 'link', await readlink(path)]);
      // Include the referent too; editing linked source must invalidate it.
      const target = await stat(path);
      if (target.isFile()) entries.push([name, digest(await readFile(path))]);
      else throw new Error(`Directory symlink is not a supported build input: ${name}`);
    } else if (info.isDirectory()) {
      entries.push([name, 'directory']);
      for (const child of (await readdir(path)).sort()) await visit(join(path, child));
    } else if (info.isFile()) {
      entries.push([name, digest(await readFile(path)), info.mode & 0o111]);
    } else throw new Error(`Unsupported build file: ${name}`);
  }
  for (const path of [...new Set(paths)].sort()) await visit(resolve(root, path));
  return entries;
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (['ENOENT', 'SyntaxError'].includes(error.code ?? error.name)) return undefined; throw error; }
}

// Operating systems reuse pids, so process.kill(pid, 0) can answer for an
// unrelated process. A start marker read back from the live pid tells the two
// apart; platforms without one fall back to liveness alone. Results are cached
// briefly because contenders poll the lock directory while they wait.
const startCache = new Map();
function readProcessStart(pid, platform = process.platform) {
  try {
    if (platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // Field 22 (starttime) follows the parenthesised command name.
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    }
    const command = platform === 'win32'
      ? ['powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.ToString('o')`]]
      : ['ps', ['-o', 'lstart=', '-p', String(pid)]];
    const output = spawnSync(command[0], command[1], { encoding: 'utf8', windowsHide: true,
      env: { ...process.env, LC_ALL: 'C' } }).stdout;
    return output?.trim() || undefined;
  } catch { return undefined; }
}
function processStart(pid, platform = process.platform) {
  if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
  const key = `${platform}:${pid}`;
  const cached = startCache.get(key);
  if (cached && Date.now() - cached.at < 1_000) return cached.value;
  const value = readProcessStart(pid, platform);
  startCache.set(key, { value, at: Date.now() });
  return value;
}
const sameStart = (pid, recorded) => {
  if (recorded === undefined) return true;
  const actual = processStart(pid);
  return actual === undefined || actual === recorded;
};

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

function milliseconds(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// A ticket is trustworthy while its owner keeps refreshing it and the recorded
// pid still belongs to the same process. Only a ticket whose owner is provably
// gone is ever ignored: taking over a merely old one would let two builds run
// at once. Waiting keeps a hard deadline, so a stuck build fails loudly with a
// diagnosis instead of hanging forever.
export const lockTiming = (env = process.env) => {
  const heartbeatMs = milliseconds(env.XUNJIE_BUILD_LOCK_HEARTBEAT_MS, 15_000);
  // A live owner refreshes every heartbeatMs, so a ticket must be allowed to
  // miss several refreshes before anyone is allowed to doubt it.
  const staleMs = Math.max(milliseconds(env.XUNJIE_BUILD_LOCK_STALE_MS, 120_000), heartbeatMs * 4);
  // The deadline only bounds a wait held by a live owner, so it can never
  // expire before a ticket could have aged out.
  const waitMs = Math.max(milliseconds(env.XUNJIE_BUILD_LOCK_WAIT_MS, 600_000), staleMs * 2);
  return { heartbeatMs, staleMs, waitMs, pollMs: milliseconds(env.XUNJIE_BUILD_LOCK_POLL_MS, 50),
    startVerifyMs: milliseconds(env.XUNJIE_BUILD_LOCK_START_VERIFY_MS, 500) };
};

// Lamport's bakery lock: every contender owns a unique ticket, including while
// it waits, and refreshes it until it releases. Only a ticket whose owner is
// provably gone is ignored, so a merely old ticket can never let two builds
// into the critical section at once.
async function lock(cache, signal) {
  const directory = join(cache, 'locks');
  await mkdir(directory, { recursive: true });
  const host = digest(hostname()).slice(0, 16);
  const id = `${host}-${process.pid}-${randomUUID()}`;
  const path = join(directory, `${id}.json`);
  const { heartbeatMs, staleMs, pollMs, waitMs, startVerifyMs } = lockTiming();
  const owner = { pid: process.pid, host, choosing: true, number: 0, start: processStart(process.pid),
    createdAt: Date.now(), updatedAt: Date.now() };
  let queue = Promise.resolve();
  let released = false;
  let heartbeat;
  async function publish() {
    if (released) return;
    owner.updatedAt = Date.now();
    const snapshot = JSON.stringify(owner);
    // Serialised, and written through a unique temporary name: a heartbeat must
    // neither interleave with itself nor race the unlink in release().
    const next = queue.then(async () => {
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, snapshot);
        // Windows can briefly refuse replacement while a reader/scanner holds
        // the previous ticket. Keep that ticket intact and retry atomically;
        // never unlink a live owner to make publication succeed.
        for (let attempt = 0; ; attempt++) {
          try { await rename(temporary, path); break; }
          catch (error) {
            if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 10) throw error;
            await delay(50, undefined, { signal });
          }
        }
      }
      finally { await rm(temporary, { force: true }); }
    });
    queue = next.catch(() => {});
    return next;
  }
  /**
   * `verifyStart` asks every ticket to be checked against the start marker of
   * its pid. That costs a process read on macOS and Windows, so it is only
   * done once waiting long enough for pid reuse to be worth ruling out.
   */
  async function peers({ now = Date.now(), verifyStart = false } = {}) {
    const result = [];
    for (const name of await readdir(directory)) {
      if (!name.endsWith('.json') || name === `${id}.json`) continue;
      const peerId = name.slice(0, -5);
      if (!peerId.startsWith(`${host}-`)) continue;
      const peer = await readJson(join(directory, name));
      if (!peer) continue;
      const refreshed = peer.updatedAt ?? peer.createdAt;
      // Tickets written before refresh timestamps existed cannot be aged; they
      // fall back to the liveness check alone.
      const aged = refreshed === undefined ? false : now - refreshed > staleMs;
      // A refreshing ticket proves its owner is alive, so the start marker only
      // matters for aged tickets, where it tells pid reuse from a slow owner.
      const owned = aged || verifyStart
        ? (alive(peer.pid) && sameStart(peer.pid, peer.start)) || alive(peer.childPid)
        : alive(peer.pid) || alive(peer.childPid);
      result.push({ id: peerId, ...peer, owned, aged });
    }
    return result;
  }
  const drop = async () => {
    clearInterval(heartbeat);
    released = true;
    await queue;
    await rm(path, { force: true });
  };
  // Creation is atomic; other contenders never observe a partially written owner.
  await publish();
  let warned = false;
  // Refreshing starts before taking a number, not after winning: a waiter that
  // stopped refreshing would look dead and be overtaken while it still queues.
  heartbeat = setInterval(() => {
    publish().catch(error => {
      if (warned) return;
      warned = true;
      console.warn(`[build] lock ticket could not be refreshed (${error.message}); this build may be overtaken.`);
    });
  }, heartbeatMs);
  heartbeat.unref?.();
  try {
    owner.number = 1 + Math.max(0, ...(await peers()).filter(peer => peer.owned).map(peer => peer.number));
    owner.choosing = false;
    await publish();
    const started = Date.now();
    while (true) {
      signal?.throwIfAborted();
      const now = Date.now();
      const elapsed = now - started;
      const blocking = (await peers({ now, verifyStart: elapsed > startVerifyMs }))
        .filter(peer => peer.owned
          && (peer.choosing || peer.number < owner.number || (peer.number === owner.number && peer.id < id)));
      if (!blocking.length) break;
      if (elapsed > waitMs) throw new Error(`Timed out after ${waitMs}ms waiting for the build lock`
        + ` (blocked by ${blocking.map(peer => `${peer.id} pid ${peer.pid}`).join(', ')}).`
        + ` A ticket is released when its owner is gone; inspect ${directory}.`);
      await delay(pollMs, undefined, { signal });
    }
    // Only the owner unlinks tickets, and only those its own liveness check
    // proves dead, so no contender can delete a ticket that was just published.
    for (const peer of (await peers({ verifyStart: true })).filter(peer => !peer.owned)) {
      await rm(join(directory, `${peer.id}.json`), { force: true });
    }
    return {
      async child(pid) { owner.childPid = pid; await publish(); },
      async release() { await drop(); },
    };
  } catch (error) { await drop(); throw error; }
}

export async function runCommand(binary, args, { cwd, env = process.env, signal, onChild = async () => {} } = {}) {
  signal?.throwIfAborted();
  const child = spawn(binary, args, { cwd, env, stdio: 'inherit', detached: process.platform !== 'win32', windowsHide: true });
  let stopTimer;
  const kill = force => {
    if (!child.pid) return;
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    } else {
      try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  };
  const abort = () => {
    kill(false);
    stopTimer = setTimeout(() => kill(true), 1500);
    stopTimer.unref();
  };
  const completed = new Promise((accept, reject) => {
    child.once('error', reject);
    child.once('close', (code, childSignal) => {
      if (code === 0) accept();
      else reject(new Error(`Build command failed (${childSignal ?? code}): ${binary} ${args.join(' ')}`));
    });
  });
  // Attach a rejection handler before awaiting lock bookkeeping.
  completed.catch(() => {});
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    await onChild(child.pid);
    await completed;
    signal?.throwIfAborted();
  } finally {
    if (signal?.aborted) kill(true);
    clearTimeout(stopTimer);
    signal?.removeEventListener('abort', abort);
    await onChild(undefined);
  }
}

/** Run a dependency graph under one cross-process output lock. Tests are never tasks. */
export async function runBuildGraph({ root, tasks, targets, force = false, signal, env = process.env, log = console.log }) {
  const cache = join(root, '.cache/xunjie-build');
  const lease = await lock(cache, signal);
  const results = new Map();
  const visiting = new Set();
  try {
    async function ensure(id) {
      if (results.has(id)) return results.get(id);
      if (visiting.has(id)) throw new Error(`Build dependency cycle: ${id}`);
      const task = tasks[id];
      if (!task) throw new Error(`Unknown build task: ${id}`);
      visiting.add(id);
      const upstream = [];
      for (const dependency of task.deps ?? []) upstream.push([dependency, await ensure(dependency)]);
      signal?.throwIfAborted();
      const fingerprint = async () => digest(JSON.stringify({ schema, id, input: await task.fingerprint(), upstream }));
      const key = await fingerprint();
      const marker = join(cache, `${id.replaceAll(':', '--')}.json`);
      const entry = await readJson(marker);
      const outputs = async () => contentManifest(root, task.outputs ?? [], { required: true });
      let manifest;
      try { manifest = await outputs(); }
      catch { /* Missing outputs are a miss, not proof of an earlier success. */ }
      if (task.cache !== false && !force && entry?.schema === schema && entry.key === key && manifest && JSON.stringify(entry.outputs) === JSON.stringify(manifest)) {
        log(`[build] HIT ${id}`);
      } else {
        log(`[build] RUN ${id}`);
        await rm(marker, { force: true });
        signal?.throwIfAborted();
        const run = (binary, args, options = {}) => runCommand(binary, args, { cwd: root, env, ...options, signal, onChild: pid => lease.child(pid) });
        await task.run({ run, signal, env });
        signal?.throwIfAborted();
        if (await fingerprint() !== key) throw new Error(`Build inputs changed while running ${id}; run again.`);
        manifest = await outputs();
        for (const path of task.requiredOutputs ?? []) await contentManifest(root, [path], { required: true });
        if (task.cache !== false) {
          const temporary = `${marker}.${process.pid}.${randomUUID()}.tmp`;
          try {
            await mkdir(dirname(marker), { recursive: true });
            await writeFile(temporary, JSON.stringify({ schema, key, outputs: manifest }) + '\n');
            signal?.throwIfAborted();
            await rename(temporary, marker);
          } finally { await rm(temporary, { force: true }); }
        }
      }
      const result = digest(JSON.stringify({ key, outputs: manifest }));
      results.set(id, result);
      visiting.delete(id);
      return result;
    }
    for (const id of targets) await ensure(id);
    return Object.fromEntries(results);
  } finally { await lease.release(); }
}
