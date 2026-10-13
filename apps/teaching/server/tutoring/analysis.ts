import type { Job } from "../../contracts/records/index.ts";
import type { AnalysisBinding } from "../../contracts/review/index.ts";
import type {
  LearnerAnalysisRequest,
  LearnerAnalysisTarget,
  TutoringOutcome,
  LearnerAnalysisBody,
  UntrustedReference,
} from "../../contracts/tutoring/index.ts";
import { CALL_VERDICT_WINDOW_MS, generateLearnerAnalysis, type CurrentGuard } from "./core.ts";
import {
  InputLimitError,
  ProviderCallNotStartedError,
  type ModelProvider,
  type ProviderRequest,
  type ProviderResponse,
} from "./providers.ts";

export type ClaimedLearnerAnalysis = {
  job: Job;
  binding: AnalysisBinding;
  leaseToken: string;
};

export type LearnerAnalysisCurrentState = {
  jobStatus: Job["status"];
  stopRequested: boolean;
  leaseToken?: string;
  leaseUntil?: string;
  recoveryGeneration: string;
  attemptRevision: number;
  decisionEpoch: number;
  learnerStateRevision: number;
  contextRevision: number;
  captureRevision: number;
  activityVersionId: string;
  policyVersionId: string;
  versions: AnalysisBinding["versions"];
};

export type ClaimedLearnerAnalysisRuntime = {
  provider: ModelProvider;
  readCurrent: (signal: AbortSignal) => LearnerAnalysisCurrentState | Promise<LearnerAnalysisCurrentState>;
  recordModelCall: (signal: AbortSignal) => void | Promise<void>;
  releaseModelCall: (signal: AbortSignal) => void | Promise<void>;
  budgetAvailable: () => boolean;
  now?: () => number;
};

const MAX_LEARNER_ANALYSIS_MS = 45_000;

export function prepareLearnerAnalysisRequest(input: {
  claimed: ClaimedLearnerAnalysis;
  targets: readonly LearnerAnalysisTarget[];
  references: readonly UntrustedReference[];
  budgetAvailable: boolean;
  signal?: AbortSignal;
}): LearnerAnalysisRequest {
  const { job, binding, leaseToken } = input.claimed;
  if (
    job.kind !== "learner_analysis" ||
    !["explicit_analysis", "passive_analysis"].includes(job.purpose) ||
    binding.collectionPurpose !== job.purpose ||
    job.status !== "running" ||
    job.stopRequested ||
    !job.scope.studentId ||
    !job.scope.attemptId ||
    !job.leaseToken ||
    job.leaseToken !== leaseToken ||
    !job.leaseUntil ||
    !Number.isFinite(Date.parse(job.leaseUntil)) ||
    !Number.isFinite(Date.parse(job.acceptedAt)) ||
    !Number.isFinite(Date.parse(job.deadline)) ||
    Date.parse(job.deadline) <= Date.parse(job.acceptedAt) ||
    job.scope.courseId !== binding.scope.courseId ||
    job.scope.studentId !== binding.scope.studentId ||
    job.scope.attemptId !== binding.scope.attemptId ||
    job.expectedRevision !== binding.expectedAttemptRevision ||
    job.decisionEpoch !== binding.decisionEpoch
  ) {
    throw new Error("Claimed learner analysis does not match its trusted binding");
  }

  const boundReferenceIds = [
    ...binding.inputRefs,
    ...binding.assistanceRefs,
    ...binding.coverageRefs,
  ].map((reference) => reference.id);
  const suppliedReferenceIds = input.references.map((reference) => reference.id);
  const bound = new Set(boundReferenceIds);
  const supplied = new Set(suppliedReferenceIds);
  if (
    bound.size !== boundReferenceIds.length ||
    supplied.size !== suppliedReferenceIds.length ||
    supplied.size !== bound.size ||
    boundReferenceIds.some((referenceId) => !supplied.has(referenceId))
  ) {
    throw new Error("Learner analysis references must exactly match the trusted binding");
  }

  return {
    context: {
      jobId: job.jobId,
      purpose: "learner_analysis",
      scope: {
        courseId: binding.scope.courseId,
        userId: binding.scope.studentId,
        attemptId: binding.scope.attemptId,
      },
      authorizedReferenceIds: input.references.map((reference) => reference.id),
      acceptedAtMs: Date.parse(job.acceptedAt),
      deadlineAtMs: Date.parse(job.deadline),
      budgetAvailable: input.budgetAvailable,
      versions: {
        modelConfig: binding.versions.modelConfigVersion,
        prompt: binding.versions.promptVersion,
        schema: binding.versions.schemaVersion,
        policy: binding.policyVersionId,
      },
    },
    binding: structuredClone(binding),
    targets: structuredClone(input.targets),
    references: structuredClone(input.references),
    ...(input.signal ? { signal: input.signal } : {}),
  };
}

