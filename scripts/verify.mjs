import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const stages = ['typecheck', 'build', 'check:contracts:browser', 'check:docs', 'test'];

async function verify() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log('Usage: npm run verify [-- --list | --help]\nRuns type checks, builds, browser-contract checks, document-link checks, and tests.\nRaw logs and stage results: .verification/latest.json');
    return;
  }
  if (args.length === 1 && args[0] === '--list') {
    for (const stage of stages) console.log(stage);
    return;
  }
  if (args.length) throw new Error('Usage: npm run verify [-- --list | --help]');
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('Run this command through npm run verify.');
  const cwd = process.cwd();
  const logRoot = resolve(cwd, '.verification');
  mkdirSync(logRoot, { recursive: true });
  const directory = mkdtempSync(join(logRoot, new Date().toISOString().replace(/[:.]/g, '-') + '-'));
  const logFile = join(directory, 'verify.log');
  const summaryFile = join(directory, 'summary.json');
  const summary = {
    status: 'running', startedAt: new Date().toISOString(), finishedAt: null,
    cwd, nodeVersion: process.version, logFile, summaryFile, exitCode: null,
    stages: stages.map(name => ({ name, status: 'pending' })),
  };
  const save = () => {
    const value = JSON.stringify(summary, null, 2) + '\n';
    writeFileSync(summaryFile, value);
    const temporary = join(logRoot, `latest-${process.pid}.tmp`);
    writeFileSync(temporary, value);
    renameSync(temporary, join(logRoot, 'latest.json'));
  };
  const report = message => {
    appendFileSync(logFile, message + '\n');
    console.log(message);
  };
  save();
  report(`[verify] Raw log: ${logFile}`);
  let interrupted;
  let active;
  const stop = signal => {
    interrupted = signal;
    if (!active?.pid) return;
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(active.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    } else {
      try { process.kill(-active.pid, signal); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  };
  const interrupt = () => stop('SIGINT');
  const terminate = () => stop('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    for (const [index, stage] of summary.stages.entries()) {
      if (interrupted) break;
      const started = Date.now();
      const stageLog = join(directory, `${String(index + 1).padStart(2, '0')}-${stage.name.replaceAll(':', '-')}.log`);
      Object.assign(stage, { status: 'running', startedAt: new Date().toISOString(), logFile: stageLog });
      writeFileSync(stageLog, '');
      save();
      report(`[verify ${index + 1}/${stages.length}] START ${stage.name}`);
      let tail = Buffer.alloc(0);
      const capture = data => {
        appendFileSync(stageLog, data);
        appendFileSync(logFile, data);
        tail = Buffer.concat([tail, data]).subarray(-16_384);
      };
      let spawnError;
      const child = spawn(process.execPath, [npmCli, 'run', stage.name], {
        cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32', windowsHide: true,
      });
      active = child;
      child.stdout.on('data', capture);
      child.stderr.on('data', capture);
      const heartbeat = setInterval(() => {
        console.log(`[verify ${index + 1}/${stages.length}] ${stage.name}: running ${((Date.now() - started) / 1000).toFixed(1)}s; ${stageLog}`);
      }, 20_000);
      heartbeat.unref();
      const result = await new Promise(resolveResult => {
        child.once('error', error => { spawnError = error; capture(Buffer.from(error.message + '\n')); });
        child.once('close', (code, signal) => resolveResult({ code, signal }));
      });
      clearInterval(heartbeat);
      active = undefined;
      const exitCode = interrupted === 'SIGINT' ? 130 : interrupted === 'SIGTERM' ? 143
        : spawnError ? 1 : result.code ?? 1;
      Object.assign(stage, {
        status: interrupted ? 'interrupted' : exitCode === 0 ? 'passed' : 'failed',
        finishedAt: new Date().toISOString(), durationMs: Date.now() - started,
        exitCode, signal: result.signal,
      });
      save();
      report(`[verify ${index + 1}/${stages.length}] ${stage.status.toUpperCase()} ${stage.name} (${(stage.durationMs / 1000).toFixed(1)}s, exit ${exitCode})`);
      if (exitCode !== 0) {
        summary.exitCode = exitCode;
        console.error(tail.toString('utf8').trimEnd());
        break;
      }
    }
    summary.exitCode ??= interrupted === 'SIGINT' ? 130 : interrupted === 'SIGTERM' ? 143 : 0;
    summary.status = interrupted ? 'interrupted' : summary.exitCode === 0 ? 'passed' : 'failed';
    summary.finishedAt = new Date().toISOString();
    save();
    report(`[verify] ${summary.status.toUpperCase()}; summary: ${summaryFile}`);
    process.exitCode = summary.exitCode;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}

verify().catch(error => {
  console.error(`[verify] ${error.message}`);
  process.exitCode = 1;
});
