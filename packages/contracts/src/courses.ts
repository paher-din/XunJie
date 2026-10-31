import { z } from 'zod';
import type { LearningTarget, SpaceIdentity } from './spaces.js';

/** Course owner wire. Student projections never contain teacher-private material or storage locators. */
export const courseDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const courseMaterialSchema = z.object({
  materialId: z.uuid(), title: z.string().min(1).max(300), mediaType: z.string().min(1).max(200),
  byteLength: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), sha256: courseDigestSchema,
}).strict();
export type CourseMaterial = z.infer<typeof courseMaterialSchema>;

export const courseStarterWorkSchema = z.object({
  workId: z.uuid(), title: z.string().min(1).max(300), description: z.string().max(4000),
  materialId: z.uuid().nullable(),
}).strict();
export type CourseStarterWork = z.infer<typeof courseStarterWorkSchema>;

export const courseCapabilitySchema = z.object({
  kind: z.enum(['component', 'executor']), objectId: z.uuid(), version: z.number().int().positive(),
}).strict();
export type CourseCapability = z.infer<typeof courseCapabilitySchema>;

const objectivesSchema = z.array(z.string().min(1).max(500)).min(1).max(20);
const requirementsSchema = z.string().min(1).max(20000);
const starterWorksSchema = z.array(courseStarterWorkSchema).max(50);
const capabilitiesSchema = z.array(courseCapabilitySchema).max(50);

/** A release is immutable; a changed registration needs a new releaseId. */
export const courseReleaseSchema = z.object({
  formatVersion: z.literal(1), courseId: z.uuid(), taskId: z.uuid(), releaseId: z.uuid(),
  contentDigest: courseDigestSchema, objectives: objectivesSchema, requirements: requirementsSchema,
  materials: z.array(courseMaterialSchema).max(100), starterWorks: starterWorksSchema,
  capabilities: capabilitiesSchema, publishedAt: z.string(), courseName: z.string().min(1).max(200),
  taskTitle: z.string().min(1).max(300),
}).strict();
export type CourseRelease = z.infer<typeof courseReleaseSchema>;

export const courseReleaseSummarySchema = z.object({
  releaseId: z.uuid(), contentDigest: courseDigestSchema, objectives: z.array(z.string().min(1).max(500)),
  publishedAt: z.string(),
}).strict();
export type CourseReleaseSummary = z.infer<typeof courseReleaseSummarySchema>;

export const courseTaskSchema = z.object({
  taskId: z.uuid(), title: z.string().min(1).max(300), summary: z.string().max(4000),
  releases: z.array(courseReleaseSummarySchema),
}).strict();
export type CourseTask = z.infer<typeof courseTaskSchema>;

export const courseSchema = z.object({
  courseId: z.uuid(), name: z.string().min(1).max(200), tasks: z.array(courseTaskSchema),
}).strict();
export type Course = z.infer<typeof courseSchema>;

export const courseCatalogSchema = z.object({ courses: z.array(courseSchema) }).strict();
export type CourseCatalog = z.infer<typeof courseCatalogSchema>;

export const courseMaterialContentSchema = z.object({
  materialId: z.uuid(), title: z.string().min(1).max(300), mediaType: z.string().min(1).max(200),
  byteLength: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), sha256: courseDigestSchema,
  contentBase64: z.string(),
}).strict();
export type CourseMaterialContent = z.infer<typeof courseMaterialContentSchema>;

const safeResourcePath = z.string().min(1).max(300).refine(value =>
  !value.startsWith('/') && !value.includes('\\') && !value.split('/').some(part => part === '' || part === '.' || part === '..'),
{ message: 'resource paths are relative, normalized and confined to the import root' });

