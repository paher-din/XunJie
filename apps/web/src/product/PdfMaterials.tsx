import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState, type ComponentProps, type CSSProperties, type PointerEvent } from 'react'
import type { CourseMaterial } from '@xunjie/contracts/courses'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import { useToastFeedback } from '@xunjie/ui/feedback'
import { Button } from '@xunjie/ui/foundation'
import { Icon, type IconName } from '@xunjie/ui/icons'
import { WorkspaceResourceLibrary, WorkspaceResourceList, WorkspaceResourceMenu, WorkspaceResourceRow } from '@xunjie/ui/workspace'
import { PDF_LIMITS, pdfDocumentSchema, pdfReadingSchema, pdfReferenceCopy, pdfReferenceSourceSchema,
  type PdfDocument, type PdfPage, type PdfReading, type PdfRegion } from '@xunjie/contracts/pdf-materials'
import { questionReferenceSourceId } from '@xunjie/contracts/question-drafts'
import { useWorkspaceReferences } from '../components/workspace/references'
import { acknowledgePdfRequest, listPdfRequests, retainCoursePdf, retainPdfUpload, type PdfMaterialRequest } from '../reliable-workspace/pdf-materials'
import { learningRequest, workspaceScope } from './learningTransport'
import { PdfContinuousPage, usePdfPageSizes } from './PdfContinuousPage'
import { PdfReaderText, PdfSelectionCopy, usePdfReaderText, usePdfTextFind } from './PdfReaderText'
import { PdfPagePreview } from './PdfPagePreview'
import { PdfThumbnails } from './PdfThumbnails'
import { buildPdfTwoPageRows, findActivePdfPage, findPdfTwoPageRowIndex } from './pdfScroll'
import { pdfCanSpread, pdfPageSize, pdfSpreadGap, pdfZoomLimits, pdfZoomStops, type PdfSize, type PdfZoom } from './pdfZoom'
import './PdfMaterials.css'

