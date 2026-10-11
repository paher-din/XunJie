import type {
  AuthorizedStudentHelpContext,
  LearnerContextClaim,
  StudentHelpRequest,
  UntrustedReference,
} from "../../contracts/tutoring/index.ts";
import { studentActionTypes } from "../../contracts/tutoring/index.ts";
import { RunnerError } from "../../runner/snapshot.ts";
import type { CurrentGuard, GuardState } from "./core.ts";
import { rangeOffsets } from "../workspace/files.ts";

export type StudentHelpCurrentState = AuthorizedStudentHelpContext["current"] & {
  helpAllowed: boolean;
  learnerStateRevision: number;
  objectAvailable: boolean;
  jobStatus: "queued" | "running" | "succeeded" | "failed" | "cancelling" | "cancelled" | "stale" | "timed_out" | "outcome_unknown";
  stopRequested: boolean;
};

export function assembleStudentHelpRequest(
  input: AuthorizedStudentHelpContext,
  signal?: AbortSignal,
): StudentHelpRequest {
  assertAuthorizedContext(input);
  const references: UntrustedReference[] = [];
  const add = (reference: UntrustedReference) => {
    if (references.some((item) => item.id === reference.id)) return;
    references.push(reference);
  };

  const projectId = `project:${input.activity.activityVersionId}`;
  add({
    id: projectId,
    content: JSON.stringify({
      source: "approved_activity",
      activityVersionId: input.activity.activityVersionId,
      goals: input.activity.content.content.goals,
      tasks: input.activity.content.content.tasks,
      milestones: input.activity.content.content.milestones,
      helpPolicyVersionId: input.activity.helpPolicy.versionId,
    }),
  });

  if (input.objectRef) addObjectReference(input, add);
  for (const reference of selectResourceParagraphs(input)) add(reference);

  const relevantClaims = input.learnerClaims.filter((claim) => relevantClaim(input, claim));
  if (relevantClaims.length === 0) {
    add({
      id: `learner-state:${input.learnerStateRevision}:unknown`,
      content: JSON.stringify({
        source: "learner_state",
        learnerStateRevision: input.learnerStateRevision,
        state: "unknown",
        reason: "No applicable active or contested claim is available.",
      }),
    });
  } else {
    for (const claim of relevantClaims) {
      add({
        id: `claim:${claim.claimId}:${claim.claimRevision}`,
        content: JSON.stringify({
          source: "learner_state",
          learnerStateRevision: input.learnerStateRevision,
          competencyId: claim.competencyId,
          competencyVersion: claim.competencyVersion,
          statement: claim.statement,
          state: claim.state,
          validity: claim.validity,
          evidenceIds: claim.evidenceIds,
          counterEvidenceIds: claim.counterEvidenceIds,
          assistanceStatus: claim.assistanceStatus,
          unresolved: claim.unresolved,
        }),
      });
    }
  }

  for (const action of input.assistanceHistory
    .filter((item) => item.status === "displayed" || item.status === "acknowledged")
    .slice(-3)) {
    add({
      id: `assistance:${action.actionId}`,
      content: JSON.stringify({
        source: "actual_help",
        actionType: action.actionType,
        content: action.content,
        status: action.status,
      }),
    });
  }

  return {
    context: {
      jobId: input.job.jobId,
      purpose: "student_help",
      scope: {
        courseId: input.job.scope.courseId,
        userId: input.job.scope.studentId!,
        attemptId: input.job.scope.attemptId!,
      },
      authorizedReferenceIds: references.map((reference) => reference.id),
      acceptedAtMs: Date.parse(input.job.acceptedAt),
      deadlineAtMs: Date.parse(input.job.deadline),
      budgetAvailable: input.budgetAvailable,
      versions: input.versions,
    },
    question: input.question,
    ...(input.objectRef ? { objectRef: structuredClone(input.objectRef) } : {}),
    references,
    policy: {
      helpAllowed: input.activity.helpPolicy.helpAllowed && !input.current.limitedCheck,
      wholeSolutionAllowed: false,
    },
    ...(signal ? { signal } : {}),
  };
}

