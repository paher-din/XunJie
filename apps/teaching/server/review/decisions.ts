import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { Transaction } from '../db/transaction.ts';
import { ApiError } from '../app/errors.ts';
import { latestClaims,readCurrentInTransaction,readState,writeState,invalidateLearnerTeaching } from './storage.ts';
import { resolveEvidence,validateClaim } from './evidence.ts';
import { decisionSchema,reviewInput,type LearnerClaim,type LearnerScope,type LearnerState } from '../../contracts/review/index.ts';

type AttemptScope = LearnerScope & {attemptId: string};
export function exactClaim(tx: Transaction,scope: AttemptScope,id: string,revision: number) {
  const state = readState(tx,scope),target = state.claims.find(claim => claim.claimId === id && claim.claimRevision === revision);
  const current = readCurrentInTransaction(tx,scope).claims.find(claim => claim.claimId === id);
  if (!target || !current) throw new ApiError('INVALID_REFERENCE');
  return {state,target,current};
}
function blockClaim(state: LearnerState,claim: LearnerClaim,causeRef: string,validity: 'contested'|'withdrawn') {
  state.blockedBases.push({competencyId: claim.competencyId,competencyVersion: claim.competencyVersion,domain: claim.domain,
    scope: claim.scope,atoms: [...claim.basisAtoms],causeRef,validity});
}
/** Append revisions; primitive basis survives renamed IDs and transitive claim references. */
export function reviseBasis(before: LearnerState,target: LearnerClaim,causeRef: string,validity: 'contested'|'withdrawn',source?: LearnerClaim['source']) {
  const next = structuredClone(before),current = latestClaims(before),affected = new Set([target.claimId]);
  let changed = true;
  while (changed) {
    changed = false;
    const affectedDecisions = new Set(current.filter(claim => affected.has(claim.claimId) && claim.source === 'teacher_judgment').map(claim => claim.sourceId));
    for (const claim of current) {
      const dependent = claim.refs.some(ref => (ref.kind === 'claim' && affected.has(ref.id))
        || (ref.kind === 'teacher_decision' && affectedDecisions.has(ref.id)));
      const sameBasis = claim.competencyId === target.competencyId && claim.competencyVersion === target.competencyVersion && claim.domain === target.domain
        && (claim.scope.kind === 'course' || target.scope.kind === 'course' || claim.scope.activityVersionId === target.scope.activityVersionId)
        && claim.basisAtoms.some(atom => target.basisAtoms.includes(atom));
      if (!affected.has(claim.claimId) && ['active','contested'].includes(claim.validity) && (dependent || sameBasis)) {
        affected.add(claim.claimId);changed = true;
      }
    }
  }
  for (const claim of current.filter(value => affected.has(value.claimId))) {
    const revisedValidity = claim.claimId === target.claimId ? validity : 'contested';
    next.claims.push({...claim,claimRevision: claim.claimRevision+1,validity: revisedValidity,unresolved: true,
      ...(claim.claimId === target.claimId && source ? {source,sourceId: causeRef} : {})});
    blockClaim(next,claim,causeRef,revisedValidity);
  }
  return next;
}
export function reviewInTransaction(tx: Transaction,scope: AttemptScope,teacherId: string,input: z.infer<typeof reviewInput>,generation: string,now: string) {
  const {state,target,current} = exactClaim(tx,scope,input.targetRef.id,input.targetRef.revision);
  if (state.learnerStateRevision !== input.expectedStateRevision || current.claimRevision !== target.claimRevision) throw new ApiError('VERSION_CONFLICT');
  if (!['active','contested'].includes(current.validity)) throw new ApiError('STATE_CONFLICT');
  if (input.replacement && input.decision !== 'correct') throw new ApiError('INVALID_REQUEST');
  for (const ref of input.evidenceRefs) resolveEvidence(tx,scope,ref,state);
  const decisionId = randomUUID();
  let next = input.decision === 'confirm' ? structuredClone(state)
    : reviseBasis(state,target,decisionId,input.decision === 'correct' ? 'withdrawn' : 'contested','teacher_judgment');
  if (input.decision === 'confirm') next.claims.push({...target,claimRevision: target.claimRevision+1,source: 'teacher_judgment',sourceId: decisionId});
  let replacementClaimId: string|undefined;
  if (input.replacement) {
    if (input.replacement.competencyId !== target.competencyId || input.replacement.competencyVersion !== target.competencyVersion
      || input.replacement.domain !== target.domain || JSON.stringify(input.replacement.scope) !== JSON.stringify(target.scope)) throw new ApiError('INVALID_REFERENCE');
    const basis = validateClaim(tx,scope,input.replacement,input.evidenceRefs,next);replacementClaimId = randomUUID();
    next.claims.push({...input.replacement,...basis,claimId: replacementClaimId,claimRevision: 1,courseId: scope.courseId,studentId: scope.studentId,
      validity: 'active',source: 'teacher_judgment',sourceId: decisionId,estimatorVersion: target.estimatorVersion,analysisVersion: target.analysisVersion});
  }
  next.learnerStateRevision++;
  writeState(tx,state,next,'teacher_decision',decisionId,now);
  const decision = decisionSchema.parse({decisionId,...scope,teacherId,expectedStateRevision: state.learnerStateRevision,
    learnerStateRevision: next.learnerStateRevision,targetRef: input.targetRef,decision: input.decision,reason: input.reason,evidenceRefs: input.evidenceRefs,
    ...(replacementClaimId ? {replacementClaimId} : {}),createdAt: now});
  tx.run('INSERT INTO teacher_decisions(decision_id,course_id,student_id,attempt_id,teacher_id,expected_state_revision,result_state_revision,decision_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    decisionId,scope.courseId,scope.studentId,scope.attemptId,teacherId,state.learnerStateRevision,next.learnerStateRevision,JSON.stringify(decision),now);
  const invalidated = invalidateLearnerTeaching(tx,scope,decisionId,generation,now,teacherId);
  return {decisionId,learnerStateRevision: next.learnerStateRevision,stoppedJobIds: invalidated.jobIds,affectedAttemptIds: Object.keys(invalidated.epochs)};
}
