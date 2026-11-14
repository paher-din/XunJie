import { DirectRunner, DispatchClosedError } from './direct-runner.ts';
import type { AdvanceResult, ExecutionStrategy } from './direct-runner.ts';
import { systemTimers } from './async-waits.ts';
import type { TimerScheduler } from './async-waits.ts';

/** expiresAt uses milliseconds on the injected now clock (Date.now by default). */
export interface RunLease { expiresAt: number; }
export interface LeaseContext<Lease extends RunLease> {
  readonly lease: Lease;
  readonly signal: AbortSignal;
  /** Call before external dispatch; advance must also honor signal while awaiting work. */
  assertCurrent(): void;
}

export interface RunCoordinatorOptions<Lease extends RunLease> {
  /** Host callbacks own atomic claim/fencing; null means another owner holds this run. */
  claim(runId: string, signal: AbortSignal): Lease | null | Promise<Lease | null>;
  /** Renews the same claim epoch; return a receipt with its new expiration or null on loss. */
  renew(runId: string, lease: Lease, signal: AbortSignal): Lease | null | Promise<Lease | null>;
  advance(runId: string, context: LeaseContext<Lease>): void | Promise<void>;
  release?(runId: string, lease: Lease): void | Promise<void>;
  renewIntervalMs: number;
  markPending?(runId: string): void | Promise<void>;
  hasPending?(runId: string): boolean | Promise<boolean>;
  now?: () => number;
  timers?: TimerScheduler;
  /** Supplies only runs the host intends to resume; never called by construction. */
  scan?(signal: AbortSignal): Iterable<string> | Promise<Iterable<string>>;
}

export class LeaseLostError extends Error {
  constructor(message = 'Run lease is no longer current', options?: ErrorOptions) {
    super(message, options);
    this.name = 'LeaseLostError';
  }
}

interface HeldLease<Lease extends RunLease> {
  controller: AbortController;
  lease: Lease | null;
  deadline?: unknown;
  heartbeat?: unknown;
  renewal?: Promise<void>;
  renewing: boolean;
  epoch: number;
  finished: boolean;
}

interface ScanLoop { timer?: unknown; stopped: boolean; generation: number; }

/** Optional policy for competing hosts. Holds a lease for each advance and releases it
 * before the next turn. The host must pass cancellation/fencing to actual dispatch.
 */
export class RunCoordinator<Lease extends RunLease = RunLease> implements ExecutionStrategy {
  private readonly runner: DirectRunner;
  private readonly options: RunCoordinatorOptions<Lease>;
  private readonly timers: TimerScheduler;
  private readonly now: () => number;
  private readonly held = new Map<string, HeldLease<Lease>>();
  private scanning: { task: Promise<void>; controller: AbortController } | undefined;
  private scanLoop: ScanLoop | undefined;
  private readonly scanFailures: unknown[] = [];
  private closed = false;
  constructor(options: RunCoordinatorOptions<Lease>) {
    if (!Number.isFinite(options.renewIntervalMs) || options.renewIntervalMs < 1) {
      throw new RangeError('renewIntervalMs must be finite and positive');
    }
    this.options = options;
    this.timers = options.timers ?? systemTimers;
    this.now = options.now ?? Date.now;
    this.runner = new DirectRunner({
      advance: (runId) => this.advance(runId),
      ...(options.markPending ? { markPending: options.markPending } : {}),
    });
  }

  private async advance(runId: string): Promise<void | AdvanceResult> {
    const held: HeldLease<Lease> = {
      controller: new AbortController(), lease: null, renewing: false, epoch: 0, finished: false,
    };
    this.held.set(runId, held);
    const signal = held.controller.signal;
    try {
      held.lease = await this.options.claim(runId, signal);
      if (!held.lease || this.closed) return;
      this.assertCurrent(held);
      this.arm(runId, held);
      const context: LeaseContext<Lease> = {
        get lease() { return held.lease!; },
        signal,
        assertCurrent: () => this.assertCurrent(held),
      };
      await this.options.advance(runId, context);
      this.assertCurrent(held);
      const pending = await this.options.hasPending?.(runId);
      this.assertCurrent(held);
      return { pending: !!pending };
    } catch (error) {
      if (signal.reason instanceof DispatchClosedError
        && (error === signal.reason || (error instanceof Error && error.name === 'AbortError'))) return;
      throw error;
    } finally {
      held.finished = true;
      this.clearTimers(held);
      if (!signal.aborted) held.controller.abort(new LeaseLostError('Run advance finished'));
      try {
        await held.renewal;
        if (held.lease) await this.options.release?.(runId, held.lease);
      } finally { this.held.delete(runId); }
    }
  }

  private assertCurrent(held: HeldLease<Lease>): void {
    if (this.closed && !held.controller.signal.aborted) held.controller.abort(new DispatchClosedError());
    if (held.finished || !held.lease || !Number.isFinite(held.lease.expiresAt) || this.now() >= held.lease.expiresAt) {
      this.lose(held, new LeaseLostError());
    }
    held.controller.signal.throwIfAborted();
  }

  private lose(held: HeldLease<Lease>, reason: LeaseLostError): void {
    this.clearTimers(held);
    if (!held.controller.signal.aborted) held.controller.abort(reason);
  }

  private clearTimers(held: HeldLease<Lease>): void {
    if (held.deadline !== undefined) this.timers.clearTimeout(held.deadline);
    if (held.heartbeat !== undefined) this.timers.clearTimeout(held.heartbeat);
    held.deadline = undefined;
    held.heartbeat = undefined;
  }