export function createStudentHelpCurrentGuard(
  expected: AuthorizedStudentHelpContext,
  readCurrent: (signal: AbortSignal) => StudentHelpCurrentState | Promise<StudentHelpCurrentState>,
): CurrentGuard {
  return async (signal): Promise<GuardState> => {
    if (signal.aborted) return "cancelled";
    const current = await readCurrent(signal);
    if (signal.aborted || current.stopRequested || ["cancelling", "cancelled"].includes(current.jobStatus)) {
      return "cancelled";
    }
    if (
      current.jobStatus !== "queued" && current.jobStatus !== "running" ||
      current.recoveryGeneration !== expected.job.recoveryGeneration ||
      current.decisionEpoch !== expected.job.decisionEpoch ||
      current.activityVersionId !== expected.activity.activityVersionId ||
      current.helpPolicyVersionId !== expected.activity.helpPolicy.versionId ||
      current.learnerStateRevision !== expected.learnerStateRevision ||
      !current.objectAvailable ||
      current.attemptStatus !== "active" ||
      !current.assignmentActive ||
      current.limitedCheck ||
      !current.helpAllowed
    ) {
      return "stale";
    }
    return "current";
  };
}

function assertAuthorizedContext(input: AuthorizedStudentHelpContext) {
  const { job, current } = input;
  if (
    job.purpose !== "student_help" ||
    !job.scope.studentId ||
    !job.scope.attemptId ||
    job.decisionEpoch !== current.decisionEpoch ||
    job.recoveryGeneration !== current.recoveryGeneration ||
    current.activityVersionId !== input.activity.activityVersionId ||
    current.helpPolicyVersionId !== input.activity.helpPolicy.versionId ||
    input.activity.courseId !== job.scope.courseId ||
    current.attemptStatus !== "active" ||
    !current.assignmentActive ||
    current.limitedCheck ||
    job.stopRequested ||
    (job.status !== "queued" && job.status !== "running") ||
    input.activity.status !== "active" ||
    !input.activity.helpPolicy.helpAllowed ||
    !input.question.trim() ||
    !Number.isSafeInteger(input.learnerStateRevision) ||
    input.learnerStateRevision < 0 ||
    input.learnerClaims.some((claim) => !validLearnerClaim(claim)) ||
    input.assistanceHistory.some((item) =>
      !item.actionId ||
      !studentActionTypes.includes(item.actionType) ||
      typeof item.content !== "string" ||
      !["generated", "received", "displayed", "acknowledged", "cancelled", "stale", "failed"].includes(item.status)) ||
    !Number.isFinite(Date.parse(job.acceptedAt)) ||
    !Number.isFinite(Date.parse(job.deadline)) ||
    Date.parse(job.deadline) <= Date.parse(job.acceptedAt)
  ) {
    throw new RunnerError("STATE_CONFLICT", "Student help context is not current");
  }
}

function validLearnerClaim(claim: LearnerContextClaim): boolean {
  return Boolean(claim.claimId) &&
    Number.isSafeInteger(claim.claimRevision) && claim.claimRevision > 0 &&
    Boolean(claim.competencyId) &&
    Number.isSafeInteger(claim.competencyVersion) && claim.competencyVersion > 0 &&
    typeof claim.statement === "string" &&
    ["insufficient", "supported_with_assistance", "supported_in_check", "conflicting"].includes(claim.state) &&
    ["active", "contested", "superseded", "withdrawn"].includes(claim.validity) &&
    claim.evidenceIds.every((value) => typeof value === "string") &&
    claim.counterEvidenceIds.every((value) => typeof value === "string") &&
    ["observed_help", "none_observed_in_system", "unknown"].includes(claim.assistanceStatus) &&
    typeof claim.unresolved === "boolean";
}

