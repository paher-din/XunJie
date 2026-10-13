import { contextSchema,stateSchema,decisionSchema,disputeSchema,type LearnerScope,type LearnerContext,type LearnerState,type LearnerClaim } from '../../contracts/review/index.ts';
import type { Transaction } from '../db/transaction.ts';
import { ApiError } from '../app/errors.ts';
import { readAttempt } from '../db/records-adapter.ts';
import { invalidateTeachingInTransaction } from '../records/teaching.ts';
import { readActivity } from '../design/activities.ts';

export function readContext(tx: Transaction,scope: LearnerScope): LearnerContext {
  const row = tx.get('SELECT context_revision,context_json FROM learner_context_revisions WHERE course_id=? AND student_id=? ORDER BY context_revision DESC LIMIT 1',scope.courseId,scope.studentId);
  if (!row) return {courseId: scope.courseId,studentId: scope.studentId,contextRevision: 0,source: 'self_report',goals: '',constraints: ''};
  const value = contextSchema.parse(JSON.parse(String(row.context_json)));
  if (value.courseId !== scope.courseId || value.studentId !== scope.studentId || value.contextRevision !== row.context_revision)
    throw new ApiError('PERSISTENCE_UNAVAILABLE');return value;
}
export function readState(tx: Transaction,scope: LearnerScope): LearnerState {
  const row = tx.get('SELECT state_revision,state_json FROM learner_state_revisions WHERE course_id=? AND student_id=? ORDER BY state_revision DESC LIMIT 1',scope.courseId,scope.studentId);
  if (!row) return {courseId: scope.courseId,studentId: scope.studentId,learnerStateRevision: 0,claims: [],blockedBases: []};
  const value = stateSchema.parse(JSON.parse(String(row.state_json)));
  if (value.courseId !== scope.courseId || value.studentId !== scope.studentId || value.learnerStateRevision !== row.state_revision)
    throw new ApiError('PERSISTENCE_UNAVAILABLE');return value;
}
export function latestClaims(state: LearnerState): LearnerClaim[] {
  const byId = new Map<string,LearnerClaim>();
  for (const claim of state.claims) if (!byId.has(claim.claimId) || byId.get(claim.claimId)!.claimRevision < claim.claimRevision) byId.set(claim.claimId,claim);
  return [...byId.values()];
}
export function writeState(tx: Transaction,before: LearnerState,next: LearnerState,sourceKind: string,sourceId: string,now: string) {
  if (readState(tx,before).learnerStateRevision !== before.learnerStateRevision
    || next.learnerStateRevision !== before.learnerStateRevision + 1) throw new ApiError('VERSION_CONFLICT');
  const value = stateSchema.parse(next);
  if (value.courseId !== before.courseId || value.studentId !== before.studentId) throw new ApiError('FORBIDDEN');
  tx.run('INSERT INTO learner_state_revisions(course_id,student_id,state_revision,source_kind,source_id,created_at,state_json) VALUES (?,?,?,?,?,?,?)',
    value.courseId,value.studentId,value.learnerStateRevision,sourceKind,sourceId,now,JSON.stringify(value));return value;
}
export function readCurrentInTransaction(tx: Transaction,scope: LearnerScope) {
  const state = readState(tx,scope),context = readContext(tx,scope);
  let claims = latestClaims(state);
  if (scope.attemptId) {
    const attempt = readAttempt(tx,scope.attemptId);
    if (attempt.courseId !== scope.courseId || attempt.studentId !== scope.studentId) throw new ApiError('FORBIDDEN');
    const activity = readActivity(tx,scope.courseId,attempt.activityVersionId);
    claims = claims.filter(claim => (claim.scope.kind === 'course' || claim.scope.activityVersionId === activity.activityVersionId)
      && activity.draft.content.goals.some(goal => goal.competencyId === claim.competencyId && goal.competencyVersion === claim.competencyVersion && goal.domain === claim.domain));
  }
  const decisions = tx.all('SELECT * FROM teacher_decisions WHERE course_id=? AND student_id=? ORDER BY created_at,decision_id',scope.courseId,scope.studentId)
    .map(row => {
      const value = decisionSchema.parse(JSON.parse(String(row.decision_json)));
      if (value.decisionId !== row.decision_id || value.courseId !== scope.courseId || value.studentId !== scope.studentId
        || value.attemptId !== row.attempt_id || value.teacherId !== row.teacher_id || value.expectedStateRevision !== row.expected_state_revision
        || value.learnerStateRevision !== row.result_state_revision || value.createdAt !== row.created_at) throw new ApiError('PERSISTENCE_UNAVAILABLE');return value;
    });
  const disputes = tx.all('SELECT * FROM learner_disputes WHERE course_id=? AND student_id=? ORDER BY created_at,dispute_id',scope.courseId,scope.studentId)
    .map(row => {
      const value = disputeSchema.parse(JSON.parse(String(row.dispute_json)));
      if (value.disputeId !== row.dispute_id || value.courseId !== scope.courseId || value.studentId !== scope.studentId
        || value.attemptId !== row.attempt_id || value.targetRef.kind !== row.target_kind || value.targetRef.id !== row.target_id
        || value.targetRef.revision !== row.target_revision || value.createdAt !== row.created_at) throw new ApiError('PERSISTENCE_UNAVAILABLE');return value;
    });
  return {learnerStateRevision: state.learnerStateRevision,context,claims,decisions,disputes};
}
export function invalidateLearnerTeaching(tx: Transaction,scope: LearnerScope,causeRef: string,generation: string,now: string,actorId: string) {
  const attempts = tx.all('SELECT attempt_id FROM attempts WHERE course_id=? AND student_id=?',scope.courseId,scope.studentId)
    .map(row => readAttempt(tx,String(row.attempt_id)));
  return invalidateTeachingInTransaction(tx,{actorId,courseId: scope.courseId,studentId: scope.studentId,
    attemptIds: attempts.map(value => value.attemptId),expectedEpochs: Object.fromEntries(attempts.map(value => [value.attemptId,value.decisionEpoch])),
    reason: 'Learner teaching basis revised',causeRef,generation,now});
}
