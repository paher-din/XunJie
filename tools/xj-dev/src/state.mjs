import { existsSync, mkdirSync, mkdtempSync, lstatSync, linkSync, openSync, readSync, readFileSync, rmSync, writeFileSync, closeSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { CliError } from './envelope.mjs';

export function loadState(envPaths) {
  if (!existsSync(envPaths.stateFile)) return undefined;
  try {
    return JSON.parse(readFileSync(envPaths.stateFile, 'utf8'));
  } catch {
    throw new CliError('environment', 'STATE_CORRUPT',
      `环境状态文件无法解析：${envPaths.stateFile}`,
      { recovery: '保留环境与永久锁守卫，核对归属并修复该 JSON；有效登记的环境需重建时使用 xj-dev delete 后 up，不手工删除根目录。' });
  }
}

export function writeJsonAtomic(file, value, mode = 0o600) {
  const temporary = file + '.tmp';
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode });
  renameSync(temporary, file);
}

export function saveState(envPaths, state) {
  mkdirSync(envPaths.root, { recursive: true });
  writeJsonAtomic(envPaths.stateFile, state);
}

export function acquireLock(envPaths) {
  mkdirSync(envPaths.root, { recursive: true });
  let db;
  try {
    // The directory also blocks 0.1.0 clients: their non-recursive stale-file
    // rmSync cannot unlink our OS-locked database and create a second inode.
    try { mkdirSync(envPaths.lockFile, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const entry = lstatSync(envPaths.lockFile);
    if (!entry.isDirectory() || entry.isSymbolicLink()) rejectOldLock(envPaths.lockFile, entry);

    // CLI modules are loaded before runtime redirection. Do not statically
    // import node:sqlite, which may not exist on the bootstrap Node.
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const file = join(envPaths.lockFile, 'mutex.sqlite');
    if (!existsSync(file)) initializeLockDatabase(DatabaseSync, envPaths.lockFile, file);
    validateLockFile(file);
    const reader = new DatabaseSync(file, { readOnly: true });
    try { validateLockDatabase(reader); } finally { reader.close(); }
    db = new DatabaseSync(file);
    validateLockDatabase(db);
    db.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE');
    let released = false;
    return {
      token: `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      release() {
        if (released) return;
        db.close(); // Rolls back the empty transaction; never deletes any path.
        released = true;
      },
    };
  } catch (error) {
    db?.close();
    if (error instanceof CliError) throw error;
    if ([5, 6].includes(error.errcode & 0xff)) {
      throw new CliError('lock', 'LOCK_HELD', '另一个进程正在操作该环境。',
        { retryable: true, recovery: '等待其完成后重试；进程退出会自动释放锁，请勿删除锁目录。' });
    }
    throw new CliError('lock', 'LOCK_UNSAFE', `环境锁无法安全打开：${envPaths.lockFile}（${error.message}）`,
      { recovery: '保留现场，检查锁路径、权限与受管 Node 24.21.0；停止所有旧版 CLI 后按 README 处理，勿删除业务数据。' });
  }
}

const LOCK_APPLICATION_ID = 0x584a4c4b; // XJLK, distinct from any business DB.
const LOCK_FORMAT = 'xj-dev/operation-lock-v1';

function unsafeLock(message) {
  throw new CliError('lock', 'LOCK_UNSAFE', message,
    { recovery: '不自动删除或改写未知锁。停止所有相关 CLI 后检查并保留该对象，按 README 恢复。' });
}

function rejectOldLock(file, entry) {
  if (entry.isFile() && entry.size <= 4096) {
    let holder;
    try { holder = JSON.parse(readFileSync(file, 'utf8')); } catch { /* Unknown or still being written. */ }
    if (Number.isInteger(holder?.pid) && holder.pid > 0 && typeof holder.token === 'string'
      && holder.token && typeof holder.at === 'string' && Number.isFinite(Date.parse(holder.at))) {
      if (processAlive(holder.pid)) {
        throw new CliError('lock', 'LOCK_HELD', `旧版 CLI 进程（pid ${holder.pid}）仍持有环境锁。`,
          { retryable: true, recovery: '等待旧版进程退出，并停止所有旧版 CLI，再按 README 显式迁移旧锁。' });
      }
      throw new CliError('lock', 'LOCK_LEGACY', `环境存在旧版 JSON 锁：${file}`,
        { recovery: '停止所有旧版 CLI，确认无操作后将此文件移到锁路径之外保留，再以新版 CLI 重试。' });
    }
  }
  unsafeLock(`环境锁路径不是本工具锁目录，或旧锁未知/损坏/尚未写完：${file}`);
}

function initializeLockDatabase(DatabaseSync, directory, file) {
  // Publish only a fully committed DB. linkSync is atomic and never replaces an
  // existing name, so competing creators all converge on one permanent inode.
  const temporary = mkdtempSync(join(directory, '.initialize-'));
  let db;
  try {
    const source = join(temporary, 'mutex.sqlite');
    db = new DatabaseSync(source);
    db.exec(`PRAGMA application_id = ${LOCK_APPLICATION_ID};
      CREATE TABLE xj_dev_lock (format TEXT NOT NULL);
      INSERT INTO xj_dev_lock VALUES ('${LOCK_FORMAT}');`);
    db.close();
    db = undefined;
    try { linkSync(source, file); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  } finally {
    db?.close();
    rmSync(temporary, { recursive: true, force: true });
  }
}

function validateLockFile(file) {
  const entry = lstatSync(file);
  if (!entry.isFile() || entry.isSymbolicLink()) unsafeLock(`锁数据库不是普通文件：${file}`);
  const header = Buffer.alloc(100);
  const fd = openSync(file, 'r');
  try { readSync(fd, header, 0, header.length, 0); } finally { closeSync(fd); }
  if (header.subarray(0, 16).toString() !== 'SQLite format 3\0'
    || header.readUInt32BE(68) !== LOCK_APPLICATION_ID || header[18] !== 1 || header[19] !== 1) {
    unsafeLock(`拒绝未知、损坏或非工具 SQLite 锁：${file}`);
  }
  // This mutex never writes after initialization and cannot create sidecars.
  // Do not let SQLite recovery modify unknown journals or WAL files.
  for (const suffix of ['-journal', '-wal', '-shm']) {
    try { lstatSync(file + suffix); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    unsafeLock(`锁数据库存在非预期的附属文件：${file + suffix}`);
  }
}

function validateLockDatabase(db) {
  const objects = db.prepare('SELECT type, name FROM sqlite_schema').all();
  if (objects.length !== 1 || objects[0].type !== 'table' || objects[0].name !== 'xj_dev_lock') {
    unsafeLock('锁数据库结构不属于本工具。');
  }
  const rows = db.prepare('SELECT format FROM xj_dev_lock').all();
  if (rows.length !== 1 || rows[0].format !== LOCK_FORMAT) unsafeLock('锁数据库格式不属于本工具。');
}

export function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
