/** Display-only submission facts, already authorized by the host. */
export interface SubmissionSnapshotDisplay {
  snapshotId: string; workspaceRevision: number; createdAt: string; hash: string
  files: Array<{ fileId: string; path: string; documentVersion: number }>
}
export interface SubmissionFeedbackDisplay {
  phase: 'idle' | 'reading' | 'ready' | 'sending' | 'unknown' | 'unavailable'
  assignment: { active: boolean } | null
  pending: { kind: 'submit' | 'resume' } | null
  notice: string | null; feedbackNotice: string | null
  recovery: { attempt: { status: 'ready' | 'active' | 'paused' | 'submitted' | 'reviewed'; attemptRevision: number }
    runs: Array<{ runId: string; mode: 'run' | 'check'; snapshotId: string; outcome: string }>
    reopen: { actionable: boolean; state: 'none' | 'valid' | 'consumed' | 'superseded'; reason?: string }
    latestSubmissionId?: string
    submissions: Array<{ submissionId: string; workspaceRevision: number; submittedAt: string; snapshotId: string; snapshotHash: string; hasReflection: boolean; checkRefs: readonly unknown[] }>
  } | null
  feedback: { entries: Array<{ feedbackId: string; threadRevision: number; kind: 'formative' | 'submission_review'; current: boolean; createdAt: string
    summary: string; reason: string; disputed: boolean; submissionId: string
    basis: Array<{ claimId: string; claimRevision: number; status: 'current' | 'revised' | 'withdrawn' | 'superseded' | 'unavailable' }> }> } | null
}