  private arm(runId: string, held: HeldLease<Lease>): void {
    this.clearTimers(held);
    const epoch = ++held.epoch;
    const current = () => !held.finished && !held.controller.signal.aborted && held.epoch === epoch;
    const remaining = () => held.lease!.expiresAt - this.now();
    const deadline = () => {
      if (!current()) return;
      if (remaining() <= 0) { this.lose(held, new LeaseLostError('Run lease expired')); return; }
      held.deadline = this.timers.setTimeout(deadline, Math.max(1, Math.min(2_147_483_647, remaining())));
    };
    deadline();
    held.heartbeat = this.timers.setTimeout(() => {
      if (!current() || held.renewing) return;
      this.timers.clearTimeout(held.heartbeat);
      held.heartbeat = undefined;
      held.renewing = true;
      held.renewal = this.renew(runId, held).finally(() => { held.renewing = false; });
    }, Math.max(1, Math.min(2_147_483_647, this.options.renewIntervalMs, remaining() / 2)));
  }

  private async renew(runId: string, held: HeldLease<Lease>): Promise<void> {
    try {
      this.assertCurrent(held);
      const previous = held.lease!;
      const lease = await this.options.renew(runId, previous, held.controller.signal);
      const expired = this.now() >= previous.expiresAt;
      // Keep the latest receipt for release, but never revive an aborted execution.
      if (lease) held.lease = lease;
      if (held.finished || held.controller.signal.aborted) return;
      if (expired) { this.lose(held, new LeaseLostError('Run lease expired during renewal')); return; }
      if (!lease) { this.lose(held, new LeaseLostError('Run lease renewal was denied')); return; }
      this.assertCurrent(held);
      this.arm(runId, held);
    } catch (error) {
      this.lose(held, new LeaseLostError('Run lease renewal failed', { cause: error }));
    }
  }

  wake(runId: string): Promise<void> { return this.runner.wake(runId); }

  /** Coalesces source scans, schedules discovered runs, and leaves execution waiting to drain. */
  scanOnce(): Promise<void> {
    if (this.closed) return Promise.reject(new DispatchClosedError());
    if (!this.options.scan) return Promise.reject(new Error('No run scan callback was configured'));
    if (this.scanning) return this.scanning.task;
    const scan = { task: Promise.resolve(), controller: new AbortController() };
    this.scanning = scan;
    scan.task = Promise.resolve().then(async () => {
      if (this.closed) return;
      let runs: string[];
      try {
        runs = [...new Set(await this.options.scan!(scan.controller.signal))];
      } catch (error) {
        if (this.closed && (error === scan.controller.signal.reason || (error instanceof Error && error.name === 'AbortError'))) return;
        this.scanFailures.push(error);
        throw error;
      }
      if (this.closed) return;
      // DirectRunner retains these failures for drain; scanning does not wait for long advances.
      for (const runId of runs) void this.wake(runId).catch(() => {});
    }).finally(() => { if (this.scanning === scan) this.scanning = undefined; });
    void scan.task.catch(() => {});
    return scan.task;
  }

  /** Explicit opt-in. Waits one interval before scanning, then schedules after completion. */
  startScanning(intervalMs: number): () => void {
    if (this.closed) throw new DispatchClosedError();
    if (!this.options.scan) throw new Error('No run scan callback was configured');
    if (!Number.isFinite(intervalMs) || intervalMs < 1 || intervalMs > 2_147_483_647) {
      throw new RangeError('Scan interval must be between 1 and 2147483647ms');
    }
    if (this.scanLoop) this.stopLoop(this.scanLoop);
    const loop: ScanLoop = { stopped: false, generation: 0 };
    this.scanLoop = loop;
    const schedule = () => {
      if (this.closed || loop.stopped || this.scanLoop !== loop) return;
      const generation = ++loop.generation;
      loop.timer = this.timers.setTimeout(() => {
        if (this.closed || loop.stopped || this.scanLoop !== loop || loop.generation !== generation) return;
        loop.generation += 1;
        this.timers.clearTimeout(loop.timer);
        loop.timer = undefined;
        void this.scanOnce().catch(() => {}).finally(schedule);
      }, intervalMs);
    };
    schedule();
    return () => this.stopLoop(loop);
  }

  private stopLoop(loop: ScanLoop): void {
    loop.stopped = true;
    if (loop.timer !== undefined) this.timers.clearTimeout(loop.timer);
    if (this.scanLoop === loop) this.scanLoop = undefined;
  }

  closeDispatch(): void {
    this.closed = true;
    this.runner.closeDispatch();
    if (this.scanLoop) this.stopLoop(this.scanLoop);
    this.scanning?.controller.abort(new DispatchClosedError());
    for (const held of this.held.values()) {
      this.clearTimers(held);
      if (!held.controller.signal.aborted) held.controller.abort(new DispatchClosedError());
    }
  }
  async drain(): Promise<void> {
    const failures: unknown[] = [];
    do {
      await this.scanning?.task.catch(() => {});
      try { await this.runner.drain(); }
      catch (error) { failures.push(...(error instanceof AggregateError ? error.errors : [error])); }
    } while (this.scanning);
    failures.push(...this.scanFailures.splice(0));
    if (failures.length) throw new AggregateError(failures, 'Run coordination failed');
  }
}
