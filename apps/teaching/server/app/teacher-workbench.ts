import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { teacherWorkbenchSchema } from '../../contracts/design/workbench.ts';
import type { createVerificationApp } from '../access/app.ts';
import { activityView, readActivity, readAssignment } from '../design/activities.ts';
import { readDraft, readMaterial } from '../design/storage.ts';
import { readAttempt } from '../db/records-adapter.ts';
import { loadWorkspace } from '../workspace/storage.ts';
import { latestSubmission } from '../workspace/submissions.ts';
import { parseRequest } from './validation.ts';
import { ApiError } from './errors.ts';
import { hasDisplayColumn, optionalDisplayText } from '../access/display-text.ts';

type Access = Awaited<ReturnType<typeof createVerificationApp>>['access'];
const params = z.strictObject({ id: z.string().min(1).max(128) });

/** Registered only by an explicitly enabled normal review host. This query never starts a learner attempt. */
export function registerTeacherWorkbench(app: FastifyInstance, access: Access, currentGeneration: () => string) {
  app.get('/api/courses/:id/teacher-workbench', (request, reply) => {
    reply.header('cache-control', 'no-store');
    const courseId = parseRequest(params, request.params).id;
    const data = access.withAuthorizedCourse(request, courseId, 'teacher', (tx, actor) => {
      const recoveryGeneration = currentGeneration();
      if (!recoveryGeneration) throw new ApiError('RECOVERY_REQUIRED');
      // Display metadata is optional while the separate shared-data batch is being integrated. Missing columns
      // remain absent; this reader neither invents names nor performs a schema change.
      const userName = hasDisplayColumn(tx, 'users', 'display_name'), courseName = hasDisplayColumn(tx, 'courses', 'name'), assignmentTitle = hasDisplayColumn(tx, 'assignments', 'display_title');
      const course = courseName ? tx.get('SELECT name FROM courses WHERE id=?', courseId) : undefined;
      const courseDisplayName = optionalDisplayText(course?.name);
      const members = tx.all(`SELECT m.user_id${userName ? ',u.display_name' : ''} FROM course_memberships m JOIN users u ON u.id=m.user_id WHERE m.course_id=? AND m.role='student' AND m.active=1 AND u.disabled_at_ms IS NULL ORDER BY m.user_id`, courseId)
        .map(row => { const displayName = optionalDisplayText(row.display_name); return { userId: String(row.user_id), ...(displayName ? { displayName } : {}) }; });
      const resources = tx.all('SELECT id FROM resource_versions WHERE course_id=? ORDER BY created_at_ms,id', courseId)
        .map(row => readMaterial(tx, courseId, String(row.id)));
      const drafts = tx.all('SELECT id FROM blueprint_drafts WHERE course_id=? ORDER BY created_at_ms,id', courseId)
        .map(row => readDraft(tx, courseId, String(row.id)));
      const fixed = tx.all('SELECT id FROM activity_versions WHERE course_id=? ORDER BY created_at_ms,id', courseId)
        .map(row => readActivity(tx, courseId, String(row.id)));
      const activities = fixed.map(activity => activityView(tx, actor, activity.activityVersionId, 'teacher-validator'));
      const assignments = tx.all('SELECT id FROM assignments WHERE course_id=? ORDER BY id', courseId).map(row => {
        const assignment = readAssignment(tx, courseId, String(row.id));
        const control = tx.get('SELECT status FROM activity_controls WHERE activity_id=?', assignment.activity_id);
        const metadata = assignmentTitle ? tx.get('SELECT display_title FROM assignments WHERE id=? AND course_id=?', assignment.id, courseId) : undefined;
        const displayTitle = optionalDisplayText(metadata?.display_title);
        return { assignmentId: assignment.id, studentId: assignment.student_id, activityVersionId: assignment.activity_id,
          assignmentRevision: assignment.assignment_revision,
          ...(displayTitle ? { displayTitle } : {}),
          active: assignment.status === 'active' && control?.status === 'active' && members.some(member => member.userId === assignment.student_id) };
      });
      const attempts = tx.all('SELECT attempt_id FROM attempts WHERE course_id=? ORDER BY attempt_id', courseId).map(row => {
        const attempt = readAttempt(tx, String(row.attempt_id));
        const latest = latestSubmission(loadWorkspace(tx, attempt.attemptId));
        return {
          attemptId: attempt.attemptId, courseId: attempt.courseId, studentId: attempt.studentId,
          assignmentId: attempt.assignmentId, activityVersionId: attempt.activityVersionId,
          status: attempt.status, attemptRevision: attempt.attemptRevision, workspaceRevision: attempt.workspaceRevision,
          latestSubmission: latest ? { submissionId: latest.submissionId, snapshotId: latest.snapshotId, submittedAt: latest.submittedAt } : null,
        };
      });
      const presets = fixed.map(activity => ({ id: activity.activityVersionId,
        title: activity.draft.content.projectTitle ?? activity.activityVersionId,
        content: activity.draft.content, helpPolicy: activity.helpPolicy }));
      return teacherWorkbenchSchema.parse({ courseId, ...(courseDisplayName ? { courseName: courseDisplayName } : {}), recoveryGeneration, members, resources, drafts, activities, assignments, attempts, presets });
    }, false);
    return { requestId: request.id, data };
  });
}
