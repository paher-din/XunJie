import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { appContainerIsolation, linuxWatchdogSource, planSeatbelt, supervisorWatchdogSource, unboundedIsolation } from './native-sandbox.js';
import type { NativeSessionIsolation, SeatbeltPlan } from './native-sandbox.js';
import { linuxSessionUnit, stopUnit, unitStopped } from './linux-isolation.js';
import type { LinuxSessionEntry } from './linux-isolation.js';
import { recoverableAccumulatorSource } from './accumulator-recovery.js';
import type { ExecutionPlatform, SessionControlEffect } from '@xunjie/contracts/execution';

const exec = promisify(execFile);
/** Fixed product-level cap on tasks per session; the adapter's declared budgets do not cover forks. */
const linuxTasksMax = 64;
/** A confirmed stop waits for the managed group to be empty, not only for the direct child. */
const groupReapMs = 3000;
const memorySampleMs = 400;

/**
 * A native session is a real supervised child process. The adapter source is fixed product code
 * and receives only bounded parameters over stdin; the supervisor never evaluates component input.
 */
export interface NativeAdapter {
  adapterId: string;
  adapterVersion: number;
  /** Product-supported platforms; absent only for injected test adapters. */
  platforms?: readonly ExecutionPlatform[];
  /** A self-contained ES module, executed with the product's own Node runtime. */
  source: string;
  controls?: readonly SessionControlEffect[];
  checkpointVersion?: number;
}
export interface NativeSessionLimits {
  operationTimeoutMs: number;
  idleMs: number;
  maxMs: number;
  memoryMiB: number;
  outputBytes: number;
}
export interface NativeObservation {
  seq: number;
  controlId: string;
  state: unknown;
  at: string;
  sessionState?: 'running' | 'paused';
  checkpoint?: unknown;
}
export interface NativeSessionExit {
  /** The supervisor asked the process to end, so a non-zero exit is not the student's outcome. */
  requested: boolean;
  expired: 'idle' | 'max' | 'output' | 'memory' | null;
  code: number | null;
  confirmed: boolean;
}
export interface NativeSessionEvents {
  onExit?(exit: NativeSessionExit): void;
}
export interface NativeSessionStart {
  adapter: NativeAdapter;
  limits: NativeSessionLimits;
  instanceId?: string;
  sessionRoot?: string;
  nodePath?: string;
  windowsHelper?: string;
  /** macOS only. `false` keeps the POSIX process-group baseline for probes and non-product hosts. */
  macosSandbox?: boolean;
  /** Directories the sandbox refuses to read besides the fixed protected roots and the home directory. */
  protectRoots?: readonly string[];
  /** Linux only: the fixed root entry that starts the session inside a restricted systemd unit. */
  linuxEntry?: LinuxSessionEntry;
  /** What `probeLinuxIsolation` measured for that entry. A session without it is not started. */
  linuxIsolation?: NativeSessionIsolation;
  events?: NativeSessionEvents;
}

class NativeSessionError extends Error {
  constructor(readonly code: 'resource-unavailable' | 'budget-exceeded' | 'worker-terminated' | 'algorithm-error' | 'termination-unconfirmed',
    message: string) {
    super(message);
    this.name = 'NativeSessionError';
  }
}

interface Reply {
  type?: unknown;
  [key: string]: unknown;
}

const delay = (milliseconds: number) => new Promise<void>(resolve => { setTimeout(resolve, milliseconds) });
const lineLimit = 256 * 1024;
const stderrLimit = 8192;

/** Residency of the whole managed group, in KiB; a session cannot grow past its budget unnoticed. */
async function groupResidentKib(pid: number): Promise<number> {
  const { stdout } = await exec('ps', ['-axo', 'pgid=,rss='], { timeout: 2000, maxBuffer: 4 * 1024 * 1024 });
  let kib = 0;
  for (const line of stdout.split('\n')) {
    const [pgid, rss] = line.trim().split(/\s+/);
    if (Number(pgid) === pid) kib += Number(rss) || 0;
  }
  return kib;
}

