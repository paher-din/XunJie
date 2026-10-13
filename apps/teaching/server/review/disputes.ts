import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { Transaction } from '../db/transaction.ts';
import { ApiError } from '../app/errors.ts';
import { readState,writeState,invalidateLearnerTeaching } from './storage.ts';
import { exactClaim,reviseBasis } from './decisions.ts';
import { disputeSchema,disputeInput,claimRefSchema,type LearnerScope } from '../../contracts/review/index.ts';

export type FeedbackTargetResolver = (tx: Transaction,scope: LearnerScope & {attemptId: string},
  ref: Extract<z.infer<typeof disputeInput>['targetRef'],{kind:'feedback'}>) => {current: boolean;claimRefs: z.infer<typeof claimRefSchema>[]} | undefined;

export function disputeInTransaction(tx: Transaction,scope: LearnerScope & {attemptId: string},input: z.infer<typeof disputeInput>,generation: string,now: string,
  feedbackTarget?: FeedbackTargetResolver) {
  const before = readState(tx,scope),disputeId = randomUUID();
  let currentTarget: boolean,targets: ReturnType<typeof exactClaim>['target'][] = [];
  if (input.targetRef.kind === 'claim') {
    const {target,current} = exactClaim(tx,scope,input.targetRef.id,input.targetRef.revision);
    currentTarget = target.claimRevision === current.claimRevision;targets = currentTarget ? [current] : [];
  } else {
    const feedback = feedbackTarget?.(tx,scope,input.targetRef);
    if (!feedback) throw new ApiError('INVALID_REFERENCE');
    currentTarget = feedback.current;
    if (currentTarget) for (const ref of feedback.claimRefs) {
      const {target,current} = exactClaim(tx,scope,ref.id,ref.revision);
      if (target.claimRevision !== current.claimRevision) throw new ApiError('VERSION_CONFLICT');targets.push(current);
    }
  }
  if (currentTarget && input.expectedStateRevision !== before.learnerStateRevision) throw new ApiError('VERSION_CONFLICT');
  let next = structuredClone(before),stoppedJobIds: string[] = [],affectedAttemptIds: string[] = [];
  if (currentTarget) {
    for (const target of targets.filter(value => ['active','contested'].includes(value.validity))) {
      const latest = next.claims.filter(value => value.claimId === target.claimId).at(-1)!;
      next = reviseBasis(next,latest,disputeId,'contested');
    }
    next.learnerStateRevision++;
    writeState(tx,before,next,'learner_dispute',disputeId,now);
    const invalidated = invalidateLearnerTeaching(tx,scope,disputeId,generation,now,scope.studentId);
    stoppedJobIds = invalidated.jobIds;affectedAttemptIds = Object.keys(invalidated.epochs);
  }
  const record = disputeSchema.parse({disputeId,...scope,targetRef: input.targetRef,reason: input.reason,currentTarget,
    learnerStateRevision: next.learnerStateRevision,createdAt: now});
  tx.run('INSERT INTO learner_disputes(dispute_id,course_id,student_id,attempt_id,target_kind,target_id,target_revision,dispute_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    disputeId,scope.courseId,scope.studentId,scope.attemptId,input.targetRef.kind,input.targetRef.id,input.targetRef.revision,JSON.stringify(record),now);
  return {disputeId,currentTarget,learnerStateRevision: next.learnerStateRevision,stoppedJobIds,affectedAttemptIds};
}
