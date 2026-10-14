import { z } from "zod";
import { analysisBodySchema } from "../../contracts/review/index.ts";

const nonEmptyString = z.string().min(1);
const stringList = z.array(z.string());

const candidateSchema = z.object({
  problem: nonEmptyString,
  audience: nonEmptyString,
  artifact: nonEmptyString,
  routes: stringList,
  goals: stringList,
  constraints: stringList,
  unresolved: stringList,
  resourceRefs: stringList,
}).passthrough();

const teacherCandidatesSchema = z.object({
  kind: z.literal("candidates"),
  candidates: z.array(candidateSchema).min(1).max(3),
}).passthrough();

const teacherBlueprintSchema = z.object({
  kind: z.literal("blueprint"),
  problem: nonEmptyString,
  audience: nonEmptyString,
  artifact: nonEmptyString,
  routes: stringList,
  goals: stringList,
  milestones: stringList,
  resources: stringList,
  helpPolicy: nonEmptyString,
  checkpoints: stringList,
  rubric: stringList,
  goalEvidenceLinks: stringList,
  unresolved: stringList,
}).passthrough();

const teacherPatchSchema = z.object({
  kind: z.literal("patch"),
  changes: z.array(z.object({ field: z.string(), value: z.json() }).passthrough()),
  rationale: nonEmptyString,
  resourceRefs: stringList,
  affectedLinks: stringList,
  unresolved: stringList,
}).passthrough();

const teacherRubricTrialSchema = z.object({
  kind: z.literal("rubric_trial"),
  criterionComments: stringList,
  ambiguities: stringList,
  suggestedChanges: stringList,
  sampleRefs: stringList,
  unresolved: stringList,
}).passthrough();

const studentHelpSchema = z.object({
  kind: z.literal("student_help"),
  actionType: z.enum([
    "plan",
    "clarify",
    "hint",
    "explain",
    "compare",
    "verify_suggestion",
    "reflect",
    "extend",
    "handoff_teacher",
    "no_action",
  ]),
  content: nonEmptyString,
  rationale: nonEmptyString,
  expectedStudentAction: nonEmptyString,
  evidenceIds: stringList,
  resourceRefs: stringList,
  assistanceContext: nonEmptyString,
  unresolved: stringList,
  policyChecks: z.object({
    containsWholeSolution: z.literal(false),
    writesStudentWork: z.literal(false),
    runsCode: z.literal(false),
    makesFormalEvaluation: z.literal(false),
  }).passthrough(),
}).passthrough();

export const tutoringSchemaKinds = [
  "candidates",
  "blueprint",
  "patch",
  "rubric_trial",
  "student_help",
  "learner_analysis",
] as const;

export type TutoringSchemaKind = (typeof tutoringSchemaKinds)[number];

export function getTutoringOutputSchema(kind: TutoringSchemaKind): z.ZodType<unknown> {
  switch (kind) {
    case "candidates": return teacherCandidatesSchema;
    case "blueprint": return teacherBlueprintSchema;
    case "patch": return teacherPatchSchema;
    case "rubric_trial": return teacherRubricTrialSchema;
    case "student_help": return studentHelpSchema;
    case "learner_analysis": return analysisBodySchema;
  }
}

export function getTutoringJsonSchema(kind: TutoringSchemaKind): Record<string, unknown> {
  return z.toJSONSchema(getTutoringOutputSchema(kind), { target: "draft-7" }) as Record<string, unknown>;
}
