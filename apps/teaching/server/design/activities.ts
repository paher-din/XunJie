import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Transaction, SqlRow } from '../db/transaction.ts';
import type { ActorContext } from '../../contracts/access/index.ts';
import { helpPolicySchema, checkRuleSchema, runtimeSchema, frozenActivityShape, activityViewSchema } from '../../contracts/design/index.ts';
import { ApiError } from '../app/errors.ts';
import { readDraft, draftMaterials, resourceSchema } from './storage.ts';
import { checkDraft, type TeacherConcern } from './checks.ts';
import { projectActivityContent } from './projection.ts';
import { readAttempt, saveAttempt, stopAttemptJobs } from '../db/records-adapter.ts';
import type { Purpose } from '../../contracts/records/index.ts';

const activitySchema = z.strictObject({ ...frozenActivityShape, materials: z.array(resourceSchema) });
const hash = (body: string) => createHash('sha256').update(body, 'utf8').digest('hex');
function checked<Schema extends z.ZodType>(schema: Schema, input: unknown): z.output<Schema> {
  const value = schema.safeParse(input);
  if (!value.success) throw new Error('Invalid persisted activity data.');
  return value.data;
}
function teacher(tx: Transaction, actor: ActorContext) {
  if (actor.role !== 'teacher' || !tx.get("SELECT user_id FROM course_memberships WHERE course_id=? AND user_id=? AND role='teacher' AND active=1", actor.courseId, actor.userId)) throw new ApiError('FORBIDDEN');
}
export function storePolicy(tx: Transaction, actor: ActorContext, input: unknown, now: number) {
  teacher(tx, actor);
  const policy = helpPolicySchema.parse(input), body = JSON.stringify(policy);
  const old = tx.get('SELECT policy_json FROM help_policy_versions WHERE id=? AND course_id=?', policy.versionId, actor.courseId);
  if (old) { if (String(old.policy_json) !== body) throw new ApiError('IDEMPOTENCY_CONFLICT'); return policy; }
  if (tx.get('SELECT id FROM help_policy_versions WHERE id=?', policy.versionId)) throw new ApiError('FORBIDDEN');
  tx.run('INSERT INTO help_policy_versions(id,course_id,created_by,created_at_ms,policy_json,content_hash) VALUES (?,?,?,?,?,?)',
    policy.versionId, actor.courseId, actor.userId, now, body, hash(body));
  return policy;
}
export function storeRule(tx: Transaction, actor: ActorContext, input: unknown, now: number) {
  teacher(tx, actor);
  const rule = checkRuleSchema.parse(input), body = JSON.stringify(rule), storageId = JSON.stringify([actor.courseId, rule.versionId]);
  const old = tx.get('SELECT rules_json FROM check_rule_versions WHERE id=? AND course_id=?', storageId, actor.courseId);
  if (old) { if (String(old.rules_json) !== body) throw new ApiError('IDEMPOTENCY_CONFLICT'); return rule; }

  tx.run('INSERT INTO check_rule_versions(id,course_id,created_by,created_at_ms,rules_json,content_hash) VALUES (?,?,?,?,?,?)',
    storageId, actor.courseId, actor.userId, now, body, hash(body));
  return rule;
}
export function releaseContext(tx: Transaction, courseId: string, blueprintId: string, concerns: TeacherConcern[], runtime?: z.infer<typeof runtimeSchema>) {
  const draft = readDraft(tx, courseId, blueprintId);
  const policyRow = tx.get('SELECT * FROM help_policy_versions WHERE id=? AND course_id=?', draft.content.helpPolicyVersionId ?? '', courseId);
  const ruleRow = tx.get('SELECT * FROM check_rule_versions WHERE id=? AND course_id=?', JSON.stringify([courseId, draft.content.checkRuleVersionId ?? '']), courseId);
  const helpPolicy = policyRow ? readVersion(helpPolicySchema, policyRow, 'policy_json') : undefined;
  const checkRule = ruleRow ? readVersion(checkRuleSchema, ruleRow, 'rules_json') : undefined;
  const materials = draftMaterials(tx, draft);
  const report = checkDraft(draft, { materials, concerns, helpPolicyVersionIds: helpPolicy ? [helpPolicy.versionId] : [],
    checkRuleVersionIds: checkRule ? [checkRule.versionId] : [], ...(runtime ? { runtimeProfile: { versionId: runtime.runtimeProfileVersion, ready: true } } : {}) });
  return { draft, materials, helpPolicy, checkRule, report };
}
function readVersion<Schema extends z.ZodType>(schema: Schema, row: SqlRow, field: string): z.output<Schema> {
  const body = String(row[field]);
  if (hash(body) !== row.content_hash) throw new Error('Invalid persisted version hash.');
  return checked(schema, JSON.parse(body));
}
export function confirmActivity(tx: Transaction, actor: ActorContext, blueprintId: string, revision: number, concerns: TeacherConcern[],
  runtime: z.infer<typeof runtimeSchema>, generation: string, now: number) {
  teacher(tx, actor);
  const context = releaseContext(tx, actor.courseId, blueprintId, concerns, runtime);
  if (context.draft.revision !== revision) throw new ApiError('VERSION_CONFLICT');
  if (context.report.blocking.some(item => item.code === 'runtime_not_ready')) throw new ApiError('RUNTIME_NOT_READY');
  if (context.report.blocking.length || !context.helpPolicy || !context.checkRule
    || context.report.designConcerns.some(item => item.status === 'requires_teacher')) throw new ApiError('INVALID_CONFIGURATION');
  const activity = checked(activitySchema, { activityVersionId: randomUUID(), courseId: actor.courseId, sourceBlueprintId: blueprintId,
    sourceRevision: revision, draft: context.draft, materials: context.materials, helpPolicy: context.helpPolicy, checkRule: context.checkRule,
    runtimeProfile: runtime, recoveryGeneration: generation, confirmedBy: actor.userId, confirmedAt: now });
  const body = JSON.stringify(activity);
  tx.run('INSERT INTO activity_versions(id,course_id,blueprint_id,source_revision,created_by,created_at_ms,activity_json,content_hash) VALUES (?,?,?,?,?,?,?,?)',
    activity.activityVersionId, actor.courseId, blueprintId, revision, actor.userId, now, body, hash(body));
  tx.run("INSERT INTO activity_controls(activity_id,control_revision,status,reason,controlled_by,controlled_at_ms) VALUES (?,1,'active','',?,?)",
    activity.activityVersionId, actor.userId, now);
  return { activityVersionId: activity.activityVersionId, sourceRevision: revision, activityControlRevision: 1,
    unverified: context.report.unverified, checks: context.report };
}
export function activityCourse(tx: Transaction, activityId: string) {
  const row = tx.get('SELECT course_id FROM activity_versions WHERE id=?', activityId);
  if (!row || typeof row.course_id !== 'string') throw new ApiError('FORBIDDEN');
  return row.course_id;
}
export function assignmentCourse(tx: Transaction, assignmentId: string) {
  const row = tx.get('SELECT course_id FROM assignments WHERE id=?', assignmentId);
  if (!row || typeof row.course_id !== 'string') throw new ApiError('FORBIDDEN');
  return row.course_id;
}
export function readActivity(tx: Transaction, courseId: string, activityId: string) {
  const row = tx.get('SELECT * FROM activity_versions WHERE id=? AND course_id=?', activityId, courseId);
  if (!row) throw new ApiError('FORBIDDEN');
  const activity = readVersion(activitySchema, row, 'activity_json');
  if (activity.activityVersionId !== row.id || activity.courseId !== row.course_id || activity.sourceBlueprintId !== row.blueprint_id
    || activity.sourceRevision !== row.source_revision || activity.draft.blueprintId !== activity.sourceBlueprintId
    || activity.draft.courseId !== activity.courseId || activity.draft.revision !== activity.sourceRevision
    || activity.confirmedBy !== row.created_by || activity.confirmedAt !== row.created_at_ms
    || activity.draft.content.helpPolicyVersionId !== activity.helpPolicy.versionId
    || activity.draft.content.checkRuleVersionId !== activity.checkRule.versionId
    || activity.draft.content.runtimeProfileVersionId !== activity.runtimeProfile.runtimeProfileVersion
    || activity.materials.some(material => material.courseId !== activity.courseId)
    || activity.draft.content.resources.some(ref => activity.materials.filter(material => material.resourceVersionId === ref.resourceVersionId).length !== 1)) throw new Error('Invalid persisted activity scope.');
  return activity;
}
const assignmentRowSchema = z.object({ id: z.string(), course_id: z.string(), student_id: z.string(), activity_id: z.string(),
  assignment_revision: z.number().int().positive(), status: z.enum(['active', 'paused']), individual_paused: z.union([z.literal(0), z.literal(1)]),
  paused_by_activity: z.union([z.literal(0), z.literal(1)]), individual_reason: z.string(), activity_reason: z.string() });
