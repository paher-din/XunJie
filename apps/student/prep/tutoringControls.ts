/** I0-B-06 synthetic control plans, traced to server/workspace/{inputs,controls,commands}.ts.
 * The owner plugs this into the existing prepTeachingCommand; no second head or replay ledger.
 */
import type { AttemptView, Receipt } from '../src/workspace/workspaceContracts'
import type { ApiErrorCode } from '../src/workspace/contracts'
import type { PrepSession } from './authority'
import { PrepWorkspaceError, type readPrepAttempt } from './workspace'

type Head = ReturnType<typeof readPrepAttempt>
type TutoringControl = { kind: 'pause' } | { kind: 'resume' } | { kind: 'capture'; value: boolean } | { kind: 'reminders'; value: boolean }
interface ControlResult {
  attemptRevision: number; decisionEpoch: number; captureRevision: number
  cancelledJobIds: string[]; captureChanged: boolean
}
type ControlPurpose = 'student_help' | 'reminder' | 'explicit_analysis' | 'passive_analysis' | 'student_run'
export interface PrepControlInput { recoveryGeneration: string; expectedAttemptRevision: number; control: TutoringControl }
function fail(code: ApiErrorCode): never { throw new PrepWorkspaceError(code) }
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail('INVALID_REQUEST')
  return value as Record<string, unknown>
}
/** Four controls in this slice, not an alternative schema for position/start/reopen. */
export function parsePrepControlInput(value: unknown): PrepControlInput {
  const body = exact(value, ['recoveryGeneration', 'expectedAttemptRevision', 'control'])
  if (typeof body.recoveryGeneration !== 'string' || !body.recoveryGeneration.length || body.recoveryGeneration.length > 128 ||
    !Number.isSafeInteger(body.expectedAttemptRevision) || (body.expectedAttemptRevision as number) < 1) fail('INVALID_REQUEST')
  const control = exact(body.control, ['kind', 'value'])
  if (control.kind === 'pause' || control.kind === 'resume') {
    exact(body.control, ['kind'])
  } else if (!['capture', 'reminders'].includes(String(control.kind)) || typeof control.value !== 'boolean') fail('INVALID_REQUEST')
  return structuredClone(body) as unknown as PrepControlInput
}
export function planPrepControl<T extends AttemptView>(attempt: T, expectedRevision: number, control: TutoringControl, assignmentActive: boolean) {
  if (expectedRevision !== attempt.attemptRevision) fail('VERSION_CONFLICT')
  const next = structuredClone(attempt)
  let changed = false, captureChanged = false
  let cancelPurposes: ControlPurpose[] = []
  if (control.kind === 'pause' || control.kind === 'resume') {
    if (!assignmentActive && control.kind === 'resume') fail('STATE_CONFLICT')
    if (attempt.status !== (control.kind === 'pause' ? 'active' : 'paused')) fail('STATE_CONFLICT')
    next.status = control.kind === 'pause' ? 'paused' : 'active'
    changed = true
    if (control.kind === 'pause') {
      next.decisionEpoch++
      cancelPurposes = ['student_help', 'reminder', 'explicit_analysis', 'passive_analysis', 'student_run']
    }
  } else {
    const key = control.kind === 'capture' ? 'collecting' : 'reminders'
    changed = next[key] !== control.value
    if (changed) {
      next[key] = control.value
      if (control.kind === 'capture') {
        next.captureRevision++; captureChanged = true
        if (!control.value) cancelPurposes = ['passive_analysis']
      } else if (!control.value) cancelPurposes = ['reminder']
    }
  }
  if (changed) next.attemptRevision++
  return { attempt: next, cancelPurposes, captureChanged }
}
/** Passed by prep/plugin.ts from the workspace owner's existing scene command function.
 * The owner must retain generation/authorization/original-key replay BEFORE calling work,
 * and controlCommand's digest {expectedRevision,control} (not HTTP's expectedAttemptRevision).
 */
export type PrepTeachingCommandPort = (scenario: string, session: PrepSession, attemptId: string,
  commandName: string, target: string, body: Record<string, unknown>, key: unknown, work: (head: Head) => unknown) => Receipt
export interface PrepControlPorts {
  prepTeachingCommand: PrepTeachingCommandPort
  assignmentActive: (scenario: string, session: PrepSession, attemptId: string) => boolean
  /** Same teaching authority cancels undisplayed Actions/teaching Jobs; no fake fields added to head. */
  stopTeaching?: (scenario: string, attemptId: string, purposes: ControlPurpose[]) => string[]
}
export function createPrepControlHandler(ports: PrepControlPorts) {
  return (scenario: string, session: PrepSession, attemptId: string, value: unknown, key: unknown): Receipt => {
    const input = parsePrepControlInput(value)
    const target = `/api/attempts/${encodeURIComponent(attemptId)}/controls`
    // Internal digest adapter only: POST wire stays expectedAttemptRevision.
    const digestBody = { recoveryGeneration: input.recoveryGeneration, expectedRevision: input.expectedAttemptRevision, control: input.control }
    return ports.prepTeachingCommand(scenario, session, attemptId, 'attempt.control', target, digestBody, key, head => {
      // Assignment and Attempt checks are inside the original command's serialized mutation.
      const plan = planPrepControl(head.attempt, input.expectedAttemptRevision, input.control,
        ports.assignmentActive(scenario, session, attemptId))
      const cancelledJobIds: string[] = []
      const terminal = new Set(['succeeded', 'failed', 'cancelled', 'stale', 'timed_out'])
      for (const job of head.jobs) {
        if (!plan.cancelPurposes.includes(job.purpose) || job.stopRequested ||
          job.scope.courseId !== head.attempt.courseId || job.scope.studentId !== head.attempt.studentId ||
          job.scope.attemptId !== head.attempt.attemptId) continue
        job.stopRequested = true
        if (!terminal.has(job.status)) job.status = 'cancelling'
        cancelledJobIds.push(job.jobId)
      }
      if (plan.cancelPurposes.length) cancelledJobIds.push(...(ports.stopTeaching?.(scenario, attemptId, plan.cancelPurposes) ?? []))
      head.attempt = plan.attempt
      return { attemptRevision: plan.attempt.attemptRevision, decisionEpoch: plan.attempt.decisionEpoch,
        captureRevision: plan.attempt.captureRevision, cancelledJobIds: [...new Set(cancelledJobIds)], captureChanged: plan.captureChanged } satisfies ControlResult
    })
  }
}
