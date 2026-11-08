import type { ComponentType, ReactNode } from 'react'
export type DesignDomain = 'domain' | 'project' | 'ai_collaboration'
export type PreviewSection = 'brief' | 'goals' | 'milestones' | 'support'
export type PreviewRole = 'student' | 'tutor' | 'teacher'
export type LiveRole = 'student' | 'tutor' | 'teacher-validator'
export interface DesignLinkProps { to: string; className?: string; children?: ReactNode }
export type DesignLinkComponent = ComponentType<DesignLinkProps>
export interface PreviewGoalDisplay { id: string; domain: DesignDomain; title: string; evidence: string }
export interface PreviewDraftDisplay {
  id: string; courseId: string; title: string; problem: string; audience: string; deliverable: string
  choices: string; foundation: string; duration: string; goals: PreviewGoalDisplay[]
  milestones: { id: string; title: string; evidence: string }[]
  rubric: { id: string; criterion: string; description: string }[]
  helpPolicy: string; resourceIds: string[]; revision: number; savedAt: string
}
export interface PreviewResourceDisplay {
  id: string; title: string; kind: 'learning' | 'reference' | 'private_answer' | 'validation'
  content: string; source: string; student: boolean; tutor: boolean; teacherDesign: boolean; version: number
}
export interface DesignCheckDisplay<S extends string = PreviewSection> { title: string; section: S }
export interface PreviewSuggestionDisplay { key: 'problem' | 'foundation' | 'helpPolicy'; title: string; before: string; after: string }
export interface GoalReferenceDisplay { competencyId: string; competencyVersion: number }
export interface LiveGoalDisplay extends GoalReferenceDisplay { domain: DesignDomain; title: string; core: boolean }
export interface LiveContentDisplay {
  projectTitle?: string; problem?: string; audience?: string; artifact?: string
  studentBackground?: string; timeConstraints?: string
  routes: string[]; goals: LiveGoalDisplay[]
  tasks: { taskId: string; title: string; goalRefs: GoalReferenceDisplay[] }[]
  observations: { observationId: string; description: string; goalRefs: GoalReferenceDisplay[]; taskIds: string[] }[]
  rubricCriteria: { criterionId: string; description: string; goalRefs: GoalReferenceDisplay[]; observationIds: string[] }[]
  milestones: { milestoneId: string; title: string; taskIds: string[] }[]
  resources: { resourceVersionId: string }[]
  digitalLogicConfigVersionId?: string; helpPolicyVersionId?: string; checkRuleVersionId?: string; runtimeProfileVersionId?: string
}
export interface LivePreviewDisplay {
  audience: LiveRole; revision: number
  content: Omit<LiveContentDisplay, 'resources'>
  materials: ({status:'available';resourceVersionId:string;title:string;text:string}|{status:'redacted'|'unavailable'})[]
}
export interface LiveConcernDisplay {
  code:'meaning'|'difficulty'|'time'|'solution_space'|'rubric_ambiguity'
  path:string;reason:string;resolution?:string
}
