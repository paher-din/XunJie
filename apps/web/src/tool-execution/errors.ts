import type { ExecutionFailure } from '@xunjie/contracts/execution'

export type ExecutionErrorCode = ExecutionFailure['code']

/**
 * A failure the public executor can publish as a real terminal reason. Adapters and workers raise
 * this; anything else stays an unspecified execution error rather than an invented cause.
 */
export class ExecutionError extends Error {
  constructor(readonly code: ExecutionErrorCode, message: string,
    readonly resources?:import('./adapter').ResultResource[]) { super(message) }
}
