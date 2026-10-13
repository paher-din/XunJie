import type { FastifyRequest } from 'fastify';
import type { Transaction } from '../db/transaction.ts';
import type { ActorContext } from '../../contracts/access/index.ts';
import { readActivity,assignmentAvailability } from '../design/activities.ts';
import { disputeInTransaction,type FeedbackTargetResolver } from './disputes.ts';
import { reviewInTransaction } from './decisions.ts';
import { resolveEvidence } from './evidence.ts';
import { claimAnalysisInTransaction,completeAnalysisInTransaction,originalAnalysis } from './analysis.ts';
import { readAnalysisResultInTransaction } from '../records/analysis.ts';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { contextInput,contextResultSchema,id,type AnalysisVersions,queueAnalysisInput,queuedAnalysisSchema,analysisResultSchema,analysisCompleteInput,reviewInput,reviewResultSchema,disputeInput,disputeResultSchema } from '../../contracts/review/index.ts';
import { createTutoringApp,type TutoringAppOptions } from '../tutoring/application.ts';
import { ApiError,domainError } from '../app/errors.ts';
import { parseRequest } from '../app/validation.ts';
import { finishRecordCommand,readRecordCommand,readAttempt,enqueueStoredJob } from '../db/records-adapter.ts';
import { readCurrentInTransaction } from './projection.ts';
import { readContext,invalidateLearnerTeaching,readState } from './storage.ts';

