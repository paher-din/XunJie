import type {
  AuthorizedStudentHelpContext,
  StudentHelpExecutionResult,
} from "../../contracts/tutoring/index.ts";
import { generateStudentHelp } from "./core.ts";
import {
  assembleStudentHelpRequest,
  createStudentHelpCurrentGuard,
  type StudentHelpCurrentState,
} from "./context.ts";
import type { ModelProvider } from "./providers.ts";

export type AuthorizedStudentHelpRuntime = {
  provider: ModelProvider;
  readCurrent: (signal: AbortSignal) => StudentHelpCurrentState | Promise<StudentHelpCurrentState>;
  signal?: AbortSignal;
  now?: () => number;
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
  const request = assembleStudentHelpRequest(input, runtime.signal);
  const outcome = await generateStudentHelp(request, {
    provider: runtime.provider,
    checkCurrent: createStudentHelpCurrentGuard(input, runtime.readCurrent),
    ...(runtime.now ? { now: runtime.now } : {}),
  });
  return {
    jobId: input.job.jobId,
    requestReceiptId: input.job.requestReceiptId,
    scope: {
      courseId: input.job.scope.courseId,
      userId: input.job.scope.studentId!,
      attemptId: input.job.scope.attemptId!,
    },
    expectedAttemptRevision: input.job.expectedRevision,
    decisionEpoch: input.job.decisionEpoch,
    activityVersionId: input.activity.activityVersionId,
    helpPolicyVersionId: input.activity.helpPolicy.versionId,
    learnerStateRevision: input.learnerStateRevision,
    ...(input.objectRef ? { objectRef: structuredClone(input.objectRef) } : {}),
    authorizedReferenceIds: [...request.context.authorizedReferenceIds],
    versions: structuredClone(request.context.versions),
    outcome,
  };
}
