import { constants, closeSync, existsSync, fsyncSync, fstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RunnerError, sha256 } from './snapshot.ts';

export type RunIdentity = {
  runId: string;
  commandId: string;
  requestHash: string;
  recoveryGeneration: string;
  snapshotId: string;
  snapshotHash: string;
  inputHash: string;
  runtimeProfileVersion: string;
  imageDigest: string;
  authorizedScope: { userId: string; courseId: string; purpose: 'student_run' | 'teacher_sample';
    attemptId?: string; activityVersionId?: string };
};

type State = 'queued' | 'running' | 'cancelling' | 'cancelled' | 'succeeded' | 'failed' | 'stale' | 'outcome_unknown';
type Fact = { identity: RunIdentity; state: State; reserved: boolean; stopRequested: boolean;
  units: string[]; pending: string[]; resultRef?: string; resultHash?: string };
type Work = (signal: AbortSignal, phase: <T extends { unitTerminated: boolean }>(name: string,
  operation: () => Promise<T>) => Promise<T>) => Promise<{ unitTerminated: boolean; [key: string]: unknown }>;
type Authorization = (actor: unknown, identity: RunIdentity, action: 'submit' | 'query' | 'cancel') => boolean | Promise<boolean>;

// This is node-local control metadata, not the application's Job/Receipt/Event schema.
export class RunControl {
  private facts = new Map<string, Fact>();
  private work = new Map<string, { actor: unknown; execute: Work }>();
  private abort = new Map<string, AbortController>();
  private fd: number;
  private directoryFd: number;
  private previousHash = '0'.repeat(64);
  private directory: string;
  private generation: string;
  private authorize: Authorization;
  private authorizeRecovery: (actor: unknown, generation: string) => boolean | Promise<boolean>;
  private generations = new Set<string>();
  private stopUnit: (name: string) => Promise<boolean>;
  private healthy = true;
  private closed = false;
  private dispatchPaused = false;