export function createLearnerAnalysisCurrentGuard(
  claimed: ClaimedLearnerAnalysis,
  readCurrent: ClaimedLearnerAnalysisRuntime["readCurrent"],
  now: () => number = Date.now,
): CurrentGuard {
  return async (signal) => {
    if (signal.aborted) return "cancelled";
    const current = await readCurrent(signal);
    if (
      signal.aborted ||
      current.stopRequested ||
      current.jobStatus === "cancelling" ||
      current.jobStatus === "cancelled"
    ) return "cancelled";
    const { job, binding } = claimed;
    if (
      current.jobStatus !== "running" ||
      current.leaseToken !== claimed.leaseToken ||
      !current.leaseUntil ||
      Date.parse(current.leaseUntil) <= now() ||
      current.recoveryGeneration !== job.recoveryGeneration ||
      current.attemptRevision !== binding.expectedAttemptRevision ||
      current.decisionEpoch !== binding.decisionEpoch ||
      current.learnerStateRevision !== binding.expectedStateRevision ||
      current.contextRevision !== binding.contextRevision ||
      (binding.collectionPurpose === "passive_analysis" && current.captureRevision !== binding.captureRevision) ||
      current.activityVersionId !== binding.activityVersionId ||
      current.policyVersionId !== binding.policyVersionId ||
      current.versions.modelConfigVersion !== binding.versions.modelConfigVersion ||
      current.versions.promptVersion !== binding.versions.promptVersion ||
      current.versions.schemaVersion !== binding.versions.schemaVersion ||
      current.versions.analysisVersion !== binding.versions.analysisVersion
    ) return "stale";
    return "current";
  };
}

