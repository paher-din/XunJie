import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeSync } from 'node:fs';
import { request } from 'node:https';
import { join } from 'node:path';
import { authenticatedRequest, loadDevice, readRegistration } from './enrollment-client.mjs';
import { assertPrivateFile, digest as hexDigest, ensurePrivateDirectory, privateJson, writePrivateFile, writePrivateJson } from './enrollment-protocol.mjs';
import { CliError } from './envelope.mjs';
import { inspectRepro, checkReproCompatibility } from './repro.mjs';
import { ARCHIVE_LIMITS, digest, REPRO_FORMAT } from './repro-archive.mjs';
import { TOOL_VERSION } from './paths.mjs';
import { acquireLock } from './state.mjs';

const PART = 8 * 1024 * 1024, MAX = ARCHIVE_LIMITS.zip, PRIVATE_ZIP = { maxBytes: MAX };
const SCHEMA = 'xj-dev/package-transfer-v1';
const activeNamespaces = new Set();
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const reproId = value => typeof value === 'string' && value.startsWith('xjp_') && uuid(value.slice(4));
const sha = value => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
function fail(code, retryable = false) {
  return new CliError('transfer', code, `复现包传输未完成（${code}）。`, { retryable,
    recovery: '保留冻结包和私有传输状态；核对当前设备权限与网络后显式重试，不重新采集现场。' });
}
function need(condition, code = 'TRANSFER_STATE_INVALID') { if (!condition) throw fail(code); }
function sanitized(error) {
  if (error instanceof CliError && ['transfer', 'enrollment', 'repro', 'lock'].includes(error.stage)) return error;
  // Never propagate native HTTP/TLS errors, response bodies, JSON parse text,
  // or arbitrary remote properties: they may contain signed URLs or secrets.
  return fail(error?.code === 'PRIVATE_FILE_REQUIRED' ? 'PRIVATE_FILE_REQUIRED' : 'TRANSFER_STATE_INVALID');
}
async function safe(work) {
  try { return await work(); } catch (error) { throw sanitized(error); }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let crc = BigInt(n);
  for (let bit = 0; bit < 8; bit++) crc = crc & 1n ? (crc >> 1n) ^ 0xC96C5795D7870F42n : crc >> 1n;
  return crc;
});
export function crc64XZ(bytes) {
  let crc = 0xFFFFFFFFFFFFFFFFn;
  for (const byte of bytes) crc = crcTable[Number((crc ^ BigInt(byte)) & 255n)] ^ (crc >> 8n);
  return (crc ^ 0xFFFFFFFFFFFFFFFFn).toString(10);
}
function layout(bytes) {
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += PART) {
    const part = bytes.subarray(offset, offset + PART);
    parts.push({ partNumber: parts.length + 1, bytes: part.length, contentMD5: createHash('md5').update(part).digest('base64') });
  }
  return parts;
}
function record(value, expected, publisher) {
  need(value && reproId(value.reproId) && typeof value.publisherId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value.publisherId)
    && sha(value.digest) && Number.isSafeInteger(value.bytes) && value.bytes > 0 && value.bytes <= MAX
    && typeof value.crc64 === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value.crc64) && BigInt(value.crc64) <= 0xFFFFFFFFFFFFFFFFn
    && value.formatVersion === REPRO_FORMAT && typeof value.toolVersion === 'string' && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(value.toolVersion)
    && ['uploading', 'published', 'failed'].includes(value.state) && Number.isSafeInteger(value.createdAt)
    && (value.publishedAt === null || Number.isSafeInteger(value.publishedAt)), 'TRANSFER_RESPONSE_INVALID');
  if (publisher) need(value.publisherId === publisher, 'TRANSFER_NOT_OWNED');
  if (expected) for (const key of ['digest', 'bytes', 'crc64', 'formatVersion', 'toolVersion']) need(value[key] === expected[key], 'OBJECT_MISMATCH');
  // Public output and durable state use only an explicit non-secret projection.
  return Object.fromEntries(['reproId', 'publisherId', 'digest', 'bytes', 'crc64', 'formatVersion', 'toolVersion', 'state', 'createdAt', 'publishedAt'].map(key => [key, value[key]]));
}
function locations(context, deviceFile) {
  const device = loadDevice(deviceFile);
  const transfers = ensurePrivateDirectory(join(realpathSync(context.home), 'transfers'));
  const root = ensurePrivateDirectory(join(transfers, hexDigest(JSON.stringify([device.serviceId, device.identity.memberId]))));
  for (const name of ['uploads', 'cache']) ensurePrivateDirectory(join(root, name));
  return { root, device, indexFile: join(root, 'index.json') };
}
async function locked(context, deviceFile, work) {
  const paths = locations(context, deviceFile);
  // Do not reopen/close a POSIX lock inode already held by this process. The
  // permanent SQLite mutex still excludes other processes and releases on exit.
  if (activeNamespaces.has(paths.root)) throw fail('LOCK_HELD', true);
  activeNamespaces.add(paths.root);
  let lock;
  try {
    lock = acquireLock({ root: paths.root, lockFile: join(paths.root, 'operation-lock') });
    return await work(paths);
  } finally { try { lock?.release(); } finally { activeNamespaces.delete(paths.root); } }
}
function indexAt(paths) {
  if (!existsSync(paths.indexFile)) return { schema: SCHEMA, operations: {} };
  const value = privateJson(paths.indexFile);
  need(value?.schema === SCHEMA && value.operations && typeof value.operations === 'object' && !Array.isArray(value.operations));
  for (const [key, item] of Object.entries(value.operations)) need(uuid(key) && sha(item.digest) && (item.transferId === null || reproId(item.transferId)));
  return value;
}
function operation(paths, key) {
  need(uuid(key));
  const root = ensurePrivateDirectory(join(paths.root, 'uploads', key));
  return { root, file: join(root, 'frozen.zip'), stateFile: join(root, 'state.json') };
}
function frozen(op, state) {
  need(state?.claim && sha(state.claim.digest) && Number.isSafeInteger(state.claim.bytes) && state.claim.bytes > 0 && state.claim.bytes <= MAX
    && state.claim.formatVersion === REPRO_FORMAT && state.claim.toolVersion === TOOL_VERSION && Array.isArray(state.parts));
  assertPrivateFile(op.file, PRIVATE_ZIP);
  const bytes = readFileSync(op.file);
  need(bytes.length === state.claim.bytes && digest(bytes) === state.claim.digest, 'FROZEN_FILE_CHANGED');
  const checked = inspectRepro(op.file, { expectedDigest: state.claim.digest });
  need(checked.package.manifest.tool?.version === state.claim.toolVersion, 'OBJECT_MISMATCH');
  need(crc64XZ(bytes) === state.claim.crc64 && JSON.stringify(layout(bytes)) === JSON.stringify(state.parts), 'FROZEN_FILE_CHANGED');
  return bytes;
}
function save(op, state) { writePrivateJson(op.stateFile, state); }
async function api(deviceFile, route, body) { return authenticatedRequest(deviceFile, '/v1/packages/' + route, body); }
function statusResult(value, state, member) {
  const current = record(value?.record, state.claim, member);
  need(value.transferId === current.reproId && value.transferId === state.transferId && value.partSize === PART && value.partCount === state.parts.length, 'TRANSFER_RESPONSE_INVALID');
  need(Array.isArray(value.parts) && value.parts.length <= state.parts.length, 'TRANSFER_RESPONSE_INVALID');
  const seen = new Set();
  const confirmed = value.parts.map(part => {
    const expected = state.parts[part?.partNumber - 1];
    need(expected && part.partNumber === expected.partNumber && !seen.has(part.partNumber) && part.bytes === expected.bytes && part.contentMD5 === expected.contentMD5
      && typeof part.etag === 'string' && part.etag.toLowerCase() === '"' + Buffer.from(expected.contentMD5, 'base64').toString('hex') + '"', 'PART_CONFLICT');
    seen.add(part.partNumber);
    return { ...expected, etag: part.etag };
  });
  return { current, confirmed };
}
function grant(value, method, headers) {
  let url;
  try { url = new URL(value?.url); } catch { throw fail('TRANSFER_AUTHORIZATION_INVALID'); }
  need(value.method === method && url.protocol === 'https:' && !url.username && !url.password && !url.hash
    && typeof value.allowedHost === 'string' && /^[A-Za-z0-9.-]+(?::[0-9]+)?$/.test(value.allowedHost)
    && url.host === value.allowedHost && Number.isSafeInteger(value.expiresAt) && value.expiresAt <= Date.now() + 305000,
  'TRANSFER_AUTHORIZATION_INVALID');
  need(value.expiresAt > Date.now(), 'URL_EXPIRED');
  need(value.headers && typeof value.headers === 'object' && !Array.isArray(value.headers), 'TRANSFER_AUTHORIZATION_INVALID');
  const required = { host: url.host, ...headers };
  need(Object.keys(value.headers).length === Object.keys(required).length, 'TRANSFER_AUTHORIZATION_INVALID');
  for (const [key, expected] of Object.entries(required)) need(String(value.headers[key]) === String(expected), 'TRANSFER_AUTHORIZATION_INVALID');
  return { url, headers: required };
}
function objectRequest(authorization, { method, headers, bytes, onHeaders, onChunk }) {
  return new Promise((resolve, reject) => {
    let access;
    try { access = grant(authorization, method, headers); } catch (error) { reject(error); return; }
    let done = false, timer;
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const req = request(access.url, { method, headers: access.headers, agent: false, rejectUnauthorized: true }, res => {
      const status = res.statusCode;
      if (status === 401 || status === 403 || status === 412) {
        finish(fail(status === 412 ? 'OBJECT_PRECONDITION_FAILED' : 'URL_EXPIRED', true)); res.destroy(); return;
      }
      if (status !== (method === 'GET' ? 206 : 200)) { finish(fail('OBJECT_HTTP_FAILED', status >= 500)); res.destroy(); return; }
      try { onHeaders?.(res.headers); } catch (error) { finish(error); res.destroy(); return; }
      res.on('data', chunk => { try { onChunk?.(chunk); } catch (error) { finish(error); req.destroy(); } });
      res.on('end', () => finish(undefined, res.headers));
      res.on('error', () => finish(fail('OBJECT_UNREACHABLE', true)));
      res.on('aborted', () => finish(fail('OBJECT_UNREACHABLE', true)));
    });
    req.on('error', () => finish(fail('OBJECT_UNREACHABLE', true)));
    req.setTimeout(30000, () => req.destroy());
    timer = setTimeout(() => { finish(fail('OBJECT_UNREACHABLE', true)); req.destroy(); }, 60000);
    req.end(bytes);
  });
}
function published(op, current, confirmed) {
  need(current.state === 'published', 'PACKAGE_NOT_READY');
  return { state: 'published', transferId: current.reproId, reproId: current.reproId, digest: current.digest,
    bytes: current.bytes, file: op.file, confirmedParts: confirmed.length, record: current, restored: false, reproduction: 'unverified' };
}
async function upload(deviceFile, paths, op, state) {
  const bytes = frozen(op, state);
  try { return await sendUpload(deviceFile, paths, op, state, bytes); }
  catch (error) {
    const failure = sanitized(error);
    failure.transfer = { state: 'interrupted', transferId: state.transferId, file: op.file,
      digest: state.claim.digest, bytes: state.claim.bytes, confirmedParts: Array.isArray(state.confirmed) ? state.confirmed.length : 0 };
    throw failure;
  }
}
async function sendUpload(deviceFile, paths, op, state, bytes) {
  const member = paths.device.identity.memberId;
  if (!state.transferId) {
    const started = await api(deviceFile, 'upload', { idempotencyKey: state.idempotencyKey, ...state.claim });
    const current = record(started?.record, state.claim, member);
    need(started.transferId === current.reproId && started.partSize === PART && started.partCount === state.parts.length, 'TRANSFER_RESPONSE_INVALID');
    state.transferId = current.reproId; save(op, state);
    const index = indexAt(paths); index.operations[state.idempotencyKey].transferId = state.transferId; writePrivateJson(paths.indexFile, index);
  }
  async function confirmed() {
    const result = statusResult(await api(deviceFile, 'upload-status', { transferId: state.transferId }), state, member);
    state.confirmed = result.confirmed; state.record = result.current; save(op, state); return result;
  }
  let status = await confirmed();
  if (status.current.state === 'published') return published(op, status.current, status.confirmed);
  need(status.current.state === 'uploading', 'PACKAGE_NOT_READY');
  for (const part of state.parts) {
    if (status.confirmed.some(p => p.partNumber === part.partNumber)) continue;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const authorization = await api(deviceFile, 'upload-parts', { transferId: state.transferId, parts: [part] });
        need(authorization?.transferId === state.transferId && authorization.parts?.length === 1, 'TRANSFER_RESPONSE_INVALID');
        const access = authorization.parts[0];
        need(access.partNumber === part.partNumber && access.bytes === part.bytes && access.contentMD5 === part.contentMD5, 'PART_CONFLICT');
        const offset = (part.partNumber - 1) * PART;
        await objectRequest(access, { method: 'PUT', headers: { 'content-length': String(part.bytes), 'content-md5': part.contentMD5, 'content-type': 'application/octet-stream' },
          bytes: bytes.subarray(offset, offset + part.bytes) });
        break;
      } catch (error) {
        if (error.code !== 'URL_EXPIRED' || attempt === 1) throw error;
        status = await confirmed();
        if (status.current.state === 'published') return published(op, status.current, status.confirmed);
        need(status.current.state === 'uploading', 'PACKAGE_NOT_READY');
        if (status.confirmed.some(p => p.partNumber === part.partNumber)) break;
      }
    }
  }
  status = await confirmed();
  need(status.confirmed.length === state.parts.length, 'UPLOAD_INCOMPLETE');
  frozen(op, state); // Refuse a locally altered frozen file before publication.
  const current = record((await api(deviceFile, 'complete', { transferId: state.transferId }))?.record, state.claim, member);
  need(current.reproId === state.transferId, 'TRANSFER_RESPONSE_INVALID');
  state.record = current; save(op, state); return published(op, current, status.confirmed);
}

