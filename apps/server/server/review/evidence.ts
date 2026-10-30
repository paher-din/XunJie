import type { Transaction } from '../db/transaction.ts';
import { ApiError } from '../app/errors.ts';
import { courseChecks } from '../../runner/course.ts';
import { sha256 } from '../../runner/snapshot.ts';
import { canonical } from '../records/commands.ts';
import { readAttempt } from '../db/records-adapter.ts';
import { activityView,readActivity } from '../design/activities.ts';
import { loadWorkspace } from '../workspace/storage.ts';
import { validateRunResult } from '../records/runner.ts';
import { readCoverageIntervals,readTeachingRecordsInTransaction } from '../records/teaching.ts';
import { latestClaims,readContext,readState,readCurrentInTransaction } from './storage.ts';
import type { ClaimBody,EvidenceRef,LearnerClaim,LearnerScope,LearnerState } from '../../contracts/review/index.ts';

export type EvidenceFact = {atoms: string[];groupIds: string[];source: 'observation'|'self_report'|'model_candidate'|'teacher_judgment'|'coverage'|'resource';
  checked: boolean;toolFailure: boolean;helpObserved: boolean;gap: boolean};
function pick(value: unknown,names: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const object = value as Record<string,unknown>;
  return Object.fromEntries(names.filter(name => object[name] !== undefined).map(name => [name,object[name]]));
}
function normalizedRunResult(result: Record<string,unknown>|undefined) {
  if (!result) return null;
  return {...pick(result,['verdict','executionOutcome','failureKind']),
    phases: Array.isArray(result.phases) ? result.phases.map(value => pick(value,['phase','exitCode','stdout','stderr','failureKind','unitTerminated'])) : [],
    checks: Array.isArray(result.checkResults) ? result.checkResults.map(value => pick(value,['caseIndex','checkRuleVersion','validatorVersion','source','verdict'])) : [],
    resultFiles: Array.isArray(result.resultFiles) ? result.resultFiles.map(value => pick(value,['relativeName','caseIndex','contentHash','status'])) : []};
}
type WorkspaceCache = Map<string,ReturnType<typeof loadWorkspace>>;
function readEvidenceWorkspace(tx: Transaction,attemptId: string,cache: WorkspaceCache) {
  let workspace=cache.get(attemptId);
  if(!workspace){workspace=loadWorkspace(tx,attemptId);cache.set(attemptId,workspace);}
  return workspace;
}
/** A resolver belongs to one synchronous authorized projection/validation; never retain it across calls. */
export function createEvidenceResolver(tx: Transaction,scope: LearnerScope,state=readState(tx,scope)) {
  const cache:WorkspaceCache=new Map();
  return (ref:EvidenceRef)=>resolveEvidenceWithCache(tx,scope,ref,state,cache);
}
export function resolveEvidence(tx: Transaction,scope: LearnerScope,ref: EvidenceRef,state=readState(tx,scope)):EvidenceFact {
  return createEvidenceResolver(tx,scope,state)(ref);
}
export const evidenceKey = (scope: LearnerScope,ref: EvidenceRef) => canonical([scope.courseId,scope.studentId,ref]);
function verifyClaimDependencies(tx: Transaction,scope: LearnerScope,root: EvidenceRef,state: LearnerState,cache:WorkspaceCache) {
  const current = new Map(latestClaims(state).map(claim => [claim.claimId,claim]));
  const checked = new Set<string>(),active = new Set<string>(),stack: {ref: EvidenceRef;leave?: true}[] = [{ref: root}];
  while (stack.length) {
    const {ref,leave} = stack.pop()!,key = evidenceKey(scope,ref);
    if (leave) {active.delete(key);checked.add(key);continue;}
    if (active.has(key)) throw new ApiError('INVALID_REFERENCE');
    if (checked.has(key)) continue;
    if (ref.kind !== 'claim') {resolveEvidenceWithCache(tx,scope,ref,state,cache);checked.add(key);continue;}
    const claim = current.get(ref.id);
    if (!claim || claim.claimRevision !== ref.revision || !['active','contested'].includes(claim.validity)) throw new ApiError('INVALID_REFERENCE');
    active.add(key);stack.push({ref,leave: true});
    for (const dependency of [...claim.refs].reverse()) stack.push({ref: dependency});
  }
}
function resolveEvidenceWithCache(tx: Transaction,scope: LearnerScope,ref: EvidenceRef,state:LearnerState,cache:WorkspaceCache): EvidenceFact {
  const fact: EvidenceFact = {atoms: [evidenceKey(scope,ref)],groupIds: [],source: 'observation',checked: false,toolFailure: false,helpObserved: false,gap: false};
  if ('attemptId' in ref) {
    const attempt = readAttempt(tx,ref.attemptId);
    if (attempt.courseId !== scope.courseId || attempt.studentId !== scope.studentId) throw new ApiError('INVALID_REFERENCE');
    fact.groupIds = [attempt.attemptId];
    if (ref.kind === 'snapshot') {
      const workspace = readEvidenceWorkspace(tx,ref.attemptId,cache);
      const snapshot = workspace.snapshots.find(value => value.snapshotId === ref.id);
      if (!snapshot) throw new ApiError('INVALID_REFERENCE');
      const content = snapshot.files.map(file => ({path: file.path,contentHash: file.contentHash})).sort((a,b) => Buffer.compare(Buffer.from(a.path),Buffer.from(b.path)));
      fact.atoms = [canonical([scope.courseId,scope.studentId,'snapshot',ref.attemptId,sha256(canonical(content))])];
    } else if (ref.kind === 'run') {
      const workspace = readEvidenceWorkspace(tx,ref.attemptId,cache),run = workspace.runs.find(value => value.runId === ref.id);
      if (!run) throw new ApiError('INVALID_REFERENCE');
      const result = run.result ? validateRunResult(run.submission,run.result).record : undefined;
      const content = run.submission.snapshot.files.map(file => ({path: file.path,contentHash: file.contentHash})).sort((a,b) => Buffer.compare(Buffer.from(a.path),Buffer.from(b.path)));
      const {fileIds,...parameters} = run.submission.input;
      const input = {...parameters,files: fileIds.map(id => {
        const file = run.submission.snapshot.files.find(value => value.fileId === id);
        if (!file) throw new ApiError('INVALID_REFERENCE');
        return {path: file.path,contentHash: file.contentHash};
      })};
      const entryFile = run.submission.snapshot.files.find(value => value.fileId === run.submission.entryFileId);
      if (!entryFile) throw new ApiError('INVALID_REFERENCE');
      const entryPath = entryFile.path;
      fact.atoms = [canonical([scope.courseId,scope.studentId,'run',ref.attemptId,sha256(canonical({content,input,entryPath,mode: run.submission.mode,
        checkRuleVersion: run.submission.checkRuleVersion ?? null,runtimeProfileVersion: run.submission.identity.runtimeProfileVersion,
        imageDigest: run.submission.identity.imageDigest,result: normalizedRunResult(result)}))])];
      const activity = readActivity(tx,scope.courseId,attempt.activityVersionId),identity = run.submission.identity;
      const checks = Array.isArray(result?.checkResults) ? result.checkResults : [];
      fact.checked = run.submission.mode === 'check' && result?.verdict === 'passed' && result.executionOutcome !== 'outcome_unknown'
        && !result.failureKind && run.submission.checkRuleVersion === activity.checkRule.versionId
        && checks.length === courseChecks(run.submission.snapshot,run.submission.input,activity.checkRule.versionId).length
        && checks.every((item,index) => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
          const check = item as Record<string,unknown>;
          return check.source === 'trusted_validator' && check.verdict === 'passed' && check.caseIndex === index
            && check.checkRuleVersion === activity.checkRule.versionId && check.validatorVersion === activity.checkRule.validatorVersion
            && check.runId === identity.runId && check.snapshotId === identity.snapshotId && check.snapshotHash === identity.snapshotHash
            && check.inputHash === identity.inputHash && check.imageDigest === identity.imageDigest;
        });
      fact.toolFailure = !result || result.executionOutcome === 'outcome_unknown' || Boolean(result.failureKind) || result.verdict === 'incomplete'
        || (Array.isArray(result.phases) && result.phases.some(phase => phase && typeof phase === 'object' && Boolean(phase.failureKind)));
      fact.checked = fact.checked && !fact.toolFailure;
    } else if (ref.kind === 'coverage') {
      const intervals = readCoverageIntervals(tx,ref.attemptId).intervals;
      const interval = intervals.find(value => value.captureRevision === ref.captureRevision && value.fromServerSeq === ref.fromServerSeq);
      if (!interval || ref.id !== `coverage:${ref.attemptId}:${ref.captureRevision}:${ref.fromServerSeq}`) throw new ApiError('INVALID_REFERENCE');
      fact.source = 'coverage';fact.gap = interval.state === 'paused' || interval.rejections.length > 0;
    } else {
      const records = readTeachingRecordsInTransaction(tx,{courseId: scope.courseId,studentId: scope.studentId,attemptId: ref.attemptId},'student');
      const action = records.actions.find(value => ref.kind === 'action' ? value.actionId === ref.id : value.messageId === ref.id);
      const message = records.messages.find(value => ref.kind === 'message' ? value.messageId === ref.id : value.messageId === action?.messageId);
      if (!message) throw new ApiError('INVALID_REFERENCE');
      fact.source = message.authorKind === 'student' ? 'self_report' : 'model_candidate';
      fact.helpObserved = Boolean(action?.receipts.some(value => ['displayed','acknowledged'].includes(value.receiptKind)));
      // Display is an assistance fact, not an independent observation proving competence.
    }
  } else if (ref.kind === 'context') {
    const row = tx.get('SELECT context_json FROM learner_context_revisions WHERE course_id=? AND student_id=? AND context_revision=?',scope.courseId,scope.studentId,ref.revision);
    if (!row || ref.id !== scope.studentId || readContext(tx,scope).contextRevision !== ref.revision) throw new ApiError('INVALID_REFERENCE');
    fact.source = 'self_report';
  } else if (ref.kind === 'claim') {
    const claim = state.claims.find(value => value.claimId === ref.id && value.claimRevision === ref.revision);
    if (!claim || !['active','contested'].includes(claim.validity)
      || latestClaims(state).find(value => value.claimId === ref.id)?.claimRevision !== ref.revision) throw new ApiError('INVALID_REFERENCE');
    verifyClaimDependencies(tx,scope,ref,state,cache);
    fact.atoms = [...claim.basisAtoms];fact.groupIds = [...claim.evidenceGroupIds];fact.source = claim.source;
    fact.helpObserved = claim.assistanceStatus === 'observed_help';fact.gap = claim.assistanceStatus === 'unknown' || claim.validity === 'contested';
  } else if (ref.kind === 'teacher_decision') {
    const current = readCurrentInTransaction(tx,scope);
    const decision = current.decisions.find(value => value.decisionId === ref.id);
    const judgments = current.claims.filter(claim => claim.source === 'teacher_judgment' && claim.sourceId === ref.id
      && ['active','contested'].includes(claim.validity));
    if (!decision || !judgments.length) throw new ApiError('INVALID_REFERENCE');
    for (const claim of judgments) verifyClaimDependencies(tx,scope,{kind: 'claim',id: claim.claimId,revision: claim.claimRevision},state,cache);
    fact.atoms = [...new Set(judgments.flatMap(claim => claim.basisAtoms))];
    fact.groupIds = [...new Set(judgments.flatMap(claim => claim.evidenceGroupIds))];
    fact.source = 'teacher_judgment';fact.helpObserved = judgments.some(claim => claim.assistanceStatus === 'observed_help');
    fact.gap = judgments.some(claim => claim.assistanceStatus === 'unknown' || claim.unresolved || claim.validity === 'contested');
  } else {
    if (!scope.attemptId) throw new ApiError('INVALID_REFERENCE');
    const attempt = readAttempt(tx,scope.attemptId);
    const view = activityView(tx,{userId: scope.studentId,courseId: scope.courseId,role: 'student'},attempt.activityVersionId,'tutor');
    const resource = view.content.materials.find(value => value.status === 'available' && value.resourceVersionId === ref.resourceVersionId);
    if (!resource || resource.status !== 'available' || !resource.paragraphs.some(value => value.paragraphId === ref.paragraphId)
      || ref.id !== `resource:${ref.resourceVersionId}:${ref.paragraphId}`) throw new ApiError('INVALID_REFERENCE');
    fact.source = 'resource';
  }
  return fact;
}
function sameTarget(a: ClaimBody,b: Pick<LearnerClaim,'competencyId'|'competencyVersion'|'domain'|'scope'>) {
  return a.competencyId === b.competencyId && a.competencyVersion === b.competencyVersion && a.domain === b.domain
    && (a.scope.kind === 'course' || b.scope.kind === 'course' || a.scope.activityVersionId === b.scope.activityVersionId);
}
export function unsupportedBasis(claim: ClaimBody) { return canonical(['unsupported',claim.competencyId,claim.competencyVersion,claim.domain,claim.scope]); }
export function validateClaim(tx: Transaction,scope: LearnerScope & {attemptId: string},body: ClaimBody,refs: EvidenceRef[],state: LearnerState) {
  const attempt = readAttempt(tx,scope.attemptId),activity = readActivity(tx,scope.courseId,attempt.activityVersionId);
  if ((body.scope.kind === 'activity' && body.scope.activityVersionId !== activity.activityVersionId)
    || !activity.draft.content.goals.some(goal => goal.competencyId === body.competencyId && goal.competencyVersion === body.competencyVersion && goal.domain === body.domain)) throw new ApiError('INVALID_REFERENCE');
  const ids = [...body.evidenceIds,...body.counterEvidenceIds];
  if (ids.some(value => !refs.some(ref => ref.id === value))) throw new ApiError('INVALID_REFERENCE');
  const readEvidence=createEvidenceResolver(tx,scope,state);
  const used = refs.filter(ref => ids.includes(ref.id)),facts = used.map(ref => readEvidence(ref));
  for (const attemptId of new Set(facts.flatMap(value => value.groupIds))) {
    const sourceAttempt = readAttempt(tx,attemptId),sourceActivity = readActivity(tx,scope.courseId,sourceAttempt.activityVersionId);
    if ((body.scope.kind === 'activity' && sourceActivity.activityVersionId !== body.scope.activityVersionId)
      || !sourceActivity.draft.content.goals.some(goal => goal.competencyId === body.competencyId
        && goal.competencyVersion === body.competencyVersion && goal.domain === body.domain)) throw new ApiError('INVALID_REFERENCE');
  }
  const atoms = [...new Set(facts.flatMap(value => value.atoms))];if (!atoms.length) atoms.push(unsupportedBasis(body));
  if (state.blockedBases.some(blocked => sameTarget(body,blocked) && blocked.atoms.some(atom => atoms.includes(atom)))) throw new ApiError('STATE_CONFLICT');
  const attemptIds = [...new Set([scope.attemptId,...facts.flatMap(value => value.groupIds)])];
  const coverages = attemptIds.map(value => readCoverageIntervals(tx,value));
  const actions = attemptIds.flatMap(attemptId =>
    readTeachingRecordsInTransaction(tx,{courseId: scope.courseId,studentId: scope.studentId,attemptId},'trusted').actions);
  const wasShown = (action: typeof actions[number]) => action.receipts.some(receipt => ['displayed','acknowledged'].includes(receipt.receiptKind));
  const observed = facts.some(value => value.helpObserved) || actions.some(wasShown);
  // Sending or receiving help without a display receipt leaves its actual assistance unknown.
  const displayGap = actions.some(action => action.deliveries.length > 0 && !wasShown(action));
  const gap = displayGap || facts.some(value => value.gap || value.toolFailure) || coverages.some(value => !value.collecting
    || value.intervals.some(interval => interval.state === 'paused' || interval.rejections.length > 0));
  if ((body.assistanceStatus === 'observed_help' && !observed) || (body.assistanceStatus === 'none_observed_in_system' && (observed || gap))
    || (observed && body.assistanceStatus !== 'observed_help') || ((gap || body.unknown.length > 0) && !body.unresolved)) throw new ApiError('INVALID_REFERENCE');
  const support = body.evidenceIds.map(value => facts[used.findIndex(ref => ref.id === value)]!).filter(Boolean);
  if (body.state === 'supported_in_check' && !support.some(value => value.checked)) throw new ApiError('INVALID_REFERENCE');
  if (body.state === 'supported_with_assistance' && (!observed || !support.some(value => value.source === 'observation'))) throw new ApiError('INVALID_REFERENCE');
  return {refs: used,basisAtoms: atoms,evidenceGroupIds: [...new Set(facts.flatMap(value => value.groupIds))]};
}
