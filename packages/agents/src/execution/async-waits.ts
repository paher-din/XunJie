export interface AsyncWait {
  /** Globally identifies the original attempt/command, including its generation. */
  waitId: string;
  runId: string;
  delayMs: number;
}

export interface AsyncWaitsOptions {
  wake(runId: string, waitId: string): void | Promise<void>;
  minDelayMs?: number;
  maxDelayMs?: number;
  timers?: TimerScheduler;
}

export interface TimerScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Creating this adapter has no side effects. */
export const systemTimers: TimerScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface Registration {
  wait: AsyncWait;
  timer?: unknown;
  queued: boolean;
}

/** Only explicit registrations get timers; delays are clamped to the configured bounds.
 * Each registration fires at most once. Further retries require explicit registration.
 */
export class AsyncWaits {
  private readonly options: AsyncWaitsOptions;
  private readonly timers: TimerScheduler;
  private readonly registrations = new Map<string, Registration>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly failures: unknown[] = [];
  private readonly minDelayMs: number;
  private readonly maxDelayMs: number;
  private stopped = false;
  constructor(options: AsyncWaitsOptions) {
    this.options = options;
    this.timers = options.timers ?? systemTimers;
    this.minDelayMs = options.minDelayMs ?? 1;
    this.maxDelayMs = options.maxDelayMs ?? 60_000;
    if (!Number.isFinite(this.minDelayMs) || !Number.isFinite(this.maxDelayMs)
      || this.minDelayMs < 1 || this.maxDelayMs > 2_147_483_647 || this.minDelayMs > this.maxDelayMs) {
      throw new RangeError('Wait timer bounds must satisfy 1 <= minDelayMs <= maxDelayMs <= 2147483647');
    }
  }
  register(wait: AsyncWait): () => void {
    if (this.stopped) throw new Error('Async waits are stopped');
    if (!Number.isFinite(wait.delayMs) || wait.delayMs < 0) throw new RangeError('delayMs must be finite and nonnegative');
    const previous = this.registrations.get(wait.waitId);
    if (previous) this.cancel(previous);
    const delay = Math.min(this.maxDelayMs, Math.max(this.minDelayMs, wait.delayMs));
    const entry: Registration = { wait: { ...wait }, queued: false };
    this.registrations.set(wait.waitId, entry);
    entry.timer = this.timers.setTimeout(() => { this.enqueue(entry); }, delay);
    return () => this.cancel(entry);
  }

  /** Notify only an explicitly registered attempt/command; unknown or stale IDs do nothing. */
  notify(waitId: string): boolean {
    const entry = this.registrations.get(waitId);
    return entry ? this.enqueue(entry) : false;
  }

  private enqueue(entry: Registration): boolean {
    if (this.stopped || entry.queued || this.registrations.get(entry.wait.waitId) !== entry) return false;
    entry.queued = true;
    this.timers.clearTimeout(entry.timer);
    const task = Promise.resolve().then(async () => {
      if (this.stopped || this.registrations.get(entry.wait.waitId) !== entry) return;
      this.cancel(entry);
      await this.options.wake(entry.wait.runId, entry.wait.waitId);
    }).catch((error: unknown) => { this.failures.push(error); }).finally(() => { this.inFlight.delete(task); });
    this.inFlight.add(task);
    return true;
  }
  private cancel(entry: Registration): void {
    this.timers.clearTimeout(entry.timer);
    if (this.registrations.get(entry.wait.waitId) === entry) this.registrations.delete(entry.wait.waitId);
  }
  stop(): void {
    this.stopped = true;
    for (const entry of this.registrations.values()) this.cancel(entry);
  }

  /** Waits for callbacks already dispatched; scheduled waits are not dispatched by draining. */
  async drain(): Promise<void> {
    while (this.inFlight.size) await Promise.all([...this.inFlight]);
    if (this.failures.length) throw new AggregateError(this.failures.splice(0), 'Asynchronous wait wake failed');
  }
}
