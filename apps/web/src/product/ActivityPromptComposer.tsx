import { useEffect, useRef, useState, type RefObject } from 'react'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import type { AgentConversation } from '@xunjie/contracts/agent-service'
import { questionReferenceKey } from '@xunjie/contracts/question-drafts'
import { useWorkspaceReferences, WorkspaceReferenceComposer } from '../components/workspace/references'
import { type ModelSelectionController } from './ModelSelection'
import { ProductPromptInput } from './ProductPromptInput'
import { useActivitySession } from './ActivitySession'
import { workspaceScope } from './learningTransport'
import { releaseComposerAttachments, resolveComposerAttachments, useComposerAttachments } from './composer-attachments'
import { sessionComposerActions } from './session-composer'
import { useAgentModelPicker } from './AgentModelPicker'
import { isAgentImage } from '../reliable-workspace/agent-images'

/** Shared durable input for the full conversation and the workspace sidebar. */
export function ActivityPromptComposer({ activity, spaceKey, namespace, authorized, selection, onModels, active, contextUsage, sending, closeFocusRef, onSend }: {
  activity: LearningActivity; spaceKey: string; namespace: string; authorized: boolean
  selection: ModelSelectionController; onModels?: () => void; active: boolean; onSend?: () => void
  contextUsage?: AgentConversation['contextUsage']; sending: RefObject<Promise<void> | null>; closeFocusRef?: RefObject<HTMLElement | null>
}) {
  const { workspace, draft, inputInteraction, agent } = useActivitySession()
  const references = useWorkspaceReferences()
  const scope = workspaceScope(namespace, activity)
  const controls = sessionComposerActions(agent, workspace.isReadOnly() || !authorized)
  const picker = useAgentModelPicker(selection)
  const files = useComposerAttachments(scope)
  const composerFiles = references.addImages ? { ...files, busy: files.busy || !!references.addingImages,
    async add(selected: File[]) {
      const images = selected.filter(isAgentImage)
      if (images.length) await references.addImages?.(images)
      await files.add(selected.filter(file => !isAgentImage(file)))
    },
  } : files
  const hasDraft = !!references.question.trim() || files.items.length > 0
  const [attachmentError, setAttachmentError] = useState('')
  const [preparing, setPreparing] = useState(false)
  const canSendFiles = useRef(false)
  const mounted = useRef(true)
  canSendFiles.current = authorized && !workspace.isReadOnly()
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  function sendWithAttachments(send: () => void | Promise<void>) {
    if (sending.current) return
    if (!files.items.length) return send()
    const staged = files.items
    setAttachmentError(''); setPreparing(true)
    sending.current = (async () => {
      try {
        const writable = () => mounted.current && canSendFiles.current
        const attachments = await resolveComposerAttachments(activity, spaceKey, namespace, staged, writable)
        if (!writable()) return
        const saved = draft.snapshot(), keys = new Set(saved.references.map(questionReferenceKey))
        draft.change(saved.question, [...saved.references, ...attachments.filter(item => !keys.has(questionReferenceKey(item)))])
        await draft.leave()
        if (!writable()) return
        files.detach(staged)
        void releaseComposerAttachments(staged).catch(() => {})
        await send()
      } catch (cause) { setAttachmentError(cause instanceof Error ? cause.message : '附件未就绪，原草稿已保留。') }
      finally { sending.current = null; setPreparing(false) }
    })()
    return sending.current
  }

  return <div className="activity-prompt-composer">
      {attachmentError && <p className="learning-error" role="alert">{attachmentError}</p>}
      {controls.error && <p className="learning-error" role="alert">{controls.error}</p>}
      <WorkspaceReferenceComposer closeFocusRef={closeFocusRef} sendBlocked={!inputInteraction.ready || picker.blocked}
        supportsImages={picker.supportsImages}
        blockedHint="正在核对本次发送方式，问题与引用仍保留。" blockedLabel="核对发送方式…"
        submitLabel={active ? inputInteraction.mode === 'queue' ? '排队发送' : '补充当前任务' : '发送问题'}
        renderInput={props => <ProductPromptInput {...props} sendLabel="发送消息" files={composerFiles} skills={references.skills}
          pasteImages={!!references.addImages} submitting={preparing}
          busy={controls.active && !hasDraft} onStop={controls.stop}
          onResume={controls.canResume && !hasDraft ? controls.resume : undefined}
          actionDisabled={controls.disabled} resumeLabel="继续生成"
          onSend={() => sendWithAttachments(() => { onSend?.(); return props.onSend() })} canSend={props.canSend && !preparing}
          selection={selection} modelLocked={active} contextUsage={contextUsage ?? agent?.conversation?.contextUsage}
          readOnly={workspace.isReadOnly() || !authorized} onModelSettings={onModels} />} />
  </div>
}
