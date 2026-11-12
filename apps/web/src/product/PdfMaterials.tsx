import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import { useToastFeedback } from '@xunjie/ui/feedback'
import { PDF_LIMITS, pdfDocumentSchema, pdfReadingSchema, pdfReferenceCopy, pdfReferenceSourceSchema,
  type PdfDocument, type PdfReading, type PdfRegion } from '@xunjie/contracts/pdf-materials'
import { questionReferenceSourceId } from '@xunjie/contracts/question-drafts'
import { useWorkspaceReferences } from '../components/workspace/references'
import { acknowledgePdfRequest, listPdfRequests, retainCoursePdf, retainPdfUpload, type PdfMaterialRequest } from '../reliable-workspace/pdf-materials'
import { learningRequest, workspaceScope } from './learningTransport'
import './PdfMaterials.css'

type PdfSource = ReturnType<typeof pdfReferenceSourceSchema.parse>
type ReadRequest = { requestId: string; documentId: string; pages: number[]; region: PdfRegion | null }
const documentStates: Record<PdfDocument['state'], string> = {
  received: '原文件已接收，页信息尚未准备完成。请核对并继续原请求。', ready: '可阅读',
  damaged: 'PDF 已损坏，无法读取。请检查原文件后添加有效副本。', encrypted: 'PDF 已加密，请添加解除密码后的副本。',
  limit: `PDF 超出页数或处理限制（最多 ${PDF_LIMITS.pages} 页）。请拆分后添加。`,
  timeout: 'PDF 解析超时，原文件仍保留。请添加简化后的副本。', failed: 'PDF 解析失败，原文件仍保留。请检查文件后添加有效副本。',
}
function failureText(error: unknown) {
  if (error instanceof Error && error.name === 'ZodError') return 'PDF 响应缺少必要的文件、页图或定位信息，请核对原请求。已有引用仍保留。'
  const code = (error as { code?: string })?.code
  if (code === 'forbidden') return '当前活动的访问资格已失效，请恢复原空间登录后核对。'
  if (code === 'missing') return '原服务尚未找到这份 PDF 或固定阅读记录。原引用和待接收请求仍保留。'
  if (code === 'identity-conflict') return '原请求身份发生冲突，请核对原服务；不会自动更换请求或文件身份。'
  if (code === 'invalid') return 'PDF 请求未被接受，请核对文件、实际页码或选区。原文件与请求仍保留。'
  if (code === 'corrupt') return 'PDF 来源或固定页图不完整，当前无法展示；不会重新渲染替换原引用。'
  if (code === 'maintenance') return '学习服务正在维护，原请求已保留，请稍后核对。'
  if (code || (error instanceof Error && ['TimeoutError', 'AbortError', 'TypeError'].includes(error.name)))
    return '尚未确认原服务结果，已保留原请求。请恢复连接后重试核对。'
  return error instanceof Error ? error.message : 'PDF 操作未完成，请重试。'
}
const sourceOf = (reading: PdfReading): PdfSource => ({ kind: 'pdf', activityId: reading.activityId,
  documentId: reading.documentId, documentSha256: reading.documentSha256, readingId: reading.readingId })
const availableReading = (reading: PdfReading | null) => {
  try { if (reading) { pdfReferenceCopy(reading); return true } } catch { /* Partial reads cannot become references. */ }
  return false
}

