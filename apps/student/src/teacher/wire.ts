// Browser wire DTOs mirror contracts/design/{draft,results,workbench}.ts, contracts/review/index.ts and their
// workspace/records projections. Keep these structural types free of backend imports: those schemas include
// Node runner validation and target a different TypeScript/runtime configuration.
export type CompetencyDomain = 'domain' | 'project' | 'ai_collaboration'
export interface GoalRef { competencyId: string; competencyVersion: number }
export interface BlueprintGoal extends GoalRef { domain: CompetencyDomain; title: string; core: boolean }
export interface BlueprintContent {
  projectTitle?: string; problem?: string; audience?: string; artifact?: string
  studentBackground?: string; timeConstraints?: string
  routes: string[]; goals: BlueprintGoal[]
  tasks: { taskId: string; title: string; goalRefs: GoalRef[] }[]
  observations: { observationId: string; description: string; goalRefs: GoalRef[]; taskIds: string[] }[]
  rubricCriteria: { criterionId: string; description: string; goalRefs: GoalRef[]; observationIds: string[] }[]
  milestones: { milestoneId: string; title: string; taskIds: string[] }[]
  resources: { resourceVersionId: string }[]
  digitalLogicConfigVersionId?: string; helpPolicyVersionId?: string; checkRuleVersionId?: string; runtimeProfileVersionId?: string
}
export interface BlueprintDraft {
  courseId: string; blueprintId: string; revision: number; content: BlueprintContent
  source?: { courseId: string; blueprintId: string; revision: number }
}
export interface MaterialParagraph {
  paragraphId: string; ordinal: number; start: number; end: number; text: string; contentHash: string
}
export interface ResourceVersion {
  courseId: string; resourceVersionId: string; available: true; teacherDesignAllowed: boolean
  material: { format: 'txt' | 'markdown' | 'paste'; kind: 'learning_material' | 'private_answer' | 'validation_asset'
    title: string; text: string; byteLength: number; contentHash: string
    visibility: { student: boolean; tutor: boolean }; paragraphs: MaterialParagraph[] }
}
export interface HelpPolicyVersion {
  versionId: string; helpAllowed: boolean; wholeSolutionAllowed: false; limitedCheckHelpAllowed: false; description: string
}
export interface TeacherConcern {
  code: 'meaning' | 'difficulty' | 'time' | 'solution_space' | 'rubric_ambiguity'
  path: string; reason: string; resolution?: string
}
export interface DesignCheckReport {
  blueprintId: string; revision: number
  execution?: { kind: 'hdl_board'; structural: 'validated'; behavior: 'unverified' }
  blocking: { code: string; path: string }[]
  designConcerns: (TeacherConcern & { status: 'teacher_recorded' | 'requires_teacher' })[]
  unverified: { code: 'learning_effect' | 'workload_estimate'; path: string; status: 'unknown' }[]
}
export type DesignResult = { kind: 'material'; resourceVersion: ResourceVersion }
  | { kind: 'draft'; draft: BlueprintDraft } | { kind: 'checks'; report: DesignCheckReport }
type PreviewContent = Pick<BlueprintContent, 'projectTitle' | 'problem' | 'audience' | 'artifact' | 'studentBackground'
  | 'timeConstraints' | 'routes' | 'goals' | 'tasks' | 'observations' | 'rubricCriteria' | 'milestones' | 'helpPolicyVersionId'>
export type PreviewMaterial = { status: 'available'; resourceVersionId: string; title: string; text: string; contentHash: string
  paragraphs: (Omit<MaterialParagraph, 'paragraphId'> & { paragraphId?: string })[] }
  | { status: 'redacted' } | { status: 'unavailable' }
