import type { SyntheticDatabase } from '../db/transaction.ts';
import { readActivity } from '../design/activities.ts';
import { hasDisplayColumn, optionalDisplayText } from '../access/display-text.ts';
import type { StudentTaskSnapshot } from './types.ts';

const MAX_TASKS = 100;

/** A read-only, account-scoped summary. Assignment availability is not completion. */
export function readStudentTasks(db: SyntheticDatabase, userId: string): StudentTaskSnapshot {
  return db.withTransaction(tx => {
    const courseName = hasDisplayColumn(tx, 'courses', 'name') ? 'c.name AS course_name' : 'NULL AS course_name';
    const displayTitle = hasDisplayColumn(tx, 'assignments', 'display_title') ? 'a.display_title AS display_title' : 'NULL AS display_title';
    const rows = tx.all(`SELECT a.id,a.course_id,a.activity_id,a.status AS assignment_status,
        ${courseName},
        ${displayTitle},ac.status AS activity_status
      FROM assignments a
      JOIN course_memberships m ON m.course_id=a.course_id AND m.user_id=a.student_id
      JOIN users u ON u.id=a.student_id
      JOIN courses c ON c.id=a.course_id
      JOIN activity_controls ac ON ac.activity_id=a.activity_id
      WHERE a.student_id=? AND m.role='student' AND m.active=1 AND u.disabled_at_ms IS NULL
      ORDER BY a.course_id,a.id LIMIT ?`, userId, MAX_TASKS + 1);
    const hasMore = rows.length > MAX_TASKS;
    const tasks = rows.slice(0, MAX_TASKS).map(row => {
      const courseId = String(row.course_id);
      const activity = readActivity(tx, courseId, String(row.activity_id));
      const title = optionalDisplayText(row.display_title) ?? optionalDisplayText(activity.draft.content.projectTitle);
      if (!title) throw new Error('Fixed activity title unavailable.');
      const courseName = optionalDisplayText(row.course_name);
      return {
        assignmentId: String(row.id), courseId, ...(courseName ? { courseName } : {}), title,
        availability: row.assignment_status === 'active' && row.activity_status === 'active' ? 'active' as const : 'paused' as const,
      };
    });
    return { tasks, hasMore };
  });
}