type PdfSource = ReturnType<typeof pdfReferenceSourceSchema.parse>
export type PdfOrigin = 'course' | 'personal'
type ReadRequest = { requestId: string; documentId: string; pages: number[]; region: PdfRegion | null }
type PagePreload = { key: string; controller: AbortController; result: Promise<PdfReading | null> }
const cachedPageReads = 12
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
const pageReadKey = (doc: PdfDocument, pages: number[]) => JSON.stringify([doc.documentId, doc.sha256, pages])
const samePages = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((value, index) => value === b[index])
function rememberPageRead(cache: Map<string, PdfReading>, key: string, reading: PdfReading) {
  cache.delete(key)
  cache.set(key, reading)
  if (cache.size > cachedPageReads) cache.delete(cache.keys().next().value!)
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
  const pageReads = useRef(new Map<string, PdfReading>())
  const preloading = useRef<PagePreload | null>(null)
  const syncing = useRef<{ key: string; controller: AbortController } | null>(null)
  useToastFeedback(error)
  useToastFeedback(notice, 'success')
  const alive = useRef(false), operation = useRef(false), readEpoch = useRef(0), listEpoch = useRef(0)
  const current = useRef({ authorized, readOnly: !!references.readOnly, reveal })
  current.current = { authorized, readOnly: !!references.readOnly, reveal }
  const currentDoc = useRef(document)
  currentDoc.current = document
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
  const canWrite = useCallback(() => alive.current && current.current.authorized && !current.current.readOnly, [])
  const fetchReading = useCallback(async (input: ReadRequest, expectedDocument: PdfDocument | null, preview: boolean, signal?: AbortSignal) => {
    const fixed = pdfReadingSchema.parse(await api('/read', preview ? { ...input, preview: true } : input, signal))
    if (fixed.activityId !== activity.activityId || fixed.documentId !== input.documentId || fixed.readingId !== input.requestId
      || (expectedDocument && fixed.documentSha256 !== expectedDocument.sha256)
      || JSON.stringify(fixed.requestedPages) !== JSON.stringify(input.pages)
      || JSON.stringify(fixed.region) !== JSON.stringify(input.region)) throw new Error('PDF 阅读响应与所选页或区域不一致。')
    return fixed
  }, [api, activity.activityId])
  const preloadPage = useCallback((doc: PdfDocument, page: number) => {
    if (!canWrite() || operation.current || preloading.current || doc.removedAt || page > doc.pageCount) return
    const pages = [page]
    const key = pageReadKey(doc, pages)
    if (pageReads.current.has(key)) return
    const controller = new AbortController()
    const input = { requestId: crypto.randomUUID(), documentId: doc.documentId, pages, region: null }
    const result = fetchReading(input, doc, true, controller.signal).then(fixed => availableReading(fixed) ? fixed : null, () => null)
    const pending = { key, controller, result }
    preloading.current = pending
    void result.then(fixed => {
      if (preloading.current !== pending) return
      preloading.current = null
      if (fixed && canWrite()) rememberPageRead(pageReads.current, key, fixed)
    })
    return () => {
      if (preloading.current !== pending) return
      preloading.current = null
      controller.abort()
    }
  }, [canWrite, fetchReading])
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
    return () => {
      alive.current = false; ++readEpoch.current; ++listEpoch.current
      syncing.current?.controller.abort(); syncing.current = null
      pageReads.current.clear()
    }
  }, [refresh])
  const previousAuthorized = useRef(authorized)
  useEffect(() => {
    if (!authorized) {
      syncing.current?.controller.abort(); syncing.current = null
      pageReads.current.clear()
    }
    if (authorized && !previousAuthorized.current) void refresh()
    previousAuthorized.current = authorized
  }, [authorized, refresh])

  const syncPages = useCallback(async (pages: number[]) => {
    const expectedDocument = currentDoc.current
    if (!expectedDocument || !canWrite() || operation.current || expectedDocument.state !== 'ready' || expectedDocument.removedAt
      || pages.length < 1 || pages.length > 2
      || pages.some(targetPage => !Number.isInteger(targetPage) || targetPage < 1 || targetPage > expectedDocument.pageCount)) return
    const cache = pageReads.current
    const cacheKey = pageReadKey(expectedDocument, pages)
    const cached = cache.get(cacheKey)
    if (cached) {
      rememberPageRead(cache, cacheKey, cached)
      setReading(cached); setReferenceReadingId(null); setPendingRead(null); setError(''); setNotice('')
      return
    }
    if (syncing.current?.key === cacheKey) return
    syncing.current?.controller.abort()
    const background = preloading.current
    const prefetched = background?.key === cacheKey ? background : null
    if (prefetched) preloading.current = null
    const controller = new AbortController()
    const activeSync = { key: cacheKey, controller }
    syncing.current = activeSync
    const epoch = readEpoch.current
    try {
      const input = { requestId: crypto.randomUUID(), documentId: expectedDocument.documentId, pages, region: null }
      const fixed = (prefetched ? await prefetched.result : null)
        ?? await fetchReading(input, expectedDocument, true, controller.signal)
      if (!canWrite() || syncing.current !== activeSync || epoch !== readEpoch.current || operation.current) return
      if (currentDoc.current?.documentId !== expectedDocument.documentId || currentDoc.current?.sha256 !== expectedDocument.sha256) return
      if (availableReading(fixed)) rememberPageRead(cache, cacheKey, fixed)
      setReading(fixed); setReferenceReadingId(null); setPendingRead(null)
    } catch {
      // Background scroll sync failures do not interrupt reading or disable toolbar actions.
    } finally {
      if (syncing.current === activeSync) syncing.current = null
    }
  }, [canWrite, fetchReading])

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
  const addPageImages = (fixed: PdfReading) => {
    if (!canWrite() || !references.draftReady || !availableReading(fixed)) return
    return references.addImages?.(fixed.pages.flatMap(item => item.image ? [{
      name: `${fixed.documentName.slice(0, 200)} · 第 ${item.page} 页${fixed.region ? '选区' : ''}`,
      dataBase64: item.image.dataBase64,
    }] : []))
  }
  const quotePendingRead = useRef(false)
  async function read(input: ReadRequest, quote = false, expectedDocument = document, retry = false) {
    if (!canWrite() || operation.current) return
    syncing.current?.controller.abort(); syncing.current = null
    const cache = pageReads.current
    const cacheKey = expectedDocument && !input.region && !quote ? pageReadKey(expectedDocument, input.pages) : null
    const cached = !retry && cacheKey ? cache.get(cacheKey) : undefined
    if (cached && cacheKey) {
      rememberPageRead(cache, cacheKey, cached)
      setReading(cached); setReferenceReadingId(null); setPendingRead(null); setError(''); setNotice('')
      return
    }
    const background = preloading.current
    const prefetched = !retry && background?.key === cacheKey ? background : null
    // The foreground owns an adopted request, so reader cleanup cannot cancel it.
    preloading.current = null
    if (background !== prefetched) background?.controller.abort()
    operation.current = true; setBusy(true); setError(''); setNotice(''); setPendingRead(input)
    quotePendingRead.current = quote
    const epoch = ++readEpoch.current
    // Keep the last verified page and its identity visible until this read completes.
    setReading(previous => previous?.documentId === input.documentId && previous.documentSha256 === expectedDocument?.sha256 ? previous : null)
    try {
      let fixed = prefetched ? await prefetched.result : null
      if (!canWrite() || epoch !== readEpoch.current) return
      fixed ??= await fetchReading(input, expectedDocument, !quote && !input.region)
      if (!canWrite() || epoch !== readEpoch.current) return
      if (cacheKey && availableReading(fixed)) rememberPageRead(cache, cacheKey, fixed)
      setReading(fixed); setReferenceReadingId(null); setPendingRead(null)
      if (quote && availableReading(fixed)) {
        // Registering the source is an effect; queue the explicit add until it is registered.
        quoteAfterRead.current = fixed.readingId
      }
    } catch (error) { if (alive.current && epoch === readEpoch.current) setError(failureText(error)) }
    finally { operation.current = false; if (alive.current && epoch === readEpoch.current) setBusy(false) }
  }
  async function attachTargetPageImages(pages: number[]) {
    if (!canWrite() || !references.draftReady || !document || operation.current || !pages.length) return
    syncing.current?.controller.abort(); syncing.current = null
    const cacheKey = pageReadKey(document, pages)
    const cached = pageReads.current.get(cacheKey)
    if (cached && availableReading(cached)) {
      rememberPageRead(pageReads.current, cacheKey, cached)
      setReading(cached); setReferenceReadingId(null); setPendingRead(null); setError(''); setNotice('')
      return addPageImages(cached)
    }
    operation.current = true; setBusy(true); setError(''); setNotice('')
    const epoch = ++readEpoch.current
    const expectedDocument = document
    try {
      const input = { requestId: crypto.randomUUID(), documentId: expectedDocument.documentId, pages, region: null }
      const fixed = await fetchReading(input, expectedDocument, true)
      if (!canWrite() || epoch !== readEpoch.current) return
      if (availableReading(fixed)) {
        rememberPageRead(pageReads.current, cacheKey, fixed)
        setReading(fixed); setReferenceReadingId(null); setPendingRead(null)
        return addPageImages(fixed)
      }
    } catch (error) {
      if (alive.current && epoch === readEpoch.current) setError(failureText(error))
    } finally {
      operation.current = false
      if (alive.current && epoch === readEpoch.current) setBusy(false)
    }
  }
  async function openDocument(doc: PdfDocument) {
    if (!alive.current || operation.current) return
    syncing.current?.controller.abort(); syncing.current = null
    operation.current = true; setBusy(true)
    try {
      await current.current.reveal(doc.courseSource ? 'course' : 'personal')
      if (!alive.current) return
      setDocument(doc); setReading(null); setReferenceReadingId(null); setPendingRead(null); setError(''); setNotice('')
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
      const prior = value === undefined ? undefined : pdfDocumentSchema.parse(value)
      if (!prior || (prior.state === 'received' && !prior.removedAt)) {
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
      if (!doc.removedAt) await openDocument(doc)
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
  async function remove(doc: PdfDocument) {
    if (!canWrite() || operation.current || doc.courseSource || doc.removedAt) return
    ++listEpoch.current; setLoading(false)
    operation.current = true; setBusy(true); setError(''); setNotice('')
    try {
      const removed = pdfDocumentSchema.parse(await api(`/documents/${doc.documentId}/remove`, { requestId: crypto.randomUUID() }))
      if (removed.activityId !== activity.activityId || removed.documentId !== doc.documentId
        || removed.sha256 !== doc.sha256 || removed.courseSource || !removed.removedAt)
        throw new Error('PDF 移除回执与当前文件不一致，请刷新列表核对。')
      const record = requests.find(item => item.input.documentId === doc.documentId)
      if (record) {
        // The owner already confirmed removal. Update the browser's fallback copy when available.
        try { await acknowledgePdfRequest(record, removed) } catch { /* The owner's list remains authoritative. */ }
      }
      if (!alive.current) return
      adopt(removed)
      setRequests(items => items.map(item => item.input.documentId === doc.documentId ? { ...item, document: removed } : item))
      setLastOpenedPersonalId(previous => previous === doc.documentId ? null : previous)
      setNotice(`已移除「${doc.name}」。已有引用仍可打开。`)
    } catch (error) {
      if (alive.current) setError(error instanceof Error && !(error.name === 'ZodError' || 'code' in error)
        ? error.message : '尚未确认 PDF 是否已移除，请刷新列表核对。')
    } finally { operation.current = false; if (alive.current) setBusy(false) }
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
    syncing.current?.controller.abort(); syncing.current = null
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
    authorized, loadOriginal, writable: authorized && !references.readOnly, draftReady: references.draftReady,
    canQuote: references.draftReady && availableReading(reading),
    imageAttachments: !!references.addImages, addingImages: !!references.addingImages,
    refresh, upload, remove, receive, openCourse, openDocument, locate, preloadPage, syncPages,
    readPages: (pages: number[], region: PdfRegion | null = null, quote = false) => document
      ? read({ requestId: crypto.randomUUID(), documentId: document.documentId, pages, region }, quote) : Promise.resolve(),
    retryRead: () => pendingRead ? read(pendingRead, quotePendingRead.current, document, true) : Promise.resolve(),
    quote: (targetPages?: number[]) => {
      if (targetPages?.length && document && (!reading || reading.region || !samePages(reading.requestedPages, targetPages))) {
        return read({ requestId: crypto.randomUUID(), documentId: document.documentId, pages: targetPages, region: null }, true)
      }
      if (!reading || !availableReading(reading)) return
      if (reading.readingId === referenceReadingId || reading.region) return addReference(reading)
      return read({ requestId: reading.readingId, documentId: reading.documentId, pages: reading.requestedPages, region: null }, true)
    },
    attachPageImages: (targetPages?: number[]) => {
      if (targetPages?.length && (!reading || reading.region || !samePages(reading.requestedPages, targetPages))) {
        return attachTargetPageImages(targetPages)
      }
      return reading && !reading.region && addPageImages(reading)
    },
    closeDocument: () => {
      if (operation.current) return
      syncing.current?.controller.abort(); syncing.current = null
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
  const personalDocuments = pdf.documents.filter(doc => !doc.courseSource && !doc.removedAt)
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
        disabled={pdf.busy || !pdf.writable} onOpen={() => void pdf.openDocument(doc)}
        actions={pdf.writable && <WorkspaceResourceMenu name={doc.name} disabled={pdf.busy}
          items={[{ label: '移除', onSelect: () => void pdf.remove(doc) }]} />} />
    )}</WorkspaceResourceList> : !pdf.loading && !pdf.busy && !pdf.loadError && !pending.length
      && <p className="detail">还没有添加 PDF。添加后可在这里翻页、框选和引用。</p>}
    {pending.map(item => <PendingPdf key={item.key} pdf={pdf} request={item} title={item.input.name} />)}
    {pdf.loading && <p className="detail" role="status">正在读取 PDF 列表…</p>}
    {pdf.busy && <p className="detail" role="status">正在保存或读取 PDF…</p>}
    {pdf.loadError && <p className="detail">{pdf.loadError}</p>}
  </WorkspaceResourceLibrary>
}

function pdfZoomPosition(percent: number, min: number, range: number): CSSProperties {
  return { '--pdf-zoom-position': `${100 * (percent - min) / range}%` } as CSSProperties
}

const pdfZoomDotSize = 6

function PdfZoomControls({ zoom, percent, limits, cropped, disabled, onChange }: {
  zoom: PdfZoom; percent: number; limits: ReturnType<typeof pdfZoomLimits>
  cropped: boolean; disabled: boolean; onChange(zoom: PdfZoom): void
}) {
  const slider = useRef<HTMLInputElement>(null)
  const track = useRef<HTMLDivElement>(null)
  const [trackWidth, setTrackWidth] = useState(0)
  const pointer = useRef<{ id: number; x: number; dragging: boolean } | null>(null)
  useLayoutEffect(() => {
    const element = track.current
    if (!element) return
    setTrackWidth(element.getBoundingClientRect().width)
    const observer = new ResizeObserver(([entry]) => setTrackWidth(entry.contentRect.width))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const { min, max } = limits
  const stops = pdfZoomStops.map(stop => ({ ...stop, percent: limits[stop.value] }))
  const range = Math.max(1, max - min)
  const distance = Math.abs(stops[0].percent - stops[1].percent) * trackWidth / range
  const overlap = distance < pdfZoomDotSize
  const combineFits = cropped && overlap
  const visibleStops = combineFits ? [{ ...stops[zoom === 'fit-width' ? 1 : 0], label: '适合选区' }] : stops
  const moveStop = (event: PointerEvent<HTMLButtonElement>) => {
    const active = pointer.current
    if (!active || active.id !== event.pointerId || !(event.buttons & 1)) return
    if (!active.dragging) {
      if (Math.abs(event.clientX - active.x) < 3) return
      active.dragging = true
      slider.current?.focus()
    }
    const bounds = track.current?.getBoundingClientRect()
    if (!bounds?.width) return
    const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width))
    onChange(Math.round(min + ratio * range))
  }
  return <div className="pdf-zoom" role="group" aria-label="PDF 缩放">
    <Button type="button" variant="outline" className="pdf-zoom-reset" disabled={disabled}
      aria-pressed={zoom === 'reading'} onClick={() => onChange('reading')}>默认</Button>
    <div className="pdf-zoom-slider">
      <div className="pdf-zoom-scale">
        <input ref={slider} type="range" min={min} max={max} step={1} value={percent} disabled={disabled || min === max}
          style={pdfZoomPosition(percent, min, range)} aria-label="PDF 缩放比例" aria-valuetext={`${percent}%`}
          onChange={event => onChange(event.currentTarget.valueAsNumber)} />
        <div ref={track} className="pdf-zoom-stops" data-overlap={overlap && !combineFits || undefined}
          style={{ '--pdf-zoom-dot-size': `${pdfZoomDotSize}px`, '--pdf-zoom-stop-width': `${overlap ? 20 : Math.min(20, distance)}px` } as CSSProperties}>
          {visibleStops.map(({ value, label, edge, percent: position }) => <button key={combineFits ? 'fit-region' : value} type="button" className="pdf-zoom-stop"
            data-edge={edge} data-current={percent === position || undefined} aria-label={label} aria-pressed={zoom === value} disabled={disabled}
            style={pdfZoomPosition(position, min, range)}
            onPointerDown={event => {
              if (!event.isPrimary || event.button !== 0) return
              pointer.current = { id: event.pointerId, x: event.clientX, dragging: false }
              event.currentTarget.setPointerCapture(event.pointerId)
            }}
            onPointerMove={moveStop} onPointerCancel={() => { pointer.current = null }}
            onClick={event => {
              const dragged = event.detail > 0 && pointer.current?.dragging
              pointer.current = null
              if (!dragged) onChange(value)
            }}>
            <span className="pdf-zoom-stop-tip" aria-hidden="true">{label}</span>
          </button>)}
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
  const frame = Array.from(area.querySelectorAll('.pdf-page-image, .pdf-page-sheet'))
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

function PdfPanelOpenIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className="ui-icon icon-tone-neutral"
      aria-hidden="true"
      focusable="false"
    >
      <g fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth={1.5}>
        <path d="M22 11C22 7.22876 22 5.34315 20.8284 4.17157C19.6569 3 17.7712 3 14 3H10C6.22876 3 4.34315 3 3.17157 4.17157C2 5.34315 2 7.22876 2 11V13C2 16.7712 2 18.6569 3.17157 19.8284C4.34315 21 6.22876 21 10 21H14C17.7712 21 19.6569 21 20.8284 19.8284C22 18.6569 22 16.7712 22 13V11Z" />
        <path d="M9 21L9 3" />
        <path strokeLinejoin="round" d="M14.2113 9L16.7827 12L14.2113 15" />
      </g>
    </svg>
  )
}