  constructor(directory: string, generation: string, authorize: Authorization,
    stopUnit: (name: string) => Promise<boolean>, authorizeRecovery: (actor: unknown, generation: string) => boolean | Promise<boolean> = () => false) {
    if (process.platform !== 'linux' || typeof generation !== 'string' || !generation
      || typeof authorize !== 'function' || typeof stopUnit !== 'function' || typeof authorizeRecovery !== 'function') {
      throw new RunnerError('INVALID_CONFIGURATION', 'Linux and trusted control context required');
    }
    this.directory = resolve(directory);
    this.generation = generation;
    this.authorize = authorize;
    this.authorizeRecovery = authorizeRecovery;
    this.stopUnit = stopUnit;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (realpathSync(directory) !== this.directory) throw new RunnerError('INVALID_CONFIGURATION', 'Real local ledger directory required');
    const path = join(directory, 'ledger.jsonl');
    const entries = existsSync(path) ? readFileSync(path, 'utf8') : '';
    let recordedGeneration: string | undefined;
    if (entries && !entries.endsWith('\n')) throw new RunnerError('PERSISTENCE_UNAVAILABLE', 'Incomplete execution ledger');
    for (const line of entries.split('\n').filter(Boolean)) {
      let row;
      try { row = JSON.parse(line); } catch {
        throw new RunnerError('PERSISTENCE_UNAVAILABLE', 'Invalid execution ledger framing');
      }
      if (row.previousHash !== this.previousHash || row.hash !== sha256(JSON.stringify(row.payload) + this.previousHash)) {
        throw new RunnerError('PERSISTENCE_UNAVAILABLE', 'Execution ledger integrity failure');
      }
      this.previousHash = row.hash;
      if (row.payload.generation) {
        recordedGeneration = row.payload.generation;
        this.generations.add(recordedGeneration!);
      } else {
        const fact = row.payload as Fact;
        if (!fact.identity?.runId || !Array.isArray(fact.pending) || !Array.isArray(fact.units)) {
          throw new RunnerError('PERSISTENCE_UNAVAILABLE', 'Invalid execution ledger facts');
        }
        this.facts.set(fact.identity.runId, fact);
      }
    }
    if (entries && recordedGeneration !== generation) throw new RunnerError('RECOVERY_REQUIRED', 'Node generation reconciliation required');
    this.fd = openSync(path, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    this.directoryFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    fsyncSync(this.directoryFd);
    if (!entries) { this.append({ generation }); this.generations.add(generation); }
    for (const fact of this.facts.values()) {
      if (fact.reserved) this.save({ ...fact, state: 'outcome_unknown' });
    }
  }

  private append(payload: object) {
    if (!this.healthy || this.closed) throw new RunnerError('PERSISTENCE_UNAVAILABLE', 'Execution ledger unavailable');
    const hash = sha256(JSON.stringify(payload) + this.previousHash);
    const bytes = Buffer.from(JSON.stringify({ previousHash: this.previousHash, hash, payload }) + '\n');
    try {
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(this.fd, bytes, offset, bytes.length - offset);
      fsyncSync(this.fd);
      this.previousHash = hash;
    } catch {
      this.healthy = false;
      throw new RunnerError('PERSISTENCE_UNAVAILABLE', 'Execution ledger write failed');
    }
  }

  private save(fact: Fact) {
    const stored = structuredClone(fact);
    this.append(stored);
    this.facts.set(stored.identity.runId, stored);
  }

  private async guard(actor: unknown, identity: RunIdentity, action: 'submit' | 'query' | 'cancel') {
    if (!this.healthy || this.closed) throw new RunnerError('PERSISTENCE_UNAVAILABLE', 'Execution control unavailable');
    if (!identity || !identity.runId || !identity.commandId
      || !/^(?:sha256:)?[0-9a-f]{64}$/.test(identity.requestHash)
      || !identity.snapshotId || !/^[0-9a-f]{64}$/.test(identity.snapshotHash)
      || !/^[0-9a-f]{64}$/.test(identity.inputHash) || !identity.runtimeProfileVersion
      || !/^sha256:[0-9a-f]{64}$/.test(identity.imageDigest)
      || !identity.authorizedScope?.userId || !identity.authorizedScope?.courseId
      || !['student_run', 'teacher_sample'].includes(identity.authorizedScope.purpose)
      || (identity.authorizedScope.purpose === 'student_run' && !identity.authorizedScope.attemptId)
      || (identity.authorizedScope.purpose === 'teacher_sample' && identity.authorizedScope.attemptId)) {
      throw new RunnerError('INVALID_REQUEST', 'Invalid original run identity');
    }
    if (Object.entries(identity).some(([key, value]) => key !== 'authorizedScope' && (typeof value !== 'string' || !value))
      || Object.values(identity.authorizedScope).some(value => value !== undefined && (typeof value !== 'string' || !value))) {
      throw new RunnerError('INVALID_REQUEST', 'Control metadata must contain only scoped identifiers and digests');
    }
    if (Object.keys(identity).some(key => !['runId', 'commandId', 'requestHash', 'recoveryGeneration',
      'snapshotId', 'snapshotHash', 'inputHash', 'runtimeProfileVersion', 'imageDigest', 'authorizedScope'].includes(key))
      || Object.keys(identity.authorizedScope).some(key => !['userId', 'courseId', 'purpose', 'attemptId', 'activityVersionId'].includes(key))) {
      throw new RunnerError('INVALID_REQUEST', 'Only approved control metadata can enter the ledger');
    }
    if (identity.recoveryGeneration !== this.generation) throw new RunnerError('RECOVERY_REQUIRED', 'Stale control generation');
    if (await this.authorize(actor, identity, action) !== true) throw new RunnerError('FORBIDDEN', 'Run operation denied');
    if (!this.healthy || this.closed) throw new RunnerError('PERSISTENCE_UNAVAILABLE', 'Execution control unavailable');
  }

  private existing(identity: RunIdentity) {
    const existing = this.facts.get(identity.runId);
    if (existing) {
      const scope = identity.authorizedScope;
      const oldScope = existing.identity.authorizedScope;
      if (scope.userId !== oldScope.userId || scope.courseId !== oldScope.courseId
        || scope.purpose !== oldScope.purpose || scope.attemptId !== oldScope.attemptId
        || scope.activityVersionId !== oldScope.activityVersionId) throw new RunnerError('FORBIDDEN', 'Run scope mismatch');
      if (existing.identity.requestHash !== identity.requestHash || existing.identity.commandId !== identity.commandId) {
        throw new RunnerError('IDEMPOTENCY_CONFLICT', 'Original run request mismatch');
      }
      if (['snapshotId', 'snapshotHash', 'inputHash', 'runtimeProfileVersion', 'imageDigest'].some(key =>
        existing.identity[key as keyof RunIdentity] !== identity[key as keyof RunIdentity])) {
        throw new RunnerError('IDEMPOTENCY_CONFLICT', 'Original run references mismatch');
      }
    }
    return existing;
  }

  async submitRun(actor: unknown, identity: RunIdentity, work: Work) {
    identity = structuredClone(identity);
    await this.guard(actor, identity, 'submit');
    const existing = this.existing(identity);
    if (existing) {
      if (existing.state === 'queued' && !this.work.has(identity.runId)) {
        this.work.set(identity.runId, { actor, execute: work });
        this.pump();
      }
      return this.queryRun(actor, identity);
    }
    const scope = identity.authorizedScope;
    if (scope.attemptId && [...this.facts.values()].some(fact =>
      fact.identity.authorizedScope.attemptId === scope.attemptId && (fact.reserved || fact.state === 'queued'))) {
      throw new RunnerError('STATE_CONFLICT', 'Attempt already has an unsettled run');
    }
    this.save({ identity, state: 'queued', reserved: false, stopRequested: false, units: [], pending: [] });
    this.work.set(identity.runId, { actor, execute: work });
    this.pump();
    return this.queryRun(actor, identity);
  }

  async queryRun(actor: unknown, identity: RunIdentity) {
    identity = structuredClone(identity);
    await this.guard(actor, identity, 'query');
    const fact = this.existing(identity);
    if (!fact) return undefined;
    return structuredClone(fact);
  }

  async cancelRun(actor: unknown, identity: RunIdentity) {
    identity = structuredClone(identity);
    await this.guard(actor, identity, 'cancel');
    const existing = this.existing(identity);
    if (!existing) {
      this.save({ identity, state: 'cancelled', reserved: false, stopRequested: true, units: [], pending: [] });
    } else if (existing.reserved) {
      this.save({ ...existing, stopRequested: true, state: 'cancelling' });
      this.abort.get(identity.runId)?.abort();
      await this.settle(identity.runId);
    } else if (existing.state === 'queued') {
      this.save({ ...existing, stopRequested: true, state: 'cancelled' });
      this.work.delete(identity.runId);
    }
    return this.queryRun(actor, identity);
  }

  async readResult(actor: unknown, identity: RunIdentity) {
    const fact = await this.queryRun(actor, identity);
    if (!fact?.resultRef || !fact.resultHash) return undefined;
    const fd = openSync(join(this.directory, fact.resultRef), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!fstatSync(fd).isFile()) throw new RunnerError('INVALID_REFERENCE', 'Result is not a regular file');
      const bytes = readFileSync(fd);
      if (sha256(bytes) !== fact.resultHash) throw new RunnerError('INVALID_REFERENCE', 'Result content hash mismatch');
      return JSON.parse(bytes.toString('utf8'));
    } finally { closeSync(fd); }
  }

