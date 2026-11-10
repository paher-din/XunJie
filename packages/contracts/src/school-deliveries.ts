import { z } from 'zod';
import { workFilesSchema } from './learning-data.js';
import { teachingArtifactPayloadSchema } from './teaching-artifacts.js';
import { executionRetainedResourceSchema } from './execution.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
function utf8Bytes(text: string) {
  let size = 0;
  for (const character of text) {
    const point = character.codePointAt(0)!;
    size += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return size;
}
export const schoolDeliveryScopeSchema = z.object({ environmentId: z.uuid(), spaceId: z.uuid(),
  principalId: z.uuid(), activityId: z.uuid() }).strict();
export const schoolDeliveryCourseSchema = z.object({ courseId: z.uuid(), taskId: z.uuid(),
  releaseId: z.uuid(), contentDigest: digest }).strict();
export const schoolAcquisitionInputSchema = z.object({ requestId: z.uuid(), releaseId: z.uuid(), contentDigest: digest }).strict();
export type SchoolAcquisitionInput = z.infer<typeof schoolAcquisitionInputSchema>;
const receiptFields = { version: z.literal(1), state: z.literal('accepted'), requestId: z.uuid(),
  scope: schoolDeliveryScopeSchema, course: schoolDeliveryCourseSchema, receivedAt: z.iso.datetime() };
export const schoolAcquisitionReceiptSchema = z.object(receiptFields).strict();
export type SchoolAcquisitionReceipt = z.infer<typeof schoolAcquisitionReceiptSchema>;

/** Selected originals only. This is a student delivery, never an execution command or a verified experiment claim. */
export const schoolSubmissionEvidenceSchema = z.object({ requestId: z.uuid(), executionRef: z.uuid(),
  mediaType: z.string().min(1).max(200), text: z.string().max(8000000),
  resources: z.array(executionRetainedResourceSchema).max(4).optional() }).strict()
  .refine(value => new Set(value.resources?.map(resource => resource.contentId)).size === (value.resources?.length ?? 0),
    'Resource identities must be unique');
export const schoolSubmissionArtifactSchema = z.object({ artifactId: z.uuid(), revisionId: z.uuid(),
  payload: teachingArtifactPayloadSchema }).strict();
const submissionFields = { works: workFilesSchema,
  artifacts: z.array(schoolSubmissionArtifactSchema).max(16).default([]),
  evidence: z.array(schoolSubmissionEvidenceSchema).max(8).default([]) };
export const schoolSubmissionInputSchema = z.object({ requestId: z.uuid(), ...submissionFields }).strict()
  .refine(value => value.works.length + value.artifacts.length + value.evidence.length > 0, 'Select at least one work or result')
  .refine(value => utf8Bytes(JSON.stringify(value)) <= 24 * 1024 * 1024,
    'Submission exceeds the supported transport envelope')
  .refine(value => new Set(value.artifacts.map(artifact => artifact.artifactId)).size === value.artifacts.length
    && new Set(value.artifacts.map(artifact => artifact.revisionId)).size === value.artifacts.length
    && new Set(value.evidence.map(evidence => evidence.requestId)).size === value.evidence.length
    && new Set(value.evidence.map(evidence => evidence.executionRef)).size === value.evidence.length,
  'Artifact and evidence identities must be unique');
export type SchoolSubmissionInput = z.infer<typeof schoolSubmissionInputSchema>;
export const schoolSubmissionReceiptSchema = z.object({ ...receiptFields, submissionId: z.uuid(), contentDigest: digest }).strict();
export type SchoolSubmissionReceipt = z.infer<typeof schoolSubmissionReceiptSchema>;
export const schoolSubmissionSchema = schoolSubmissionReceiptSchema.extend(submissionFields);
export type SchoolSubmission = z.infer<typeof schoolSubmissionSchema>;
export const schoolSubmissionListSchema = z.object({ submissions: z.array(schoolSubmissionReceiptSchema) }).strict();
export type SchoolSubmissionList = z.infer<typeof schoolSubmissionListSchema>;
