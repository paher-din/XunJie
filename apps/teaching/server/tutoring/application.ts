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
import { readAttempt } from "../db/records-adapter.ts";
import type { Transaction } from "../db/transaction.ts";
import type { DesignAppOptions } from "../design/application.ts";
import { createWorkspaceApp } from "../workspace/application.ts";
import { readRunDiagnostics } from "../workspace/commands.ts";
import type { CommandContext } from "../workspace/commands.ts";
import { requestHash } from "../records/commands.ts";
import { loadWorkspace, persistWorkspace } from "../workspace/storage.ts";
import { id, key, objectRef, params } from "../workspace/inputs.ts";
import { acceptStudentHelpCommand } from "./commands.ts";
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

export type TutoringAppOptions = DesignAppOptions;
export type StudentHelpPreparationOptions = {
  learnerStateRevision?: number;
  learnerClaims?: readonly LearnerContextClaim[];
  assistanceHistory?: readonly AssistanceContextRecord[];
  budgetAvailable: boolean;
  versions: TrustedModelContext["versions"];
  signal?: AbortSignal;
};

export async function createTutoringApp(options: TutoringAppOptions) {
  const instance = await createWorkspaceApp(options);
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
    const idempotencyKey = parseRequest(key, request.headers["idempotency-key"]);
    const data = access.withAuthorizedResource(
      request,
      (tx) => locate(tx, idValue),
      "student_help",
      (tx, actor, scope) => {
        const generation = currentGeneration(input.recoveryGeneration);
        const before = loadWorkspace(tx, idValue, {
          actorId: actor.userId,
          command: "student_help.create",
          target: request.url.split("?", 1)[0]!,
          scope: {
            courseId: actor.courseId,
            studentId: actor.userId,
            attemptId: idValue,
          },
          idempotencyKey,
          recoveryGeneration: generation,
        });
        const context: CommandContext = {
          identity: {
            actorId: actor.userId,
            command: "student_help.create",
            target: request.url.split("?", 1)[0]!,
            scope: {
              courseId: actor.courseId,
              studentId: actor.userId,
              attemptId: idValue,
            },
            idempotencyKey,
            recoveryGeneration: generation,
          },
          generation,
          now: new Date(now()).toISOString(),
          commandId: randomUUID(),
          receiptId: randomUUID(),
          eventId: randomUUID(),
          assignmentActive: scope.kind === "student_work" && scope.assignmentActive,
          authorize: () => true,
        };
        const activity = readActivity(tx, actor.courseId, before.attempt.activityVersionId);
        const limitedCheck = activity.checkRule.limitedHelp && before.checks.some((check) => check.state === "active");
        const projected = activityView(tx, actor, activity.activityVersionId, "tutor");
        const resources = projected.content.materials.flatMap((material) => material.status === "available"
          ? material.paragraphs.flatMap((paragraph) => paragraph.paragraphId
            ? [{ resourceVersionId: material.resourceVersionId, paragraphId: paragraph.paragraphId }]
            : [])
          : []);
        const plan = acceptStudentHelpCommand(
          before,
          context,
          input,
          {
            helpAllowed: activity.helpPolicy.helpAllowed,
            limitedCheck,
            resources,
          },
          randomUUID(),
          new Date(now() + 45_000).toISOString(),
        );
        persistWorkspace(tx, before, plan.state);
        currentGeneration(generation);
        return { ...plan.receipt, replayed: plan.replayed };
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
            throw new Error("Invalid persisted student help request binding.");
          }
          const acceptedInput = {
            question: state.attempt.question ?? "",
            ...(state.attempt.returnPosition ? { objectRef: state.attempt.returnPosition } : {}),
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
            budgetAvailable: preparation.budgetAvailable,
            versions: preparation.versions,
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
    executeStudentHelp(
      request: FastifyRequest,
      idValue: string,
      jobId: string,
      preparation: StudentHelpPreparationOptions,
      runtime: AuthorizedStudentHelpRuntime,
    ) {
      return executeAuthorizedStudentHelp(
        authorizeStudentHelp(request, idValue, jobId, preparation),
        runtime,
      );
    },
  };

  return { ...instance, tutoring };
}
