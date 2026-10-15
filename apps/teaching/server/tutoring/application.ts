import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import type {
  AssistanceContextRecord,
  AuthorizedStudentHelpContext,
  LearnerContextClaim,
  StudentHelpCommandInput,
  StudentHelpExecutionResult,
  StudentHelpBody,
  TrustedModelContext,
} from "../../contracts/tutoring/index.ts";
import { ApiError } from "../app/errors.ts";
import { assertResourceUse } from "../access/resource.ts";
import type { ActorContext, ResourceUse } from "../../contracts/access/index.ts";
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
  completeTeachingInTransaction,
  readTeachingJob,
  readTeachingMessageByJob,
  readTeachingRecordsInTransaction,
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
import type { ModelProvider } from "./providers.ts";
import type { StudentHelpCurrentState } from "./context.ts";
import type { TeachingBasisCurrent } from '../records/teaching.ts';
import { hdlHelpSelectionSchema,type HdlHelpSelection,type HdlHelpBasis } from '../../contracts/workspace/hdl-help.ts';
import type { AuthorizedHdlHelpContext } from '../../contracts/tutoring/index.ts';
import { projectHdlHelpCurrentState } from './context.ts';
import { canonical } from '../records/commands.ts';

const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const natural = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const studentHelpCommandSchema = z.strictObject({
  expectedAttemptRevision: revision,
  expectedModelConfigRevision:natural.optional(),
  recoveryGeneration: id,
  question: z.string().max(16_384),
  objectRef: objectRef.optional(),
  hdlSelection:hdlHelpSelectionSchema.optional(),
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

export type LearnerStateReader = (tx: Transaction,scope: {courseId: string;studentId: string;attemptId: string}) => {
  learnerStateRevision: number;learnerClaims: readonly LearnerContextClaim[];
};

export type TutoringAppOptions = TeachingRecordsOptions & {
  studentHelp: {
    versions: TrustedModelContext["versions"];
    /** Trusted personal configuration, selected on acceptance and captured before dispatch. */
    versionsForStudent?: (studentId:string)=>TrustedModelContext["versions"];
    modelConfigRevisionForStudent?:(studentId:string)=>number;
    providerForStudent?: (studentId:string,modelConfigVersion:string)=>ModelProvider;
    requestLimits?:{inactivityTimeoutMs?:number;maximumCalls:number};
    readLearnerState?: LearnerStateReader;
    readLearnerStateRevision?: (tx: Transaction,scope: {courseId: string;studentId: string;attemptId: string}) => number;
    readHdlContext?:(tx:Transaction,actor:ActorContext,attemptId:string,selection:HdlHelpSelection,generation:string)=>AuthorizedHdlHelpContext;
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
  const readLearnerRevision = studentHelp.readLearnerStateRevision ?? (studentHelp.readLearnerState
    ? (tx: Transaction,scope: {courseId: string;studentId: string;attemptId: string}) => studentHelp.readLearnerState!(tx,scope).learnerStateRevision
    : undefined);
  const isTeachingBasisCurrent:TeachingBasisCurrent=(tx,scope,basis)=>{
    if(readLearnerRevision&&readLearnerRevision(tx,scope)!==basis.relatedStateRevision)return false;
    if(!(recordsOptions.isTeachingBasisCurrent?.(tx,scope,basis)??true))return false;
    if(!basis.hdl)return true;
    if(!studentHelp.readHdlContext)return false;
    try{
      const hdl=studentHelp.readHdlContext(tx,{userId:scope.studentId,courseId:scope.courseId,role:'student'},scope.attemptId,
        {snapshotId:basis.hdl.snapshotId,buildId:basis.hdl.buildId,
          ...(basis.hdl.sessionId?{sessionId:basis.hdl.sessionId}:{}),...(basis.hdl.operationId?{operationId:basis.hdl.operationId}:{})},options.currentGeneration());
      return canonical(projectHdlHelpCurrentState(hdl))===canonical(basis.hdl);
    }catch(error){if(error instanceof ApiError)return false;throw error;}
  };
  const instance = await createTeachingRecordsApp({...recordsOptions,
    isTeachingBasisCurrent,
  });
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
        if(input.expectedModelConfigRevision!==undefined&&input.expectedModelConfigRevision!==studentHelp.modelConfigRevisionForStudent?.(actor.userId))
          throw new ApiError('VERSION_CONFLICT');
        let acceptedHdlBasis:HdlHelpBasis|undefined;
        if(input.hdlSelection){
          if(!studentHelp.readHdlContext)throw new ApiError('DEPENDENCY_UNAVAILABLE');
          const selected=studentHelp.readHdlContext(tx,actor,idValue,input.hdlSelection,generation);
          acceptedHdlBasis=projectHdlHelpCurrentState(selected);
          if(input.objectRef?.kind==='code'&&input.objectRef.snapshotId!==selected.snapshotId
            ||input.objectRef?.kind==='run')throw new ApiError('INVALID_REFERENCE');
        }

        const acceptedAtMs = now();
        const acceptedAt = new Date(acceptedAtMs).toISOString();
        const deadline = new Date(acceptedAtMs + (studentHelp.requestLimits?.inactivityTimeoutMs??45_000)).toISOString();
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
            const versions = teachingVersions(activity.activityVersionId, activity.helpPolicy.versionId,
              studentHelp.versionsForStudent?.(actor.userId)??studentHelp.versions);
            const accepted = acceptStudentQuestionInTransaction(tx, {
              scope: identity.scope,
              receiptId,
              now: acceptedAt,
              generation,
              question: input.question,
              ...(input.objectRef ? { objectRef: input.objectRef } : {}),
              ...(input.hdlSelection?{hdlSelection:input.hdlSelection}:{}),
              ...(acceptedHdlBasis?{hdlBasis:acceptedHdlBasis}:{}),
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
                ...(input.hdlSelection?{hdlSelection:input.hdlSelection}:{}),
                ...(acceptedHdlBasis?{hdlBasis:acceptedHdlBasis}:{}),
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
              ...(studentHelp.requestLimits?.inactivityTimeoutMs?{inactivityTimeoutMs:studentHelp.requestLimits.inactivityTimeoutMs}:{}),
            });
          },
        );
        currentGeneration(generation);
        return { ...receipt, replayed: false };
      },
    );
    return { requestId: request.id, data };
  });

  // Only the trusted in-process consumer can omit a request. Its authority comes
  // from the original persisted Job, with current owner/membership rechecked in
  // every transaction; it never creates or impersonates a student Session.
  const withHelpTransaction = <T>(request: FastifyRequest | undefined, idValue: string,
    jobId: string, use: ResourceUse, work: (tx: Transaction, actor: ActorContext) => T): T => {
    if (request) return access.withAuthorizedResource(request, tx => locate(tx,idValue), use, work);
    return options.db.withTransaction(tx => {
      const scope = locate(tx,idValue);
      const membership = tx.get("SELECT m.role FROM course_memberships m JOIN users u ON u.id=m.user_id WHERE m.user_id=? AND m.course_id=? AND m.active=1 AND u.disabled_at_ms IS NULL",
        scope.studentId,scope.courseId);
      const job = readTeachingJob(tx,scope.courseId,jobId);
      if (membership?.role !== 'student' || !job || job.purpose !== 'student_help'
        || job.scope.studentId !== scope.studentId || job.scope.attemptId !== idValue) throw new ApiError('FORBIDDEN');
      const actor = {userId:scope.studentId,courseId:scope.courseId,role:'student' as const};
      assertResourceUse(actor,scope,use);
      return work(tx,actor);
    });
  };

  const authorizeStudentHelp = (
    request: FastifyRequest | undefined,
    idValue: string,
    jobId: string,
    preparation: StudentHelpPreparationOptions,
    use: ResourceUse = 'student_help',
  ) => withHelpTransaction(
        request, idValue, jobId, use,
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
            ...(questionMessage.envelope.hdlSelection?{hdlSelection:questionMessage.envelope.hdlSelection}:{}),
          };
          if (accepted.data.acceptedInputHash !== requestHash("student_help.accepted_input", {
            question: acceptedInput.question,
            objectRef: acceptedInput.objectRef ?? null,
            ...(acceptedInput.hdlSelection?{hdlSelection:acceptedInput.hdlSelection}:{}),
            ...(questionMessage.envelope.hdlBasis?{hdlBasis:questionMessage.envelope.hdlBasis}:{}),
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
          const learner = studentHelp.readLearnerState?.(tx,{
            courseId: actor.courseId,studentId: actor.userId,attemptId: idValue,
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
            learnerStateRevision: learner?.learnerStateRevision ?? preparation.learnerStateRevision ?? 0,
            learnerClaims: learner?.learnerClaims ?? preparation.learnerClaims ?? [],
            assistanceHistory: preparation.assistanceHistory ?? [],
            budgetAvailable: studentHelp.budgetAvailable({
              courseId: actor.courseId,
              studentId: actor.userId,
              attemptId: idValue,
            }),
            versions: {
              ...studentHelp.versions,
              ...(studentHelp.versionsForStudent?{
                modelConfig:questionMessage.envelope.versions.modelConfigVersion,
                prompt:questionMessage.envelope.versions.promptVersion,
                schema:questionMessage.envelope.versions.schemaVersion,
              }:{}),
              policy: activity.helpPolicy.versionId,
            },
          };
          if(acceptedInput.hdlSelection){
            if(!studentHelp.readHdlContext)throw new ApiError('DEPENDENCY_UNAVAILABLE');
            try{
              const hdl=studentHelp.readHdlContext(tx,actor,idValue,acceptedInput.hdlSelection,options.currentGeneration());
              if(!questionMessage.envelope.hdlBasis||canonical(questionMessage.envelope.hdlBasis)!==canonical(projectHdlHelpCurrentState(hdl)))
                throw new ApiError('STATE_CONFLICT');
              context.hdl=hdl;
            }
            catch(error){if(use!=='read'||!(error instanceof ApiError))throw error;}
          }
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
      request: FastifyRequest | undefined,
      idValue: string,
      jobId: string,
      preparation: StudentHelpPreparationOptions,
      runtime: Omit<AuthorizedStudentHelpRuntime, "updateJob" | "budgetAvailable">,
    ) {
      const authorized = authorizeStudentHelp(request, idValue, jobId, preparation);
      // Resolve once before the first call: queued changes are rejected; an in-flight
      // call keeps its captured provider instead of silently switching credentials.
      let selectedProvider=runtime.provider;
      if(studentHelp.providerForStudent){
        try{selectedProvider=studentHelp.providerForStudent(authorized.job.scope.studentId!,authorized.versions.modelConfig);}
        catch(error){
          // Execute through the original gate so a missing/changed configuration is
          // a terminal truthful Job outcome and still uses the original call ledger.
          selectedProvider={generate:async()=>{throw error;}};
        }
      }
      const updateJob: AuthorizedStudentHelpRuntime["updateJob"] = (expectedJobId, update) =>
        withHelpTransaction(request,idValue,jobId,'student_help',(tx) => {
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
        const {hdl:_runtimeHdl,...state} = await runtime.readCurrent(signal);
        const current = withHelpTransaction(request,idValue,jobId,'read',(tx) => {
          const job = readTeachingJob(tx, authorized.job.scope.courseId, authorized.job.jobId);
          if (!job || !job.scope.studentId || !job.scope.attemptId) throw new ApiError("STATE_CONFLICT");
          const learner = studentHelp.readLearnerState?.(tx,{
            courseId: job.scope.courseId,studentId: job.scope.studentId,attemptId: job.scope.attemptId,
          });
          let hdl:ReturnType<typeof projectHdlHelpCurrentState>|undefined;
          if(authorized.hdl&&studentHelp.readHdlContext){
            const selected=readTeachingMessageByJob(tx,job.scope.courseId,job.jobId)?.envelope;
            if(selected?.kind==='student_question'&&selected.hdlSelection){
              try{
                const current=projectHdlHelpCurrentState(studentHelp.readHdlContext(tx,
                  {userId:job.scope.studentId,courseId:job.scope.courseId,role:'student'},idValue,selected.hdlSelection,options.currentGeneration()));
                if(selected.hdlBasis&&canonical(selected.hdlBasis)===canonical(current))hdl=current;
              }
              catch(error){if(!(error instanceof ApiError))throw error;}
            }
          }
          return {job,learner,hdl};
        });
        return {
          ...state,
          ...(current.learner ? {learnerStateRevision: current.learner.learnerStateRevision} : {}),
          jobStatus: current.job.status,
          stopRequested: current.job.stopRequested,
          recoveryGeneration: current.job.recoveryGeneration,
          ...(current.hdl?{hdl:current.hdl}:{}),
          objectAvailable:state.objectAvailable&&(!authorized.hdl||!!current.hdl),
        };
      };
      const studentId = authorized.job.scope.studentId;
      const authorizedAttemptId = authorized.job.scope.attemptId;
      if (!studentId || !authorizedAttemptId) throw new ApiError("STATE_CONFLICT");
      const execution = await executeAuthorizedStudentHelp(authorized, {
        ...runtime,
        ...studentHelp.requestLimits,
        provider:selectedProvider,
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
      const completion = {
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
          ...(authorized.hdl?{hdl:projectHdlHelpCurrentState(authorized.hdl)}:{}),
          inputRefs: execution.authorizedReferenceIds.filter((referenceId) => !referenceId.startsWith("assistance:")),
          assistanceRefs: execution.authorizedReferenceIds.filter((referenceId) => referenceId.startsWith("assistance:")),
          coverageRefs: [],
        },
      };
      const delivery = request ? completeTeaching(request, idValue, completion)
        : withHelpTransaction(undefined,idValue,jobId,'read',tx => {
          currentGeneration(completion.recoveryGeneration);
          return completeTeachingInTransaction(tx, {
            scope:{courseId:authorized.job.scope.courseId,studentId,attemptId:authorizedAttemptId},
            jobId,leaseToken:completion.leaseToken,generation:completion.recoveryGeneration,
            now:new Date(now()).toISOString(),bodyJsonText:completion.bodyJson,
            versions:completion.versions,usage:completion.usage,calls:completion.calls,
            elapsedMs:completion.elapsedMs,basis:completion.basis,messageId:randomUUID(),actionId:randomUUID(),
            ...(isTeachingBasisCurrent?{isBasisCurrent:isTeachingBasisCurrent}:{}),
          });
        });
      return { ...execution, delivery };
    },
    async processJob(jobId: string, provider: ModelProvider, signal?: AbortSignal): Promise<StudentHelpExecutionResult> {
      const scope = options.db.withTransaction(tx => {
        const row=tx.get('SELECT attempt_id FROM jobs WHERE job_id=?',jobId);
        if(typeof row?.attempt_id!=='string') throw new ApiError('FORBIDDEN');
        return row.attempt_id;
      });
      const leaseToken=randomUUID();
      const assistanceHistory=withHelpTransaction(undefined,scope,jobId,'read',(tx,actor)=> {
        const records=readTeachingRecordsInTransaction(tx,{courseId:actor.courseId,studentId:actor.userId,attemptId:scope},'student');
        return records.actions.flatMap(action=> {
          const message=records.messages.find(item=>item.messageId===action.messageId);
          if(message?.envelope.kind!=='student_help') return [];
          const body=message.envelope.body as StudentHelpBody;
          const status:AssistanceContextRecord['status']=action.basisRevised||action.disposition==='stale'?'stale'
            :action.disposition==='cancelled'?'cancelled':action.disposition==='failed'?'failed'
            :action.receipts.some(row=>row.receiptKind==='acknowledged')?'acknowledged':'displayed';
          return [{actionId:action.actionId,actionType:body.actionType,content:body.content,status}];
        });
      });
      const preparation={assistanceHistory};
      const readCurrent = (): StudentHelpCurrentState => {
        const current=authorizeStudentHelp(undefined,scope,jobId,preparation,'read');
        let objectAvailable=true;
        try { assembleStudentHelpRequest(current); } catch { objectAvailable=false; }
        return {...current.current,helpAllowed:current.activity.helpPolicy.helpAllowed,
          learnerStateRevision:current.learnerStateRevision,objectAvailable,
          jobStatus:current.job.status,stopRequested:current.job.stopRequested,
          ...(current.hdl?{hdl:projectHdlHelpCurrentState(current.hdl)}:{})};
      };
      const execution=await tutoring.executeStudentHelp(undefined,scope,jobId,preparation,
        {provider,leaseToken,readCurrent,now,...(signal?{signal}:{})});
      if(execution.outcome.outcome!=='success') options.db.withTransaction(tx=> {
        const row=tx.get('SELECT course_id FROM jobs WHERE job_id=?',jobId);
        if(typeof row?.course_id!=='string') throw new ApiError('STATE_CONFLICT');
        const job=readTeachingJob(tx,row.course_id,jobId);
        // A late failure cannot overwrite a stop/new lease/generation or terminal success.
        if(!job||job.status!=='running'||job.leaseToken!==leaseToken||job.stopRequested
          ||job.recoveryGeneration!==options.currentGeneration()) return;
        const outcome=execution.outcome.outcome;
        saveJob(tx,{...job,status:outcome==='timed_out'?'timed_out':outcome==='stale'?'stale':outcome==='cancelled'?'cancelled':'failed',
          failure:outcome,...(outcome==='cancelled'||outcome==='stale'?{stopRequested:true}:{})});
      });
      return execution;
    },
  };

  return { ...instance, tutoring };
}