/** Kept by ActivityPage, so changing/closing a center tab cannot reset pending operations. */
export function usePdfMaterials({ activity, spaceKey, namespace, authorized, reveal }: {
  activity: LearningActivity; spaceKey: string; namespace: string; authorized: boolean; reveal(): Promise<void>
}) {
  const references = useWorkspaceReferences()
  const scope = workspaceScope(namespace, activity)
  const [documents, setDocuments] = useState<PdfDocument[]>([])
  const [requests, setRequests] = useState<PdfMaterialRequest[]>([])
  const [document, setDocument] = useState<PdfDocument | null>(null)
  const [reading, setReading] = useState<PdfReading | null>(null)
  const [pendingRead, setPendingRead] = useState<ReadRequest | null>(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [notice, setNotice] = useState('')
  useToastFeedback(error)
  useToastFeedback(notice, 'success')
  const alive = useRef(false), operation = useRef(false), readEpoch = useRef(0), listEpoch = useRef(0)
  const current = useRef({ authorized, readOnly: !!references.readOnly, reveal })
  current.current = { authorized, readOnly: !!references.readOnly, reveal }
  const api = useCallback((suffix = '', body?: unknown) => learningRequest(activity, spaceKey, namespace,
    `pdf/${activity.activityId}${suffix}`, body), [scope, spaceKey, namespace])
  const canWrite = () => alive.current && current.current.authorized && !current.current.readOnly
  const adopt = (doc: PdfDocument) => {
    if (doc.activityId !== activity.activityId) throw new Error('PDF 不属于当前活动。')
    if (alive.current) setDocuments(items => [...items.filter(item => item.documentId !== doc.documentId), doc])
    return doc
  }
  const refresh = useCallback(async () => {
    const epoch = ++listEpoch.current
    setLoading(true)
    try {
      const local = await listPdfRequests(scope)
      if (alive.current && epoch === listEpoch.current) {
        setRequests(local)
        setDocuments(items => [...items, ...local.flatMap(item => item.document && !items.some(doc => doc.documentId === item.document!.documentId) ? [item.document] : [])])
      }
      if (!current.current.authorized) return
      const value = await api()
      if (!Array.isArray(value)) throw new Error('PDF 列表不完整，请重新读取。')
      const docs = value.map(item => pdfDocumentSchema.parse(item))
      if (docs.some(item => item.activityId !== activity.activityId)) throw new Error('PDF 列表不属于当前活动。')
      if (alive.current && epoch === listEpoch.current) { setDocuments(docs); setError(''); setLoadError('') }
    } catch (error) {
      if (alive.current && epoch === listEpoch.current) { const message = failureText(error); setError(message); setLoadError(message) }
    }
    finally { if (alive.current && epoch === listEpoch.current) setLoading(false) }
  }, [scope, api, activity.activityId])
  useEffect(() => {
    alive.current = true
    void refresh()
    return () => { alive.current = false; ++readEpoch.current; ++listEpoch.current }
  }, [refresh])
  const previousAuthorized = useRef(authorized)
  useEffect(() => {
    if (authorized && !previousAuthorized.current) void refresh()
    previousAuthorized.current = authorized
  }, [authorized, refresh])

  const addReference = (fixed: PdfReading) => {
    if (!canWrite() || !references.draftReady) return
    const copy = pdfReferenceCopy(fixed), source = sourceOf(fixed)
    references.select({ snapshot: { workspaceKey: references.workspaceKey,
      sourceId: questionReferenceSourceId(source), sourceName: `${fixed.documentName} · 第 ${fixed.requestedPages.join('、')} 页${fixed.region ? '选区' : ''}`.slice(0, 300),
      kind: 'semantic', text: copy, sourceText: copy, source,
      range: { formatVersion: 1, typeId: 'pdf-pages', version: 1, start: 0, end: copy.length,
        target: { pages: fixed.requestedPages, region: fixed.region, coordinates: fixed.coordinates } } }, anchor: () => null })
    references.ask()
    setNotice('已加入当前问题草稿。')
  }
  async function read(input: ReadRequest, quote = false, expectedDocument = document) {
    if (!canWrite() || operation.current) return
    operation.current = true; setBusy(true); setError(''); setNotice(''); setPendingRead(input)
    const epoch = ++readEpoch.current
    setReading(null)
    try {
      const fixed = pdfReadingSchema.parse(await api('/read', input))
      if (fixed.activityId !== activity.activityId || fixed.documentId !== input.documentId
        || (expectedDocument && fixed.documentSha256 !== expectedDocument.sha256)
        || JSON.stringify(fixed.requestedPages) !== JSON.stringify(input.pages)
        || JSON.stringify(fixed.region) !== JSON.stringify(input.region)) throw new Error('PDF 阅读响应与所选页或区域不一致。')
      if (!alive.current || epoch !== readEpoch.current) return
      setReading(fixed); setPendingRead(null)
      if (quote && availableReading(fixed)) {
        // Registering the source is an effect; queue the explicit add until it is registered.
        quoteAfterRead.current = fixed.readingId
      }
    } catch (error) { if (alive.current && epoch === readEpoch.current) setError(failureText(error)) }
    finally { operation.current = false; if (alive.current && epoch === readEpoch.current) setBusy(false) }
  }
  async function openDocument(doc: PdfDocument) {
    if (!alive.current || operation.current) return
    operation.current = true; setBusy(true)
    try {
      await current.current.reveal()
      if (!alive.current) return
      setDocument(doc); setReading(null); setPendingRead(null); setError(''); setNotice('')
      operation.current = false; setBusy(false)
      if (doc.state === 'ready') await read({ requestId: crypto.randomUUID(), documentId: doc.documentId, pages: [1], region: null }, false, doc)
    } catch (error) { if (alive.current) setError(failureText(error)) }
    finally { operation.current = false; if (alive.current) setBusy(false) }
  }
  async function receive(record: PdfMaterialRequest) {
    if (!canWrite() || operation.current) return
    ++listEpoch.current; setLoading(false)
    operation.current = true; setBusy(true); setError(''); setNotice('')
    try {
      let value: unknown
      // Query before replay; an unknown outcome never creates a new upload identity.
      try { value = await api(`/documents/${record.input.documentId}`) }
      catch (error) { if ((error as { code?: string }).code !== 'missing') throw error }
      if (value === undefined || pdfDocumentSchema.parse(value).state === 'received') {
        if (!canWrite()) return
        value = await api(record.kind === 'course' ? '/course' : '', record.input)
      }
      const candidate = pdfDocumentSchema.parse(value)
      if (candidate.activityId !== activity.activityId) throw new Error('PDF 接收结果不属于当前活动。')
      if (record.kind === 'course' && (candidate.sha256 !== activity.course?.materials.find(item => item.materialId === record.input.materialId)?.sha256
        || candidate.courseSource?.releaseId !== activity.course?.releaseId || candidate.courseSource?.materialId !== record.input.materialId))
        throw new Error('课程 PDF 与本活动绑定的发布版本不一致，原请求仍保留。')
      const doc = await acknowledgePdfRequest(record, candidate)
      if (!alive.current) return
      const saved = await listPdfRequests(scope)
      if (!alive.current) return
      adopt(doc); setRequests(saved)
      operation.current = false; setBusy(false)
      await openDocument(doc)
    } catch (error) { if (alive.current) setError(failureText(error)) }
    finally { operation.current = false; if (alive.current) setBusy(false) }
  }
  async function upload(file: File) {
    if (!canWrite() || operation.current) return
    ++listEpoch.current; setLoading(false)
    operation.current = true; setBusy(true); setError('')
    try {
      const record = await retainPdfUpload(scope, file)
      // Navigation may finish while File.arrayBuffer/IndexedDB is pending. Keep its original scope.
      if (!canWrite()) return
      const saved = await listPdfRequests(scope)
      if (!canWrite()) return
      setRequests(saved)
      operation.current = false; setBusy(false)
      await receive(record)
    } catch (error) { if (alive.current) setError(failureText(error)) }
    finally { operation.current = false; if (alive.current) setBusy(false) }
  }
  async function openCourse(materialId: string) {
    if (!canWrite() || operation.current) return
    const existing = documents.find(doc => doc.courseSource?.releaseId === activity.course?.releaseId && doc.courseSource?.materialId === materialId)
    if (existing && existing.state !== 'received') { await openDocument(existing); return }
    ++listEpoch.current; setLoading(false)
    operation.current = true; setBusy(true); setError('')
    try {
      await current.current.reveal()
      if (!canWrite()) return
      const record = await retainCoursePdf(scope, materialId, existing)
      if (!canWrite()) return
      const saved = await listPdfRequests(scope)
      if (!canWrite()) return
      setRequests(saved)
      operation.current = false; setBusy(false)
      await receive(record)
    } catch (error) { if (alive.current) setError(failureText(error)) }
    finally { operation.current = false; if (alive.current) setBusy(false) }
  }
  const locate = async (value: unknown, targetPage?: number) => {
    const parsed = pdfReferenceSourceSchema.safeParse(value)
    if (!parsed.success || parsed.data.activityId !== activity.activityId)
      return { ok: false as const, reason: 'PDF 引用不属于当前活动，固定副本仍保留。' }
    if (operation.current) return { ok: false as const, reason: '正在处理 PDF，请完成后再定位原引用。' }
    const epoch = ++readEpoch.current
    operation.current = true; setBusy(true); setError('')
    try {
      const source = parsed.data
      const value = await api(`/reads/${source.readingId}`)
      if (value === null) throw new Error('固定阅读记录尚不可用；不会重新渲染替换原引用。')
      const fixed = pdfReadingSchema.parse(value)
      if (fixed.activityId !== source.activityId || fixed.readingId !== source.readingId
        || fixed.documentId !== source.documentId || fixed.documentSha256 !== source.documentSha256)
        throw new Error('固定阅读记录的来源不一致，原引用仍保留。')
      const doc = pdfDocumentSchema.parse(await api(`/documents/${source.documentId}`))
      if (doc.activityId !== source.activityId || doc.documentId !== source.documentId || doc.sha256 !== source.documentSha256)
        throw new Error('PDF 原文件身份与固定阅读记录不一致。')
      if (!alive.current || epoch !== readEpoch.current) return { ok: false as const, reason: '已离开原活动。' }
      await current.current.reveal()
      if (!alive.current || epoch !== readEpoch.current) return { ok: false as const, reason: '已离开原活动。' }
      adopt(doc); setDocument(doc); setReading(fixed); setPendingRead(null); setNotice('已打开引用时保留的页图。')
      for (let attempt = 0; attempt < 120 && alive.current && epoch === readEpoch.current; attempt++) {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
        const target = targetPage === undefined ? null
          : window.document.querySelector<HTMLElement>(`[data-pdf-reading-id="${CSS.escape(fixed.readingId)}"] [data-pdf-page="${targetPage}"]`)
        const readingTarget = target ?? window.document.querySelector<HTMLElement>(`[data-pdf-reading-id="${CSS.escape(fixed.readingId)}"]`)
        if (readingTarget) { readingTarget.focus(); readingTarget.scrollIntoView({ block: 'nearest' }); return { ok: true as const } }
      }
      return { ok: false as const, reason: '固定页图已读取，但当前布局未能打开阅读位置。' }
    } catch (error) {
      const reason = failureText(error)
      if (alive.current && epoch === readEpoch.current) setError(reason)
      return { ok: false as const, reason }
    } finally { operation.current = false; if (alive.current && epoch === readEpoch.current) setBusy(false) }
  }
  const latest = useRef({ locate, addReference }); latest.current = { locate, addReference }
  const sourceIds = JSON.stringify([...new Set([
    ...documents.map(doc => questionReferenceSourceId({ kind: 'pdf', activityId: doc.activityId, documentId: doc.documentId, documentSha256: doc.sha256, readingId: doc.requestId })),
    ...references.references.filter(ref => ref.source?.kind === 'pdf').map(ref => ref.sourceId),
    ...(reading ? [questionReferenceSourceId(sourceOf(reading))] : []),
  ])].sort())
  useEffect(() => {
    const unregister = (JSON.parse(sourceIds) as string[]).map(sourceId => references.register({ sourceId,
      locate: reference => latest.current.locate(reference.source) }))
    return () => unregister.forEach(stop => stop())
  }, [sourceIds, references.register])
  const quoteAfterRead = useRef<string | null>(null)
  useEffect(() => {
    if (reading && quoteAfterRead.current === reading.readingId) {
      quoteAfterRead.current = null
      latest.current.addReference(reading)
    }
  }, [reading])

  return { documents, requests, document, reading, pendingRead, busy, loading, error, loadError, notice,
    writable: authorized && !references.readOnly, canQuote: references.draftReady && availableReading(reading),
    refresh, upload, receive, openCourse, openDocument, locate,
    readPages: (pages: number[], region: PdfRegion | null = null, quote = false) => document
      ? read({ requestId: crypto.randomUUID(), documentId: document.documentId, pages, region }, quote) : Promise.resolve(),
    retryRead: () => pendingRead ? read(pendingRead) : Promise.resolve(),
    quote: () => reading && addReference(reading),
    reveal: async () => { try { await current.current.reveal() } catch (error) { if (alive.current) setError(failureText(error)) } },
  }
}
export type PdfMaterialsController = ReturnType<typeof usePdfMaterials>

export function PdfMaterialEntries({ pdf }: { pdf: PdfMaterialsController }) {
  const input = useRef<HTMLInputElement>(null)
  const pending = pdf.requests.filter(item => !item.document)
  const personalDocuments = pdf.documents.filter(doc => !doc.courseSource)
  return <section className="pdf-material-entries" aria-label="个人 PDF 资料">
    <div className="pdf-material-heading"><h3>我的 PDF 资料</h3>
      <button type="button" className="ws-btn ghost" disabled={!pdf.writable || pdf.busy} onClick={() => input.current?.click()}>添加 PDF</button></div>
    <input ref={input} type="file" accept="application/pdf,.pdf" hidden onChange={event => {
      const file = event.target.files?.[0]; event.target.value = ''; if (file) void pdf.upload(file)
    }} />
    <p className="detail">仅用于你的学习活动 · 单份最多 20 MiB</p>
    {personalDocuments.length > 0 && <ul className="material-list">{personalDocuments.map(doc => <li key={doc.documentId}>
      <button type="button" disabled={pdf.busy || !pdf.writable} onClick={() => void pdf.openDocument(doc)}>{doc.name}</button>
      <span className="detail">{doc.state === 'ready' ? `${doc.pageCount} 页` : documentStates[doc.state]}</span>
    </li>)}</ul>}
    {pending.map(item => <div className="pdf-pending" key={item.key}>
      <span>{item.kind === 'upload' ? item.input.name : '课程 PDF'} · 尚未确认处理结果</span>
      <button type="button" className="ws-btn ghost" disabled={!pdf.writable || pdf.busy} onClick={() => void pdf.receive(item)}>核对并继续原请求</button>
    </div>)}
    {pdf.loading && <p className="detail" role="status" aria-label="正在读取 PDF 列表" />}
    {pdf.busy && <p className="detail" role="status" aria-label="正在保存或读取 PDF" />}
    {pdf.loadError && <p className="detail">{pdf.loadError}</p>}
    <button type="button" className="ws-btn ghost" disabled={pdf.busy || pdf.loading} onClick={() => void pdf.refresh()}>刷新 PDF 列表</button>
    <button type="button" className="ws-btn ghost" onClick={() => void pdf.reveal()}>打开 PDF 阅读区</button>
  </section>
}

export function PdfMaterials({ pdf, onBack }: { pdf: PdfMaterialsController; onBack(): void }) {
  const { document: doc, reading } = pdf
  const [pageInput, setPageInput] = useState('1')
  const [selectionMode, setSelectionMode] = useState<'page' | 'region'>('page')
  const [region, setRegion] = useState<PdfRegion | null>(null)
  const [query, setQuery] = useState('')
  const [localError, setLocalError] = useState('')
  useToastFeedback(localError)
  const composing = useRef(false)
  const page = reading?.requestedPages[0] ?? pdf.pendingRead?.pages[0] ?? 1
  useEffect(() => { setPageInput(String(page)); setRegion(null); setLocalError(''); setSelectionMode('page') }, [reading?.readingId, page, doc?.documentId])
  const navigate = (next: number, two = false) => {
    if (!doc || !Number.isInteger(next) || next < 1 || next > doc.pageCount || (two && next >= doc.pageCount)) {
      setLocalError(`请输入 1 到 ${doc?.pageCount ?? 1} 之间的实际页码。`); return
    }
    setLocalError(''); void pdf.readPages(two ? [next, next + 1] : [next])
  }
  return <section className="pdf-materials" aria-label="PDF 阅读区" aria-busy={pdf.busy}>
    <header className="pdf-toolbar">
      <button type="button" className="ws-btn ghost" onClick={onBack}>返回作品</button>
      <strong>{doc?.name ?? 'PDF 资料'}</strong>
      {doc && <span className="pdf-muted">{doc.pageCount} 页</span>}
    </header>
    {!doc ? <div className="pdf-empty"><h2>阅读 PDF 资料</h2><p>从「目标与材料」添加 PDF，或打开课程中的 PDF 材料。</p></div>
      : doc.state !== 'ready' ? <div className="pdf-empty"><p role="status">{documentStates[doc.state]}</p>{doc.detail && <p>{doc.detail}</p>}</div>
      : <>
        <div className="pdf-toolbar pdf-page-controls">
          <button type="button" className="ws-btn ghost" disabled={pdf.busy || !pdf.writable || page <= 1} onClick={() => navigate(page - 1)}>上一页</button>
          <form onSubmit={event => { event.preventDefault(); if (!composing.current) navigate(Number(pageInput)) }}>
            <label>第 <input aria-label="实际 PDF 页码" inputMode="numeric" value={pageInput} disabled={pdf.busy || !pdf.writable}
              onChange={event => setPageInput(event.target.value)} onCompositionStart={() => { composing.current = true }}
              onCompositionEnd={() => { composing.current = false }} onKeyDown={event => {
                if (event.key === 'Enter' && (composing.current || event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault()
              }} /> / {doc.pageCount} 页</label>
            <button type="submit" className="ws-btn ghost" disabled={pdf.busy || !pdf.writable}>跳转</button>
          </form>
          <button type="button" className="ws-btn ghost" disabled={pdf.busy || !pdf.writable || page >= doc.pageCount} onClick={() => navigate(page + 1)}>下一页</button>
          <span className="pdf-muted">页标签：{reading?.pages.map(item => item.label || '无').join('、') ?? doc.pageLabels[page - 1] ?? '无'}</span>
        </div>
        <div className="pdf-toolbar">
          <button type="button" className="ws-btn ghost" aria-pressed={selectionMode === 'page' && reading?.requestedPages.length === 1 && !reading?.region}
            disabled={pdf.busy || !pdf.writable} onClick={() => { setSelectionMode('page'); reading?.region || reading?.requestedPages.length !== 1 ? navigate(page) : setRegion(null) }}>完整页</button>
          <button type="button" className="ws-btn ghost" aria-pressed={reading?.requestedPages.length === 2}
            disabled={pdf.busy || !pdf.writable || page >= doc.pageCount} onClick={() => navigate(page, true)}>相邻两页</button>
          <button type="button" className="ws-btn ghost" aria-pressed={selectionMode === 'region'}
            disabled={pdf.busy || !pdf.writable || !reading || !!reading.region || reading.requestedPages.length !== 1 || !pdf.canQuote}
            onClick={() => { setSelectionMode('region'); setRegion(null) }}>框选区域</button>
          <button type="button" className="ws-btn" disabled={pdf.busy || !pdf.writable || !pdf.canQuote || (selectionMode === 'region' && !region)}
            onPointerDown={event => event.preventDefault()} onClick={() => {
              if (selectionMode === 'region' && region) void pdf.readPages([page], region, true)
              else pdf.quote()
            }}>{selectionMode === 'region' ? '引用所选区域' : reading?.region ? '引用此区域' : reading?.requestedPages.length === 2 ? '引用这两页' : '引用此页'}</button>
        </div>
        {selectionMode === 'region' && <p className="pdf-hint">在页图上拖动框选，再将所选区域加入问题。</p>}
        {reading?.region && <p className="pdf-hint">当前为固定选区页图。文字来自整页原生文字层；选择「完整页」可重新阅读整页。</p>}
        <div className="pdf-toolbar pdf-find">
          <label>当前页文字查找 <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="查找原生文字" /></label>
          {query && <span role="status">{!reading ? '尚未读取当前页文字' : reading.pages.some(item => item.text.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
            ? '已在下方文字中标出' : reading.pages.every(item => item.state === 'ready' && !item.text.trim())
              ? '当前页无可检索的原生文字；未执行 OCR' : '当前阅读页无匹配文字'}</span>}
        </div>
        {reading && <div className="pdf-reading" data-pdf-reading-id={reading.readingId} tabIndex={-1}>
          {reading.pages.map(item => <article className="pdf-page" data-pdf-page={item.page} tabIndex={-1} key={item.page}>
            <h3>第 {item.page} 页 <span>标签：{item.label || '无'}</span></h3>
            {item.state !== 'ready' || !item.image ? <p className="pdf-error" role="status">{item.state === 'out-of-range' ? '此页超出 PDF 实际页数。'
              : item.state === 'limit' ? '此页图超出处理尺寸或体积限制，无法显示。'
                : item.state === 'timeout' ? '此页处理超时，未生成可引用页图。' : '此页图未完整生成，无法引用。'}{item.detail ? ` ${item.detail}` : ''}</p>
              : <PdfPageImage key={reading.readingId + ':' + item.page} image={item.image} page={item.page}
                selecting={selectionMode === 'region' && !pdf.busy} region={region} onRegion={setRegion} />}
            <details className="pdf-text" open={!!query}>
              <summary>{item.state !== 'ready' ? '文字层未能完整读取' : item.text.trim() ? '原生文字层' : '无可用原生文字'} · 未执行 OCR</summary>
              {item.text ? <pre><FindText text={item.text} query={query} /></pre>
                : <p>{item.state === 'ready' ? '此页没有可用的原生文字，请查看页图；未执行 OCR。' : '此页文字读取未完成；未执行 OCR。'}</p>}
            </details>
          </article>)}
        </div>}
      </>}
    {pdf.pendingRead && !pdf.busy && <button type="button" className="ws-btn ghost" disabled={!pdf.writable} onClick={() => void pdf.retryRead()}>核对并继续本次阅读</button>}
    {pdf.busy && <p className="pdf-hint" role="status" aria-label="正在保存或读取 PDF" />}
  </section>
}

function PdfPageImage({ image, page, selecting, region, onRegion }: {
  image: NonNullable<PdfReading['pages'][number]['image']>; page: number; selecting: boolean
  region: PdfRegion | null; onRegion(region: PdfRegion | null): void
}) {
  const drag = useRef<{ x: number; y: number; pointerId: number } | null>(null)
  const [imageFailed, setImageFailed] = useState(false)
  useToastFeedback(imageFailed ? '固定页图无法在浏览器中显示，请重新定位核对原记录；不会重新渲染替换这份引用。' : '')
  const point = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) }
  }
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current
    if (!start || start.pointerId !== event.pointerId) return
    const end = point(event), x = Math.min(start.x, end.x), y = Math.min(start.y, end.y)
    const width = Math.min(1 - x, Math.abs(end.x - start.x)), height = Math.min(1 - y, Math.abs(end.y - start.y))
    onRegion(width > 0.002 && height > 0.002 ? { x, y, width, height } : null)
  }
  if (imageFailed) return <p className="pdf-muted">固定页图无法在浏览器中显示，请重新定位核对原记录；不会重新渲染替换这份引用。</p>
  return <div className={'pdf-page-image' + (selecting ? ' selecting' : '')} onPointerDown={event => {
    if (!selecting || event.button !== 0) return
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { ...point(event), pointerId: event.pointerId }; onRegion(null)
  }} onPointerMove={move} onPointerUp={event => {
    if (!drag.current) return
    move(event); drag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }} onPointerCancel={() => { drag.current = null; onRegion(null) }}>
    <img src={`data:image/png;base64,${image.dataBase64}`} alt={`PDF 第 ${page} 页固定页图`} draggable={false} width={image.width} height={image.height} onError={() => setImageFailed(true)} />
    {selecting && region && <div className="pdf-region" style={{ left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%` }} />}
  </div>
}
function FindText({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>
  const lower = text.toLocaleLowerCase(), needle = query.toLocaleLowerCase(), parts = []
  let offset = 0, index: number
  // Bound highlighted DOM nodes for unusually large native text layers.
  while (parts.length < 1000 && (index = lower.indexOf(needle, offset)) !== -1) {
    parts.push(text.slice(offset, index), <mark key={index}>{text.slice(index, index + query.length)}</mark>)
    offset = index + query.length
  }
  parts.push(text.slice(offset))
  return <>{parts}</>
}
