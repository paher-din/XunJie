import { randomUUID } from 'node:crypto';
import { sha256 } from '../../runner/snapshot.ts';
import type { Job } from '../../contracts/records/index.ts';
import { analysisBodySchema,analysisCompleteInput,queuedAnalysisSchema,
  type AnalysisBinding,type AnalysisResult,type AnalysisVersions } from '../../contracts/review/index.ts';
import type { Transaction } from '../db/transaction.ts';
import { readAttempt,readRecords,saveJob } from '../db/records-adapter.ts';
import { assignmentAvailability,readActivity } from '../design/activities.ts';
import { claimJob } from '../records/jobs.ts';
import { ApiError } from '../app/errors.ts';
import { readState,readContext,writeState } from './storage.ts';
import { resolveEvidence,validateClaim } from './evidence.ts';
import { canonical } from '../records/commands.ts';
import { replayAnalysisInTransaction,storeAnalysisInTransaction } from '../records/analysis.ts';

export function originalAnalysis(tx: Transaction,jobId: string): {job: Job;binding: AnalysisBinding} {
  const row = tx.get('SELECT course_id FROM jobs WHERE job_id=?',jobId);if (!row) throw new ApiError('INVALID_REFERENCE');
  const records = readRecords(tx,String(row.course_id)),job = records.jobs.find(value => value.jobId === jobId);
  if (!job || job.kind !== 'learner_analysis' || !['explicit_analysis','passive_analysis'].includes(job.purpose)
    || !job.scope.studentId || !job.scope.attemptId) throw new ApiError('INVALID_REFERENCE');
  const receipt = records.receipts.find(value => value.receiptId === job.requestReceiptId);
  if (!receipt || receipt.identity.command !== 'analysis.queue' || receipt.identity.actorId !== job.scope.studentId
    || receipt.identity.target !== '/analysis/'+job.scope.attemptId || receipt.identity.recoveryGeneration !== job.recoveryGeneration
    || canonical(receipt.identity.scope) !== canonical(job.scope)) throw new ApiError('INVALID_REFERENCE');
  const value = queuedAnalysisSchema.safeParse(receipt.result);
  if (!value.success || value.data.jobId !== jobId) throw new ApiError('INVALID_REFERENCE');
  const binding = value.data.binding;
  if (canonical(binding.scope) !== canonical(job.scope) || binding.collectionPurpose !== job.purpose
    || binding.expectedAttemptRevision !== job.expectedRevision || binding.decisionEpoch !== job.decisionEpoch) throw new ApiError('INVALID_REFERENCE');
  return {job,binding};
}
export function assertAnalysisCurrent(tx: Transaction,job: Job,binding: AnalysisBinding,versions: AnalysisVersions,generation: string,now: number) {
  if (job.recoveryGeneration !== generation) throw new ApiError('RECOVERY_REQUIRED');
  const attempt = readAttempt(tx,binding.scope.attemptId),activity = readActivity(tx,binding.scope.courseId,attempt.activityVersionId);
  if (!tx.get("SELECT user_id FROM course_memberships WHERE course_id=? AND user_id=? AND role='student' AND active=1",binding.scope.courseId,binding.scope.studentId)
    || tx.get('SELECT disabled_at_ms FROM users WHERE id=?',binding.scope.studentId)?.disabled_at_ms !== null) throw new ApiError('FORBIDDEN');
  if (!['ready','active'].includes(attempt.status) || !assignmentAvailability(tx,attempt.courseId,attempt.assignmentId,attempt.studentId).active
    || !activity.helpPolicy.helpAllowed || (activity.checkRule.limitedHelp && tx.get("SELECT run_id FROM workspace_runs WHERE attempt_id=? AND check_state='active'",attempt.attemptId))
    || (job.purpose === 'passive_analysis' && !attempt.collecting) || job.stopRequested || !['queued','running'].includes(job.status)
    || Date.parse(job.deadline) <= now) throw new ApiError('STATE_CONFLICT');
  if (attempt.decisionEpoch !== binding.decisionEpoch || readState(tx,binding.scope).learnerStateRevision !== binding.expectedStateRevision
    || readContext(tx,binding.scope).contextRevision !== binding.contextRevision
    || (job.purpose === 'passive_analysis' && attempt.captureRevision !== binding.captureRevision)) throw new ApiError('VERSION_CONFLICT');
  if (attempt.activityVersionId !== binding.activityVersionId || activity.helpPolicy.versionId !== binding.policyVersionId
    || canonical(binding.versions) !== canonical(versions)) throw new ApiError('STATE_CONFLICT');
  for (const ref of [...binding.inputRefs,...binding.assistanceRefs,...binding.coverageRefs]) resolveEvidence(tx,binding.scope,ref);
}
export function claimAnalysisInTransaction(tx: Transaction,jobId: string,versions: AnalysisVersions,generation: string,now: number) {
  const {job,binding} = originalAnalysis(tx,jobId);assertAnalysisCurrent(tx,job,binding,versions,generation,now);
  const leaseToken = randomUUID(),next = claimJob(job,leaseToken,job.deadline,generation,new Date(now).toISOString());
  saveJob(tx,next);return {job: next,binding,leaseToken};
}
export function completeAnalysisInTransaction(tx: Transaction,raw: unknown,versions: AnalysisVersions,generation: string,now: number): AnalysisResult {
  const input = analysisCompleteInput.parse(raw),{job,binding} = originalAnalysis(tx,input.jobId);
  if (input.recoveryGeneration !== generation || job.recoveryGeneration !== generation) throw new ApiError('RECOVERY_REQUIRED');
  const previous = replayAnalysisInTransaction(tx,binding.scope,job.jobId,input.bodyJson);if (previous) return previous;
  // Only the holder of the original execution lease can archive its result; a bad token cannot occupy the Job's result slot.
  if (!job.leaseToken || job.leaseToken !== input.leaseToken || !job.leaseUntil) throw new ApiError('STATE_CONFLICT');
  const state = readState(tx,binding.scope),analysisId = randomUUID(),timestamp = new Date(now).toISOString();
  let claimIds: string[] = [],reason: string | undefined;
  let plannedState = state;
  try {
    assertAnalysisCurrent(tx,job,binding,versions,generation,now);
    if (job.status !== 'running' || Date.parse(job.leaseUntil) <= now) throw new ApiError('STATE_CONFLICT');
    let parsed: unknown;try {parsed = JSON.parse(input.bodyJson);} catch {throw new ApiError('INVALID_REQUEST');}
    const body = analysisBodySchema.safeParse(parsed);if (!body.success) throw new ApiError('INVALID_REQUEST');
    const refs = [...binding.inputRefs,...binding.assistanceRefs,...binding.coverageRefs];
    const claims = body.data.claims.map(claim => ({...claim,...validateClaim(tx,binding.scope,claim,refs,state),
      claimId: randomUUID(),claimRevision: 1,courseId: binding.scope.courseId,studentId: binding.scope.studentId,validity: 'active' as const,
      estimatorVersion: binding.versions.analysisVersion,analysisVersion: binding.versions.analysisVersion,source: 'model_candidate' as const,sourceId: analysisId}));
    claimIds = claims.map(value => value.claimId);
    plannedState = {...state,learnerStateRevision: state.learnerStateRevision + 1,claims: [...state.claims,...claims]};
  } catch (error) {
    // Persistence/programming failures are never converted into a successful rejection record.
    if (!(error instanceof ApiError) || !['INVALID_REQUEST','INVALID_REFERENCE','FORBIDDEN','VERSION_CONFLICT','STATE_CONFLICT'].includes(error.code)) throw error;
    reason = error.code;
  }
  const result: AnalysisResult = {analysisId,jobId: job.jobId,disposition: reason ? 'rejected' : 'accepted',
    ...(reason ? {reason} : {}),learnerStateRevision: plannedState.learnerStateRevision,claimIds,resultHash: sha256(input.bodyJson)};
  if (!reason) writeState(tx,state,plannedState,'model_candidate',analysisId,timestamp);
  storeAnalysisInTransaction(tx,binding.scope,input.bodyJson,result,timestamp);
  saveJob(tx,{...job,resultRef: `analysis:${analysisId}`,resultHash: result.resultHash,
    status: reason ? (['succeeded','failed','cancelled','stale','timed_out'].includes(job.status) ? job.status : 'stale') : 'succeeded',
    ...(reason ? {stopRequested: true,failure: reason} : {})});
  return result;
}
