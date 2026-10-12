import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import type {
  AssistanceContextRecord,
  AuthorizedStudentHelpContext,
  LearnerContextClaim,
  StudentHelpCommandInput,
  TrustedModelContext,
} from "../../contracts/tutoring/index.ts";
import { ApiError } from "../app/errors.ts";
import { parseRequest } from "../app/validation.ts";
import { assignmentAvailability, activityView, readActivity } from "../design/activities.ts";
import {
  finishRecordCommand,
  readAttempt,
  readRecordCommand,
  saveJob,
} from "../db/records-adapter.ts";
import type { Transaction } from "../db/transaction.ts";
import {
  createTeachingRecordsApp,
  type TeachingRecordsOptions,
} from "../records/application.ts";
import {
  acceptStudentQuestionInTransaction,
  readTeachingJob,
  readTeachingMessageByJob,
  saveTeachingJobInTransaction,
  stopTeachingJobsInTransaction,
} from "../records/teaching.ts";
import { readRunDiagnostics } from "../workspace/commands.ts";
import { requestHash } from "../records/commands.ts";
import { loadWorkspace } from "../workspace/storage.ts";
import { id, key, objectRef, params } from "../workspace/inputs.ts";
import { assembleStudentHelpRequest } from "./context.ts";
import {
  executeAuthorizedStudentHelp,
  type AuthorizedStudentHelpRuntime,
} from "./service.ts";

const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const natural = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const studentHelpCommandSchema = z.strictObject({
  expectedAttemptRevision: revision,
  recoveryGeneration: id,
  question: z.string().max(16_384),
  objectRef: objectRef.optional(),
});
const studentHelpCommandResultSchema = z.strictObject({
  jobId: id,
  attemptRevision: revision,
  decisionEpoch: natural,
  replacedJobIds: z.array(id),
  acceptedInputHash: z.string().regex(/^[a-f0-9]{64}$/),
});

function teachingVersions(
  activityVersionId: string,
  policyVersionId: string,
  versions: TrustedModelContext["versions"],
) {
  return {
    activityVersionId,
    policyVersionId,
    modelConfigVersion: versions.modelConfig,
    promptVersion: versions.prompt,
    schemaVersion: versions.schema,
  };
}

export type TutoringAppOptions = TeachingRecordsOptions & {
  studentHelp: {
    versions: TrustedModelContext["versions"];
    budgetAvailable: (scope: { courseId: string; studentId: string; attemptId: string }) => boolean;
  };
};
export type StudentHelpPreparationOptions = {
  learnerStateRevision?: number;
  learnerClaims?: readonly LearnerContextClaim[];
  assistanceHistory?: readonly AssistanceContextRecord[];
  signal?: AbortSignal;
};