function PdfIconButton({ icon, label, ...props }: Omit<ComponentProps<typeof Button>, 'children' | 'variant'> & {
  icon: IconName; label: string
}) {
  return <Button {...props} type={props.type ?? 'button'} variant="outline" className="pdf-icon-button" aria-label={label} title={label}>
    <Icon name={icon} size={16} variant="linear" />
  </Button>
}

export function PdfMaterials({ pdf, active, onBackToList }: {
  pdf: PdfMaterialsController; active: boolean; onBackToList(): void
}) {
  const { document: doc, reading, pendingRead, preloadPage, syncPages } = pdf
  const [currentPage, setCurrentPage] = useState(1)
  const [layoutMode, setLayoutMode] = useState<'single' | 'two-page'>('single')
  const [twoPageAnchor, setTwoPageAnchor] = useState(1)
  const [pageInput, setPageInput] = useState('1')
  const [zoom, setZoom] = useState<PdfZoom>('reading')
  const [viewportSize, setViewportSize] = useState<PdfSize>({ width: 0, height: 0 })
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [findOpen, setFindOpen] = useState(false)
  const sidebarId = useId()
  const findId = useId()
  const sidebarToggle = useRef<HTMLButtonElement>(null)
  const findToggle = useRef<HTMLButtonElement>(null)
  const findInput = useRef<HTMLInputElement>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const restoreZoomPosition = useRef<(() => void) | undefined>(undefined)
  const pageInputFocused = useRef(false)
  const ignoreScrollUntil = useRef(0)
  const pendingScrollPage = useRef<number | null>(null)
  const prevDocId = useRef<string | undefined>(undefined)
  const [selectionMode, setSelectionMode] = useState<'page' | 'region'>('page')
  const [region, setRegion] = useState<PdfRegion | null>(null)
  const [query, setQuery] = useState('')
  const [localError, setLocalError] = useState('')
  const [textLayout, textChanged] = useReducer(value => value + 1, 0)
  const openText = usePdfReaderText(doc?.state === 'ready' && pdf.authorized ? doc : null, pdf.loadOriginal)
  const pendingPages = pdf.busy ? pdf.pendingRead?.pages : undefined
  useToastFeedback(localError)
  const composing = useRef(false)
  const findComposing = useRef(false)
  const ready = doc?.state === 'ready'
  const selecting = selectionMode === 'region'
  const isFixedReference = !!reading && reading.readingId === pdf.referenceReadingId
  const twoPages = isFixedReference || !!reading?.region ? reading?.requestedPages.length === 2 : layoutMode === 'two-page'
  const continuous = !!(ready && doc && doc.pageCount > 1 && !selecting && !reading?.region && !isFixedReference && !doc.removedAt)
  const readingPage = reading?.requestedPages[0] ?? pdf.pendingRead?.pages[0] ?? 1
  const page = continuous ? currentPage : readingPage
  const twoPageRows = useMemo(
    () => (continuous && twoPages && doc ? buildPdfTwoPageRows(doc.pageCount, twoPageAnchor) : []),
    [continuous, twoPages, doc?.pageCount, twoPageAnchor],
  )
  const activeRowIndex = continuous && twoPages ? findPdfTwoPageRowIndex(twoPageRows, page) : -1
  const activePages = continuous
    ? (twoPages ? (twoPageRows[activeRowIndex] ?? [page]) : [page])
    : (reading?.requestedPages ?? [page])
  const activeTwoPages = activePages.length === 2
  const fixedSizes = useMemo(() => reading?.pages.map(pdfPageSize) ?? [], [reading?.pages])
  const fallbackPageSize = fixedSizes[0]
  const continuousSizes = usePdfPageSizes(continuous ? openText : undefined, continuous ? doc : null, fallbackPageSize)
  const layoutRows = useMemo(() => {
    if (!continuous) return [fixedSizes]
    if (!twoPages) return [[continuousSizes.get(1) ?? fallbackPageSize]]
    return twoPageRows.map(row => row.map(num => continuousSizes.get(num) ?? fallbackPageSize))
  }, [continuous, fixedSizes, twoPages, continuousSizes, twoPageRows, fallbackPageSize])
  const limits = useMemo(() => pdfZoomLimits(viewportSize, layoutRows, twoPages), [viewportSize, layoutRows, twoPages])
  const percent = typeof zoom === 'number' ? Math.min(limits.max, Math.max(limits.min, zoom)) : limits[zoom]
  const hasPageImage = layoutRows.some(row => row.some(Boolean))
  const spread = twoPages && layoutRows.some(row => pdfCanSpread(viewportSize, row))
  const canNavigate = !pdf.busy && pdf.writable
  const hasNativeText = reading?.pages.some(item => item.state === 'ready' && item.image && item.text.trim())
  const textScopeId = continuous ? doc?.documentId : reading?.readingId
  const find = usePdfTextFind(viewport, textScopeId, findOpen && !pendingPages ? query : '', textLayout, !!reading?.region)
  const currentFixedPages = continuous && doc && reading?.documentId === doc.documentId && reading.documentSha256 === doc.sha256
    ? activePages.map(num => reading.pages.find(item => item.page === num)).filter((item): item is PdfPage => !!item)
    : []
  const currentPageFailed = currentFixedPages.some(item => item.state !== 'ready' || !item.image)
  const canQuoteCurrent = continuous ? (pdf.draftReady && !doc.removedAt && !currentPageFailed) : pdf.canQuote
  const quoteLabel = selecting ? '引用所选区域' : reading?.region ? '引用此区域' : activeTwoPages ? '引用这两页' : '引用此页'
  const imageLabel = activeTwoPages ? '将两页添加为图片' : '将此页添加为图片'
  const cancelRegion = () => {
    if (selectionMode === 'region') pendingScrollPage.current = currentPage
    setSelectionMode('page')
    setRegion(null)
  }
  const scrollToPage = useCallback((target: number) => {
    const area = viewport.current
    if (!area) return
    const el = area.querySelector<HTMLElement>(`[data-pdf-page="${target}"]`)
    if (!el) return
    ignoreScrollUntil.current = performance.now() + 150
    const top = Math.max(0, el.getBoundingClientRect().top - area.getBoundingClientRect().top + area.scrollTop - 8)
    area.scrollTo({ top })
  }, [])
  useEffect(() => {
    if (!active || !canNavigate || pendingRead || doc?.state !== 'ready' || !reading || reading.region
      || reading.documentId !== doc.documentId || reading.documentSha256 !== doc.sha256
      || reading.pages.length !== 1 || reading.requestedPages[0] !== page
      || reading.pages[0]?.state !== 'ready' || !reading.pages[0].image) return
    return preloadPage(doc, page + 1)
  }, [active, canNavigate, doc, page, pendingRead, preloadPage, reading])
  useEffect(() => {
    setCurrentPage(1)
    setLayoutMode('single')
    setTwoPageAnchor(1)
    setQuery('')
    setFindOpen(false)
    findComposing.current = false
    setSelectionMode('page')
    setRegion(null)
    pendingScrollPage.current = null
  }, [doc?.documentId])
  useEffect(() => {
    if (pdf.referenceReadingId || reading?.region) {
      setSelectionMode('page')
      setRegion(null)
    }
  }, [pdf.referenceReadingId, reading?.region])
  useEffect(() => {
    if (!continuous && reading?.requestedPages[0]) setCurrentPage(reading.requestedPages[0])
  }, [continuous, reading?.readingId])
  useEffect(() => {
    if (!pageInputFocused.current) setPageInput(String(page))
    setLocalError('')
  }, [page, doc?.documentId])
  useLayoutEffect(() => { if (findOpen) findInput.current?.focus() }, [findOpen])
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
    if (restoreZoomPosition.current) {
      ignoreScrollUntil.current = performance.now() + 150
      restoreZoomPosition.current()
      restoreZoomPosition.current = undefined
    }
  }, [zoom, percent])
  useLayoutEffect(() => {
    const area = viewport.current
    const docChanged = prevDocId.current !== doc?.documentId
    prevDocId.current = doc?.documentId
    if (!area) return
    if (docChanged) {
      pendingScrollPage.current = null
      ignoreScrollUntil.current = performance.now() + 150
      area.scrollTo(0, 0)
      return
    }
    if (continuous) {
      if (pendingScrollPage.current !== null) {
        const target = pendingScrollPage.current
        pendingScrollPage.current = null
        scrollToPage(target)
      }
      return
    }
    area.scrollTo(0, 0)
  }, [doc?.documentId, reading?.readingId, continuous, layoutMode, scrollToPage])
  useEffect(() => {
    const area = viewport.current
    if (!continuous || !area) return
    let frame = 0
    const update = () => {
      frame = 0
      if (performance.now() < ignoreScrollUntil.current) return
      const areaTop = area.getBoundingClientRect().top
      const spans = Array.from(area.querySelectorAll<HTMLElement>('[data-pdf-page]')).map(el => {
        const rect = el.getBoundingClientRect()
        return {
          page: Number(el.dataset.pdfPage),
          top: rect.top - areaTop + area.scrollTop,
          bottom: rect.bottom - areaTop + area.scrollTop,
        }
      }).filter(span => Number.isInteger(span.page) && span.page >= 1)
      setCurrentPage(previous => {
        const hit = findActivePdfPage(spans, area.scrollTop, area.clientHeight, area.scrollHeight, previous)
        if (twoPages && twoPageRows.length) {
          return twoPageRows[findPdfTwoPageRowIndex(twoPageRows, hit)]?.[0] ?? hit
        }
        return hit
      })
    }
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    const userScroll = () => { ignoreScrollUntil.current = 0 }
    area.addEventListener('scroll', onScroll, { passive: true })
    area.addEventListener('wheel', userScroll, { passive: true })
    area.addEventListener('touchstart', userScroll, { passive: true })
    area.addEventListener('pointerdown', userScroll, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      area.removeEventListener('scroll', onScroll)
      area.removeEventListener('wheel', userScroll)
      area.removeEventListener('touchstart', userScroll)
      area.removeEventListener('pointerdown', userScroll)
    }
  }, [continuous, twoPages, twoPageRows])
  useEffect(() => {
    if (!active || !continuous || !canNavigate || pendingRead || !doc) return
    if (reading && !reading.region && reading.documentId === doc.documentId && reading.documentSha256 === doc.sha256
      && samePages(reading.requestedPages, activePages)) return
    const timer = window.setTimeout(() => { void syncPages(activePages) }, 220)
    return () => window.clearTimeout(timer)
  }, [active, continuous, canNavigate, pendingRead, doc, reading, activePages, syncPages])
  const changeZoom = (next: PdfZoom) => {
    if (next === zoom) return
    if (viewport.current) restoreZoomPosition.current = keepPdfZoomPosition(viewport.current)
    setZoom(next)
  }
  const navigate = (next: number, two = false) => {
    if (!doc || !Number.isInteger(next) || next < 1 || next > doc.pageCount || (two && !twoPages && next >= doc.pageCount)) {
      setLocalError(`请输入 1 到 ${doc?.pageCount ?? 1} 之间的实际页码。`); return
    }
    setLocalError('')
    cancelRegion()
    if (two) {
      if (!twoPages) {
        setLayoutMode('two-page')
        setTwoPageAnchor(next)
        pendingScrollPage.current = next
        setCurrentPage(next)
        setPageInput(String(next))
        void pdf.readPages([next, next + 1])
        return
      }
      const row = twoPageRows[findPdfTwoPageRowIndex(twoPageRows, next)] ?? (next < doc.pageCount ? [next, next + 1] : [next])
      setCurrentPage(row[0])
      setPageInput(String(row[0]))
      if (continuous) scrollToPage(row[0])
      else pendingScrollPage.current = row[0]
      void pdf.readPages(row)
      return
    }
    setLayoutMode('single')
    setCurrentPage(next)
    setPageInput(String(next))
    if (continuous && !twoPages) scrollToPage(next)
    else pendingScrollPage.current = next
    void pdf.readPages([next])
  }
  const openFind = () => {
    if (selecting) cancelRegion()
    if (findOpen) { findInput.current?.focus(); findInput.current?.select() }
    else setFindOpen(true)
  }
  const closeFind = (restoreFocus = true) => {
    setFindOpen(false)
    setQuery('')
    findComposing.current = false
    if (restoreFocus) findToggle.current?.focus()
  }
  const startRegion = () => {
    closeFind(false)
    const selection = window.getSelection()
    if (selection?.anchorNode && viewport.current?.contains(selection.anchorNode)) selection.removeAllRanges()
    setSelectionMode('region')
    setRegion(null)
    if (continuous && (!reading || reading.documentId !== doc?.documentId || reading.documentSha256 !== doc?.sha256
      || reading.region || reading.requestedPages.length !== 1 || reading.requestedPages[0] !== currentPage)) {
      void pdf.readPages([currentPage])
    }
  }
  if (!doc) return null
  const labels = activePages.map(num => doc.pageLabels[num - 1] || String(num))
  const pageLabel = labels.some((label, index) => label !== String(activePages[index])) ? labels.join('–') : undefined
  return <section className="pdf-reader" aria-label="PDF 阅读区" aria-busy={pdf.busy} onKeyDown={event => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229) return
    if (ready && !event.altKey && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault(); openFind()
    } else if (event.key === 'Escape') {
      if (findOpen) { event.preventDefault(); closeFind(); return }
      if (selecting) { event.preventDefault(); cancelRegion(); return }
      const selection = window.getSelection()
      if (selection?.anchorNode && !selection.isCollapsed && viewport.current?.contains(selection.anchorNode)) {
        event.preventDefault(); selection.removeAllRanges(); return
      }
      if (sidebarOpen) { event.preventDefault(); setSidebarOpen(false); sidebarToggle.current?.focus() }
    }
  }}>
    <header className="pdf-toolbar">
      <div className="pdf-toolbar-document">
        <div className="pdf-toolbar-nav">
          {ready && <Button ref={sidebarToggle} type="button" variant="outline" className="pdf-icon-button"
            aria-label="PDF 工具侧栏" title={sidebarOpen ? '收起 PDF 工具' : '展开 PDF 工具'}
            aria-expanded={sidebarOpen} aria-controls={sidebarId} onClick={() => {
              if (sidebarOpen) cancelRegion()
              setSidebarOpen(!sidebarOpen)
            }}>{sidebarOpen
              ? <Icon name="panel-left-close" size={16} variant="linear" tone="neutral" />
              : <PdfPanelOpenIcon size={16} />}</Button>}
        </div>
        <Button type="button" variant="outline" className="pdf-library-link" disabled={pdf.busy}
          aria-label={doc.courseSource ? '返回材料列表' : '返回 PDF 列表'} onClick={onBackToList}>资料</Button>
        <Icon name="alt-arrow-right" size={12} variant="linear" />
        <h2 title={doc.name}>{doc.name}</h2>
      </div>
      {ready && <div className="pdf-toolbar-controls">
        <div className="pdf-page-controls" role="group" aria-label="PDF 翻页">
          <PdfIconButton icon="alt-arrow-left" label="上一页"
            disabled={!canNavigate || (continuous && twoPages ? activeRowIndex <= 0 : page <= 1)}
            onClick={() => {
              if (continuous && twoPages) {
                const prevRow = twoPageRows[activeRowIndex - 1]
                if (prevRow) navigate(prevRow[0], true)
              } else navigate(page - 1)
            }} />
          <form onSubmit={event => {
            event.preventDefault()
            if (!composing.current) {
              pageInputFocused.current = false
              navigate(Number(pageInput), twoPages)
            }
          }}>
            <input aria-label="实际 PDF 页码" inputMode="numeric" autoComplete="off" title="输入页码，按 Enter 跳转"
              value={pageInput} disabled={!canNavigate} onChange={event => setPageInput(event.target.value)}
              onFocus={event => { pageInputFocused.current = true; event.currentTarget.select() }}
              onBlur={() => { pageInputFocused.current = false; setPageInput(String(page)) }}
              onCompositionStart={() => { composing.current = true }}
              onCompositionEnd={() => { composing.current = false }} onKeyDown={event => {
                if (event.key === 'Enter' && (composing.current || event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault()
              }} />
            <span className="pdf-page-count">{activeTwoPages && <span aria-label={`至第 ${activePages[1]} 页`}>– {activePages[1]} </span>}/ {doc.pageCount}</span>
            {pageLabel && <span className="pdf-page-label" title={pageLabel}>页标签 {pageLabel}</span>}
          </form>
          <PdfIconButton icon="alt-arrow-right" label="下一页"
            disabled={!canNavigate || (continuous && twoPages ? activeRowIndex >= twoPageRows.length - 1 : page >= doc.pageCount)}
            onClick={() => {
              if (continuous && twoPages) {
                const nextRow = twoPageRows[activeRowIndex + 1]
                if (nextRow) navigate(nextRow[0], true)
              } else navigate(page + 1)
            }} />
        </div>
        <PdfZoomControls zoom={zoom} percent={percent} limits={limits} cropped={!!reading?.region}
          disabled={!hasPageImage} onChange={changeZoom} />
        <PdfIconButton ref={findToggle} icon="minimalistic-magnifier" label="查找文字"
          aria-keyshortcuts="Control+F Meta+F" aria-expanded={findOpen} aria-controls={findId}
          onClick={() => { if (findOpen) closeFind(); else openFind() }} />
      </div>}
    </header>
    {!ready ? <div className="pdf-empty"><p role="status">{documentStates[doc.state]}</p>{doc.detail && <p>{doc.detail}</p>}</div>
      : <div className="pdf-reader-body">
        <aside className="pdf-reader-sidebar" id={sidebarId} aria-label="PDF 工具" hidden={!sidebarOpen}>
          <div role="group" aria-label="阅读方式" className="pdf-reader-modes">
            <Button type="button" variant="outline" aria-pressed={!selecting && !twoPages && !reading?.region}
              disabled={!canNavigate} onClick={() => { cancelRegion(); if (reading?.region || twoPages || isFixedReference) navigate(page) }}>
              <Icon name="file-text" variant="linear" tone="neutral" />完整页
            </Button>
            <Button type="button" variant="outline" aria-pressed={twoPages}
              disabled={!canNavigate || (!twoPages && page >= doc.pageCount)} onClick={() => navigate(page, true)}>
              <Icon name="book-2" variant="linear" tone="neutral" />相邻两页
            </Button>
          </div>
          <div role="group" aria-label="引用与附件" className="pdf-reader-actions">
            <Button type="button" variant="outline" aria-pressed={selecting}
              disabled={!canNavigate || !doc || !!reading?.region || twoPages || !canQuoteCurrent}
              onClick={selecting ? cancelRegion : startRegion}>
              <Icon name="pen-new-square" variant="linear" tone="neutral" />框选区域
            </Button>
            <Button type="button" variant="outline" disabled={!canNavigate || !canQuoteCurrent || (selecting && !region)}
              onPointerDown={event => event.preventDefault()} onClick={() => {
                if (selecting && region) void pdf.readPages([page], region, true)
                else void pdf.quote(continuous ? activePages : undefined)
              }}><Icon name="link" variant="linear" tone="neutral" />{quoteLabel}</Button>
            {pdf.imageAttachments && !selecting && !reading?.region && <Button type="button" variant="outline"
              disabled={!canNavigate || pdf.addingImages || !canQuoteCurrent}
              onClick={() => void pdf.attachPageImages(continuous ? activePages : undefined)}>
              <Icon name="file-image" variant="linear" tone="neutral" />{imageLabel}
            </Button>}
            {selecting && <p className="pdf-hint">在页图上拖动框选，再引用所选区域。</p>}
            {reading?.region && <p className="pdf-hint">当前显示已引用的区域。点「完整页」可阅读整页。</p>}
          </div>
          {doc.pageCount > 1 && <PdfThumbnails key={doc.documentId} open={openText} pageCount={doc.pageCount}
            page={page} facingPage={activePages[1]} visible={sidebarOpen} enabled={canNavigate}
            onNavigate={next => navigate(next, twoPages && next < doc.pageCount)} />}
        </aside>
        <div className="pdf-reader-stage">
          <div className="pdf-reading" data-pdf-reading-id={reading?.readingId} ref={viewport} tabIndex={0} aria-label="PDF 页图">
            <div className="pdf-pages" data-spread={!continuous && spread} data-continuous={continuous || undefined}
              data-selecting={selecting || undefined} style={!continuous && spread ? { gap: pdfSpreadGap } : undefined}>
              {continuous
                ? (twoPages
                  ? twoPageRows.map(row => <div className="pdf-page-row" key={row[0]} data-spread={spread}
                    style={spread ? { gap: pdfSpreadGap } : undefined}>
                    {row.map(number => {
                      const fixedPage = reading?.documentId === doc.documentId && reading.documentSha256 === doc.sha256
                        ? reading.pages.find(item => item.page === number) : undefined
                      return <PdfContinuousPage key={number} pageNumber={number} label={doc.pageLabels[number - 1]}
                        size={continuousSizes.get(number) ?? fallbackPageSize} percent={percent}
                        fixedPage={fixedPage} openText={openText} viewport={viewport} onTextLayout={textChanged} />
                    })}
                  </div>)
                  : Array.from({ length: doc.pageCount }, (_, index) => {
                    const number = index + 1
                    const fixedPage = reading?.documentId === doc.documentId && reading.documentSha256 === doc.sha256
                      ? reading.pages.find(item => item.page === number) : undefined
                    return <PdfContinuousPage key={number} pageNumber={number} label={doc.pageLabels[index]}
                      size={continuousSizes.get(number) ?? fallbackPageSize} percent={percent}
                      fixedPage={fixedPage} openText={openText} viewport={viewport} onTextLayout={textChanged} />
                  }))
                : reading?.pages.map((item, index) => <article className="pdf-page" data-pdf-page={item.page} tabIndex={-1} key={item.page}
                  aria-label={`第 ${item.page} 页`} style={fixedSizes[index] ? { width: fixedSizes[index].width * percent / 100 } : undefined}>
                  {item.state !== 'ready' || !item.image ? <p className="pdf-error" role="status">{item.state === 'out-of-range' ? '此页超出 PDF 实际页数。'
                    : item.state === 'limit' ? '此页图超出处理尺寸或体积限制，无法显示。'
                      : item.state === 'timeout' ? '此页处理超时，未生成可引用页图。' : '此页图未完整生成，无法引用。'}{item.detail ? ` ${item.detail}` : ''}</p>
                    : <PdfPageImage key={reading.readingId + ':' + item.page} item={item} image={item.image}
                      openText={reading.documentSha256 === doc.sha256 ? openText : undefined}
                      sharpen={!reading.region && reading.readingId !== pdf.referenceReadingId} onTextLayout={textChanged}
                      selecting={selecting && !pdf.busy} region={region} onRegion={setRegion} />}
                </article>)}
            </div>
            {pdf.pendingRead && !pdf.busy && <Button type="button" variant="outline" disabled={!pdf.writable}
              onClick={() => void pdf.retryRead()}>核对并继续本次阅读</Button>}
            {reading?.pages.some(item => item.state === 'failed' || item.state === 'timeout') && <Button type="button" variant="outline"
              disabled={!canNavigate} onClick={() => void pdf.readPages(reading.requestedPages, reading.region)}>重新读取页图</Button>}
            {pdf.busy && !pendingPages && <p className="pdf-hint" role="status">正在读取 PDF…</p>}
          </div>
          <PdfSelectionCopy viewport={viewport} readingId={textScopeId} scale={percent} enabled={!selecting && !findOpen && !pdf.busy} />
        </div>
        {pendingPages && <p className="pdf-hint pdf-reading-status" role="status">
          正在读取第 {pendingPages.join('、')} 页…
        </p>}
        <form className="pdf-find-popover" id={findId} role="search" aria-label="PDF 页内查找" hidden={!findOpen}
          onSubmit={event => event.preventDefault()}>
          <input ref={findInput} type="search" aria-label="当前页文字查找" value={query} onChange={event => setQuery(event.target.value)}
            placeholder="查找页内文字" maxLength={200} onCompositionStart={() => { findComposing.current = true }}
            onCompositionEnd={() => { findComposing.current = false }} onKeyDown={event => {
              if (event.key !== 'Enter' || findComposing.current || event.nativeEvent.isComposing || event.keyCode === 229) return
              event.preventDefault(); find.step(event.shiftKey ? -1 : 1)
            }} />
          <div className="pdf-find-controls">
            <span className="pdf-find-status" role="status">{query.trim() && (
              pendingPages ? '正在换页…' : find.count ? `${find.position} / ${find.total}`
                : continuous
                  ? (find.loading ? '正在查找…' : find.unavailable || !openText ? '文字暂不可用' : find.hasReady || hasNativeText ? '无匹配' : '无原生文字')
                  : (!reading || find.loading || pdf.busy ? '正在查找…'
                    : find.unavailable || (hasNativeText && !openText) ? '文字暂不可用' : hasNativeText ? '无匹配'
                      : reading.pages.every(item => item.state === 'ready') ? '无原生文字' : '文字读取不完整'))}
            </span>
            <PdfIconButton icon="arrow-up" label="上一处匹配" disabled={!find.count} onClick={() => find.step(-1)} />
            <PdfIconButton icon="arrow-down" label="下一处匹配" disabled={!find.count} onClick={() => find.step(1)} />
            <PdfIconButton icon="close" label="关闭查找" onClick={() => closeFind()} />
          </div>
        </form>
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
