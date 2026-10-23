import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { request } from 'node:https';
import { CliError } from './envelope.mjs';

export const CONNECTION_SCHEMA = 'xj-dev/connection-v1';
export function connectionError(code, retryable = false) {
  return new CliError('connection', code, {
    CONNECTION_INVALID: '需要获准的连接配置、私钥路径、SSH 主机 pin 和 HTTPS CA。',
    PERMISSION_REVOKED: 'SSH 公钥授权失效；停止自动重试。',
    HOST_IDENTITY_CHANGED: 'SSH 主机身份与已核定 pin 不符；停止自动重试。',
    TLS_IDENTITY_CHANGED: 'HTTPS 证书校验失败；停止自动重试。',
    BACKEND_INCOMPATIBLE: '目标不符合当前 session/health 接口契约。',
    CLOUD_UNREACHABLE: '云端连接不可达；保留当前数据目标。',
    NODE_OFFLINE: '已登记执行节点的本机监听端口离线；任务绑定和未知结果保持原样。',
    PORT_IN_USE: '连接端口被其他进程占用；不接管该进程。',
  }[code] ?? code, { retryable, recovery: retryable ? '恢复网络或节点后重新执行 up/node connect；查看 status。' : '核对获准配置与身份后显式重试；不自动接受新主机身份。' });
}

function regular(file) {
  if (!file || !existsSync(file)) throw connectionError('CONNECTION_INVALID');
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw connectionError('CONNECTION_INVALID');
  return file;
}
function pathFrom(base, value) {
  if (typeof value !== 'string' || !value) return undefined;
  return resolve(base, value.startsWith('~/') ? join(homedir(), value.slice(2)) : value);
}
const portValid = value => Number.isInteger(value) && value > 0 && value <= 65535;
const userValid = value => typeof value === 'string' && /^[a-z_][a-z0-9_-]{0,31}$/.test(value);

// The owner handover predates registered-v1. Read OpenSSH's resolved paths without
// connecting, accepting new keys, or copying its credentials into a second config.
function ownerPaths(file, raw) {
  if (!raw.sshUser || !raw.profile) return {};
  const sshConfig = join(dirname(file), 'ssh.conf');
  if (!existsSync(sshConfig)) return {};
  const out = execFileSync('ssh', ['-G', '-F', sshConfig, 'xunjie-cloud-browser'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const fields = Object.fromEntries(out.trim().split('\n').map(line => { const i = line.indexOf(' '); return [line.slice(0, i), line.slice(i + 1)]; }));
  if (fields.hostname !== raw.host || fields.user !== raw.browserUser || Number(fields.port) !== raw.port) throw connectionError('CONNECTION_INVALID');
  return { identityFile: fields.identityfile, knownHostsFile: fields.userknownhostsfile, caFile: join(dirname(file), 'cloud-server.cert.pem') };
}

export function loadConnection(file, options = {}) {
  try {
    file = resolve(file);
    const raw = JSON.parse(readFileSync(regular(file), 'utf8'));
    if (!(raw.schema === CONNECTION_SCHEMA || raw.version === 1 && raw.registered === true || raw.sshUser && raw.profile)) throw connectionError('CONNECTION_INVALID');
    const base = dirname(file);
    const c = { ...ownerPaths(file, raw), ...raw, file };
    c.identityFile = regular(pathFrom(base, options.identity ?? c.identityFile));
    c.knownHostsFile = regular(pathFrom(base, c.knownHostsFile));
    c.caFile = regular(pathFrom(base, c.caFile ?? (existsSync(join(base, 'cloud-server.cert.pem')) ? 'cloud-server.cert.pem' : undefined)));
    if (typeof c.host !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(c.host) || !portValid(c.port) || !userValid(c.browserUser) || !portValid(c.applicationPort)) throw connectionError('CONNECTION_INVALID');
    const origin = new URL(c.browserOrigin);
    if (origin.protocol !== 'https:' || !['localhost', '127.0.0.1'].includes(origin.hostname) || origin.origin !== c.browserOrigin) throw connectionError('CONNECTION_INVALID');
    const hostToken = c.port === 22 ? c.host : `[${c.host}]:${c.port}`;
    const pins = readFileSync(c.knownHostsFile, 'utf8').trim().split(/\r?\n/).filter(line => line && !line.startsWith('#'));
    if (!pins.some(line => line.startsWith(hostToken + ' ssh-ed25519 ') && /^[A-Za-z0-9+/=]+$/.test(line.split(/\s+/)[2] ?? ''))) throw connectionError('HOST_IDENTITY_CHANGED');
    const nodeFields = ['nodeId', 'nodeUser', 'remoteRunnerPort', 'localRunnerPort'];
    if (nodeFields.some(k => c[k] !== undefined) && (!/^[A-Za-z0-9_-]{1,64}$/.test(c.nodeId ?? '') || !userValid(c.nodeUser) || !portValid(c.remoteRunnerPort) || !portValid(c.localRunnerPort))) throw connectionError('CONNECTION_INVALID');
    if (c.nodeIdentityFile) c.nodeIdentityFile = regular(pathFrom(base, c.nodeIdentityFile));
    c.id = createHash('sha256').update(JSON.stringify([c.host, c.port, c.browserUser, c.applicationPort, c.browserOrigin, c.identityFile, readFileSync(c.knownHostsFile, 'utf8'), readFileSync(c.caFile, 'utf8'), c.nodeId, c.nodeUser, c.remoteRunnerPort, c.localRunnerPort, c.nodeIdentityFile])).digest('hex').slice(0, 12);
    return c;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw connectionError('CONNECTION_INVALID');
  }
}

export function sshArguments(c, kind, localPort) {
  const nullFile = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const args = ['-F', nullFile, '-N', '-T', '-p', String(c.port), '-i', kind === 'node' ? c.nodeIdentityFile ?? c.identityFile : c.identityFile];
  if (kind === 'node') args.push('-v');
  for (const option of ['StrictHostKeyChecking=yes', `UserKnownHostsFile=${c.knownHostsFile}`, `GlobalKnownHostsFile=${nullFile}`, 'HostKeyAlgorithms=ssh-ed25519', 'UpdateHostKeys=no', 'IdentitiesOnly=yes', 'IdentityAgent=none', 'BatchMode=yes', 'PreferredAuthentications=publickey', 'PasswordAuthentication=no', 'KbdInteractiveAuthentication=no', 'ExitOnForwardFailure=yes', 'ForwardAgent=no', 'ForwardX11=no', 'ConnectTimeout=5', 'ServerAliveInterval=5', 'ServerAliveCountMax=2']) args.push('-o', option);
  if (c.bindAddress) {
    // Forward destinations remain loopback even when a source address is selected.
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(c.bindAddress)) throw connectionError('CONNECTION_INVALID');
    args.push('-o', `BindAddress=${c.bindAddress}`);
  }
  if (kind === 'node') {
    if (!c.nodeId) throw connectionError('NODE_OFFLINE');
    args.push('-R', `127.0.0.1:${c.remoteRunnerPort}:127.0.0.1:${c.localRunnerPort}`, `${c.nodeUser}@${c.host}`);
  } else args.push('-L', `127.0.0.1:${localPort}:127.0.0.1:${c.applicationPort}`, `${c.browserUser}@${c.host}`);
  return args;
}

export function classifySshFailure(stderr) {
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|No .* host key is known/i.test(stderr)) return connectionError('HOST_IDENTITY_CHANGED');
  if (/Permission denied|Authentication failed|Load key .*:|sign_and_send_pubkey/i.test(stderr)) return connectionError('PERMISSION_REVOKED');
  if (/Address already in use|cannot listen to port|remote port forwarding failed/i.test(stderr)) return connectionError('PORT_IN_USE');
  return connectionError('CLOUD_UNREACHABLE', true);
}

