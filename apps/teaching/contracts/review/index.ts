import { z } from 'zod';
export const id = z.string().min(1).max(256);
export const natural = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const positive = natural.min(1);
export const contextInput = z.strictObject({ recoveryGeneration: id,expectedContextRevision: natural,
  goals: z.string().max(16384),constraints: z.string().max(16384) });
export const contextSchema = z.strictObject({ courseId: id,studentId: id,contextRevision: natural,
  source: z.literal('self_report'),goals: z.string(),constraints: z.string() });
export type LearnerScope = { courseId: string;studentId: string;attemptId?: string };
export type LearnerContext = z.infer<typeof contextSchema>;
export const analysisVersionsSchema = z.strictObject({ modelConfigVersion: id,promptVersion: id,schemaVersion: id,analysisVersion: id });
export type AnalysisVersions = z.infer<typeof analysisVersionsSchema>;
export const evidenceRefSchema = z.discriminatedUnion('kind',[
  z.strictObject({kind: z.literal('snapshot'),id,attemptId: id}),
  z.strictObject({kind: z.literal('run'),id,attemptId: id}),
  z.strictObject({kind: z.literal('message'),id,attemptId: id}),
  z.strictObject({kind: z.literal('action'),id,attemptId: id}),
  z.strictObject({kind: z.literal('coverage'),id,attemptId: id,captureRevision: natural,fromServerSeq: natural}),
  z.strictObject({kind: z.literal('context'),id,revision: positive}),
  z.strictObject({kind: z.literal('claim'),id,revision: positive}),
  z.strictObject({kind: z.literal('teacher_decision'),id}),
  z.strictObject({kind: z.literal('resource'),id,resourceVersionId: id,paragraphId: id}),
]);
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;
export const applicabilitySchema = z.discriminatedUnion('kind',[
  z.strictObject({kind: z.literal('course')}),z.strictObject({kind: z.literal('activity'),activityVersionId: id}),
]);
export const claimTargetShape = {competencyId: id,competencyVersion: positive,domain: z.enum(['domain','project','ai_collaboration']),scope: applicabilitySchema};
export const claimBodySchema = z.strictObject({...claimTargetShape,claimId: id.optional(),statement: z.string().trim().min(1).max(16384),
  state: z.enum(['insufficient','supported_with_assistance','supported_in_check','conflicting']),
  evidenceIds: z.array(id).max(64),counterEvidenceIds: z.array(id).max(64),
  assistanceStatus: z.enum(['observed_help','none_observed_in_system','unknown']),unresolved: z.boolean(),unknown: z.array(z.string().min(1).max(512)).max(64)});
export const analysisBodySchema = z.strictObject({kind: z.literal('learner_analysis'),claims: z.array(claimBodySchema).max(64),
  feedbackDraft: z.string().max(16384).optional()});
export const claimSchema = z.strictObject({...claimBodySchema.shape,claimId: id,claimRevision: positive,courseId: id,studentId: id,
  validity: z.enum(['active','contested','superseded','withdrawn']),estimatorVersion: id,analysisVersion: id,
  source: z.enum(['model_candidate','teacher_judgment']),sourceId: id,refs: z.array(evidenceRefSchema),basisAtoms: z.array(z.string()),
  evidenceGroupIds: z.array(id)});
export type LearnerClaim = z.infer<typeof claimSchema>;
export type ClaimBody = z.infer<typeof claimBodySchema>;
export const blockedBasisSchema = z.strictObject({...claimTargetShape,atoms: z.array(z.string()),causeRef: id,
  validity: z.enum(['contested','withdrawn'])});
export const stateSchema = z.strictObject({courseId: id,studentId: id,learnerStateRevision: natural,
  claims: z.array(claimSchema),blockedBases: z.array(blockedBasisSchema)});
