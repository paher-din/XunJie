import { useCallback, useEffect, useId, useLayoutEffect, useReducer, useRef, useState, type ComponentProps, type CSSProperties, type PointerEvent } from 'react'
import type { CourseMaterial } from '@xunjie/contracts/courses'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import { useToastFeedback } from '@xunjie/ui/feedback'
import { Button } from '@xunjie/ui/foundation'
import { Icon, type IconName } from '@xunjie/ui/icons'
import { WorkspaceResourceLibrary, WorkspaceResourceList, WorkspaceResourceRow } from '@xunjie/ui/workspace'
import { PDF_LIMITS, pdfDocumentSchema, pdfReadingSchema, pdfReferenceCopy, pdfReferenceSourceSchema,
  type PdfDocument, type PdfPage, type PdfReading, type PdfRegion } from '@xunjie/contracts/pdf-materials'
import { questionReferenceSourceId } from '@xunjie/contracts/question-drafts'
import { useWorkspaceReferences } from '../components/workspace/references'
import { acknowledgePdfRequest, listPdfRequests, retainCoursePdf, retainPdfUpload, type PdfMaterialRequest } from '../reliable-workspace/pdf-materials'
import { learningRequest, workspaceScope } from './learningTransport'
import { PdfReaderText, usePdfReaderText, usePdfTextFind } from './PdfReaderText'
import { PdfPagePreview } from './PdfPagePreview'
import { pdfPageSize, pdfZoomMax, pdfZoomMin, pdfZoomPercent, pdfZoomStops, type PdfSize, type PdfZoom } from './pdfZoom'
import './PdfMaterials.css'

