import { createHash, createHmac, randomUUID } from 'node:crypto';
import { constants, realpathSync } from 'node:fs';
import { link, lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

export interface BlobBackend {
  readonly id: string;
  /** Host-only physical location. Never contains backend credentials. */
  readonly location?: Readonly<{ kind: 'file'; root: string } | { kind: 's3'; endpoint: string; bucket: string }>;
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  /** Caller must hold a durable PG row delete claim which serializes removal against uploads for this key. */
  remove(key: string): Promise<void>;
}

export class BlobError extends Error {
  readonly code: 'missing' | 'corrupt' | 'forbidden' | 'unavailable' | 'upload-unknown' | 'identity-conflict';

  constructor(code: BlobError['code'], message: string = code) {
    super(message);
    this.name = 'BlobError';
    this.code = code;
  }
}

function validateKey(key: string): void {
  if (typeof key !== 'string' || !/^[a-z0-9_-]+(?:\/[a-z0-9_-]+)*$/.test(key)) {
    throw new BlobError('forbidden', 'Unsafe blob key');
  }
  if (process.platform === 'win32' && key.split('/').some(part => /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(part))) {
    throw new BlobError('forbidden', 'Reserved blob key');
  }
}

function validateId(id: string): void {
  if (typeof id !== 'string' || !/^[a-z0-9_-]{1,80}$/.test(id)) throw new BlobError('forbidden', 'Invalid blob backend identity');
}

function fileError(error: unknown): BlobError {
  if (error instanceof BlobError) return error;
  switch ((error as NodeJS.ErrnoException).code) {
    case 'ENOENT': return new BlobError('missing');
    case 'EACCES': case 'EPERM': case 'ELOOP': case 'ENOTDIR': return new BlobError('forbidden');
    case 'EISDIR': return new BlobError('corrupt');
    default: return new BlobError('unavailable');
  }
}

async function syncDirectory(path: string): Promise<void> {
  // Node cannot portably open/fsync directories on Windows. There put() fsyncs
  // the staging file, atomically links it, then reopens and flushes the destination
  // with a writable handle. This targets writer-process crash recovery only:
  // new directories, links and deletions are not guaranteed to survive an OS
  // crash or power loss without a directory-entry flush. POSIX still requires
  // directory fsync; its open/sync failures must propagate, never be ignored.
  if (process.platform === 'win32') return;
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}

async function directory(path: string, create: boolean): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new BlobError('forbidden');
    // Also flush an entry made by a competing writer which has not yet synced its parent.
    if (create) await syncDirectory(dirname(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) throw error;
    const parent = dirname(path);
    await directory(parent, true);
    try { await mkdir(path, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    await directory(path, false);
    await syncDirectory(parent);
  }
}

async function readBlob(path: string, durable = false): Promise<Uint8Array> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new BlobError('forbidden');
  if (!info.isFile()) throw new BlobError('corrupt');
  // Windows FlushFileBuffers needs a handle opened with write access.
  const access = durable && process.platform === 'win32' ? constants.O_RDWR : constants.O_RDONLY;
  const file = await open(path, access | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev) throw new BlobError('forbidden');
    const bytes = new Uint8Array(await file.readFile());
    if (durable) await file.sync();
    return bytes;
  } finally { await file.close(); }
}

