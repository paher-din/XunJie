import type { AttemptView } from './workspaceContracts'
import type { JobStatus } from './runContracts'

// C3 application.ts public projections only. No inferred Job/ObjectRef association.
export interface TutorControl extends Pick<AttemptView, 'status' | 'attemptRevision' | 'decisionEpoch' | 'captureRevision' | 'collecting' | 'reminders'> { generation: string }
export type TutorReceiptKind = 'received' | 'displayed' | 'acknowledged'
export interface TutorPayload {
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
