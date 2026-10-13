import type { Job } from "../../contracts/records/index.ts";
import type { AnalysisBinding } from "../../contracts/review/index.ts";
import type {
  LearnerAnalysisRequest,
  LearnerAnalysisTarget,
  TutoringOutcome,
  LearnerAnalysisBody,
  UntrustedReference,
} from "../../contracts/tutoring/index.ts";
import { generateLearnerAnalysis, type CurrentGuard } from "./core.ts";
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

  const allowed = new Set([
    ...binding.inputRefs,
    ...binding.assistanceRefs,
    ...binding.coverageRefs,
  ].map((reference) => reference.id));
  if (input.references.some((reference) => !allowed.has(reference.id))) {
    throw new Error("Learner analysis reference is outside the trusted binding");
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
      try {
        return await runtime.provider.generate(providerRequest);
      } catch (error) {
        if (!(error instanceof InputLimitError)) throw error;
        try {
          await runtime.releaseModelCall(providerRequest.signal);
        } catch (releaseError) {
          if (releaseError instanceof ProviderCallNotStartedError) throw releaseError;
          throw new ProviderCallNotStartedError("unavailable", "Unable to release an unsent learner analysis call");
        }
        throw error;
      }
    },
  };
  return generateLearnerAnalysis(request, {
    provider,
    checkCurrent: createLearnerAnalysisCurrentGuard(input.claimed, runtime.readCurrent, runtime.now),
    priorCalls: input.claimed.job.attemptCount,
    ...(runtime.now ? { now: runtime.now } : {}),
  });
}