/** macOS must run inside the seatbelt profile; a machine without the launcher never falls back. */
function seatbeltFor(nodePath: string, sessionDirectory: string, protectRoots: readonly string[]): SeatbeltPlan | null {
  if (process.platform !== 'darwin') return null;
  return planSeatbelt(nodePath, sessionDirectory, protectRoots);
}

/**
 * One live child process. Every command is serialized by `tail`, so a retried input can never
 * overtake the operation before it and a reply cannot be attributed to a different control.
 */
export class SupervisedSession {
  private readonly child: ChildProcess;
  private readonly sessionDirectory: string;
  private buffer = '';
  private outputBytes = 0;
  private stderrBytes = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private pending: { accept(reply: Reply): boolean; resolve(reply: Reply): void; reject(error: unknown): void;
    timer: ReturnType<typeof setTimeout> } | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private maxTimer: ReturnType<typeof setTimeout> | undefined;
  private helperStopTimer: ReturnType<typeof setTimeout> | undefined;
  private memoryTimer: ReturnType<typeof setInterval> | undefined;
  private memoryBaselineKib = 0;
  private memorySampling = false;
  private readonly exited: Promise<boolean>;
  private readonly settleExit: (value: boolean) => void;
  private exit: NativeSessionExit | null = null;
  private requestedStop = false;
  private expired: 'idle' | 'max' | 'output' | 'memory' | null = null;
  private ready = false;
  private initial: unknown = null;
  private disposed = false;
  /** POSIX sessions are their own process group, so a stop can be confirmed by the group being empty. */
  private readonly managesGroup: boolean;

  private constructor(private readonly start: NativeSessionStart, readonly instanceId: string,
    readonly sessionDirectoryInput: string, child: ChildProcess, private readonly windowsProfile?: string,
    readonly isolation: NativeSessionIsolation = unboundedIsolation,
    private readonly linuxUnit?: { entry: LinuxSessionEntry; unit: string }) {
    this.child = child;
    this.sessionDirectory = sessionDirectoryInput;
    // A unit owns the process tree on Linux; the supervisor cannot signal a group it does not own.
    this.managesGroup = !linuxUnit && process.platform !== 'win32' && !windowsProfile;
    let settle!: (value: boolean) => void;
    this.exited = new Promise<boolean>(resolve => { settle = resolve });
    this.settleExit = settle;
    this.wire(child);
  }

