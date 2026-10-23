import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { request } from 'node:https';
import { basename, dirname, join as pathJoin, resolve } from 'node:path';
import { ACCESS_PROTOCOL, assertPrivateFile, digest, ensurePrivateDirectory, opaque, privateJson, publicKey, writePrivateFile, writePrivateJson } from './enrollment-protocol.mjs';
import { enrollmentKeygen, signEnrollmentProof } from './enrollment-ssh.mjs';
import { CliError } from './envelope.mjs';
import { loadConnection } from './connection.mjs';
import { toolHome } from './paths.mjs';
import { acquireLock } from './state.mjs';

const STAGE = 'xj-dev/enrollment-stage-v1', RESULT = 'xj-dev/registration-v1';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const serverCodes = new Set(['INVITATION_INVALID', 'INVITATION_EXPIRED', 'INVITATION_KEY_MISMATCH', 'DEVICE_ALREADY_REGISTERED',
  'DEVICE_REVOKED', 'DEVICE_NOT_READY', 'DEVICE_KEY_MISMATCH', 'PROOF_EXPIRED_OR_REPLAYED', 'PROOF_INVALID', 'RATE_LIMITED',
  'ACCESS_UNAVAILABLE', 'APPLICATION_CONTROL_UNAVAILABLE', 'SSH_RECEIPT_INVALID', 'CAPABILITY_DENIED', 'PACKAGES_UNAVAILABLE',
  'TRANSFER_NOT_FOUND', 'TRANSFER_NOT_OWNED', 'TRANSFER_FAILED', 'UPLOAD_CONFLICT', 'PACKAGE_METADATA_INVALID', 'PACKAGE_TOO_LARGE',
  'MEMBER_QUOTA_EXCEEDED', 'TEAM_QUOTA_EXCEEDED', 'PART_INVALID', 'PART_CONFLICT', 'UPLOAD_INCOMPLETE', 'OBJECT_MISMATCH',
  'PACKAGE_NOT_READY', 'ETAG_CHANGED', 'OBJECT_STORAGE_UNAVAILABLE']);
