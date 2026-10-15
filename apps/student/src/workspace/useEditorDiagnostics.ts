import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { apiPost } from './http'
import type { CommandContext } from './frozenCommand'
import type { AttemptView, ConfirmedWorkspace } from './workspaceContracts'
import type { ProjectWorkspace } from '../components/workspace/useProjectWorkspace'
import { diagnosticNodeTarget, diagnosticSources, verifyEditorDiagnostics, type EditorDiagnosticsResult, type EditorDiagnosticMarkers } from './editorDiagnostics'
import { getExecutionNodes, subscribeExecutionNodes } from './executionNodes'

export function useEditorDiagnostics(project: ProjectWorkspace, context: CommandContext | null | undefined,
  workspace: ConfirmedWorkspace | null, attempt: AttemptView | null, blocked: boolean) {
  const [result, setResult] = useState<{ key: string; value: EditorDiagnosticsResult } | null>(null)
  const [retry, setRetry] = useState(0)
  const inFlight = useRef(false)
  const nodes = useSyncExternalStore(subscribeExecutionNodes, getExecutionNodes)
  const active = project.activeFile, drafts = project.files.filter(file => file.lifecycle === 'active').map(file => project.readCodeDraft(file.fileId))
  const supported = !!active && /\.(c|h|v|vh|sv|svh)$/i.test(active.path)
  const ready = !!context?.attemptId && !!context.trustedRecoveryGeneration && !!workspace && !!active && supported && !blocked && attempt?.status === 'active' && attempt.collecting
  const unconfirmed = !workspace || project.lifecyclePendingCount > 0 || drafts.some(draft => !draft?.serverFileId ||
    !workspace.files.some(file => file.fileId === draft.serverFileId && file.lifecycle === 'active'))
  const target = diagnosticNodeTarget(context, active?.path, nodes), destination = JSON.stringify(target)
  const key = JSON.stringify([context, attempt?.captureRevision, attempt?.collecting, blocked, workspace?.workspaceRevision, active?.fileId,
    drafts.map(draft => draft && [draft.fileId, draft.serverFileId, draft.text, draft.confirmed?.version]), destination])
  useEffect(() => {
    if (!ready || !target.ready || unconfirmed || !workspace || !context?.attemptId || !active) return
    let cancelled = false, retryTimer: ReturnType<typeof setTimeout> | undefined
    const destinationCurrent = () => destination === JSON.stringify(diagnosticNodeTarget(context, active.path, getExecutionNodes()))
    const timer = setTimeout(async () => {
      if (inFlight.current) { retryTimer = setTimeout(() => setRetry(value => value + 1), 500); return }
      inFlight.current = true
      try {
        const current = drafts.map(draft => {
          const file = workspace.files.find(file => file.fileId === draft!.serverFileId)!
          return { ...file, text: draft!.text }
        })
        const basis = await diagnosticSources(current)
        if (cancelled || !destinationCurrent()) return
        const body = { recoveryGeneration: context.trustedRecoveryGeneration, workspaceRevision: workspace.workspaceRevision,
          captureRevision: attempt!.captureRevision, fileId: project.readCodeDraft(active.fileId)!.serverFileId,
          files: current.map(file => ({ fileId: file.fileId, documentVersion: file.documentVersion,
            contentHash: workspace.files.find(source => source.fileId === file.fileId)!.contentHash, text: file.text })) }
        const response = await apiPost<unknown>(`/attempts/${encodeURIComponent(context.attemptId!)}/editor-diagnostics`, body,
          { mode: context.mode, scenarioId: context.scenarioId, timeoutMs: 20000, executionNodeId: target.nodeId })
        const value = verifyEditorDiagnostics(response, basis.hash, basis.sources)
        if (cancelled || !destinationCurrent()) return
        setResult({ key, value })
        if (['busy', 'stale'].includes(value.status)) retryTimer = setTimeout(() => setRetry(value => value + 1), 1500)
      } catch {
        if (!cancelled && destinationCurrent()) setResult({ key, value: { status: 'unavailable', sourceHash: '0'.repeat(64), diagnostics: [] } })
      } finally { inFlight.current = false }
    }, 500)
    return () => { cancelled = true; clearTimeout(timer); clearTimeout(retryTimer) }
  }, [key, ready, unconfirmed, retry, destination])
  const current = ready && target.ready && !unconfirmed && result?.key === key ? result.value : null
  const markers: EditorDiagnosticMarkers | undefined = current?.status === 'ready' && active
    ? { fileId: active.fileId, originalText: project.draftText(active.fileId),
      diagnostics: current.diagnostics.filter(item => item.fileId === project.readCodeDraft(active.fileId)?.serverFileId) } : undefined
  return { status: !supported ? 'unsupported' as const : !ready ? 'paused' as const : unconfirmed ? 'unconfirmed' as const : !target.ready ? 'unavailable' as const : current?.status ?? 'pending' as const,
    result: current, markers }
}
