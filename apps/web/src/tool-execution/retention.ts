import { advanceExecution, isTerminalExecutionState, type ExecutionAcceptance, type AnyExecutionAction,
  type ExecutionOutput, type ExecutionQuery } from '@xunjie/contracts/execution'
import type { ResultResource } from './adapter'
import type { BrowserExecutionReceiver } from './receiver'
import type { ExecutionRecord } from './ledger'
import { abandonedQuery } from './ledger'
import type { ExecutionHistoryEntry } from '@xunjie/contracts/execution'
import type { ResultRecord } from './store'

/** The service side of the same facts; a local run is usable while it is unreachable. */
export interface ExecutionTransport {
  history?(): Promise<ExecutionHistoryEntry[]>
  artifact?(requestId: string): Promise<Omit<ResultRecord, 'scope' | 'at'> | null>
  accept(action: AnyExecutionAction, acceptance: ExecutionAcceptance): Promise<ExecutionQuery>
  report(requestId: string, query: ExecutionQuery): Promise<ExecutionQuery>
  stop(requestId: string, stopId: string, reason: string): Promise<ExecutionQuery>
  result(requestId: string, value: { contentId: string; output: unknown; text: string; name: string
    mediaType: string; sha256: string; byteLength: number; resources?:import('@xunjie/contracts/execution').ExecutionRetainedResource[] }): Promise<ExecutionQuery | null>
  read(requestId: string): Promise<ExecutionQuery | null>
}

const sha256Of = async (bytes: Uint8Array<ArrayBuffer>) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
  byte => byte.toString(16).padStart(2, '0')).join('')

/**
 * Result retention, in the order that matters: every byte is verified readable locally before the
 * primary reference is published, and the ownership service receives them afterwards. A lost
 * service reply only re-queries the same identity; it never recomputes the file.
 *
 * The first resource is the run's primary artifact, which is what `ExecutionQuery.output` cites.
 * The rest are retained under the same execution reference, so a run's diagnostics, log and
 * waveform survive an upgrade and are read by role rather than by a larger text field.
 */
export async function retainResult(receiver: BrowserExecutionReceiver, record: ExecutionRecord, value: {
  output: ExecutionOutput['output']; text: string; name: string; mediaType: string
}, extras: ResultResource[] = []): Promise<{ output: ExecutionOutput; sha256: string }> {
  const bytes = new TextEncoder().encode(value.text)
  const sha256 = await sha256Of(bytes)
  const output: ExecutionOutput = { contentId: crypto.randomUUID(), output: value.output,
    artifact: { name: value.name, mediaType: value.mediaType, byteLength: bytes.length, sha256 } }
  const resources=await Promise.all(extras.map(async resource=>({...resource,contentId:crypto.randomUUID(),
    sha256:await sha256Of(new TextEncoder().encode(resource.text)),byteLength:new TextEncoder().encode(resource.text).length})))
  // The artifact is read back before its reference is published; a record alone is not proof.
  await receiver.retainResult({ scope: record.scope, executionRef: record.executionRef, requestId: record.requestId,
    name: value.name, mediaType: value.mediaType, sha256, byteLength: bytes.length, text: value.text,
    output: value.output, at: Date.now(),...(resources.length?{resources}:{}) })
  // Secondary resources are all-or-nothing: a half-retained result is never published as complete.
  for (const [index, resource] of extras.entries()) {
    const resourceBytes = new TextEncoder().encode(resource.text)
    const resourceDigest = await sha256Of(resourceBytes)
    await receiver.retainResult({ scope: record.scope, executionRef: `${record.executionRef}:${index + 1}`,
      requestId: record.requestId, name: resource.name, mediaType: resource.mediaType, sha256: resourceDigest,
      byteLength: resourceBytes.length, text: resource.text, output: null, at: Date.now() })
  }
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