function fail(code) {
  return new CliError('enrollment', code, `开发接入未完成（${code}）。`, {
    retryable: ['ACCESS_UNREACHABLE', 'ACCESS_UNAVAILABLE', 'APPLICATION_CONTROL_UNAVAILABLE', 'RATE_LIMITED', 'PACKAGES_UNAVAILABLE', 'OBJECT_STORAGE_UNAVAILABLE'].includes(code),
    recovery: '保留现有设备和连接；核对邀请、主机信任与服务状态后，使用同一设备文件显式重试。',
  });
}
function need(condition, code = 'ENROLLMENT_STATE_INVALID') { if (!condition) throw fail(code); }
function safe(error) {
  if (error instanceof CliError && error.stage === 'enrollment') return error;
  return fail(['PRIVATE_FILE_REQUIRED', 'PRIVATE_PATH_REQUIRED', 'PRIVATE_PATH_UNSAFE', 'PRIVATE_DIRECTORY_REQUIRED', 'PRIVATE_PERMISSIONS_REQUIRED'].includes(error?.code)
    ? 'PRIVATE_FILE_REQUIRED' : error?.code === 'DEVICE_SIGNING_FAILED' ? 'DEVICE_SIGNING_FAILED' : 'ENROLLMENT_STATE_INVALID');
}
function directory(path) {
  ensurePrivateDirectory(path); need(lstatSync(path).isDirectory()); return path;
}
function enrollmentRoot(home = toolHome()) {
  home = resolve(home);
  if (!existsSync(home)) mkdirSync(home, { recursive: true, mode: 0o700 });
  return directory(pathJoin(realpathSync(home), 'enrollment'));
}
function certificates(value) {
  need(typeof value === 'string' && value.length <= 65536, 'INVITATION_INVALID');
  const blocks = value.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  need(blocks?.length && !value.replace(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g, '').trim(), 'INVITATION_INVALID');
  try { return blocks.map(block => digest(new X509Certificate(block).raw)).sort(); }
  catch { throw fail('INVITATION_INVALID'); }
}
function pins(value) {
  need(typeof value === 'string' && value.length <= 65536, 'HOST_IDENTITY_CHANGED');
  const lines = value.trim().split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#')).map(line => {
    const [host, kind, key] = line.trim().split(/\s+/);
    need(/^(?:[A-Za-z0-9][A-Za-z0-9.-]*|\[[A-Za-z0-9][A-Za-z0-9.-]*\]:[0-9]+)$/.test(host ?? ''), 'HOST_IDENTITY_CHANGED');
    try { return `${host} ${publicKey(`${kind} ${key}`)}`; } catch { throw fail('HOST_IDENTITY_CHANGED'); }
  });
  need(lines.length > 0 && lines.length <= 32, 'HOST_IDENTITY_CHANGED'); return [...new Set(lines)].sort();
}
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function trustFrom(invite) {
  need(invite?.protocol === ACCESS_PROTOCOL && typeof invite.serviceId === 'string' && invite.serviceId.length > 0 && invite.serviceId.length <= 128
    && id(invite.invitationId) && typeof invite.secret === 'string' && invite.secret.length >= 16 && invite.secret.length <= 128
    && Number.isSafeInteger(invite.expiresAt), 'INVITATION_INVALID');
  let endpoint;
  try { endpoint = new URL(invite.endpoint); } catch { throw fail('INVITATION_INVALID'); }
  need(endpoint.protocol === 'https:' && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash && endpoint.pathname === '/', 'INVITATION_INVALID');
  certificates(invite.caPem); certificates(invite.cloudCaPem); pins(invite.sshKnownHosts);
  return { endpoint: endpoint.origin, caPem: invite.caPem, cloudCaPem: invite.cloudCaPem, sshKnownHosts: invite.sshKnownHosts };
}
function location(stage, deviceFile) {
  need(stage?.schema === STAGE && typeof stage.serviceId === 'string' && id(stage.invitationId) && object(stage.trust));
  const base = dirname(deviceFile), service = dirname(base), root = dirname(service);
  need(basename(deviceFile) === 'stage.json' && basename(base) === stage.invitationId
    && basename(service) === digest(stage.serviceId).slice(0, 24) && basename(root) === 'enrollment');
  for (const path of [root, service, base]) { directory(path); }
  return { root, base, deviceFile, identityFile: pathJoin(base, 'device_ed25519') };
}
function stateAt(file) {
  file = resolve(file); const stage = privateJson(file), paths = location(stage, file);
  assertPrivateFile(paths.identityFile);
  return { stage, paths };
}
function resolveDevice(input = {}) {
  if (typeof input === 'string') return resolve(input);
  if (input.deviceFile) return resolve(input.deviceFile);
  const pointer = pathJoin(resolve(input.home ?? toolHome()), 'enrollment', 'registration.json');
  if (!existsSync(pointer)) return undefined;
  const value = privateJson(pointer);
  need(value.schema === RESULT && typeof value.deviceFile === 'string');
  const root = dirname(pointer), deviceFile = resolve(value.deviceFile);
  need(deviceFile.startsWith(root + '/') || process.platform === 'win32' && deviceFile.startsWith(root + '\\'));
  return deviceFile;
}
function identity(value, previous) {
  need(object(value) && id(value.memberId) && id(value.deviceId) && ['developer', 'maintainer'].includes(value.teamRole)
    && Array.isArray(value.capabilities) && value.capabilities.length > 0
    && value.capabilities.every(cap => ['page', 'file:read', 'file:publish'].includes(cap) || /^node:[A-Za-z0-9_-]{1,64}$/.test(cap)), 'IDENTITY_MISMATCH');
  if (previous) need(value.memberId === previous.memberId && value.deviceId === previous.deviceId, 'IDENTITY_MISMATCH');
  return { memberId: value.memberId, deviceId: value.deviceId, teamRole: value.teamRole, capabilities: [...new Set(value.capabilities)] };
}
function visible(stage, paths) {
  const result = { schema: RESULT, state: stage.registration ? 'registered' : 'prepared', serviceId: stage.serviceId,
    invitationId: stage.invitationId, deviceFile: paths.deviceFile, identityFile: paths.identityFile };
  if (stage.registration) {
    need(/^generation-[A-Za-z0-9_-]+$/.test(stage.registration.generation));
    const generation = pathJoin(paths.base, stage.registration.generation);
    directory(generation);
    result.identity = identity(stage.registration.identity);
    result.connectionFile = pathJoin(generation, 'connection.json'); result.accountFile = pathJoin(generation, 'account.json');
    if (result.identity.capabilities.includes('page')) {
      for (const file of [result.connectionFile, result.accountFile]) assertPrivateFile(file);
    } else { delete result.connectionFile; delete result.accountFile; }
  }
  return result;
}
function locked(paths, work) {
  const lock = acquireLock({ root: paths.base, lockFile: pathJoin(paths.base, 'operation-lock') });
  try { return work(); } finally { lock.release(); }
}
async function lockedAsync(paths, work) {
  const lock = acquireLock({ root: paths.base, lockFile: pathJoin(paths.base, 'operation-lock') });
  try { return await work(); } finally { lock.release(); }
}

