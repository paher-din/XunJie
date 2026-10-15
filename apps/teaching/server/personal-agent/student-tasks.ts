import type { SyntheticDatabase } from '../db/transaction.ts';
import { activityView } from '../design/activities.ts';
import { hasDisplayColumn, optionalDisplayText } from '../access/display-text.ts';
import type { StudentTaskSnapshot } from './types.ts';

const MAX_TASKS = 100;
const MAX_SCANNED_ASSIGNMENTS = 1_000;

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
      ORDER BY a.course_id,a.id LIMIT ?`, userId, MAX_SCANNED_ASSIGNMENTS + 1);
    // A truncated scan cannot choose the same representative as the home.
    if (rows.length > MAX_SCANNED_ASSIGNMENTS) throw new Error('Student task snapshot exceeds scan limit.');
    const visible: StudentTaskSnapshot['tasks'] = [];
    const positions = new Map<string, number>();
    for (const row of rows) {
      const courseId = String(row.course_id);
      // Use the same authorized student projection as the course home, including
      // visible materials. Private activity fields must never define a chat task.
      const activity = activityView(tx, { userId, courseId, role: 'student' }, String(row.activity_id));
      const displayTitle = optionalDisplayText(row.display_title);
      const title = displayTitle ?? optionalDisplayText(activity.content.content.projectTitle);
      if (!title) throw new Error('Fixed activity title unavailable.');
      const courseName = optionalDisplayText(row.course_name);
      const availability = row.assignment_status === 'active' && row.activity_status === 'active' ? 'active' as const : 'paused' as const;
      const task = {
        assignmentId: String(row.id), courseId, ...(courseName ? { courseName } : {}), title,
        availability,
      };
      const identity = JSON.stringify([
        courseId, userId, 'execution' in activity ? 'hdl_board' : 'textscope', displayTitle ?? null,
        activity.content, activity.helpPolicy, activity.runtimeProfileVersionId, activity.execution ?? null,
      ]);
      const position = positions.get(identity);
      if (position === undefined) {
        positions.set(identity, visible.length);
        visible.push(task);
      } else if (availability === 'active' || visible[position]!.availability === 'paused') {
        // The home prefers an available assignment, then the last ID in its stable list.
        visible[position] = task;
      }
    }
    return { tasks: visible.slice(0, MAX_TASKS), hasMore: visible.length > MAX_TASKS };
  });
}