export interface RolePreview {
  audience: 'student' | 'tutor' | 'teacher-validator'; content: PreviewContent; materials: PreviewMaterial[]
}
export interface BlueprintPreview extends RolePreview { blueprintId: string; revision: number }
export interface HdlConfiguration {
  versionId: string
  board: { boardProfileVersion: string; mappingVersion: string; topModule: string
    bindings: { signal: 'clock' | 'switches' | 'buttons' | 'resetN' | 'leds' | 'anodes' | 'segments' | 'dp'
      offset: number; port: string; portOffset: number; width: number }[] }
  runtime: { runtimeProfileVersion: string; engineVersion: string; buildImage: string; runtimeImage: string; sourceHash: string }
  signals: { bitOrder: 'msb_first'; clockHz: 100000000; initialClock: '0'; initialSwitches: '0000000000000000'
    initialButtons: '00000'; initialResetN: '1'; stableSampling: 'low_phase'; anodesActive: 'low'; segmentsActive: 'low'; dpActive: 'low' }
  alu: { operandWidth: 4; resultWidth: 4; carryWidth: 1; signedness: 'unsigned'
    operations: { mode: '0' | '1'; code: '00' | '01' | '10' | '11'; meaning: 'not_a' | 'and' | 'or' | 'xor' | 'add_with_carry' | 'subtract_with_borrow' }[]
    subtractionOperandDomain: 'a_gt_b'; undefinedArithmeticSelectors: 'ungraded'; subtractionOutsideDomain: 'ungraded'; nonAdditionCout: 'ungraded'
    switchMapping: { semantic: 'operand_a' | 'operand_b' | 'mode' | 'select' | 'carry_in'; offset: number; width: number }[] }
  structuralCoverage: 'board_bindings_and_defined_alu_domain'
}
export interface ActivityView {
  activityVersionId: string; courseId: string; sourceRevision?: number; sourceBlueprintId?: string
  activityControlRevision: number; status: 'active' | 'paused'; content: RolePreview
  helpPolicy: HelpPolicyVersion; runtimeProfileVersionId: string
  execution?: { kind: 'hdl_board'; runtimeProfileVersion: string; configuration: HdlConfiguration; contentHash: string }
}
export interface TeacherWorkbench {
  courseId: string; courseName?: string; recoveryGeneration: string
  members: { userId: string; displayName?: string }[]
  resources: ResourceVersion[]; drafts: BlueprintDraft[]; activities: ActivityView[]
  assignments: { assignmentId: string; studentId: string; activityVersionId: string; assignmentRevision: number; active: boolean; displayTitle?: string }[]
  attempts: { attemptId: string; courseId: string; studentId: string; assignmentId: string; activityVersionId: string
    status: Attempt['status']; attemptRevision: number; workspaceRevision: number
    latestSubmission: { submissionId: string; snapshotId: string; submittedAt: string } | null }[]
  presets: { id: string; title: string; content: BlueprintContent; helpPolicy: HelpPolicyVersion }[]
}

export type EvidenceRef = { kind: 'snapshot' | 'run' | 'message' | 'action'; id: string; attemptId: string }
  | { kind: 'coverage'; id: string; attemptId: string; captureRevision: number; fromServerSeq: number }
  | { kind: 'context' | 'claim'; id: string; revision: number }
  | { kind: 'teacher_decision'; id: string }
  | { kind: 'resource'; id: string; resourceVersionId: string; paragraphId: string }