export type ReviewAppOptions = TutoringAppOptions & { review: { versions: AnalysisVersions;feedbackTarget?: FeedbackTargetResolver } };
const params = z.strictObject({ id });
const key = id.regex(/^[\x21-\x7e]+$/);
export async function createReviewApp(options: ReviewAppOptions) {
  const instance = await createTutoringApp({...options,studentHelp: {...options.studentHelp,
    readLearnerStateRevision: (tx,scope) => {
      const attempt=readAttempt(tx,scope.attemptId);
      if(attempt.courseId!==scope.courseId || attempt.studentId!==scope.studentId)throw new ApiError('FORBIDDEN');
      return readState(tx,scope).learnerStateRevision;
    },
    readLearnerState: (tx,scope) => {
      const current = readCurrentInTransaction(tx,scope);
      return {learnerStateRevision: current.learnerStateRevision,learnerClaims: current.claims
        .filter(claim => claim.basisAvailable && ['active','contested'].includes(claim.validity)).map(claim => ({
          claimId: claim.claimId,claimRevision: claim.claimRevision,competencyId: claim.competencyId,competencyVersion: claim.competencyVersion,
          ...(claim.scope.kind === 'activity' ? {activityVersionId: claim.scope.activityVersionId} : {}),statement: claim.statement,state: claim.state,
          validity: claim.validity,evidenceIds: claim.evidenceIds,counterEvidenceIds: claim.counterEvidenceIds,
          assistanceStatus: claim.assistanceStatus,unresolved: claim.unresolved,
        }))};
    },
  }});
  const { app,access } = instance,now = options.now ?? Date.now;
  const generation = (expected: string) => {
    if (!expected || expected !== options.currentGeneration()) throw new ApiError('RECOVERY_REQUIRED');return expected;
  };
  app.get('/api/courses/:id/my-context',request => {
    const courseId = parseRequest(params,request.params).id;
    const data = access.withAuthorizedCourse(request,courseId,'student',(tx,actor) => readContext(tx,{ courseId,studentId: actor.userId }));
    return { requestId: request.id,data };
  });
  app.patch('/api/courses/:id/my-context',request => {
    const courseId = parseRequest(params,request.params).id,input = parseRequest(contextInput,request.body);
    const idempotencyKey = parseRequest(key,request.headers['idempotency-key']);
    const data = access.withAuthorizedCourse(request,courseId,'student',(tx,actor) => {
      const currentGeneration = generation(input.recoveryGeneration),scope = { courseId,studentId: actor.userId };
      const identity = { actorId: actor.userId,command: 'learner.context',target: `/api/courses/${courseId}/my-context`,scope,
        idempotencyKey,recoveryGeneration: currentGeneration };
      const previous = readRecordCommand(tx,identity,input,currentGeneration,value => contextResultSchema.parse(value));
      if (previous) return { ...previous,replayed: true };
      const current = readContext(tx,scope);
      if (current.contextRevision !== input.expectedContextRevision) throw new ApiError('VERSION_CONFLICT');
      const timestamp = new Date(now()).toISOString();
      const next = { ...current,contextRevision: current.contextRevision + 1,goals: input.goals,constraints: input.constraints };
      const result = finishRecordCommand(tx,identity,input,currentGeneration,now(),receiptId => {
        tx.run('INSERT INTO learner_context_revisions(course_id,student_id,context_revision,actor_id,created_at,context_json) VALUES (?,?,?,?,?,?)',
          courseId,actor.userId,next.contextRevision,actor.userId,timestamp,JSON.stringify(next));
        const invalidated = invalidateLearnerTeaching(tx,scope,receiptId,currentGeneration,timestamp,actor.userId);
        return {...next,stoppedJobIds: invalidated.jobIds,affectedAttemptIds: Object.keys(invalidated.epochs)};
      },value => contextResultSchema.parse(value));
      generation(currentGeneration);return { ...result,replayed: false };
    });
    return { requestId: request.id,data };
  });

  const attemptScope = (tx: Transaction,attemptId: string) => {
    const attempt = readAttempt(tx,attemptId);return {courseId: attempt.courseId,studentId: attempt.studentId,attemptId};
  };
  const authorizeAttempt = <T>(request: FastifyRequest,attemptId: string,role: 'student'|'teacher'|undefined,
    work: (tx: Transaction,actor: ActorContext) => T) => access.withAuthorizedCourse(request,tx => readAttempt(tx,attemptId).courseId,role,(tx,actor) => {
      const scope = attemptScope(tx,attemptId);
      if (actor.role === 'student' && scope.studentId !== actor.userId) throw new ApiError('FORBIDDEN');
      return work(tx,actor);
    });
  const persisted = <T>(work: (tx: Transaction) => T): T => {try {return options.db.withTransaction(work);} catch(error) {throw domainError(error,'PERSISTENCE_UNAVAILABLE');}};
  app.get('/api/attempts/:id/learner-state',request => {
    const attemptId = parseRequest(params,request.params).id;
    const data = authorizeAttempt(request,attemptId,undefined,tx => readCurrentInTransaction(tx,attemptScope(tx,attemptId)));
    return {requestId: request.id,data};
  });
  app.post('/api/attempts/:id/reviews',request => {
    const attemptId = parseRequest(params,request.params).id,input = parseRequest(reviewInput,request.body);
    const idempotencyKey = parseRequest(key,request.headers['idempotency-key']);
    const data = authorizeAttempt(request,attemptId,'teacher',(tx,actor) => {
      const currentGeneration = generation(input.recoveryGeneration),scope = attemptScope(tx,attemptId);
      const identity = {actorId: actor.userId,command: 'learner.review',target: '/api/attempts/'+attemptId+'/reviews',scope,idempotencyKey,recoveryGeneration: currentGeneration};
      const previous=readRecordCommand(tx,identity,input,currentGeneration,value=>reviewResultSchema.parse(value));
      if(previous)return {...previous,replayed:true};
      const result = finishRecordCommand(tx,identity,input,currentGeneration,now(),
        () => reviewInTransaction(tx,scope,actor.userId,input,currentGeneration,new Date(now()).toISOString()),value => reviewResultSchema.parse(value));
      generation(currentGeneration);return {...result,replayed:false};
    });
    return {requestId: request.id,data};
  });
  app.post('/api/attempts/:id/disputes',request => {
    const attemptId = parseRequest(params,request.params).id,input = parseRequest(disputeInput,request.body);
    const idempotencyKey = parseRequest(key,request.headers['idempotency-key']);
    const data = authorizeAttempt(request,attemptId,'student',(tx,actor) => {
      const currentGeneration = generation(input.recoveryGeneration),scope = attemptScope(tx,attemptId);
      const identity = {actorId: actor.userId,command: 'learner.dispute',target: '/api/attempts/'+attemptId+'/disputes',scope,idempotencyKey,recoveryGeneration: currentGeneration};
      const previous=readRecordCommand(tx,identity,input,currentGeneration,value=>disputeResultSchema.parse(value));
      if(previous)return {...previous,replayed:true};
      const result = finishRecordCommand(tx,identity,input,currentGeneration,now(),
        () => disputeInTransaction(tx,scope,input,currentGeneration,new Date(now()).toISOString(),options.review.feedbackTarget),value => disputeResultSchema.parse(value));
      generation(currentGeneration);return {...result,replayed:false};
    });
    return {requestId: request.id,data};
  });
  const review = {
    readCurrentInTransaction,
    queueAnalysis(request: FastifyRequest,attemptId: string,raw: unknown) {
      const input = parseRequest(queueAnalysisInput,raw),idempotencyKey = parseRequest(key,request.headers['idempotency-key']);
      return authorizeAttempt(request,attemptId,'student',(tx,actor) => {
        const currentGeneration = generation(input.recoveryGeneration),scope = attemptScope(tx,attemptId);
        const identity = {actorId: actor.userId,command: 'analysis.queue',target: '/analysis/'+attemptId,scope,idempotencyKey,recoveryGeneration: currentGeneration};
        const previous = readRecordCommand(tx,identity,input,currentGeneration,value => queuedAnalysisSchema.parse(value));if (previous) return {...previous,replayed: true};
        const attempt = readAttempt(tx,attemptId),state = readState(tx,scope),activity = readActivity(tx,scope.courseId,attempt.activityVersionId);
        if (input.expectedStateRevision !== state.learnerStateRevision || input.expectedAttemptRevision !== attempt.attemptRevision) throw new ApiError('VERSION_CONFLICT');
        if (!['ready','active'].includes(attempt.status) || !assignmentAvailability(tx,scope.courseId,attempt.assignmentId,scope.studentId).active
          || !activity.helpPolicy.helpAllowed || (input.purpose === 'passive_analysis' && !attempt.collecting)
          || (activity.checkRule.limitedHelp && tx.get("SELECT run_id FROM workspace_runs WHERE attempt_id=? AND check_state='active'",attemptId))) throw new ApiError('STATE_CONFLICT');
        const all = [...input.inputRefs,...input.assistanceRefs,...input.coverageRefs];
        if (new Set(all.map(ref => ref.id)).size !== all.length || input.coverageRefs.some(ref => ref.kind !== 'coverage')
          || input.assistanceRefs.some(ref => !['message','action'].includes(ref.kind))) throw new ApiError('INVALID_REFERENCE');
        for (const ref of all) resolveEvidence(tx,scope,ref,state);
        const binding = {scope,expectedStateRevision: state.learnerStateRevision,expectedAttemptRevision: attempt.attemptRevision,
          decisionEpoch: attempt.decisionEpoch,contextRevision: readContext(tx,scope).contextRevision,captureRevision: attempt.captureRevision,
          activityVersionId: attempt.activityVersionId,policyVersionId: activity.helpPolicy.versionId,collectionPurpose: input.purpose,
          versions: options.review.versions,inputRefs: input.inputRefs,assistanceRefs: input.assistanceRefs,coverageRefs: input.coverageRefs};
        const timestamp = now(),jobId = randomUUID();
        const result = finishRecordCommand(tx,identity,input,currentGeneration,timestamp,() => ({jobId,binding}),value => queuedAnalysisSchema.parse(value),(receiptId) => {
          enqueueStoredJob(tx,{jobId,kind: 'learner_analysis',purpose: input.purpose,scope,requestReceiptId: receiptId,status: 'queued',stopRequested: false,
            expectedRevision: attempt.attemptRevision,decisionEpoch: attempt.decisionEpoch,recoveryGeneration: currentGeneration,
            acceptedAt: new Date(timestamp).toISOString(),deadline: new Date(timestamp+45000).toISOString(),attemptCount: 0});
        });
        generation(currentGeneration);return {...result,replayed: false};
      });
    },
    claimAnalysis(jobId: string) {return persisted(tx => claimAnalysisInTransaction(tx,jobId,options.review.versions,options.currentGeneration(),now()));},
    completeAnalysis(raw: unknown) {
      const input = parseRequest(analysisCompleteInput,raw);
      return persisted(tx => {
        const currentGeneration = generation(input.recoveryGeneration),{binding} = originalAnalysis(tx,input.jobId);
        const identity = {actorId: binding.scope.studentId,command: 'analysis.complete',target: '/jobs/'+input.jobId,scope: binding.scope,
          idempotencyKey: input.jobId,recoveryGeneration: currentGeneration};
        const result = finishRecordCommand(tx,identity,{jobId: input.jobId,bodyJson: input.bodyJson},currentGeneration,now(),
          () => completeAnalysisInTransaction(tx,input,options.review.versions,currentGeneration,now()),value => analysisResultSchema.parse(value));
        generation(currentGeneration);return result.result;
      });
    },
    readAnalysis(request: FastifyRequest,attemptId: string,jobId: string) {
      return authorizeAttempt(request,attemptId,undefined,(tx,actor) => {
        const result = readAnalysisResultInTransaction(tx,attemptScope(tx,attemptId),jobId);if (!result) throw new ApiError('INVALID_REFERENCE');
        if (actor.role === 'teacher') return result;
        const {rawBodyText: _raw,...metadata} = result;return metadata;
      });
    },
  };
  return {...instance,review};
}
