import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, rm, writeFile, lstat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

export interface ProcessOwner { pid: number; processIdentity: string }
let macBootIdentity: Promise<string> | undefined;

/** OS creation identity prevents a recycled PID from owning an old lease. */
export async function processIdentity(pid: number): Promise<string | null> {
  if (!alive(pid)) return null;
  try {
    let identity: string;
    if (process.platform === 'linux') {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      const startTicks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
      identity = `${await readFile('/proc/sys/kernel/random/boot_id', 'utf8')}:${startTicks}`;
    } else if (process.platform === 'win32') {
      const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`], { timeout: 5000, windowsHide: true });
      identity = stdout.trim();
    } else {
      const { stdout } = await promisify(execFile)('/bin/ps', ['-p', String(pid), '-o', 'lstart='],
        { timeout: 5000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } });
      macBootIdentity ??= promisify(execFile)('/usr/sbin/sysctl', ['-n', 'kern.boottime'],
        { timeout: 5000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } })
        .then(result => result.stdout.trim());
      identity = `${await macBootIdentity}:${stdout.trim()}`;
    }
    if (!identity) return null;
    // Only immutable OS creation metadata participates, never process.title/argv.
    return createHash('sha256').update(identity).digest('hex');
  } catch (error) {
    if (!alive(pid) || ['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
    throw error;
  }
}

export async function ownsProcess(owner: ProcessOwner): Promise<boolean> {
  return typeof owner.processIdentity === 'string' && await processIdentity(owner.pid) === owner.processIdentity;
}

export const alive = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

// Windows readers/virus scanners can briefly deny rename or reopening for write.
// EACCES/EPERM also include real permission failures: only retry for a bounded
// shared window, then preserve the error. Never unlink the destination to move.
async function retryWindowsSharing<T>(action: () => Promise<T>, deadline: number): Promise<T> {
  let pauseMs = 10;
  for (;;) {
    try { return await action(); }
    catch (error) {
      const remaining = deadline - Date.now();
      if (process.platform !== 'win32' || remaining <= 0
        || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await delay(Math.min(pauseMs, remaining));
      if (Date.now() >= deadline) throw error;
      pauseMs = Math.min(pauseMs * 2, 100);
    }
  }
}

/**
 * Publish complete JSON only after its file sync, then sync the POSIX parent.
 * A rejection after rename has an unknown publication outcome: reread the
 * original operation identity instead of assuming the previous value survived.
 * Callers must prepare the parent; creation of its ancestors is not synced here.
 *
 * On Windows sync uses FlushFileBuffers. Reopen/sync the published file to
 * flush its changed metadata for every caller, including authority changes;
 * syncing only the temporary before rename does not request that barrier.
 * Node exposes no Windows directory sync; this does not flush newly created
 * ancestors or claim tested power-loss survival on arbitrary filesystems/devices.
 * Do not suppress ordinary I/O errors, including the post-publication sync.
 * https://learn.microsoft.com/en-us/windows/win32/fileio/file-caching
 * https://github.com/postgres/postgres/blob/REL_18_STABLE/src/common/file_utils.c
 * https://github.com/libuv/libuv/blob/v1.52.1/src/win/fs.c
 */
export async function atomicJson(path: string, value: unknown): Promise<void> {
  const data = JSON.stringify(value, null, 2) + '\n';
  const temporary = `${path}.${randomUUID()}.tmp`;
  // An unsuccessful exclusive open must not remove somebody else's file.
  const file = await open(temporary, 'wx', 0o600);
  let directory: FileHandle | undefined;
  let published: FileHandle | undefined;
  try {
    await file.writeFile(data);
    await file.sync();
    await file.close();
    // One retry budget covers rename and the published-file flush together.
    const sharingDeadline = Date.now() + 2_000;
    await retryWindowsSharing(() => rename(temporary, path), sharingDeadline);
    if (process.platform === 'win32') {
      // FlushFileBuffers needs GENERIC_WRITE. Reopen by the new name after
      // rename, as in PostgreSQL's durable_rename, not via a read-only handle.
      published = await retryWindowsSharing(() => open(path, 'r+'), sharingDeadline);
      await retryWindowsSharing(() => published!.sync(), sharingDeadline);
      await published.close();
    } else {
      directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
      await directory.sync();
      await directory.close();
    }
  } catch (error) {
    const failures = [error];
    // Close before unlinking on Windows. Keep the original write/sync failure
    // visible even if closing or removing the owned temporary also fails.
    for (const cleanup of [() => published?.close(), () => directory?.close(), () => file.close(), () => rm(temporary, { force: true })]) {
      try { await cleanup(); } catch (failure) { failures.push(failure); }
    }
    if (failures.length > 1) throw new AggregateError(failures, 'Atomic JSON write and cleanup failed.');
    throw error;
  }
}

export async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

export async function initializeRoot(root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  if ((await lstat(root)).isSymbolicLink()) throw new Error('Environment root cannot be a symbolic link.');
  if (await exists(join(root, '.xunjie-root'))) { await assertRoot(root); return; }
  const contents = await readdir(root);
  if (contents.length && !await exists(join(root, '.xunjie-root'))) throw new Error('Directory is occupied; select an empty product environment directory.');
  try { await writeFile(join(root, '.xunjie-root'), 'XunJie product environment v1\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  await assertRoot(root);
}

export async function assertRoot(root: string): Promise<void> {
  if (await readFile(join(root, '.xunjie-root'), 'utf8') !== 'XunJie product environment v1\n') {
    throw new Error('Not a product environment.');
  }
  if ((await lstat(root)).isSymbolicLink()) throw new Error('Environment root cannot be a symbolic link.');
}

export async function removeOwned(root: string, name: string): Promise<void> {
  const target = resolve(root, name);
  if (target !== join(resolve(root), name) || name.includes('/') || name.includes('\\')) throw new Error('Invalid owned path.');
  if (await exists(target) && (await lstat(target)).isSymbolicLink()) throw new Error(`Refusing symbolic link: ${name}`);
  await rm(target, { recursive: true, force: true });
}

interface LockEntry extends ProcessOwner { ticket: number | null }

// A filesystem bakery lock uses a unique file per contender. A stale contender
// is ignored by PID liveness, never by elapsed time (sleep is not process death).
// No contender unlinks or replaces another live contender's lock.
export async function acquireLock(root: string, scope: string, timeoutMs = 60_000): Promise<() => Promise<void>> {
  const directory = join(root, '.locks', scope);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const path = join(directory, `${id}.json`);
  const entries = async () => {
    const result: Array<[string, LockEntry]> = [];
    for (const name of await readdir(directory)) {
      if (!name.endsWith('.json')) continue;
      let entry: LockEntry;
      try { entry = await readJson<LockEntry>(join(directory, name)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      if (await ownsProcess(entry)) result.push([name, entry]);
      else await rm(join(directory, name), { force: true });
    }
    return result;
  };
  const identity = await processIdentity(process.pid);
  if (!identity) throw new Error('Cannot determine this process creation identity.');
  await atomicJson(path, { pid: process.pid, processIdentity: identity, ticket: null });
  try {
    const ticket = Math.max(0, ...(await entries()).map(([, value]) => value.ticket ?? 0)) + 1;
    await atomicJson(path, { pid: process.pid, processIdentity: identity, ticket });
    const deadline = Date.now() + timeoutMs;
    while ((await entries()).some(([name, other]) => name !== `${id}.json`
      && (other.ticket === null || other.ticket < ticket || (other.ticket === ticket && name < `${id}.json`)))) {
      if (Date.now() > deadline) throw new Error(`Environment ${scope} is occupied by another live process.`);
      await delay(50);
    }
    return async () => { await rm(path, { force: true }); };
  } catch (error) { await rm(path, { force: true }); throw error; }
}

export async function withLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  const release = await acquireLock(root, 'operation');
  try { return await action(); } finally { await release(); }
}
