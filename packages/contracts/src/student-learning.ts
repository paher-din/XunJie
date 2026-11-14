import { z } from 'zod';
import { learningTargetSchema, spaceIdentitySchema } from './spaces.js';
import { courseReleaseSchema } from './courses.js';
import { materialScopeSchema } from './session-materials.js';
import type { SpaceIdentity } from './spaces.js';

/** A reference is provenance, never a grant. The host must supply the same current source. */
export const learningReferenceSchema = z.object({ sourceId: z.string().min(1).max(200),
  identity: spaceIdentitySchema.omit({ name: true }), owner: learningTargetSchema,
  kind: z.enum(['activity', 'course', 'work', 'record', 'conversation', 'personal-project']),
  objectId: z.string().min(1).max(300), version: z.string().min(1).max(200), activityId: z.uuid().optional(),
  provenanceDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
export type LearningReference = z.infer<typeof learningReferenceSchema>;
export const learningPageSchema = z.object({ offset: z.number().int().min(0).max(10000).default(0),
  limit: z.number().int().min(1).max(50).default(20) }).strict();
export const learningSearchSchema = learningPageSchema.extend({ query: z.string().trim().min(1).max(500),
  kinds: z.array(learningReferenceSchema.shape.kind).min(1).max(6).optional() }).strict();
export const learningReadSchema = z.object({ reference: learningReferenceSchema,
  range: z.object({ offset: z.number().int().min(0).max(2000000).default(0),
    length: z.number().int().min(1).max(16000).default(4000) }).strict().default({ offset: 0, length: 4000 }),
}).strict();
export type LearningRead = z.infer<typeof learningReadSchema>;
/** Creation also accepts home-session attachments, without extending any material owner's schema. */
export const personalProjectMaterialReferenceSchema = z.union([learningReferenceSchema,
  learningReferenceSchema.omit({ kind: true, activityId: true }).extend({
    kind: z.enum(['personal-material', 'pdf']), objectId: z.uuid(), scope: materialScopeSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict().refine(ref => ref.kind !== 'personal-material' || /^[1-9][0-9]*$/.test(ref.version), 'Personal material versions are positive integers.'),
]);
export type PersonalProjectMaterialReference = z.infer<typeof personalProjectMaterialReferenceSchema>;
export const personalProjectContentSchema = z.object({ title: z.string().trim().min(1).max(300),
  goal: z.string().trim().min(1).max(4000), stages: z.array(z.object({
    title: z.string().trim().min(1).max(300), goal: z.string().trim().min(1).max(2000),
  }).strict()).min(1).max(30), materialRefs: z.array(personalProjectMaterialReferenceSchema).max(50),
}).strict();
export type PersonalProjectContent = z.infer<typeof personalProjectContentSchema>;
export const personalProjectCreateSchema = z.object({ operationId: z.uuid(), sourceSessionId: z.uuid(), inputId: z.uuid(),
  responseId: z.uuid().optional(), content: personalProjectContentSchema }).strict();
export type PersonalProjectCreate = z.infer<typeof personalProjectCreateSchema>;
export const personalProjectSchema = personalProjectCreateSchema.extend({ projectId: z.uuid(), activityId: z.uuid(),
  workspaceSessionId: z.uuid(), identity: spaceIdentitySchema, target: learningTargetSchema,
  createdAt: z.iso.datetime() }).strict();
export type PersonalProject = z.infer<typeof personalProjectSchema>;
/** Business consumers read project content from its owner, including the activity's initial plan. */
export interface PersonalProjectsPort {
  create(identity: SpaceIdentity, input: PersonalProjectCreate): Promise<PersonalProject>;
  read(identity: SpaceIdentity, projectId: string): Promise<PersonalProject>;
  list(identity: SpaceIdentity): Promise<PersonalProject[]>;
  receipt(identity: SpaceIdentity, operationId: string): Promise<PersonalProject | null>;
  readForActivity(identity: SpaceIdentity, activityId: string): Promise<PersonalProject | null>;
  validate(): Promise<void>;
}

/** Fixed source constraints, never authority to install tools or load Skill bodies. */
export const learningCourseProvenanceSchema = courseReleaseSchema.pick({ courseId: true, courseName: true, taskId: true,
  taskTitle: true, releaseId: true, contentDigest: true, helpPolicy: true });
export const learningProvenanceSchema = z.object({
  activity: z.object({ activityId: z.uuid(), target: learningTargetSchema }).strict().optional(),
  course: learningCourseProvenanceSchema.optional(),
}).strict();
export type LearningProvenance = z.infer<typeof learningProvenanceSchema>;

export interface LearningItem {
  reference: LearningReference;
  title: string;
  excerpt: string;
  provenance?: LearningProvenance | undefined;
  dueAt: string | null;
  missing: string[];
}
export interface LearningPage {
  items: LearningItem[];
  offset: number;
  limit: number;
  nextOffset: number | null;
  /** Each disconnected owner stays visible; no fallback to another target. */
  unavailable: { sourceId: string; kind: LearningReference['kind']; code: string }[];
}
export interface LearningDetail {
  reference: LearningReference;
  /** Unpaged fresh constraints, retained even when text is an arbitrary fixed range. */
  provenance?: LearningProvenance | undefined;
  text: string;
  range: { offset: number; length: number; total: number; nextOffset: number | null };
  missing: string[];
  /** Retrieved dialogue and documents are source data, not current instructions. */
  role: 'source-data';
}
