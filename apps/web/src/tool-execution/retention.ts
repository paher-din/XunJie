import { advanceExecution, isTerminalExecutionState, type ExecutionAcceptance, type ExecutionAction,
  type ExecutionOutput, type ExecutionQuery } from '@xunjie/contracts/execution'
import { AlgorithmError } from './algorithm'
import type { BrowserExecutionReceiver } from './receiver'
import type { ExecutionRecord } from './ledger'
import { abandonedQuery } from './ledger'

/** The service side of the same facts; a local run is usable while it is unreachable. */
export interface ExecutionTransport {
  accept(action: ExecutionAction, acceptance: ExecutionAcceptance): Promise<ExecutionQuery>
  report(requestId: string, query: ExecutionQuery): Promise<ExecutionQuery>
  stop(requestId: string, stopId: string, reason: string): Promise<ExecutionQuery>
  result(requestId: string, value: { contentId: string; output: unknown; text: string; name: string
    mediaType: string; sha256: string; byteLength: number }): Promise<ExecutionQuery | null>
  read(requestId: string): Promise<ExecutionQuery | null>
}

/**
 * Result retention, in the order that matters: the bytes are verified readable locally, then the
 * reference is published, then the ownership service receives them. A lost service reply only
 * re-queries the same identity; it never recomputes the file.
 */
export async function retainResult(receiver: BrowserExecutionReceiver, record: ExecutionRecord, value: {
  output: ExecutionOutput['output']; text: string; name: string; mediaType: string
}): Promise<{ output: ExecutionOutput; sha256: string }> {
  const bytes = new TextEncoder().encode(value.text)
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    byte => byte.toString(16).padStart(2, '0')).join('')
  const output: ExecutionOutput = { contentId: crypto.randomUUID(), output: value.output,
    artifact: { name: value.name, mediaType: value.mediaType, byteLength: bytes.length, sha256 } }
  await receiver.retainResult({ scope: record.scope, executionRef: record.executionRef, requestId: record.requestId,
    name: value.name, mediaType: value.mediaType, sha256, byteLength: bytes.length, text: value.text,
    output: value.output, at: Date.now() })
  return { output, sha256 }
}

/** A reloaded page can only be sure about a run that never started. */
export function reconcileOnOpen(record: ExecutionRecord): { query: ExecutionQuery; resume: boolean } {
  if (isTerminalExecutionState(record.query.state)) return { query: record.query, resume: false }
  if (record.startedAt === null) return { query: record.query, resume: true }
  return { query: abandonedQuery(record.query), resume: false }
}

export function mergeServiceFact(current: ExecutionQuery | null, remote: ExecutionQuery | null): ExecutionQuery | null {
  if (!remote) return current
  if (!current) return remote
  return advanceExecution(current, remote)
}

export { AlgorithmError }