  static async create(options: NativeSessionStart): Promise<SupervisedSession> {
    const platform: ExecutionPlatform | null = process.platform === 'darwin' && process.arch === 'arm64' ? 'macos-arm64'
      : process.platform === 'win32' && process.arch === 'x64' ? 'windows-x64'
      : process.platform === 'linux' && process.arch === 'x64' ? 'linux-x64' : null;
    if (options.adapter.platforms && (!platform || !options.adapter.platforms.includes(platform)))
      throw new NativeSessionError('resource-unavailable', '当前设备不支持该适配器要求的平台能力。');
    const instanceId = options.instanceId ?? randomUUID();
    const linux = options.linuxEntry && process.platform === 'linux' ? options.linuxEntry : null;
    if (linux && !options.linuxIsolation) {
      throw new NativeSessionError('resource-unavailable',
        '本机没有通过自检的受限会话入口，会话没有在强制隔离下启动。');
    }
    const root = linux ? linux.workRoot : options.sessionRoot ?? join(tmpdir(), 'xunjie-native-sessions');
    await mkdir(root, { recursive: true, mode: 0o700 });
    const sessionDirectory = await mkdtemp(join(root, 'session-'));
    const nodePath = options.nodePath ?? process.execPath;
    const helper = options.windowsHelper;
    const profile = helper ? 'XunJie.NativeSession.' + randomUUID() : undefined;
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    const sandbox = helper || options.macosSandbox === false ? null
      : seatbeltFor(nodePath, sessionDirectory, [...(options.protectRoots ?? []), dirname(root)]);
    if (!sandbox && !helper && process.platform === 'darwin' && options.macosSandbox !== false) {
      await rm(sessionDirectory, { recursive: true, force: true }).catch(() => {});
      throw new NativeSessionError('resource-unavailable', '本机缺少可用的沙盒启动器，会话没有在强制隔离下启动。');
    }
    const nodeArgs = [`--max-old-space-size=${options.limits.memoryMiB}`, '--input-type=module', '-e',
      helper ? options.adapter.source : supervisorWatchdogSource + '\n' + options.adapter.source];
    const env = {
      ...(process.platform === 'win32' ? { SystemRoot: systemRoot, windir: systemRoot } : {}),
      TEMP: sessionDirectory, TMP: sessionDirectory, TMPDIR: sessionDirectory,
      XJ_SESSION_INSTANCE: instanceId, NO_COLOR: '1', TZ: 'UTC',
    };
    let child: ChildProcess;
    const unit = linux ? linuxSessionUnit(instanceId) : null;
    try {
      if (linux && unit) {
        // The adapter is a real file so the unit runs exactly one fixed command; the client keeps
        // the line protocol on inherited descriptors through `systemd-run --pipe`.
        await writeFile(join(sessionDirectory, 'adapter.mjs'), linuxWatchdogSource + '\n' + options.adapter.source,
          { mode: 0o600 });
        // The entry reads the runtime budget in milliseconds and turns it into `RuntimeMaxSec`,
        // so the unit outlives the session budget by a small margin and never cuts a legal run.
        child = spawn(linux.sudo, ['-n', linux.entry, 'start', unit, sessionDirectory,
          String(options.limits.memoryMiB), String(linuxTasksMax), String(options.limits.maxMs + 5000),
          nodePath, instanceId], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
          env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' } });
      } else if (helper && profile) {
        const helperEnv = { ...env, USERPROFILE: process.env.USERPROFILE, LOCALAPPDATA: process.env.LOCALAPPDATA };
        const { stdout } = await exec(helper, ['--prepare', profile], { env: helperEnv, windowsHide: true, timeout: 10000 });
        const sid = stdout.trim();
        if (!/^S-1-15-2-(?:\d+-)*\d+$/.test(sid)) throw new Error('Invalid AppContainer identity');
        const executable = join(sessionDirectory, 'node.exe');
        await copyFile(nodePath, executable);
        await exec(join(systemRoot, 'System32', 'icacls.exe'),
          [sessionDirectory, '/grant', `*${sid}:(OI)(CI)M`, '/T'], { windowsHide: true, timeout: 10000 });
        const command = [executable, ...nodeArgs].map(argument => '"' +
          argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"').join(' ');
        child = spawn(helper, [profile, executable, sessionDirectory, command, SupervisedSession.stopEvent(profile)],
          { cwd: sessionDirectory, env: helperEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      } else if (sandbox) {
        const profilePath = join(sessionDirectory, 'session.sb');
        await writeFile(profilePath, sandbox.profileText, { mode: 0o600 });
        // The fourth pipe reports supervisor death to the session; it carries no learning fact.
        child = spawn(sandbox.launcher, ['-f', profilePath, nodePath, ...nodeArgs],
          { cwd: sessionDirectory, env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'], windowsHide: true, detached: true });
      } else {
        child = spawn(nodePath, nodeArgs, { cwd: sessionDirectory, env,
          stdio: process.platform === 'win32' ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe', 'pipe'],
          windowsHide: true, detached: process.platform !== 'win32' });
      }
    } catch (error) {
      if (helper && profile) await exec(helper, ['--release', profile], { windowsHide: true, timeout: 10000 }).catch(() => {});
      await rm(sessionDirectory, { recursive: true, force: true }).catch(() => {});
      if (linux) throw new NativeSessionError('resource-unavailable', 'Linux 受限会话入口未能启动会话，请检查该入口的安装与 sudo 规则。');
      if (helper) throw new NativeSessionError('resource-unavailable', 'Windows 会话隔离准备失败，请检查产品资源与当前用户权限后重试。');
      if (sandbox) throw new NativeSessionError('resource-unavailable', '本机会话无法在沙盒中启动，请检查系统沙盒启动器。');
      throw error;
    }
    const isolation = linux ? options.linuxIsolation! : sandbox?.isolation ?? (helper ? appContainerIsolation : unboundedIsolation);
    const session = new SupervisedSession(options, instanceId, sessionDirectory, child, profile, isolation,
      linux && unit ? { entry: linux, unit } : undefined);
    try {
      await session.waitReady();
      if (child.pid && !linux) await session.primeMemory(child.pid);
      session.startMemoryWatch();
      return session;
    } catch (error) {
      await session.dispose();
      if (linux && !session.exitFact?.confirmed) {
        throw new NativeSessionError('termination-unconfirmed', 'Linux 会话未通过自检，受限单元的回收结果待核实。');
      }
      if (profile && !session.exitFact?.confirmed) {
        throw new NativeSessionError('termination-unconfirmed', 'Windows 会话未通过自检，隔离进程的回收结果待核实。');
      }
      throw error;
    }
  }

  private static stopEvent(profile: string): string { return 'Local\\' + profile; }

  /** The observation the adapter itself reported before any input was admitted. */
  get initialObservation(): unknown { return this.initial }
  get pid(): number | undefined { return this.child.pid }
  get exitFact(): NativeSessionExit | null { return this.exit }

  private wire(child: ChildProcess) {
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.receive(chunk));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      this.stderrBytes += Buffer.byteLength(chunk);
      if (this.stderrBytes > stderrLimit) this.terminate('output');
    });
    child.stdin?.on('error', () => { /* The exit handler is the single outcome. */ });
    child.once('error', error => this.finish(null, error));
    child.once('exit', code => this.finish(code, null));
  }

  private receive(chunk: string) {
    if (this.disposed) return;
    this.outputBytes += Buffer.byteLength(chunk);
    if (this.outputBytes > this.start.limits.outputBytes) { this.terminate('output'); return }
    this.buffer += chunk;
    for (;;) {
      const index = this.buffer.indexOf('\n');
      if (index < 0) break;
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line.length > lineLimit) { this.terminate('output'); return }
      if (!line) continue;
      let reply: Reply;
      try { reply = JSON.parse(line) as Reply; }
      catch { this.terminate('output'); return }
      if (this.ready && reply.type === 'observation' && !this.pending) continue;
      const pending = this.pending;
      if (!pending) continue;
      if (!pending.accept(reply)) continue;
      this.pending = null;
      clearTimeout(pending.timer);
      pending.resolve(reply);
    }
  }

  private finish(code: number | null, error: Error | null) {
    if (this.exit) return;
    this.clearTimers();
    const pending = this.pending;
    this.pending = null;
    if (pending) { clearTimeout(pending.timer); pending.reject(error ?? new NativeSessionError('worker-terminated', '本机会话进程已结束。')) }
    if (this.linuxUnit) {
      // The client exiting is not the unit exiting; only an inactive unit confirms the stop.
      this.exit = { requested: this.requestedStop, expired: this.expired, code, confirmed: false };
      void this.confirmUnit();
      return;
    }
    if (!this.managesGroup) {
      const confirmed = !this.windowsProfile || code === 0 || code === 1;
      this.exit = { requested: this.requestedStop, expired: this.expired, code, confirmed };
      this.settleExit(confirmed);
      if (confirmed) this.releaseSession();
      this.start.events?.onExit?.(this.exit);
      return;
    }
    // The direct child exited, but a stop is only confirmed once the managed group is empty.
    this.exit = { requested: this.requestedStop, expired: this.expired, code, confirmed: false };
    void this.confirmGroup();
  }

  private async confirmUnit() {
    const { entry, unit } = this.linuxUnit!;
    const deadline = Date.now() + groupReapMs;
    let empty = await unitStopped(entry, unit, this.instanceId);
    while (!empty && Date.now() < deadline) {
      await delay(50);
      empty = await unitStopped(entry, unit, this.instanceId);
    }
    if (!this.exit) return;
    this.exit.confirmed = empty;
    this.settleExit(empty);
    if (empty) this.releaseSession();
    this.start.events?.onExit?.(this.exit);
  }

  private async confirmGroup() {
    const pid = this.child.pid;
    let empty = !pid;
    if (pid) {
      try { process.kill(-pid, 'SIGKILL') } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') empty = true;
      }
    }
    const deadline = Date.now() + groupReapMs;
    while (!empty && pid && Date.now() < deadline) {
      await delay(25);
      try { process.kill(-pid, 0) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') empty = true;
      }
    }
    if (!this.exit) return;
    this.exit.confirmed = empty;
    this.settleExit(empty);
    if (empty) this.releaseSession();
    this.start.events?.onExit?.(this.exit);
  }

  private clearTimers() {
    clearTimeout(this.idleTimer); clearTimeout(this.maxTimer); clearTimeout(this.helperStopTimer);
    if (this.memoryTimer) clearInterval(this.memoryTimer);
    this.memoryTimer = undefined;
  }

  private releaseSession() {
    void rm(this.sessionDirectory, { recursive: true, force: true }).catch(() => {});
    if (this.start.windowsHelper && this.windowsProfile) {
      void exec(this.start.windowsHelper, ['--release', this.windowsProfile], { windowsHide: true, timeout: 10000 }).catch(() => {});
    }
  }

  /**
   * The V8 heap cap only bounds JavaScript objects. A working set that grows past the baseline plus
   * the declared budget is stopped here, so off-heap buffers cannot leave the session unbounded.
   */
  private startMemoryWatch() {
    // A cgroup MemoryMax is enforced by the kernel; sampling the unit from outside adds nothing.
    if (this.linuxUnit || this.managesGroup === false || process.platform === 'win32') return;
    const pid = this.child.pid;
    if (!pid) return;
    this.memoryTimer = setInterval(() => { void this.sampleMemory(pid) }, memorySampleMs);
    this.memoryTimer.unref?.();
  }

  private async sampleMemory(pid: number) {
    if (this.exit || this.memorySampling) return;
    this.memorySampling = true;
    try {
      const kib = await groupResidentKib(pid);
      if (kib <= 0) return;
      if (!this.memoryBaselineKib) { this.memoryBaselineKib = kib; return }
      if (kib > this.memoryBaselineKib + this.start.limits.memoryMiB * 1024) this.terminate('memory');
    } catch { /* A failed sample is not evidence that the session exceeded its budget. */ }
    finally { this.memorySampling = false; }
  }

  /** The baseline is taken before the session is handed out, so an early allocation cannot inflate it. */
  private async primeMemory(pid: number) {
    try { this.memoryBaselineKib = await groupResidentKib(pid) } catch { /* The first sample then sets it. */ }
  }

  private terminate(reason: 'idle' | 'max' | 'output' | 'memory') {
    if (this.exit || this.expired) return;
    this.expired = reason;
    this.requestedStop = true;
    this.killTree();
  }

  private killTree() {
    if (this.linuxUnit) {
      // Stopping the unit ends every process in its cgroup, including grandchildren.
      void stopUnit(this.linuxUnit.entry, this.linuxUnit.unit, this.instanceId);
      return;
    }
    const pid = this.child.pid;
    if (!pid || this.child.exitCode !== null) return;
    if (this.start.windowsHelper && this.windowsProfile) {
      if (this.helperStopTimer) return;
      // Losing the launcher still closes its Job handle. Without its explicit
      // empty-Job result, the durable record must remain unconfirmed.
      this.helperStopTimer = setTimeout(() => { this.child.kill(); }, 5000);
      void exec(this.start.windowsHelper, ['--stop', SupervisedSession.stopEvent(this.windowsProfile)],
        { windowsHide: true, timeout: 2000 }).catch(() => { this.child.kill(); });
    } else if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => { try { this.child.kill('SIGKILL') } catch { /* The exit handler records it. */ } });
    } else {
      try { process.kill(-pid, 'SIGKILL') }
      catch { try { this.child.kill('SIGKILL') } catch { /* The exit handler records it. */ } }
    }
  }

  private send<T>(message: unknown, accept: (reply: Reply) => boolean, timeoutMs: number,
    timeoutCode: NativeSessionError['code'], timeoutDetail: string): Promise<T> {
    const run = this.tail.then(() => new Promise<Reply>((resolve, reject) => {
      if (this.exit) {
        reject(new NativeSessionError('worker-terminated', '本机会话进程已结束。'));
        return;
      }
      const timer = setTimeout(() => {
        if (!this.pending) return;
        this.pending = null;
        reject(new NativeSessionError(timeoutCode, timeoutDetail));
        this.killTree();
      }, timeoutMs);
      this.pending = { accept, resolve, reject, timer };
      try { this.child.stdin?.write(JSON.stringify(message) + '\n'); }
      catch {
        clearTimeout(timer);
        this.pending = null;
        reject(new NativeSessionError('worker-terminated', '本机会话进程已结束。'));
      }
    }));
    // A failed command must not poison every later command on the same session.
    this.tail = run.catch(() => {});
    return run as Promise<T>;
  }

  private async waitReady() {
    const reply = await this.send<Reply>({ type: 'ready' }, candidate => candidate.type === 'ready', 10_000,
      'resource-unavailable', '本机会话适配器未在时限内就绪。');
    if (reply.instanceId !== this.instanceId) throw new NativeSessionError('resource-unavailable', '本机会话实例身份不一致。');
    this.ready = true;
    this.initial = reply.observation ?? null;
    this.idleTimer = setTimeout(() => this.terminate('idle'), this.start.limits.idleMs);
    this.maxTimer = setTimeout(() => this.terminate('max'), this.start.limits.maxMs);
  }

  async input(controlId: string, seq: number, parameters: unknown): Promise<NativeObservation> {
    return this.control('input', controlId, seq, parameters);
  }

  async control(effect: SessionControlEffect, controlId: string, seq: number, parameters: unknown): Promise<NativeObservation> {
    const reply = await this.send<Reply>({ type: effect === 'input' ? 'input' : 'control', effect, controlId, seq, parameters },
      candidate => candidate.type === 'observation' && candidate.controlId === controlId
        || candidate.type === 'error',
      this.start.limits.operationTimeoutMs, 'resource-unavailable', '本机会话未在时限内确认这次输入。');
    this.resetIdle();
    if (reply.type === 'error') {
      const code = reply.code === 'identity-conflict' ? 'algorithm-error' : 'algorithm-error';
      throw new NativeSessionError(code, typeof reply.detail === 'string' ? reply.detail : '本机会话拒绝了这次输入。');
    }
    return this.observation(reply);
  }

  private observation(reply: Reply): NativeObservation {
    return { seq: Number(reply.seq), controlId: String(reply.controlId), state: reply.state, at: String(reply.at),
      ...(reply.sessionState === 'running' || reply.sessionState === 'paused' ? { sessionState: reply.sessionState } : {}),
      ...(reply.checkpoint !== undefined ? { checkpoint: reply.checkpoint } : {}) };
  }

  async restore(snapshot: unknown): Promise<{ state: unknown; sessionState: 'running' | 'paused' }> {
    const reply = await this.send<Reply>({ type: 'restore', snapshot }, candidate => candidate.type === 'restored' || candidate.type === 'error',
      this.start.limits.operationTimeoutMs, 'resource-unavailable', '检查点恢复未得到执行器确认。');
    if (reply.type === 'error' || !['running', 'paused'].includes(String(reply.sessionState)))
      throw new NativeSessionError('algorithm-error', '检查点与执行器版本不兼容。');
    this.resetIdle();
    return { state: reply.observation, sessionState: reply.sessionState as 'running' | 'paused' };
  }

  async reconcile(controlId: string): Promise<NativeObservation | null> {
    const reply = await this.send<Reply>({ type: 'reconcile', controlId },
      candidate => candidate.type === 'reconcile' && candidate.controlId === controlId || candidate.type === 'error',
      this.start.limits.operationTimeoutMs, 'resource-unavailable', '本机会话未在时限内核对原输入。');
    if (reply.type === 'error' || reply.applied !== true || !reply.observation)
      return null;
    const value = reply.observation as Reply;
    return this.observation(value);
  }

  async snapshot(): Promise<unknown> {
    const reply = await this.send<Reply>({ type: 'status' }, candidate => candidate.type === 'status',
      this.start.limits.operationTimeoutMs, 'resource-unavailable', '本机会话未在时限内返回状态。');
    return reply.observation ?? null;
  }

  private resetIdle() {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    if (!this.exit) this.idleTimer = setTimeout(() => this.terminate('idle'), this.start.limits.idleMs);
  }

  /** Resolves once the exit fact is final: the direct child is gone and its group is empty. */
  async settled(timeoutMs = groupReapMs + 2000): Promise<NativeSessionExit | null> {
    await Promise.race([this.exited, delay(timeoutMs)]);
    return this.exit;
  }

  /** A confirmed stop is the OS process really exiting, never just the accepted request. */
  async stop(timeoutMs = 3000): Promise<boolean> {
    // An exit that is still confirming its group must not be reported as a stopped session.
    if (this.exit) return Promise.race([this.exited, delay(timeoutMs).then(() => false)]);
    this.requestedStop = true;
    try { this.child.stdin?.write(JSON.stringify({ type: 'stop' }) + '\n') } catch { /* Kill follows. */ }
    const clean = await Promise.race([this.exited, delay(timeoutMs).then(() => false)]);
    if (clean) return true;
    this.killTree();
    return Promise.race([this.exited, delay(2000).then(() => false)]);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (!this.exit) { this.requestedStop = true; this.killTree() }
    await Promise.race([this.exited, delay(groupReapMs + 1000)]);
    if (this.exit?.confirmed) await rm(this.sessionDirectory, { recursive: true, force: true }).catch(() => {});
  }

  /** Last-resort cleanup from a synchronous process-exit hook; no learning fact depends on it. */
  terminateNow(): void {
    if (this.exit) return;
    this.requestedStop = true;
    if (this.windowsProfile) this.child.kill();
    else this.killTree();
  }
}

