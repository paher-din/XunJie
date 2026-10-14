import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { Transaction } from '../db/transaction.ts';
import { ApiError } from '../app/errors.ts';
import { readAttempt } from '../db/records-adapter.ts';
import { assignmentAvailability } from '../design/activities.ts';
import { latestSubmission, planReopenGrant, readGrants, readSubmissions, reopenView, transitionAttemptInTransaction } from '../workspace/submissions.ts';
import { loadWorkspace } from '../workspace/storage.ts';
import { readRecovery, readWorkspace } from '../workspace/commands.ts';
import { readCoverageIntervals, readTeachingRecordsInTransaction } from '../records/teaching.ts';
import { readCurrentInTransaction as readProjectedCurrent } from './projection.ts';
import { resolveEvidence } from './evidence.ts';
import { invalidateLearnerTeaching, readState } from './storage.ts';
import type { FeedbackTargetResolver } from './disputes.ts';
import { feedbackInput, feedbackSchema, type FeedbackEntry, type FeedbackThread, type FeedbackView,
  type ReviewContext, type TeacherFeedback } from '../../contracts/review/index.ts';

export type AttemptScope = {courseId: string;studentId: string;attemptId: string};
/** The fields a feedback revision carries; the route adds the generation and the optional revision CAS input. */
export type FeedbackFields = Pick<z.infer<typeof feedbackInput>,
  'kind'|'expectedFeedbackRevision'|'expectedStateRevision'|'summary'|'reason'|'evidenceRefs'>
  & {feedbackId?: string|undefined;submissionId?: string|undefined;expectedAttemptRevision?: number|undefined};

/**
 * Mirrors C4's `assignmentActionable` (workspace/application.ts), so the reopen view A5 republishes agrees with the
 * recovery view. C4 owns this rule; replace this with C's exported helper once it publishes one.
 */
function actionableAssignment(tx: Transaction, attempt: {courseId: string;studentId: string;assignmentId: string}): boolean {
  return Boolean(tx.get("SELECT m.user_id FROM course_memberships m JOIN users u ON u.id=m.user_id WHERE m.course_id=? AND m.user_id=? AND m.role='student' AND m.active=1 AND u.disabled_at_ms IS NULL",
    attempt.courseId, attempt.studentId))
    && assignmentAvailability(tx, attempt.courseId, attempt.assignmentId, attempt.studentId).active;
}

/** One authorized scope: the attempt exists and belongs to the course/student the caller resolved. */
function ownedAttempt(tx: Transaction, scope: AttemptScope) {
  const attempt = readAttempt(tx, scope.attemptId);
  if (attempt.courseId !== scope.courseId || attempt.studentId !== scope.studentId) throw new ApiError('FORBIDDEN');
  return attempt;
}

/**
 * The attempt-scoped append counter behind `feedbackRevision`. It is derived from the append-only rows, so a
 * revision, a withdrawal or a supersede never resets it and a first write expects 0.
 */
export function readFeedbackScopeRevision(tx: Transaction, scope: AttemptScope): number {
  const row = tx.get('SELECT COUNT(*) AS n FROM teacher_feedback WHERE course_id=? AND student_id=? AND attempt_id=?',
    scope.courseId, scope.studentId, scope.attemptId);
  return Number(row?.n ?? 0);
}

/** Every saved revision in insertion order, with each row cross-checked against the JSON it owns. */
export function readFeedbackRevisions(tx: Transaction, scope: AttemptScope): TeacherFeedback[] {
  // `created_at` is a millisecond timestamp the caller supplies, so two commands can share it; `rowid` is the
  // table's real insertion order and is what makes the revision history reproduce the order it was written in.
  return tx.all('SELECT * FROM teacher_feedback WHERE course_id=? AND student_id=? AND attempt_id=? ORDER BY rowid',
    scope.courseId, scope.studentId, scope.attemptId).map(row => {
    const value = feedbackSchema.parse(JSON.parse(String(row.feedback_json)));
    if (value.feedbackId !== row.feedback_id || value.feedbackRevision !== row.feedback_revision
      || value.courseId !== scope.courseId || value.studentId !== scope.studentId || value.attemptId !== row.attempt_id
      || value.submissionId !== row.submission_id || value.teacherId !== row.teacher_id || value.kind !== row.kind
      || value.expectedStateRevision !== row.expected_state_revision || value.createdAt !== row.created_at)
      throw new ApiError('PERSISTENCE_UNAVAILABLE');
    return value;
  });
}

