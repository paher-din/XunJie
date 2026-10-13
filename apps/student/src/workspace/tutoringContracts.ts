import type { AttemptView } from './workspaceContracts'
import type { JobStatus } from './runContracts'

// C3 application.ts public projections only. No inferred Job/ObjectRef association.
export interface TutorControl extends Pick<AttemptView, 'status' | 'attemptRevision' | 'decisionEpoch' | 'captureRevision' | 'collecting' | 'reminders'> { generation: string }
export type TutorReceiptKind = 'received' | 'displayed' | 'acknowledged'
export interface TutorPayload extends Partial<TutorSource> {
  actionId: string; contentHash: string; disposition: 'pending' | 'cancelled' | 'stale' | 'failed'
  createdAt: string; basisRevised: boolean; deliveryId?: string
  actionType?: string; content?: string; rationale?: string; expectedStudentAction?: string
  assistanceContext?: string; evidenceIds?: string[]; resourceRefs?: string[]; unresolved?: string[]
}
export interface TutorPage { control: TutorControl; resyncRequired: boolean
  events: Array<{ serverSeq: number; eventId: string; type: string; occurredAt: string; payload?: TutorPayload }>
  nextServerSeq: number; hasMore: boolean; coverage?: TutorCoverage }
export interface TutorCoverage { attemptId:string;captureRevision:number;collecting:boolean;cutoffServerSeq:number
  intervals:Array<{attemptId:string;captureRevision:number;state:'collecting'|'paused';fromServerSeq:number;from:string
    to?:string;toServerSeq?:number;open:boolean;rejections:Array<{receiptId:string;reason:string}>}> }
export interface TutorJob { jobId: string; status: JobStatus; stopRequested: boolean; decisionEpoch: number
  recoveryGeneration: string; scope: { courseId: string; studentId?: string; attemptId?: string }
  purpose: 'student_help'; acceptedAt: string; deadline: string; failure?: string }
export interface TutorObject { kind: string; attemptId: string; [key: string]: unknown }

// Existing C3 teaching-records student projection. These are historical facts, not event candidates.
export interface TutorVersions { activityVersionId:string;policyVersionId:string;modelConfigVersion:string
  promptVersion:string;schemaVersion:string;analysisVersion?:string }
export interface TutorHistoryScope { courseId:string;studentId:string;attemptId:string }
export interface TutorBasis { attemptRevision:number;decisionEpoch:number;captureRevision:number;relatedStateRevision:number
  objectRef?:TutorObject;inputRefs:string[];assistanceRefs:string[];coverageRefs:string[] }
// C3 authorized event body association. The original basis is immutable provenance, not the current head.
export interface TutorSource { scope:TutorHistoryScope;jobId:string;messageId:string;generation:string;targetVersions:TutorVersions
  basis:Pick<TutorBasis,'attemptRevision'|'decisionEpoch'|'captureRevision'|'relatedStateRevision'|'objectRef'> }
export interface TutorHistoryBody { kind:'student_help';actionType:string;content:string;rationale:string
  expectedStudentAction:string;evidenceIds:string[];resourceRefs:string[];assistanceContext:string;unresolved:string[]
  policyChecks:{containsWholeSolution:false;writesStudentWork:false;runsCode:false;makesFormalEvaluation:false} }
interface TutorHistoryMessageBase { messageId:string;scope:TutorHistoryScope;jobId:string;requestReceiptId?:string
  contentHash:string;resultHash?:string }
export interface TutorHistoryQuestion extends TutorHistoryMessageBase { authorKind:'student'
  envelope:{kind:'student_question';question:string;objectRef?:TutorObject;inputRefs:string[];versions:TutorVersions} }
export interface TutorHistoryReply extends TutorHistoryMessageBase { authorKind:'model'
  envelope:{kind:'student_help';body:TutorHistoryBody;bodyJsonText?:string;versions:TutorVersions
    usage:{status:'actual';inputTokens:number;outputTokens:number}|{status:'unknown';reason?:string}
    calls:number;elapsedMs:number;basis:TutorBasis} }
export interface TutorHistoryDelivery { deliveryId:string;actionId:string;recipientId:string;clientId:string
  contentHash:string;recoveryGeneration:string;serverSeq:number;attemptedAt:string
  control:{attemptRevision:number;decisionEpoch:number;captureRevision:number};eventId?:string }
export interface TutorHistoryReceipt { receiptId:string;actionId:string;deliveryId?:string;contentHash:string
  receiptKind:TutorReceiptKind|'cancelled'|'stale'|'failed';clientReceiptId:string;clientId:string;serverSeq:number
  clientDeclaredAt?:string;serverReceivedAt:string;versions:TutorVersions;raceReason?:string }
export interface TutorHistoryAction { actionId:string;scope:TutorHistoryScope;jobId:string;messageId:string;contentHash:string
  disposition:TutorPayload['disposition'];targetVersions:TutorVersions;basis:TutorBasis;generation:string
  stopReason?:string;causeRef?:string;basisRevised:boolean;createdAt:string
  deliveries:TutorHistoryDelivery[];receipts:TutorHistoryReceipt[] }
export interface TutorHistoryEntry { action:TutorHistoryAction;message:TutorHistoryReply;question?:TutorHistoryQuestion }
export interface TutorHistory { questions:TutorHistoryQuestion[];entries:TutorHistoryEntry[] }
export interface TutorHistoryState { phase:'loading'|'ready'|'unavailable';data:TutorHistory;notice:string|null }
