import type { FastifyRequest } from 'fastify';
import type { Transaction } from '../db/transaction.ts';
import type { ActorContext } from '../../contracts/access/index.ts';
import { readActivity,assignmentAvailability } from '../design/activities.ts';
import { disputeInTransaction,type FeedbackTargetResolver } from './disputes.ts';
import { reviewInTransaction } from './decisions.ts';
import { resolveEvidence } from './evidence.ts';
import { claimAnalysisInTransaction,completeAnalysisInTransaction,originalAnalysis } from './analysis.ts';
import { readAnalysisResultInTransaction } from '../records/analysis.ts';
import { appendFeedbackInTransaction,feedbackTargetResolver,planReopenInTransaction,readFeedbackView,
  readRecoveryFeedback,reviewContextInTransaction,type ReopenPlan } from './feedback.ts';
// The grant row's foreign key names the authorizing receipt, so C4's write runs from the command's `afterCommit`.
import { writeReopenGrant } from '../workspace/submissions.ts';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { contextInput,contextResultSchema,id,type AnalysisVersions,queueAnalysisInput,queuedAnalysisSchema,analysisResultSchema,analysisCompleteInput,reviewInput,reviewResultSchema,disputeInput,disputeResultSchema,
  feedbackInput,reviewContextQuery,feedbackResultSchema,reopenInput,reopenResultSchema } from '../../contracts/review/index.ts';
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
  // A5 owns formal feedback. C4 declares this mount point; without a real record it reports `unavailable` instead of
  // reconstructing text from hashes or submission rows. The transaction comes from C4's own authorized read.
  const readFeedback = (tx: Transaction,_request: FastifyRequest,attemptId: string) => {
    const attempt = readAttempt(tx,attemptId);
    return readRecoveryFeedback(tx,{courseId: attempt.courseId,studentId: attempt.studentId,attemptId});
  };
  const instance = await createTutoringApp({...options,recovery: {readFeedback},studentHelp: {...options.studentHelp,
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
  // A5 supplies A4's dispute seam from its own store; an explicit resolver still wins, and an unresolved reference
  // stays `INVALID_REFERENCE` instead of inventing a formal feedback that was never saved.
  const feedbackTarget = options.review.feedbackTarget ?? feedbackTargetResolver();
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
        () => disputeInTransaction(tx,scope,input,currentGeneration,new Date(now()).toISOString(),feedbackTarget),value => disputeResultSchema.parse(value));
      generation(currentGeneration);return {...result,replayed:false};
    });
    return {requestId: request.id,data};
  });

  // A5.1 READ-11. Teacher-only aggregate. It never hands a student the review surface and never hands anyone the
  // private validation assets or another student's content.
  app.get('/api/attempts/:id/review-context',request => {
    const attemptId = parseRequest(params,request.params).id,query = parseRequest(reviewContextQuery,request.query);
    const data = authorizeAttempt(request,attemptId,'teacher',tx => reviewContextInTransaction(tx,attemptId,options.currentGeneration(),query.submissionId));
    return {requestId: request.id,data};
  });
  // A5.2 READ-14. The student sees the formal feedback about their own attempt and whether a revision permission is
  // actionable right now; the teacher of the course sees the same shape. An unadopted model draft never appears.
  app.get('/api/attempts/:id/feedback',request => {
    const attemptId = parseRequest(params,request.params).id;
    const data = authorizeAttempt(request,attemptId,undefined,tx => readFeedbackView(tx,attemptScope(tx,attemptId)));
    return {requestId: request.id,data};
  });
  app.post('/api/attempts/:id/feedback',request => {
    const attemptId = parseRequest(params,request.params).id,input = parseRequest(feedbackInput,request.body);
    const idempotencyKey = parseRequest(key,request.headers['idempotency-key']);
    const data = authorizeAttempt(request,attemptId,'teacher',(tx,actor) => {
      const currentGeneration = generation(input.recoveryGeneration),scope = attemptScope(tx,attemptId);
      const identity = {actorId: actor.userId,command: 'feedback.save',target: '/api/attempts/'+attemptId+'/feedback',scope,idempotencyKey,recoveryGeneration: currentGeneration};
      const previous=readRecordCommand(tx,identity,input,currentGeneration,value=>feedbackResultSchema.parse(value));
      if(previous)return {...previous,replayed:true};
      const result = finishRecordCommand(tx,identity,input,currentGeneration,now(),
        () => appendFeedbackInTransaction(tx,scope,actor.userId,input,currentGeneration,new Date(now()).toISOString()),
        value => feedbackResultSchema.parse(value));
      generation(currentGeneration);return {...result,replayed:false};
    });
    return {requestId: request.id,data};
  });
  // A5.3. The teacher saves the revision permission for the latest fixed submission, optionally with the formal
  // feedback for that same submission in one transaction. C4 owns the guard and the storage; saving the permission
  // keeps the attempt `reviewed`, and only the student's own resume_revision consumes it.
  app.post('/api/attempts/:id/reopen',request => {
    const attemptId = parseRequest(params,request.params).id,input = parseRequest(reopenInput,request.body);
    const idempotencyKey = parseRequest(key,request.headers['idempotency-key']);
    const data = authorizeAttempt(request,attemptId,'teacher',(tx,actor) => {
      const currentGeneration = generation(input.recoveryGeneration),scope = attemptScope(tx,attemptId);
      const identity = {actorId: actor.userId,command: 'feedback.reopen',target: '/api/attempts/'+attemptId+'/reopen',scope,idempotencyKey,recoveryGeneration: currentGeneration};
      const previous=readRecordCommand(tx,identity,input,currentGeneration,value=>reopenResultSchema.parse(value));
      if(previous)return {...previous,replayed:true};
      let pending: ReopenPlan|undefined,written = false;
      const timestamp = new Date(now()).toISOString();
      const result = finishRecordCommand(tx,identity,input,currentGeneration,now(),() => {
        pending = planReopenInTransaction(tx,scope,actor.userId,input,timestamp);
        const feedback = input.feedback
          ? appendFeedbackInTransaction(tx,scope,actor.userId,{...input.feedback},currentGeneration,timestamp,{submissionId: input.submissionId})
          : undefined;
        return {grantId: pending.grant.grantId,submissionId: pending.grant.submissionId,
          attemptRevision: pending.attempt.attemptRevision,status: 'reviewed' as const,
          supersededGrantIds: pending.superseded.map(row => row.grantId),
          ...(feedback ? {feedback: {feedbackId: feedback.feedbackId,feedbackRevision: feedback.feedbackRevision}} : {})};
      },value => reopenResultSchema.parse(value),(receiptId,value) => {
        // The grant row's foreign key names the authorizing receipt, so it is written once that receipt exists.
        if(!pending)throw new Error('Missing planned reopen grant.');
        const granted = writeReopenGrant(tx,pending,receiptId);
        if(granted.grantId !== value.grantId || granted.submissionId !== value.submissionId
          || granted.attemptRevision !== value.attemptRevision || granted.status !== value.status)
          throw new ApiError('PERSISTENCE_UNAVAILABLE');
        written = true;
      });
      generation(currentGeneration);return {...result,replayed:!written};
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
