import { useEffect, useMemo, useState } from 'react'
import type { WorkspaceInit } from './init'
import { ConfirmationWorkspace, type ConfirmationState } from './confirmationWorkspace'
import { confirmationRepository, localInstanceOf } from './confirmationDb'
import type { ProjectSeed } from '../bridge/types'
import type { CommandContext } from './frozenCommand'
import { localFileIdOf, type InstanceRecord } from '../lib/draftStore'

export function projectSeedOf(state: ConfirmationState, instances: InstanceRecord[], taskId: string, assignmentActive: boolean): ProjectSeed | null {
  if (!state.workspace) return null
  // 实例对应关系由确认库维护（confirmationDb.localInstanceOf），视图不再自行重推规则。
  const claimed = new Set<string>()
  const files: ProjectSeed['files'] = state.workspace.files.map(f => {
    const instance = localInstanceOf(f, instances, claimed)
    const localId = instance ? localFileIdOf(instance.clientFileKey) : f.fileId
    if (instance) claimed.add(localId)
    return { fileId: localId, serverFileId: f.fileId, path: f.path, lifecycle: f.lifecycle,
      confirmed: { text: f.text, version: f.documentVersion } }
  })
  // 恢复可移除曾确认的实例，但本机实例和草稿仍须可打开。保留原 serverFileId，
  // freezeSync 将拒绝不在当前权威清单的旧实例，不把它自动当 create 补发。
  for (const instance of instances) {
    const localId = localFileIdOf(instance.clientFileKey)
    if (instance.lifecycle !== 'active' || files.some(f => f.fileId === localId)) continue
    files.push({ fileId: localId, serverFileId: instance.fileId === localId ? undefined : instance.fileId,
      path: instance.path, lifecycle: 'active', confirmed: null })
  }
  return { taskId, confirmedRevision: state.workspace.workspaceRevision,
    access: !state.attempt || ['submitted', 'reviewed'].includes(state.attempt.status)
      ? { kind: 'read-only', reason: state.attempt ? '作品已进入终态' : '权威 Attempt 尚待核对' }
      : state.attempt.status === 'paused' || !assignmentActive ? { kind: 'paused', reason: '分配或尝试已暂停' } : { kind: 'editable' },
    files }
}
const idle: ConfirmationState = { phase: 'idle', workspace: null, attempt: null, snapshot: null, pending: null,
  outcome: null, original: null, error: null }

/** 绑定一次 bootstrap；重新加载/退出/切换令旧客户端立即失效，页面不复用另一份确认状态。 */
export function useConfirmationWorkspace(init: WorkspaceInit | null, taskId: string) {
  const [client, setClient] = useState<ConfirmationWorkspace | null>(null)
  const [state, setState] = useState<ConfirmationState>(idle)
  const [instances, setInstances] = useState<InstanceRecord[]>([])
  const ready = init?.kind === 'ready' ? init : null
  useEffect(() => {
    setState(idle); setInstances([])
    if (!ready) { setClient(null); return }
    const context: CommandContext = { ...ready.context, courseId: ready.activity.courseId,
      attemptId: ready.context.attemptId ?? ready.prepContext?.refs.attemptId ?? null,
      scenarioId: ready.prepContext?.scenarioId }
    const current = new ConfirmationWorkspace(context)
    setClient(current)
    let live = true, readSeq = 0
    const unsubscribe = current.subscribe(value => {
      const seq = ++readSeq
      if (!value.workspace) { if (live) setState(value); return }
      // 映射和 head 同事务；先读回关联再一起换可见 seed，防止短暂创建第二个 model。
      void confirmationRepository.read(current.context).then(local => {
        if (!live || seq !== readSeq) return
        setInstances(local.instances); setState(value)
      }).catch(e => {
        if (!live || seq !== readSeq) return
        setState({ ...value, phase: 'error', error: `本机确认读取失败：${e instanceof Error ? e.message : String(e)}` })
      })
    })
    void current.initialize()
    return () => { live = false; unsubscribe(); current.dispose() }
  }, [ready])
  const seed = useMemo(() => projectSeedOf(state, instances, taskId, ready?.assignment.active ?? false), [state.workspace, state.attempt, instances, taskId, ready?.assignment.active])
  return { client, state, seed }
}
