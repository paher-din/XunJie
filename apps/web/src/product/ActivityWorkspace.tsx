import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { toast } from '@xunjie/ui/feedback'
import type { WorkFile, LearningActivity } from '@xunjie/contracts/learning-data'
import { ALU_REFLECTION_MEDIA_TYPE } from '@xunjie/contracts/alu-learning'
import { componentStateMediaType } from '@xunjie/contracts/components'
import { CodeReferenceSource } from '../components/workspace/references'
import { FileStripView, type FileStripViewHandle } from '@xunjie/ui/workspace'
import { workFileSchema } from '@xunjie/contracts/learning-data'
import { workspaceScope } from './learningTransport'
import { materialCache } from '../component-preparation/materials'
import { useActivitySession } from './ActivitySession'

export interface ActivityWorkspaceHandle { leave(): Promise<void> }
export function ActivityWorkspace({ activity, namespace, spaceKey, authorized, location }: { activity: LearningActivity; spaceKey: string; namespace: string; authorized: boolean; location?: { objectId: string } }) {
    const scope = workspaceScope(namespace, activity)
    const { workspace,execution } = useActivitySession()
    const runs=useSyncExternalStore(execution.subscribe,execution.snapshot)
    const readOnly = workspace.isReadOnly()
    const state = useSyncExternalStore(workspace.subscribe, workspace.snapshot)
    const editorNamespace = useMemo(() => scope + ':' + crypto.randomUUID(), [scope, workspace])
    const [starterError, setStarterError] = useState('')
    useEffect(()=>{
      let live=true
      if(!state.ready || !authorized || readOnly || !activity.course?.starterWorks.length)return
      void (async()=>{
        const files:WorkFile[]=[]
        for(const starter of activity.course!.starterWorks) {
          if(!starter.materialId)continue
          const material=activity.course!.materials.find(m=>m.materialId===starter.materialId)
          if(!material)throw new Error('起始作品来源缺失。')
          // Same fixed definition and same verified bytes as the material list: a starter already
          // held by this browser is read without asking the service again.
          const value=await materialCache.text(activity,activity.course!,spaceKey,namespace,material)
          // Starter ids name a published template, not a row in this activity's work store.
          // A per-activity object id keeps two activities of the same release from colliding
          // on the work store's global object identity (#206 identity-conflict).
          files.push({objectId:crypto.randomUUID(),contentId:crypto.randomUUID(),name:starter.title,kind:/\.(sv|v|c|py|js)$/.test(starter.title)?'code':'text',encoding:'utf8',mediaType:'text/plain',value})
        }
        if(live) {
          if(files.length)workspace.initializeStarters(files)
          setStarterError('')
        }
      })().catch(error=>{if(live)setStarterError(error instanceof Error?error.message:'无法读取起始作品。')})
      return()=>{live=false}
    },[activity,spaceKey,namespace,state.ready,authorized,readOnly,workspace])
    const [selected, setSelected] = useState<string | null>(null)
    const [openIds, setOpenIds] = useState<string[] | null>(null)
    const strip = useRef<FileStripViewHandle>(null)
    const [merged, setMerged] = useState('')
    const visibleFiles = state.files.filter(f => f.mediaType !== ALU_REFLECTION_MEDIA_TYPE
      && !(f.mediaType === componentStateMediaType && /^components\/artifact-[0-9a-f-]{36}\.json$/.test(f.name)))
    const ids = openIds ?? visibleFiles.slice(0, 1).map(f => f.objectId)
    const opened = ids.flatMap(id => { const file = visibleFiles.find(item => item.objectId === id); return file ? [file] : [] })
    const file = opened.find(f => f.objectId === selected) ?? opened[0]
    const openFile = (id: string) => { setOpenIds(current => [...new Set([...(current ?? ids), id])]); setSelected(id) }
    useEffect(() => { if (location) { setOpenIds(current => [...new Set([...(current ?? []), location.objectId])]); setSelected(location.objectId) } }, [location])
    const closeFile = (id: string) => {
      const remaining = ids.filter(item => item !== id)
      setOpenIds(remaining)
      if (file?.objectId === id) setSelected(remaining[Math.max(0, ids.indexOf(id) - 1)] ?? null)
    }
    const latestRun=runs.records.find(r=>r.action.protocolVersion===3)
    const failed=latestRun?.query.state==='failed'?latestRun:undefined
    const basis=file&&failed?.action.execution.basis.works.find(f=>f.objectId===file.objectId&&f.name===file.name&&f.value===file.value)
    const diagnostics=basis ? {fileId:basis.objectId,originalText:basis.value,diagnostics:[...(failed?.query.reason?.detail??'').matchAll(/^\/?([^:\n]+):(\d+):\s*(.+)$/gm)]
      .filter(match=>match[1]===basis.name).map(match=>({severity:'error' as const,path:basis.name,line:Number(match[2]),message:match[3]}))}:undefined
    const attempt = (operation: () => unknown) => { try { operation() } catch { toast.error('操作未完成，请检查文件名、内容大小或重复路径。原内容仍保留。') } }
    const validateName = (name: string, id?: string) => {
      if (!workFileSchema.shape.name.safeParse(name).success) return '请输入有效的相对文件名，不含空路径、反斜线或控制字符。'
      if (state.files.some(item => item.name === name && item.objectId !== id)) return `已存在「${name}」，请打开已有文件或使用其他名称。`
      return null
    }
    const manageFile = (operation: () => void) => {
      if (readOnly || state.conflict) return '当前作品不可修改，请先处理只读状态或作品分歧。'
      try { operation(); return null } catch { return '文件操作未完成，原内容仍保留。请检查作品限制后重试。' }
    }
    const choose = async (files: WorkFile[]) => {
      try { await workspace.resolve(files) } catch { toast.error('比较期间作品再次变化，请重新打开活动核对。双方内容仍保留。') }
    }
    const download = () => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(state.files, null, 2)], { type: 'application/json;charset=utf-8' }))
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = '循阶作品备份.json'; anchor.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }
    return <section className="learning-workspace" aria-label="当前作品" tabIndex={-1}
      data-work-object-id={file?.objectId} data-work-content-id={file?.contentId}>
      {(starterError || state.error) && <div role="alert" className="learning-error"><p>{starterError || state.error}</p>
        <button type="button" className="ws-btn ghost" onClick={download}>导出当前作品</button>
        <label>可复制的当前原文<textarea readOnly value={file?.value ?? ''} /></label></div>}
      {!state.ready ? <p role="status" aria-label="正在读取作品" /> : <>
        {state.conflict && <div role="alert" className="learning-error"><h3>作品存在分歧</h3>
          <p>双方内容均保留。请比较后选择，或在下方合并当前文件。</p>
          <div className="work-comparison"><div><h4>本页内容</h4>{state.conflict.local.map(f => <details key={f.objectId} open><summary>{f.name}</summary><pre>{f.value}</pre></details>)}</div>
            <div><h4>另一版本</h4>{state.conflict.other.map(f => <details key={f.objectId} open><summary>{f.name}</summary><pre>{f.value}</pre></details>)}</div></div>
          <button type="button" className="ws-btn ghost" disabled={!state.conflictReady} onClick={() => void choose(state.conflict!.local)}>采用本页内容</button>
          <button type="button" className="ws-btn ghost" disabled={!state.conflictReady} onClick={() => void choose(state.conflict!.other)}>采用另一版本</button>
          {file?.encoding === 'utf8' && <><label>合并内容<textarea value={merged} onChange={e => setMerged(e.target.value)} /></label>
            <button type="button" className="ws-btn ghost" disabled={!state.conflictReady} onClick={() => void choose(state.conflict!.local.map(f => f.objectId === file.objectId ? { ...f, contentId: crypto.randomUUID(), value: merged } : f))}>采用合并内容</button></>}
        </div>}
        <FileStripView ref={strip} files={visibleFiles.map(f => ({ id: f.objectId, name: f.name }))}
          openFiles={opened.map(f => ({ id: f.objectId, name: f.name }))} activeId={file?.objectId ?? null}
          disabled={!!state.conflict || readOnly} canManage={id => visibleFiles.find(f => f.objectId === id)?.mediaType !== componentStateMediaType}
          onOpen={openFile} onClose={closeFile} onExport={download}
          onCreate={name => validateName(name) ?? manageFile(() => openFile(workspace.create(name,
            /\.(c|cc|cpp|h|hpp|js|jsx|ts|tsx|py|v|vh|sv|svh|java|rs|go)$/i.test(name) ? 'code' : 'text')))}
          onRename={(id, name) => validateName(name, id) ?? manageFile(() => workspace.rename(id, name))}
          onDelete={id => manageFile(() => { workspace.remove(id); closeFile(id) })} />
        {file ? <>
          {file.encoding === 'utf8' && ['text', 'code'].includes(file.kind) ? <CodeReferenceSource key={state.editorEpoch}
            editorWorkspaceKey={editorNamespace + ':' + state.editorEpoch}
            fileId={file.objectId} sourceName={file.name} language={file.kind === 'text' ? 'plaintext' : /\.c(pp|c)?$/.test(file.name) ? 'cpp' : /\.(sv|svh|v|vh)$/.test(file.name) ? 'verilog' : 'plaintext'}
            initialText={file.value} readOnly={!!state.conflict || readOnly} readOnlyReason={readOnly ? '还原校验环境中的作品只读' : state.conflict ? '请先比较作品分歧' : null}
            workBasis={() => ({ objectId: file.objectId, contentId: file.contentId, name: file.name,
              kind: file.kind === 'text' ? 'text' : 'code', encoding: 'utf8', mediaType: file.mediaType })}
            diagnostics={diagnostics} onTextChange={(id, text) => attempt(() => workspace.edit(id, text))} onCursorChange={() => {}} />
            : <pre>{file.value}</pre>}
        </> : <div className="empty product-work-empty"><h2>{visibleFiles.length ? '没有打开的文件' : '从第一份作品开始'}</h2><p>{visibleFiles.length ? '从上方「文件」列表打开作品，或创建新文件。' : '创建代码或笔记，边实践边记录你的思考。'}</p>
          <button type="button" className="ws-btn solid" disabled={readOnly || !!state.conflict} onClick={() => strip.current?.startNaming()}>新建文件</button></div>}
      </>}
    </section>
  }
