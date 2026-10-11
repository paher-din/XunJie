export type Scope = {courseId:string;studentId?:string;attemptId?:string;blueprintId?:string|null};
export type Purpose = 'teacher_design'|'student_help'|'reminder'|'explicit_analysis'|'passive_analysis'|'student_run'|'teacher_sample';
export type JobStatus = 'queued'|'running'|'succeeded'|'failed'|'cancelling'|'cancelled'|'stale'|'timed_out'|'outcome_unknown';
export type CommandIdentity = {actorId:string;command:string;target:string;scope:Scope;idempotencyKey:string;
  recoveryGeneration:string;sync?:{clientId:string;clientSeq:number}};
export type CommandReceipt<T=unknown> = {receiptId:string;commandId:string;identity:CommandIdentity;requestHash:string;
  result:T;serverSeq:number;committedAt:string};
export type AuditEvent = {eventId:string;serverSeq:number;scope:Scope;type:string;occurredAt:string;
  source:'student_command'|'trusted_service';payloadRef?:string};
export type Job = {jobId:string;kind:string;purpose:Purpose;scope:Scope;requestReceiptId:string;
  status:JobStatus;stopRequested:boolean;expectedRevision:number;decisionEpoch:number;
  recoveryGeneration:string;acceptedAt:string;deadline:string;attemptCount:number;
  leaseToken?:string;leaseUntil?:string;runId?:string;resultRef?:string;resultHash?:string;failure?:string};
export type Records = {receipts:CommandReceipt[];commandAliases:{identity:CommandIdentity;receiptId:string}[];
  events:AuditEvent[];jobs:Job[];serverSeq:number};

// C3 teaching records. Existing Scope/Purpose/JobStatus/ObjectRef meanings are unchanged; these add the
// message/action/delivery/receipt layer approved in TECH §4.1/§4.3/§7.3. `clientId` identifies the
// authenticated target page channel only and never proves who physically operated the browser.
export type TeachingAuthorKind = 'student'|'model';
export type ActionDisposition = 'pending'|'cancelled'|'stale'|'failed';
export type ReceiptKind = 'received'|'displayed'|'acknowledged'|'cancelled'|'stale'|'failed';
export type TeachingScopeRef = {courseId:string;studentId:string;attemptId:string};
// Trusted envelope: A/C construct it from the current transaction; B only produces `body`.
export type TeachingVersions = {activityVersionId:string;policyVersionId:string;modelConfigVersion:string;
  promptVersion:string;schemaVersion:string;analysisVersion?:string|undefined};
export type TeachingUsage =
  | {status:'actual';inputTokens:number;outputTokens:number}
  | {status:'unknown';reason?:string|undefined};
export type TeachingAttemptEpoch = {attemptRevision:number;decisionEpoch:number};
export type TeachingBasis = TeachingAttemptEpoch & {captureRevision:number;relatedStateRevision:number;
  objectRef?:import('../workspace/index.ts').ObjectRef;inputRefs:string[];assistanceRefs:string[];coverageRefs:string[]};
export type TeachingQuestionEnvelope = {kind:'student_question';question:string;
  objectRef?:import('../workspace/index.ts').ObjectRef;inputRefs:string[];versions:TeachingVersions};
export type TeachingMessageEnvelope = {kind:'student_help';body:unknown;
  versions:TeachingVersions;usage:TeachingUsage;calls:number;elapsedMs:number;basis:TeachingBasis};
export type TeachingMessage = {messageId:string;scope:TeachingScopeRef;jobId:string;requestReceiptId?:string;
  authorKind:TeachingAuthorKind;contentHash:string;resultHash?:string;envelope:TeachingQuestionEnvelope|TeachingMessageEnvelope};
export type TeachingAction = {actionId:string;scope:TeachingScopeRef;jobId:string;messageId:string;contentHash:string;
  disposition:ActionDisposition;targetVersions:TeachingVersions;basis:TeachingBasis;generation:string;
  stopReason?:string;causeRef?:string;basisRevised:boolean;createdAt:string};
export type TeachingDelivery = {deliveryId:string;actionId:string;recipientId:string;clientId:string;contentHash:string;
  recoveryGeneration:string;serverSeq:number;attemptedAt:string;control:TeachingAttemptEpoch & {captureRevision:number};
  eventId?:string};
export type TeachingActionReceipt = {receiptId:string;actionId:string;deliveryId?:string;contentHash:string;receiptKind:ReceiptKind;
  clientReceiptId:string;clientId:string;serverSeq:number;clientDeclaredAt?:string;serverReceivedAt:string;
  versions:TeachingVersions;raceReason?:string};
export type TeachingActionRecord = TeachingAction & {deliveries:TeachingDelivery[];receipts:TeachingActionReceipt[]};
// Synchronous, same-transaction stop seam supplied by C; a rejected or async handler rolls the caller's transaction back.
export type TeachingStopContext = {reason:string;causeRef?:string;generation:string;now:string};
export type TeachingStopResult = {stoppedJobIds:string[];invalidatedActionIds:string[];
  jobs:{jobId:string;status:JobStatus;stopRequested:boolean}[]};
export type TeachingCoverageInterval = {attemptId:string;captureRevision:number;state:'collecting'|'paused';
  fromServerSeq:number;from:string;to?:string;toServerSeq?:number;open:boolean;
  rejections:{receiptId:string;reason:string}[]};
export type TeachingCoverage = {attemptId:string;captureRevision:number;collecting:boolean;cutoffServerSeq:number;
  intervals:TeachingCoverageInterval[]};
export type TeachingControlState = {attemptRevision:number;decisionEpoch:number;captureRevision:number;
  collecting:boolean;reminders:boolean;generation:string;status:'ready'|'active'|'paused'|'submitted'|'reviewed'};
export type TeachingEventPayload = {actionId:string;contentHash:string;disposition:ActionDisposition;createdAt:string;
  basisRevised:boolean;actionType?:string;content?:string;rationale?:string;expectedStudentAction?:string;
  assistanceContext?:string;evidenceIds?:string[];resourceRefs?:string[];unresolved?:string[];deliveryId?:string};
export type TeachingEventView = {serverSeq:number;eventId:string;type:string;occurredAt:string;payload?:TeachingEventPayload};
export type TeachingEventsPage = {control:TeachingControlState;resyncRequired:boolean;events:TeachingEventView[];
  nextServerSeq:number;hasMore:boolean;coverage?:TeachingCoverage};
