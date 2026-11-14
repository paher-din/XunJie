import { z } from 'zod';
import { materialScopeSchema, sessionMaterialScopeSchema } from './session-materials.js';

/** Personal notes are UTF-8 text only. PDFs keep using the existing fixed PDF materials owner. */
export const PERSONAL_MATERIAL_LIMITS = { inputBytes: 2 * 1024 * 1024, nameLength: 240,
  versions: 64, readChars: 6000, searchMatches: 24 } as const;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const base64Schema = z.string().min(1).max(Math.ceil(PERSONAL_MATERIAL_LIMITS.inputBytes / 3) * 4);
export const personalMaterialMediaTypeSchema = z.enum(['text/plain', 'text/markdown']);
export type PersonalMaterialMediaType = z.infer<typeof personalMaterialMediaTypeSchema>;

export const personalMaterialSaveSchema = z.object({ requestId: z.uuid(), materialId: z.uuid(),
  name: z.string().min(1).max(PERSONAL_MATERIAL_LIMITS.nameLength), mediaType: personalMaterialMediaTypeSchema,
  dataBase64: base64Schema }).strict();
export type PersonalMaterialSave = z.infer<typeof personalMaterialSaveSchema>;
export const personalMaterialUpdateSchema = z.object({ requestId: z.uuid(), materialId: z.uuid(),
  expectedVersion: z.number().int().positive().max(PERSONAL_MATERIAL_LIMITS.versions),
  name: z.string().min(1).max(PERSONAL_MATERIAL_LIMITS.nameLength).optional(),
  mediaType: personalMaterialMediaTypeSchema.optional(), dataBase64: base64Schema.optional() }).strict()
  .refine(value => value.name !== undefined || value.mediaType !== undefined || value.dataBase64 !== undefined,
    { message: 'update must change name, media type or content' });
export type PersonalMaterialUpdate = z.infer<typeof personalMaterialUpdateSchema>;
export const personalMaterialRemoveSchema = z.object({ requestId: z.uuid(), materialId: z.uuid(),
  expectedVersion: z.number().int().positive().max(PERSONAL_MATERIAL_LIMITS.versions) }).strict();
export type PersonalMaterialRemove = z.infer<typeof personalMaterialRemoveSchema>;

export const personalMaterialVersionSchema = z.object({ materialId: z.uuid(), version: z.number().int().positive(),
  requestId: z.uuid(), name: z.string().min(1).max(PERSONAL_MATERIAL_LIMITS.nameLength),
  mediaType: personalMaterialMediaTypeSchema, sha256: digest, byteLength: z.number().int().positive(),
  createdAt: z.iso.datetime() }).strict();
export type PersonalMaterialVersion = z.infer<typeof personalMaterialVersionSchema>;
/** Same names are never identity. Versions are append-only and each keeps its immutable bytes. */
export const personalMaterialSchema = z.object({ materialId: z.uuid(), activityId: z.uuid(), requestId: z.uuid(),
  name: z.string().min(1).max(PERSONAL_MATERIAL_LIMITS.nameLength), mediaType: personalMaterialMediaTypeSchema,
  currentVersion: z.number().int().positive(), createdAt: z.iso.datetime(),
  removedAt: z.iso.datetime().nullable(), versions: z.array(personalMaterialVersionSchema)
    .min(1).max(PERSONAL_MATERIAL_LIMITS.versions) }).strict();
export type PersonalMaterial = z.infer<typeof personalMaterialSchema>;
/** Workspace wire stays byte-for-byte compatible; session records never contain a fake activity id. */
export const sessionPersonalMaterialSchema = personalMaterialSchema.omit({ activityId: true })
  .extend({ scope: sessionMaterialScopeSchema }).strict();
export const scopedPersonalMaterialSchema = z.union([personalMaterialSchema, sessionPersonalMaterialSchema]);
export type ScopedPersonalMaterial = z.infer<typeof scopedPersonalMaterialSchema>;
export const personalMaterialVersionContentSchema = z.object({ material: personalMaterialSchema,
  version: personalMaterialVersionSchema, text: z.string() }).strict();
export type PersonalMaterialVersionContent = z.infer<typeof personalMaterialVersionContentSchema>;
export const scopedPersonalMaterialVersionContentSchema = personalMaterialVersionContentSchema
  .extend({ material: scopedPersonalMaterialSchema }).strict();
export type ScopedPersonalMaterialVersionContent = z.infer<typeof scopedPersonalMaterialVersionContentSchema>;

