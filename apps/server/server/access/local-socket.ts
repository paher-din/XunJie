// Generic Unix control endpoint ownership. No developer-service dependencies.
import { DatabaseSync } from 'node:sqlite';
import { createConnection, type Server } from 'node:net';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const APPLICATION_ID = 0x584a534c;
const FORMAT = 'xunjie/local-socket-v1';
type Identity = { dev: number; ino: number };
type Receipt = Identity & { format: string; boundPath: string };
function conflict(): never { throw new Error('LOCAL_SOCKET_CONFLICT'); }
function identity(path: string): Identity | undefined {
  try { const s = lstatSync(path); return { dev: s.dev, ino: s.ino }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
}
function same(path: string, owned: Identity) { const s = identity(path); return s?.dev === owned.dev && s?.ino === owned.ino; }
function ownedFile(path: string) {
  const s = lstatSync(path);
  if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid?.() || s.mode & 0o077) conflict();
}
function lock(path: string) {
  // Publish a fully initialized permanent inode. Never remove/recreate the
  // mutex: the kernel releases its SQLite lock even after SIGKILL.
  if (!existsSync(path)) {
    const temporary = path + '.' + randomBytes(8).toString('hex');
    let initial: DatabaseSync | undefined;
    try {
      initial = new DatabaseSync(temporary); chmodSync(temporary, 0o600);
      initial.exec(`PRAGMA application_id=${APPLICATION_ID}; CREATE TABLE socket_mutex(format TEXT); INSERT INTO socket_mutex VALUES ('${FORMAT}');`);
      initial.close(); initial = undefined;
      try { linkSync(temporary, path); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    } finally { initial?.close(); rmSync(temporary, { force: true }); }
  }
  ownedFile(path);
  const header = readFileSync(path).subarray(0, 100);
  if (header.length !== 100 || header.subarray(0, 16).toString() !== 'SQLite format 3\0' || header.readUInt32BE(68) !== APPLICATION_ID) conflict();
  if (['-journal', '-wal', '-shm'].some(suffix => existsSync(path + suffix))) conflict();
  const db = new DatabaseSync(path);
  try {
    if (db.prepare('PRAGMA application_id').get()?.application_id !== APPLICATION_ID ||
      db.prepare('SELECT format FROM socket_mutex').get()?.format !== FORMAT) conflict();
    db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
    return db;
  } catch (error) { db.close(); throw error; }
}
function refused(path: string) {
  return new Promise<boolean>(resolve => {
    const socket = createConnection(path);
    socket.setTimeout(500);
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', (error: NodeJS.ErrnoException) => { socket.destroy(); resolve(error.code === 'ECONNREFUSED'); });
  });
}
export function localSocket(path: string) {
  let mutex: DatabaseSync | undefined, published: Identity | undefined, boundPath: string | undefined;
  const receiptPath = path + '.owner.json';
  let listening = false, closed = false;
  return {
    async listen(server: Server, mode: number, gid?: number) {
      if (closed || mutex) conflict();
      mkdirSync(dirname(path), { recursive: true, mode: 0o750 });
      mutex = lock(path + '.lease.sqlite');
      try {
        if (identity(path)) {
          if (!existsSync(receiptPath)) conflict();
          ownedFile(receiptPath);
          const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as Receipt;
          const socket = lstatSync(path);
          if (receipt.format !== FORMAT || !socket.isSocket() || socket.uid !== process.getuid?.() || !same(path, receipt) ||
            dirname(receipt.boundPath) !== dirname(path) || !/^\.s-[a-f0-9]{16}$/.test(receipt.boundPath.slice(dirname(path).length + 1)) ||
            !same(receipt.boundPath, receipt) || !await refused(path) || !same(path, receipt)) conflict();
          rmSync(path);
          if (same(receipt.boundPath, receipt)) rmSync(receipt.boundPath);
        }
        boundPath = join(dirname(path), '.s-' + randomBytes(8).toString('hex'));
        await new Promise<void>((resolve, reject) => {
          const fail = (e: Error) => { server.off('listening', ready); reject(e); };
          const ready = () => { server.off('error', fail); resolve(); };
          server.once('error', fail); server.once('listening', ready); server.listen(boundPath);
        });
        listening = true;
        if (gid !== undefined) {
          const { chownSync } = await import('node:fs');
          chownSync(boundPath, process.getuid!(), gid);
        }
        chmodSync(boundPath, mode);
        // libuv closes/unlinks only its unique bound name. The public name is a
        // hard link; our explicit inode check controls its cleanup.
        const boundIdentity = identity(boundPath)!;
        const temporary = receiptPath + '.' + randomBytes(8).toString('hex');
        try {
          writeFileSync(temporary, JSON.stringify({ format: FORMAT, ...boundIdentity, boundPath }), { mode: 0o600, flag: 'wx' });
          renameSync(temporary, receiptPath);
        } finally { rmSync(temporary, { force: true }); }
        linkSync(boundPath, path);
        published = boundIdentity;
      } catch (error) {
        if (listening) { await new Promise<void>(done => server.close(() => done())); listening = false; }
        if (published && same(path, published)) rmSync(path);
        published = undefined; mutex?.close(); mutex = undefined;
        throw error;
      }
    },
    async close(server: Server) {
      if (closed) return;
      closed = true;
      if (listening) { await new Promise<void>(done => server.close(() => done())); listening = false; }
      if (published && same(path, published)) rmSync(path);
      published = undefined;
      mutex?.close(); mutex = undefined;
    },
  };
}