export interface ClaimRef { kind: 'claim'; id: string; revision: number }
export interface LearnerClaim {
  competencyId: string; competencyVersion: number; domain: CompetencyDomain
  scope: { kind: 'course' } | { kind: 'activity'; activityVersionId: string }
  claimId: string; statement: string; state: 'insufficient' | 'supported_with_assistance' | 'supported_in_check' | 'conflicting'
  evidenceIds: string[]; counterEvidenceIds: string[]; assistanceStatus: 'observed_help' | 'none_observed_in_system' | 'unknown'
  unresolved: boolean; unknown: string[]; claimRevision: number; courseId: string; studentId: string
  validity: 'active' | 'contested' | 'superseded' | 'withdrawn'; estimatorVersion: string; analysisVersion: string
  source: 'model_candidate' | 'teacher_judgment'; sourceId: string; refs: EvidenceRef[]; basisAtoms: string[]; evidenceGroupIds: string[]
}
export interface TeacherDecision {
  decisionId: string; courseId: string; studentId: string; attemptId: string; teacherId: string
  expectedStateRevision: number; learnerStateRevision: number; targetRef: ClaimRef
  decision: 'confirm' | 'correct' | 'defer'; reason: string; evidenceRefs: EvidenceRef[]; replacementClaimId?: string; createdAt: string
}
export interface LearnerDispute {
  disputeId: string; courseId: string; studentId: string; attemptId: string
  targetRef: ClaimRef | { kind: 'feedback'; id: string; revision: number }; reason: string; currentTarget: boolean; learnerStateRevision: number; createdAt: string
}
export interface FeedbackEntry {
  feedbackId: string; threadRevision: number; courseId: string; studentId: string; attemptId: string; submissionId: string; teacherId: string
  kind: 'formative' | 'submission_review'; expectedStateRevision: number; summary: string; reason: string
  evidenceRefs: EvidenceRef[]; claimRefs: ClaimRef[]; createdAt: string; current: boolean; disputed: boolean
  basis: { claimId: string; claimRevision: number; status: 'current' | 'revised' | 'withdrawn' | 'superseded' | 'unavailable' }[]
}
export interface FeedbackThread { feedbackRevision: number; entries: FeedbackEntry[] }
export interface ReopenView {
  state: 'none' | 'valid' | 'consumed' | 'superseded'; actionable: boolean
  grantId?: string; submissionId?: string; reason?: string; grantedAt?: string; consumedAt?: string
}
export interface FeedbackView extends FeedbackThread { reopen: ReopenView }
interface Range { startLine: number; startColumn: number; endLine: number; endColumn: number }
type ObjectRef = { kind: 'code'; attemptId: string; snapshotId: string; fileId: string; path: string; documentVersion: number; contentHash: string; range?: Range
  source?: { system: 'student-ide'; session: string; modelId: string; seq?: number } }
  | { kind: 'run'; attemptId: string; runId: string; snapshotId: string }
  | { kind: 'resource'; attemptId: string; resourceVersionId: string; paragraphId: string }
  | { kind: 'project'; attemptId: string; activityVersionId: string }
interface Attempt {
  attemptId: string; courseId: string; studentId: string; assignmentId: string; activityVersionId: string
  status: 'ready' | 'active' | 'paused' | 'submitted' | 'reviewed'; attemptRevision: number; workspaceRevision: number
  decisionEpoch: number; captureRevision: number; collecting: boolean; reminders: boolean
  route?: string; question?: string; returnPosition?: ObjectRef
}
interface Submission {
  submissionId: string; attemptId: string; courseId: string; studentId: string; assignmentId: string; activityVersionId: string
  snapshotId: string; snapshotHash: string; workspaceRevision: number; attemptRevision: number; decisionEpoch: number
  recoveryGeneration: string; receiptId: string; submittedAt: string; reflection?: string
  checkRefs: { runId: string; snapshotId: string; resultHash?: string; verdict?: string }[]
}
type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelling' | 'cancelled' | 'stale' | 'timed_out' | 'outcome_unknown'
interface RecoveryRun {
  runId: string; jobId: string; mode: 'run' | 'check'; snapshotId: string; jobStatus: JobStatus
  outcome: 'confirmed' | 'incomplete' | 'unknown' | 'failed' | 'cancelled' | 'in_flight' | 'stale' | 'timed_out'
}
interface HdlHelpBasis {
  snapshotId: string; snapshotHash: string; buildId: string; buildResultHash?: string; workspaceRevision?: number
  buildStatus: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'outcome_unknown'
  sessionId?: string; sessionRevision?: number; sessionStatus?: 'starting' | 'active' | 'stopping' | 'stopped' | 'failed' | 'outcome_unknown'
  sessionGeneration?: string; confirmedSequence?: number; simTimePs?: string; pendingOperationId?: string
  stopRequested?: boolean; terminationConfirmed?: boolean; operationId?: string; resultHash?: string
}
interface TeachingVersions {
  activityVersionId: string; policyVersionId: string; modelConfigVersion: string; promptVersion: string; schemaVersion: string; analysisVersion?: string
}
interface TeachingBasis {
  attemptRevision: number; decisionEpoch: number; captureRevision: number; relatedStateRevision: number
  objectRef?: ObjectRef; hdl?: HdlHelpBasis; inputRefs: string[]; assistanceRefs: string[]; coverageRefs: string[]
}
interface TeachingScope { courseId: string; studentId: string; attemptId: string }
type TeachingEnvelope = { kind: 'student_question'; question: string; objectRef?: ObjectRef
  hdlSelection?: { snapshotId: string; buildId: string; sessionId?: string; operationId?: string }; hdlBasis?: HdlHelpBasis; inputRefs: string[]; versions: TeachingVersions }
  | { kind: 'student_help'; body: unknown; bodyJsonText?: string; versions: TeachingVersions
    usage: { status: 'actual'; inputTokens: number; outputTokens: number } | { status: 'unknown'; reason?: string }
    calls: number; elapsedMs: number; basis: TeachingBasis }
