import { z } from 'zod';

/** Transported files are inert values, never filesystem entries or executable capabilities. */
export const teachingSkillLimits = { skills: 32, versions: 16, files: 64,
  fileBytes: 524288, packageBytes: 2097152, bodyBytes: 262144, selections: 32 } as const;
export const teachingSkillPathSchema = z.string().min(1).max(240).refine(path =>
  !/^[\/~]/.test(path) && !/[\\%:\x00-\x1f\x7f]/.test(path) && path.normalize('NFC') === path,
  'Expected a canonical relative package path').refine(path =>
  !path.split('/').some(part => !part || part === '.' || part === '..' || part.trim() !== part || part.endsWith('.')
    || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)),
  'Non-canonical package path');
export const teachingSkillFileSchema = z.object({ path: teachingSkillPathSchema,
  encoding: z.enum(['utf8', 'base64']), mediaType: z.string().min(1).max(200).optional(),
  content: z.string().max(700000),
}).strict();
export const teachingSkillReferenceSchema = z.object({ skillId: z.uuid(), version: z.number().int().positive() }).strict();
export type TeachingSkillReference = z.infer<typeof teachingSkillReferenceSchema>;
export const teachingSkillReferencesSchema = z.array(teachingSkillReferenceSchema).max(teachingSkillLimits.selections)
  .refine(items => new Set(items.map(item => item.skillId)).size === items.length, 'Duplicate skill selection');
export const teachingSkillImportSchema = z.object({ requestId: z.uuid(), skillId: z.uuid().optional(),
  source: z.string().min(1).max(2000), packageVersion: z.string().trim().min(1).max(100),
  files: z.array(teachingSkillFileSchema).min(1).max(teachingSkillLimits.files),
}).strict().refine(input => new Set(input.files.map(file => file.path.toLowerCase())).size === input.files.length,
  'Duplicate package path');
export type TeachingSkillImport = z.infer<typeof teachingSkillImportSchema>;
export const teachingSkillMetadataSchema = z.object({ name: z.string().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().min(1).max(1024), compatibility: z.string().max(500).optional(),
  license: z.string().max(1000).optional(), metadata: z.record(z.string().max(100), z.string().max(2000)).optional(),
  dependencies: z.array(z.string().min(1).max(200)).max(32).default([]),
  conflicts: z.array(z.string().min(1).max(200)).max(32).default([]),
  'allowed-tools': z.array(z.string().min(1).max(200)).max(64).default([]),
}).strict();
export type TeachingSkillMetadata = z.infer<typeof teachingSkillMetadataSchema>;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const teachingSkillAttachmentSchema = z.object({ path: teachingSkillPathSchema,
  encoding: z.enum(['utf8', 'base64']), mediaType: z.string(), byteLength: z.number().int().nonnegative(), digest,
}).strict();
export const teachingSkillVersionSchema = teachingSkillReferenceSchema.extend({ source: z.string().min(1).max(2000),
  packageVersion: z.string().min(1).max(100), metadata: teachingSkillMetadataSchema,
  digest, files: z.array(teachingSkillFileSchema).min(1).max(teachingSkillLimits.files),
  attachments: z.array(teachingSkillAttachmentSchema).min(1).max(teachingSkillLimits.files),
}).strict();
export type TeachingSkillVersion = z.infer<typeof teachingSkillVersionSchema>;
/** Course owner fixes these exact bytes inside the immutable release and activity binding. */
export const courseSkillPackageSchema = teachingSkillReferenceSchema.extend({ source: z.string().min(1).max(2000),
  packageVersion: z.string().min(1).max(100), files: z.array(teachingSkillFileSchema).min(1).max(teachingSkillLimits.files),
  required: z.boolean().default(false),
}).strict();
export type CourseSkillPackage = z.infer<typeof courseSkillPackageSchema>;
export const courseSkillPackagesSchema = z.array(courseSkillPackageSchema).max(teachingSkillLimits.selections)
  .refine(items => new Set(items.map(item => item.skillId)).size === items.length, 'Duplicate course skill');
export const teachingSkillRangeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }).strict(), z.object({ kind: z.literal('self-study') }).strict(),
  z.object({ kind: z.literal('course'), courseId: z.uuid() }).strict(),
  z.object({ kind: z.literal('activity'), activityId: z.uuid() }).strict(),
]);
export type TeachingSkillRange = z.infer<typeof teachingSkillRangeSchema>;
export const teachingSkillSelectSchema = z.object({ requestId: z.uuid(), range: teachingSkillRangeSchema,
  skills: teachingSkillReferencesSchema }).strict();
export const teachingSkillDisableSchema = z.object({ requestId: z.uuid(), skillId: z.uuid(), disabled: z.boolean() }).strict();
export const teachingSkillUnavailableSchema = z.object({ reason: z.enum(['disabled', 'not-selected', 'skill-missing',
  'version-missing', 'dependency-missing', 'dependency-unavailable', 'conflict', 'compatibility-unsupported',
  'tool-unavailable', 'owner-unavailable', 'invalid-package']), detail: z.string().max(4000) }).strict();
export type TeachingSkillUnavailable = z.infer<typeof teachingSkillUnavailableSchema>;
export const teachingSkillCatalogEntrySchema = teachingSkillReferenceSchema.extend({
  name: z.string(), description: z.string(), source: z.string(), packageVersion: z.string(), digest, metadata: teachingSkillMetadataSchema,
  attachments: z.array(teachingSkillAttachmentSchema), origin: z.enum(['personal', 'course']),
  selected: z.boolean(), disabled: z.boolean(), required: z.boolean().default(false), unavailable: teachingSkillUnavailableSchema.optional(),
}).strict();
export type TeachingSkillCatalogEntry = z.infer<typeof teachingSkillCatalogEntrySchema>;
export const teachingSkillListSchema = z.object({ skills: z.array(teachingSkillCatalogEntrySchema),
  selections: z.array(teachingSkillSelectSchema.omit({ requestId: true })).max(64) }).strict();
/** Freeze this value in the run snapshot. Replay consumes it without calling the current owner. */
export const teachingSkillLoadedSchema = teachingSkillReferenceSchema.extend({ source: z.string(), packageVersion: z.string(),
  packageDigest: digest, path: teachingSkillPathSchema, encoding: z.enum(['utf8', 'base64']), mediaType: z.string(),
  byteLength: z.number().int().nonnegative(), digest, originalDigest: digest, content: z.string(),
  offset: z.number().int().nonnegative(), totalByteLength: z.number().int().nonnegative(), complete: z.boolean(),
}).strict();
export type TeachingSkillLoaded = z.infer<typeof teachingSkillLoadedSchema>;
export const teachingSkillLoadSchema = teachingSkillReferenceSchema.extend({ runId: z.uuid(), stepId: z.uuid(), commandId: z.uuid(),
  path: teachingSkillPathSchema.default('SKILL.md'), offset: z.number().int().nonnegative().default(0),
  length: z.number().int().positive().max(6000).default(6000),
}).strict();
export type TeachingSkillLoad = z.input<typeof teachingSkillLoadSchema>;
export const teachingSkillStateSchema = z.object({ catalog: z.array(teachingSkillCatalogEntrySchema).max(1024),
  loaded: z.array(teachingSkillLoadedSchema).max(128) }).strict();
export type TeachingSkillState = z.infer<typeof teachingSkillStateSchema>;