export type LearnerState = z.infer<typeof stateSchema>;
export const queueAnalysisInput = z.strictObject({recoveryGeneration: id,expectedAttemptRevision: positive,expectedStateRevision: natural,
  purpose: z.enum(['explicit_analysis','passive_analysis']),inputRefs: z.array(evidenceRefSchema).max(64),
  assistanceRefs: z.array(evidenceRefSchema).max(64),coverageRefs: z.array(evidenceRefSchema).max(64)});
export const analysisBindingSchema = z.strictObject({scope: z.strictObject({courseId: id,studentId: id,attemptId: id}),
  expectedStateRevision: natural,expectedAttemptRevision: positive,decisionEpoch: natural,contextRevision: natural,captureRevision: natural,
  activityVersionId: id,policyVersionId: id,collectionPurpose: z.enum(['explicit_analysis','passive_analysis']),
  versions: analysisVersionsSchema,inputRefs: z.array(evidenceRefSchema),assistanceRefs: z.array(evidenceRefSchema),coverageRefs: z.array(evidenceRefSchema)});
export type AnalysisBinding = z.infer<typeof analysisBindingSchema>;
export const queuedAnalysisSchema = z.strictObject({jobId: id,binding: analysisBindingSchema});
export const analysisResultSchema = z.strictObject({analysisId: id,jobId: id,disposition: z.enum(['accepted','rejected']),
  reason: id.optional(),learnerStateRevision: natural,claimIds: z.array(id),resultHash: z.string().regex(/^[a-f0-9]{64}$/)});
export type AnalysisResult = z.infer<typeof analysisResultSchema>;
export const analysisCompleteInput = z.strictObject({jobId: id,leaseToken: id,recoveryGeneration: id,bodyJson: z.string().max(262144).refine(value => value.isWellFormed())});
export const claimRefSchema = z.strictObject({kind: z.literal('claim'),id,revision: positive});
export const reviewInput = z.strictObject({recoveryGeneration: id,expectedStateRevision: natural,targetRef: claimRefSchema,
  decision: z.enum(['confirm','correct','defer']),reason: z.string().trim().min(1).max(512),
  evidenceRefs: z.array(evidenceRefSchema).max(64),replacement: claimBodySchema.optional()});
export const disputeInput = z.strictObject({recoveryGeneration: id,expectedStateRevision: natural.optional(),
  targetRef: z.discriminatedUnion('kind',[claimRefSchema,z.strictObject({kind: z.literal('feedback'),id,revision: positive})]),
  reason: z.string().trim().min(1).max(512)});

export const decisionSchema = z.strictObject({decisionId: id,courseId: id,studentId: id,attemptId: id,teacherId: id,
  expectedStateRevision: natural,learnerStateRevision: positive,targetRef: claimRefSchema,decision: z.enum(['confirm','correct','defer']),
  reason: z.string().min(1).max(512),evidenceRefs: z.array(evidenceRefSchema),replacementClaimId: id.optional(),createdAt: id});
export const reviewResultSchema = z.strictObject({decisionId: id,learnerStateRevision: positive,stoppedJobIds: z.array(id),affectedAttemptIds: z.array(id)});
export type TeacherDecision = z.infer<typeof decisionSchema>;
export const disputeSchema = z.strictObject({disputeId: id,courseId: id,studentId: id,attemptId: id,targetRef: disputeInput.shape.targetRef,
  reason: z.string().min(1).max(512),currentTarget: z.boolean(),learnerStateRevision: natural,createdAt: id});
export const disputeResultSchema = z.strictObject({disputeId: id,currentTarget: z.boolean(),learnerStateRevision: natural,
  stoppedJobIds: z.array(id),affectedAttemptIds: z.array(id)});
export const projectedClaimSchema = claimSchema.extend({basisAvailable: z.boolean(),
  references: z.array(z.strictObject({ref: evidenceRefSchema,status: z.enum(['available','unavailable'])}))});
export const contextResultSchema = contextSchema.extend({stoppedJobIds: z.array(id),affectedAttemptIds: z.array(id)});
