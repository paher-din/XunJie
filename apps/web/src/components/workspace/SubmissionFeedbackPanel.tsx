import { useEffect, useRef, useState } from 'react'
import type { ConfirmationWorkspace } from '../../workspace/confirmationWorkspace'
import type { AssignmentView } from '../../workspace/contracts'
import { SubmissionFeedbackWorkspace, type SubmissionState } from '../../workspace/submissionFeedback'
import type { SnapshotView } from '../../workspace/workspaceContracts'
import { SubmissionFeedbackPanel as SubmissionFeedbackView } from '@xunjie/ui/workspace'

interface Props {
  confirmation: ConfirmationWorkspace
  snapshots: SnapshotView[]
  unconfirmedCount: number
  onReturn: () => void
  onAssignmentChange?: (assignment: AssignmentView) => void
}
/** Uses the existing centre pane; it does not create or change a learning object while reading. */
export function SubmissionFeedbackPanel({ confirmation, snapshots, unconfirmedCount, onReturn, onAssignmentChange }: Props) {
  const [binding, setBinding] = useState<{ client: SubmissionFeedbackWorkspace; state: SubmissionState } | null>(null)
  const assignmentCallback = useRef(onAssignmentChange)
  assignmentCallback.current = onAssignmentChange
  const context = confirmation.context
  useEffect(() => {
    setBinding(null)
    const client = new SubmissionFeedbackWorkspace(confirmation)
    const unsubscribe = client.subscribe(state => setBinding({ client, state }))
    void client.refresh()
    return () => { unsubscribe(); client.dispose() }
  }, [confirmation, context])
  const state = binding?.state, client = binding?.client
  useEffect(() => { if (state?.assignment) assignmentCallback.current?.(state.assignment) }, [state?.assignment])
  const lifetime = useRef({ confirmation, context, revision: 0 })
  if (lifetime.current.confirmation !== confirmation || lifetime.current.context !== context) {
    lifetime.current = { confirmation, context, revision: lifetime.current.revision + 1 }
  }
  return <SubmissionFeedbackView state={state ?? null} snapshots={snapshots} unconfirmedCount={unconfirmedCount}
    resetKey={lifetime.current.revision} onReturn={onReturn}
    onRefresh={() => { void client?.refresh() }} onReconcile={() => { void client?.reconcile() }}
    onSubmit={(snapshotId, reflection, checks) => {
      const snapshot = snapshots.find(item => item.snapshotId === snapshotId)
      if (snapshot) void client?.submit(snapshot, reflection, checks)
    }} onResume={() => { void client?.resume() }} />
}