type PdfSource = ReturnType<typeof pdfReferenceSourceSchema.parse>
export type PdfOrigin = 'course' | 'personal'
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
  activity: LearningActivity; spaceKey: string; namespace: string; authorized: boolean; reveal(origin: PdfOrigin): Promise<void>
}) {
  const references = useWorkspaceReferences()
  const scope = workspaceScope(namespace, activity)
  const [documents, setDocuments] = useState<PdfDocument[]>([])
  const [requests, setRequests] = useState<PdfMaterialRequest[]>([])
  const [document, setDocument] = useState<PdfDocument | null>(null)
  const [lastOpenedPersonalId, setLastOpenedPersonalId] = useState<string | null>(null)
  const [reading, setReading] = useState<PdfReading | null>(null)
  const [referenceReadingId, setReferenceReadingId] = useState<string | null>(null)
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
  const api = useCallback((suffix = '', body?: unknown, signal?: AbortSignal) => learningRequest(activity, spaceKey, namespace,
    `pdf/${activity.activityId}${suffix}`, body, signal), [scope, spaceKey, namespace])
  const loadOriginal = useCallback(async (expected: PdfDocument, signal: AbortSignal) => {
    if (!current.current.authorized || expected.activityId !== activity.activityId)
      throw new Error('当前无法访问 PDF 原件。')
    const value = await api(`/originals/${expected.documentId}`, undefined, signal) as { document?: unknown; dataBase64?: unknown }
    const original = pdfDocumentSchema.parse(value?.document)
    if (original.activityId !== expected.activityId || original.documentId !== expected.documentId
      || original.sha256 !== expected.sha256 || original.byteLength !== expected.byteLength
      || original.byteLength > PDF_LIMITS.inputBytes
      || typeof value.dataBase64 !== 'string' || value.dataBase64.length !== Math.ceil(expected.byteLength / 3) * 4)
      throw new Error('PDF 原件与固定页图的来源不一致。')
    const bytes = Uint8Array.from(atob(value.dataBase64), char => char.charCodeAt(0))
    if (bytes.length !== expected.byteLength)
      throw new Error('PDF 原件大小不一致。')
    return bytes
  }, [api, activity.activityId])
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
  const quotePendingRead = useRef(false)
  async function read(input: ReadRequest, quote = false, expectedDocument = document) {
    if (!canWrite() || operation.current) return
    operation.current = true; setBusy(true); setError(''); setNotice(''); setPendingRead(input)
    quotePendingRead.current = quote
    const epoch = ++readEpoch.current
    setReading(null)
    setReferenceReadingId(null)
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
      await current.current.reveal(doc.courseSource ? 'course' : 'personal')
      if (!alive.current) return
      setDocument(doc); setReading(null); setPendingRead(null); setError(''); setNotice('')
      if (!doc.courseSource) setLastOpenedPersonalId(doc.documentId)
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
      if (record.kind === 'upload' && candidate.courseSource)
        throw new Error('个人 PDF 的接收结果来源不一致，原请求仍保留。')
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
      await current.current.reveal('course')
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
      await current.current.reveal(doc.courseSource ? 'course' : 'personal')
      if (!alive.current || epoch !== readEpoch.current) return { ok: false as const, reason: '已离开原活动。' }
      adopt(doc); setDocument(doc); setReading(fixed); setReferenceReadingId(fixed.readingId)
      setPendingRead(null); setNotice('已打开引用时保留的页图。')
      if (!doc.courseSource) setLastOpenedPersonalId(doc.documentId)
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

  return { documents, requests, document, lastOpenedPersonalId, reading, referenceReadingId, pendingRead, busy, loading, error, loadError, notice,
    authorized, loadOriginal, writable: authorized && !references.readOnly, canQuote: references.draftReady && availableReading(reading),
    refresh, upload, receive, openCourse, openDocument, locate,
    readPages: (pages: number[], region: PdfRegion | null = null, quote = false) => document
      ? read({ requestId: crypto.randomUUID(), documentId: document.documentId, pages, region }, quote) : Promise.resolve(),
    retryRead: () => pendingRead ? read(pendingRead, quotePendingRead.current) : Promise.resolve(),
    quote: () => reading && addReference(reading),
    closeDocument: () => {
      if (operation.current) return
      setDocument(null); setReading(null); setPendingRead(null)
    },
  }
}
export type PdfMaterialsController = ReturnType<typeof usePdfMaterials>

function PendingPdf({ pdf, request, title }: { pdf: PdfMaterialsController; request: PdfMaterialRequest; title: string }) {
  return <div className="pdf-pending">
    <span>{title} · 尚未确认处理结果</span>
    <button type="button" className="ws-btn ghost" disabled={!pdf.writable || pdf.busy}
      onClick={() => void pdf.receive(request)}>核对并继续原请求</button>
  </div>
}

export function PendingCoursePdfs({ pdf, materials }: { pdf: PdfMaterialsController; materials: readonly CourseMaterial[] }) {
  return pdf.requests.map(request => {
    if (request.kind !== 'course' || request.document) return null
    const material = materials.find(item => item.materialId === request.input.materialId)
    return material ? <PendingPdf key={request.key} pdf={pdf} request={request} title={material.title} /> : null
  })
}

export function PersonalPdfLibrary({ pdf }: { pdf: PdfMaterialsController }) {
  const input = useRef<HTMLInputElement>(null)
  const pending = pdf.requests.filter(item => item.kind === 'upload').filter(item => !item.document)
  const personalDocuments = pdf.documents.filter(doc => !doc.courseSource)
  return <WorkspaceResourceLibrary title="个人 PDF" description="随当前活动保存，单份最多 20 MiB。" busy={pdf.busy} actions={<>
    <Button type="button" variant="outline" className="workspace-resource-icon-action" aria-label="刷新 PDF 列表" title="刷新 PDF 列表"
      disabled={pdf.busy || pdf.loading} onClick={() => void pdf.refresh()}><Icon name="refresh" /></Button>
    <Button type="button" variant="outline" disabled={!pdf.writable || pdf.busy} onClick={() => input.current?.click()}>添加 PDF</Button>
  </>}>
    <input ref={input} type="file" accept="application/pdf,.pdf" hidden onChange={event => {
      const file = event.target.files?.[0]; event.target.value = ''; if (file) void pdf.upload(file)
    }} />
    {personalDocuments.length > 0 ? <WorkspaceResourceList label="PDF 列表">{personalDocuments.map(doc =>
      <WorkspaceResourceRow key={doc.documentId} name={doc.name}
        detail={doc.state === 'ready' ? `${doc.pageCount} 页` : documentStates[doc.state]}
        current={doc.documentId === pdf.lastOpenedPersonalId}
        disabled={pdf.busy || !pdf.writable} onOpen={() => void pdf.openDocument(doc)} />
    )}</WorkspaceResourceList> : !pdf.loading && !pdf.busy && !pdf.loadError && !pending.length
      && <p className="detail">还没有添加 PDF。添加后可在这里翻页、框选和引用。</p>}
    {pending.map(item => <PendingPdf key={item.key} pdf={pdf} request={item} title={item.input.name} />)}
    {pdf.loading && <p className="detail" role="status">正在读取 PDF 列表…</p>}
    {pdf.busy && <p className="detail" role="status">正在保存或读取 PDF…</p>}
    {pdf.loadError && <p className="detail">{pdf.loadError}</p>}
  </WorkspaceResourceLibrary>
}

function pdfZoomPosition(percent: number): CSSProperties {
  return { '--pdf-zoom-position': `${100 * (percent - pdfZoomMin) / (pdfZoomMax - pdfZoomMin)}%` } as CSSProperties
}

function PdfZoomControls({ zoom, percent, viewport, pages, disabled, onChange }: {
  zoom: PdfZoom; percent: number; viewport: PdfSize; pages: readonly (PdfSize | undefined)[]
  disabled: boolean; onChange(zoom: PdfZoom): void
}) {
  return <div className="pdf-zoom" role="group" aria-label="PDF 缩放">
    <Button type="button" variant="outline" className="pdf-zoom-reset" disabled={disabled}
      aria-pressed={zoom === 'reading'} onClick={() => onChange('reading')}>默认</Button>
    <div className="pdf-zoom-slider">
      <div className="pdf-zoom-scale">
        <input type="range" min={pdfZoomMin} max={pdfZoomMax} step={1} value={percent} disabled={disabled}
          style={pdfZoomPosition(percent)} aria-label="PDF 缩放比例" aria-valuetext={`${percent}%`}
          onChange={event => onChange(event.currentTarget.valueAsNumber)} />
        <div className="pdf-zoom-stops">
          {pdfZoomStops.map(({ value, label, edge }) => <button key={value} type="button" className="pdf-zoom-stop"
            data-edge={edge} aria-pressed={zoom === value} disabled={disabled}
            style={pdfZoomPosition(pdfZoomPercent(value, viewport, pages))} onClick={() => onChange(value)}>{label}</button>)}
        </div>
      </div>
    </div>
    <output aria-hidden="true">{disabled ? '—' : `${percent}%`}</output>
  </div>
}

function keepPdfZoomPosition(area: HTMLDivElement) {
  const bounds = area.getBoundingClientRect()
  const offset = Math.min(48, area.clientHeight / 4)
  const left = bounds.left + area.clientWidth / 2
  const top = bounds.top + offset
  const frame = Array.from(area.querySelectorAll('.pdf-page-image'))
    .find(item => item.getBoundingClientRect().bottom > top)
  if (!frame) return
  const before = frame.getBoundingClientRect()
  const x = (left - before.left) / before.width
  const y = (top - before.top) / before.height
  const wasScrolled = area.scrollTop > 0
  return () => {
    const after = frame.getBoundingClientRect()
    area.scrollBy({ left: after.left + x * after.width - left,
      top: wasScrolled ? after.top + y * after.height - top : 0 })
  }
}

function PdfIconButton({ icon, label, ...props }: Omit<ComponentProps<typeof Button>, 'children' | 'variant'> & {
  icon: IconName; label: string
}) {
  return <Button {...props} type={props.type ?? 'button'} variant="outline" className="pdf-icon-button" aria-label={label} title={label}>
    <Icon name={icon} size={16} variant="linear" />
  </Button>
}

export function PdfMaterials({ pdf, onBackToList }: {
  pdf: PdfMaterialsController; onBackToList(): void
}) {
  const { document: doc, reading } = pdf
  const [pageInput, setPageInput] = useState('1')
  const [zoom, setZoom] = useState<PdfZoom>('reading')
  const [viewportSize, setViewportSize] = useState<PdfSize>({ width: 0, height: 0 })
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const sidebarId = useId()
  const sidebarToggle = useRef<HTMLButtonElement>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const restoreZoomPosition = useRef<(() => void) | undefined>(undefined)
  const [selectionMode, setSelectionMode] = useState<'page' | 'region'>('page')
  const [region, setRegion] = useState<PdfRegion | null>(null)
  const [query, setQuery] = useState('')
  const [localError, setLocalError] = useState('')
  const [textLayout, textChanged] = useReducer(value => value + 1, 0)
  const openText = usePdfReaderText(doc?.state === 'ready' && pdf.authorized ? doc : null, pdf.loadOriginal)
  const find = usePdfTextFind(viewport, reading?.readingId, selectionMode === 'region' ? '' : query, textLayout, !!reading?.region)
  useToastFeedback(localError)
  const composing = useRef(false)
  const page = reading?.requestedPages[0] ?? pdf.pendingRead?.pages[0] ?? 1
  const pageSizes = reading?.pages.map(pdfPageSize) ?? []
  const percent = pdfZoomPercent(zoom, viewportSize, pageSizes)
  const hasPageImage = pageSizes.some(Boolean)
  const ready = doc?.state === 'ready'
  const selecting = selectionMode === 'region'
  const twoPages = reading?.requestedPages.length === 2
  const canNavigate = !pdf.busy && pdf.writable
  const hasNativeText = reading?.pages.some(item => item.state === 'ready' && item.image && item.text.trim())
  const quoteLabel = selecting ? '引用所选区域' : reading?.region ? '引用此区域' : twoPages ? '引用这两页' : '引用此页'
  const cancelRegion = () => { setSelectionMode('page'); setRegion(null) }
  useEffect(() => { setPageInput(String(page)); cancelRegion(); setLocalError('') }, [reading?.readingId, page, doc?.documentId])
  useEffect(() => { setQuery('') }, [doc?.documentId])
  useLayoutEffect(() => {
    const area = viewport.current
    if (!ready || !area) return
    const measure = () => {
      const style = getComputedStyle(area)
      const width = Math.max(0, area.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight))
      const height = Math.max(0, area.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom))
      setViewportSize(previous => previous.width === width && previous.height === height ? previous : { width, height })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(area)
    return () => observer.disconnect()
  }, [ready])
  useLayoutEffect(() => {
    restoreZoomPosition.current?.()
    restoreZoomPosition.current = undefined
  }, [zoom, percent])
  const changeZoom = (next: PdfZoom) => {
    if (next === zoom) return
    if (viewport.current) restoreZoomPosition.current = keepPdfZoomPosition(viewport.current)
    setZoom(next)
  }
  const navigate = (next: number, two = false) => {
    if (!doc || !Number.isInteger(next) || next < 1 || next > doc.pageCount || (two && next >= doc.pageCount)) {
      setLocalError(`请输入 1 到 ${doc?.pageCount ?? 1} 之间的实际页码。`); return
    }
    setLocalError('')
    viewport.current?.scrollTo(0, 0)
    void pdf.readPages(two ? [next, next + 1] : [next])
  }
  const startRegion = () => {
    const selection = window.getSelection()
    if (selection?.anchorNode && viewport.current?.contains(selection.anchorNode)) selection.removeAllRanges()
    setSelectionMode('region')
    setRegion(null)
  }
  if (!doc) return null
  return <section className="pdf-reader" aria-label="PDF 阅读区" aria-busy={pdf.busy} onKeyDown={event => {
    if (event.key !== 'Escape' || event.defaultPrevented) return
    if (selecting) { event.preventDefault(); cancelRegion() }
    else if (sidebarOpen && !(event.target instanceof HTMLInputElement && event.target.type === 'search' && query)) {
      event.preventDefault(); setSidebarOpen(false); sidebarToggle.current?.focus()
    }
  }}>
    <header className="pdf-toolbar">
      <div className="pdf-toolbar-document">
        {ready && <Button ref={sidebarToggle} type="button" variant="outline" className="pdf-icon-button"
          aria-label="PDF 工具侧栏" title={sidebarOpen ? '收起 PDF 工具' : '展开 PDF 工具'}
          aria-expanded={sidebarOpen} aria-controls={sidebarId} onClick={() => {
            if (sidebarOpen) cancelRegion()
            setSidebarOpen(!sidebarOpen)
          }}><Icon name="panel-left-close" size={17} /></Button>}
        <PdfIconButton icon="folder-with-files" label={doc.courseSource ? '返回材料列表' : '返回 PDF 列表'}
          disabled={pdf.busy} onClick={onBackToList} />
        <h2 title={doc.name}>{doc.name}</h2>
      </div>
      {ready && <div className="pdf-toolbar-controls">
        <div className="pdf-page-controls" role="group" aria-label="PDF 翻页">
          <PdfIconButton icon="alt-arrow-left" label="上一页" disabled={!canNavigate || page <= 1} onClick={() => navigate(page - 1)} />
          <form onSubmit={event => { event.preventDefault(); if (!composing.current) navigate(Number(pageInput)) }}>
            <input aria-label="实际 PDF 页码" inputMode="numeric" autoComplete="off" title="输入页码，按 Enter 跳转"
              value={pageInput} disabled={!canNavigate} onChange={event => setPageInput(event.target.value)}
              onFocus={event => event.currentTarget.select()} onCompositionStart={() => { composing.current = true }}
              onCompositionEnd={() => { composing.current = false }} onKeyDown={event => {
                if (event.key === 'Enter' && (composing.current || event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault()
              }} />
            <span className="pdf-page-count" aria-label={`共 ${doc.pageCount} 页`}>/ {doc.pageCount}</span>
          </form>
          <PdfIconButton icon="alt-arrow-right" label="下一页" disabled={!canNavigate || page >= doc.pageCount} onClick={() => navigate(page + 1)} />
        </div>
        <PdfZoomControls zoom={zoom} percent={percent} viewport={viewportSize} pages={pageSizes}
          disabled={!hasPageImage} onChange={changeZoom} />
      </div>}
    </header>
    {!ready ? <div className="pdf-empty"><p role="status">{documentStates[doc.state]}</p>{doc.detail && <p>{doc.detail}</p>}</div>
      : <div className="pdf-reader-body">
        <aside className="pdf-reader-sidebar" id={sidebarId} aria-label="PDF 工具" hidden={!sidebarOpen}>
          <div role="group" aria-label="阅读方式" className="pdf-reader-modes">
            <Button type="button" variant="outline" aria-pressed={!selecting && !twoPages && !reading?.region}
              disabled={!canNavigate} onClick={() => { cancelRegion(); if (reading?.region || twoPages) navigate(page) }}>
              <Icon name="file-text" variant="linear" />完整页
            </Button>
            <Button type="button" variant="outline" aria-pressed={twoPages}
              disabled={!canNavigate || page >= doc.pageCount} onClick={() => navigate(page, true)}>
              <Icon name="book-2" variant="linear" />相邻两页
            </Button>
            <Button type="button" variant="outline" aria-pressed={selecting}
              disabled={!canNavigate || !reading || !!reading.region || twoPages || !pdf.canQuote}
              onClick={selecting ? cancelRegion : startRegion}>
              <Icon name="pen-new-square" variant="linear" />框选区域
            </Button>
          </div>
          <div role="group" aria-label="引用与附件" className="pdf-reader-actions">
            <Button type="button" variant="outline" disabled={!canNavigate || !pdf.canQuote || (selecting && !region)}
              onPointerDown={event => event.preventDefault()} onClick={() => {
                if (selecting && region) void pdf.readPages([page], region, true)
                else pdf.quote()
              }}><Icon name="link" />{quoteLabel}</Button>
            {selecting && <p className="pdf-hint">在页图上拖动框选，再引用所选区域。</p>}
            {reading?.region && <p className="pdf-hint">当前显示已引用的区域。点「完整页」可阅读整页。</p>}
          </div>
          <form className="pdf-find" role="search" onSubmit={event => { event.preventDefault(); find.revealMatch() }}>
            <div className="pdf-find-input">
              <Icon name="minimalistic-magnifier" size={15} />
              <input type="search" aria-label="当前页文字查找" value={query} onChange={event => setQuery(event.target.value)}
                disabled={selecting} placeholder="查找页内文字" maxLength={200} />
            </div>
            {query.trim() && !selecting && <p className="pdf-hint" role="status">
              {!reading || find.loading ? '正在读取页内文字…' : find.count ? `匹配 ${find.count} 处，按 Enter 跳转`
                : find.unavailable || (hasNativeText && !openText) ? '原生文字暂不可用' : hasNativeText ? '当前阅读页无匹配文字'
                  : reading.pages.every(item => item.state === 'ready') ? '当前阅读页无原生文字' : '当前阅读页文字未能完整读取'}
            </p>}
          </form>
        </aside>
        <div className="pdf-reading" data-pdf-reading-id={reading?.readingId} ref={viewport} tabIndex={0} aria-label="PDF 页图">
          {reading?.pages.map((item, index) => <article className="pdf-page" data-pdf-page={item.page} tabIndex={-1} key={item.page}
            style={pageSizes[index] ? { width: pageSizes[index].width * percent / 100 } : undefined}>
            <h3>第 {item.page} 页{item.label && item.label !== String(item.page) && <span title={item.label}>页标签 {item.label}</span>}</h3>
            {item.state !== 'ready' || !item.image ? <p className="pdf-error" role="status">{item.state === 'out-of-range' ? '此页超出 PDF 实际页数。'
              : item.state === 'limit' ? '此页图超出处理尺寸或体积限制，无法显示。'
                : item.state === 'timeout' ? '此页处理超时，未生成可引用页图。' : '此页图未完整生成，无法引用。'}{item.detail ? ` ${item.detail}` : ''}</p>
              : <PdfPageImage key={reading.readingId + ':' + item.page} item={item} image={item.image}
                openText={reading.documentSha256 === doc.sha256 ? openText : undefined}
                sharpen={!reading.region && reading.readingId !== pdf.referenceReadingId} onTextLayout={textChanged}
                selecting={selecting && !pdf.busy} region={region} onRegion={setRegion} />}
          </article>)}
          {pdf.pendingRead && !pdf.busy && <Button type="button" variant="outline" disabled={!pdf.writable}
            onClick={() => void pdf.retryRead()}>核对并继续本次阅读</Button>}
          {reading?.pages.some(item => item.state === 'failed' || item.state === 'timeout') && <Button type="button" variant="outline"
            disabled={!canNavigate} onClick={() => void pdf.readPages(reading.requestedPages, reading.region)}>重新读取页图</Button>}
          {pdf.busy && <p className="pdf-hint" role="status">正在读取 PDF…</p>}
        </div>
      </div>}
  </section>
}

function PdfPageImage({ image, item, openText, sharpen, onTextLayout, selecting, region, onRegion }: {
  image: NonNullable<PdfPage['image']>; item: PdfPage; openText: ReturnType<typeof usePdfReaderText>
  sharpen: boolean
  onTextLayout(): void; selecting: boolean; region: PdfRegion | null; onRegion(region: PdfRegion | null): void
}) {
  const frame = useRef<HTMLDivElement>(null)
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
  if (imageFailed) return <p className="pdf-muted">固定页图无法在浏览器中显示，请重新定位核对原记录。</p>
  return <div className={'pdf-page-image' + (selecting ? ' selecting' : '')} ref={frame} onPointerDown={event => {
    if (!selecting || event.button !== 0 || drag.current) return
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { ...point(event), pointerId: event.pointerId }; onRegion(null)
  }} onPointerMove={move} onPointerUp={event => {
    if (drag.current?.pointerId !== event.pointerId) return
    move(event); drag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }} onLostPointerCapture={event => {
    if (drag.current?.pointerId === event.pointerId) { drag.current = null; onRegion(null) }
  }}>
    <img src={`data:image/png;base64,${image.dataBase64}`} alt={`PDF 第 ${item.page} 页固定页图`} draggable={false}
      width={image.width} height={image.height} onError={() => setImageFailed(true)} />
    {sharpen && openText && <PdfPagePreview open={openText} page={item} image={image} frame={frame} />}
    {openText && item.text.trim() && <PdfReaderText open={openText} page={item} width={image.width} frame={frame} onLayout={onTextLayout} />}
    {selecting && region && <div className="pdf-region" style={{ left: `${region.x * 100}%`, top: `${region.y * 100}%`,
      width: `${region.width * 100}%`, height: `${region.height * 100}%` }} />}
  </div>
}
