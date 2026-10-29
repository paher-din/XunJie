#!/usr/bin/env node
// Disposable real S3 acceptance host. No package dependencies; Node.js 24 + tar + ps.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

// Official GitHub release asset digests, independently checked against the
// downloaded archives. Binary digests pin --binary as strictly as --download.
const RELEASE = 'https://github.com/seaweedfs/seaweedfs/releases/tag/4.50';
const COMMIT = 'ec8f9793502c59ce3381cc4151bfc0806afd92e8';
const PINS = {
  'darwin-arm64': {
    asset: 'darwin_arm64.tar.gz',
    archiveSha256: '97514d9e704dec19ea9258b3b93766b5613d954a3740e9e868e88c5cfbfaf10e',
    binarySha256: '415ed1a7926aaafd299ec15ae57547a2af2765585eafa78ecc4a7460fc75a504',
  },
  'linux-x64': {
    asset: 'linux_amd64.tar.gz',
    archiveSha256: '8fc88061421a74d1cd486d1cd9dc5874d6495f9ed17fed8fa677bb16bd195b07',
    binarySha256: '0c6d5539b58357d8a1cceb098dc6f086e8aa2f50c1d1072c7442618e6130fb25',
  },
};
const HELP = `Usage (Node.js 24):
  node scripts/storage-s3-fixture.mjs --binary /absolute/path/to/weed --root /tmp/new-s3-fixture
  node scripts/storage-s3-fixture.mjs --download --root /tmp/new-s3-fixture
  node scripts/storage-s3-fixture.mjs --stop --root /tmp/new-s3-fixture

Pinned official SeaweedFS 4.50: macOS arm64 / Linux amd64 only.
Start requires a new or empty private directory outside this repository.
stdout: absolute s3-config.json path only, after authenticated bucket readiness.
stderr: public version, source URL, SHA256 and process metadata; never credentials.
Private JSON contains endpoint/region/bucket/accessKeyId/secretAccessKey/id.
All services bind 127.0.0.1; data, logs and credentials remain under --root.
--stop verifies process ownership before SIGTERM and preserves data/config.
After stopping, remove --root yourself when its acceptance data is no longer needed.
`;

function options(argv) {
  const value = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (['--download', '--stop', '--help'].includes(flag)) value[flag.slice(2)] = true;
    else if (['--binary', '--root'].includes(flag) && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      if (value[flag.slice(2)]) throw Error(`Duplicate ${flag}`);
      value[flag.slice(2)] = argv[++i];
    } else throw Error(`Unknown or incomplete option: ${flag}`);
  }
  if (value.help) return value;
  if (!value.root) throw Error('--root is required');
  if (value.stop ? value.binary || value.download : Boolean(value.binary) === Boolean(value.download)) {
    throw Error('Choose --binary or --download for start; --stop only accepts --root');
  }
  return value;
}

const digest = value => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
async function fileDigest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function json(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw Error(`${command} failed (exit ${result.status ?? 'unavailable'})`);
  return result.stdout.trim();
}
function processInfo(pid) {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'stat=', '-o', 'args='], { encoding: 'utf8' });
  if (result.error) throw Error('Cannot inspect fixture process with ps');
  if (result.status === 1 && !result.stdout.trim()) return null;
  if (result.status !== 0) throw Error('Cannot inspect fixture process with ps');
  const match = result.stdout.trim().match(/^(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(\S+)\s+([\s\S]*)$/);
  if (!match) throw Error('Unexpected ps output; refusing process operation');
  return { started: match[1], state: match[2], args: match[3] };
}
async function stop(root) {
  const path = join(root, 'process.json');
  const state = JSON.parse(await readFile(path, 'utf8'));
  if (state.root !== root || !Number.isSafeInteger(state.pid) || state.pid <= 1) throw Error('Invalid fixture process record');
  const info = processInfo(state.pid);
  if (info && !info.state.startsWith('Z')) {
    if (info.started !== state.started || info.args !== state.args.join(' ')) {
      throw Error('Process ownership mismatch; refusing to stop');
    }
    process.kill(state.pid, 'SIGTERM');
    for (let attempt = 0; attempt < 150; attempt++) {
      const current = processInfo(state.pid);
      if (!current || current.state.startsWith('Z') || current.started !== state.started) break;
      if (attempt === 149) throw Error('Graceful shutdown still pending; no forced termination');
      await delay(100);
    }
  }
  await unlink(path);
  console.error(JSON.stringify({ stopped: true, pid: state.pid, dataRetainedAt: root }));
}