type ProjectedClaim = {claimId: string;claimRevision: number;validity: string;basisAvailable: boolean};
/**
 * The appended feedback revisions of one attempt. `feedbackRevision` is the attempt-scoped append counter; `current`
 * marks the newest revision of each thread. Each entry also reports whether a student dispute targets that exact
 * revision and how each claim the evaluation rested on stands now, so a reader can never mistake a stale or
 * withdrawn basis for a still-current evaluation.
 */
export function readFeedbackEntries(tx: Transaction, scope: AttemptScope, current?: {claims: ProjectedClaim[]}): FeedbackThread {
  const rows = readFeedbackRevisions(tx, scope);
  const claims = current ?? readProjectedCurrent(tx, scope);
  const latestByClaim = new Map(claims.claims.map(claim => [claim.claimId, claim]));
  const disputed = new Set(tx.all("SELECT target_id,target_revision FROM learner_disputes WHERE course_id=? AND student_id=? AND attempt_id=? AND target_kind='feedback'",
    scope.courseId, scope.studentId, scope.attemptId).map(row => `${row.target_id}\0${row.target_revision}`));
  const newest = new Map<string, number>();
  for (const row of rows) newest.set(row.feedbackId, Math.max(newest.get(row.feedbackId) ?? 0, row.feedbackRevision));
  const entries: FeedbackEntry[] = rows.map(row => ({
    ...row,
    current: newest.get(row.feedbackId) === row.feedbackRevision,
    disputed: disputed.has(`${row.feedbackId}\0${row.feedbackRevision}`),
    basis: row.claimRefs.map(ref => ({claimId: ref.id, claimRevision: ref.revision, status: basisStatus(ref, latestByClaim.get(ref.id))})),
  }));
  return {feedbackRevision: rows.length, entries};
}
function basisStatus(ref: {revision: number}, latest: ProjectedClaim | undefined): FeedbackEntry['basis'][number]['status'] {
  if (!latest) return 'unavailable';
  if (latest.validity === 'withdrawn') return 'withdrawn';
  if (latest.validity === 'superseded') return 'superseded';
  if (!latest.basisAvailable) return 'unavailable';
  return latest.claimRevision === ref.revision ? 'current' : 'revised';
}
/**
 * The student/teacher feedback read. The reopen view is C4's own projection, republished unchanged so a
 * granted-but-spent permission is never folded into `none`.
 */
export function readFeedbackView(tx: Transaction, scope: AttemptScope): FeedbackView {
  const attempt = ownedAttempt(tx, scope);
  const submissions = readSubmissions(tx, scope.attemptId, attempt), grants = readGrants(tx, scope.attemptId, attempt);
  return {...readFeedbackEntries(tx, scope),
    reopen: reopenView({attempt, submissions, grants}, actionableAssignment(tx, attempt))};
}

/**
 * Append one formal feedback revision inside the caller's authorized transaction. `kind=submission_review` names the
 * latest fixed submission and moves `submitted`→`reviewed` in this same transaction; `kind=formative` may cite any
 * real submission of the attempt and never moves the learning stage. An unadopted model draft is never written here.
 */
