import type { MaintenanceParticipantDescriptor } from '@xunjie/contracts/product-runtime';

export interface MaintenanceParticipant {
  descriptor: MaintenanceParticipantDescriptor;
  closeWrites(): Promise<void>;
  closeDispatch(): Promise<void>;
  drain(): Promise<void>;
  validate(): Promise<void>;
  resume(): Promise<void>;
}

export interface MaintenanceState {
  phase: 'open' | 'closing' | 'draining' | 'maintenance' | 'validating' | 'validated' | 'resuming' | 'failed';
  reason?: string;
  participants: MaintenanceParticipantDescriptor[];
  missingServiceIds: string[];
  gatesClosed: boolean;
  /** True only after every registered service is closed and drained and all required services exist. */
  safeToStop: boolean;
  error?: string;
}

/** Actions must resolve only once their effect is confirmed; closing must be idempotent. */
export function createMaintenanceCoordinator(options: {
  requiredServiceIds: string[];
  record: (state: MaintenanceState) => Promise<void>;
  timeoutMs?: number;
  beforeResume?: () => Promise<void>;
}) {
  const required = [...new Set(options.requiredServiceIds)];
  const participants = new Map<string, MaintenanceParticipant>();
  let phase: MaintenanceState['phase'] = 'open';
  let reason: string | undefined;
  let error: string | undefined;
  let busy = false;
  let gatesClosed = false;
  let drained = false;

  function status(): MaintenanceState {
    const missingServiceIds = required.filter((id) => !participants.has(id));
    return {
      phase, reason, error,
      participants: [...participants.values()].map(({ descriptor }) => ({
        ...descriptor,
        resourceRoots: [...descriptor.resourceRoots],
        configurationRefs: [...descriptor.configurationRefs],
      })),
      missingServiceIds,
      gatesClosed,
      safeToStop: !busy && gatesClosed && drained && missingServiceIds.length === 0
        && (phase === 'maintenance' || phase === 'validated'),
    };
  }

  async function save(next: MaintenanceState['phase']) {
    phase = next;
    // Completed transitions are recorded with the same readiness exposed after the operation.
    const snapshot = status();
    snapshot.safeToStop = gatesClosed && drained && snapshot.missingServiceIds.length === 0
      && (next === 'maintenance' || next === 'validated');
    await options.record(snapshot);
  }

  async function all(actions: (() => Promise<void>)[]) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = Promise.allSettled(actions.map((action) => Promise.resolve().then(action)));
    // Closing/draining/validation can time out safely: none of them open a gate.
    // Resume must confirm completion and is never abandoned in the background.
    const results = await (phase === 'resuming' ? pending : Promise.race([pending,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Maintenance participant timeout')), options.timeoutMs ?? 30_000); }),
    ])).finally(() => { if (timer) clearTimeout(timer); });
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length) {
      const causes: unknown[] = failures.map((result) => result.reason);
      throw new AggregateError(causes, `Maintenance participant failed: ${causes.map((cause) =>
        cause instanceof Error ? cause.message : String(cause)).join('; ')}`);
    }
  }

  async function close() {
    gatesClosed = false;
    drained = false;
    await all([...participants.values()].flatMap((participant) => [
      () => participant.closeWrites(), () => participant.closeDispatch(),
    ]));
    gatesClosed = true;
  }

  function requireParticipants() {
    const missing = status().missingServiceIds;
    if (missing.length) throw new Error(`Missing maintenance participants: ${missing.join(', ')}`);
  }

  async function quiesce() {
    await save('closing');
    await close();
    requireParticipants();
    await save('draining');
    await all([...participants.values()].map((participant) => () => participant.drain()));
    drained = true;
    await save('maintenance');
  }

  async function check() {
    requireParticipants();
    // A failed entry or newly registered missing participant needs the full boundary again.
    if (!gatesClosed || !drained) await quiesce();
    await save('validating');
    await all([...participants.values()].map((participant) => () => participant.validate()));
    await save('validated');
  }

  function exclusive(action: () => Promise<void>): Promise<MaintenanceState> {
    if (busy) return Promise.reject(new Error('Maintenance operation already in progress'));
    busy = true;
    return (async () => {
      try {
        await action();
      } catch (failure) {
        const failures = [failure];
        // Also reseal services already reopened before another service/record failed.
        try { await close(); } catch (closingFailure) { failures.push(closingFailure); }
        error = failures.map((item) => item instanceof Error ? item.message : String(item)).join('; ');
        try { await save('failed'); } catch (recordFailure) { failures.push(recordFailure); }
        throw new AggregateError(failures, error);
      } finally {
        busy = false;
      }
      return status();
    })();
  }

  return {
    register(participant: MaintenanceParticipant): void {
      if (busy || (phase !== 'open' && phase !== 'failed')) {
        throw new Error('Cannot change participants during maintenance');
      }
      const id = participant.descriptor.serviceId;
      if (!id || participants.has(id)) throw new Error(`Duplicate or empty maintenance serviceId: ${id}`);
      // Capture the descriptor and action bindings so caller mutation cannot change membership.
      participants.set(id, {
        descriptor: { ...participant.descriptor, resourceRoots: [...participant.descriptor.resourceRoots],
          configurationRefs: [...participant.descriptor.configurationRefs] },
        closeWrites: participant.closeWrites.bind(participant),
        closeDispatch: participant.closeDispatch.bind(participant),
        drain: participant.drain.bind(participant),
        validate: participant.validate.bind(participant),
        resume: participant.resume.bind(participant),
      });
      gatesClosed = false;
      drained = false;
    },
    enter(nextReason: string) {
      if (phase !== 'open' && phase !== 'failed') return Promise.reject(new Error('Maintenance already entered'));
      return exclusive(async () => { reason = nextReason; error = undefined; await quiesce(); });
    },
    validate() {
      if (phase === 'open') return Promise.reject(new Error('Enter maintenance before validating'));
      return exclusive(async () => { error = undefined; await check(); });
    },
    resume() {
      if (phase === 'open') return Promise.reject(new Error('Enter maintenance before resuming'));
      return exclusive(async () => {
        error = undefined;
        await check();
        await options.beforeResume?.();
        await save('resuming');
        gatesClosed = false;
        drained = false;
        await all([...participants.values()].map((participant) => () => participant.resume()));
        await save('open');
      });
    },
    status,
  };
}