export function cloudRequest(c, localPort, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((done, reject) => {
    const req = request({ hostname: '127.0.0.1', port: localPort, servername: new URL(c.browserOrigin).hostname, ca: readFileSync(c.caFile), method, path, headers: { host: new URL(c.browserOrigin).host, connection: 'close', ...headers }, timeout: 5000 }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; if (text.length > 2 * 1024 * 1024) req.destroy(new Error('response limit')); });
      res.on('end', () => { let json; try { json = JSON.parse(text); } catch {} done({ status: res.statusCode, headers: res.headers, text, json }); });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', error => reject(connectionError(/CERT|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/.test(error.code ?? '') ? 'TLS_IDENTITY_CHANGED' : 'CLOUD_UNREACHABLE', !/CERT|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/.test(error.code ?? ''))));
    req.end(body);
  });
}

export async function checkBackend(c, localPort) {
  const live = await cloudRequest(c, localPort, '/health/live');
  const ready = await cloudRequest(c, localPort, '/health/ready');
  if (live.status !== 200 || ready.status !== 200) throw connectionError('CLOUD_UNREACHABLE', true);
  const session = await cloudRequest(c, localPort, '/api/session');
  if (live.json?.data?.status !== 'alive' || ready.json?.data?.status !== 'ready' || session.status !== 401 || session.json?.error?.code !== 'UNAUTHENTICATED') throw connectionError('BACKEND_INCOMPATIBLE');
  const page = await cloudRequest(c, localPort, '/');
  const asset = page.text.match(/src="(\/assets\/[^"<>]+\.js)"/)?.[1];
  if (page.status !== 200 || !asset) throw connectionError('BACKEND_INCOMPATIBLE');
  const version = ready.headers['x-xunjie-version'] ?? null;
  if (c.expectedBackendVersion && version !== c.expectedBackendVersion) throw connectionError('BACKEND_INCOMPATIBLE');
  return { protocol: 'xunjie/session-v1', backendVersion: version, versionSource: version ? 'server' : 'not-exposed', deployedFrontend: asset, checkedAt: new Date().toISOString() };
}