  async advanceGeneration(actor: unknown, generation: string) {
    if (!this.healthy || this.closed) throw new RunnerError('PERSISTENCE_UNAVAILABLE', 'Execution control unavailable');
    if (typeof generation !== 'string' || !generation || await this.authorizeRecovery(actor, generation) !== true) {
      throw new RunnerError('FORBIDDEN', 'Trusted recovery registration required');
    }
    if (generation === this.generation) return;
    if (this.generations.has(generation)) throw new RunnerError('RECOVERY_REQUIRED', 'Cannot reuse an older generation');
    if ([...this.facts.values()].some(fact => fact.reserved || fact.pending.length)) {
      throw new RunnerError('STATE_CONFLICT', 'Unknown or live units prevent generation admission');
    }
    for (const fact of this.facts.values()) {
      if (fact.state === 'queued') {
        this.save({ ...fact, state: 'stale', stopRequested: true });
        this.work.delete(fact.identity.runId);
      }
    }
    this.append({ generation });
    this.generations.add(generation);
    this.generation = generation;
  }

  private pump() {
    if (!this.healthy || this.closed || this.dispatchPaused) return;
    for (const fact of this.facts.values()) {
      if ([...this.facts.values()].filter(item => item.reserved).length >= 2) break;
      if (fact.state !== 'queued' || !this.work.has(fact.identity.runId)) continue;
      const id = fact.identity.runId;
      const queuedWork = this.work.get(id)!;
      this.work.delete(id);
      this.save({ ...fact, state: 'running', reserved: true });
      const abort = new AbortController();
      this.abort.set(id, abort);
      void this.run(id, queuedWork.actor, queuedWork.execute, abort).catch(() => {
        this.healthy = false;
      });
    }
  }

