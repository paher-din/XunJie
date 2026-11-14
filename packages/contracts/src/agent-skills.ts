import { z } from 'zod';
import type { SpaceIdentity } from './spaces.js';

/** Transported files are inert values, never filesystem entries or executable capabilities. */
export const teachingSkillLimits = { skills: 32, versions: 16, files: 4096,
  fileBytes: 32 * 1024 * 1024, packageBytes: 64 * 1024 * 1024,
  bodyBytes: 4 * 1024 * 1024, nameChars: 64, descriptionChars: 4096,
  selections: 32, importTimeoutMs: 300000, githubReadTimeoutMs: 300000 } as const;
// A UTF-8 byte may become a six-character JSON escape. Reserve file metadata as well,
// so a valid package is not rejected by an unrelated HTTP or Base64 string ceiling.
export const teachingSkillTransportBytes = teachingSkillLimits.packageBytes * 6 + teachingSkillLimits.files * 4096 + 65536;
export const teachingSkillContentChars = Math.ceil(teachingSkillLimits.fileBytes / 3) * 4;
export const teachingSkillPathSchema = z.string().min(1).max(240).refine(path =>
  !/^[\/~]/.test(path) && !/[\\%:\x00-\x1f\x7f]/.test(path) && path.normalize('NFC') === path,
  'Expected a canonical relative package path').refine(path =>
  !path.split('/').some(part => !part || part === '.' || part === '..' || part.trim() !== part || part.endsWith('.')
    || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)),
  'Non-canonical package path');
export const teachingSkillFileSchema = z.object({ path: teachingSkillPathSchema,
  encoding: z.enum(['utf8', 'base64']), mediaType: z.string().min(1).max(200).optional(),
  content: z.string().max(teachingSkillContentChars),
}).strict();
export const teachingSkillReferenceSchema = z.object({ skillId: z.uuid(), version: z.number().int().positive() }).strict();
export type TeachingSkillReference = z.infer<typeof teachingSkillReferenceSchema>;
export const teachingSkillDocumentSchema = teachingSkillReferenceSchema.extend({ content: z.string() }).strict();
export type TeachingSkillDocument = z.infer<typeof teachingSkillDocumentSchema>;
export const teachingSkillReferencesSchema = z.array(teachingSkillReferenceSchema).max(teachingSkillLimits.selections)
  .refine(items => new Set(items.map(item => item.skillId)).size === items.length, 'Duplicate skill selection');
export const teachingSkillImportSchema = z.object({ requestId: z.uuid(), skillId: z.uuid().optional(),
  source: z.string().min(1).max(2000), packageVersion: z.string().trim().min(1).max(100),
  files: z.array(teachingSkillFileSchema).min(1).max(teachingSkillLimits.files),
}).strict().refine(input => new Set(input.files.map(file => file.path.toLowerCase())).size === input.files.length,
  'Duplicate package path');
export type TeachingSkillImport = z.infer<typeof teachingSkillImportSchema>;
export const teachingSkillImportFailureSchema = z.object({ error: z.literal('invalid-skill'),
  reason: z.enum(['frontmatter', 'name', 'description', 'metadata', 'skill-limit']) }).strict();
export type TeachingSkillImportFailure = z.infer<typeof teachingSkillImportFailureSchema>;
export const teachingSkillMetadataSchema = z.object({ name: z.string().min(1).max(teachingSkillLimits.nameChars).regex(/^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u),
  description: z.string().min(1).max(teachingSkillLimits.descriptionChars), compatibility: z.string().max(500).optional(),
  // Author metadata is opaque JSON; dependencies and tools use their explicit fields below.
  license: z.string().max(1000).optional(), metadata: z.record(z.string().max(100), z.json()).optional(),
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
export const librarySkillRangeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }).strict(), z.object({ kind: z.literal('self-study') }).strict(),
  z.object({ kind: z.literal('course'), courseId: z.uuid() }).strict(),
  z.object({ kind: z.literal('activity'), activityId: z.uuid() }).strict(),
]);
export const teachingSkillRangeSchema = z.discriminatedUnion('kind', [
  ...librarySkillRangeSchema.options,
  z.object({ kind: z.literal('session'), sessionId: z.uuid() }).strict(),
]);
export type TeachingSkillRange = z.infer<typeof teachingSkillRangeSchema>;
export const teachingSkillSelectSchema = z.object({ requestId: z.uuid(), range: teachingSkillRangeSchema,
  skills: teachingSkillReferencesSchema }).strict();
export const teachingSkillDisableSchema = z.object({ requestId: z.uuid(), skillId: z.uuid(), disabled: z.boolean() }).strict();
export const teachingSkillRemoveSchema = z.object({ requestId: z.uuid(), skillId: z.uuid() }).strict();
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
export type TeachingSkillList = z.infer<typeof teachingSkillListSchema>;
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
/** The module and selected package are fixed before dispatch; a name is never a recovery identity. */
export const sessionSkillLoadSchema = teachingSkillLoadSchema.extend({ selectionDigest: digest, packageDigest: digest,
  moduleId: z.string().min(1).max(200), moduleVersion: z.number().int().positive() }).strict();
