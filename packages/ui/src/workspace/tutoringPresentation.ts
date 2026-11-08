/** Authorized teaching records as display facts. No controller, receipt writer or identity validation. */
export interface TutorObjectDisplay { kind: string; attemptId: string; [key: string]: unknown }
export interface TutorHdlSelectionDisplay { snapshotId: string; buildId: string; sessionId?: string; operationId?: string }
export interface TutorHdlBasisDisplay extends TutorHdlSelectionDisplay {
  snapshotHash: string; buildStatus: string; workspaceRevision?: number; sessionRevision?: number
  confirmedSequence?: number; simTimePs?: string; resultHash?: string
}
export interface TutorMessageDisplay {
  valid: boolean; shown: boolean
  facts: { received?: { state: string }; displayed?: unknown; acknowledged?: unknown }
  payload: { actionId: string; content?: string; expectedStudentAction?: string; jobId?: string; messageId?: string
    basis?: { objectRef?: TutorObjectDisplay; hdl?: TutorHdlBasisDisplay }
    targetVersions?: { policyVersionId: string }; rationale?: string; assistanceContext?: string
    unresolved?: string[]; resourceRefs?: string[]; evidenceIds?: string[]; basisRevised: boolean }
}
export interface TutorHistoryEntryDisplay {
  action: { actionId: string; jobId: string; messageId: string; basis: { objectRef?: TutorObjectDisplay; hdl?: TutorHdlBasisDisplay; decisionEpoch: number }
    targetVersions: { policyVersionId: string }; disposition: string; basisRevised: boolean; stopReason?: string; receipts: Array<{ receiptKind: string }> }
  message: { envelope: { body: { content: string; expectedStudentAction: string; assistanceContext: string; unresolved: string[] } } }
  question?: { messageId: string; envelope: { question: string; hdlSelection?: TutorHdlSelectionDisplay } }
}

export interface TutorQuestionDisplay { messageId: string; envelope: { question: string; hdlSelection?: TutorHdlSelectionDisplay } }
export interface TutorHistoryDisplay {
  phase: 'loading' | 'ready' | 'unavailable'; notice: string | null
  data: { questions: TutorQuestionDisplay[]; entries: TutorHistoryEntryDisplay[] }
}
export interface TutorExchangeDisplay {
  key: string
  command?: { question?: string; statusLabel: string; error?: string; failureNotice?: string }
  messageIds: string[]
}
