import type { Job } from "../../contracts/records/index.ts";
import type {
  StudentHelpCommandInput,
  StudentHelpCommandResult,
} from "../../contracts/tutoring/index.ts";
import { RunnerError } from "../../runner/snapshot.ts";
import { requestHash, resolveCommandReceipt, onlyFields } from "../records/commands.ts";
import { cancelJob, enqueueJob } from "../records/jobs.ts";
import type { CommandContext, WorkspaceState } from "../workspace/commands.ts";
import { completeCommand, guardCommand } from "../workspace/commands.ts";
import { validateText } from "../workspace/files.ts";
import { beginExplicitOperation, validateObjectRef } from "../workspace/snapshots.ts";

export type StudentHelpPolicyState = {
  helpAllowed: boolean;
  limitedCheck: boolean;
  resources: readonly { resourceVersionId: string; paragraphId: string }[];
};

export function acceptStudentHelpCommand(
  state: WorkspaceState,
  context: CommandContext,
  input: StudentHelpCommandInput,
  policy: StudentHelpPolicyState,
  jobId: string,
  deadline: string,
) {
  guardCommand(state, context);
  onlyFields(input, ["expectedAttemptRevision", "recoveryGeneration", "question", "objectRef"]);
  if (input.recoveryGeneration !== context.generation) {
    throw new RunnerError("RECOVERY_REQUIRED", "Stale help generation");
  }
  validateText(input.question);
  if (!input.question.trim()) throw new RunnerError("INVALID_REQUEST", "Student question required");

  const hash = requestHash(context.identity.target, input);
  const previous = resolveCommandReceipt(state.records, context.identity, hash, context.generation);
  if (previous) return completeCommand(state, context, hash, previous.result, "student_help_requested");
  if (!policy.helpAllowed || policy.limitedCheck) {
    throw new RunnerError("STATE_CONFLICT", "Student help is disabled by the current policy");
  }
  if (input.objectRef) {
    validateObjectRef(state.attempt, input.objectRef, {
      snapshots: state.snapshots,
      runs: state.runs.map((row) => ({
        runId: row.runId,
        snapshotId: row.submission.snapshot.snapshotId,
        attemptId: state.attempt.attemptId,
      })),
      resources: [...policy.resources],
    });
  }

  const activated = beginExplicitOperation(
    state.attempt,
    input.expectedAttemptRevision,
    context.assignmentActive,
  );
  const activatedWithoutPosition = structuredClone(activated);
  delete activatedWithoutPosition.returnPosition;
  const attempt = {
    ...activatedWithoutPosition,
    question: input.question,
    ...(input.objectRef ? { returnPosition: structuredClone(input.objectRef) } : {}),
    decisionEpoch: activated.decisionEpoch + 1,
    attemptRevision:
      activated.attemptRevision === state.attempt.attemptRevision
        ? activated.attemptRevision + 1
        : activated.attemptRevision,
  };
  const terminal = new Set(["succeeded", "failed", "cancelled", "stale", "timed_out"]);
  const replacedJobIds: string[] = [];
  const replacedJobs = state.records.jobs.map((existing) => {
    if (
      existing.scope.courseId !== context.identity.scope.courseId ||
      existing.scope.studentId !== context.identity.scope.studentId ||
      existing.scope.attemptId !== context.identity.scope.attemptId ||
      (existing.purpose !== "student_help" && existing.purpose !== "reminder") ||
      existing.stopRequested ||
      terminal.has(existing.status)
    ) return structuredClone(existing);
    replacedJobIds.push(existing.jobId);
    return cancelJob(existing);
  });
  const job: Job = {
    jobId,
    kind: "student_help",
    purpose: "student_help",
    scope: context.identity.scope,
    requestReceiptId: context.receiptId,
    status: "queued",
    stopRequested: false,
    expectedRevision: attempt.attemptRevision,
    decisionEpoch: attempt.decisionEpoch,
    recoveryGeneration: context.generation,
    acceptedAt: context.now,
    deadline,
    attemptCount: 0,
  };
  const records = {
    ...state.records,
    jobs: enqueueJob(replacedJobs, job),
  };
  const result: StudentHelpCommandResult = {
    jobId,
    attemptRevision: attempt.attemptRevision,
    decisionEpoch: attempt.decisionEpoch,
    replacedJobIds,
    acceptedInputHash: requestHash("student_help.accepted_input", {
      question: input.question,
      objectRef: input.objectRef ?? null,
    }),
  };
  return completeCommand(
    { ...state, attempt, records },
    context,
    hash,
    result,
    "student_help_requested",
  );
}