export function appendFeedbackInTransaction(tx: Transaction, scope: AttemptScope, teacherId: string,
  input: FeedbackFields, generation: string, now: string, options: {submissionId?: string} = {}) {
  const attempt = ownedAttempt(tx, scope);
  if (input.expectedFeedbackRevision !== readFeedbackScopeRevision(tx, scope)) throw new ApiError('VERSION_CONFLICT');
  const state = readState(tx, scope);
  if (input.expectedStateRevision !== state.learnerStateRevision) throw new ApiError('VERSION_CONFLICT');
  const submissions = readSubmissions(tx, scope.attemptId, attempt), latest = latestSubmission({submissions});
  const submissionId = options.submissionId ?? input.submissionId ?? latest?.submissionId;
  const submission = submissions.find(row => row.submissionId === submissionId);
  if (!submission) throw new ApiError('INVALID_REFERENCE');
  let reviewed = false;
  if (input.kind === 'submission_review') {
    if (latest?.submissionId !== submissionId) throw new ApiError('INVALID_REFERENCE');
    if (attempt.status === 'submitted') {
      if (!Number.isSafeInteger(input.expectedAttemptRevision)) throw new ApiError('INVALID_REQUEST');
      transitionAttemptInTransaction(tx, {attemptId: scope.attemptId, courseId: scope.courseId,
        expectedAttemptRevision: input.expectedAttemptRevision!, to: 'reviewed'});
      reviewed = true;
    } else if (attempt.status !== 'reviewed') throw new ApiError('STATE_CONFLICT');
  }
  for (const ref of input.evidenceRefs) resolveEvidence(tx, scope, ref, state);
  // The evaluation rests on the claims that were current when the teacher wrote it. Keeping those exact versions in
  // the record lets a later dispute resolve against what was actually evaluated instead of today's projection.
  const claimRefs = readProjectedCurrent(tx, scope).claims
    .filter(claim => ['active', 'contested'].includes(claim.validity))
    .map(claim => ({kind: 'claim' as const, id: claim.claimId, revision: claim.claimRevision}));
  const feedbackId = input.feedbackId ?? randomUUID();
  // A revision must stay inside the scope it belongs to: looking the thread up by ID alone would let a teacher in
  // one course/attempt append onto a thread owned by another, and would turn the per-thread revision into a global
  // maximum. Ownership is checked on the same four columns the row itself carries.
  const previous = input.feedbackId === undefined ? []
    : tx.all('SELECT feedback_revision FROM teacher_feedback WHERE feedback_id=? AND course_id=? AND student_id=? AND attempt_id=?',
      input.feedbackId, scope.courseId, scope.studentId, scope.attemptId);
  if (input.feedbackId !== undefined && !previous.length) throw new ApiError('INVALID_REFERENCE');
  const feedbackRevision = previous.reduce((max, row) => Math.max(max, Number(row.feedback_revision)), 0) + 1;
  const value = feedbackSchema.parse({feedbackId, feedbackRevision, courseId: scope.courseId, studentId: scope.studentId,
    attemptId: scope.attemptId, submissionId, teacherId, kind: input.kind, expectedStateRevision: input.expectedStateRevision,
    summary: input.summary, reason: input.reason, evidenceRefs: input.evidenceRefs, claimRefs, createdAt: now});
  tx.run(`INSERT INTO teacher_feedback(feedback_id,feedback_revision,course_id,student_id,attempt_id,submission_id,teacher_id,kind,expected_state_revision,feedback_json,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, value.feedbackId, value.feedbackRevision, value.courseId, value.studentId,
    value.attemptId, value.submissionId, value.teacherId, value.kind, value.expectedStateRevision, JSON.stringify(value), value.createdAt);
  const saved = readFeedbackRevisions(tx, scope).find(row => row.feedbackId === feedbackId && row.feedbackRevision === feedbackRevision);
  if (!saved || JSON.stringify(saved) !== JSON.stringify(value)) throw new ApiError('PERSISTENCE_UNAVAILABLE');
  // TECH §7.2.1: a related formal-feedback change invalidates the teaching context that depended on it.
  const invalidated = invalidateLearnerTeaching(tx, scope, feedbackId, generation, now, teacherId);
  const next = readAttempt(tx, scope.attemptId);
  return {feedbackId, feedbackRevision, submissionId, kind: input.kind, reviewed,
    attemptRevision: next.attemptRevision, decisionEpoch: next.decisionEpoch,
    stoppedJobIds: invalidated.jobIds, affectedAttemptIds: Object.keys(invalidated.epochs)};
}

/**
 * The revision permission for the latest fixed submission, planned in the caller's transaction and persisted once the
 * authorizing receipt exists. C4 owns the guard and the storage; A5 only binds it to the teacher command and to the
 * formal feedback the same command may save.
 */
export function planReopenInTransaction(tx: Transaction, scope: AttemptScope, teacherId: string,
  input: {expectedAttemptRevision: number;submissionId: string;reason: string}, now: string) {
  const attempt = ownedAttempt(tx, scope);
  if (attempt.status !== 'reviewed') throw new ApiError('STATE_CONFLICT');
  return planReopenGrant(tx, {attemptId: scope.attemptId, courseId: scope.courseId, grantedBy: teacherId,
    expectedAttemptRevision: input.expectedAttemptRevision, submissionId: input.submissionId, reason: input.reason,
    grantId: randomUUID(), now});
}

export type ReopenPlan = ReturnType<typeof planReopenGrant>;

/**
 * A4's dispute seam: resolve an exact feedback revision to whether it is still current and which claims it rested
 * on. Nothing is invented for a reference that was never saved, so A4 keeps returning `INVALID_REFERENCE`.
 */
export function feedbackTargetResolver(): FeedbackTargetResolver {
  return (tx, scope, ref) => {
    const rows = readFeedbackRevisions(tx, scope);
    const target = rows.find(row => row.feedbackId === ref.id && row.feedbackRevision === ref.revision);
    if (!target) return undefined;
    const newest = rows.filter(row => row.feedbackId === ref.id)
      .reduce((max, row) => Math.max(max, row.feedbackRevision), 0);
    return {current: newest === ref.revision, claimRefs: target.claimRefs};
  };
}

/** The C4 recovery surface A5 attaches: the formal feedback revisions, never a draft or a reconstructed digest. */
export function readRecoveryFeedback(tx: Transaction, scope: AttemptScope) {
  const entries = readFeedbackRevisions(tx, scope)
    .map(row => ({feedbackId: row.feedbackId, kind: row.kind, revision: row.feedbackRevision,
      submissionId: row.submissionId, createdAt: row.createdAt}));
  return {status: 'available' as const, feedbackRevision: readFeedbackScopeRevision(tx, scope), entries};
}

const domains = ['domain', 'project', 'ai_collaboration'] as const;
/**
 * READ-11. Teacher-only aggregate read: artifact facts, the three competency lines, help/unknown and coverage are
 * returned in separate groups and never collapsed into one verdict. Read-only — it activates nothing and enqueues
 * no job. Private validation assets and other students' content stay out because every part comes from a scope-
 * checked C/A read, and missing or withdrawn references are reported `unavailable` instead of being filled in.
 */
export function reviewContextInTransaction(tx: Transaction, attemptId: string, generation: string, submissionId?: string): ReviewContext {
  const attempt = readAttempt(tx, attemptId);
  const scope: AttemptScope = {courseId: attempt.courseId, studentId: attempt.studentId, attemptId};
  const state = loadWorkspace(tx, attemptId);
  const assignmentActive = actionableAssignment(tx, attempt);
  const projected = readWorkspace(state, () => true, assignmentActive);
  // C4 classifies a run's outcome (confirmed / incomplete / unknown / failed / …); reuse its projection rather than
  // restating that rule here. Only the `runs` group is taken from it, and the grant view comes from `projected`.
  const runs = readRecovery(state, {recoveryGeneration: generation, resyncRequired: false, assignmentActive,
    feedback: {status: 'unavailable'}, coverage: readCoverageIntervals(tx, attemptId)}, () => true).runs;
  const latest = latestSubmission(state);
  const chosen = submissionId === undefined ? latest : state.submissions.find(row => row.submissionId === submissionId);
  if (submissionId !== undefined && !chosen) throw new ApiError('INVALID_REFERENCE');
  const current = readProjectedCurrent(tx, scope);
  // The three competency lines are the current valid claims, so a claim that has no resolvable basis stays listed
  // with `basisAvailable: false` and per-reference `unavailable` rather than being dropped from the teacher's view.
  const competencyLines = current.claims.filter(claim => ['active', 'contested'].includes(claim.validity));
  return {
    attempt: structuredClone(attempt),
    submission: chosen ? structuredClone(chosen) : null,
    submissions: state.submissions.map(row => ({...structuredClone(row), latest: row.submissionId === latest?.submissionId})),
    artifact: projected.files.map(({fileId, path, documentVersion, contentHash, lifecycle}) => ({fileId, path, documentVersion, contentHash, lifecycle})),
    runs,
    help: readTeachingRecordsInTransaction(tx, scope, 'teacher'),
    coverage: readCoverageIntervals(tx, attemptId),
    competencies: Object.fromEntries(domains.map(domain => [domain, structuredClone(competencyLines.filter(claim => claim.domain === domain))])) as ReviewContext['competencies'],
    learnerStateRevision: current.learnerStateRevision,
    // A decision or a dispute belongs to the attempt it was made about; A4's read returns the course/student slice,
    // so this attempt-scoped view narrows it instead of republishing another attempt's history as this one's.
    decisions: structuredClone(current.decisions.filter(decision => decision.attemptId === attemptId)),
    disputes: structuredClone(current.disputes.filter(dispute => dispute.attemptId === attemptId)),
    feedback: readFeedbackEntries(tx, scope, current),
    reopen: structuredClone(projected.reopen),
  };
}
