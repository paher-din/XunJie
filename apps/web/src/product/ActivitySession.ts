import { createContext, useContext } from 'react'
import type { ReliableWorkspace } from '../reliable-workspace'
import type { ReliableQuestionDraft } from '../reliable-workspace/draft'
import type { ReliableActions } from '../reliable-workspace/actions'
import type { ComponentInteractions } from '../component-host/interactions'
import type { ExecutionController } from '../tool-execution/controller'
import type { NativeSessionController } from '../tool-execution/session-controller'
import type { AgentInteractionController } from './AgentInteraction'
import type { LearningReadCache } from './learning-read-cache'

export const ActivitySessionContext = createContext<{
  workspace: ReliableWorkspace; draft: ReliableQuestionDraft; actions: ReliableActions; execution: ExecutionController
  sessions: NativeSessionController; interactions: ComponentInteractions; inputInteraction: AgentInteractionController
  readCache?: LearningReadCache; viewActive?: boolean
} | null>(null)
export function useActivitySession() {
  const session = useContext(ActivitySessionContext)
  if (!session) throw new Error('ActivitySessionContext is required')
  return session
}
