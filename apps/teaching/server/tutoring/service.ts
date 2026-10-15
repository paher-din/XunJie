import type {
  AuthorizedStudentHelpContext,
  StudentHelpExecutionResult,
  TutoringFailure,
} from "../../contracts/tutoring/index.ts";
import type { Job } from "../../contracts/records/index.ts";
import { claimJob, recordModelCall,renewModelActivity } from "../records/jobs.ts";
import { generateStudentHelp } from "./core.ts";
import {
  assembleStudentHelpRequest,
  createStudentHelpCurrentGuard,
  type StudentHelpCurrentState,
} from "./context.ts";
import {
  InputLimitError,
  ProviderCallNotStartedError,
  type ModelProvider,
} from "./providers.ts";

export type StudentHelpJobUpdater = (
  jobId: string,
  update: (current: Job) => Job,
) => Job | Promise<Job>;

export type AuthorizedStudentHelpRuntime = {
  provider: ModelProvider;
  leaseToken: string;
  budgetAvailable: () => boolean;
  updateJob: StudentHelpJobUpdater;
  readCurrent: (signal: AbortSignal) => StudentHelpCurrentState | Promise<StudentHelpCurrentState>;
  signal?: AbortSignal;
  now?: () => number;
  maximumCalls?:number;
  inactivityTimeoutMs?:number;
};

/**
 * B2's trusted execution seam. C3 supplies the persisted Job lease/current-state
 * reader and consumes the returned envelope in its own acceptance transaction.
 * This function does not persist, deliver, acknowledge, or mutate student work.
 */
export async function executeAuthorizedStudentHelp(
  input: AuthorizedStudentHelpContext,
  runtime: AuthorizedStudentHelpRuntime,
): Promise<StudentHelpExecutionResult> {
  const studentId = input.job.scope.studentId;
  const attemptId = input.job.scope.attemptId;
  if (!studentId || !attemptId) {
    throw new ProviderCallNotStartedError("stale", "Student help scope is incomplete");
  }
  const now = runtime.now ?? Date.now;
  let trustedJob: Job;
  try {
    trustedJob = assertSameJob(input.job, await updateJob(runtime, input.job.jobId, (current) => {
      assertSameJob(input.job, current);
      if (runtime.signal?.aborted || current.stopRequested || current.status === "cancelled") {
        throw new ProviderCallNotStartedError("cancelled", "Student help was stopped before claim");
      }
      if (Date.parse(current.deadline) <= now()) {
        throw new ProviderCallNotStartedError("timed_out", "Student help deadline expired before claim");
      }
      if (current.status === "queued") {
        return claimJob(
          current,
          runtime.leaseToken,
          current.deadline,
          current.recoveryGeneration,
          new Date(now()).toISOString(),
        );
      }
      if (current.status !== "running" || current.leaseToken !== runtime.leaseToken) {
        throw new ProviderCallNotStartedError("stale", "Student help lease is not current");
      }
      return current;
    }));
  } catch (error) {
    const notStarted = error instanceof ProviderCallNotStartedError
      ? error
      : new ProviderCallNotStartedError("unavailable", "Unable to claim student help job");
    return executionResult(input, [], input.versions, failureForNotStarted(notStarted));
  }
  const authorizedInput = { ...input, job: trustedJob };
  const request = assembleStudentHelpRequest(authorizedInput, runtime.signal);
  const provider = persistedCallProvider(authorizedInput, runtime, now);
  const outcome = await generateStudentHelp(request, {
    provider,
    checkCurrent: createStudentHelpCurrentGuard(authorizedInput, runtime.readCurrent),
    priorCalls: trustedJob.attemptCount,
    now,
    ...(runtime.maximumCalls?{maximumCalls:runtime.maximumCalls}:{}),
    ...(runtime.inactivityTimeoutMs?{inactivityTimeoutMs:runtime.inactivityTimeoutMs}:{}),
  });
  return executionResult(input, request.context.authorizedReferenceIds, request.context.versions, outcome);
}

function executionResult(
  input: AuthorizedStudentHelpContext,
  authorizedReferenceIds: readonly string[],
  versions: AuthorizedStudentHelpContext["versions"],
  outcome: StudentHelpExecutionResult["outcome"],
): StudentHelpExecutionResult {
  const studentId = input.job.scope.studentId;
  const attemptId = input.job.scope.attemptId;
  if (!studentId || !attemptId) throw new ProviderCallNotStartedError("stale", "Student help scope is incomplete");
  return {
    jobId: input.job.jobId,
    requestReceiptId: input.job.requestReceiptId,
    scope: {
      courseId: input.job.scope.courseId,
      userId: studentId,
      attemptId,
    },
    expectedAttemptRevision: input.job.expectedRevision,
    decisionEpoch: input.job.decisionEpoch,
    activityVersionId: input.activity.activityVersionId,
    helpPolicyVersionId: input.activity.helpPolicy.versionId,
    learnerStateRevision: input.learnerStateRevision,
    ...(input.objectRef ? { objectRef: structuredClone(input.objectRef) } : {}),
    authorizedReferenceIds: [...authorizedReferenceIds],
    versions: structuredClone(versions),
    outcome,
  };
}