export async function createTutoringApp(options: TutoringAppOptions) {
  const { studentHelp, ...recordsOptions } = options;
  const instance = await createTeachingRecordsApp(recordsOptions);
  const { app, access } = instance;
  const now = options.now ?? Date.now;
  const attemptId = (request: FastifyRequest) => parseRequest(params, request.params).id;
  const currentGeneration = (expected: string) => {
    if (!expected || options.currentGeneration() !== expected) throw new ApiError("RECOVERY_REQUIRED");
    return expected;
  };
  const locate = (tx: Transaction, idValue: string) => {
    const attempt = readAttempt(tx, idValue);
    const active = assignmentAvailability(
      tx,
      attempt.courseId,
      attempt.assignmentId,
      attempt.studentId,
    ).active;
    return {
      kind: "student_work" as const,
      courseId: attempt.courseId,
      studentId: attempt.studentId,
      stage: attempt.status,
      assignmentActive: active,
    };
  };

  app.post("/api/attempts/:id/help", (request) => {
    const idValue = attemptId(request);
    const parsed = parseRequest(studentHelpCommandSchema, request.body);
    const input = JSON.parse(JSON.stringify(parsed)) as StudentHelpCommandInput;
    if (!input.question.trim()) throw new ApiError("INVALID_REQUEST");
    const idempotencyKey = parseRequest(key, request.headers["idempotency-key"]);
    const data = access.withAuthorizedResource(
      request,
      (tx) => locate(tx, idValue),
      "student_help",
      (tx, actor) => {
        const generation = currentGeneration(input.recoveryGeneration);
        const target = request.url.split("?", 1)[0]!;
        const identity = {
          actorId: actor.userId,
          command: "student_help.create",
          target,
          scope: { courseId: actor.courseId, studentId: actor.userId, attemptId: idValue },
          idempotencyKey,
          recoveryGeneration: generation,
        };
        const previous = readRecordCommand(
          tx,
          identity,
          input,
          generation,
          (value) => studentHelpCommandResultSchema.parse(value),
        );
        if (previous) return { ...previous, replayed: true };

        const acceptedAtMs = now();
        const acceptedAt = new Date(acceptedAtMs).toISOString();
        const deadline = new Date(acceptedAtMs + 45_000).toISOString();
        const jobId = randomUUID();
        let plannedMessage: ReturnType<typeof acceptStudentQuestionInTransaction>["message"] | undefined;
        const receipt = finishRecordCommand(
          tx,
          identity,
          input,
          generation,
          now(),
          (receiptId) => {
            const before = readAttempt(tx, idValue);
            const activity = readActivity(tx, actor.courseId, before.activityVersionId);
            const versions = teachingVersions(activity.activityVersionId, activity.helpPolicy.versionId, studentHelp.versions);
            const accepted = acceptStudentQuestionInTransaction(tx, {
              scope: identity.scope,
              receiptId,
              now: acceptedAt,
              generation,
              question: input.question,
              ...(input.objectRef ? { objectRef: input.objectRef } : {}),
              inputRefs: [],
              versions,
              expectedRevision: input.expectedAttemptRevision,
            });
            plannedMessage = accepted.message;
            const reminders = stopTeachingJobsInTransaction(tx, {
              actorId: actor.userId,
              scope: identity.scope,
              purposes: ["reminder"],
              reason: "replaced_by_explicit_help",
              causeRef: receiptId,
              generation,
              now: acceptedAt,
              audit: false,
            });
            const acceptedAttempt = readAttempt(tx, idValue);
            return {
              jobId,
              attemptRevision: acceptedAttempt.attemptRevision,
              decisionEpoch: acceptedAttempt.decisionEpoch,
              replacedJobIds: [...new Set([...accepted.stoppedJobIds, ...reminders.jobIds])],
              acceptedInputHash: requestHash("student_help.accepted_input", {
                question: input.question,
                objectRef: input.objectRef ?? null,
              }),
            };
          },
          (value) => studentHelpCommandResultSchema.parse(value),
          (receiptId) => {
            if (!plannedMessage) throw new ApiError("PERSISTENCE_UNAVAILABLE");
            saveTeachingJobInTransaction(tx, {
              message: plannedMessage,
              jobId,
              receiptId,
              now: acceptedAt,
              generation,
              deadline,
              kind: "student_help",
            });
          },
        );
        currentGeneration(generation);
        return { ...receipt, replayed: false };
      },
    );
    return { requestId: request.id, data };
  });

  const authorizeStudentHelp = (
    request: FastifyRequest,
    idValue: string,
    jobId: string,
    preparation: StudentHelpPreparationOptions,
  ) => access.withAuthorizedResource(
        request,
        (tx) => locate(tx, idValue),
        "student_help",
        (tx, actor) => {
          const state = loadWorkspace(tx, idValue);
          const job = state.records.jobs.find((item) => item.jobId === jobId);
          if (!job || job.scope.courseId !== actor.courseId || job.scope.studentId !== actor.userId ||
            job.scope.attemptId !== idValue || job.purpose !== "student_help") {
            throw new ApiError("FORBIDDEN");
          }
          const receipt = state.records.receipts.find((item) => item.receiptId === job.requestReceiptId);
          const accepted = studentHelpCommandResultSchema.safeParse(receipt?.result);
          if (!receipt || !accepted.success || accepted.data.jobId !== job.jobId ||
            receipt.identity.command !== "student_help.create" ||
            receipt.identity.scope.attemptId !== idValue ||
            receipt.identity.scope.studentId !== actor.userId) {
            throw new ApiError("STATE_CONFLICT");
          }
          const questionMessage = readTeachingMessageByJob(tx, actor.courseId, job.jobId);
          if (!questionMessage || questionMessage.authorKind !== "student" ||
            questionMessage.envelope.kind !== "student_question") {
            throw new ApiError("STATE_CONFLICT");
          }
          const acceptedInput = {
            question: questionMessage.envelope.question,
            ...(questionMessage.envelope.objectRef ? { objectRef: questionMessage.envelope.objectRef } : {}),
          };
          if (accepted.data.acceptedInputHash !== requestHash("student_help.accepted_input", {
            question: acceptedInput.question,
            objectRef: acceptedInput.objectRef ?? null,
          })) {
            throw new ApiError("STATE_CONFLICT");
          }
          const activity = readActivity(tx, actor.courseId, state.attempt.activityVersionId);
          const projected = activityView(tx, actor, activity.activityVersionId, "tutor");
          const availability = assignmentAvailability(
            tx,
            state.attempt.courseId,
            state.attempt.assignmentId,
            state.attempt.studentId,
          );
          const limitedCheck = activity.checkRule.limitedHelp && state.checks.some((check) => check.state === "active");
          const diagnostics = state.runs.map((run) => {
            const value = readRunDiagnostics(state, run.runId, () => true);
            const optional = value as Record<string, unknown>;
            return {
              runId: value.runId,
              snapshotId: value.snapshotId,
              status: value.status === "available" ? "available" as const : "unavailable" as const,
              ...(typeof optional.failureKind === "string" ? { failureKind: optional.failureKind } : {}),
              ...(typeof optional.stdout === "string" ? { stdout: optional.stdout } : {}),
              ...(typeof optional.stderr === "string" ? { stderr: optional.stderr } : {}),
              ...(typeof optional.verdict === "string" ? { verdict: optional.verdict } : {}),
            };
          });
          const context: AuthorizedStudentHelpContext = {
            job,
            current: {
              attemptRevision: state.attempt.attemptRevision,
              decisionEpoch: state.attempt.decisionEpoch,
              captureRevision: state.attempt.captureRevision,
              activityVersionId: state.attempt.activityVersionId,
              helpPolicyVersionId: activity.helpPolicy.versionId,
              attemptStatus: state.attempt.status,
              assignmentActive: availability.active,
              limitedCheck,
              recoveryGeneration: options.currentGeneration(),
            },
            activity: projected,
            question: acceptedInput.question,
            ...(acceptedInput.objectRef
              ? { objectRef: structuredClone(acceptedInput.objectRef) }
              : {}),
            snapshots: state.snapshots,
            diagnostics,
            learnerStateRevision: preparation.learnerStateRevision ?? 0,
            learnerClaims: preparation.learnerClaims ?? [],
            assistanceHistory: preparation.assistanceHistory ?? [],
            budgetAvailable: studentHelp.budgetAvailable({
              courseId: actor.courseId,
              studentId: actor.userId,
              attemptId: idValue,
            }),
            versions: {
              ...studentHelp.versions,
              policy: activity.helpPolicy.versionId,
            },
          };
          return context;
        },
      );
  const tutoring = {
    authorizeStudentHelp,
    prepareStudentHelp(
      request: FastifyRequest,
      idValue: string,
      jobId: string,
      preparation: StudentHelpPreparationOptions,
    ) {
      return assembleStudentHelpRequest(
        authorizeStudentHelp(request, idValue, jobId, preparation),
        preparation.signal,
      );
    },
    async executeStudentHelp(
      request: FastifyRequest,
      idValue: string,
      jobId: string,
      preparation: StudentHelpPreparationOptions,
      runtime: Omit<AuthorizedStudentHelpRuntime, "updateJob" | "budgetAvailable">,
    ) {
      const authorized = authorizeStudentHelp(request, idValue, jobId, preparation);
      const updateJob: AuthorizedStudentHelpRuntime["updateJob"] = (expectedJobId, update) =>
        options.db.withTransaction((tx) => {
          currentGeneration(authorized.job.recoveryGeneration);
          const current = readTeachingJob(tx, authorized.job.scope.courseId, expectedJobId);
          if (!current || current.scope.studentId !== authorized.job.scope.studentId ||
            current.scope.attemptId !== authorized.job.scope.attemptId) {
            throw new ApiError("STATE_CONFLICT");
          }
          const next = update(current);
          saveJob(tx, next);
          currentGeneration(authorized.job.recoveryGeneration);
          return next;
        });
      const readCurrent: AuthorizedStudentHelpRuntime["readCurrent"] = async (signal) => {
        const state = await runtime.readCurrent(signal);
        const job = options.db.withTransaction((tx) =>
          readTeachingJob(tx, authorized.job.scope.courseId, authorized.job.jobId));
        if (!job) throw new ApiError("STATE_CONFLICT");
        return {
          ...state,
          jobStatus: job.status,
          stopRequested: job.stopRequested,
          recoveryGeneration: job.recoveryGeneration,
        };
      };
      const studentId = authorized.job.scope.studentId;
      const authorizedAttemptId = authorized.job.scope.attemptId;
      if (!studentId || !authorizedAttemptId) throw new ApiError("STATE_CONFLICT");
      const execution = await executeAuthorizedStudentHelp(authorized, {
        ...runtime,
        budgetAvailable: () => studentHelp.budgetAvailable({
          courseId: authorized.job.scope.courseId,
          studentId,
          attemptId: authorizedAttemptId,
        }),
        readCurrent,
        updateJob,
      });
      if (execution.outcome.outcome !== "success") return execution;
      const bodyJson = JSON.stringify(execution.outcome.body);
      const completeTeaching = instance.workspace.teaching.completeTeaching;
      if (!completeTeaching) throw new ApiError("DEPENDENCY_UNAVAILABLE");
      const delivery = completeTeaching(request, idValue, {
        recoveryGeneration: authorized.job.recoveryGeneration,
        jobId: authorized.job.jobId,
        leaseToken: runtime.leaseToken,
        bodyJson,
        versions: teachingVersions(
          authorized.activity.activityVersionId,
          authorized.activity.helpPolicy.versionId,
          execution.versions,
        ),
        usage: execution.outcome.usage.status === "actual"
          ? execution.outcome.usage
          : { status: "unknown" as const, reason: "provider_status_unknown" },
        calls: execution.outcome.calls,
        elapsedMs: execution.outcome.elapsedMs,
        basis: {
          attemptRevision: authorized.job.expectedRevision,
          decisionEpoch: authorized.job.decisionEpoch,
          captureRevision: authorized.current.captureRevision,
          relatedStateRevision: authorized.learnerStateRevision,
          ...(authorized.objectRef ? { objectRef: authorized.objectRef } : {}),
          inputRefs: execution.authorizedReferenceIds.filter((referenceId) => !referenceId.startsWith("assistance:")),
          assistanceRefs: execution.authorizedReferenceIds.filter((referenceId) => referenceId.startsWith("assistance:")),
          coverageRefs: [],
        },
      });
      return { ...execution, delivery };
    },
  };

  return { ...instance, tutoring };
}
