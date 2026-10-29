#!/usr/bin/env node
// Issue #143: consume a relocated distribution only; no product/source/test imports.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const help = `Standalone XunJie package black-box probe (macOS arm64 / Windows x64).
Usage: <bundled-node> scripts/probe-product-package.mjs --package DIR --out FILE [--keep-running[=true|false]] [--path-mode chinese|ascii|chinese-package|chinese-data]
Copies the COMPLETE distribution outside the repository to a Chinese/space path.
--path-mode is for path diagnosis; only the default chinese mode can pass Windows acceptance.
Invokes its public xunjie launcher with a system-only PATH, no NODE_PATH/NODE_OPTIONS.
Uses only its psql/pg_ctl/pg_dump/pg_restore, and public database credentialRef.
Creates two private disposable environments and an independent SQL fixture (no course data).
Default: stop, verify stopped, remove the temporary copy/environments on success.
--keep-running: leave A ready and return {url,root,packagePath,temporaryPath,stopCommand} in JSON.
The caller must stop A with the copied CLI, verify it stopped, then remove temporaryPath.
On failure: attempt public CLI stops; retain diagnostics/data/copy, never delete live data.
No signing/notarization, clean-machine, real sleep/wake, cross-machine or browser acceptance.
`;

function parse(argv) {
  const result = { keepRunning: false, pathMode: 'chinese' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--keep-running' || arg.startsWith('--keep-running=')) {
      let value = arg.includes('=') ? arg.slice('--keep-running='.length) : 'true';
      if (arg === '--keep-running' && ['true', 'false'].includes(argv[i + 1])) value = argv[++i];
      assert(['true', 'false'].includes(value), '--keep-running must be true or false');
      result.keepRunning = value === 'true';
    } else if (arg === '--path-mode') {
      result.pathMode = argv[++i];
      assert(['chinese', 'ascii', 'chinese-package', 'chinese-data'].includes(result.pathMode), 'Invalid path mode');
    } else {
      assert(['--package', '--out'].includes(arg) && argv[i + 1] && !argv[i + 1].startsWith('--'), `Invalid option: ${arg}`);
      result[arg.slice(2)] = path.resolve(argv[++i]);
    }
  }
  assert(result.package && result.out, '--package DIR and --out FILE are required');
  return result;
}

const windows = process.platform === 'win32';
const windowsRoot = process.env.SystemRoot || 'C:\\Windows';
const powershell = path.join(windowsRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const psArgs = script => ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from("$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding = [Text.UTF8Encoding]::new(); " + script, 'utf16le').toString('base64')];
const psLiteral = value => "'" + value.replaceAll("'", "''") + "'";
const containsPath = (text, target) => windows
  ? text.replaceAll('\\', '/').toLowerCase().includes(target.replaceAll('\\', '/').toLowerCase())
  : text.includes(target);
const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);
const rounded = value => Math.round(value * 100) / 100;
async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

// Compare every regular file and symlink, not just an application entry or manifest.
async function inventory(directory) {
  const root = await realpath(directory);
  const entries = [];
  async function visit(relative) {
    const names = (await readdir(path.join(root, relative))).sort();
    for (const name of names) {
      const rel = path.join(relative, name);
      const file = path.join(root, rel);
      const stat = await lstat(file);
      if (stat.isSymbolicLink()) {
        assert(inside(root, await realpath(file)), `External package symlink: ${rel}`);
        entries.push({ path: rel, type: 'symlink', target: await readlink(file), bytes: stat.size, mode: stat.mode & 0o777 });
      } else if (stat.isDirectory()) {
        entries.push({ path: rel, type: 'directory', mode: stat.mode & 0o777 });
        await visit(rel);
      } else {
        assert(stat.isFile(), `Unsupported package entry: ${rel}`);
        entries.push({ path: rel, type: 'file', bytes: stat.size, mode: stat.mode & 0o777, sha256: await digest(file) });
      }
    }
  }
  await visit('');
  return { regularFileBytes: entries.filter(e => e.type === 'file').reduce((sum, e) => sum + e.bytes, 0),
    files: entries.filter(e => e.type === 'file').length, symlinks: entries.filter(e => e.type === 'symlink').length,
    treeSha256: createHash('sha256').update(JSON.stringify(entries)).digest('hex') };
}

async function main(options) {
  const started = performance.now();
  const repository = await realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const source = await realpath(options.package);
  assert(!inside(source, options.out), 'Evidence must not modify the candidate package');
  const secrets = new Set();
  const redact = value => {
    let text = String(value);
    for (const secret of secrets) if (secret) text = text.replaceAll(secret, '[redacted]');
    return text;
  };
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(NODE|NPM|npm_config_|PG|DYLD_|LD_)/.test(key) && !['BASH_ENV', 'ENV', 'CDPATH'].includes(key) && key.toUpperCase() !== 'PATH'));
  // macOS ps renders UTF-8 argv as M- byte escapes under LC_ALL=C. A UTF-8
  // locale plus -ww is necessary to identify the actual Chinese/space paths.
  Object.assign(env, { PATH: windows ? [path.join(windowsRoot, 'System32'), windowsRoot, path.dirname(powershell)].join(';') : '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', TZ: 'UTC' });
  const report = {
    schemaVersion: 1, issue: 'https://github.com/paher-din/XunJie/issues/143',
    kind: 'relocated-product-package-black-box', status: 'running', startedAt: new Date().toISOString(),
    host: { platform: process.platform, arch: process.arch, osRelease: os.release(), osVersion: os.version(), machine: os.machine() },
    harness: { executable: process.execPath, node: process.version, source: fileURLToPath(import.meta.url), imports: 'Node builtins only' },
    isolation: { pathMode: options.pathMode, childPath: env.PATH, childLocale: env.LC_ALL, nodePathRemoved: !('NODE_PATH' in env), nodeOptionsRemoved: !('NODE_OPTIONS' in env),
      inheritedPgConfigurationRemoved: true, sourceNodeNpmPostgresUsedByProduct: false,
      caveat: 'PATH isolation on an existing user machine, not a clean machine or an OS sandbox' },
    package: { source, signing: 'unsigned candidate; signing/notarization excluded from this round, not blockers' },
    environments: {}, stages: [], commands: [],
    acceptance: { engineering: 'running', browser: 'not-run', teachingEffectiveness: 'not-run',
      cleanMachine: 'not-run', windows: 'not-run', realSleepWake: 'not-run', crossMachine: 'not-run',
      chrome: 'not-run', edge: 'not-required-by-owner', doubleClickLaunch: 'not-run', signingNotarization: 'out-of-scope' },
    limitations: [
      'Only this recorded platform/host and package tree hash; a rebuilt candidate needs a fresh run.',
      'Independent SQL fixture only; no course, Agent, business persistence or teaching acceptance.',
      'Basic same-engine table dump/restore only; PostgreSQL 17 minor/major upgrade paths belong to the separate probe.',
      'HTTP/asset availability is not browser interaction acceptance; no real sleep/wake or cross-machine exercise.',
      'Idle CPU/RSS measures only each owned daemon and its PostgreSQL process tree; not a machine-wide product estimate.',
    ],
  };
  let temporary;
  let packagePath;
  let launcher;
  let bundledNode;
  let pgBin;
  let activeStage;
  let interrupted;
  const environments = [];
  const transactions = new Set();
  const handlers = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => { interrupted = signal; }]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  async function save() {
    await mkdir(path.dirname(options.out), { recursive: true });
    await writeFile(options.out, redact(JSON.stringify(report, null, 2)) + '\n', { mode: 0o600 });
  }
  // stderr/stdout are always redacted before recording; passwords never enter argv or files.
  async function command(executable, args, { password, input, allowFailure = false, timeout = 90_000, cleanup = false, record = true } = {}) {
    if (interrupted && !cleanup) throw new Error(`Interrupted: ${interrupted}`);
    const begin = performance.now();
    const result = await new Promise(resolve => {
      const child = spawn(executable, args, { cwd: temporary, env: { ...env,
        ...(password === undefined ? {} : { PGPASSWORD: password }), PGCONNECT_TIMEOUT: '5', PGCLIENTENCODING: 'UTF8', PGSSLMODE: 'disable' },
      shell: false, windowsHide: true, windowsVerbatimArguments: windows && /cmd\.exe$/i.test(executable), stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = ''; let spawnError; let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeout);
      child.stdout.setEncoding('utf8').on('data', data => { stdout += data; });
      child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
      child.once('error', error => { spawnError = error.message; });
      child.stdin.on('error', () => {});
      child.stdin.end(input);
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, timedOut, ...(spawnError ? { spawnError } : {}), stdout: redact(stdout.trim()), stderr: redact(stderr.trim()), durationMs: rounded(performance.now() - begin) });
      });
    });
    if (record) {
      report.commands.push({ stage: activeStage ?? 'cleanup', executable, args, ...result });
      await save();
    }
    if (!allowFailure) assert(result.code === 0 && !result.timedOut && !result.spawnError,
      `${executable} ${args.join(' ')} failed (${result.code}): ${result.stderr || result.spawnError || result.stdout || result.signal}`);
    return result;
  }
  async function stage(name, action) {
    activeStage = name;
    const entry = { name, status: 'running', startedAt: new Date().toISOString() };
    report.stages.push(entry);
    const begin = performance.now();
    await save();
    try { entry.result = await action(); entry.status = 'passed'; return entry.result; }
    catch (error) { entry.status = 'failed'; entry.error = redact(error.message); throw error; }
    finally { entry.durationMs = rounded(performance.now() - begin); console.log(`${name}: ${entry.status} (${entry.durationMs}ms)`); await save(); activeStage = undefined; }
  }
  function cliInvocation(e, verb, args = []) {
    const argv = [verb, '--root', e.root, ...args];
    if (!windows) return [launcher, argv];
    // .cmd files cannot be spawned with shell:false. Use the fixed system cmd
    // explicitly; all arguments here are harness-generated, quoted, no secrets.
    const quoted = [launcher, ...argv].map(value => {
      assert(!/["%\r\n&|<>^!]/.test(value), 'Unsafe cmd argument');
      return `"${value}"`;
    }).join(' ');
    return [path.join(windowsRoot, 'System32/cmd.exe'), ['/d', '/s', '/c', `"${quoted}"`]];
  }
  async function cli(environment, verb, args = [], cleanup = false) {
    const [exe, argv] = cliInvocation(environment, verb, args);
    const result = await command(exe, argv, { cleanup });
    return JSON.parse(result.stdout);
  }
  function identity(status) {
    const e = status.environment;
    return { environmentId: e.environmentId, installationId: e.installationId, clientNamespace: e.clientNamespace,
      serviceIds: e.services.map(s => s.serviceId), serviceEndpoints: e.services.map(s => s.endpoint) };
  }
  function sameIdentity(environment, status) { assert.deepEqual(identity(status), environment.identity); }
  const pgTool = tool => path.join(pgBin, tool + (windows ? '.exe' : ''));
  const connect = e => ['--host', e.binding.host, '--port', String(e.binding.port), '--username', e.binding.user, '--no-password', '--dbname', e.binding.database];
  async function sql(e, query) {
    const r = await command(pgTool('psql'), ['-X', '-q', '-A', '-t', '--set', 'ON_ERROR_STOP=1', ...connect(e)], { password: e.password, input: query + '\n' });
    return r.stdout;
  }
  async function processes() {
    if (windows) {
      // Query only our copied executable paths; do not record unrelated argv.
      const script = `$items = @(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='postgres.exe'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith(${psLiteral(packagePath)}, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { [pscustomobject]@{ pid=[int]$_.ProcessId; ppid=[int]$_.ParentProcessId; rssKiB=[math]::Round([double]$_.WorkingSetSize/1024,2); cpuSeconds=([double]$_.KernelModeTime+[double]$_.UserModeTime)/10000000; command=$_.CommandLine; executable=$_.ExecutablePath; createdAt=$_.CreationDate.ToUniversalTime().ToString('o') } }); ConvertTo-Json -InputObject $items -Compress`;
      const result = await command(powershell, psArgs(script), { record: false, cleanup: true });
      return JSON.parse(result.stdout || '[]');
    }
    const r = await command('/bin/ps', ['-ww', '-axo', 'pid=,ppid=,rss=,%cpu=,time=,command='], { record: false, cleanup: true });
    return r.stdout.split('\n').map(line => {
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+([\d:.]+)\s+(.+)$/.exec(line);
      if (!m) return null;
      const time = m[5].split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
      return { pid: Number(m[1]), ppid: Number(m[2]), rssKiB: Number(m[3]), psCpuPercent: Number(m[4]), cpuSeconds: time, command: m[6] };
    }).filter(Boolean);
  }
  function daemonRows(rows, e) {
    return rows.filter(row => {
      const text = row.command.replaceAll('"', '');
      return text.includes(path.join(packagePath, 'app/daemon.js') + ' --root ')
        && text.trimEnd().endsWith(' --root ' + e.root);
    });
  }
  async function pgStatus(e) {
    const r = await command(pgTool('pg_ctl'), ['status', '-D', e.data], { allowFailure: true, cleanup: true });
    if (r.code === 3) return null;
    assert.equal(r.code, 0, `Cannot establish PG stopped/running for ${e.name}: ${r.stderr}`);
    const pid = Number(/\bPID:\s*(\d+)/.exec(r.stdout)?.[1]);
    assert(Number.isSafeInteger(pid) && pid > 1, 'pg_ctl status did not identify a postmaster PID');
    return pid;
  }
  async function owned(e) {
    const pgPid = await pgStatus(e);
    assert(pgPid, `${e.name}: PostgreSQL must be running`);
    const all = await processes();
    const daemons = daemonRows(all, e);
    assert.equal(daemons.length, 1, `${e.name}: expected exactly one packaged daemon`);
    const parent = all.find(row => row.pid === pgPid);
    assert(parent && containsPath(parent.command, pgTool('postgres')) && containsPath(parent.command, e.data), 'PG PID is not the owned packaged postgres');
    const pids = new Set([pgPid]);
    for (let changed = true; changed;) {
      changed = false;
      for (const row of all) if (pids.has(row.ppid) && !pids.has(row.pid)) { pids.add(row.pid); changed = true; }
    }
    e.observedPids ??= new Set();
    e.observedWindowsProcesses ??= new Set();
    for (const pid of [...pids, daemons[0].pid]) {
      e.observedPids.add(pid);
      const process = all.find(row => row.pid === pid);
      if (windows) e.observedWindowsProcesses.add(`${pid}:${process.createdAt}`);
    }
    return { daemon: daemons[0], postgres: all.filter(row => pids.has(row.pid)), pgPid };
  }
  const queryRows = 'SELECT COALESCE(jsonb_agg(jsonb_build_object(\'id\',id,\'value\',value) ORDER BY id),\'[]\'::jsonb) FROM package_probe.records;';
  async function rows(e) { return JSON.parse(await sql(e, queryRows)); }
  async function check(e, expected = e.expected) {
    const status = await cli(e, 'status');
    assert.equal(status.state, 'ready'); sameIdentity(e, status);
    assert.equal(status.endpoint, e.endpoint);
    assert.deepEqual(await rows(e), expected);
    const p = await owned(e);
    return { state: status.state, environmentId: e.identity.environmentId, endpoint: status.endpoint, daemonPid: p.daemon.pid, postgresPid: p.pgPid, rows: expected };
  }
  async function http(e) {
    const statusResponse = await fetch(new URL('/runtime/status', e.endpoint), { signal: AbortSignal.timeout(5000) });
    assert.equal(statusResponse.status, 200);
    const status = await statusResponse.json(); sameIdentity(e, status); assert.equal(status.state, 'ready');
    const response = await fetch(e.endpoint, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    const html = await response.text(); assert(/<html/i.test(html));
    const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map(m => m[1]);
    assert(assets.some(asset => asset.endsWith('.js')), 'Web entry must load its bundled JS');
    for (const asset of assets) {
      const url = new URL(asset, e.endpoint); assert.equal(url.origin, new URL(e.endpoint).origin);
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) }); assert.equal(r.status, 200); await r.arrayBuffer();
    }
    return { url: e.endpoint, httpStatus: response.status, assets, browserInteraction: 'not-run' };
  }
  async function assertStopped(e) {
    const status = await cli(e, 'status', [], true);
    sameIdentity(e, status); assert(['stopped', 'uninstalled'].includes(status.state));
    assert.equal(await pgStatus(e), null);
    // A successful stop can precede the daemon's final asynchronous exit.
    for (let i = 0; i < 40; i++) {
      const all = await processes();
      const daemons = daemonRows(all, e);
      const postgres = all.filter(row => containsPath(row.command, pgTool('postgres')) && containsPath(row.command, e.data));
      const previouslyOwned = all.filter(row => windows
        ? e.observedWindowsProcesses?.has(`${row.pid}:${row.createdAt}`)
        : e.observedPids?.has(row.pid));
      if (!daemons.length && !postgres.length && !previouslyOwned.length) {
        e.stopped = true;
        return { state: status.state, daemonAbsent: true, postgresAbsent: true, observedProcessTreeAbsent: true };
      }
      await delay(100);
    }
    throw new Error(`${e.name}: CLI reports stopped but owned processes remain; preserving data`);
  }
  async function stop(e) { await cli(e, 'stop', [], true); return assertStopped(e); }
  async function start(e) {
    e.stopped = false;
    const status = await cli(e, 'start'); assert.equal(status.state, 'ready'); sameIdentity(e, status);
    return status;
  }
  async function bind(e) {
    const binding = await cli(e, 'database');
    assert(binding && /^[a-zA-Z0-9_-]{1,100}$/.test(binding.credentialRef));
    assert.equal(binding.host, '127.0.0.1');
    e.binding = binding;
    e.password = await readFile(path.join(e.root, 'credentials', binding.credentialRef), 'utf8');
    assert(e.password.length > 0); secrets.add(e.password);
    const settings = JSON.parse(await sql(e, `SELECT jsonb_build_object('dataDirectory',current_setting('data_directory'),'version',current_setting('server_version'),'serverPort',current_setting('port')::int,'unixSocketDirectories',current_setting('unix_socket_directories'),'systemIdentifier',(SELECT system_identifier::text FROM pg_control_system()));`));
    e.data = await realpath(settings.dataDirectory);
    assert(inside(e.root, e.data), 'SQL data_directory must belong to the environment created here');
    assert.equal(settings.serverPort, binding.port);
    assert.equal(settings.unixSocketDirectories, '', 'Managed PG must not create Unix-domain sockets');
    Object.assign(report.environments[e.name], { database: binding, postgres: settings });
  }
  async function idle(e) {
    await delay(4000);
    const samples = [];
    for (let i = 0; i < 4; i++) {
      const p = await owned(e);
      samples.push({ atMs: rounded(performance.now()), daemon: p.daemon, postgres: p.postgres,
        rssKiB: p.daemon.rssKiB + p.postgres.reduce((sum, row) => sum + row.rssKiB, 0),
        cpuSeconds: p.daemon.cpuSeconds + p.postgres.reduce((sum, row) => sum + row.cpuSeconds, 0) });
      if (i < 3) await delay(1000);
    }
    assert(samples.every(s => s.daemon.pid === samples[0].daemon.pid));
    assert(samples.every(s => s.postgres.map(p => p.pid).sort().join() === samples[0].postgres.map(p => p.pid).sort().join()), 'Idle PG process tree changed; CPU delta would be ambiguous');
    const elapsedMs = samples.at(-1).atMs - samples[0].atMs;
    return { settleMs: 4000, elapsedMs: rounded(elapsedMs), samples,
      maxRssKiB: Math.max(...samples.map(s => s.rssKiB)),
      intervalCpuPercentOfOneCore: rounded((samples.at(-1).cpuSeconds - samples[0].cpuSeconds) * 100_000 / elapsedMs),
      method: (windows ? 'Win32_Process CIM working set and 100ns CPU counters' : '/bin/ps RSS and CPU time counters') + '; owned daemon plus pg_ctl-identified postmaster and recursive descendants only; RSS is a sum (shared pages may overlap); interval CPU uses the difference of cumulative counters'  };
  }
  try {
    assert((process.platform === 'darwin' && process.arch === 'arm64') || (windows && process.arch === 'x64'), 'Supported: macOS arm64 or Windows x64');
    if (windows) {
      await stage('windows-host-and-non-elevated-token', async () => {
        const r = await command(powershell, psArgs(String.raw`$os=Get-CimInstance Win32_OperatingSystem; $vc=Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64' -ErrorAction SilentlyContinue; [pscustomobject]@{ caption=$os.Caption; version=$os.Version; build=$os.BuildNumber; architecture=$os.OSArchitecture; totalMemoryKiB=$os.TotalVisibleMemorySize; freeMemoryKiB=$os.FreePhysicalMemory; user=[Security.Principal.WindowsIdentity]::GetCurrent().Name; elevated=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator); vcRuntimeInstalled=$vc.Installed; vcRuntimeVersion=$vc.Version } | ConvertTo-Json -Compress`));
        report.host.windows = JSON.parse(r.stdout);
        assert.equal(report.host.windows.elevated, false, 'Windows acceptance requires a non-elevated token');
        return report.host.windows;
      });
    }
    temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), options.pathMode === 'chinese' ? '循阶 包 验收 ' : 'XunJie package probe ')));
    assert(!inside(repository, temporary) && !inside(source, temporary));
    await chmod(temporary, 0o700);
    packagePath = path.join(temporary, ['ascii', 'chinese-data'].includes(options.pathMode) ? 'XunJie package' : '循阶 独立包');
    report.isolation.childCwd = temporary;
    report.package.copy = packagePath;
    report.temporaryPath = temporary;
    await stage('relocate-complete-package', async () => {
      const original = await inventory(source);
      await cp(source, packagePath, { recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true, errorOnExist: true, force: false });
      const copied = await inventory(packagePath); assert.deepEqual(copied, original);
      Object.assign(report.package, copied, { distributionSha256: await digest(path.join(packagePath, 'distribution.json')) });
      const distribution = JSON.parse(await readFile(path.join(packagePath, 'distribution.json'), 'utf8'));
      report.package.createdAt = distribution.createdAt;
      report.package.distributionStatus = distribution.status;
      const resources = JSON.parse(await readFile(path.join(packagePath, 'resources.json'), 'utf8'));
      const node = await realpath(path.resolve(packagePath, resources.nodePath));
      pgBin = await realpath(path.resolve(packagePath, resources.postgresBin));
      bundledNode = node;
      launcher = path.join(packagePath, windows ? 'xunjie.cmd' : 'xunjie');
      assert(inside(packagePath, node) && inside(packagePath, pgBin));
      const pathCheck = windows ? await command(powershell, psArgs("$bad=@('node','npm','psql','pg_ctl','pg_dump','pg_restore') | Where-Object { Get-Command $_ -ErrorAction SilentlyContinue }; if($bad) { throw ($bad -join ',') }; 'no host tools on PATH'")) : await command('/bin/sh', ['-c', 'for tool in node npm psql pg_ctl pg_dump pg_restore; do if command -v "$tool" >/dev/null 2>&1; then echo "unexpected PATH tool: $tool"; exit 1; fi; done']);
      const nodeVersion = (await command(node, ['--version'])).stdout;
      assert.equal(nodeVersion, `v${resources.nodeVersion}`);
      const toolVersions = {};
      for (const tool of ['postgres', 'initdb', 'pg_ctl', 'psql', 'pg_dump', 'pg_restore']) {
        assert(inside(packagePath, await realpath(pgTool(tool))));
        toolVersions[tool] = (await command(pgTool(tool), ['--version'])).stdout;
        assert(toolVersions[tool].includes(` ${resources.postgresVersion}`));
      }
      report.package.toolVersions = { node: nodeVersion, ...toolVersions };
      return { ...copied, externalChineseSpacePath: options.pathMode === 'chinese', pathToolLookupAbsent: pathCheck.code === 0, node, pgBin };
    });
    if (windows) {
      await stage('occupied-directory-refused-with-sentinel-intact', async () => {
        const root = path.join(temporary, '已有 文件目录'); await mkdir(root);
        const sentinel = path.join(root, '用户 文件.txt'); await writeFile(sentinel, 'harness-owned sentinel');
        const [exe, args] = cliInvocation({ root }, 'install', ['--profile', 'local']);
        const r = await command(exe, args, { allowFailure: true });
        assert.notEqual(r.code, 0); assert.match(r.stderr, /Directory is occupied/);
        assert.equal(await readFile(sentinel, 'utf8'), 'harness-owned sentinel');
        assert.deepEqual(await readdir(root), ['用户 文件.txt']);
        return { refused: true, sentinelUnchanged: true, noProductFilesAdded: true };
      });
    }
    for (const name of ['A', 'B']) {
      const e = { name, root: path.join(temporary, ['chinese', 'chinese-data'].includes(options.pathMode) ? `环境 ${name}` : `Environment ${name}`), stopped: false,
        expected: [{ id: 1, value: `${name} 已提交 循阶 包` }] };
      environments.push(e); report.environments[name] = { root: e.root };
      await stage(`${name}-first-install`, async () => {
        const begin = performance.now();
        const status = await cli(e, 'install', ['--profile', 'local']);
        e.identity = identity(status); assert.equal(status.state, 'installed');
        // This fixture always installs a managed database; retain its known
        // directory for safe stop verification even if first start/bind fails.
        e.data = await realpath(path.join(e.root, 'pgdata'));
        Object.assign(report.environments[name], { identity: e.identity, firstInstallMs: rounded(performance.now() - begin) });
        return status;
      });
      await stage(`${name}-first-start`, async () => {
        const begin = performance.now(); const status = await start(e);
        report.environments[name].firstStartMs = rounded(performance.now() - begin);
        e.endpoint = status.endpoint; assert(e.endpoint); report.environments[name].url = e.endpoint;
        await bind(e);
        await sql(e, `CREATE SCHEMA package_probe; CREATE TABLE package_probe.records(id integer PRIMARY KEY,value text NOT NULL); BEGIN; INSERT INTO package_probe.records VALUES(1,'${e.expected[0].value}'); COMMIT;`);
        return { ...(await check(e)), http: await http(e) };
      });
    }
    const [a, b] = environments;
    await stage('A-B-independent-identities-ports-and-start', async () => {
      for (const field of ['environmentId', 'installationId', 'clientNamespace']) assert.notEqual(a.identity[field], b.identity[field]);
      assert(!a.identity.serviceIds.some(id => b.identity.serviceIds.includes(id)));
      const ports = [Number(new URL(a.endpoint).port), Number(new URL(b.endpoint).port), a.binding.port, b.binding.port];
      assert.equal(new Set(ports).size, 4);
      return { ports, A: await check(a), B: await check(b) };
    });
    await stage('repeated-start-reuses-both-instances', async () => {
      const results = {};
      for (const e of environments) {
        const before = await check(e); await start(e); await start(e);
        const after = await check(e); assert.deepEqual(after, before); results[e.name] = after;
      }
      return results;
    });
    await stage('normal-stop-restart-and-two-way-isolation', async () => {
      const results = {};
      for (const [target, peer] of [[a, b], [b, a]]) {
        const before = await check(peer);
        const stopped = await stop(target); assert.deepEqual(await check(peer), before);
        await start(target); const restarted = await check(target); assert.deepEqual(await check(peer), before);
        results[target.name] = { stopped, restarted, peerUnchanged: true };
      }
      return results;
    });
    await stage('uninstall-reinstall-retains-committed-data-and-identity', async () => {
      const results = {};
      for (const [target, peer] of [[a, b], [b, a]]) {
        const before = await check(peer); const bindingBefore = { ...target.binding };
        const status = await cli(target, 'uninstall'); assert.equal(status.state, 'uninstalled'); sameIdentity(target, status);
        const stopped = await assertStopped(target);
        await access(target.data); assert.deepEqual(await check(peer), before);
        const reinstalled = await cli(target, 'install', ['--profile', 'local']); sameIdentity(target, reinstalled);
        await start(target); await bind(target); assert.deepEqual(target.binding, bindingBefore);
        const restored = await check(target); assert.deepEqual(await check(peer), before);
        results[target.name] = { stopped, restored, databaseBindingRetained: true, peerUnchanged: true };
      }
      return results;
    });
    if (windows) {
      await stage('database-and-http-port-conflicts-preserve-foreign-listener', async () => {
        const results = {};
        for (const [label, port] of [['database', a.binding.port], ['http', Number(new URL(a.endpoint).port)]]) {
          await stop(a); const peer = await check(b);
          const sockets = new Set();
          const foreign = createServer(socket => {
            sockets.add(socket);
            socket.on('error', () => {});
            socket.once('close', () => sockets.delete(socket));
            socket.destroy();
          });
          try {
            await new Promise((resolve, reject) => { foreign.once('error', reject); foreign.listen(port, '127.0.0.1', resolve); });
            const [exe, args] = cliInvocation(a, 'start');
            const failed = await command(exe, args, { allowFailure: true });
            assert.notEqual(failed.code, 0);
            assert(foreign.listening, 'Foreign listener was stopped');
            const stopped = await stop(a); assert(foreign.listening);
            assert.deepEqual(await check(b), peer);
            results[label] = { port, startExitCode: failed.code, foreignListenerPreserved: true, stopped, BUnchanged: true };
          } finally {
            for (const socket of sockets) socket.destroy();
            await new Promise(resolve => foreign.close(resolve));
          }
          await start(a); results[label].recovered = await check(a);
        }
        return results;
      });
      await stage('interrupt-starting-cli-and-reuse-owned-daemon', async () => {
        await stop(a); const peer = await check(b);
        const child = spawn(bundledNode, [path.join(packagePath, 'app/cli.js'), 'start', '--root', a.root], {
          cwd: temporary, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        });
        transactions.add(child); let stderr = ''; let spawnError;
        child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
        child.on('error', error => { spawnError = error.message; });
        const closed = new Promise(resolve => child.once('close', resolve));
        let instance; let starting;
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline && child.exitCode === null && !spawnError) {
          try {
            instance = JSON.parse(await readFile(path.join(a.root, 'instance.json'), 'utf8'));
            const response = await fetch(new URL('/runtime/status', a.endpoint), { signal: AbortSignal.timeout(1000) });
            starting = await response.json(); if (starting.state === 'starting') break;
          } catch { /* Wait for the actual daemon's public listener. */ }
          await delay(10);
        }
        try {
          assert.equal(starting?.state, 'starting', `Did not observe startup before interruption: ${redact(stderr || spawnError || '')}`);
          sameIdentity(a, starting);
          process.kill(child.pid, 'SIGKILL'); await closed; transactions.delete(child);
          report.commands.push({ stage: activeStage, action: 'SIGKILL-starting-cli', pid: child.pid, ownedChild: true, daemonPid: instance.pid, observedState: 'starting' });
          await start(a); const recovered = await check(a);
          assert.equal(recovered.daemonPid, instance.pid, 'Retry spawned a duplicate daemon');
          assert.deepEqual(await check(b), peer);
          return { interruptedCliPid: child.pid, observedState: 'starting', recovered, daemonReused: true, BUnchanged: true };
        } finally { if (child.exitCode === null) child.kill('SIGKILL'); transactions.delete(child); }
      });
      await stage('killed-daemon-residual-postgres-stop-and-restart', async () => {
        const peer = await check(b); const before = await owned(a);
        process.kill(before.daemon.pid, 'SIGKILL');
        report.commands.push({ stage: activeStage, action: 'SIGKILL-daemon', pid: before.daemon.pid, ownership: 'CIM exact packaged daemon path/root plus prior public status' });
        await delay(200);
        assert.equal(await pgStatus(a), before.pgPid, 'Expected the real residual PostgreSQL');
        const stopped = await stop(a); await start(a); const recovered = await check(a);
        assert.notEqual(recovered.daemonPid, before.daemon.pid);
        assert.deepEqual(await check(b), peer);
        return { killedDaemonPid: before.daemon.pid, residualPostgresPid: before.pgPid, stopped, recovered, BUnchanged: true };
      });
      await stage('windows-loaded-vc-runtime-libraries', async () => {
        const ownedA = await owned(a);
        const script = `@(Get-Process -Id ${ownedA.daemon.pid},${ownedA.pgPid} | ForEach-Object { $p=$_; $_.Modules | Where-Object { $_.ModuleName -match '^(vcruntime|msvcp|ucrtbase)' } | ForEach-Object { [pscustomobject]@{pid=$p.Id; name=$_.ModuleName; path=$_.FileName; version=$_.FileVersionInfo.FileVersion} } }) | ConvertTo-Json -Compress`;
        const result = await command(powershell, psArgs(script));
        const modules = JSON.parse(result.stdout);
        report.host.loadedRuntimeLibraries = modules;
        return { modules, prerequisite: 'VC++ v14 already installed on this machine; no runtime installation or clean-machine acceptance performed' };
      });
    }
    await stage('managed-postgres-SIGKILL-stop-start-transaction-recovery', async () => {
      const peerBefore = await check(b);
      // Keep an actual open transaction after its INSERT has been acknowledged.
      const application = 'xunjie-package-probe-uncommitted';
      const child = spawn(pgTool('psql'), ['-X', '-q', '-A', '-t', '--set', 'ON_ERROR_STOP=1', ...connect(a)], {
        cwd: temporary, env: { ...env, PGPASSWORD: a.password, PGAPPNAME: application, PGCONNECT_TIMEOUT: '5', PGCLIENTENCODING: 'UTF8', PGSSLMODE: 'disable' },
        shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
      transactions.add(child); let output = ''; let stderr = ''; let spawnError;
      child.stdout.setEncoding('utf8').on('data', data => { output += data; });
      child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
      child.on('error', error => { spawnError = error.message; }); child.stdin.on('error', () => {});
      child.stdin.write("BEGIN; INSERT INTO package_probe.records VALUES(2,'UNCOMMITTED must never survive'); SELECT 'transaction-open';\n");
      const deadline = Date.now() + 10_000;
      while (!output.includes('transaction-open') && !spawnError && child.exitCode === null && Date.now() < deadline) await delay(50);
      assert(output.includes('transaction-open'), `Uncommitted INSERT not acknowledged: ${redact(stderr || spawnError || output)}`);
      assert.equal(await sql(a, `SELECT count(*) FROM pg_stat_activity WHERE application_name='${application}' AND state='idle in transaction' AND xact_start IS NOT NULL;`), '1');
      assert.deepEqual(await rows(a), a.expected, 'Uncommitted INSERT must be invisible to another session before crash');
      const dataBefore = JSON.parse(await sql(a, "SELECT jsonb_build_object('systemIdentifier',(SELECT system_identifier::text FROM pg_control_system()));"));
      const ownedBefore = await owned(a);
      process.kill(ownedBefore.pgPid, 'SIGKILL');
      report.commands.push({ stage: activeStage, action: 'SIGKILL', pid: ownedBefore.pgPid, ownership: 'packaged pg_ctl status PID plus ps executable/data directory and public SQL data_directory' });
      child.stdin.end();
      await delay(500);
      assert.deepEqual(await check(b), peerBefore);
      const stopped = await stop(a); await start(a);
      const recovered = await check(a);
      assert.equal(await sql(a, 'SELECT count(*) FROM package_probe.records WHERE id=2;'), '0');
      const dataAfter = JSON.parse(await sql(a, "SELECT jsonb_build_object('systemIdentifier',(SELECT system_identifier::text FROM pg_control_system()));"));
      assert.deepEqual(dataAfter, dataBefore); assert.deepEqual(await check(b), peerBefore);
      child.kill('SIGTERM'); transactions.delete(child);
      return { killedPostmasterPid: ownedBefore.pgPid, uncommittedInsertAcknowledged: true, idleInTransactionObserved: true,
        committedVisibleBeforeAndAfter: true, uncommittedAbsentAfterRecovery: true, sameClusterIdentifier: dataAfter.systemIdentifier,
        stopped, recovered, BUnchanged: true };
    });
    await stage('bundled-basic-dump-restore-roundtrip', async () => {
      const dump = path.join(temporary, '独立 样本.dump');
      const peerBefore = await check(b);
      await command(pgTool('pg_dump'), [...connect(a), '--format=custom', '--schema=package_probe', '--file', dump], { password: a.password });
      const dumpSha256 = await digest(dump); const bytes = (await lstat(dump)).size; assert(bytes > 0);
      await sql(a, 'DROP SCHEMA package_probe CASCADE;');
      await command(pgTool('pg_restore'), [...connect(a), '--exit-on-error', '--single-transaction', dump], { password: a.password });
      const restored = await check(a); assert.deepEqual(await check(b), peerBefore);
      await rm(dump);
      return { dumpSha256, bytes, restored, BUnchanged: true, scope: 'same-engine independent SQL schema only, no upgrade or full-product backup claim' };
    });
    await stage('http-entry-and-owned-idle-resource-samples', async () => {
      const result = {};
      for (const e of environments) result[e.name] = { http: await http(e), idle: await idle(e) };
      return result;
    });
    if (options.keepRunning) {
      await stage('keep-A-running-stop-and-remove-B', async () => {
        const before = await check(a); const stopped = await stop(b); assert.deepEqual(await check(a), before);
        await rm(b.root, { recursive: true });
        report.handoff = { url: a.endpoint, root: a.root, packagePath, temporaryPath: temporary,
          environmentId: a.identity.environmentId, state: 'ready',
          stopCommand: windows ? [bundledNode, path.join(packagePath, 'app/cli.js'), 'stop', '--root', a.root] : [launcher, 'stop', '--root', a.root],
          cleanup: 'After browser acceptance, use stopCommand, confirm status stopped and pg_ctl status exit 3 with no owned daemon/PG processes, then remove temporaryPath. Never delete live data.' };
        return { B: stopped, BRootRemoved: true, A: before };
      });
      report.cleanup = { mode: 'keep-running', A: 'running, caller owns stop/removal', B: 'stopped-and-removed', packageRetained: true };
    } else {
      await stage('default-cleanup', async () => {
        for (const e of environments) await stop(e);
        assert(environments.every(e => e.stopped));
        await rm(temporary, { recursive: true });
        return { allOwnedEnvironmentsStopped: true, temporaryRemoved: true };
      });
      report.cleanup = { mode: 'default', allOwnedEnvironmentsStopped: true, temporaryRemoved: true };
    }
    report.status = 'passed'; report.acceptance.engineering = 'passed';
    if (windows) report.acceptance.windows = options.pathMode === 'chinese' ? 'passed' : 'partial-diagnostic-paths-only';
  } catch (error) {
    report.status = 'failed'; report.acceptance.engineering = 'failed';
    if (windows) report.acceptance.windows = 'failed';
    report.error = redact(error.message);
    for (const child of transactions) { child.stdin?.end(); child.kill('SIGTERM'); }
    report.failureCleanup = [];
    for (const e of environments) {
      try {
        // Never delete on failure. If installation failed partway, retain even its metadata.
        if (!e.identity || !e.data) {
          await cli(e, 'stop', [], true);
          throw new Error('Incomplete install/binding: CLI stop returned success, but process absence is not fully established; retained without deletion');
        }
        report.failureCleanup.push({ name: e.name, ...(await stop(e)), retained: true });
      } catch (cleanupError) { report.failureCleanup.push({ name: e.name, error: redact(cleanupError.message), retained: true }); }
      const logs = {};
      for (const relative of ['logs/runtime.log', 'postgres.log']) {
        try { logs[relative] = redact((await readFile(path.join(e.root, relative), 'utf8')).slice(-32_000)); } catch { /* Not created yet. */ }
      }
      report.environments[e.name].diagnosticLogs = logs;
    }
    report.cleanup = { mode: 'failure-preserve', temporaryRetained: temporary ?? null,
      reason: 'Diagnostics and all data retained; no deletion of an unverified or live environment' };
    console.error(redact(error.message));
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    report.finishedAt = new Date().toISOString(); report.durationMs = rounded(performance.now() - started);
    await save();
    console.log(JSON.stringify({ status: report.status, evidence: options.out, handoff: report.handoff ?? null,
      diagnostics: report.status === 'failed' ? { temporaryPath: temporary, error: report.error } : null }, null, 2));
  }
  if (report.status !== 'passed') process.exitCode = 1;
}

if (process.argv.includes('--help')) console.log(help);
else {
  try { await main(parse(process.argv.slice(2))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