export type { NativeSessionError };

/**
 * The first shipped adapter: a four-state cyclic accumulator. State genuinely lives in the child
 * process and every observation is a function of the previous one, so 1, 2, 2 yields 1, 3, 1.
 */
export const fourStateAccumulatorSource = [
  "let value = 0, total = 0, applied = 0;",
  "const history = [];",
  "const instanceId = process.env.XJ_SESSION_INSTANCE || '';",
  "const write = value => process.stdout.write(JSON.stringify(value) + '\\n');",
  "const observationOf = item => ({ type: 'observation', seq: item.seq, controlId: item.controlId, state: item.state, at: item.at });",
  "const intake = (controlId, parameters) => {",
  "  const previous = history.find(item => item.controlId === controlId);",
  "  if (previous) return observationOf(previous);",
  "  const amount = parameters && parameters.value;",
  "  if (!Number.isInteger(amount) || amount < 0 || amount > 99) return { type: 'error', code: 'invalid-input', detail: '每次输入必须是 0 到 99 的整数。' };",
  "  value = (value + amount) % 4; total += amount; applied += 1;",
  "  const item = { seq: applied, controlId, state: { value, total, applied }, at: new Date().toISOString() };",
  "  history.push(item); if (history.length > 64) history.shift();",
  "  return observationOf(item);",
  "};",
  "let buffer = '';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', chunk => {",
  "  buffer += chunk;",
  "  for (;;) {",
  "    const index = buffer.indexOf('\\n');",
  "    if (index < 0) break;",
  "    const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);",
  "    if (!line) continue;",
  "    let message;",
  "    try { message = JSON.parse(line); } catch { write({ type: 'error', code: 'invalid-input', detail: '无法读取的会话消息。' }); continue; }",
  "    if (message.type === 'ready') {",
  "      write({ type: 'ready', adapterId: 'four-state-accumulator', adapterVersion: 1, instanceId,",
  "        observation: { value, total, applied } });",
  "    } else if (message.type === 'input') {",
  "      if (message.seq !== applied + 1 && !history.some(item => item.controlId === message.controlId)) {",
  "        write({ type: 'error', code: 'identity-conflict', detail: '输入顺序与当前已应用位置不一致。' });",
  "      } else { write(intake(message.controlId, message.parameters)); }",
  "    } else if (message.type === 'reconcile') {",
  "      const known = history.find(item => item.controlId === message.controlId);",
  "      write(known ? { type: 'reconcile', applied: true, controlId: message.controlId, observation: known }",
  "        : { type: 'reconcile', applied: false, controlId: message.controlId });",
  "    } else if (message.type === 'status') {",
  "      write({ type: 'status', observation: { value, total, applied } });",
  "    } else if (message.type === 'stop') {",
  "      write({ type: 'stopped' }); process.exit(0);",
  "    } else { write({ type: 'error', code: 'invalid-input', detail: '未知的会话消息。' }); }",
  "  }",
  "});",
  "process.stdin.on('end', () => process.exit(0));",
].join('\n');

