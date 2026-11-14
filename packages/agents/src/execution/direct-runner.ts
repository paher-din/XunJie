/** Public boundary shared by exclusive-host and lease-coordinated runners. */
export interface ExecutionStrategy {
  /** Resolves when this run becomes idle (coalesced wakes share the same task). */
  wake(runId: string): Promise<void>;
  /** Permanently prevents new advances; an already entered advance may finish. */
  closeDispatch(): void;
  /** Waits for accepted work, then reports and consumes accumulated failures as AggregateError. */
  drain(): Promise<void>;
}

export class DispatchClosedError extends Error {
  constructor() { super('Execution dispatch is closed'); this.name = 'DispatchClosedError'; }
}

export interface AdvanceResult {
  /** Runnable work remains; a user wait alone must not set this flag. */
  pending?: boolean;
}

export interface DirectRunnerOptions {
  advance(runId: string): void | AdvanceResult | Promise<void | AdvanceResult>;
  /** Persist a wake before advancing. advance owns consuming durable pending work. */
  markPending?(runId: string): void | Promise<void>;
  /** Rechecked at exit for runnable durable work, not a wait-user state. */
  hasPending?(runId: string): boolean | Promise<boolean>;
}

interface ActiveRun {
  dirty: boolean;
  task: Promise<void>;
  writes: Promise<void>;
}

/** Exclusive-host policy: no startup scan, timers, or implicit recovery after a failed turn. */
export class DirectRunner implements ExecutionStrategy {
  private readonly options: DirectRunnerOptions;
  private readonly active = new Map<string, ActiveRun>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly failures: unknown[] = [];
  private closed = false;
  constructor(options: DirectRunnerOptions) { this.options = options; }
  wake(runId: string): Promise<void> {
    if (this.closed) return Promise.reject(new DispatchClosedError());
    const current = this.active.get(runId);
    if (current) { this.mark(runId, current); return current.task; }
    const entry: ActiveRun = { dirty: true, task: Promise.resolve(), writes: Promise.resolve() };
    this.active.set(runId, entry);
    this.mark(runId, entry);
    entry.task = Promise.resolve().then(() => this.run(runId, entry));
    this.inFlight.add(entry.task);
    // Callers may observe failures through wake or drain without an unhandled rejection.
    void entry.task.then(
      () => { this.inFlight.delete(entry.task); },
      (error: unknown) => { this.failures.push(error); this.inFlight.delete(entry.task); },
    );
    return entry.task;
  }
  private mark(runId: string, entry: ActiveRun): void {
    entry.dirty = true;
    if (this.options.markPending) {
      entry.writes = entry.writes.then(() => this.options.markPending!(runId));
      void entry.writes.catch(() => {});
    }
  }
  private async flushWrites(entry: ActiveRun): Promise<void> {
    let writes: Promise<void>;
    do { writes = entry.writes; await writes; } while (writes !== entry.writes);
  }
  private async run(runId: string, entry: ActiveRun): Promise<void> {
    try {
      while (entry.dirty) {
        await this.flushWrites(entry);
        if (this.closed) return;
        entry.dirty = false;
        const result = await this.options.advance(runId);
        if (this.closed) { await this.flushWrites(entry); return; }
        const pending = await this.options.hasPending?.(runId);
        if (pending || result?.pending) entry.dirty = true;
      }
    } catch (error) {
      // Even a failed turn must finish all durable wakes it already accepted.
      try { await this.flushWrites(entry); }
      catch (writeError) {
        if (writeError !== error) throw new AggregateError([error, writeError], 'Advance and pending persistence failed');
      }
      throw error;
    } finally {
      this.active.delete(runId);
    }
  }
  closeDispatch(): void { this.closed = true; }
  async drain(): Promise<void> {
    while (this.inFlight.size) await Promise.allSettled([...this.inFlight]);
    if (this.failures.length) throw new AggregateError(this.failures.splice(0), 'Run execution failed');
  }
}
