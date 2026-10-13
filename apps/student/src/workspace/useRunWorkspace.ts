import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ConfirmationWorkspace } from './confirmationWorkspace'
import { RunWorkspace, emptyRunState, type RunState } from './runWorkspace'
import { displayRun, settledJob } from './runResults'
import type { WorkspaceInit } from './init'

/** 一个确认上下文一个运行客户端；不创建第二份 head/快照状态或新的 ContextGuard。 */
export function useRunWorkspace(workspace: ConfirmationWorkspace | null, init: WorkspaceInit | null) {
  const [client, setClient] = useState<RunWorkspace | null>(null)
  const [state, setState] = useState<RunState>(emptyRunState)
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible')
  const [online, setOnline] = useState(() => navigator.onLine)
  const ticks = useRef({ runId: '', count: 0 })
  const context = workspace?.context
  useEffect(() => {
    setState(emptyRunState())
    if (!workspace || !context?.attemptId || init?.kind !== 'ready') { setClient(null); return }
    const current = new RunWorkspace(workspace, {
      // 当前真实 H-04 尚未交接；不能把 activity profile 或合成配置等同于 runtime readiness。
      verified: context.mode === 'preparation' && init.prepContext?.capabilities.run === true,
      runtimeProfileVersion: init.activity.runtimeProfileVersionId, recoveryGeneration: context.trustedRecoveryGeneration,
    })
    setClient(current)
    const unsubscribe = current.subscribe(setState)
    // 先等 03 初始化安装权威 head；同时抢第一次 GET 会因读取序号失效而永久落到未知。
    let started = false
    const stopConfirmation = workspace.subscribe(value => {
      if (!started && value.attempt && ['ready', 'readonly'].includes(value.phase)) {
        started = true
        void current.initialize()
      }
    })
    return () => { unsubscribe(); stopConfirmation(); current.dispose() }
  }, [workspace, context, init])
  useEffect(() => {
    const update = () => { setVisible(document.visibilityState === 'visible'); setOnline(navigator.onLine) }
    document.addEventListener('visibilitychange', update)
    window.addEventListener('online', update); window.addEventListener('offline', update)
    return () => { document.removeEventListener('visibilitychange', update); window.removeEventListener('online', update); window.removeEventListener('offline', update) }
  }, [])
  useEffect(() => {
    const job = state.job
    if (!client || !job || settledJob(job.status) || state.phase === 'submitting' || state.controlBusy || !online) return
    if (ticks.current.runId !== job.runId) ticks.current = { runId: job.runId, count: 0 }
    if (ticks.current.count >= 60) { client.pollingExhausted(); return }
    const timer = window.setTimeout(() => {
      ticks.current.count++
      void client.readResult()
    }, visible ? 1000 : 10_000)
    return () => window.clearTimeout(timer)
  }, [client, state, visible, online])
  const read = useCallback(() => {
    ticks.current.count = 0
    void client?.initialize()
  }, [client])
  const result = useMemo(() => displayRun(state.run, state.job, state.command,
    workspace?.current.snapshots.find(s => s.snapshotId === state.run?.snapshotId)?.workspaceRevision ?? state.command?.runSnapshot?.workspaceRevision),
  [state.run, state.job, state.command, workspace?.current.snapshots])
  return { client, state, result, read }
}
