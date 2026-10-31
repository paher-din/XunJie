import { forwardRef, useEffect, useImperativeHandle, useMemo, useState, useSyncExternalStore } from 'react'
import { workViewSchema } from '@xunjie/contracts/learning-data'
import type { WorkFile, LearningActivity } from '@xunjie/contracts/learning-data'
import { ReliableWorkspace } from '../reliable-workspace'
import { CodeEditorHost } from '../components/workspace/CodeEditorHost'

export interface ActivityWorkspaceHandle { leave(): Promise<void> }
export const ActivityWorkspace = forwardRef<ActivityWorkspaceHandle, { activity: LearningActivity; spaceKey: string; namespace: string; authorized: boolean }>(
  function ActivityWorkspace({ activity, spaceKey, namespace, authorized }, ref) {
    const scope = JSON.stringify([namespace, activity.identity.environmentId, activity.identity.spaceId, activity.identity.principalId, activity.activityId])
    const workspace = useMemo(() => {
      const base = '/api/learning/workspaces/' + activity.activityId
      const request = async (suffix: string, body?: unknown) => {
        const response = await fetch(base + suffix, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store',
          headers: { 'content-type': 'application/json', 'x-xj-space': spaceKey, 'x-xj-namespace': namespace,
            'x-xj-expected-subject': [activity.identity.environmentId, activity.identity.spaceId, activity.identity.principalId].join('.') },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) })
        let value: unknown
        try { value = await response.json() } catch { throw Object.assign(new Error('原服务返回了不完整响应。'), { code: response.ok ? 'corrupt' : 'unavailable' }) }
        if (!response.ok) {
          const failure = value as { error?: string }
          throw Object.assign(new Error(failure?.error ?? 'unavailable'), { code: failure?.error ?? 'unavailable' })
        }
        try { return value === null && suffix.startsWith('/receipts/') ? null : workViewSchema.parse(value) }
        catch { throw Object.assign(new Error('原服务返回了不完整的作品数据。'), { code: 'corrupt' }) }
      }
      const instance = new ReliableWorkspace(scope, { read: async () => workViewSchema.parse(await request('')),
        receipt: id => request('/receipts/' + id), sync: async input => workViewSchema.parse(await request('', input)) })
      if (!authorized) instance.suspend()
      return instance
    }, [scope, activity.activityId, spaceKey, namespace, authorized])
    const state = useSyncExternalStore(workspace.subscribe, workspace.snapshot)
    const editorNamespace = useMemo(() => scope + ':' + crypto.randomUUID(), [scope, workspace])
    const [failure, setFailure] = useState('')
    const [selected, setSelected] = useState<string | null>(null)
    const [name, setName] = useState('')
    const [rename, setRename] = useState('')
    const [merged, setMerged] = useState('')
    useEffect(() => {
      void workspace.open().catch(() => { /* Workspace state reports failure and retries initialization. */ })
      return () => workspace.dispose()
    }, [workspace])
    useImperativeHandle(ref, () => ({ leave: () => workspace.leave() }), [workspace])
    const file = state.files.find(f => f.objectId === selected) ?? state.files[0]
    const attempt = (operation: () => unknown) => { try { operation(); setFailure('') } catch { setFailure('操作未完成，请检查文件名、内容大小或重复路径。原内容仍保留。') } }
    const choose = async (files: WorkFile[]) => {
      try { await workspace.resolve(files); setFailure('') } catch { setFailure('比较期间作品再次变化，请重新打开活动核对。双方内容仍保留。') }
    }
    const download = () => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(state.files, null, 2)], { type: 'application/json;charset=utf-8' }))
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = '循阶作品备份.json'; anchor.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }
    return <section className="learning-workspace" aria-label="当前作品">
      <h2>当前作品</h2>
      {(failure || state.error) && <div role="alert" className="learning-error"><p>{failure || state.error}</p>
        <button type="button" onClick={download}>导出当前作品</button>
        <label>可复制的当前原文<textarea readOnly value={file?.value ?? ''} /></label></div>}
      {!state.ready ? <p>正在读取作品…</p> : <>
        {state.conflict && <div role="alert" className="learning-error"><h3>作品存在分歧</h3>
          <p>双方内容均保留。请比较后选择，或在下方合并当前文件。</p>
          <div className="work-comparison"><div><h4>本页内容</h4>{state.conflict.local.map(f => <details key={f.objectId} open><summary>{f.name}</summary><pre>{f.value}</pre></details>)}</div>
            <div><h4>另一版本</h4>{state.conflict.other.map(f => <details key={f.objectId} open><summary>{f.name}</summary><pre>{f.value}</pre></details>)}</div></div>
          <button type="button" disabled={!state.conflictReady} onClick={() => void choose(state.conflict!.local)}>采用本页内容</button>
          <button type="button" disabled={!state.conflictReady} onClick={() => void choose(state.conflict!.other)}>采用另一版本</button>
          {file?.encoding === 'utf8' && <><label>合并内容<textarea value={merged} onChange={e => setMerged(e.target.value)} /></label>
            <button type="button" disabled={!state.conflictReady} onClick={() => void choose(state.conflict!.local.map(f => f.objectId === file.objectId ? { ...f, contentId: crypto.randomUUID(), value: merged } : f))}>采用合并内容</button></>}
        </div>}
          <form onSubmit={e => { e.preventDefault(); attempt(() => { setSelected(workspace.create(name, /\.(c|cc|cpp|h|hpp|js|jsx|ts|tsx|py|v|sv|java|rs|go)$/i.test(name) ? 'code' : 'text')); setName('') }) }}>
          <label>文件名<input value={name} required onChange={e => setName(e.target.value)} /></label>
          <button type="submit" disabled={!!state.conflict}>新建文件</button>
        </form>
        <nav aria-label="作品文件">{state.files.map(f => <button type="button" key={f.objectId} aria-pressed={f.objectId === file?.objectId}
          onClick={() => { setSelected(f.objectId); setRename('') }}>{f.name}</button>)}</nav>
        {file ? <>
          <form onSubmit={e => { e.preventDefault(); attempt(() => { workspace.rename(file.objectId, rename); setRename('') }) }}>
            <label>新名称<input value={rename} required onChange={e => setRename(e.target.value)} /></label>
            <button type="submit" disabled={!!state.conflict}>重命名</button>
            <button type="button" disabled={!!state.conflict} onClick={() => attempt(() => workspace.remove(file.objectId))}>删除文件</button>
          </form>
          {file.encoding === 'utf8' && ['text', 'code'].includes(file.kind) ? <CodeEditorHost key={state.editorEpoch} workspaceKey={editorNamespace + ':' + state.editorEpoch}
            fileId={file.objectId} language={file.kind === 'text' ? 'plaintext' : /\.c(pp|c)?$/.test(file.name) ? 'cpp' : /\.v$/.test(file.name) ? 'verilog' : 'plaintext'}
            initialText={file.value} readOnly={!!state.conflict} readOnlyReason={state.conflict ? '请先比较作品分歧' : null}
            onTextChange={(id, text) => attempt(() => workspace.edit(id, text))} onCursorChange={() => {}} />
            : <pre>{file.value}</pre>}
        </> : <p>从一个文本或代码文件开始。</p>}
      </>}
    </section>
  })
