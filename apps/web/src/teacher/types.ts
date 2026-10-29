import type { TeacherWorkbench } from './wire'

export interface TeacherCourse { id: string; title: string; code: string; term: string; kind: 'c' | 'hdl' | 'mixed' | 'unknown' }
export type ActivityStatus = 'draft' | 'active' | 'paused' | 'completed'
export interface TeacherActivity {
  id: string; courseId: string; title: string; description: string; status: ActivityStatus
  version: number; assigned: number; submitted: number; reviewed: number; due: string
  snapshot?: DesignDraft; studentIds?: string[]; resourceVersions?: TeacherResource[]
}
export interface DesignGoal { id: string; domain: 'domain' | 'project' | 'ai_collaboration'; title: string; evidence: string }
export interface DesignDraft {
  id: string; courseId: string; title: string; problem: string; audience: string; deliverable: string
  choices: string; foundation: string; duration: string; goals: DesignGoal[]
  milestones: { id: string; title: string; evidence: string }[]
  rubric: { id: string; criterion: string; description: string }[]
  helpPolicy: string; resourceIds: string[]; revision: number; savedAt: string
}
export interface TeacherResource {
  id: string; courseId: string; title: string; kind: 'learning' | 'reference' | 'private_answer' | 'validation'
  content: string; source: string; student: boolean; tutor: boolean; teacherDesign: boolean; version: number
  format?: 'txt' | 'markdown' | 'paste'
}
export interface TeacherEvidence {
  id: string; type: '作品' | '运行记录' | '学生自述' | '辅导消息'; title: string; text: string
  source: string; assistance: string
}
export interface TeacherLearner {
  id: string; name: string; courseId: string; activityId: string; activityTitle: string
  status: 'ready' | 'active' | 'submitted' | 'reviewed' | 'paused'; route: string; updated: string
  submission: string; version: number; evidence: TeacherEvidence[]
  claims: { id: string; domain: string; text: string; state: 'insufficient' | 'supported_with_assistance' | 'supported_in_check' | 'conflicting'; evidenceIds: string[] }[]
  unknowns: string[]; feedback: string; decision: string; revisionAllowed: boolean
}
export interface TeacherData {
  courses: TeacherCourse[]; activities: TeacherActivity[]; drafts: DesignDraft[]
  resources: TeacherResource[]; learners: TeacherLearner[]
  workbenches?: TeacherWorkbench[]
}
export interface TeacherWorkspace {
  preview: boolean; base: string; data: TeacherData; courseId: string; setCourseId: (id: string) => void
  notify: (text: string) => void
  saveDraft: (draft: DesignDraft) => void
  saveResource: (resource: TeacherResource) => Promise<void>
  saveReview: (learner: TeacherLearner) => void
  releaseDraft: (draft: DesignDraft, studentIds: string[]) => void
  refresh: () => void; loading: boolean; error: string
  retryPending?: () => Promise<void>; pendingCommand?: boolean
}
