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
    const output = spawnSync(command[0], command[1], { encoding: 'utf8', windowsHide: true }).stdout;
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

// A ticket is only trustworthy while its owner keeps refreshing it and the
// recorded pid still belongs to the same process. Waiting also has a hard
// deadline, so a stuck build fails loudly instead of hanging forever.
const lockTiming = (env = process.env) => ({
  heartbeatMs: milliseconds(env.XUNJIE_BUILD_LOCK_HEARTBEAT_MS, 15_000),
  staleMs: milliseconds(env.XUNJIE_BUILD_LOCK_STALE_MS, 120_000),
  pollMs: milliseconds(env.XUNJIE_BUILD_LOCK_POLL_MS, 50),
  waitMs: milliseconds(env.XUNJIE_BUILD_LOCK_WAIT_MS, 600_000),
});

// Lamport's bakery lock: every contender owns a unique ticket. A dead ticket
// is ignored, never unlinked by another contender, so stale takeover has no
// read-token/unlink race that could delete a newly acquired owner's lock.
async function lock(cache, signal) {
  const directory = join(cache, 'locks');
  await mkdir(directory, { recursive: true });
  const host = digest(hostname()).slice(0, 16);
  const id = `${host}-${process.pid}-${randomUUID()}`;
  const path = join(directory, `${id}.json`);
  const { heartbeatMs, staleMs, pollMs, waitMs } = lockTiming();
  const owner = { pid: process.pid, host, choosing: true, number: 0, start: processStart(process.pid),
    createdAt: Date.now(), updatedAt: Date.now() };
  async function publish() {
    owner.updatedAt = Date.now();
    const temporary = `${path}.tmp`;
    try { await writeFile(temporary, JSON.stringify(owner)); await rename(temporary, path); }
    finally { await rm(temporary, { force: true }); }
  }
  async function peers(now = Date.now()) {
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
      // A ticket that is still being refreshed proves its owner is alive, so
      // the start marker (a process read on macOS/Windows) is only consulted
      // for aged tickets, where it tells pid reuse from a stopped owner.
      const owned = aged
        ? (alive(peer.pid) && sameStart(peer.pid, peer.start))
          || (alive(peer.childPid) && sameStart(peer.childPid, peer.childStart))
        : alive(peer.pid) || alive(peer.childPid);
      result.push({ id: peerId, ...peer, owned, stale: aged || !owned });
    }
    return result;
  }
  // Creation is atomic; other contenders never observe a partially written owner.
  await publish();
  let heartbeat;
  try {
    owner.number = 1 + Math.max(0, ...(await peers()).filter(peer => !peer.stale).map(peer => peer.number));
    owner.choosing = false;
    await publish();
    const started = Date.now();
    while (true) {
      signal?.throwIfAborted();
      const now = Date.now();
      const blocking = (await peers(now)).filter(peer => !peer.stale
        && (peer.choosing || peer.number < owner.number || (peer.number === owner.number && peer.id < id)));
      if (!blocking.length) break;
      if (now - started > waitMs) throw new Error(`Timed out after ${waitMs}ms waiting for the build lock`
        + ` (blocked by ${blocking.map(peer => `${peer.id} pid ${peer.pid}`).join(', ')}).`
        + ` Tickets are treated as dead ${staleMs}ms after their last refresh; inspect ${directory}.`);
      await delay(pollMs, undefined, { signal });
    }
    // Refreshing proves liveness for as long as the lock is held; a killed
    // owner leaves a ticket that ages out instead of blocking forever.
    heartbeat = setInterval(() => { publish().catch(() => {}); }, heartbeatMs);
    heartbeat.unref?.();
    // Only the owner unlinks tickets, and only those its own liveness check
    // proves dead, so no contender can delete a ticket that was just published.
    for (const peer of (await peers()).filter(peer => peer.stale && !peer.owned)) {
      await rm(join(directory, `${peer.id}.json`), { force: true });
    }
    return {
      async child(pid) { owner.childPid = pid; owner.childStart = processStart(pid); await publish(); },
      async release() { clearInterval(heartbeat); await rm(path, { force: true }); },
    };
  } catch (error) { clearInterval(heartbeat); await rm(path, { force: true }); throw error; }
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