export async function executeClaimedLearnerAnalysis(
  input: {
    claimed: ClaimedLearnerAnalysis;
    targets: readonly LearnerAnalysisTarget[];
    references: readonly UntrustedReference[];
    signal?: AbortSignal;
  },
  runtime: ClaimedLearnerAnalysisRuntime,
): Promise<TutoringOutcome<LearnerAnalysisBody>> {
  const now = runtime.now ?? Date.now;
  const effectiveDeadline = Math.min(
    Date.parse(input.claimed.job.deadline),
    Date.parse(input.claimed.job.acceptedAt) + MAX_LEARNER_ANALYSIS_MS,
  );
  const checkCurrent = createLearnerAnalysisCurrentGuard(input.claimed, runtime.readCurrent, now);
  const request = prepareLearnerAnalysisRequest({
    ...input,
    budgetAvailable: runtime.budgetAvailable(),
  });
  const provider: ModelProvider = {
    async generate(providerRequest: ProviderRequest): Promise<ProviderResponse> {
      if (!runtime.budgetAvailable()) {
        throw new ProviderCallNotStartedError("budget_exhausted", "Learner analysis budget is unavailable");
      }
      try {
        await runtime.recordModelCall(providerRequest.signal);
      } catch (error) {
        if (error instanceof ProviderCallNotStartedError) throw error;
        throw new ProviderCallNotStartedError("unavailable", "Unable to persist learner analysis call reservation");
      }

      let notStarted: ProviderCallNotStartedError | undefined;
      try {
        if (providerRequest.signal.aborted) {
          notStarted = new ProviderCallNotStartedError("cancelled", "Learner analysis was cancelled before provider invocation");
        } else if (now() >= effectiveDeadline) {
          notStarted = new ProviderCallNotStartedError("timed_out", "Learner analysis expired before provider invocation");
        } else {
          const current = await revalidateReservedModelCall(
            checkCurrent,
            providerRequest.signal,
            effectiveDeadline,
            now,
          );
          if (providerRequest.signal.aborted || current === "cancelled") {
            notStarted = new ProviderCallNotStartedError("cancelled", "Learner analysis was cancelled before provider invocation");
          } else if (now() >= effectiveDeadline) {
            notStarted = new ProviderCallNotStartedError("timed_out", "Learner analysis expired before provider invocation");
          } else if (current === "stale") {
            notStarted = new ProviderCallNotStartedError("stale", "Learner analysis became stale before provider invocation");
          } else if (!runtime.budgetAvailable()) {
            notStarted = new ProviderCallNotStartedError("budget_exhausted", "Learner analysis budget was withdrawn before provider invocation");
          }
        }
      } catch (error) {
        notStarted = error instanceof ProviderCallNotStartedError
          ? error
          : new ProviderCallNotStartedError("unavailable", "Unable to revalidate learner analysis before provider invocation");
      }
      if (notStarted) {
        await releaseUnsentModelCall(runtime);
        throw notStarted.withReservation("released");
      }

      try {
        return await runtime.provider.generate(providerRequest);
      } catch (error) {
        if (!(error instanceof InputLimitError)) throw error;
        await releaseUnsentModelCall(runtime);
        throw error;
      }
    },
  };
  return generateLearnerAnalysis(request, {
    provider,
    checkCurrent,
    priorCalls: input.claimed.job.attemptCount,
    // This wrapper reserves a persistent call before sending, so the loop may wait for its verdict
    // instead of billing a cancellation that provably never reached the provider.
    callVerdictWindowMs: CALL_VERDICT_WINDOW_MS,
    ...(runtime.now ? { now: runtime.now } : {}),
  });
}

async function revalidateReservedModelCall(
  checkCurrent: CurrentGuard,
  signal: AbortSignal,
  effectiveDeadline: number,
  now: () => number,
): Promise<Awaited<ReturnType<CurrentGuard>>> {
  if (signal.aborted) {
    throw new ProviderCallNotStartedError("cancelled", "Learner analysis was cancelled before provider invocation");
  }
  const remainingMs = effectiveDeadline - now();
  if (remainingMs <= 0) {
    throw new ProviderCallNotStartedError("timed_out", "Learner analysis expired before provider invocation");
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let removeAbort: (() => void) | undefined;
  const boundary = new Promise<never>((_, reject) => {
    const onAbort = () => reject(new ProviderCallNotStartedError(
      "cancelled",
      "Learner analysis was cancelled before provider invocation",
    ));
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbort = () => signal.removeEventListener("abort", onAbort);
    timeout = setTimeout(() => reject(new ProviderCallNotStartedError(
      "timed_out",
      "Learner analysis expired before provider invocation",
    )), remainingMs);
  });

  try {
    return await Promise.race([checkCurrent(signal), boundary]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    removeAbort?.();
  }
}

async function releaseUnsentModelCall(runtime: ClaimedLearnerAnalysisRuntime): Promise<void> {
  try {
    await runtime.releaseModelCall(new AbortController().signal);
  } catch (error) {
    // An unconfirmed release leaves the reservation holding budget, so the call must stay counted
    // and enter the existing unknown-result reconciliation instead of returning budget it still owes.
    if (error instanceof ProviderCallNotStartedError) throw error.withReservation("held");
    throw new ProviderCallNotStartedError("unavailable", "Unable to release an unsent learner analysis call", "held");
  }
}
