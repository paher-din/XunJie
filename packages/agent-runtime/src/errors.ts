import type { RequestCapacity } from './ports.js';

/** Domain reasons of the Agent loop, distinct from storage failure codes. */
export class AgentError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) { super(message ?? code); this.code = code; this.name = 'AgentError'; }
}
export const agentErrorCode = (error: unknown): string | null => error instanceof AgentError ? error.code : null;

export class ContextCapacityError extends AgentError {
  constructor(readonly bytes: number, readonly sent: boolean, reason: string, readonly capacity?: RequestCapacity) {
    super(sent ? 'context-capacity-exceeded' : 'context-capacity-preflight', reason);
  }
}
export class ContextPressureError extends AgentError {
  constructor(readonly capacity: RequestCapacity) {
    super('context-pressure', 'Final request crossed the 80% planning threshold');
  }
}