async function bucketHead(config) {
  const url = new URL('/' + config.bucket, config.endpoint);
  const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = date.slice(0, 8), payload = digest('');
  const headers = { host: url.host, 'x-amz-content-sha256': payload, 'x-amz-date': date };
  const names = 'host;x-amz-content-sha256;x-amz-date';
  const canonical = ['HEAD', url.pathname, '', Object.entries(headers).map(([k, v]) => `${k}:${v}\n`).join(''), names, payload].join('\n');
  const scope = `${day}/${config.region}/s3/aws4_request`;
  const key = hmac(hmac(hmac(hmac('AWS4' + config.secretAccessKey, day), config.region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', key).update(`AWS4-HMAC-SHA256\n${date}\n${scope}\n${digest(canonical)}`).digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${names}, Signature=${signature}`;
  return fetch(url, { method: 'HEAD', headers, signal: AbortSignal.timeout(2000) });
}

async function reservePorts() {
  const servers = [], ports = {};
  try {
    for (const name of ['master', 'masterGrpc', 'volume', 'volumeGrpc', 'filer', 'filerGrpc', 's3', 's3Grpc', 'admin', 'adminGrpc']) {
      const server = createServer();
      servers.push(server);
      await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
      ports[name] = server.address().port;
    }
    return ports;
  } finally {
    await Promise.all(servers.filter(server => server.listening).map(server => new Promise(resolve => server.close(resolve))));
  }
}

async function start(opt, root) {
  const pin = PINS[`${process.platform}-${process.arch}`];
  if (!pin) throw Error('Supported platforms: macOS arm64 and Linux amd64');
  const assetUrl = `https://github.com/seaweedfs/seaweedfs/releases/download/4.50/${pin.asset}`;
  try { await mkdir(root, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (await readdir(root)).length) {
    throw Error('--root must be a new or empty directory owned by the current user');
  }
  await chmod(root, 0o700);
  let binary;
  if (opt.download) {
    const archive = join(root, pin.asset);
    const response = await fetch(assetUrl, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok || !response.body) throw Error(`Official asset download failed: HTTP ${response.status}`);
    const file = await open(archive, 'wx', 0o600);
    await pipeline(response.body, file.createWriteStream());
    if (await fileDigest(archive) !== pin.archiveSha256) throw Error('Official archive SHA256 mismatch');
    await mkdir(join(root, 'bin'), { mode: 0o700 });
    run('tar', ['-xzf', archive, '-C', join(root, 'bin'), 'weed']);
    binary = join(root, 'bin', 'weed');
    await chmod(binary, 0o700);
    await unlink(archive);
  } else binary = await realpath(resolve(opt.binary));
  if (await fileDigest(binary) !== pin.binarySha256) throw Error('Pinned binary SHA256 mismatch');
  const version = run(binary, ['version']);
  if (!version.includes(` 4.50 ${COMMIT} `)) throw Error('Pinned SeaweedFS version mismatch');
  const evidence = { version: '4.50', versionOutput: version, releaseUrl: RELEASE, assetUrl, archiveSha256: pin.archiveSha256, binarySha256: pin.binarySha256 };
  await json(join(root, 'evidence.json'), evidence);
  const help = spawnSync(binary, ['mini', '--help'], { encoding: 'utf8' });
  if (help.error || !help.stderr?.includes('-s3.config')) throw Error('Cannot inspect weed mini --help');
  await writeFile(join(root, 'mini-help.txt'), help.stdout + help.stderr, { mode: 0o600, flag: 'wx' });
  const ports = await reservePorts();
  const id = 'issue144-' + randomBytes(6).toString('hex');
  const config = { endpoint: `http://127.0.0.1:${ports.s3}`, region: 'us-east-1', bucket: id, accessKeyId: randomBytes(12).toString('hex'), secretAccessKey: randomBytes(32).toString('hex'), id, forcePathStyle: true };
  const configPath = join(root, 's3-config.json');
  await json(configPath, config);
  await json(join(root, 's3-auth.json'), { identities: [{ name: id, credentials: [{ accessKey: config.accessKeyId, secretKey: config.secretAccessKey }], actions: ['Admin', 'Read', 'List', 'Tagging', 'Write'] }] });
  await mkdir(join(root, 'data'), { mode: 0o700 });
  const flags = {
    dir: join(root, 'data'), ip: '127.0.0.1', 'ip.bind': '127.0.0.1',
    'master.port': ports.master, 'master.port.grpc': ports.masterGrpc,
    'master.peers': 'none', 'master.telemetry': false,
    'volume.port': ports.volume, 'volume.port.grpc': ports.volumeGrpc,
    'filer.port': ports.filer, 'filer.port.grpc': ports.filerGrpc,
    'filer.localSocket': join(root, 'filer.sock'),
    's3.port': ports.s3, 's3.port.grpc': ports.s3Grpc,
    's3.localSocket': join(root, 's3.sock'), 's3.localFilerSocket': join(root, 'filer.sock'),
    's3.config': join(root, 's3-auth.json'), 's3.autoCreateBucket': false, bucket: config.bucket,
    'admin.ui': false, 'admin.port': ports.admin, 'admin.port.grpc': ports.adminGrpc,
    'admin.port.legacy': 0, webdav: false, 's3.port.iceberg': 0, 's3.port.lance': 0,
    'master.volumeSizeLimitMB': 32, 'volume.max': 8, metricsPort: 0, 's3.metricsPort': 0,
  };
  const args = ['mini', ...Object.entries(flags).map(([key, value]) => `-${key}=${value}`)];
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AWS_|S3_|WEED_)/.test(key)));
  env.TMPDIR = root;
  const logPath = join(root, 'weed.log');
  const log = await open(logPath, 'wx', 0o600);
  const child = spawn(binary, args, { cwd: root, env, detached: true, stdio: ['ignore', log.fd, log.fd] });
  try {
    await new Promise((yes, no) => { child.once('spawn', yes); child.once('error', no); });
  } finally { await log.close(); }
  child.unref();
  let ready = false;
  try {
    const info = processInfo(child.pid);
    if (!info) throw Error('SeaweedFS exited before process registration');
    await json(join(root, 'process.json'), { root, pid: child.pid, started: info.started, args: [binary, ...args], ports });
    for (let attempt = 0; attempt < 90; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null) throw Error('SeaweedFS exited during startup; inspect private weed.log');
      try { if ((await bucketHead(config)).status === 200) { ready = true; break; } } catch { /* wait for local services */ }
      await delay(1000);
    }
    if (!ready) throw Error('Authenticated bucket readiness timed out');
    const anonymous = await fetch(config.endpoint + '/' + config.bucket, { method: 'HEAD', signal: AbortSignal.timeout(2000) });
    if (anonymous.status !== 403) throw Error('Anonymous access was not denied');
    const logText = await readFile(logPath, 'utf8');
    if ([config.accessKeyId, config.secretAccessKey].some(secret => logText.includes(secret))) {
      await writeFile(logPath, '[credential-bearing service output removed]\n', { mode: 0o600 });
      throw Error('Service unexpectedly logged credentials; output removed');
    }
    console.error(JSON.stringify({ ...evidence, pid: child.pid, endpoint: config.endpoint }));
    console.log(configPath);
  } catch (error) {
    // This child was created here; never terminate an external process on failure.
    if (child.exitCode === null && child.signalCode === null) {
      try { process.kill(child.pid, 'SIGTERM'); } catch (killError) { if (killError.code !== 'ESRCH') throw killError; }
      await new Promise(resolve => child.exitCode !== null || child.signalCode !== null ? resolve() : child.once('exit', resolve));
    }
    throw error;
  }
}

try {
  const opt = options(process.argv.slice(2));
  if (opt.help) console.log(HELP);
  else {
    process.umask(0o077);
    const requested = resolve(opt.root);
    const root = join(await realpath(dirname(requested)), requested.split(sep).at(-1));
    const repo = await realpath(fileURLToPath(new URL('..', import.meta.url)));
    if (root === repo || root.startsWith(repo + sep)) throw Error('--root must be outside the repository');
    if (opt.stop) await stop(await realpath(root));
    else await start(opt, root);
  }
} catch (error) {
  // Messages above describe operations and paths, never config contents.
  console.error(error.message);
  process.exitCode = 1;
}