export const personalMaterialReadSchema = z.object({ start: z.number().int().nonnegative().max(100000000),
  length: z.number().int().min(1).max(PERSONAL_MATERIAL_LIMITS.readChars) }).strict();
export const personalMaterialReadResultSchema = z.object({ materialId: z.uuid(), version: z.number().int().positive(),
  sha256: digest, name: z.string(), mediaType: personalMaterialMediaTypeSchema, start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(), total: z.number().int().nonnegative(), text: z.string(),
  coordinates: z.literal('utf16-code-units'), readMethod: z.literal('stored-text-range') }).strict();
export type PersonalMaterialReadResult = z.infer<typeof personalMaterialReadResultSchema>;

/** A fixed reference pins the personal original's version and byte digest. */
export const personalMaterialReferenceSourceSchema = z.object({ kind: z.literal('personal-material'),
  activityId: z.uuid(), materialId: z.uuid(), version: z.number().int().positive(), sha256: digest }).strict();
export type PersonalMaterialReferenceSource = z.infer<typeof personalMaterialReferenceSourceSchema>;
export const scopedPersonalMaterialReferenceSourceSchema = z.union([personalMaterialReferenceSourceSchema,
  personalMaterialReferenceSourceSchema.omit({ activityId: true }).extend({ scope: sessionMaterialScopeSchema }).strict()]);
export type ScopedPersonalMaterialReferenceSource = z.infer<typeof scopedPersonalMaterialReferenceSourceSchema>;

export const materialSearchScopeSchema = z.object({ courseMaterials: z.boolean().default(true),
  personalMaterialIds: z.array(z.uuid()).max(64).optional(),
  pdfReferenceIds: z.array(z.uuid()).max(16).optional(),
  skillAttachments: z.boolean().default(true) }).strict();
export type MaterialSearchScope = z.infer<typeof materialSearchScopeSchema>;
export const materialSearchInputSchema = z.object({ query: z.string().trim().min(1).max(200),
  scope: materialSearchScopeSchema.default({ courseMaterials: true, skillAttachments: true }) }).strict();
export type MaterialSearchInput = z.infer<typeof materialSearchInputSchema>;

export const materialSourceRefSchema = z.object({ kind: z.enum(['course-material', 'personal-material', 'pdf', 'skill-attachment']),
  id: z.string().min(1).max(400), version: z.string().min(1).max(200), sha256: digest.optional(),
  label: z.string().min(1).max(300).optional(), releaseId: z.uuid().optional(), materialId: z.uuid().optional(),
  documentId: z.uuid().optional(), readingId: z.uuid().optional(), skillId: z.uuid().optional(),
  scope: materialScopeSchema.optional(),
  path: z.string().min(1).max(240).optional() }).strict();
export type MaterialSourceRef = z.infer<typeof materialSourceRefSchema>;
export const materialSearchMatchSchema = z.object({ source: materialSourceRefSchema,
  locator: z.object({ line: z.number().int().positive().optional(), page: z.number().int().positive().optional(),
    start: z.number().int().nonnegative().optional(), end: z.number().int().nonnegative().optional() }).strict(),
  excerpt: z.string().max(2000), readMethod: z.enum(['stored-text', 'native-pdf-text', 'skill-text-attachment']) }).strict();
export type MaterialSearchMatch = z.infer<typeof materialSearchMatchSchema>;
export const materialSearchSourceStateSchema = z.object({ source: materialSourceRefSchema.optional(),
  state: z.enum(['searched', 'no-hit', 'not-indexed', 'no-text', 'partial-failure', 'no-access', 'missing']),
  detail: z.string().max(500).optional(), searchedChars: z.number().int().nonnegative().optional() }).strict();
export type MaterialSearchSourceState = z.infer<typeof materialSearchSourceStateSchema>;
export const materialSearchResultSchema = z.object({ query: z.string(), scope: materialSearchScopeSchema,
  matches: z.array(materialSearchMatchSchema).max(PERSONAL_MATERIAL_LIMITS.searchMatches),
  sources: z.array(materialSearchSourceStateSchema).max(200),
  coverage: z.object({ sourceCount: z.number().int().nonnegative(), searchedSourceCount: z.number().int().nonnegative(),
    excludedSourceCount: z.number().int().nonnegative(), searchedChars: z.number().int().nonnegative(),
    kinds: z.array(z.enum(['course-material', 'personal-material', 'pdf', 'skill-attachment'])) }).strict(),
  truncated: z.boolean() }).strict();
export type MaterialSearchResult = z.infer<typeof materialSearchResultSchema>;