export async function publishFrozen(context, { deviceFile, file, expectedDigest, idempotencyKey } = {}) {
  return safe(() => locked(context, deviceFile, async paths => {
    need(sha(expectedDigest), 'DIGEST_REQUIRED');
    const inspected = inspectRepro(file, { expectedDigest });
    need(inspected.package.manifest.tool?.version === TOOL_VERSION && inspected.package.manifest.conditions.toolVersion === TOOL_VERSION, 'TOOL_VERSION_MISMATCH');
    const bytes = readFileSync(file); need(digest(bytes) === expectedDigest && bytes.length === inspected.package.bytes, 'FROZEN_FILE_CHANGED');
    const index = indexAt(paths);
    const key = idempotencyKey ?? Object.keys(index.operations).find(key => index.operations[key].digest === expectedDigest) ?? randomUUID();
    need(uuid(key), 'INVALID_IDEMPOTENCY_KEY');
    need(!index.operations[key] || index.operations[key].digest === expectedDigest, 'UPLOAD_CONFLICT');
    const op = operation(paths, key);
    let state;
    if (existsSync(op.stateFile)) {
      state = privateJson(op.stateFile); need(state.schema === SCHEMA && state.idempotencyKey === key && state.claim?.digest === expectedDigest);
    } else {
      writePrivateFile(op.file, bytes, PRIVATE_ZIP);
      state = { schema: SCHEMA, idempotencyKey: key, transferId: null,
        claim: { digest: expectedDigest, bytes: bytes.length, crc64: crc64XZ(bytes), formatVersion: REPRO_FORMAT, toolVersion: TOOL_VERSION }, parts: layout(bytes), confirmed: [] };
      save(op, state);
    }
    index.operations[key] = { digest: expectedDigest, transferId: state.transferId }; writePrivateJson(paths.indexFile, index);
    return upload(deviceFile, paths, op, state);
  }));
}

