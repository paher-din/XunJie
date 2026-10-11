export type ActorContext = { userId: string; courseId: string; role: 'teacher' | 'student' };
export type ResourceUse = 'read' | 'write' | 'teacher_design' | 'student_help' | 'teacher_sample';
// Returned exclusively by a trusted synchronous locator using the caller's current transaction.
export type ResourceScope =
  | { kind: 'student_work'; courseId: string; studentId: string; assignmentActive: boolean; stage: 'ready' | 'active' | 'paused' | 'submitted' | 'reviewed' }
  | { kind: 'blueprint'; courseId: string }
  | { kind: 'activity'; courseId: string; studentId?: string }
  | { kind: 'material'; courseId: string; studentId?: string; materialKind: 'learning_material' | 'private_answer' | 'validation_asset'; studentVisible: boolean; tutorVisible: boolean; teacherDesignAllowed: boolean };
