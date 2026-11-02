import { createContext, useContext } from 'react'
import type { ReliableWorkspace } from '../reliable-workspace'
import type { ReliableQuestionDraft } from '../reliable-workspace/draft'
import type { ReliableActions } from '../reliable-workspace/actions'
import type { ExecutionController } from '../tool-execution/controller'

export const ActivitySessionContext = createContext<{
  workspace: ReliableWorkspace; draft: ReliableQuestionDraft; actions: ReliableActions; execution: ExecutionController
} | null>(null)
export function useActivitySession() {
  const session = useContext(ActivitySessionContext)
  if (!session) throw new Error('ActivitySessionContext is required')
  return session
}
