/** Domain reasons of the Agent loop, distinct from storage failure codes. */
export class AgentError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) { super(message ?? code); this.code = code; this.name = 'AgentError'; }
}
export const agentErrorCode = (error: unknown): string | null => error instanceof AgentError ? error.code : null;
