import { useCallback, useEffect, useRef, useState } from 'react'
import { ContextGuard, nextLoadEpoch, type WorkspaceContext } from './context'
import { loadWorkspaceInit, type WorkspaceInit } from './init'
import { workspaceMode } from './mode'

/** 初始化读取的可见状态；`stale` 结果被丢弃，不成为一种展示状态。 */
export type InitStatus = 'loading' | 'ready' | 'unavailable'

export interface WorkspaceInitState {
  status: InitStatus
  /** ready 时是完整读取结果；unavailable 时保留具体不可用条件与阶段。 */
  init: WorkspaceInit | null
  /** 本次载入的本机 loadEpoch；界面上如实展示，便于核对迟到响应。 */
  loadEpoch: number
  /** 主动重新加载：换新的 loadEpoch 与上下文，旧上下文的在途响应立即失效。 */
  reload: () => void
}

/**
 * 工作区初始化读取的 React 绑定。
 *
 * 每次挂载与每次 `reload()` 都产生一个新的 `ContextGuard`（新的 loadEpoch），并把上一个
 * 上下文标记失效——因此卸载、切换任务、主动重载之后到达的旧响应不会写进当前工作区。
 * StrictMode 的双挂载正好验证这条规则：第一次载入的结果被判为 stale 并丢弃。
 */
export function useWorkspaceInit(): WorkspaceInitState {
  const [state, setState] = useState<{ status: InitStatus; init: WorkspaceInit | null; loadEpoch: number }>({
    status: 'loading',
    init: null,
    loadEpoch: 0,
  })
  const [nonce, setNonce] = useState(0)
  const guardRef = useRef<ContextGuard | null>(null)

  useEffect(() => {
    const context: WorkspaceContext = {
      mode: workspaceMode,
      userId: null,
      assignmentId: null,
      activityVersionId: null,
      attemptId: null,
      preparationEpoch: null,
      loadEpoch: nextLoadEpoch(),
      trustedRecoveryGeneration: null,
    }
    const guard = new ContextGuard(context)
    guardRef.current = guard
    setState({ status: 'loading', init: null, loadEpoch: context.loadEpoch })

    void loadWorkspaceInit(guard).then((init) => {
      // 上下文已失效或结果是 stale：丢弃，不动当前工作区
      if (guard.stale || init.kind === 'stale') return
      setState({
        status: init.kind === 'ready' ? 'ready' : 'unavailable',
        init,
        loadEpoch: context.loadEpoch,
      })
    })

    return () => {
      guard.dispose()
      if (guardRef.current === guard) guardRef.current = null
    }
  }, [nonce])

  const reload = useCallback(() => setNonce((n) => n + 1), [])

  return { ...state, reload }
}