// All public results below omit invitation secrets, credentials and proof bytes.
export function prepareEnrollment({ home, invitationFile, inviteFile } = {}) {
  try {
    const invite = privateJson(invitationFile ?? inviteFile), trust = trustFrom(invite), root = enrollmentRoot(home);
    const service = directory(pathJoin(root, digest(invite.serviceId).slice(0, 24))), base = directory(pathJoin(service, invite.invitationId));
    const paths = { root, base, deviceFile: pathJoin(base, 'stage.json'), identityFile: pathJoin(base, 'device_ed25519') };
    return locked(paths, () => {
      let stage;
      if (existsSync(paths.deviceFile)) {
        stage = privateJson(paths.deviceFile); location(stage, paths.deviceFile);
        need(stage.serviceId === invite.serviceId && stage.invitationId === invite.invitationId && equal(stage.trust, trust)
          && (!stage.invitationSecret || stage.invitationSecret === invite.secret), 'INVITATION_CHANGED');
      } else {
        stage = { schema: STAGE, serviceId: invite.serviceId, invitationId: invite.invitationId, trust,
          invitationSecret: invite.secret, usedProofs: [] };
        writePrivateJson(paths.deviceFile, stage);
      }
      if (!existsSync(paths.identityFile)) {
        need(!stage.registration && !stage.publicKey, 'DEVICE_KEY_MISSING');
        const generated = spawnSync(enrollmentKeygen(), ['-q', '-t', 'ed25519', '-N', '', '-C', 'xj-dev-device', '-f', paths.identityFile],
          { stdio: 'ignore', timeout: 10000, windowsHide: true });
        need(generated.status === 0, 'DEVICE_KEY_CREATION_FAILED');
        // ssh-keygen writes inside our private directory. Republish through the
        // shared writer so Windows files also receive its protected user DACL.
        const bytes = readFileSync(paths.identityFile);
        try { writePrivateFile(paths.identityFile, bytes); } finally { bytes.fill(0); }
        if (existsSync(paths.identityFile + '.pub')) writePrivateFile(paths.identityFile + '.pub', readFileSync(paths.identityFile + '.pub'));
      }
      assertPrivateFile(paths.identityFile);
      const key = keyFor(paths);
      need(!stage.publicKey || stage.publicKey === key, 'DEVICE_KEY_CHANGED');
      if (!stage.publicKey) { stage.publicKey = key; writePrivateJson(paths.deviceFile, stage); }
      return visible(stage, paths);
    });
  } catch (error) { throw safe(error); }
}
function keyFor(paths) {
  assertPrivateFile(paths.identityFile);
  const generated = spawnSync(enrollmentKeygen(), ['-y', '-f', paths.identityFile], { encoding: 'utf8', timeout: 10000,
    stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  need(generated.status === 0, 'DEVICE_KEY_INVALID');
  try { return publicKey(generated.stdout); } catch { throw fail('DEVICE_KEY_INVALID'); }
}
function http(trust, path, body) {
  return new Promise((accept, reject) => {
    const bytes = JSON.stringify(body);
    need(Buffer.byteLength(bytes) <= 16384, 'REQUEST_TOO_LARGE');
    const req = request(new URL(path, trust.endpoint), { method: 'POST', ca: trust.caPem, rejectUnauthorized: true, agent: false,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(bytes), connection: 'close' } }, res => {
      let text = '', size = 0;
      res.setEncoding('utf8');
      res.on('data', chunk => { size += Buffer.byteLength(chunk); if (size > 131072) req.destroy(); else text += chunk; });
      res.on('aborted', () => reject(fail('ACCESS_UNREACHABLE')));
      res.on('error', () => reject(fail('ACCESS_UNREACHABLE')));
      res.on('end', () => {
        let result; try { result = JSON.parse(text); } catch { return reject(fail('ACCESS_RESPONSE_INVALID')); }
        if (res.statusCode !== 200 || result?.ok !== true) return reject(fail(serverCodes.has(result?.code) ? result.code : 'ACCESS_REJECTED'));
        if (!object(result.data)) return reject(fail('ACCESS_RESPONSE_INVALID'));
        accept(result.data);
      });
    });
    req.setTimeout(10000, () => req.destroy());
    req.on('error', error => reject(fail(/CERT|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/.test(error.code ?? '') ? 'TLS_IDENTITY_CHANGED' : 'ACCESS_UNREACHABLE')));
    req.end(bytes);
  });
}
async function signed(stage, paths, path, body) {
  need(/^\/v1\/[a-z][a-z0-9/-]*$/.test(path) && !path.includes('..'), 'INVALID_REQUEST');
  const key = keyFor(paths), bodyHash = digest(JSON.stringify(body));
  need(key === stage.publicKey, 'DEVICE_KEY_CHANGED');
  const challenge = await http(stage.trust, '/v1/challenges', { method: 'POST', path, bodyHash, publicKey: key,
    ...(path === '/v1/enroll' ? { invitationSecret: body.invitationSecret } : { deviceId: body.deviceId }) });
  need(challenge.serviceId === stage.serviceId && id(challenge.challengeId) && typeof challenge.nonce === 'string'
    && challenge.nonce.length >= 16 && challenge.nonce.length <= 128 && Number.isSafeInteger(challenge.expiresAt)
    && challenge.expiresAt > Date.now() && challenge.expiresAt <= Date.now() + 300000
    && challenge.method === 'POST' && challenge.path === path && challenge.bodyHash === bodyHash, 'CHALLENGE_INVALID');
  need(Array.isArray(stage.usedProofs), 'ENROLLMENT_STATE_INVALID');
  const used = stage.usedProofs.filter(item => item.expiresAt > Date.now());
  const idHash = digest(challenge.challengeId), nonceHash = digest(challenge.nonce);
  need(!used.some(item => item.idHash === idHash || item.nonceHash === nonceHash), 'CHALLENGE_REUSED');
  stage.usedProofs = [...used, { idHash, nonceHash, expiresAt: challenge.expiresAt }];
  writePrivateJson(paths.deviceFile, stage); // Persist consumption before signing/sending; retries obtain a new challenge.
  return http(stage.trust, path, { challengeId: challenge.challengeId, signature: signEnrollmentProof(paths.identityFile, challenge), body });
}
function publish(stage, paths, response) {
  need(object(response), 'ACCESS_RESPONSE_INVALID');
  const who = identity(response.identity, stage.registration?.identity), supplied = response.connection;
  if (!who.capabilities.includes('page')) {
    need(response.connection === undefined && response.account === undefined, 'ACCESS_RESPONSE_INVALID');
    // File-only identities never acquire an SSH account or product credential.
    // Keep an empty private generation so the same atomic registration pointer
    // and recovery behavior apply to both enrollment shapes.
    const name = 'generation-' + opaque(); directory(pathJoin(paths.base, name));
    stage.registration = { generation: name, identity: who }; delete stage.invitationSecret;
    writePrivateJson(paths.deviceFile, stage);
    writePrivateJson(pathJoin(paths.root, 'registration.json'), { schema: RESULT, deviceFile: paths.deviceFile });
    return visible(stage, paths);
  }
  need(object(response.connection) && object(response.account), 'ACCESS_RESPONSE_INVALID');
  const expectedPins = pins(stage.trust.sshKnownHosts);
  need(equal(pins(supplied.knownHosts), expectedPins), 'HOST_IDENTITY_CHANGED');
  need(equal(certificates(supplied.caPem), certificates(stage.trust.cloudCaPem)), 'TLS_IDENTITY_CHANGED');
  const hostToken = supplied.port === 22 ? supplied.host : `[${supplied.host}]:${supplied.port}`;
  need(expectedPins.some(line => line.startsWith(hostToken + ' ')), 'HOST_IDENTITY_CHANGED');
  need(typeof response.account.loginName === 'string' && response.account.loginName.length > 0 && response.account.loginName.length <= 256
    && typeof response.account.password === 'string' && response.account.password.length > 0 && response.account.password.length <= 4096, 'ACCESS_RESPONSE_INVALID');
  const name = 'generation-' + opaque(), generation = directory(pathJoin(paths.base, name));
  let published = false;
  try {
    const knownHostsFile = pathJoin(generation, 'known_hosts'), caFile = pathJoin(generation, 'cloud-ca.pem');
    writePrivateFile(knownHostsFile, expectedPins.join('\n') + '\n'); writePrivateFile(caFile, stage.trust.cloudCaPem);
    const connection = { schema: 'xj-dev/connection-v1', identityFile: paths.identityFile, knownHostsFile, caFile };
    for (const key of ['host', 'port', 'browserUser', 'applicationPort', 'browserOrigin', 'nodeId', 'nodeUser', 'remoteRunnerPort',
      'localRunnerPort', 'expectedBackendVersion', 'bindAddress']) if (supplied[key] !== undefined) connection[key] = supplied[key];
    if (connection.nodeId) { need(who.capabilities.includes('node:' + connection.nodeId), 'CAPABILITY_DENIED'); connection.nodeIdentityFile = paths.identityFile; }
    const connectionFile = pathJoin(generation, 'connection.json');
    writePrivateJson(connectionFile, connection);
    try { loadConnection(connectionFile); } catch { throw fail('CONNECTION_INVALID'); }
    writePrivateJson(pathJoin(generation, 'account.json'), { loginName: response.account.loginName, password: response.account.password });
    stage.registration = { generation: name, identity: who }; delete stage.invitationSecret;
    writePrivateJson(paths.deviceFile, stage); published = true;
    const pointer = pathJoin(paths.root, 'registration.json');
    if (!existsSync(pointer) || privateJson(pointer).deviceFile !== paths.deviceFile) writePrivateJson(pointer, { schema: RESULT, deviceFile: paths.deviceFile });
    return visible(stage, paths);
  } finally { if (!published) rmSync(generation, { recursive: true, force: true, maxRetries: 3 }); }
}
export async function joinEnrollment(options = {}) {
  try {
    const prepared = options.invitationFile || options.inviteFile ? prepareEnrollment(options) : undefined;
    const file = prepared?.deviceFile ?? resolveDevice(options); need(file, 'DEVICE_NOT_PREPARED');
    const { paths } = stateAt(file);
    return await lockedAsync(paths, async () => {
      const { stage } = stateAt(file);
      const response = stage.registration
        ? await signed(stage, paths, '/v1/config', { deviceId: stage.registration.identity.deviceId })
        : await signed(stage, paths, '/v1/enroll', { invitationSecret: stage.invitationSecret });
      return publish(stage, paths, response);
    });
  } catch (error) { throw safe(error); }
}
export async function refreshEnrollment(options = {}) {
  try {
    const file = resolveDevice(options); need(file, 'DEVICE_NOT_REGISTERED');
    const { paths } = stateAt(file);
    return await lockedAsync(paths, async () => {
      const { stage } = stateAt(file); need(stage.registration, 'DEVICE_NOT_REGISTERED');
      return publish(stage, paths, await signed(stage, paths, '/v1/config', { deviceId: stage.registration.identity.deviceId }));
    });
  } catch (error) { throw safe(error); }
}
export function readRegistration(options = {}) {
  try { const file = resolveDevice(options); if (!file) return undefined; const { stage, paths } = stateAt(file); return visible(stage, paths); }
  catch (error) { throw safe(error); }
}
export function loadDevice(file) { const device = readRegistration(file); need(device, 'DEVICE_NOT_REGISTERED'); return device; }

// Internal integration API: callers must keep its response private (e.g. config
// contains account credentials). CLI join/refresh expose only the projections above.
export async function authenticatedRequest(deviceFile, path, body = {}) {
  try {
    const { paths } = stateAt(resolveDevice(deviceFile));
    return await lockedAsync(paths, async () => {
      const { stage } = stateAt(paths.deviceFile); need(stage.registration, 'DEVICE_NOT_REGISTERED');
      need(object(body) && (body.deviceId === undefined || body.deviceId === stage.registration.identity.deviceId), 'INVALID_REQUEST');
      const result = await signed(stage, paths, path, { ...body, deviceId: stage.registration.identity.deviceId });
      if (path === '/v1/identity') return identity(result, stage.registration.identity);
      return result;
    });
  } catch (error) { throw safe(error); }
}
export { prepareEnrollment as prepare, joinEnrollment as join, refreshEnrollment as refresh };