export function createFileBackend(options: { id: string; root: string }): BlobBackend {
  const { id } = options;
  validateId(id);
  const root = resolve(options.root);
  // Resolve existing ancestors even before a new resource root is created.
  // IO still uses the configured root so symlink rejection stays intact.
  let ancestor = root;
  const missing: string[] = [];
  let physicalRoot: string;
  for (;;) {
    try { physicalRoot = join(realpathSync.native(ancestor), ...missing); break; }
    catch (error) {
      const parent = dirname(ancestor);
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === ancestor) throw fileError(error);
      missing.unshift(basename(ancestor)); ancestor = parent;
    }
  }
  const location = Object.freeze({ kind: 'file' as const, root: physicalRoot });
  async function target(key: string, create: boolean): Promise<string> {
    validateKey(key);
    await directory(root, create);
    // Configured ancestors may contain OS aliases (e.g. macOS /var -> /private/var).
    // The root itself and every caller-selected component must be real directories.
    let parent = await realpath(root);
    const parts = key.split('/');
    for (const part of parts.slice(0, -1)) {
      parent = join(parent, part);
      await directory(parent, create);
    }
    return join(parent, parts[parts.length - 1]!);
  }
  return {
    id,
    get location() { return location; },
    async put(key, bytes) {
      const content = Uint8Array.from(bytes);
      let temporary: string | undefined;
      let published = false;
      try {
        const path = await target(key, true);
        temporary = join(dirname(path), `.${basename(path)}.upload-${randomUUID()}`);
        const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
          await file.writeFile(content);
          await file.sync();
        } finally { await file.close(); }
        // link() is an atomic create-if-absent; rename() would overwrite a competing writer.
        try {
          await link(temporary, path);
          published = true;
          if (process.platform === 'win32') await readBlob(path, true);
        }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          if (!Buffer.from(await readBlob(path, true)).equals(content)) throw new BlobError('identity-conflict');
          published = true;
        }
        await unlink(temporary);
        temporary = undefined;
        await syncDirectory(dirname(path));
      } catch (error) {
        if (published) throw new BlobError('upload-unknown');
        throw fileError(error);
      } finally {
        if (temporary) await unlink(temporary).catch(() => {});
      }
    },
    async get(key) {
      try {
        const path = await target(key, false);
        const bytes = await readBlob(path, true);
        // Reconciliation can race a writer between link() and its directory fsync.
        // Readability alone must not acknowledge a durable published identity.
        await syncDirectory(dirname(path));
        return bytes;
      }
      catch (error) { throw fileError(error); }
    },
    async remove(key) {
      try {
        const path = await target(key, false);
        const parent = dirname(path);
        try {
          const info = await lstat(path);
          if (info.isSymbolicLink()) throw new BlobError('forbidden');
          if (!info.isFile()) throw new BlobError('corrupt');
          await unlink(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        // The caller's PG claim excludes uploads, including reconciliation of
        // unknown outcomes, before deletion. Missing publication does not mean
        // there is nothing to reclaim: a killed writer can leave keyed staging.
        // Dots cannot occur in caller keys, so this prefix identifies one leaf.
        const prefix = `.${basename(path)}.upload-`;
        for (const entry of await readdir(parent, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.startsWith(prefix)
            || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(entry.name.slice(prefix.length))) continue;
          try { await unlink(join(parent, entry.name)); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
        await syncDirectory(parent);
      } catch (error) {
        const failure = fileError(error);
        if (failure.code !== 'missing') throw failure;
      }
    },
  };
}

export function createS3Backend(options: {
  id: string;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  requestTimeoutMs?: number;
}): BlobBackend {
  const { id, region, bucket, accessKeyId, secretAccessKey } = options;
  validateId(id);
  let endpoint: URL;
  try { endpoint = new URL(options.endpoint); }
  catch { throw new BlobError('unavailable', 'Invalid S3 configuration'); }
  const timeout = options.requestTimeoutMs ?? 10_000;
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || !/^[a-z0-9-]+$/.test(region)
    || !/^[A-Za-z0-9_-]+$/.test(accessKeyId) || !secretAccessKey
    || !Number.isInteger(timeout) || timeout <= 0 || timeout > 2_147_483_647) {
    throw new BlobError('unavailable', 'Invalid S3 configuration');
  }
  const location = Object.freeze({ kind: 's3' as const, endpoint: endpoint.href.replace(/\/+$/, ''), bucket });
  const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
  const hmac = (key: Uint8Array | string, text: string) => createHmac('sha256', key).update(text).digest();

  async function request(method: 'PUT' | 'GET' | 'DELETE', key: string, bytes?: Uint8Array): Promise<{ status: number; bytes: Uint8Array; encoding: string | null }> {
    validateKey(key);
    const url = new URL(endpoint);
    url.pathname = `${endpoint.pathname.replace(/\/+$/, '')}/${encodeURIComponent(bucket)}/${key}`;
    const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const day = date.slice(0, 8);
    const hash = sha256(bytes ?? new Uint8Array());
    const headers: Record<string, string> = {
      host: url.host,
      'x-amz-content-sha256': hash,
      'x-amz-date': date,
    };
    if (method === 'PUT') headers['if-none-match'] = '*';
    const names = Object.keys(headers).sort();
    const signed = names.join(';');
    const canonical = [method, url.pathname, '', names.map(name => `${name}:${headers[name]}\n`).join(''), signed, hash].join('\n');
    const scope = `${day}/${region}/s3/aws4_request`;
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), 's3'), 'aws4_request');
    const signature = createHmac('sha256', signingKey).update(`AWS4-HMAC-SHA256\n${date}\n${scope}\n${sha256(canonical)}`).digest('hex');
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`;
    headers['accept-encoding'] = 'identity';
    try {
      const response = await fetch(url, { method, headers, body: bytes === undefined ? undefined : Buffer.from(bytes),
        redirect: 'manual', signal: AbortSignal.timeout(timeout) });
      return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()), encoding: response.headers.get('content-encoding') };
    } catch { throw new BlobError('unavailable'); }
  }

  function responseError(status: number, bytes: Uint8Array): BlobError {
    const body = Buffer.from(bytes).toString('utf8');
    if (status === 404 && !/<Code>\s*NoSuchBucket\s*<\/Code>/.test(body)) return new BlobError('missing');
    if (status === 401 || status === 403) return new BlobError('forbidden');
    return new BlobError('unavailable');
  }

  async function get(key: string): Promise<Uint8Array> {
    const result = await request('GET', key);
    if (result.status !== 200) throw responseError(result.status, result.bytes);
    if (result.encoding && result.encoding !== 'identity') throw new BlobError('corrupt', 'Unexpected blob content encoding');
    return result.bytes;
  }

  async function verifyUpload(key: string, content: Uint8Array, outcome: 'completed' | 'unknown'): Promise<void> {
    let stored: Uint8Array;
    try { stored = await get(key); }
    catch { throw new BlobError('upload-unknown'); }
    // A different object does not resolve an unknown original PUT: it may still
    // arrive later. Preserve that provenance so callers cannot mark it failed/GC.
    if (!Buffer.from(stored).equals(content)) throw new BlobError(outcome === 'unknown' ? 'upload-unknown' : 'identity-conflict');
  }

  return {
    id,
    get location() { return location; },
    async put(key, bytes) {
      const content = Uint8Array.from(bytes);
      validateKey(key);
      let result;
      try { result = await request('PUT', key, content); }
      catch {
        // A timeout/connection loss says nothing about whether S3 accepted this write.
        // Never retry an unconditional upload, even when the recovery GET sees 404.
        await verifyUpload(key, content, 'unknown');
        return;
      }
      if ((result.status >= 200 && result.status < 300) || result.status === 409 || result.status === 412) {
        await verifyUpload(key, content, 'completed');
      } else if (result.status === 408 || result.status === 429 || result.status >= 500) {
        await verifyUpload(key, content, 'unknown');
      } else throw responseError(result.status, result.bytes);
    },
    get,
    async remove(key) {
      const result = await request('DELETE', key);
      if (result.status < 200 || result.status >= 300) {
        const failure = responseError(result.status, result.bytes);
        if (failure.code !== 'missing') throw failure;
      }
    },
  };
}