/** Supported import format. Resource bytes travel separately and are verified before publication. */
export const courseImportMaterialSchema = z.object({
  materialId: z.uuid(), title: z.string().min(1).max(300), path: safeResourcePath,
  mediaType: z.string().min(1).max(200), access: z.enum(['student', 'private']),
  sha256: courseDigestSchema, byteLength: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
export const courseImportResourceSchema = z.object({
  path: safeResourcePath, contentBase64: z.string().max(64 * 1024 * 1024),
}).strict();
export const courseImportSchema = z.object({
  formatVersion: z.literal(1), requestId: z.uuid(),
  course: z.object({ courseId: z.uuid(), name: z.string().min(1).max(200) }).strict(),
  task: z.object({ taskId: z.uuid(), title: z.string().min(1).max(300), summary: z.string().max(4000) }).strict(),
  release: z.object({
    releaseId: z.uuid(), objectives: objectivesSchema, requirements: requirementsSchema,
    materials: z.array(courseImportMaterialSchema).max(100), starterWorks: starterWorksSchema,
    capabilities: capabilitiesSchema,
  }).strict(),
  resources: z.array(courseImportResourceSchema).max(100),
}).strict();
export type CourseImport = z.infer<typeof courseImportSchema>;

export const courseRegistrationResultSchema = z.object({
  kind: z.literal('course-release'), requestId: z.uuid(), courseId: z.uuid(), taskId: z.uuid(),
  releaseId: z.uuid(), contentDigest: courseDigestSchema, publishedAt: z.string(),
  materials: z.array(courseMaterialSchema.extend({ access: z.enum(['student', 'private']) })).max(100),
}).strict();
export type CourseRegistrationResult = z.infer<typeof courseRegistrationResultSchema>;

export const courseAccessInputSchema = z.object({
  requestId: z.uuid(), courseId: z.uuid(), principalId: z.uuid(), active: z.boolean(),
}).strict();
export type CourseAccessInput = z.infer<typeof courseAccessInputSchema>;

export const createCourseActivitySchema = z.object({ requestId: z.uuid(), releaseId: z.uuid() }).strict();
export type CreateCourseActivity = z.infer<typeof createCourseActivitySchema>;

/** Fixed evidence stored on the activity: task, release and student-open material basis. */
export const courseActivityBindingSchema = z.object({
  associationId: z.uuid(), courseId: z.uuid(), courseName: z.string().min(1).max(200),
  taskId: z.uuid(), taskTitle: z.string().min(1).max(300), releaseId: z.uuid(), contentDigest: courseDigestSchema,
  objectives: objectivesSchema, requirements: requirementsSchema, materials: z.array(courseMaterialSchema).max(100),
  starterWorks: starterWorksSchema, capabilities: capabilitiesSchema,
}).strict();
export type CourseActivityBinding = z.infer<typeof courseActivityBindingSchema>;

export const courseBindingStateSchema = z.object({
  associationId: z.uuid(), state: z.enum(['prepared', 'accepted', 'rejected']),
  binding: courseActivityBindingSchema.nullable(), error: z.string().nullable(),
}).strict();
export type CourseBindingState = z.infer<typeof courseBindingStateSchema>;

export interface CoursePrepareInput {
  associationId: string; requestId: string; identity: SpaceIdentity; target: LearningTarget;
  activityId: string; releaseId: string; inputDigest: string;
}
export interface CourseConfirmInput { associationId: string; requestId: string; inputDigest: string; }
export interface CourseBindingPointer { associationId: string; releaseId: string; contentDigest: string; }
export const courseReferenceTextSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('course-material'), courseId: z.uuid(), taskId: z.uuid(), releaseId: z.uuid(),
    contentDigest: courseDigestSchema, materialId: z.uuid(), materialSha256: courseDigestSchema,
    mediaType: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal('course-field'), courseId: z.uuid(), taskId: z.uuid(), releaseId: z.uuid(),
    contentDigest: courseDigestSchema, field: z.enum(['requirements']) }).strict(),
]);
export type CourseReferenceTextSource = z.infer<typeof courseReferenceTextSourceSchema>;
export const courseReferenceVerificationSchema = z.object({ source: courseReferenceTextSourceSchema,
  range: z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive() }).strict()
    .refine(range => range.end > range.start && range.end - range.start <= 1_000_000),
  // SHA-256 of the selected UTF-16LE code units; not the stored UTF-8 copyDigest.
  selectionDigest: courseDigestSchema,
}).strict();
export type CourseReferenceVerification = z.infer<typeof courseReferenceVerificationSchema>;
/** Verify the exact selection at its source owner without transporting the full material. */
export interface CourseReferenceAuthority {
  verifyReference(identity: SpaceIdentity, reference: CourseReferenceVerification): Promise<void>;
}
/** The learning-data owner consumes only this narrow, current-authority interface. */
export interface CourseBindingAuthority extends CourseReferenceAuthority {
  prepare(input: CoursePrepareInput): Promise<CourseBindingState>;
  confirm(input: CourseConfirmInput): Promise<CourseBindingState>;
  authorize(identity: SpaceIdentity, pointer: CourseBindingPointer): Promise<void>;
}