export async function resumeUpload(context, { deviceFile, transferId } = {}) {
  return safe(() => locked(context, deviceFile, async paths => {
    need(reproId(transferId), 'INVALID_TRANSFER_ID');
    const index = indexAt(paths), key = Object.keys(index.operations).find(key => index.operations[key].transferId === transferId);
    need(key, 'TRANSFER_NOT_FOUND');
    const op = operation(paths, key), state = privateJson(op.stateFile);
    need(state.schema === SCHEMA && state.transferId === transferId && state.idempotencyKey === key && state.claim?.digest === index.operations[key].digest);
    return upload(deviceFile, paths, op, state);
  }));
}

function validETag(value) { return typeof value === 'string' && /^"[^"\x00-\x20\x7f]{1,256}"$/.test(value); }
function inspectedContent(file, current) {
  assertPrivateFile(file, PRIVATE_ZIP);
  const checked = inspectRepro(file, { expectedDigest: current.digest });
  need(checked.package.bytes === current.bytes && checked.package.formatVersion === current.formatVersion
    && checked.package.manifest.tool?.version === current.toolVersion, 'OBJECT_MISMATCH');
  need(crc64XZ(readFileSync(file)) === current.crc64, 'OBJECT_MISMATCH');
  return checked;
}
const invalidCacheContent = error => error instanceof CliError && ['repro', 'transfer'].includes(error.stage);
async function usable(context, file, current, root) {
  let checked;
  try { checked = inspectedContent(file, current); }
  catch (error) {
    if (invalidCacheContent(error)) error.recovery = `下载缓存校验失败，保留上传冻结包；显式执行 xj-dev repro cache-delete ${current.reproId}，再用 repro fetch ${current.reproId} 重新授权下载。`;
    throw error;
  }
  const scratch = mkdtempSync(join(root, 'compatibility-'));
  try { await checkReproCompatibility(context, checked.package.manifest, scratch); }
  finally { rmSync(scratch, { recursive: true, force: true, maxRetries: 3 }); }
}
function downloaded(file, current, cacheHit) {
  return { state: 'downloaded', reproId: current.reproId, digest: current.digest, bytes: current.bytes,
    file, cacheHit, inspected: true, record: current, restored: false, reproduction: 'unverified' };
}

