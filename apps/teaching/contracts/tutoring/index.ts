export const teacherGenerationModes = [
  "candidates",
  "blueprint",
  "patch",
  "rubric_trial",
] as const;

export type TeacherGenerationMode = (typeof teacherGenerationModes)[number];

export const studentActionTypes = [
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
] as const;

export type StudentActionType = (typeof studentActionTypes)[number];
export type TutoringPurpose = "teacher_design" | "student_help";

export type TrustedModelContext = {
  jobId: string;
  purpose: TutoringPurpose;
  scope: {
    courseId: string;
    userId: string;
    attemptId?: string;
  };
  authorizedReferenceIds: readonly string[];
  acceptedAtMs: number;
  deadlineAtMs: number;
  budgetAvailable: boolean;
  versions: {
    modelConfig: string;
    prompt: string;
    schema: string;
    policy: string;
  };
};

export type UntrustedReference = {
  id: string;
  content: string;
};

export type TeacherGenerationRequest = {
  context: TrustedModelContext;
  mode: TeacherGenerationMode;
  request: string;
  references: readonly UntrustedReference[];
  blueprintId?: string | null;
  baseRevision?: number;
  signal?: AbortSignal;
};

export type StudentHelpRequest = {
  context: TrustedModelContext;
  question: string;
  objectRef?: Readonly<Record<string, unknown>>;
  references: readonly UntrustedReference[];
  policy: {
    helpAllowed: boolean;
    wholeSolutionAllowed: false;
  };
  signal?: AbortSignal;
};

export type TeacherGenerationBody =
  | {
      kind: "candidates";
      candidates: readonly {
        problem: string;
        audience: string;
        artifact: string;
        routes: readonly string[];
        goals: readonly string[];
        constraints: readonly string[];
        unresolved: readonly string[];
        resourceRefs: readonly string[];
      }[];
    }
  | {
      kind: "blueprint";
      problem: string;
      audience: string;
      artifact: string;
      routes: readonly string[];
      goals: readonly string[];
      milestones: readonly string[];
      resources: readonly string[];
      helpPolicy: string;
      checkpoints: readonly string[];
      rubric: readonly string[];
      goalEvidenceLinks: readonly string[];
      unresolved: readonly string[];
    }
  | {
      kind: "patch";
      changes: readonly { field: string; value: unknown }[];
      rationale: string;
      resourceRefs: readonly string[];
      affectedLinks: readonly string[];
      unresolved: readonly string[];
    }
  | {
      kind: "rubric_trial";
      criterionComments: readonly string[];
      ambiguities: readonly string[];
      suggestedChanges: readonly string[];
      sampleRefs: readonly string[];
      unresolved: readonly string[];
    };

export type StudentHelpBody = {
  kind: "student_help";
  actionType: StudentActionType;
  content: string;
  rationale: string;
  expectedStudentAction: string;
  evidenceIds: readonly string[];
  resourceRefs: readonly string[];
  assistanceContext: string;
  unresolved: readonly string[];
  policyChecks: {
    containsWholeSolution: false;
    writesStudentWork: false;
    runsCode: false;
    makesFormalEvaluation: false;
  };
};

export type ModelUsage =
  | { status: "actual"; inputTokens: number; outputTokens: number }
  | { status: "unknown" };

export type TutoringSuccess<TBody> = {
  outcome: "success";
  body: TBody;
  calls: number;
  elapsedMs: number;
  usage: ModelUsage;
  versions: TrustedModelContext["versions"];
};

export type TutoringFailure = {
  outcome:
    | "needs_input"
    | "rejected"
    | "stale"
    | "cancelled"
    | "timed_out"
    | "budget_exhausted"
    | "unavailable";
  code: string;
  retryable: boolean;
  calls: number;
  usage: ModelUsage;
};

export type TutoringOutcome<TBody> = TutoringSuccess<TBody> | TutoringFailure;
