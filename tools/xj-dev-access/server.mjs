import { createServer as httpsServer } from 'node:https';
import { createServer as httpServer } from 'node:http';
import { chmodSync, copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ACCESS_PROTOCOL, AccessError, privateJson, requireAccess, writePrivateJson } from '../xj-dev/src/enrollment-protocol.mjs';
import { openAccessStore } from './store.mjs';
import { authenticateDevice } from './identity.mjs';
import { applicationOperation, systemOperation } from './adapters.mjs';
import { localSocket } from '../../apps/teaching/server/access/local-socket.ts';

async function readBody(req) {
  let body = '';
  for await (const bytes of req) { body += bytes; requireAccess(Buffer.byteLength(body) <= 16384, 'REQUEST_TOO_LARGE', 413); }
  try { return JSON.parse(body); } catch { throw new AccessError('INVALID_JSON'); }
}
const reply = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };

export function createAccessService(config, adapters = {}) {
  requireAccess(typeof config.serviceId === 'string' && config.serviceId.length <= 128 && new URL(config.endpoint).protocol === 'https:', 'CONFIGURATION_INVALID');
  requireAccess(Array.isArray(config.courseIds) && config.courseIds.length && config.target?.schema === 'xj-dev/connection-v1', 'CONFIGURATION_INVALID');
  const store = openAccessStore(config.databaseFile, config.credentialKeyFile, config.serviceId, adapters.now);
  const system = adapters.system ?? (input => systemOperation(config.systemCommand, input));
  const application = adapters.application ?? ((operation, input) => applicationOperation(config.applicationSocket, operation, input));
  let queue = Promise.resolve();
  const serial = work => { const next = queue.then(work); queue = next.catch(() => {}); return next; };
  const configuration = id => {
    const d = store.activeDevice(id); requireAccess(d.state === 'active' && d.ssh_username, 'DEVICE_NOT_READY', 409);
    const m = store.member(d.member_id), capabilities = JSON.parse(d.capabilities);
    const node = capabilities.find(cap => cap.startsWith('node:'));
    return { identity: store.identity(id), connection: { ...config.target, browserUser: d.ssh_username,
      knownHosts: readFileSync(config.knownHostsFile, 'utf8'), caPem: readFileSync(config.cloudCaFile, 'utf8'),
      ...(node ? { nodeId: node.slice(5), nodeUser: d.ssh_username, ...config.nodes[node.slice(5)] } : {}) }, account: store.credentials(m.id) };
  };
  async function enroll(envelope) {
    const initial = store.authenticateProof(envelope, '/v1/enroll');
    if (!initial.ssh_ready) {
      const receipt = await system({ operation: 'ensure', deviceId: initial.id, publicKey: initial.public_key, capabilities: JSON.parse(initial.capabilities) });
      requireAccess(typeof receipt.username === 'string' && /^xjd_[0-9a-f]{28}$/.test(receipt.username), 'SSH_RECEIPT_INVALID', 503);
      store.stage(initial.id, 'ssh_ready', receipt);
    }
    const d = store.activeDevice(initial.id), m = store.member(d.member_id);
    if (!d.app_ready) {
      await application('ensure', { externalId: m.id, ...store.credentials(m.id), courseId: m.course_id, role: m.app_role });
      store.stage(d.id, 'app_ready');
    }
    store.activate(d.id); return configuration(d.id);
  }
  async function revokeDevice(id) {
    store.denyDevice(id);
    await system({ operation: 'revoke', deviceId: id }); store.closed(id);
    return { deviceId: id, denied: true, connectionsClosed: true };
  }
  async function admin(operation, input) {
    if (operation === 'invite') {
      requireAccess(config.courseIds.includes(input.courseId), 'COURSE_NOT_GRANTED', 403);
      requireAccess(input.capabilities?.includes('page') && input.capabilities.every(cap => cap === 'page' || cap.startsWith('node:') && config.nodes?.[cap.slice(5)]), 'CAPABILITY_NOT_GRANTED', 403);
      const i = store.createInvitation(input);
      return { protocol: ACCESS_PROTOCOL, serviceId: config.serviceId, endpoint: config.endpoint,
        caPem: readFileSync(config.tls.caFile, 'utf8'), sshKnownHosts: readFileSync(config.knownHostsFile, 'utf8'), cloudCaPem: readFileSync(config.cloudCaFile, 'utf8'), ...i };
    }
    if (operation === 'inspect') return store.inspect();
    if (operation === 'revoke-invitation') { store.revokeInvitation(input.invitationId); return { invitationId: input.invitationId, revoked: true }; }
    if (operation === 'revoke-device') return revokeDevice(input.deviceId);
    if (operation === 'revoke-member') {
      const devices = store.denyMember(input.memberId), failed = [];
      try { await application('disable', { externalId: input.memberId }); } catch { failed.push('application'); }
      for (const d of devices.filter(device => !device.close_ready)) {
        try { await system({ operation: 'revoke', deviceId: d.id }); store.closed(d.id); }
        catch { failed.push(d.id); }
      }
      requireAccess(!failed.length, 'REVOCATION_INCOMPLETE', 503);
      return { memberId: input.memberId, denied: true, devicesClosed: devices.length, applicationDisabled: true };
    }
    if (operation === 'snapshot') {
      const file = input.destination;
      requireAccess(typeof file === 'string' && file.startsWith(config.backupDirectory + '/') && /^[A-Za-z0-9_-]+\.sqlite$/.test(file.slice(config.backupDirectory.length + 1)), 'BACKUP_PATH_INVALID');
      const keyFile = file + '.key', receiptFile = file + '.json';
      requireAccess(![file, keyFile, receiptFile].some(existsSync), 'BACKUP_TARGET_EXISTS');
      try {
        await store.snapshot(file);
        copyFileSync(config.credentialKeyFile, keyFile); chmodSync(keyFile, 0o600);
        writePrivateJson(receiptFile, { format: 'xunjie/dev-access-backup-v1', serviceId: config.serviceId, databaseFile: file, credentialKeyFile: keyFile });
        return { file, keyFile, receiptFile };
      } catch (error) { for (const path of [file, keyFile, receiptFile]) rmSync(path, { force: true }); throw error; }
    }
    throw new AccessError('ADMIN_OPERATION_INVALID');
  }
  let inFlight = 0;
  const publicServer = httpsServer({ key: readFileSync(config.tls.keyFile), cert: readFileSync(config.tls.certFile) }, async (req, res) => {
    let entered = false;
    try {
      requireAccess(inFlight < 8, 'RATE_LIMITED', 429); inFlight++; entered = true;
      if (req.method === 'GET' && req.url === '/health/live') return reply(res, 200, { ok: true, data: { protocol: ACCESS_PROTOCOL, serviceId: config.serviceId } });
      requireAccess(req.method === 'POST', 'METHOD_NOT_ALLOWED', 405);
      const input = await readBody(req);
      let data;
      if (req.url === '/v1/challenges') data = store.issueChallenge(input);
      else if (req.url === '/v1/enroll') data = await serial(() => enroll(input));
      else if (req.url === '/v1/config') { const identity = authenticateDevice(store, input, req.url, 'page'); data = configuration(identity.deviceId); }
      else if (req.url === '/v1/identity') data = authenticateDevice(store, input, req.url);
      else throw new AccessError('NOT_FOUND', 404);
      reply(res, 200, { ok: true, data });
    } catch (error) { reply(res, error instanceof AccessError ? error.status : 503, { ok: false, code: error instanceof AccessError ? error.code : 'ACCESS_UNAVAILABLE' }); }
    finally { if (entered) inFlight--; }
  });
  publicServer.requestTimeout = 10000; publicServer.headersTimeout = 5000;
  const adminServer = httpServer(async (req, res) => {
    try { requireAccess(req.method === 'POST', 'METHOD_NOT_ALLOWED', 405); const data = await serial(() => readBody(req).then(body => admin(req.url.slice(1), body))); reply(res, 200, { ok: true, data }); }
    catch (error) { reply(res, error instanceof AccessError ? error.status : 503, { ok: false, code: error instanceof AccessError ? error.code : 'ACCESS_UNAVAILABLE' }); }
  });
  const adminEndpoint = localSocket(config.adminSocket);
  let closed = false, started = false;
  return {
    store, publicServer, adminServer,
    async listen() {
      if (started || closed) throw new AccessError('SERVICE_ALREADY_STARTED', 409);
      started = true;
      try {
        await adminEndpoint.listen(adminServer, 0o600);
        await new Promise((accept, reject) => {
          const fail = error => { publicServer.off('listening', ready); reject(error); };
          const ready = () => { publicServer.off('error', fail); accept(); };
          publicServer.once('error', fail); publicServer.once('listening', ready);
          publicServer.listen(config.port ?? 8443, config.listenHost ?? '0.0.0.0');
        });
      } catch (error) { await adminEndpoint.close(adminServer); throw error; }
    },
    async close() {
      if (closed) return; closed = true;
      publicServer.closeAllConnections(); adminServer.closeAllConnections();
      await Promise.all([new Promise(done => publicServer.close(done)), adminEndpoint.close(adminServer)]);
      await queue; store.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let service;
  try {
    requireAccess(process.version === 'v24.21.0' && process.platform === 'linux', 'LINUX_NODE_24_REQUIRED');
    const config = privateJson(process.argv[2]); service = createAccessService(config); await service.listen();
    process.once('SIGTERM', () => { void service.close(); }); process.once('SIGINT', () => { void service.close(); });
    process.stdout.write(JSON.stringify({ kind: 'dev-access-ready', protocol: ACCESS_PROTOCOL, serviceId: config.serviceId }) + '\n');
  } catch { process.stderr.write('Developer access startup failed; check controlled configuration.\n'); await service?.close().catch(() => {}); process.exitCode = 1; }
}
