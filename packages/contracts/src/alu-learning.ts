import { z } from 'zod';
import type { ExecutionActionV3, AnyExecutionAction } from './execution.js';
import type { WorkFile } from './learning-data.js';

export const aluInputsSchema = z.object({ A: z.number().int().min(0).max(15), B: z.number().int().min(0).max(15),
  M: z.number().int().min(0).max(1), S: z.number().int().min(0).max(3), Cin: z.number().int().min(0).max(1) }).strict();
export type AluInputs = z.infer<typeof aluInputsSchema>;
export const aluPriorSourceSchema = z.object({ requestId: z.uuid(), inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  executionRef: z.uuid(), kind: z.enum(['same-input-observation', 'work-check']) }).strict();
/** Missing or non-binary predictions remain student text; they never become fabricated actual values. */
export const aluCaseDraftSchema = z.object({ formatVersion: z.literal(1), caseId: z.uuid(), revisionId: z.uuid(),
  purpose: z.enum(['unspecified', 'boundary', 'operation', 'custom']), predictedF: z.string().max(32),
  predictedCout: z.string().max(32), reason: z.string().max(4000), helpReported: z.boolean(),
  priorSources: z.array(aluPriorSourceSchema).max(32) }).strict();
export type AluCaseDraft = z.infer<typeof aluCaseDraftSchema>;
export function newAluCaseDraft(caseId: string, revisionId: string): AluCaseDraft {
  return aluCaseDraftSchema.parse({ formatVersion: 1, caseId, revisionId, purpose: 'unspecified',
    predictedF: '', predictedCout: '', reason: '', helpReported: false, priorSources: [] });
}

export const ALU_REFLECTION_MEDIA_TYPE = 'application/vnd.xunjie.alu-reflection+json';
/** A reflection stores student text and original-owner links, never another F/Cout or execution ledger. */
export const aluReflectionSchema = z.object({ formatVersion: z.literal(1), kind: z.literal('alu-reflection'),
  noteId: z.uuid(), activityId: z.uuid(), bindingKey: z.string().min(1).max(80),
  instanceId: z.string().min(1).max(300), definitionDigest: z.string().regex(/^[a-f0-9]{64}$/),
  requestId: z.uuid(), inputDigest: z.string().regex(/^[a-f0-9]{64}$/), executionRef: z.uuid(),
  parentNoteId: z.uuid().nullable(), text: z.string().max(8000) }).strict();
export type AluReflection = z.infer<typeof aluReflectionSchema>;
export const aluReflectionName = (bindingKey: string, noteId: string) => `alu-reflections/${bindingKey}/${noteId}.json`;

const fixedStateSchema = z.object({ formatVersion: z.literal(1), instanceId: z.string(), componentId: z.uuid(),
  version: z.number().int().positive(), definitionDigest: z.string(), stateVersion: z.literal(3), operationId: z.uuid(),
  content: aluInputsSchema.extend({ caseDraft: z.string().max(16000), caseRequestId: z.uuid(),
    feedbackPolicy: z.literal('hold'), enabledBasis: z.string().max(4000) }).passthrough() }).strict();
export interface AluCaseCapture {
  draft: AluCaseDraft;
  inputs: AluInputs;
  stateFile: WorkFile;
  origin: ExecutionActionV3['execution']['initiator']['kind'];
}

/** A direct observation may be explained later without inventing a prior prediction. */
export function isAluObservationAction(action: AnyExecutionAction): action is ExecutionActionV3 {
  return action.protocolVersion === 3 && action.execution.basis.runtime.adapterId === 'icarus-alu'
    && ['run-single', 'observe-enabled'].includes(action.execution.operation.operationId)
    && aluInputsSchema.safeParse(action.execution.parameters).success;
}

/** The command's own fixed state establishes a case. A current mutable pointer cannot rewrite it. */
export function aluCaseFromAction(action: ExecutionActionV3): AluCaseCapture | null {
  try {
    if (action.protocolVersion !== 3 || action.execution.basis.runtime.adapterId !== 'icarus-alu'
      || action.execution.instance.stateVersion !== 3 || action.execution.operation.operationId !== 'observe-enabled') return null;
    const { instance, basis } = action.execution;
    const stateFile = basis.works.find(file => file.kind === 'state' && file.contentId === basis.expected.stateContentId);
    if (!stateFile || stateFile.encoding !== 'json') return null;
    const state = fixedStateSchema.parse(JSON.parse(stateFile.value));
    if (state.instanceId !== instance.instanceId || state.componentId !== instance.componentId || state.version !== instance.componentVersion
      || state.definitionDigest !== instance.definitionDigest || state.content.caseRequestId !== action.requestId) return null;
    const inputs = aluInputsSchema.parse(action.execution.parameters);
    if (Object.keys(inputs).some(key => inputs[key as keyof AluInputs] !== state.content[key as keyof AluInputs])) return null;
    const enabled = JSON.parse(state.content.enabledBasis) as { requestId?: unknown; executionRef?: unknown; definitionDigest?: unknown };
    if (!basis.enabledBy || enabled.requestId !== basis.enabledBy.requestId || enabled.executionRef !== basis.enabledBy.executionRef
      || enabled.definitionDigest !== instance.definitionDigest) return null;
    return { draft: aluCaseDraftSchema.parse(JSON.parse(state.content.caseDraft)), inputs, stateFile,
      origin: action.execution.initiator.kind };
  } catch { return null; }
}

/** Equality uses original compile-relevant bytes, so undo or copying the same bytes cannot hide an existing source. */
export function aluCodeIdentity(action: ExecutionActionV3): string {
  return JSON.stringify({ runtime: action.execution.basis.runtime.bundleIdentity,
    compile: { entryFiles: action.execution.basis.compile.entryFiles,
      includeDirs: action.execution.basis.compile.includeDirs, strictExprWidth: action.execution.basis.compile.strictExprWidth },
    files: action.execution.basis.works.filter(file => file.kind === 'code')
      .map(file => ({ name: file.name, encoding: file.encoding, value: file.value })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0) });
}
export const sameAluInputs = (left: unknown, right: unknown) => {
  const a = aluInputsSchema.safeParse(left), b = aluInputsSchema.safeParse(right);
  return a.success && b.success && Object.keys(a.data).every(key => a.data[key as keyof AluInputs] === b.data[key as keyof AluInputs]);
};

export function parseAluReflectionFile(file: WorkFile): AluReflection {
  if (file.mediaType !== ALU_REFLECTION_MEDIA_TYPE || file.kind !== 'state' || file.encoding !== 'json') throw new Error('invalid-reflection');
  const note = aluReflectionSchema.parse(JSON.parse(file.value));
  if (file.objectId !== note.noteId || file.contentId !== note.noteId || file.name !== aluReflectionName(note.bindingKey, note.noteId))
    throw new Error('invalid-reflection');
  return note;
}
