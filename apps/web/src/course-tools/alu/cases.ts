import { aluCaseDraftSchema, aluCaseFromAction, aluCodeIdentity, sameAluInputs, newAluCaseDraft,
  type AluCaseDraft } from '@xunjie/contracts/alu-learning'
import type { ExecutionRecord } from '../../tool-execution/ledger'
import { controlsOf, type AluState } from './state'

export function readCaseDraft(value: string): AluCaseDraft | null {
  try { return aluCaseDraftSchema.parse(JSON.parse(value)) } catch { return null }
}

export function editCase(state: AluState, change: Partial<AluCaseDraft> = {}): AluState {
  const draft = readCaseDraft(state.caseDraft) ?? newAluCaseDraft(crypto.randomUUID(), crypto.randomUUID())
  return { ...state, feedbackPolicy: 'hold', caseRequestId: '', caseDraft: JSON.stringify({ ...draft, ...change,
    revisionId: crypto.randomUUID() }) }
}

/** Existing application observations remain sources even after identical code is copied to new IDs. */
export function priorCaseSources(records: ExecutionRecord[], enabled: ExecutionRecord, inputs: unknown) {
  if (enabled.action.protocolVersion !== 3) return []
  const identity = aluCodeIdentity(enabled.action)
  return records.filter(record => record.action.protocolVersion === 3
    && aluCodeIdentity(record.action) === identity && record.query.statusKnowledge === 'confirmed'
    && !!record.query.output && (record.action.execution.operation.operationId === 'check-all'
      || sameAluInputs(record.action.execution.parameters, inputs)))
    .slice(0, 32).map(record => ({ requestId: record.requestId, inputDigest: record.inputDigest,
      executionRef: record.executionRef, kind: record.action.execution.operation.operationId === 'check-all'
        ? 'work-check' as const : 'same-input-observation' as const }))
}

export function isCurrentComparison(state: AluState, record: ExecutionRecord | undefined) {
  const capture = record?.action.protocolVersion === 3 ? aluCaseFromAction(record.action) : null
  return !!capture && state.caseRequestId === record?.requestId && state.selectedCase === record.requestId
    && sameAluInputs(controlsOf(state), capture.inputs) && JSON.stringify(readCaseDraft(state.caseDraft)) === JSON.stringify(capture.draft)
}

export function comparisonText(prediction: string, actual: string | undefined, width: number) {
  if (!actual) return '实际值未取得'
  if (!new RegExp(`^[01xz]{${width}}$`, 'i').test(actual)) return '实际值不完整，不作二值比较'
  if (/[xz]/i.test(actual)) return '实际值含 X/Z，不能作二值比较'
  if (!prediction.trim()) return '未填写预测'
  if (!new RegExp(`^[01]{${width}}$`).test(prediction.trim())) return '预测未按二进制填写，原文保留'
  return prediction.trim() === actual ? '相同' : '不同'
}
