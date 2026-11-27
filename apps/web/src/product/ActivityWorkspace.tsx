import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { toast } from '@xunjie/ui/feedback'
import { CompilerProblemsPanel, FileStripView, type CodeEditorLocation, type EditorDiagnostic } from '@xunjie/ui/workspace'
import type { WorkFile, LearningActivity } from '@xunjie/contracts/learning-data'
import { workFileSchema } from '@xunjie/contracts/learning-data'
import { ALU_REFLECTION_MEDIA_TYPE, isAluCodeWork } from '@xunjie/contracts/alu-learning'
import { componentStateMediaType } from '@xunjie/contracts/components'
import { CodeReferenceSource } from '../components/workspace/references'
import { workspaceScope } from './learningTransport'
import { materialCache } from '../component-preparation/materials'
import { useActivitySession } from './ActivitySession'
import { isCompileFailure, parseCompilerLog } from '../tool-execution/compiler-log'

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
    const [closedTabs, setClosedTabs] = useState<string[]>([])
    useEffect(() => {
      if (location) {
        setClosedTabs(tabs => tabs.filter(id => id !== location.objectId))
        setSelected(location.objectId)
      }
    }, [location])
    const [merged, setMerged] = useState('')
    const visibleFiles = state.files.filter(f => f.mediaType !== ALU_REFLECTION_MEDIA_TYPE
      && !(f.mediaType === componentStateMediaType && /^components\/artifact-[0-9a-f-]{36}\.json$/.test(f.name)))
    const openFiles = visibleFiles.filter(f => !closedTabs.includes(f.objectId))
    const file = openFiles.find(f => f.objectId === selected) ?? openFiles[0]
    const latestRun = runs.records.find(({ action }) => action.protocolVersion === 3 && action.execution.initiator.kind === 'student'
      && ['run-single', 'check-all'].includes(action.execution.operation.operationId))
    const failed = authorized && latestRun && isCompileFailure(latestRun) ? latestRun : undefined
    const requestId = failed?.requestId, outputId = failed?.query.output?.contentId
    const [log, setLog] = useState<{ requestId: string; outputId: string; text: string } | null>(null)
    useEffect(() => {
      if (!requestId || !outputId) return
      let live = true
      void execution.artifact(requestId).then(artifact => {
        const resource = artifact?.resources?.find(item => item.name === 'diagnostics.txt' && item.mediaType === 'text/plain')
        if (live && resource) setLog({ requestId, outputId, text: resource.text })
      }).catch(() => { /* The execution summary remains available if the retained log cannot be read. */ })
      return () => { live = false }
    }, [execution, requestId, outputId])
    const output = log && log.requestId === requestId && log.outputId === outputId ? log.text
      : failed?.query.reason?.detail.split('\n').slice(1).join('\n') ?? ''
    const issues = useMemo(() => parseCompilerLog(output), [output])
    const sources = failed?.action.execution.basis.works.filter(isAluCodeWork) ?? []
    const currentSources = sources.filter(source => state.files.some(work => work.objectId === source.objectId
      && work.name === source.name && work.value === source.value))
    const stale = currentSources.length !== sources.length || sources.length !== state.files.filter(isAluCodeWork).length
    const sourceFor = (issue: EditorDiagnostic) => currentSources.find(source => source.name === issue.path)
    const basis = currentSources.find(source => source.objectId === file?.objectId)
    const diagnostics = basis ? { fileId: basis.objectId, originalText: basis.value, diagnostics: issues.filter(issue => issue.path === basis.name) } : undefined
    const editorWorkspaceKey = editorNamespace + ':' + state.editorEpoch
    const [jump, setJump] = useState<CodeEditorLocation>()
    const attempt = (operation: () => unknown) => { try { operation() } catch { toast.error('操作未完成，请检查文件名、内容大小或重复路径。原内容仍保留。') } }
    const openFile = (id: string) => {
      setJump(undefined)
      setClosedTabs(tabs => tabs.filter(closed => closed !== id))
      setSelected(id)
    }
    const closeFile = (id: string) => {
      setJump(undefined)
      void workspace.leave().then(() => {
        setClosedTabs(tabs => [...new Set([...tabs, id])])
        setSelected(selected => selected === id ? null : selected)
      }).catch(() => toast.error('当前修改尚未在本机保存，请保留标签后重试。'))
    }
    const manageName = (name: string, id?: string) => {
      if (!workFileSchema.shape.name.safeParse(name).success) return '请输入有效的文件名。'
      if (workspace.snapshot().files.some(file => file.name === name && file.objectId !== id)) return '已有同名文件。'
      try {
        if (id) workspace.rename(id, name)
        else openFile(workspace.create(name, /\.(c|cc|cpp|h|hpp|js|jsx|ts|tsx|py|v|vh|sv|svh|java|rs|go)$/i.test(name) ? 'code' : 'text'))
      } catch { return '文件操作未完成，请检查名称和作品状态。' }
    }
    const choose = async (files: WorkFile[]) => {
      try { await workspace.resolve(files) } catch { toast.error('比较期间作品再次变化，请重新打开活动核对。双方内容仍保留。') }
    }
    const download = () => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(state.files, null, 2)], { type: 'application/json;charset=utf-8' }))
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = '循阶作品备份.json'; anchor.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }
    return <section className="learning-workspace" aria-label="当前作品" tabIndex={-1} data-compile-failure={failed ? '' : undefined}
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
        <FileStripView files={visibleFiles.map(({ objectId, name }) => ({ id: objectId, name }))}
          openFiles={openFiles.map(({ objectId, name }) => ({ id: objectId, name }))} activeId={file?.objectId ?? null}
          readOnly={readOnly || !!state.conflict} canManage={id => visibleFiles.find(file => file.objectId === id)?.mediaType !== componentStateMediaType}
          onOpen={openFile} onClose={closeFile} onCreate={manageName} onRename={(id, name) => manageName(name, id)} onExport={download}
          onDelete={async id => {
            await workspace.remove(id)
            setClosedTabs(tabs => tabs.filter(closed => closed !== id))
            setSelected(selected => selected === id ? null : selected)
          }} />
        {file ? <>
          {file.encoding === 'utf8' && ['text', 'code'].includes(file.kind) ? <CodeReferenceSource key={state.editorEpoch}
            editorWorkspaceKey={editorWorkspaceKey} revealLocation={jump}
            fileId={file.objectId} sourceName={file.name} language={file.kind === 'text' ? 'plaintext' : /\.c(pp|c)?$/.test(file.name) ? 'cpp' : /\.(sv|svh|v|vh)$/.test(file.name) ? 'verilog' : 'plaintext'}
            initialText={file.value} readOnly={!!state.conflict || readOnly} readOnlyReason={readOnly ? '还原校验环境中的作品只读' : state.conflict ? '请先比较作品分歧' : null}
            workBasis={() => ({ objectId: file.objectId, contentId: file.contentId, name: file.name,
              kind: file.kind === 'text' ? 'text' : 'code', encoding: 'utf8', mediaType: file.mediaType })}
            diagnostics={diagnostics} onTextChange={(id, text) => attempt(() => workspace.edit(id, text))} onCursorChange={() => {}} />
            : <pre>{file.value}</pre>}
        </> : <div className="empty"><p>{visibleFiles.length ? '从「文件」中打开作品。' : '在「文件」中创建你的第一份作品。'}</p></div>}
        {failed && <CompilerProblemsPanel key={failed.requestId} issues={issues} stale={stale}
          canReveal={issue => !!sourceFor(issue)} onReveal={issue => {
            const source = sourceFor(issue)
            if (!source || !issue.line) return
            openFile(source.objectId)
            setJump({ workspaceKey: editorWorkspaceKey, fileId: source.objectId, originalText: source.value,
              range: issue.range ?? { startLine: issue.line, endLine: issue.line, startColumn: 1, endColumn: 1 } })
          }} />}
      </>}
    </section>
  }
