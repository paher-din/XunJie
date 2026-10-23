import { request } from 'node:http';
import { createRequire } from 'node:module';
import { AccessError, requireAccess } from '../xj-dev/src/enrollment-protocol.mjs';

// Fixed IMDSv2 origin; never obtained from a member request or a signed URL.
function metadata(path, method, headers = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(deadline); error ? reject(new AccessError('OBJECT_STORAGE_UNAVAILABLE', 503)) : resolve(value); };
    const req = request({ host: '100.100.100.200', port: 80, path, method, headers }, res => {
      let value = '';
      res.on('data', x => { value += x; if (value.length > 65536) req.destroy(); });
      res.once('error', finish); res.once('aborted', () => finish(true));
      res.once('end', () => finish(res.statusCode !== 200, value));
    });
    const deadline = setTimeout(() => { req.destroy(); finish(true); }, 2500);
    req.once('error', finish); req.end();
  });
}
export function imdsCredentials(roleName, { now = Date.now, read = metadata } = {}) {
  requireAccess(/^[A-Za-z0-9_-]{1,64}$/.test(roleName ?? ''), 'PACKAGE_CONFIGURATION_INVALID');
  let cached, pending;
  return async function credentials() {
    if (cached && cached.expiresAt - now() > 600000) return cached;
    if (pending) return pending;
    pending = (async () => {
      const token = await read('/latest/api/token', 'PUT', { 'X-aliyun-ecs-metadata-token-ttl-seconds': '1800' });
      requireAccess(typeof token === 'string' && token.length > 0 && token.length < 8192 && !/[\r\n]/.test(token), 'OBJECT_STORAGE_UNAVAILABLE', 503);
      let body; try { body = JSON.parse(await read('/latest/meta-data/ram/security-credentials/' + roleName, 'GET', { 'X-aliyun-ecs-metadata-token': token })); }
      catch { throw new AccessError('OBJECT_STORAGE_UNAVAILABLE', 503); }
      const expiresAt = Date.parse(body.Expiration);
      requireAccess(body.Code === 'Success' && ['AccessKeyId', 'AccessKeySecret', 'SecurityToken'].every(k => typeof body[k] === 'string' && body[k].length > 0)
        && Number.isFinite(expiresAt) && expiresAt - now() > 60000, 'OBJECT_STORAGE_UNAVAILABLE', 503);
      cached = Object.freeze({ accessKeyId: body.AccessKeyId, accessKeySecret: body.AccessKeySecret, stsToken: body.SecurityToken, expiresAt });
      return cached;
    })().catch(() => { throw new AccessError('OBJECT_STORAGE_UNAVAILABLE', 503); });
    try { return await pending; } finally { pending = undefined; }
  };
}

