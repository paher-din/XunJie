import type { ActorContext, ResourceScope, ResourceUse } from '../../contracts/access/index.ts';
import { ApiError } from '../app/errors.ts';

export function assertResourceUse(actor: ActorContext, scope: ResourceScope, use: ResourceUse) {
  if (!scope.courseId || scope.courseId !== actor.courseId) throw new ApiError('FORBIDDEN');
  if (actor.role === 'teacher') {
    if (scope.kind === 'student_work' && use !== 'read') throw new ApiError('FORBIDDEN');
    if (use === 'teacher_design' && (scope.kind === 'activity' || scope.kind === 'student_work'
      || (scope.kind === 'material' && !scope.teacherDesignAllowed))) throw new ApiError('FORBIDDEN');
    if (use === 'student_help' || (use === 'teacher_sample' && scope.kind !== 'blueprint')) throw new ApiError('FORBIDDEN');
    return;
  }
  if (use === 'teacher_design' || use === 'teacher_sample' || scope.kind === 'blueprint'
    || !('studentId' in scope) || scope.studentId !== actor.userId) throw new ApiError('FORBIDDEN');
  if (scope.kind === 'material') {
    if (use === 'write' || scope.materialKind !== 'learning_material'
      || (use === 'student_help' ? !scope.tutorVisible : !scope.studentVisible)) throw new ApiError('FORBIDDEN');
  } else if (scope.kind === 'activity') {
    if (use === 'write') throw new ApiError('FORBIDDEN');
  } else if (use !== 'read' && (!['ready', 'active', 'paused'].includes(scope.stage)
    || (use === 'student_help' && (!scope.assignmentActive || scope.stage === 'paused')))) throw new ApiError('STATE_CONFLICT');
}
