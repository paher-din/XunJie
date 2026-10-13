import type {Snapshot} from '../runner/index.ts';
export type Range = {startLine:number;startColumn:number;endLine:number;endColumn:number};
export type ObjectRef = {kind:'code';attemptId:string;snapshotId:string;fileId:string;path:string;
  documentVersion:number;contentHash:string;range?:Range;
  source?:{system:'student-ide';session:string;modelId:string;seq?:number}}
  | {kind:'run';attemptId:string;runId:string;snapshotId:string}
  | {kind:'resource';attemptId:string;resourceVersionId:string;paragraphId:string}
  | {kind:'project';attemptId:string;activityVersionId:string};
export type Attempt = {attemptId:string;courseId:string;studentId:string;assignmentId:string;activityVersionId:string;
  status:'ready'|'active'|'paused'|'submitted'|'reviewed';attemptRevision:number;workspaceRevision:number;
  decisionEpoch:number;captureRevision:number;collecting:boolean;reminders:boolean;
  route?:string;question?:string;returnPosition?:ObjectRef};
export type ProjectFile = {fileId:string;attemptId:string;path:string;documentVersion:number;contentHash:string;
  text:string;lifecycle:'active'|'recycled'};
// Internal edit representation uses the already approved UTF-16 range; HTTP/UI adapters remain A/UI-owned.
export type TextChange = {range:Range;text:string};
export type FileOperation = {kind:'create';clientFileKey:string;path:string;text:string}
  | {kind:'update';fileId:string;baseVersion:number;text?:string;changes?:TextChange[]}
  | {kind:'recycle'|'restore';fileId:string;baseVersion:number};
export type SyncBatch = {expectedWorkspaceRevision:number;clientId:string;clientSeq:number;operations:FileOperation[];
  process?:{captureRevision:number}};
export type ArtifactSnapshot = Snapshot & {attemptId:string;activityVersionId:string;workspaceRevision:number;createdAt:string};

// C4 fixed artifact submission. It freezes one already confirmed snapshot together with the student's own short
// reflection and the trusted check references matching that exact snapshot. A submission never rewrites the
// artifact, the runs or the checks it points at, and it never requires the artifact to be correct.
export type SubmissionCheckRef = {runId:string;snapshotId:string;resultHash?:string;verdict?:string};
export type Submission = {submissionId:string;attemptId:string;courseId:string;studentId:string;assignmentId:string;
  activityVersionId:string;snapshotId:string;snapshotHash:string;workspaceRevision:number;attemptRevision:number;
  decisionEpoch:number;recoveryGeneration:string;receiptId:string;submittedAt:string;
  reflection?:string;checkRefs:SubmissionCheckRef[]};
// C4 reopen permission. A saves it through C's same-transaction capability on the latest submission only; saving it
// keeps the attempt `reviewed`. Only the student's own explicit resume_revision consumes it, so the system never
// continues revising on the student's behalf.
export type ReopenGrantState = 'valid'|'consumed'|'superseded';
export type ReopenGrant = {grantId:string;attemptId:string;courseId:string;studentId:string;submissionId:string;
  attemptRevision:number;state:ReopenGrantState;reason:string;grantedBy:string;grantedAt:string;receiptId:string;
  consumedReceiptId?:string;consumedAt?:string};
// C4 recovery outcome classes. `unknown` is an executor-disconnect fact and is never folded into `confirmed`.
export type RecoveryRunOutcome = 'confirmed'|'incomplete'|'unknown'|'failed'|'cancelled'|'in_flight'|'stale'|'timed_out';
export type RecoveryRun = {runId:string;jobId:string;mode:'run'|'check';snapshotId:string;
  jobStatus:import('../records/index.ts').JobStatus;outcome:RecoveryRunOutcome};
// Formal feedback belongs to A5. C4 carries only what an attached A5 seam returns, so an unattached recovery view
// reports `unavailable` instead of reconstructing feedback text from hashes, digests or submission rows.
export type RecoveryFeedback = {status:'unavailable'}
  | {status:'available';feedbackRevision:number;
    entries:{feedbackId:string;kind:string;revision:number;submissionId?:string;createdAt:string}[]};
// The reopen permission as a resuming client acts on it. `state` is the most recently saved grant's own persisted
// state, so a `valid` row is never folded into `none`; `actionable` says whether the student's own resume_revision
// would be accepted right now. A grant whose revision an assignment pause moved, or which names an older
// submission, reports `valid` with `actionable:false` — granted but spent, which the student must be able to tell
// apart from never having been granted anything.
export type ReopenView = {state:'none'|ReopenGrantState;actionable:boolean;grantId?:string;submissionId?:string;
  reason?:string;grantedAt?:string;consumedAt?:string};
export type AttemptRecovery = {attempt:Attempt;recoveryGeneration:string;resyncRequired:boolean;
  files:{fileId:string;path:string;documentVersion:number;contentHash:string;lifecycle:'active'|'recycled'}[];
  latestSnapshotId?:string;
  submissions:{submissionId:string;snapshotId:string;snapshotHash:string;workspaceRevision:number;
    attemptRevision:number;serverSeq:number;submittedAt:string;hasReflection:boolean;
    checkRefs:SubmissionCheckRef[]}[];
  latestSubmissionId?:string;
  reopen:ReopenView;
  runs:RecoveryRun[];pendingQuestions:{jobId:string;jobStatus:import('../records/index.ts').JobStatus;
    acceptedAt:string;deadline:string}[];
  coverage?:import('../records/index.ts').TeachingCoverage;feedback:RecoveryFeedback};