export async function fetchRepro(context, { deviceFile, reproId: id } = {}) {
  return safe(() => locked(context, deviceFile, async paths => {
    need(reproId(id), 'INVALID_REPRO_ID');
    const cache = join(paths.root, 'cache'), pointer = join(cache, id + '.json');
    let previous;
    if (existsSync(pointer)) {
      previous = privateJson(pointer);
      need(previous?.schema === SCHEMA && previous.record?.reproId === id && validETag(previous.etag));
      previous.record = record(previous.record);
    }
    let reset = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      let offset = 0;
      if (previous && !reset) {
        const root = ensurePrivateDirectory(join(cache, previous.record.digest.slice(7)));
        const candidate = join(root, 'ready.zip'), partial = join(root, 'partial.zip');
        if (existsSync(candidate)) { assertPrivateFile(candidate, PRIVATE_ZIP); offset = previous.record.bytes; }
        else if (existsSync(partial)) { assertPrivateFile(partial, PRIVATE_ZIP); offset = lstatSync(partial).size; }
        need(offset <= previous.record.bytes, 'OBJECT_MISMATCH');
      }
      let resolved;
      try {
        // Authorization is required even for a complete locally cached ZIP.
        resolved = await api(deviceFile, 'resolve', { reproId: id, offset, ...(previous && !reset ? { etag: previous.etag } : {}) });
      } catch (error) {
        if (error.code !== 'ETAG_CHANGED' || attempt === 1 || !previous) throw error;
        const partial = join(cache, previous.record.digest.slice(7), 'partial.zip');
        if (existsSync(partial)) { assertPrivateFile(partial, PRIVATE_ZIP); rmSync(partial); }
        reset = true; continue;
      }
      const current = record(resolved?.record, previous?.record);
      need(current.reproId === id && current.state === 'published', 'PACKAGE_NOT_READY');
      need(validETag(resolved.etag), 'TRANSFER_RESPONSE_INVALID');
      const root = ensurePrivateDirectory(join(cache, current.digest.slice(7)));
      const ready = join(root, 'ready.zip'), partial = join(root, 'partial.zip');
      if (existsSync(ready)) {
        await usable(context, ready, current, root);
        writePrivateJson(pointer, { schema: SCHEMA, record: current, etag: resolved.etag });
        return downloaded(ready, current, true);
      }
      if (previous && offset && previous.etag !== resolved.etag) {
        if (existsSync(partial)) { assertPrivateFile(partial, PRIVATE_ZIP); rmSync(partial); }
        need(attempt === 0, 'OBJECT_PRECONDITION_FAILED'); reset = true; continue;
      }
      if (!previous || reset) {
        if (existsSync(partial)) assertPrivateFile(partial, PRIVATE_ZIP);
        writePrivateFile(partial, Buffer.alloc(0), PRIVATE_ZIP); offset = 0;
      } else if (!existsSync(partial)) writePrivateFile(partial, Buffer.alloc(0), PRIVATE_ZIP);
      previous = { schema: SCHEMA, record: current, etag: resolved.etag };
      writePrivateJson(pointer, previous);
      reset = false;
      if (offset < current.bytes) {
        assertPrivateFile(partial, PRIVATE_ZIP);
        const fd = openSync(partial, 'a'); let received = 0;
        try {
          await objectRequest(resolved.authorization, { method: 'GET', headers: { range: `bytes=${offset}-`, 'if-match': resolved.etag },
            onHeaders(headers) {
              need(headers.etag === resolved.etag && headers['content-range'] === `bytes ${offset}-${current.bytes - 1}/${current.bytes}`
                && headers['content-length'] === String(current.bytes - offset) && (!headers['content-encoding'] || headers['content-encoding'] === 'identity'), 'OBJECT_RANGE_INVALID');
            },
            onChunk(chunk) {
              need(offset + received + chunk.length <= current.bytes, 'OBJECT_RANGE_INVALID');
              let written = 0;
              while (written < chunk.length) written += writeSync(fd, chunk, written, chunk.length - written);
              received += chunk.length;
            } });
          need(offset + received === current.bytes, 'OBJECT_RANGE_INVALID');
        } catch (error) {
          if (!['URL_EXPIRED', 'OBJECT_PRECONDITION_FAILED'].includes(error.code) || attempt === 1) throw error;
          if (error.code === 'OBJECT_PRECONDITION_FAILED') { reset = true; }
          continue;
        } finally { closeSync(fd); if (reset && existsSync(partial)) rmSync(partial); }
      } else need(resolved.authorization === null, 'TRANSFER_RESPONSE_INVALID');
      await usable(context, partial, current, root);
      renameSync(partial, ready);
      return downloaded(ready, current, false);
    }
    throw fail('OBJECT_PRECONDITION_FAILED');
  }));
}

