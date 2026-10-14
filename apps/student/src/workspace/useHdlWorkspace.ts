import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConfirmationWorkspace } from './confirmationWorkspace'
import type { WorkspaceInit } from './init'
import { apiGet } from './http'
import { HdlWorkspace, emptyHdlState, type HdlState } from './hdlWorkspace'
import { hdlSettled } from './hdlStore'

/** One authorized confirmation context; polling reads facts and never creates or replays operations. */
export function useHdlWorkspace(workspace: ConfirmationWorkspace | null, init: WorkspaceInit | null) {
  const [client, setClient] = useState<HdlWorkspace | null>(null)
  const [state, setState] = useState<HdlState>(emptyHdlState)
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible')
  const [online, setOnline] = useState(() => navigator.onLine)
  const ticks = useRef({ key: '', count: 0, notified: false })
  const context = workspace?.context
  useEffect(() => {
    setState(emptyHdlState())
    if (!workspace || !context?.attemptId || init?.kind !== 'ready' || init.activity.execution?.kind !== 'hdl_board') {
      setClient(null); return
    }
    const execution = init.activity.execution, cfg = execution.configuration
    const current = new HdlWorkspace(workspace, {
      runtimeProfileVersion: execution.runtimeProfileVersion, engineVersion: cfg.runtime.engineVersion,
      boardProfileVersion: cfg.board.boardProfileVersion, mappingVersion: cfg.board.mappingVersion,
      buildImage: cfg.runtime.buildImage, recoveryGeneration: context.trustedRecoveryGeneration,
      configurationVersion: cfg.versionId, contentHash: execution.contentHash, sourceHash: cfg.runtime.sourceHash,
      read: async () => {
        if (init.session.userId !== context.userId || init.assignment.assignmentId !== context.assignmentId ||
          init.activity.activityVersionId !== context.activityVersionId || init.activity.courseId !== context.courseId ||
          init.context.trustedRecoveryGeneration !== context.trustedRecoveryGeneration || !workspace.isCurrent(context)) return false
        const value = await apiGet<unknown>('/health/ready', { mode: context.mode, absolutePath: '/health/ready', timeoutMs: 6500 })
        return workspace.isCurrent(context) && !!value && typeof value === 'object' && 'status' in value && value.status === 'ready'
      },
    })
    setClient(current)
    const unsubscribe = current.subscribe(setState)
    let started = false
    const stopConfirmation = workspace.subscribe(value => {
      if (!started && value.attempt && ['ready', 'readonly'].includes(value.phase)) {
        started = true; void current.initialize()
      }
    })
    const reconnect = () => { ticks.current.count = 0; ticks.current.notified = false; void current.initialize() }
    window.addEventListener('online', reconnect)
    return () => { window.removeEventListener('online', reconnect); stopConfirmation(); unsubscribe(); current.dispose() }
  }, [workspace, context, init])
  useEffect(() => {
    const update = () => { setVisible(document.visibilityState === 'visible'); setOnline(navigator.onLine) }
    document.addEventListener('visibilitychange', update)
    window.addEventListener('online', update); window.addEventListener('offline', update)
    return () => { document.removeEventListener('visibilitychange', update); window.removeEventListener('online', update); window.removeEventListener('offline', update) }
  }, [])
  useEffect(() => {
    const session = state.session
    const waiting = !!state.job && !hdlSettled(state.job.status) || !!session && !session.terminationConfirmed &&
      (session.pendingOperationId !== undefined || session.status === 'starting' || session.status === 'stopping' || session.stopRequested ||
        !state.operation || state.operation.sessionId !== session.sessionId || state.operation.sequence < session.confirmedSequence)
    if (!client || !waiting || state.busy || state.phase === 'reading' || !online || state.phase === 'read-unknown') return
    const key = `${state.job?.jobId ?? ''}/${session?.pendingOperationId ?? ''}/${session?.stopRequested ?? ''}`
    if (ticks.current.key !== key) ticks.current = { key, count: 0, notified: false }
    if (ticks.current.count >= 60) {
      if (!ticks.current.notified) { ticks.current.notified = true; client.pollingExhausted() }
      return
    }
    const timer = window.setTimeout(() => { ticks.current.count++; void client.read() }, visible ? 1000 : 10_000)
    return () => window.clearTimeout(timer)
  }, [client, state, online, visible])
  const read = useCallback(() => { ticks.current.count = 0; ticks.current.notified = false; void client?.read() }, [client])
  return { client, state, read }
}
