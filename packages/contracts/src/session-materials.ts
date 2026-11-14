import { z } from 'zod';
import type { SpaceIdentity } from './spaces.js';
import type { PersonalMaterialSave, PersonalMaterialUpdate, PersonalMaterialRemove, PersonalMaterialReadResult,
  ScopedPersonalMaterial, ScopedPersonalMaterialVersionContent, ScopedPersonalMaterialReferenceSource,
  MaterialSearchInput, MaterialSearchResult, personalMaterialReadSchema } from './personal-materials.js';
import type { ScopedPdfDocument, ScopedPdfReading, ScopedPdfSearchResult, ScopedPdfReferenceSource,
  pdfUploadSchema, pdfCourseInputSchema, pdfReadInputSchema, pdfFindInputSchema } from './pdf-materials.js';
import type { QuestionReferenceInput } from './question-drafts.js';
import type { TeachingSkillReference, TeachingSkillState } from './agent-skills.js';

export const sessionMaterialScopeSchema = z.object({ kind: z.literal('session'), sessionId: z.uuid() }).strict();
export const workspaceMaterialScopeSchema = z.object({ kind: z.literal('workspace'), activityId: z.uuid() }).strict();
export const materialScopeSchema = z.discriminatedUnion('kind', [sessionMaterialScopeSchema, workspaceMaterialScopeSchema]);
export type MaterialScope = z.infer<typeof materialScopeSchema>;
export type SessionMaterialScope = z.infer<typeof sessionMaterialScopeSchema>;
export type WorkspaceMaterialScope = z.infer<typeof workspaceMaterialScopeSchema>;
/** Existing strings always mean a real workspace activity, never a session. */
export type MaterialScopeInput = MaterialScope | string;

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const adoptSessionMaterialSchema = z.discriminatedUnion('kind', [
  z.object({ requestId: z.uuid(), kind: z.literal('personal-material'), materialId: z.uuid(),
    source: z.object({ scope: materialScopeSchema, materialId: z.uuid(), version: z.number().int().positive(), sha256 }).strict() }).strict(),
  z.object({ requestId: z.uuid(), kind: z.literal('pdf'), documentId: z.uuid(),
    source: z.object({ scope: materialScopeSchema, documentId: z.uuid(), sha256 }).strict() }).strict(),
]);
export type AdoptSessionMaterial = z.infer<typeof adoptSessionMaterialSchema>;
export const releaseSessionMaterialsSchema = z.object({ requestId: z.uuid(), sessionId: z.uuid() }).strict();
export type ReleaseSessionMaterials = z.infer<typeof releaseSessionMaterialsSchema>;

/** Explicit cross-owner ports. Providers validate the real scope and current access on every call. */
export interface PersonalMaterialPort {
  list(identity: SpaceIdentity, scope: MaterialScopeInput): Promise<ScopedPersonalMaterial[]>;
  material(identity: SpaceIdentity, scope: MaterialScopeInput, materialId: string): Promise<ScopedPersonalMaterial>;
  receive(identity: SpaceIdentity, scope: MaterialScopeInput, input: PersonalMaterialSave): Promise<ScopedPersonalMaterial>;
  update(identity: SpaceIdentity, scope: MaterialScopeInput, materialId: string, input: PersonalMaterialUpdate): Promise<ScopedPersonalMaterial>;
  remove(identity: SpaceIdentity, scope: MaterialScopeInput, materialId: string, input: PersonalMaterialRemove): Promise<ScopedPersonalMaterial>;
  receipt(identity: SpaceIdentity, scope: MaterialScopeInput, requestId: string): Promise<ScopedPersonalMaterial | null>;
  original(identity: SpaceIdentity, scope: MaterialScopeInput, materialId: string, version: number): Promise<ScopedPersonalMaterialVersionContent>;
  versionContent(identity: SpaceIdentity, scope: MaterialScopeInput, materialId: string, version: number): Promise<ScopedPersonalMaterialVersionContent>;
  readRange(identity: SpaceIdentity, scope: MaterialScopeInput, materialId: string, version: number,
    input: z.infer<typeof personalMaterialReadSchema>): Promise<PersonalMaterialReadResult>;
}
export interface PdfMaterialPort {
  list(identity: SpaceIdentity, scope: MaterialScopeInput): Promise<ScopedPdfDocument[]>;
  document(identity: SpaceIdentity, scope: MaterialScopeInput, documentId: string): Promise<ScopedPdfDocument>;
  original(identity: SpaceIdentity, scope: MaterialScopeInput, documentId: string): Promise<{ document: ScopedPdfDocument; bytes: Uint8Array }>;
  upload(identity: SpaceIdentity, scope: MaterialScopeInput, input: z.infer<typeof pdfUploadSchema>): Promise<ScopedPdfDocument>;
  importCourse(identity: SpaceIdentity, scope: MaterialScopeInput, input: z.infer<typeof pdfCourseInputSchema>): Promise<ScopedPdfDocument>;
  read(identity: SpaceIdentity, scope: MaterialScopeInput, input: z.infer<typeof pdfReadInputSchema>): Promise<ScopedPdfReading>;
  reading(identity: SpaceIdentity, scope: MaterialScopeInput, readingId: string): Promise<ScopedPdfReading | null>;
  find(identity: SpaceIdentity, scope: MaterialScopeInput, input: z.infer<typeof pdfFindInputSchema>): Promise<ScopedPdfSearchResult>;
}
export interface MaterialSearchSelection {
  pdfReferences?: (QuestionReferenceInput | { source: ScopedPdfReferenceSource })[];
  personalReferences?: (QuestionReferenceInput | { source: ScopedPersonalMaterialReferenceSource })[];
  skillReferences?: TeachingSkillReference[];
  skillState?: TeachingSkillState;
  skillRead?: (skillId: string, version: number, path: string) => Promise<{ content: string; digest: string }>;
}
export interface SessionMaterialPort {
  personal: PersonalMaterialPort;
  pdf: PdfMaterialPort;
  search(identity: SpaceIdentity, scope: MaterialScopeInput, input: MaterialSearchInput, selection?: MaterialSearchSelection): Promise<MaterialSearchResult>;
  adopt(identity: SpaceIdentity, destination: MaterialScopeInput, input: AdoptSessionMaterial): Promise<ScopedPersonalMaterial | ScopedPdfDocument>;
  releaseDeleted(identity: SpaceIdentity, input: ReleaseSessionMaterials): Promise<void>;
  validate(): Promise<void>;
}