// Delete one registered, currently retrievable download cache, including corrupt
// completed bytes. Uploads, resumable partials and permanent locks stay intact.
export async function pruneCache(context, { deviceFile, reproId: id } = {}) {
  return safe(async () => {
    deviceFile ??= readRegistration({ home: context.home })?.deviceFile;
    need(deviceFile, 'DEVICE_NOT_REGISTERED');
    return locked(context, deviceFile, async paths => {
      need(reproId(id), 'INVALID_REPRO_ID');
      const resolved = await api(deviceFile, 'resolve', { reproId: id, offset: 0 });
      const current = record(resolved?.record);
      need(current.reproId === id && current.state === 'published' && validETag(resolved.etag), 'PACKAGE_NOT_READY');
      grant(resolved.authorization, 'GET', { range: 'bytes=0-', 'if-match': resolved.etag });
      const cache = join(paths.root, 'cache'), pointer = join(cache, id + '.json');
      if (!existsSync(pointer)) return { state: 'cache-absent', reproId: id, removedBytes: 0 };
      const saved = privateJson(pointer);
      need(saved?.schema === SCHEMA && saved.record?.reproId === id && validETag(saved.etag), 'CACHE_UNSAFE');
      record(saved.record, current);
      const root = ensurePrivateDirectory(join(cache, current.digest.slice(7)));
      const entries = readdirSync(root);
      need(entries.every(name => ['ready.zip', 'partial.zip'].includes(name)), 'CACHE_UNSAFE');
      need(entries.length !== 2, 'CACHE_IN_USE');
      need(entries.length === 1, 'CACHE_UNSAFE');
      const file = join(root, entries[0]);
      // Cleanup does not read oversized files, but still checks the same private
      // owner/DACL and non-symlink requirements before considering any unlink.
      assertPrivateFile(file, { maxBytes: Number.MAX_SAFE_INTEGER });
      const owned = lstatSync(file), partial = entries[0] === 'partial.zip';
      if (partial) need(owned.size >= current.bytes, 'CACHE_IN_USE');
      let contentValid = owned.size === current.bytes;
      if (contentValid) {
        try { inspectedContent(file, current); }
        catch (error) { if (!invalidCacheContent(error)) throw error; contentValid = false; }
      }
      if (partial) need(!contentValid, 'CACHE_IN_USE');
      let retainedShared = false;
      // A different stable ID can reference the same digest. Its cache remains
      // available; malformed/unknown metadata is preserved without deletion.
      for (const name of readdirSync(cache)) {
        if (name === id + '.json' || /^[0-9a-f]{64}$/.test(name)) continue;
        need(name.endsWith('.json') && reproId(name.slice(0, -5)), 'CACHE_UNSAFE');
        const reference = privateJson(join(cache, name));
        need(reference?.schema === SCHEMA && reference.record?.reproId === name.slice(0, -5) && validETag(reference.etag), 'CACHE_UNSAFE');
        if (record(reference.record).digest === current.digest) retainedShared = true;
      }
      // Only valid shared bytes remain useful to another ID. Removing corrupt
      // bytes leaves those IDs' pointers intact so their next fetch starts at 0.
      retainedShared &&= contentValid;
      const latest = lstatSync(file);
      const latestEntries = readdirSync(root);
      need(['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => latest[key] === owned[key])
        && latestEntries.length === 1 && latestEntries[0] === entries[0], 'CACHE_IN_USE');
      assertPrivateFile(file, { maxBytes: Number.MAX_SAFE_INTEGER });
      if (!retainedShared) rmSync(file);
      rmSync(pointer);
      return { state: 'cache-deleted', reproId: id, digest: current.digest, removedBytes: retainedShared ? 0 : owned.size, retainedShared };
    });
  });
}
