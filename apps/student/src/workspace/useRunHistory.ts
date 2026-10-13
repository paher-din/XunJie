import { useCallback, useEffect, useState } from 'react'
import type { ConfirmationWorkspace } from './confirmationWorkspace'
import { RunHistory, emptyRunHistory, type RunHistoryState } from './runHistory'

/** 历史只在明确打开时读取；共用唯一确认上下文，不建第二份 head 或持久层。 */
export function useRunHistory(workspace: ConfirmationWorkspace | null, enabled: boolean) {
  const [client, setClient] = useState<RunHistory | null>(null)
  const [state, setState] = useState<RunHistoryState>(emptyRunHistory)
  useEffect(() => {
    setState(emptyRunHistory())
    if (!workspace || !enabled || !workspace.context.attemptId) { setClient(null); return }
    const current = new RunHistory(workspace)
    setClient(current)
    const unsubscribe = current.subscribe(setState)
    void current.initialize()
    return () => { unsubscribe(); current.dispose() }
  }, [workspace, enabled])
  const download = useCallback(async (side: 0 | 1, fileId: string) => {
    const file = await client?.download(side, fileId)
    if (!file || !client?.valid) return
    // Blob 仅作 text/plain 下载；没有 HTML 导航、作品写入或远程下载请求。
    const url = URL.createObjectURL(new Blob([new TextEncoder().encode(file.text)], { type: 'text/plain;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url; anchor.download = file.name.split('/').at(-1)!; anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }, [client])
  return { client, state, download }
}