export type SessionSkillLoad = z.input<typeof sessionSkillLoadSchema>;
export const teachingSkillStateSchema = z.object({ catalog: z.array(teachingSkillCatalogEntrySchema).max(1024),
  loaded: z.array(teachingSkillLoadedSchema).max(128) }).strict();
export type TeachingSkillState = z.infer<typeof teachingSkillStateSchema>;
export const sessionSkillStateSchema = teachingSkillStateSchema.extend({ selectionDigest: digest }).strict();
export type SessionSkillState = z.infer<typeof sessionSkillStateSchema>;
export const sessionSkillSelectSchema = teachingSkillSelectSchema.pick({ requestId: true, skills: true }).strict();
export type SessionSkillSelect = z.infer<typeof sessionSkillSelectSchema>;
export const skillsScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('library') }).strict(),
  z.object({ kind: z.literal('session'), sessionId: z.uuid() }).strict(),
]);
export type SkillsScope = z.infer<typeof skillsScopeSchema>;

/** Host migration only: the exact package versions and global toggles move through their owning API. */
export const skillLibrarySnapshotSchema = z.object({ formatVersion: z.literal(1), packages: z.array(z.object({
  skillId: z.uuid(), version: z.number().int().positive().max(teachingSkillLimits.versions), disabled: z.boolean(), removed: z.boolean(),
  versions: z.array(teachingSkillVersionSchema).min(1).max(teachingSkillLimits.versions),
}).strict()).max(teachingSkillLimits.skills),
  selections: z.array(teachingSkillSelectSchema.omit({ requestId: true })).max(64),
}).strict();
export type SkillLibrarySnapshot = z.infer<typeof skillLibrarySnapshotSchema>;

export const librarySkillSelectSchema = teachingSkillSelectSchema.extend({ range: librarySkillRangeSchema }).strict();
export type LibrarySkillSelect = z.infer<typeof librarySkillSelectSchema>;
export interface SessionSkillReadGuard {
  assertDispatch?(): Promise<void>;
  toolNames?: string[];
}
/**
 * scope.kind=library: GET /api/learning/skills; POST /api/learning/skills/{import,select,disable,document,remove}.
 * The host supplies the current personal-library identity/permissions; no activity or Agent runtime is required.
 */
export interface SkillsLibraryPort {
  /** activityId is retained for retiring callers; the global library HTTP route does not supply it. */
  list(identity: SpaceIdentity, activityId?: string): Promise<TeachingSkillList>;
  import(identity: SpaceIdentity, input: TeachingSkillImport): Promise<TeachingSkillCatalogEntry>;
  select(identity: SpaceIdentity, input: LibrarySkillSelect): Promise<TeachingSkillList>;
  disable(identity: SpaceIdentity, input: z.infer<typeof teachingSkillDisableSchema>): Promise<TeachingSkillCatalogEntry>;
  document(identity: SpaceIdentity, reference: TeachingSkillReference): Promise<TeachingSkillDocument>;
  remove(identity: SpaceIdentity, input: z.infer<typeof teachingSkillRemoveSchema>): Promise<{ skillId: string }>;
}
/**
 * scope.kind=session: GET /api/learning/agent-sessions/:sessionId/skills -> resolveSession;
 * POST /api/learning/agent-sessions/:sessionId/skills/select -> selectSession (body excludes range/owner).
 * loadSession/reconcileSession are the fixed-command owner API for installed server tool modules.
 */
export interface SessionSkillsPort {
  resolveSession(identity: SpaceIdentity, sessionId: string, toolNames?: string[]): Promise<SessionSkillState>;
  selectSession(identity: SpaceIdentity, sessionId: string, input: SessionSkillSelect): Promise<SessionSkillState>;
  loadSession(identity: SpaceIdentity, sessionId: string, input: SessionSkillLoad, guard?: SessionSkillReadGuard): Promise<TeachingSkillLoaded>;
  reconcileSession(identity: SpaceIdentity, sessionId: string, input: SessionSkillLoad): Promise<TeachingSkillLoaded | null>;
}
export interface SkillLibraryTransferPort {
  exportLibrary(identity: SpaceIdentity): Promise<SkillLibrarySnapshot>;
  adoptLibrary(identity: SpaceIdentity, input: { requestId: string; library: SkillLibrarySnapshot }): Promise<void>;
}
export interface SkillsPort extends SkillsLibraryPort, SessionSkillsPort, SkillLibraryTransferPort {
  /** Pure owner maintenance; it never asks current member or model owners for authority. */
  validate(): Promise<void>;
}
