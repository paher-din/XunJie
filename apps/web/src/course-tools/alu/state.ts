/**
 * The ALU component's saved state. It holds only the five public controls, monotonically increasing
 * revisions and pointers to accepted executions. HDL, F/Cout and reports stay in their own records.
 */
export const ALU_CONTROL_LIMITS = { A: 15, B: 15, M: 1, S: 3, Cin: 1 } as const
export type AluControl = keyof typeof ALU_CONTROL_LIMITS
export const ALU_CONTROLS: AluControl[] = ['A', 'B', 'M', 'S', 'Cin']

export interface AluState {
  A: number; B: number; M: number; S: number; Cin: number
  inputRevision: number
  activationRevision: number
  enabledBasis: string
  pendingActivation: string
  pendingActivationRevision: number
  pendingActivationBase: number
  selectedObservation: string
  selectedObservationRevision: number
  selectedCheck: string
  selectedCheckBasis: string
  feedbackPolicy: 'live' | 'hold'
  caseDraft: string
  caseRequestId: string
  selectedCase: string
  reflectionFor: string
  reflectionParent: string
  reflectionDraft: string
  waveSelection: string
}

export interface EnabledBasis {
  requestId: string
  executionRef: string
  definitionDigest: string
  activationRevision: number
}

export const defaultAluState: AluState = {
  A: 0, B: 0, M: 0, S: 0, Cin: 0,
  inputRevision: 0, activationRevision: 0, enabledBasis: '', pendingActivation: '',
  pendingActivationRevision: 0, pendingActivationBase: 0,
  selectedObservation: '', selectedObservationRevision: -1, selectedCheck: '', selectedCheckBasis: '',
  feedbackPolicy: 'live',
  caseDraft: '', caseRequestId: '', selectedCase: '', reflectionFor: '', reflectionParent: '', reflectionDraft: '',
  waveSelection: '',
}

const integer = (value: unknown, fallback: number) => Number.isInteger(value) ? value as number : fallback
const text = (value: unknown, maxLength: number) => typeof value === 'string' && value.length <= maxLength ? value : ''

/** Tolerant display reader. The durable state envelope already rejects anything that does not match the manifest. */
export function readAluState(content: unknown): AluState {
  const value = content && typeof content === 'object' && !Array.isArray(content) ? content as Record<string, unknown> : {}
  return {
    A: Math.min(15, Math.max(0, integer(value.A, 0))),
    B: Math.min(15, Math.max(0, integer(value.B, 0))),
    M: Math.min(1, Math.max(0, integer(value.M, 0))),
    S: Math.min(3, Math.max(0, integer(value.S, 0))),
    Cin: Math.min(1, Math.max(0, integer(value.Cin, 0))),
    inputRevision: Math.max(0, integer(value.inputRevision, 0)),
    activationRevision: Math.max(0, integer(value.activationRevision, 0)),
    enabledBasis: text(value.enabledBasis, 4000),
    pendingActivation: text(value.pendingActivation, 64),
    pendingActivationRevision: Math.max(0, integer(value.pendingActivationRevision, 0)),
    pendingActivationBase: Math.max(0, integer(value.pendingActivationBase, 0)),
    selectedObservation: text(value.selectedObservation, 64),
    selectedObservationRevision: integer(value.selectedObservationRevision, -1),
    selectedCheck: text(value.selectedCheck, 64),
    selectedCheckBasis: text(value.selectedCheckBasis, 64),
    feedbackPolicy: value.feedbackPolicy === 'hold' ? 'hold' : 'live',
    caseDraft: text(value.caseDraft, 16000), caseRequestId: text(value.caseRequestId, 64),
    selectedCase: text(value.selectedCase, 64), reflectionFor: text(value.reflectionFor, 64),
    reflectionParent: text(value.reflectionParent, 64),
    reflectionDraft: text(value.reflectionDraft, 8000), waveSelection: text(value.waveSelection, 4000),
  }
}

export function controlsOf(state: AluState) {
  return { A: state.A, B: state.B, M: state.M, S: state.S, Cin: state.Cin }
}

export function sameControls(left: unknown, right: unknown) {
  const read = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    if (ALU_CONTROLS.some(key => !Number.isInteger(record[key]))) return null
    return ALU_CONTROLS.map(key => record[key] as number)
  }
  const a = read(left), b = read(right)
  return a !== null && b !== null && a.every((value, index) => value === b[index])
}

export function parseEnabledBasis(value: string): EnabledBasis | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    if (typeof parsed.requestId !== 'string' || typeof parsed.executionRef !== 'string'
      || typeof parsed.definitionDigest !== 'string' || !Number.isInteger(parsed.activationRevision)) return null
    return { requestId: parsed.requestId, executionRef: parsed.executionRef,
      definitionDigest: parsed.definitionDigest, activationRevision: parsed.activationRevision as number }
  } catch { return null }
}

export function encodeEnabledBasis(value: EnabledBasis) {
  return JSON.stringify(value)
}

export const relativeTime = (milliseconds: number) => {
  const seconds = Math.max(0, Math.round((Date.now() - milliseconds) / 1000))
  if (seconds < 60) return `${seconds} 秒前`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  return new Date(milliseconds).toLocaleString('zh-CN')
}