export function createOssStorage(config, { now = Date.now, credentials = imdsCredentials(config.roleName), SDK } = {}) {
  requireAccess(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.bucket ?? '') && config.region === 'oss-cn-beijing'
    && config.prefix === 'team/', 'PACKAGE_CONFIGURATION_INVALID');
  const host = config.bucket + '.oss-cn-beijing.aliyuncs.com';
  let Constructor = SDK;
  const client = async (publicEndpoint = false) => {
    // Construct after a full, immutable credential snapshot. signatureUrlV4 must
    // never refresh a shared client halfway through building its query string.
    const snapshot = await credentials();
    Constructor ??= createRequire(import.meta.url)('ali-oss');
    return { snapshot, sdk: new Constructor({ ...snapshot, bucket: config.bucket, region: config.region,
      endpoint: publicEndpoint ? 'https://oss-cn-beijing.aliyuncs.com' : 'https://oss-cn-beijing-internal.aliyuncs.com',
      authorizationV4: true, secure: true, timeout: 3000, retryMax: 0 }) };
  };
  const own = key => requireAccess(typeof key === 'string' && /^team\/packages\/xjp_[a-f0-9-]{36}\/repro\.zip$/.test(key), 'OBJECT_KEY_INVALID');
  const safe = async work => { try { return await work(); } catch (e) { if (e instanceof AccessError) throw e; throw new AccessError('OBJECT_STORAGE_UNAVAILABLE', 503); } };
  async function sign(key, method, headers, queries, additional) {
    own(key); const { sdk, snapshot } = await client(true);
    const seconds = Math.min(300, Math.floor((snapshot.expiresAt - now() - 30000) / 1000));
    requireAccess(seconds > 0, 'OBJECT_STORAGE_UNAVAILABLE', 503);
    const url = await sdk.signatureUrlV4(method, seconds, { headers, queries }, key, additional);
    const parsed = new URL(url);
    requireAccess(parsed.protocol === 'https:' && parsed.host === host && !parsed.username && !parsed.password, 'OBJECT_STORAGE_UNAVAILABLE', 503);
    // The SDK rounds its signing time to whole seconds. Report that exact expiry,
    // rather than now()+TTL which would overstate the remaining validity.
    const stamp = parsed.searchParams.get('x-oss-date'), ttl = Number(parsed.searchParams.get('x-oss-expires'));
    requireAccess(/^\d{8}T\d{6}Z$/.test(stamp ?? '') && ttl === seconds, 'OBJECT_STORAGE_UNAVAILABLE', 503);
    const base = Date.parse(stamp.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'));
    return { method, url, headers, expiresAt: base + ttl * 1000, allowedHost: host };
  }
  return {
    async initiate(key) { return safe(async () => {
      own(key); const { sdk } = await client();
      // Recover an init whose reply was lost before its uploadId reached SQLite.
      const found = await sdk.listUploads({ prefix: key, 'max-uploads': 100 });
      const old = (found.uploads ?? []).filter(x => x.name === key).sort((a, b) => String(a.initiated).localeCompare(String(b.initiated)))[0];
      if (old) return old.uploadId;
      return (await sdk.initMultipartUpload(key, { mime: 'application/zip' })).uploadId;
    }); },
    async list(key, uploadId) { return safe(async () => {
      own(key); const { sdk } = await client(), result = await sdk.listParts(key, uploadId, { 'max-parts': 100 });
      requireAccess(result.isTruncated !== true && result.isTruncated !== 'true', 'OBJECT_MISMATCH', 409);
      return (Array.isArray(result.parts) ? result.parts : [result.parts]).map(p => ({ partNumber: Number(p.PartNumber), bytes: Number(p.Size), etag: p.ETag }));
    }); },
    async part(key, uploadId, claim) { return safe(() => sign(key, 'PUT', { host, 'content-length': String(claim.bytes),
      'content-md5': claim.contentMD5, 'content-type': 'application/octet-stream' }, { partNumber: String(claim.partNumber), uploadId }, ['content-length', 'host'])); },
    async head(key) { return safe(async () => {
      own(key); const { sdk } = await client();
      let result; try { result = await sdk.head(key); } catch (e) { if (e.code === 'NoSuchKey' || e.status === 404) return null; throw e; }
      const h = result.res.headers;
      return { bytes: Number(h['content-length']), crc64: h['x-oss-hash-crc64ecma'], etag: h.etag };
    }); },
    async complete(key, uploadId, parts) { return safe(async () => {
      own(key); const { sdk } = await client();
      await sdk.completeMultipartUpload(key, uploadId, parts.map(p => ({ number: p.partNumber, etag: p.etag })), { headers: { 'x-oss-forbid-overwrite': 'true' } });
    }); },
    async download(key, offset, etag) { return safe(() => sign(key, 'GET', { host, range: 'bytes=' + offset + '-', 'if-match': etag }, {}, ['host', 'if-match', 'range'])); },
    async abort(key, uploadId) { return safe(async () => {
      own(key); const { sdk } = await client();
      const remaining = async () => {
        const listed = await sdk.listUploads({ prefix: key, 'max-uploads': 100 });
        requireAccess(!listed.isTruncated, 'OBJECT_STORAGE_UNAVAILABLE', 503);
        return (listed.uploads ?? []).filter(x => x.name === key).map(x => x.uploadId);
      };
      const ids = [...new Set([...(uploadId ? [uploadId] : []), ...await remaining()])];
      for (const id of ids) { try { await sdk.abortMultipartUpload(key, id); } catch (e) { if (e.code !== 'NoSuchUpload' && e.status !== 404) throw e; } }
      // This method is called only after catalog.fail has denied a nonpublished,
      // unreferenced record. Remove a Complete whose success reply was lost too.
      const exists = async () => { try { await sdk.head(key); return true; } catch (e) { if (e.code === 'NoSuchKey' || e.status === 404) return false; throw e; } };
      if (await exists()) await sdk.delete(key);
      requireAccess(!await exists() && (await remaining()).length === 0, 'OBJECT_STORAGE_UNAVAILABLE', 503);
    }); },
  };
}
