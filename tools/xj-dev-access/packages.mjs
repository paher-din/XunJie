import { openPackageStore, PART_SIZE, quotedEtag } from './package-store.mjs';
import { createOssStorage } from './oss-storage.mjs';
import { requireAccess } from '../xj-dev/src/enrollment-protocol.mjs';

export function createPackages(access, config, { storage, now = Date.now } = {}) {
  const catalog = openPackageStore(access, config, now), objects = storage ?? createOssStorage(config, { now });
  const response = p => ({ transferId: p.id, record: catalog.record(p), partSize: PART_SIZE, partCount: catalog.partCount(p), limits: catalog.limits });
  const active = p => requireAccess(p.state !== 'failed', 'TRANSFER_FAILED', 409);
  const checkHead = (p, head) => requireAccess(head && head.bytes === p.bytes && head.crc64 === p.crc64 && quotedEtag(head.etag)
    && (!p.etag || p.etag === head.etag), 'OBJECT_MISMATCH', 409);
  const confirmed = async p => {
    const remote = await objects.list(p.object_key, p.upload_id), claims = catalog.parts(p.id);
    requireAccess(new Set(remote.map(x => x.partNumber)).size === remote.length, 'OBJECT_MISMATCH', 409);
    return remote.map(part => {
      const claim = claims.find(c => c.partNumber === part.partNumber);
      requireAccess(claim && part.bytes === claim.bytes && quotedEtag(part.etag)
        && part.etag.slice(1, -1).toLowerCase() === Buffer.from(claim.contentMD5, 'base64').toString('hex'), 'OBJECT_MISMATCH', 409);
      return { ...claim, etag: part.etag };
    }).sort((a, b) => a.partNumber - b.partNumber);
  };
  return {
    catalog,
    async handle(operation, identity, input) {
      // The existing resolve proof target already requires file:read. Catalog
      // reads neither sign object URLs nor expose owner/admin operations.
      if (operation === 'resolve' && input.catalog === 'baselines') {
        return { baselines: catalog.baselines().map(baseline => {
          const p = catalog.get(baseline.reproId);
          requireAccess(p.state === 'published', 'PACKAGE_NOT_READY', 409);
          return { ...baseline, digest: p.digest, bytes: p.bytes };
        }) };
      }
      if (operation === 'upload') {
        let p = catalog.reservation(identity, input);
        if (p.state === 'uploading' && !p.upload_id) p = catalog.setUpload(p.id, await objects.initiate(p.object_key));
        return response(p);
      }
      if (operation === 'resolve') {
        const p = catalog.get(input.reproId); requireAccess(p.state === 'published', 'PACKAGE_NOT_READY', 409);
        const head = await objects.head(p.object_key); checkHead(p, head);
        requireAccess(Number.isSafeInteger(input.offset) && input.offset >= 0 && input.offset <= p.bytes, 'PART_INVALID');
        requireAccess(input.offset === 0 && input.etag === undefined || input.etag === head.etag, 'ETAG_CHANGED', 409);
        if (input.offset === p.bytes) return { record: catalog.record(p), etag: head.etag, authorization: null };
        const authorization = await objects.download(p.object_key, input.offset, head.etag);
        catalog.grant(p.id, identity.deviceId, authorization.expiresAt);
        return { record: catalog.record(p), etag: head.etag, authorization };
      }
      let p = catalog.own(input.transferId, identity.memberId); active(p);
      if (operation === 'upload-status') {
        return { ...response(p), parts: p.state === 'published' ? [] : p.upload_id ? await confirmed(p) : [] };
      }
      if (operation === 'upload-parts') {
        requireAccess(p.state === 'uploading' && p.upload_id, 'UPLOAD_CONFLICT', 409);
        const claims = catalog.declareParts(p.id, input.parts), parts = [];
        for (const claim of claims) {
          const authorization = await objects.part(p.object_key, p.upload_id, claim);
          catalog.grant(p.id, identity.deviceId, authorization.expiresAt); parts.push({ ...claim, ...authorization });
        }
        return { transferId: p.id, parts };
      }
      requireAccess(operation === 'complete', 'NOT_FOUND', 404);
      if (p.state === 'published') { checkHead(p, await objects.head(p.object_key)); return { record: catalog.record(p) }; }
      // A previous Complete may have succeeded even if its response was lost.
      let head = await objects.head(p.object_key);
      if (!head) {
        requireAccess(p.upload_id, 'UPLOAD_INCOMPLETE', 409);
        const parts = await confirmed(p); requireAccess(parts.length === catalog.partCount(p), 'UPLOAD_INCOMPLETE', 409);
        await objects.complete(p.object_key, p.upload_id, parts); head = await objects.head(p.object_key);
      }
      checkHead(p, head); return { record: catalog.publish(p.id, head) };
    },
    async admin(operation, input) {
      if (operation === 'package-quota') return catalog.quota(input.memberId);
      if (operation === 'package-baselines') return { baselines: catalog.baselines({ includeRetired: true }) };
      if (operation === 'package-baseline') return catalog.addBaseline(input);
      if (operation === 'package-baseline-retire') return catalog.retireBaseline(input);
      requireAccess(operation === 'package-cleanup', 'ADMIN_OPERATION_INVALID');
      // Deny before abort. Retries remain possible without touching published or
      // referenced objects, even when the storage operation temporarily fails.
      const p = catalog.fail(input.transferId); await objects.abort(p.object_key, p.upload_id); catalog.cleaned(p.id);
      return { transferId: p.id, failed: true, multipartAborted: true, signedUrlsValidUntil: p.max_url_expiry || null,
        remainingUrlValidityMs: Math.max(0, p.max_url_expiry - now()) };
    },
  };
}