interface TeachingMessage {
  messageId: string; scope: TeachingScope; jobId: string; requestReceiptId?: string; authorKind: 'student' | 'model'; contentHash: string; resultHash?: string; envelope: TeachingEnvelope
}
interface TeachingActionRecord {
  actionId: string; scope: TeachingScope; jobId: string; messageId: string; contentHash: string
  disposition: 'pending' | 'cancelled' | 'stale' | 'failed'; targetVersions: TeachingVersions; basis: TeachingBasis; generation: string
  stopReason?: string; causeRef?: string; basisRevised: boolean; createdAt: string
  deliveries: { deliveryId: string; actionId: string; recipientId: string; clientId: string; contentHash: string
    recoveryGeneration: string; serverSeq: number; attemptedAt: string; control: { attemptRevision: number; decisionEpoch: number; captureRevision: number }; eventId?: string }[]
  receipts: { receiptId: string; actionId: string; deliveryId?: string; contentHash: string
    receiptKind: 'received' | 'displayed' | 'acknowledged' | 'cancelled' | 'stale' | 'failed'; clientReceiptId: string; clientId: string; serverSeq: number
    clientDeclaredAt?: string; serverReceivedAt: string; versions: TeachingVersions; raceReason?: string }[]
}
interface TeachingCoverage {
  attemptId: string; captureRevision: number; collecting: boolean; cutoffServerSeq: number
  intervals: { attemptId: string; captureRevision: number; state: 'collecting' | 'paused'; fromServerSeq: number; from: string; to?: string; toServerSeq?: number
    open: boolean; rejections: { receiptId: string; reason: string }[] }[]
}
export interface ReviewContext {
  attempt: Attempt; submission: Submission | null; submissions: (Submission & { latest: boolean })[]
  artifact: { fileId: string; path: string; documentVersion: number; contentHash: string }[]; artifactSnapshotId: string | null
  workspaceFiles: { fileId: string; path: string; documentVersion: number; contentHash: string; lifecycle: 'active' | 'recycled' }[]
  runs: RecoveryRun[]; help: { messages: TeachingMessage[]; actions: TeachingActionRecord[] }; coverage: TeachingCoverage
  competencies: Record<CompetencyDomain, (LearnerClaim & { basisAvailable: boolean; references: { ref: EvidenceRef; status: 'available' | 'unavailable' }[] })[]>
  learnerStateRevision: number; decisions: TeacherDecision[]; disputes: LearnerDispute[]; feedback: FeedbackThread; reopen: ReopenView
}