function addObjectReference(
  input: AuthorizedStudentHelpContext,
  add: (reference: UntrustedReference) => void,
) {
  const reference = input.objectRef!;
  if (reference.attemptId !== input.job.scope.attemptId) {
    throw new RunnerError("INVALID_REFERENCE", "Object reference attempt mismatch");
  }
  if (reference.kind === "project") {
    if (reference.activityVersionId !== input.activity.activityVersionId) {
      throw new RunnerError("INVALID_REFERENCE", "Project reference version mismatch");
    }
    return;
  }
  if (reference.kind === "resource") {
    const paragraph = availableParagraphs(input).find((item) =>
      item.resourceVersionId === reference.resourceVersionId && item.paragraphId === reference.paragraphId);
    if (!paragraph) throw new RunnerError("INVALID_REFERENCE", "Authorized resource paragraph unavailable");
    add({ id: paragraph.id, content: paragraph.content });
    return;
  }
  if (reference.kind === "run") {
    const diagnostic = input.diagnostics.find((item) =>
      item.runId === reference.runId && item.snapshotId === reference.snapshotId);
    if (!diagnostic) throw new RunnerError("INVALID_REFERENCE", "Authorized run diagnostics unavailable");
    add({
      id: `run:${reference.runId}:${reference.snapshotId}`,
      content: JSON.stringify({ source: "runner_diagnostics", ...diagnostic }),
    });
    return;
  }

  const snapshot = input.snapshots.find((item) => item.snapshotId === reference.snapshotId &&
    item.attemptId === reference.attemptId && item.activityVersionId === input.activity.activityVersionId);
  const file = snapshot?.files.find((item) => item.fileId === reference.fileId &&
    item.path === reference.path && item.documentVersion === reference.documentVersion &&
    item.contentHash === reference.contentHash);
  if (!snapshot || !file) throw new RunnerError("INVALID_REFERENCE", "Authorized code snapshot unavailable");
  let text = file.text;
  if (reference.range) {
    const [start, end] = rangeOffsets(text, reference.range);
    text = text.slice(start, end);
  }
  add({
    id: `code:${reference.snapshotId}:${reference.fileId}:${reference.documentVersion}:${reference.contentHash}`,
    content: JSON.stringify({
      source: "confirmed_snapshot",
      snapshotId: reference.snapshotId,
      fileId: reference.fileId,
      path: reference.path,
      documentVersion: reference.documentVersion,
      contentHash: reference.contentHash,
      range: reference.range ?? null,
      text,
    }),
  });
}

function selectResourceParagraphs(input: AuthorizedStudentHelpContext): UntrustedReference[] {
  const exact = input.objectRef?.kind === "resource"
    ? `${input.objectRef.resourceVersionId}:${input.objectRef.paragraphId}`
    : undefined;
  const terms = searchTerms(input.question);
  return availableParagraphs(input)
    .map((paragraph) => ({
      paragraph,
      score: paragraph.key === exact ? Number.MAX_SAFE_INTEGER : terms.reduce(
        (sum, term) => sum + (paragraph.searchable.includes(term) ? 1 : 0),
        0,
      ),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.paragraph.id.localeCompare(right.paragraph.id))
    .slice(0, 3)
    .map(({ paragraph }) => ({ id: paragraph.id, content: paragraph.content }));
}

function availableParagraphs(input: AuthorizedStudentHelpContext) {
  return input.activity.content.materials.flatMap((material) => {
    if (material.status !== "available") return [];
    return material.paragraphs.flatMap((paragraph) => {
      if (!paragraph.paragraphId) return [];
      const id = `resource:${material.resourceVersionId}:${paragraph.paragraphId}:${paragraph.contentHash}`;
      const content = JSON.stringify({
        source: "approved_course_resource",
        resourceVersionId: material.resourceVersionId,
        paragraphId: paragraph.paragraphId,
        contentHash: paragraph.contentHash,
        title: material.title,
        text: paragraph.text,
      });
      return [{
        id,
        key: `${material.resourceVersionId}:${paragraph.paragraphId}`,
        resourceVersionId: material.resourceVersionId,
        paragraphId: paragraph.paragraphId,
        content,
        searchable: `${material.title}\n${paragraph.text}`.toLocaleLowerCase(),
      }];
    });
  });
}

function searchTerms(value: string): string[] {
  const normalized = value.toLocaleLowerCase();
  const words = normalized.match(/[\p{L}\p{N}_]+/gu) ?? [];
  const cjk = normalized.match(/[\p{Script=Han}]+/gu) ?? [];
  const grams = cjk.flatMap((part) => {
    const characters = [...part];
    return characters.length < 2
      ? characters
      : characters.slice(0, -1).map((character, index) => character + characters[index + 1]);
  });
  return [...new Set([...words.filter((word) => word.length > 1), ...grams])];
}

function relevantClaim(input: AuthorizedStudentHelpContext, claim: LearnerContextClaim): boolean {
  if (claim.validity !== "active" && claim.validity !== "contested") return false;
  if (claim.activityVersionId && claim.activityVersionId !== input.activity.activityVersionId) return false;
  return input.activity.content.content.goals.some((goal) =>
    goal.competencyId === claim.competencyId && goal.competencyVersion === claim.competencyVersion);
}