export function readAssignment(tx: Transaction, courseId: string, assignmentId: string) {
  const row = tx.get('SELECT * FROM assignments WHERE id=? AND course_id=?', assignmentId, courseId);
  if (!row) throw new ApiError('FORBIDDEN');
  const value = checked(assignmentRowSchema, row);
  if ((value.status === 'active') !== (value.individual_paused === 0 && value.paused_by_activity === 0)) throw new Error('Invalid persisted assignment status.');
  return value;
}
export function assignmentAvailability(tx: Transaction, courseId: string, assignmentId: string, studentId: string) {
  const assignment = readAssignment(tx, courseId, assignmentId);
  if (assignment.student_id !== studentId || !tx.get("SELECT user_id FROM course_memberships WHERE course_id=? AND user_id=? AND role='student' AND active=1", courseId, studentId)) throw new ApiError('FORBIDDEN');
  const control = tx.get('SELECT status,control_revision FROM activity_controls WHERE activity_id=?', assignment.activity_id);
  if (!control) throw new Error('Missing activity control.');
  return { assignment, active: assignment.status === 'active' && control.status === 'active', activityControlRevision: Number(control.control_revision) };
}
export function assignActivity(tx: Transaction, actor: ActorContext, activityId: string, students: string[], expectedControl: number, now: number) {
  teacher(tx, actor); readActivity(tx, actor.courseId, activityId);
  const control = tx.get('SELECT status,control_revision FROM activity_controls WHERE activity_id=?', activityId);
  if (control?.control_revision !== expectedControl) throw new ApiError('VERSION_CONFLICT');
  if (control.status !== 'active') throw new ApiError('STATE_CONFLICT');
  for (const student of students) if (!tx.get("SELECT user_id FROM course_memberships WHERE course_id=? AND user_id=? AND role='student' AND active=1", actor.courseId, student)) throw new ApiError('FORBIDDEN');
  const assignments = students.map(studentId => {
    const existing = tx.get('SELECT id FROM assignments WHERE activity_id=? AND student_id=?', activityId, studentId);
    if (existing) return readAssignment(tx, actor.courseId, String(existing.id));
    const assignmentId = randomUUID();
    tx.run("INSERT INTO assignments(id,course_id,student_id,activity_id,assignment_revision,status,individual_paused,paused_by_activity,individual_reason,activity_reason,controlled_by,controlled_at_ms) VALUES (?,?,?,?,1,'active',0,0,'','',?,?)",
      assignmentId, actor.courseId, studentId, activityId, actor.userId, now);
    return readAssignment(tx, actor.courseId, assignmentId);
  });
  return { assignments: assignments.map(a => ({ assignmentId: a.id, studentId: a.student_id, activityVersionId: a.activity_id, assignmentRevision: a.assignment_revision, status: a.status })) };
}
const pausePurposes: Purpose[] = ['student_help', 'reminder', 'explicit_analysis', 'passive_analysis', 'student_run'];
function invalidateAssignment(tx: Transaction, assignmentId: string) {
  const affected: string[] = [], stopped: string[] = [];
  for (const row of tx.all('SELECT attempt_id FROM attempts WHERE assignment_id=?', assignmentId)) {
    const attempt = readAttempt(tx, String(row.attempt_id));
    saveAttempt(tx, { ...attempt, attemptRevision: attempt.attemptRevision + 1, decisionEpoch: attempt.decisionEpoch + 1 });
    affected.push(attempt.attemptId);
    stopped.push(...stopAttemptJobs(tx, attempt, pausePurposes));
  }
  return { attemptIds: affected, stoppedJobIds: stopped };
}
export function controlAssignment(tx: Transaction, actor: ActorContext, assignmentId: string, expected: number, action: 'pause' | 'resume', reason: string, now: number) {
  teacher(tx, actor);
  const assignment = readAssignment(tx, actor.courseId, assignmentId);
  if (assignment.assignment_revision !== expected) throw new ApiError('VERSION_CONFLICT');
  const desired = Number(action === 'pause');
  if (assignment.individual_paused === desired) return { assignmentId, assignmentRevision: expected, status: assignment.status, stoppedJobIds: [], attemptIds: [] };
  const control = tx.get('SELECT status FROM activity_controls WHERE activity_id=?', assignment.activity_id);
  if (!control) throw new Error('Missing activity control.');
  if (action === 'resume' && control.status !== 'active') throw new ApiError('STATE_CONFLICT');
  const status = desired || assignment.paused_by_activity ? 'paused' : 'active';
  const changed = tx.run('UPDATE assignments SET assignment_revision=assignment_revision+1,status=?,individual_paused=?,individual_reason=?,controlled_by=?,controlled_at_ms=? WHERE id=? AND assignment_revision=?',
    status, desired, reason, actor.userId, now, assignmentId, expected);
  if (changed.changes !== 1) throw new ApiError('VERSION_CONFLICT');
  const invalidated = action === 'pause' ? invalidateAssignment(tx, assignmentId) : { stoppedJobIds: [], attemptIds: [] };
  return { assignmentId, assignmentRevision: expected + 1, status, ...invalidated };
}
export function controlActivity(tx: Transaction, actor: ActorContext, activityId: string, expected: number, action: 'pause' | 'resume', reason: string, now: number) {
  teacher(tx, actor); readActivity(tx, actor.courseId, activityId);
  const control = tx.get('SELECT * FROM activity_controls WHERE activity_id=?', activityId);
  if (control?.control_revision !== expected) throw new ApiError('VERSION_CONFLICT');
  const desired = action === 'pause' ? 'paused' : 'active';
  if (control.status === desired) return { activityVersionId: activityId, activityControlRevision: expected, status: desired, stoppedJobIds: [], attemptIds: [] };
  const changed = tx.run('UPDATE activity_controls SET control_revision=control_revision+1,status=?,reason=?,controlled_by=?,controlled_at_ms=? WHERE activity_id=? AND control_revision=?',
    desired, reason, actor.userId, now, activityId, expected);
  if (changed.changes !== 1) throw new ApiError('VERSION_CONFLICT');
  const attemptIds: string[] = [], stoppedJobIds: string[] = [];
  for (const row of tx.all('SELECT id FROM assignments WHERE activity_id=?', activityId)) {
    const assignment = readAssignment(tx, actor.courseId, String(row.id));
    const pausedByActivity = Number(action === 'pause');
    const status = pausedByActivity || assignment.individual_paused ? 'paused' : 'active';
    tx.run('UPDATE assignments SET assignment_revision=assignment_revision+1,status=?,paused_by_activity=?,activity_reason=?,controlled_by=?,controlled_at_ms=? WHERE id=?',
      status, pausedByActivity, reason, actor.userId, now, assignment.id);
    if (action === 'pause') { const invalidated = invalidateAssignment(tx, assignment.id); attemptIds.push(...invalidated.attemptIds); stoppedJobIds.push(...invalidated.stoppedJobIds); }
  }
  return { activityVersionId: activityId, activityControlRevision: expected + 1, status: desired, attemptIds, stoppedJobIds };
}
export function activityView(tx: Transaction, actor: ActorContext, activityId: string, audience: 'student' | 'tutor' | 'teacher-validator' = 'student') {
  const activity = readActivity(tx, actor.courseId, activityId);
  if (actor.role !== 'teacher') {
    if (audience === 'teacher-validator') throw new ApiError('FORBIDDEN');
    const assignment = tx.get('SELECT id FROM assignments WHERE activity_id=? AND student_id=?', activityId, actor.userId);
    if (!assignment) throw new ApiError('FORBIDDEN');
    assignmentAvailability(tx, actor.courseId, String(assignment.id), actor.userId);
  }
  const currentMaterials = draftMaterials(tx, activity.draft);
  const materials = activity.materials.filter(material => {
    const current = currentMaterials.find(item => item.resourceVersionId === material.resourceVersionId);
    if (!current) return false;
    if (JSON.stringify(current) !== JSON.stringify(material)) throw new Error('Fixed activity material changed.');
    return true;
  });
  const preview = projectActivityContent(activity.draft, audience, { materials,
    authorizeActivity: courseId => { if (courseId !== actor.courseId) throw new ApiError('FORBIDDEN'); } });
  const control = tx.get('SELECT status,control_revision FROM activity_controls WHERE activity_id=?', activityId);
  if (!control) throw new Error('Missing activity control.');
  return activityViewSchema.parse({ activityVersionId: activityId, courseId: actor.courseId, ...(actor.role === 'teacher' ? { sourceRevision: activity.sourceRevision } : {}),
    activityControlRevision: control.control_revision, status: control.status, content: { audience: preview.audience, content: preview.content, materials: preview.materials },
    helpPolicy: activity.helpPolicy, runtimeProfileVersionId: activity.runtimeProfile.runtimeProfileVersion });
}
