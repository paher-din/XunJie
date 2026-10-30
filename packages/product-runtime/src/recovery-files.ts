import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, statfs } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { dirname, isAbsolute, join, parse, relative, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { RecoveryArtifact, RecoveryManifest } from './recovery-types.js';

const manifestLimit = 4 * 1024 * 1024;
const artifactLimit = 10_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = /^[0-9a-f]{64}$/;
const ownKeys = (value: object) => Object.keys(value).sort();

/** Error messages deliberately contain no filesystem paths or owner-supplied values. */
function failure(code = 'invalid-recovery'): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
function cleanError(error: unknown): Error {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOSPC' || code === 'EDQUOT') return failure('insufficient-space');
  if (['invalid-recovery', 'invalid-recovery-key', 'invalid-recovery-path', 'invalid-recovery-destination',
    'invalid-space-requirement', 'insufficient-space', 'recovery-io-error'].includes(code ?? '')) return failure(code);
  return failure('recovery-io-error');
}
function requireValue(value: unknown): asserts value {
  if (!value) throw failure();
}
function record(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, unknown> {
  requireValue(value && typeof value === 'object' && !Array.isArray(value));
  const item = value as Record<string, unknown>;
  requireValue(required.every((key) => Object.hasOwn(item, key)) && ownKeys(item).every((key) => required.includes(key) || optional.includes(key)));
}
function text(value: unknown, max = 128): asserts value is string {
  requireValue(typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value));
}
function identifier(value: unknown): asserts value is string {
  requireValue(typeof value === 'string' && uuid.test(value));
}
function version(value: unknown): void {
  text(value);
  requireValue(/^[a-z0-9][a-z0-9._/;=+:-]*$/i.test(value));
}
function unique(values: string[]): void {
  requireValue(new Set(values.map((value) => value.normalize('NFC').toLowerCase())).size === values.length);
}
function portablePath(value: unknown): asserts value is string {
  text(value, 2048);
  requireValue(Buffer.byteLength(value) <= 2048 && !/[\\:\x00-\x1f\x7f]/.test(value));
  requireValue(value.split('/').every((part) => part.length > 0 && Buffer.byteLength(part) <= 255 && part !== '.' && part !== '..'
    && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)));
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${ownKeys(object).map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function parseManifest(bytes: Uint8Array): unknown {
  try {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const stack: (Set<string> | null)[] = [];
    // JSON.parse discards duplicate keys. Detect them (including escaped spellings)
    // before parsing so no catalog data can disappear from authentication.
    for (let i = 0; i < source.length; i++) {
      const token = source[i];
      if (token === '{' || token === '[') {
        stack.push(token === '{' ? new Set() : null);
        requireValue(stack.length <= 64);
      } else if (token === '}' || token === ']') stack.pop();
      else if (token === '"') {
        const start = i++;
        while (i < source.length && source[i] !== '"') {
          if (source[i] === '\\') i++;
          i++;
        }
        let next = i + 1;
        while (/\s/.test(source[next] ?? '') && next < source.length) next++;
        if (source[next] === ':') {
          const fields = stack.at(-1);
          requireValue(fields);
          const key = JSON.parse(source.slice(start, i + 1)) as string;
          requireValue(!fields.has(key));
          fields.add(key);
        }
      }
    }
    return JSON.parse(source);
  } catch { throw failure(); }
}
function validateManifest(value: unknown): asserts value is RecoveryManifest {
  record(value, ['formatVersion', 'backupId', 'source', 'boundaryAt', 'completedAt', 'durationMs', 'services', 'receiverIds', 'artifacts', 'authentication']);
  requireValue(value.formatVersion === 1);
  identifier(value.backupId);
  for (const field of ['boundaryAt', 'completedAt']) {
    const date = value[field];
    text(date, 32);
    requireValue(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(date)
      && Number.isFinite(Date.parse(date)) && new Date(date).toISOString() === (date.includes('.') ? date : date.replace(/Z$/, '.000Z')));
  }
  requireValue(Date.parse(value.completedAt as string) >= Date.parse(value.boundaryAt as string));
  requireValue(typeof value.durationMs === 'number' && Number.isSafeInteger(value.durationMs) && value.durationMs >= 0);
  const source = value.source;
  record(source, ['formatVersion', 'environmentId', 'installationId', 'clientNamespace', 'profile', 'services']);
  requireValue(source.formatVersion === 1);
  identifier(source.environmentId); identifier(source.installationId); text(source.clientNamespace);
  requireValue(/^[a-z0-9._-]+$/i.test(source.clientNamespace) && ['local', 'school', 'remote'].includes(source.profile as string));
  requireValue(Array.isArray(source.services) && source.services.length <= 1000);
  const sourceIds: string[] = [];
  for (const item of source.services) {
    record(item, ['environmentId', 'serviceId', 'unit', 'endpoint', 'protocolVersion', 'capabilities']);
    identifier(item.environmentId); identifier(item.serviceId);
    requireValue(item.environmentId.toLowerCase() === source.environmentId.toLowerCase() && item.protocolVersion === 1);
    requireValue(['client', 'space-course', 'learning-data', 'teaching-agent', 'model-connection', 'tool-execution'].includes(item.unit as string));
    text(item.endpoint, 2048);
    let url: URL;
    try { url = new URL(item.endpoint); } catch { throw failure(); }
    requireValue(['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash);
    requireValue(Array.isArray(item.capabilities) && item.capabilities.length <= 100);
    for (const capability of item.capabilities) { text(capability); requireValue(/^[a-z0-9._:/-]+$/i.test(capability)); }
    unique(item.capabilities as string[]);
    sourceIds.push(item.serviceId);
  }
  unique(sourceIds);
  requireValue(Array.isArray(value.services) && value.services.length > 0 && value.services.length <= 1000);
  const serviceIds: string[] = [];
  for (const item of value.services) {
    record(item, ['serviceId', 'schemaVersion'], ['engineVersion']);
    identifier(item.serviceId); version(item.schemaVersion);
    if (Object.hasOwn(item, 'engineVersion')) version(item.engineVersion);
    serviceIds.push(item.serviceId);
  }
  unique(serviceIds);
  requireValue(Array.isArray(value.receiverIds) && value.receiverIds.length <= 1000);
  for (const id of value.receiverIds) {
    text(id);
    const authority = id.split('/');
    requireValue(authority.length === 1 || authority.length === 2);
    for (const part of authority) identifier(part);
  }
  unique(value.receiverIds as string[]);
  requireValue(Array.isArray(value.artifacts) && value.artifacts.length <= artifactLimit);
  const paths: string[] = [];
  for (const artifact of value.artifacts) {
    record(artifact, ['path', 'sha256', 'byteLength']);
    portablePath(artifact.path);
    requireValue(typeof artifact.sha256 === 'string' && digest.test(artifact.sha256));
    requireValue(typeof artifact.byteLength === 'number' && Number.isSafeInteger(artifact.byteLength) && artifact.byteLength >= 28);
    paths.push(artifact.path);
  }
  unique(paths);
  // A file cannot also be a directory, including on case-insensitive destinations.
  const pathSet = new Set(paths.map((path) => path.normalize('NFC').toLowerCase()));
  for (const path of pathSet) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) requireValue(!pathSet.has(parts.slice(0, i).join('/')));
  }
  requireValue(typeof value.authentication === 'string' && digest.test(value.authentication));
  requireValue(Buffer.byteLength(canonical(value)) < manifestLimit);
}
function keys(key: Uint8Array): { encryption: Buffer; authentication: Buffer } {
  if (!(key instanceof Uint8Array) || key.byteLength < 32) throw failure('invalid-recovery-key');
  // Domain separation; the caller supplies a high-entropy key, not a password.
  return {
    encryption: createHmac('sha256', key).update('xunjie/recovery/v1/encryption').digest(),
    authentication: createHmac('sha256', key).update('xunjie/recovery/v1/authentication').digest(),
  };
}
function authenticate(manifest: RecoveryManifest, key: Buffer): string {
  const { authentication: _authentication, ...fields } = manifest;
  return createHmac('sha256', key).update(canonical(fields)).digest('hex');
}
async function directoryRoot(path: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw failure('invalid-recovery-path');
  // Resolve ancestors once: macOS /var -> /private/var is a legitimate root alias.
  return realpath(path);
}
async function plainFile(path: string): Promise<FileHandle> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw failure('invalid-recovery-path');
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const actual = await file.stat();
    if (!actual.isFile() || actual.dev !== before.dev || actual.ino !== before.ino) throw failure('invalid-recovery-path');
    return file;
  } catch (error) { await file.close(); throw error; }
}
async function walk(root: string, prefix = '', files: string[] = [], directories = { count: 0 }): Promise<string[]> {
  await directoryRoot(prefix ? join(root, prefix) : root);
  const entries = await readdir(prefix ? join(root, prefix) : root);
  for (const name of entries.sort()) {
    const path = prefix ? `${prefix}/${name}` : name;
    portablePath(path);
    const info = await lstat(join(root, path));
    if (info.isSymbolicLink()) throw failure('invalid-recovery-path');
    if (info.isDirectory()) {
      if (++directories.count > artifactLimit || path.split('/').length > 64) throw failure();
      await walk(root, path, files, directories);
    } else if (info.isFile()) {
      files.push(path);
      if (files.length > artifactLimit) throw failure();
    } else throw failure('invalid-recovery-path');
  }
  return files;
}
async function summary(path: string, artifactPath: string): Promise<RecoveryArtifact> {
  const file = await plainFile(path);
  const stream = file.createReadStream({ autoClose: false });
  try {
    const hash = createHash('sha256');
    let byteLength = 0;
    for await (const chunk of stream) { hash.update(chunk); byteLength += chunk.length; }
    requireValue(Number.isSafeInteger(byteLength));
    return { path: artifactPath, sha256: hash.digest('hex'), byteLength };
  } finally { stream.destroy(); await file.close(); }
}
async function absent(path: string): Promise<void> {
  try { await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  throw failure('invalid-recovery-path');
}

/** Encrypts payload/<path> into artifacts/<path>, then removes the plaintext payload even on failure. */
export async function sealRecovery(directory: string, key: Uint8Array,
  metadata: Omit<RecoveryManifest, 'artifacts' | 'authentication'>): Promise<RecoveryManifest> {
  let root: string | undefined;
  const started = performance.now();
  try {
    root = await directoryRoot(directory);
    const derived = keys(key);
    const manifest: RecoveryManifest = { ...structuredClone(metadata), artifacts: [], authentication: '0'.repeat(64) };
    validateManifest(manifest);
    await absent(join(root, 'manifest.json'));
    await absent(join(root, 'artifacts'));
    const payload = join(root, 'payload');
    const paths = await walk(payload);
    unique(paths);
    await mkdir(join(root, 'artifacts'), { mode: 0o700 });
    for (const path of paths) {
      const input = await plainFile(join(payload, path));
      let output: FileHandle | undefined;
      const source = input.createReadStream({ autoClose: false });
      let sink: ReturnType<FileHandle['createWriteStream']> | undefined;
      try {
        const target = join(root, 'artifacts', path);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        output = await open(target, 'wx', 0o600);
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', derived.encryption, iv);
        cipher.setAAD(Buffer.from(path));
        await output.writeFile(iv);
        sink = output.createWriteStream({ start: 12, autoClose: false });
        await pipeline(source, cipher, sink);
        const tag = cipher.getAuthTag();
        const { size } = await output.stat();
        await output.write(tag, 0, tag.length, size);
        await output.sync();
      } finally { source.destroy(); sink?.destroy(); await input.close(); await output?.close(); }
      manifest.artifacts.push(await summary(join(root, 'artifacts', path), path));
    }
    manifest.completedAt = new Date(Math.max(Date.parse(metadata.completedAt), Date.now())).toISOString();
    manifest.durationMs += Math.ceil(performance.now() - started);
    manifest.authentication = authenticate(manifest, derived.authentication);
    validateManifest(manifest);
    const file = await open(join(root, 'manifest.json'), 'wx', 0o600);
    try { await file.writeFile(`${canonical(manifest)}\n`); await file.sync(); } finally { await file.close(); }
    return manifest;
  } catch (error) { throw cleanError(error); }
  finally {
    if (root) {
      try { await rm(join(root, 'payload'), { recursive: true, force: true }); } catch (error) { throw cleanError(error); }
    }
  }
}

/** Verifies the complete public catalog, its MAC, and the exact on-disk ciphertext inventory. */
export async function verifyRecovery(directory: string, key: Uint8Array): Promise<RecoveryManifest> {
  try {
    const root = await directoryRoot(directory);
    const derived = keys(key);
    const file = await plainFile(join(root, 'manifest.json'));
    let value: unknown;
    try {
      const { size } = await file.stat();
      requireValue(size > 0 && size <= manifestLimit);
      // A bounded read also prevents a concurrently growing manifest from exhausting memory.
      const buffer = Buffer.alloc(size + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      requireValue(length === size);
      value = parseManifest(buffer.subarray(0, length));
    } finally { await file.close(); }
    validateManifest(value);
    requireValue(timingSafeEqual(Buffer.from(value.authentication, 'hex'), Buffer.from(authenticate(value, derived.authentication), 'hex')));
    const artifactRoot = join(root, 'artifacts');
    const paths = await walk(artifactRoot);
    unique(paths);
    const expected = new Set(value.artifacts.map((artifact) => artifact.path));
    requireValue(paths.length === expected.size && paths.every((path) => expected.has(path)));
    for (const artifact of value.artifacts) {
      const actual = await summary(join(artifactRoot, artifact.path), artifact.path);
      requireValue(actual.byteLength === artifact.byteLength && actual.sha256 === artifact.sha256);
    }
    return value;
  } catch (error) { throw cleanError(error); }
}

function overlaps(left: string, right: string): boolean {
  const contains = (parent: string, child: string) => {
    const path = relative(parent, child);
    return !path || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
  };
  return contains(left, right) || contains(right, left);
}

/** Authenticates all files before publishing plaintext directly under an existing empty private destination. */
export async function unsealRecovery(directory: string, destination: string, key: Uint8Array): Promise<RecoveryManifest> {
  let staging: string | undefined;
  let target: string | undefined;
  const published: string[] = [];
  try {
    const root = await directoryRoot(directory);
    target = await directoryRoot(destination);
    const targetInfo = await lstat(target);
    if (overlaps(root, target) || (process.platform !== 'win32' && (targetInfo.mode & 0o077) !== 0)
      || (await readdir(target)).length) throw failure('invalid-recovery-destination');
    const manifest = await verifyRecovery(root, key);
    const derived = keys(key);
    staging = await mkdtemp(join(dirname(target), '.xj-recovery-'));
    for (const artifact of manifest.artifacts) {
      const input = await plainFile(join(root, 'artifacts', artifact.path));
      let output: FileHandle | undefined;
      let source: ReturnType<FileHandle['createReadStream']> | undefined;
      let sink: ReturnType<FileHandle['createWriteStream']> | undefined;
      try {
        // Re-hash the exact bytes being decrypted, closing the verify/decrypt modification window.
        const { size } = await input.stat();
        requireValue(size === artifact.byteLength && size >= 28);
        const iv = Buffer.alloc(12); const tag = Buffer.alloc(16);
        requireValue((await input.read(iv, 0, 12, 0)).bytesRead === 12 && (await input.read(tag, 0, 16, size - 16)).bytesRead === 16);
        const decipher = createDecipheriv('aes-256-gcm', derived.encryption, iv);
        decipher.setAAD(Buffer.from(artifact.path)); decipher.setAuthTag(tag);
        const path = join(staging, artifact.path);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        output = await open(path, 'wx', 0o600);
        const hash = createHash('sha256').update(iv);
        let cipherBytes = 0;
        async function* ciphertext() {
          if (size > 28) {
            source = input.createReadStream({ start: 12, end: size - 17, autoClose: false });
            for await (const chunk of source) {
              hash.update(chunk); cipherBytes += chunk.length; yield chunk;
            }
          }
        }
        sink = output.createWriteStream({ autoClose: false });
        try { await pipeline(ciphertext(), decipher, sink); }
        catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === 'ENOSPC' || (error as NodeJS.ErrnoException)?.code === 'EDQUOT') throw error;
          throw failure();
        }
        hash.update(tag);
        requireValue(cipherBytes === size - 28 && hash.digest('hex') === artifact.sha256);
        await output.sync();
      } finally { source?.destroy(); sink?.destroy(); await input.close(); await output?.close(); }
    }
    const current = await lstat(target);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== targetInfo.dev || current.ino !== targetInfo.ino
      || (await readdir(target)).length) throw failure('invalid-recovery-destination');
    for (const name of await readdir(staging)) {
      const path = join(target, name);
      await absent(path);
      await rename(join(staging, name), path);
      published.push(path);
    }
    return manifest;
  } catch (error) {
    for (const path of published.reverse()) await rm(path, { recursive: true, force: true }).catch(() => {});
    throw cleanError(error);
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

/** Resolves aliases and missing descendants without creating directories. */
async function prospectiveRoot(path: string): Promise<string> {
  if (typeof path !== 'string' || !path || path.includes('\0')) throw failure('invalid-recovery-path');
  // Follow existing aliases before processing '..', preserving filesystem rather
  // than lexical path semantics even when the requested descendant is missing.
  const absolute = isAbsolute(path) ? path : `${process.cwd()}${sep}${path}`;
  let cursor = parse(absolute).root;
  for (const part of absolute.slice(cursor.length).split(process.platform === 'win32' ? /[\\/]/ : '/')) {
    if (!part || part === '.') continue;
    if (part === '..') { cursor = dirname(cursor); continue; }
    cursor = join(cursor, part);
    try {
      const resolved = await realpath(cursor);
      if (!(await lstat(resolved)).isDirectory()) throw failure('invalid-recovery-path');
      cursor = resolved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // A dangling symlink is not a legitimate missing directory.
      try { if ((await lstat(cursor)).isSymbolicLink()) throw failure('invalid-recovery-path'); }
      catch (entryError) { if ((entryError as NodeJS.ErrnoException).code !== 'ENOENT') throw entryError; }
    }
  }
  return cursor;
}

/** A backup must be outside data and owned resource roots; a separate device is not required. */
export async function checkIndependentDirectory(dataRoot: string, backupDirectory: string, resourceRoots: string[] = []): Promise<void> {
  try {
    const backup = await prospectiveRoot(backupDirectory);
    for (const root of [dataRoot, ...resourceRoots]) {
      if (overlaps(await prospectiveRoot(root), backup)) throw failure('invalid-recovery-path');
    }
  } catch (error) { throw cleanError(error); }
}

/** Explicit preflight: creates the requested directory, then checks available unprivileged space. */
export async function ensureRecoverySpace(directory: string, requiredBytes: number): Promise<void> {
  try {
    if (typeof requiredBytes !== 'number' || !Number.isSafeInteger(requiredBytes) || requiredBytes < 0) throw failure('invalid-space-requirement');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const root = await directoryRoot(directory);
    const capacity = await statfs(root, { bigint: true });
    if (capacity.bavail < 0n || capacity.bsize <= 0n) throw failure('recovery-io-error');
    if (capacity.bavail * capacity.bsize < BigInt(requiredBytes)) throw failure('insufficient-space');
  } catch (error) { throw cleanError(error); }
}