/** A Linux process experiment observes real procfs data on every confirmed transition. */
const linuxProcPrelude = [
  "import { readFileSync as readProc } from 'node:fs';",
  "if (process.platform !== 'linux') throw new Error('This experiment requires Linux procfs.');",
  "const procState = () => { const text = readProc('/proc/self/status', 'utf8');",
  "  return { pid: Number(text.match(/^Pid:\\s+(\\d+)/m)?.[1]), threads: Number(text.match(/^Threads:\\s+(\\d+)/m)?.[1]) }; };",
].join('\n');
const linuxProcAccumulatorSource = [
  linuxProcPrelude,
  fourStateAccumulatorSource.replaceAll("adapterId: 'four-state-accumulator'", "adapterId: 'linux-proc-accumulator'")
    .replaceAll('{ value, total, applied }', '{ value, total, applied, ...procState() }'),
].join('\n');

/** Only observations include live procfs identity. Checkpoints restore simulation state into a new process. */
const recoverableLinuxProcAccumulatorSource = linuxProcPrelude + '\n' + recoverableAccumulatorSource
  .replace('const state = () => ({ value, total, applied });',
    'const state = () => ({ value, total, applied, ...procState() });');

export const productNativeAdapters: readonly NativeAdapter[] = Object.freeze([
  Object.freeze({ adapterId: 'four-state-accumulator', adapterVersion: 1, source: fourStateAccumulatorSource,
    platforms: Object.freeze(['linux-x64', 'macos-arm64', 'windows-x64'] as const) }),
  Object.freeze({ adapterId: 'linux-proc-accumulator', adapterVersion: 1, source: linuxProcAccumulatorSource,
    platforms: Object.freeze(['linux-x64'] as const) }),
  Object.freeze({ adapterId: 'four-state-accumulator', adapterVersion: 2, source: recoverableAccumulatorSource,
    platforms: Object.freeze(['linux-x64', 'macos-arm64', 'windows-x64'] as const),
    controls: ['pause', 'resume', 'step', 'reset', 'checkpoint'] as const, checkpointVersion: 1 }),
  Object.freeze({ adapterId: 'linux-proc-accumulator', adapterVersion: 2, source: recoverableLinuxProcAccumulatorSource,
    platforms: Object.freeze(['linux-x64'] as const),
    controls: ['pause', 'resume', 'step', 'reset', 'checkpoint'] as const, checkpointVersion: 1 }),
]);