function failureForNotStarted(error: ProviderCallNotStartedError): TutoringFailure {
  const mapped = error.outcome === "budget_exhausted"
    ? { outcome: "budget_exhausted" as const, code: "CALL_LIMIT_EXCEEDED" }
    : error.outcome === "cancelled"
      ? { outcome: "cancelled" as const, code: "CANCELLED" }
      : error.outcome === "stale"
        ? { outcome: "stale" as const, code: "STALE_CONTEXT" }
        : error.outcome === "timed_out"
          ? { outcome: "timed_out" as const, code: "DEADLINE_EXCEEDED" }
          : { outcome: "unavailable" as const, code: "DEPENDENCY_UNAVAILABLE" };
  return {
    ...mapped,
    retryable: error.outcome === "unavailable",
    calls: 0,
    usage: { status: "unknown" },
  };
}

function persistedCallProvider(
  input: AuthorizedStudentHelpContext,
  runtime: AuthorizedStudentHelpRuntime,
  now: () => number,
): ModelProvider {
  let renewedAt=0;
  return {
    async generate(request) {
      let reservedCount = -1;
      let budgetAvailable: boolean;
      try {
        budgetAvailable = runtime.budgetAvailable();
      } catch {
        throw new ProviderCallNotStartedError("unavailable", "Unable to read the current model budget");
      }
      if (!budgetAvailable) {
        throw new ProviderCallNotStartedError("budget_exhausted", "Student help model budget is exhausted");
      }
      try {
        const reserved = await updateJob(runtime, input.job.jobId, (current) => {
          assertSameJob(input.job, current);
          if (current.stopRequested || current.status === "cancelled") {
            throw new ProviderCallNotStartedError("cancelled", "Student help was stopped");
          }
          if (current.attemptCount >= (runtime.maximumCalls??3)) {
            throw new ProviderCallNotStartedError("budget_exhausted", "Student help call budget is exhausted");
          }
          if (Date.parse(current.deadline) <= now()) {
            throw new ProviderCallNotStartedError("timed_out", "Student help deadline expired");
          }
          if (current.status !== "running" || current.leaseToken !== runtime.leaseToken) {
            throw new ProviderCallNotStartedError("stale", "Student help lease changed");
          }
          return recordModelCall(
            current,
            runtime.leaseToken,
            current.recoveryGeneration,
            new Date(now()).toISOString(),
          );
        });
        reservedCount = reserved.attemptCount;
      } catch (error) {
        if (error instanceof ProviderCallNotStartedError) throw error;
        throw new ProviderCallNotStartedError("unavailable", "Unable to persist model call reservation");
      }

      try {
        return await runtime.provider.generate({...request,...(input.job.inactivityTimeoutMs?{onActivity:async()=>{
          const stamp=now();if(stamp-renewedAt<5000)return;
          await updateJob(runtime,input.job.jobId,current=>{
            assertSameJob(input.job,current);
            return renewModelActivity(current,runtime.leaseToken,input.job.recoveryGeneration,new Date(stamp).toISOString());
          });renewedAt=stamp;
        }}:{})});
      } catch (error) {
        if (error instanceof InputLimitError || error instanceof ProviderCallNotStartedError && error.reservation==='none') {
          try {
            await updateJob(runtime, input.job.jobId, (current) => {
              assertSameJob(input.job, current);
              if (
                current.status !== "running" ||
                current.leaseToken !== runtime.leaseToken ||
                current.attemptCount !== reservedCount
              ) {
                throw new ProviderCallNotStartedError("stale", "Cannot release a changed model call reservation");
              }
              return { ...current, attemptCount: current.attemptCount - 1 };
            });
          } catch (releaseError) {
            // The reservation survived this release attempt, so the call keeps its budget slot; a
            // changed lease or attemptCount means someone else already reconciled it.
            if (releaseError instanceof ProviderCallNotStartedError) throw releaseError.withReservation("held");
            throw new ProviderCallNotStartedError("unavailable", "Unable to release unsent model call reservation", "held");
          }
          if(error instanceof ProviderCallNotStartedError)throw error.withReservation('released');
        }
        throw error;
      }
    },
  };
}

async function updateJob(
  runtime: AuthorizedStudentHelpRuntime,
  jobId: string,
  update: (current: Job) => Job,
) {
  return await runtime.updateJob(jobId, update);
}

function assertSameJob(expected: Job, current: Job) {
  if (
    current.jobId !== expected.jobId ||
    current.purpose !== "student_help" ||
    current.scope.courseId !== expected.scope.courseId ||
    current.scope.studentId !== expected.scope.studentId ||
    current.scope.attemptId !== expected.scope.attemptId ||
    current.requestReceiptId !== expected.requestReceiptId ||
    current.expectedRevision !== expected.expectedRevision ||
    current.decisionEpoch !== expected.decisionEpoch ||
    current.recoveryGeneration !== expected.recoveryGeneration ||
    current.acceptedAt !== expected.acceptedAt ||
    current.inactivityTimeoutMs !== expected.inactivityTimeoutMs ||
    !expected.inactivityTimeoutMs&&current.deadline !== expected.deadline
  ) {
    throw new ProviderCallNotStartedError("stale", "Student help job identity changed");
  }
  return current;
}
