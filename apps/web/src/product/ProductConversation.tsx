import { useEffect, useImperativeHandle, useState, type ReactNode, type RefObject } from 'react'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import { IconText } from '@xunjie/ui/icons'
import { useWorkspaceReferences, WorkspaceReferenceComposer } from '../components/workspace/references'
import { waitForComposerComposition } from '../components/workspace/references/composer-view'
import type { ActivityWorkspaceHandle } from './ActivityWorkspace'
import { ActivityActions } from './ActivityActions'
import { ActivityConversation, FirstQuestionAutoSend } from './ActivityConversation'
import { AgentInputMode } from './AgentInteraction'
import { useActivitySession } from './ActivitySession'
import { workspaceScope } from './learningTransport'
import { useTeachingArtifacts } from '../teaching-artifacts/useTeachingArtifacts'
import { AgentModelPicker, useAgentModelPicker } from './AgentModelPicker'
import type { ModelSelectionController } from './ModelSelection'
import './product-agent.css'

/** The same reliable activity session can be read as a conversation or opened as a workspace. */
export function ProductConversation({ activity, spaceKey, namespace, authorized, workspaceRef, onWorkspace, onModels, error, title, selection }: {
  activity: LearningActivity; spaceKey: string; namespace: string; authorized: boolean
  workspaceRef: RefObject<ActivityWorkspaceHandle | null>; onWorkspace(artifactId?: string): Promise<void>; onModels(): void; error?: ReactNode
  title?: string; selection: ModelSelectionController
}) {
  const { workspace, draft, actions, inputInteraction } = useActivitySession()
  const references = useWorkspaceReferences()
  const picker = useAgentModelPicker(selection, activity, spaceKey, namespace)
  const artifacts = useTeachingArtifacts(activity, spaceKey, namespace, authorized)
  const [active, setActive] = useState(false)
  const scope = workspaceScope(namespace, activity)
  useEffect(() => { if (!references.open) references.setOpen(true) }, [references.open])
  useImperativeHandle(workspaceRef, () => ({ leave: async () => {
    await waitForComposerComposition(scope)
    await workspace.leave(); await draft.leave(); await actions.leave()
  } }), [scope, workspace, draft, actions])

  return <div className="product-conversation">
    <header className="product-conversation-head">
      <h1>{title || activity.goal || activity.question || '自主学习'}</h1>
      <button type="button" className="outline" onClick={() => void onWorkspace()}><IconText name="arrow-right" position="end">进入工作区</IconText></button>
    </header>
    <div className="product-conversation-scroll">
      <div className="product-conversation-inner">
        {error}
        <FirstQuestionAutoSend activity={activity} />
        <ActivityConversation activity={activity} spaceKey={spaceKey} namespace={namespace} onModels={onModels} onActiveChange={setActive}
          artifacts={artifacts} onOpenArtifact={onWorkspace} />
        <details className="product-conversation-records"><summary>发送记录</summary><ActivityActions /></details>
      </div>
    </div>
    <div className="product-conversation-input">
      <details className="product-conversation-mode"><summary>发送方式</summary><AgentInputMode active={active} /></details>
      <WorkspaceReferenceComposer modelPicker={<AgentModelPicker controller={picker} disabled={!authorized || workspace.isReadOnly()} onSettings={onModels} />}
        sendBlocked={!inputInteraction.ready || picker.blocked}
        blockedHint={picker.blocked ? '正在切换模型，问题与引用仍保留。' : '正在核对本次发送方式，问题与引用仍保留。'}
        blockedLabel={picker.blocked ? '切换模型中…' : '核对发送方式…'}
        submitLabel={active ? inputInteraction.mode === 'queue' ? '排队发送' : '补充当前任务' : '发送问题'} />
    </div>
  </div>
}
