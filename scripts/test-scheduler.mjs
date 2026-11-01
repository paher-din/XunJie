import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const iso = () => new Date().toISOString();
const signalCode = signal => signal === 'SIGINT' ? 130 : 143;

// A process group covers ordinary descendants. Remember descendants as well,
// including detached helpers, before their parent exits and they are reparented.
function supervisor() {
  const roots = new Set(), descendants = new Map();
  let interrupted;
  let stopping;
  function discover() {
    if (process.platform === 'win32' || (!roots.size && !descendants.size)) return;
    try {
      const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,lstart='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .trim().split('\n').map(row => {
          const [pid, ppid, ...start] = row.trim().split(/\s+/);
          return [Number(pid), Number(ppid), start.join(' ')];
        });
      const identities = new Map(rows.map(([pid, , start]) => [pid, start]));
      for (const [pid, start] of descendants) if (identities.get(pid) !== start) descendants.delete(pid);
      const parents = new Set([...roots, ...descendants.keys()]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const [pid, ppid, start] of rows) {
          if (pid !== process.pid && parents.has(ppid) && !parents.has(pid)) {
            parents.add(pid); descendants.set(pid, start); changed = true;
          }
        }
      }
    } catch { /* Process-group termination still works if ps is unavailable. */ }
  }
  function kill(signal) {
    for (const pid of roots) {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
      } else {
        try { process.kill(-pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    }
    for (const pid of descendants.keys()) {
      try { process.kill(pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
  function stop(signal) {
    if (interrupted) return;
    interrupted = signal;
    discover();
    kill(signal);
    // Do not cancel escalation when the direct child closes: detached helpers
    // may have ignored SIGTERM and closed their inherited streams already.
    stopping = delay(750).then(() => { discover(); kill('SIGKILL'); });
  }
  const interrupt = () => stop('SIGINT'), terminate = () => stop('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  const poll = setInterval(discover, 500);
  poll.unref();
  return {
    add(child) {
      if (!child.pid) return;
      roots.add(child.pid);
      const remove = () => { discover(); roots.delete(child.pid); };
      child.once('exit', remove);
      child.once('close', remove);
    },
    get signal() { return interrupted; },
    async close() {
      if (stopping) await stopping;
      clearInterval(poll);
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
    },
  };
}

/** One task occupies one global worker. Nested runners must also use one worker. */
export async function runVerification({ root, options, phases }) {
  const jobs = options.jobs ?? 4;
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 4) throw new Error('jobs must be an integer from 1 to 4');
  const started = Date.now();
  const logRoot = join(root, '.verification');
  mkdirSync(logRoot, { recursive: true });
  const directory = mkdtempSync(join(logRoot, iso().replace(/[:.]/g, '-') + '-'));
  const logFile = join(directory, 'verify.log'), summaryFile = join(directory, 'summary.json');
  writeFileSync(logFile, '');
  const stages = [...new Set(phases.flat().map(task => task.group))].map((name, index) => ({
    name, status: 'pending', logFile: join(directory, `${String(index + 1).padStart(2, '0')}-${name.replaceAll(':', '-')}.log`),
    tasks: [],
  }));
  for (const stage of stages) writeFileSync(stage.logFile, '');
  const summary = { status: 'running', startedAt: iso(), finishedAt: null, cwd: root,
    nodeVersion: process.version, logFile, summaryFile, exitCode: null,
    group: options.group ?? options.target ?? 'full', shard: options.shard ?? null, jobs,
    testsCached: false, stages };
  const byGroup = new Map(stages.map(stage => [stage.name, stage]));
  const records = new Map();
  for (const task of phases.flat()) {
    const stage = byGroup.get(task.group);
    const record = { name: task.name, status: 'pending', command: task.command, args: task.args,
      cwd: task.cwd, exclusive: Boolean(task.exclusive) };
    stage.tasks.push(record); records.set(task, record);
  }
  const save = () => {
    const value = JSON.stringify(summary, null, 2) + '\n';
    writeFileSync(summaryFile, value);
    const temporary = join(logRoot, `latest-${process.pid}.tmp`);
    writeFileSync(temporary, value);
    renameSync(temporary, join(logRoot, 'latest.json'));
  };
  const report = message => { appendFileSync(logFile, message + '\n'); console.log(message); };
  save();
  report(`[verify] Raw log: ${logFile}; tests are never cached; jobs=${jobs}`);
  const processes = supervisor();
  let exitCode = 0;
  const heartbeat = setInterval(() => {
    for (const stage of stages.filter(stage => stage.status === 'running')) {
      console.log(`[verify] ${stage.name}: ${stage.tasks.filter(task => task.status === 'passed').length}/${stage.tasks.length} passed; ${stage.logFile}`);
    }
  }, 20_000);
  heartbeat.unref();
  async function run(task) {
    const stage = byGroup.get(task.group), record = records.get(task), start = Date.now();
    if (stage.status === 'pending') {
      Object.assign(stage, { status: 'running', startedAt: iso() });
      report(`[verify] START ${stage.name}`);
    }
    Object.assign(record, { status: 'running', startedAt: iso() });
    save();
    let tail = Buffer.alloc(0);
    const capture = data => {
      appendFileSync(stage.logFile, data);
      appendFileSync(logFile, data);
      tail = Buffer.concat([tail, data]).subarray(-16_384);
    };
    capture(Buffer.from(`\n[task] START ${task.name}\n`));
    let spawnError;
    const env = { ...process.env };
    // A verification regression can invoke this scheduler from node:test.
    // Its private marker would make a nested `node --test` silently skip files.
    delete env.NODE_TEST_CONTEXT;
    const result = await new Promise(resolveResult => {
      let child;
      try {
        child = spawn(task.command, task.args, { cwd: task.cwd, env,
          stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
        processes.add(child);
      } catch (error) {
        spawnError = error; capture(Buffer.from(error.message + '\n')); resolveResult({ code: 1, signal: null }); return;
      }
      child.stdout.on('data', capture);
      child.stderr.on('data', capture);
      child.once('error', error => { spawnError = error; capture(Buffer.from(error.message + '\n')); });
      child.once('close', (code, signal) => resolveResult({ code, signal }));
    });
    const code = processes.signal ? signalCode(processes.signal) : spawnError ? 1 : result.code ?? 1;
    Object.assign(record, { status: processes.signal ? 'interrupted' : code === 0 ? 'passed' : 'failed',
      finishedAt: iso(), durationMs: Date.now() - start, exitCode: code, signal: result.signal });
    capture(Buffer.from(`[task] ${record.status.toUpperCase()} ${task.name} (${record.durationMs}ms, exit ${code})\n`));
    if (code && !exitCode) exitCode = code;
    if (code) console.error(tail.toString('utf8').trimEnd());
    if (stage.tasks.every(record => !['running', 'pending'].includes(record.status))) {
      stage.exitCode = stage.tasks.find(record => record.exitCode)?.exitCode ?? 0;
      stage.status = processes.signal ? 'interrupted' : stage.exitCode === 0 ? 'passed' : 'failed';
      stage.finishedAt = iso(); stage.durationMs = Date.now() - Date.parse(stage.startedAt);
      report(`[verify] ${stage.status.toUpperCase()} ${stage.name} (${(stage.durationMs / 1000).toFixed(1)}s, exit ${stage.exitCode})`);
    }
    save();
    return code;
  }
  try {
    for (const phase of phases) {
      const pending = [...phase], active = new Set();
      let phaseFailure = false;
      const launch = task => {
        const promise = run(task).then(code => { if (code) phaseFailure = true; }).finally(() => active.delete(promise));
        active.add(promise);
      };
      while ((pending.length || active.size) && !processes.signal) {
        // An exclusive task is a barrier, including tasks queued after it.
        while (pending.length && active.size < jobs && !processes.signal) {
          if (pending[0].exclusive) {
            if (active.size) break;
            const code = await run(pending.shift());
            if (code) phaseFailure = true;
            if (code && phase[0]?.group === 'prepare') pending.length = 0;
          } else launch(pending.shift());
        }
        if (active.size) await Promise.race(active);
      }
      await Promise.all(active);
      // A failed prerequisite prevents unprepared tests. Test failures still run
      // every remaining test file/group so assertions are not silently dropped.
      if (processes.signal || (phaseFailure && ['prepare', 'build:test'].includes(phase[0]?.group))) break;
    }
  } catch (error) {
    exitCode ||= 1;
    report(`[verify] ${error.stack ?? error.message}`);
  } finally {
    await processes.close();
    clearInterval(heartbeat);
    for (const stage of stages.filter(stage => stage.status === 'running')) {
      stage.status = processes.signal ? 'interrupted' : 'failed';
      stage.exitCode = processes.signal ? signalCode(processes.signal) : exitCode || 1;
      stage.finishedAt = iso(); stage.durationMs = Date.now() - Date.parse(stage.startedAt);
    }
    summary.exitCode = processes.signal ? signalCode(processes.signal) : exitCode;
    summary.status = processes.signal ? 'interrupted' : summary.exitCode === 0 ? 'passed' : 'failed';
    summary.finishedAt = iso(); summary.durationMs = Date.now() - started;
    save();
    report(`[verify] ${summary.status.toUpperCase()}; summary: ${summaryFile}`);
  }
  return summary.exitCode;
}
