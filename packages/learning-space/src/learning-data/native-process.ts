import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * A native session is a real supervised child process. The adapter source is fixed product code
 * and receives only bounded parameters over stdin; the supervisor never evaluates component input.
 */
export interface NativeAdapter {
  adapterId: string;
  adapterVersion: number;
  /** A self-contained ES module, executed with the product's own Node runtime. */
  source: string;
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
}
export interface NativeSessionExit {
  /** The supervisor asked the process to end, so a non-zero exit is not the student's outcome. */
  requested: boolean;
  expired: 'idle' | 'max' | 'output' | null;
  code: number | null;
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
  events?: NativeSessionEvents;
}

class NativeSessionError extends Error {
  constructor(readonly code: 'resource-unavailable' | 'budget-exceeded' | 'worker-terminated' | 'algorithm-error',
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
  private readonly exited: Promise<boolean>;
  private readonly settleExit: (value: boolean) => void;
  private exit: NativeSessionExit | null = null;
  private requestedStop = false;
  private expired: 'idle' | 'max' | 'output' | null = null;
  private ready = false;
  private initial: unknown = null;
  private disposed = false;

  private constructor(private readonly start: NativeSessionStart, readonly instanceId: string,
    readonly sessionDirectoryInput: string, child: ChildProcess) {
    this.child = child;
    this.sessionDirectory = sessionDirectoryInput;
    let settle!: (value: boolean) => void;
    this.exited = new Promise<boolean>(resolve => { settle = resolve });
    this.settleExit = settle;
    this.wire(child);
  }

  static async create(options: NativeSessionStart): Promise<SupervisedSession> {
    const instanceId = options.instanceId ?? randomUUID();
    const root = options.sessionRoot ?? join(tmpdir(), 'xunjie-native-sessions');
    await mkdir(root, { recursive: true, mode: 0o700 });
    const sessionDirectory = await mkdtemp(join(root, 'session-'));
    const nodePath = options.nodePath ?? process.execPath;
    const child = spawn(nodePath, [`--max-old-space-size=${options.limits.memoryMiB}`, '--input-type=module',
      '-e', options.adapter.source], {
      cwd: sessionDirectory,
      // No inherited service credentials, database password or development loader flags.
      env: {
        ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
          windir: process.env.windir ?? process.env.SystemRoot ?? 'C:\\Windows' } : {}),
        TEMP: sessionDirectory, TMP: sessionDirectory, TMPDIR: sessionDirectory,
        XJ_SESSION_INSTANCE: instanceId, NO_COLOR: '1', TZ: 'UTC',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    const session = new SupervisedSession(options, instanceId, sessionDirectory, child);
    try {
      await session.waitReady();
      return session;
    } catch (error) {
      await session.dispose();
      throw error;
    }
  }

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
    this.exit = { requested: this.requestedStop, expired: this.expired, code };
    clearTimeout(this.idleTimer); clearTimeout(this.maxTimer);
    const pending = this.pending;
    this.pending = null;
    if (pending) { clearTimeout(pending.timer); pending.reject(error ?? new NativeSessionError('worker-terminated', '本机会话进程已结束。')) }
    this.settleExit(true);
    void rm(this.sessionDirectory, { recursive: true, force: true }).catch(() => {});
    this.start.events?.onExit?.(this.exit);
  }

  private terminate(reason: 'idle' | 'max' | 'output') {
    if (this.exit || this.expired) return;
    this.expired = reason;
    this.requestedStop = true;
    this.killTree();
  }

  private killTree() {
    const pid = this.child.pid;
    if (!pid || this.child.exitCode !== null) return;
    if (process.platform === 'win32') {
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
    const reply = await this.send<Reply>({ type: 'input', controlId, seq, parameters },
      candidate => candidate.type === 'observation' && candidate.controlId === controlId
        || candidate.type === 'error',
      this.start.limits.operationTimeoutMs, 'resource-unavailable', '本机会话未在时限内确认这次输入。');
    this.resetIdle();
    if (reply.type === 'error') {
      const code = reply.code === 'identity-conflict' ? 'algorithm-error' : 'algorithm-error';
      throw new NativeSessionError(code, typeof reply.detail === 'string' ? reply.detail : '本机会话拒绝了这次输入。');
    }
    return { seq: Number(reply.seq), controlId: String(reply.controlId), state: reply.state, at: String(reply.at) };
  }

  async reconcile(controlId: string): Promise<NativeObservation | null> {
    const reply = await this.send<Reply>({ type: 'reconcile', controlId },
      candidate => candidate.type === 'reconcile' && candidate.controlId === controlId || candidate.type === 'error',
      this.start.limits.operationTimeoutMs, 'resource-unavailable', '本机会话未在时限内核对原输入。');
    if (reply.type === 'error' || reply.applied !== true || !reply.observation)
      return null;
    const value = reply.observation as Reply;
    return { seq: Number(value.seq), controlId: String(value.controlId), state: value.state, at: String(value.at) };
  }

  async snapshot(): Promise<unknown> {
    const reply = await this.send<Reply>({ type: 'status' }, candidate => candidate.type === 'status',
      this.start.limits.operationTimeoutMs, 'resource-unavailable', '本机会话未在时限内返回状态。');
    this.resetIdle();
    return reply.observation ?? null;
  }

  private resetIdle() {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    if (!this.exit) this.idleTimer = setTimeout(() => this.terminate('idle'), this.start.limits.idleMs);
  }

  /** A confirmed stop is the OS process really exiting, never just the accepted request. */
  async stop(timeoutMs = 3000): Promise<boolean> {
    if (this.exit) return true;
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
    await Promise.race([this.exited, delay(2000)]);
    await rm(this.sessionDirectory, { recursive: true, force: true }).catch(() => {});
  }

  /** Last-resort cleanup from a synchronous process-exit hook; no learning fact depends on it. */
  terminateNow(): void {
    if (this.exit) return;
    this.requestedStop = true;
    this.killTree();
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

export const productNativeAdapters: readonly NativeAdapter[] = Object.freeze([
  Object.freeze({ adapterId: 'four-state-accumulator', adapterVersion: 1, source: fourStateAccumulatorSource }),
]);