  private async run(id: string, actor: unknown, work: Work, abort: AbortController) {
    try {
      const accepted = this.facts.get(id)!;
      if (await this.authorize(actor, accepted.identity, 'submit') !== true) {
        throw new RunnerError('FORBIDDEN', 'Run dispatch denied');
      }
      if (this.facts.get(id)!.stopRequested) throw new RunnerError('STATE_CONFLICT', 'Run cancelled before dispatch');
      const result = await work(abort.signal, async (name, operation) => {
        const before = this.facts.get(id)!;
        if (before.stopRequested) throw new RunnerError('STATE_CONFLICT', 'Run stopped before phase launch');
        if (!/^xunjie-[a-z0-9-]+$/.test(name) || before.units.includes(name)) {
          throw new RunnerError('INVALID_CONFIGURATION', 'Execution unit identity must be unique');
        }
        this.save({ ...before, units: [...before.units, name], pending: [...before.pending, name] });
        const phase = await operation();
        if (!phase.unitTerminated) throw new RunnerError('DEPENDENCY_UNAVAILABLE', 'Unconfirmed execution unit termination');
        const after = this.facts.get(id)!;
        this.save({ ...after, pending: after.pending.filter(unit => unit !== name) });
        return phase;
      });
      if (!result.unitTerminated) throw new RunnerError('DEPENDENCY_UNAVAILABLE', 'Run outcome unknown');
      const fact = this.facts.get(id)!;
      if (!fact.reserved) return; // Recovery may have already persisted this worker's same outcome.
      if (!fact.stopRequested && fact.pending.length === 0) {
        const resultRef = `result-${sha256(id)}.json`;
        const fd = openSync(join(this.directory, resultRef), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        const bytes = Buffer.from(JSON.stringify(result));
        try {
          let offset = 0;
          while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
          fsyncSync(fd);
          fsyncSync(this.directoryFd);
        } finally { closeSync(fd); }
        this.save({ ...fact, state: 'succeeded', reserved: false, resultRef, resultHash: sha256(bytes) });
      } else {
        await this.settle(id);
      }
    } catch (error) {
      const fact = this.facts.get(id)!;
      if (fact.stopRequested && fact.pending.length === 0) await this.settle(id);
      else if (fact.units.length === 0 && fact.pending.length === 0) {
        this.save({ ...fact, state: 'failed', reserved: false });
      }
      else this.save({ ...fact, state: 'outcome_unknown', reserved: true });
    } finally {
      this.abort.delete(id);
      this.pump();
    }
  }

  private async settle(id: string) {
    const fact = this.facts.get(id)!;
    const stopped = await Promise.all(fact.units.map(unit => this.stopUnit(unit)));
    const current = this.facts.get(id)!;
    if (current.reserved && current.stopRequested && current.pending.length === 0 && stopped.every(Boolean)) {
      this.save({ ...current, state: 'cancelled', reserved: false });
      this.pump();
    }
  }

  close() {
    if ([...this.facts.values()].some(fact => fact.reserved)) throw new RunnerError('STATE_CONFLICT', 'Unsettled units prevent control shutdown');
    closeSync(this.fd);
    closeSync(this.directoryFd);
    this.closed = true;
  }

  setDispatchPaused(paused: boolean) { this.dispatchPaused = paused; if (!paused) this.pump(); }

  unsettledIdentities() {return [...this.facts.values()].filter(fact=>fact.reserved).map(fact=>structuredClone({...fact.identity,recoveryGeneration:this.generation}));}

  queuedIdentities() {return [...this.facts.values()].filter(fact=>fact.state==='queued').map(fact=>structuredClone(fact.identity));}
  currentGeneration() {return this.generation;}

  async reconcileRun(actor: unknown, identity: RunIdentity,
    readOutcome: () => Promise<{unitTerminated:boolean;[key:string]:unknown} | undefined>) {
    await this.guard(actor, identity, 'query');
    const fact = this.existing(identity);
    if (!fact?.reserved) return this.queryRun(actor, identity);
    const outcome = await readOutcome();
    if (!outcome?.unitTerminated) return this.queryRun(actor, identity);
    const current = this.existing(identity)!;
    const resultRef = `result-${sha256(identity.runId)}.json`;
    const bytes = Buffer.from(JSON.stringify(outcome));
    if (existsSync(join(this.directory,resultRef))) {
      if (sha256(readFileSync(join(this.directory,resultRef)))!==sha256(bytes)) throw new RunnerError('INVALID_REFERENCE','Recovered result mismatch');
    } else {
      const fd=openSync(join(this.directory,resultRef),constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY,0o600);
      try { let offset=0; while(offset<bytes.length)offset+=writeSync(fd,bytes,offset,bytes.length-offset); fsyncSync(fd); fsyncSync(this.directoryFd); }
      finally {closeSync(fd);}
    }
    this.save({...current,pending:[],reserved:false,state:current.stopRequested?'cancelled':'succeeded',resultRef,resultHash:sha256(bytes)});
    this.pump();
    return this.queryRun(actor,identity);
  }
}
