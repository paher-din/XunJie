import type { ReactNode } from 'react'
/** Read-only display projections; bootstrap, authorization and failure logging stay outside UI. */
export interface MaterialDisplay {
  index: number
  state: { kind: 'loaded'; view: { title: string; text: string; paragraphs: readonly unknown[] } }
    | { kind: 'not-readable'; reason: 'redacted' | 'unavailable' } | { kind: 'failed' }
}
export interface TextScopeReadyDisplay {
  kind: 'ready'
  context: { trustedRecoveryGeneration?: string | null; loadEpoch: number }
  session: { userId: string; courses: Array<{ courseId: string; role: string }> }
  assignment: { assignmentId: string; activityVersionId: string; studentId: string; status: string; active: boolean
    assignmentRevision: number; activityControlRevision: number; reasons: { individual?: string | null; activity?: string | null } }
  activity: { activityVersionId: string; runtimeProfileVersionId: string; courseId: string; status: string; activityControlRevision: number
    execution?: { kind: string }; helpPolicy: { versionId: string; helpAllowed: boolean; wholeSolutionAllowed: boolean }
    content: { content: { projectTitle: string; problem: string; artifact: string; audience: string; studentBackground: string; timeConstraints: string
      routes: string[]; goals: Array<{ title: string; domain: 'domain' | 'project' | 'ai_collaboration'; core: boolean }>
      tasks: Array<{ title: string }>; milestones: Array<{ title: string }>; observations: Array<{ description: string }>; rubricCriteria: Array<{ description: string }> } } }
  materials: MaterialDisplay[]
  prepContext: { scenarioId: string; preparationEpoch: string; authority: { activeSessions: number }
    capabilities: { attemptCreate: boolean; workspaceSync: boolean; snapshot: boolean; run: boolean } } | null
}
export type WorkspaceInitDisplay = TextScopeReadyDisplay | { kind: 'stale' } | { kind: 'unavailable'; stage: string; reason: string }
export interface TextScopeModeDisplay {
  preparation: boolean; courseLabel: string; prepNotice: string
  /** Router-specific return link only; the initialization panel itself is implemented here. */
  returnLink?: ReactNode
}
