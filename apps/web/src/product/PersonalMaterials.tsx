import { useCallback, useEffect, useRef, useState } from 'react'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import { toast, useToastFeedback } from '@xunjie/ui/feedback'
import { PERSONAL_MATERIAL_LIMITS, personalMaterialReferenceSourceSchema, personalMaterialSchema,
  personalMaterialVersionContentSchema, type PersonalMaterial, type PersonalMaterialMediaType,
  type PersonalMaterialReferenceSource, type PersonalMaterialVersionContent } from '@xunjie/contracts/personal-materials'
import { questionReferenceSourceId } from '@xunjie/contracts/question-drafts'
import { TextReferenceSource, useWorkspaceReferences, type LocateResult } from '../components/workspace/references'
import { acknowledgePersonalMaterialRequest, listPersonalMaterialRequests, retainPersonalMaterialRemove,
  retainPersonalMaterialSave, retainPersonalMaterialUpdate, type PersonalMaterialRequest } from '../reliable-workspace/personal-materials'
import { learningRequest, workspaceScope } from './learningTransport'
import './PersonalMaterials.css'

const MEDIA_LABEL: Record<PersonalMaterialMediaType, string> = { 'text/plain': '纯文本', 'text/markdown': 'Markdown' }
const requestLabel = (request: PersonalMaterialRequest) => request.kind === 'save' ? '保存' : request.kind === 'update' ? '更新' : '移除'

function failureText(error: unknown) {
  if (error instanceof Error && error.name === 'ZodError') return '个人笔记响应缺少必要字段或版本信息，请核对原请求。已有引用仍保留。'
  const code = (error as { code?: string })?.code
  if (code === 'forbidden') return '当前活动的访问资格已失效，请恢复原空间登录后核对。'
  if (code === 'missing') return '原服务尚未找到这份个人笔记或固定版本。原引用与待核对请求仍保留。'
  if (code === 'invalid') return '个人笔记请求未被接受，请核对名称、正文或版本。原请求仍保留。'
  if (code === 'identity-conflict') return '材料版本或原请求身份发生冲突，请打开最新版本核对；不会自动更换请求或材料身份。'
  if (code === 'conflict') return '材料版本已变化，请打开最新版本核对后再更新。原请求仍保留。'
  if (code === 'maintenance') return '学习服务正在维护，原请求已保留，请稍后核对。'
  if (code || (error instanceof Error && ['TimeoutError', 'AbortError', 'TypeError'].includes(error.name)))
    return '尚未确认原服务结果，已保留原请求。请恢复连接后重试核对。'
  return error instanceof Error ? error.message : '个人笔记操作未完成，请重试。'
}
const versionOf = (material: PersonalMaterial, version = material.currentVersion) =>
  material.versions.find(item => item.version === version)
const sourceOf = (content: PersonalMaterialVersionContent): PersonalMaterialReferenceSource => ({ kind: 'personal-material',
  activityId: content.material.activityId, materialId: content.material.materialId,
  version: content.version.version, sha256: content.version.sha256 })
const sourceIdOf = (source: PersonalMaterialReferenceSource) => questionReferenceSourceId(source)
const materialSourceId = (material: PersonalMaterial) => {
  const version = versionOf(material)
  return version ? questionReferenceSourceId({ kind: 'personal-material', activityId: material.activityId,
    materialId: material.materialId, version: version.version, sha256: version.sha256 }) : ''
}
function mergeMaterials(remote: PersonalMaterial[], requests: PersonalMaterialRequest[]) {
  const result = new Map(remote.map(material => [material.materialId, material]))
  for (const request of requests) {
    if (!request.material) continue
    const material = request.material, existing = result.get(material.materialId)
    if (!existing || material.currentVersion > existing.currentVersion
      || (material.currentVersion === existing.currentVersion && material.removedAt && !existing.removedAt))
      result.set(material.materialId, material)
  }
  return [...result.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.materialId.localeCompare(b.materialId))
}
const nextFrame = () => new Promise<void>(resolve => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve())
  else setTimeout(resolve, 0)
})
function escapeAttribute(value: string) {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, char => `\\${char}`)
}
function rangeAtOffsets(root: HTMLElement, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  let offset = 0
  let foundStart = false
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0
    if (!foundStart && start <= offset + length) { range.setStart(node, start - offset); foundStart = true }
    if (foundStart && end <= offset + length) { range.setEnd(node, end - offset); return range }
    offset += length
  }
  return null
}

/** Kept by ActivityPage, so changing/closing a center tab cannot reset pending operations. */
export function usePersonalMaterials({ activity, spaceKey, namespace, authorized, reveal }: {
  activity: LearningActivity; spaceKey: string; namespace: string; authorized: boolean; reveal(): Promise<void>
}) {
  const references = useWorkspaceReferences()
  const scope = workspaceScope(namespace, activity)
  const [materials, setMaterials] = useState<PersonalMaterial[]>([])
  const [requests, setRequests] = useState<PersonalMaterialRequest[]>([])
  const [reading, setReading] = useState<PersonalMaterialVersionContent | null>(null)
  const [editing, setEditing] = useState(false)
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
    `materials/${activity.activityId}${suffix}`, body), [scope, spaceKey, namespace])
  const canWrite = () => alive.current && current.current.authorized && !current.current.readOnly

  const loadVersion = useCallback(async (materialId: string, version: number): Promise<PersonalMaterialVersionContent> => {
    const value = await api(`/${materialId}/versions/${version}`)
    if (value === null || value === undefined) throw Object.assign(new Error('个人笔记固定版本尚不可用。'), { code: 'missing' })
    const content = personalMaterialVersionContentSchema.parse(value)
    if (content.material.materialId !== materialId || content.material.activityId !== activity.activityId
      || content.version.materialId !== materialId || content.version.version !== version)
      throw new Error('固定版本内容与所选材料或版本不一致，请核对原请求。')
    return content
  }, [api, activity.activityId])

  const adopt = (material: PersonalMaterial) => {
    if (material.activityId !== activity.activityId) throw new Error('个人笔记不属于当前活动。')
    if (!alive.current) return material
    setMaterials(items => {
      const next = items.filter(item => item.materialId !== material.materialId)
      if (!material.removedAt) next.push(material)
      return next.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.materialId.localeCompare(b.materialId))
    })
    return material
  }
  const refresh = useCallback(async () => {
    const epoch = ++listEpoch.current
    setLoading(true)
    try {
      const local = await listPersonalMaterialRequests(scope)
      if (alive.current && epoch === listEpoch.current) {
        setRequests(local)
        setMaterials(items => mergeMaterials(items, local))
      }
      if (!current.current.authorized) return
      const value = await api()
      if (!Array.isArray(value)) throw new Error('个人笔记列表不完整，请重新读取。')
      const list = value.map(item => personalMaterialSchema.parse(item))
      if (list.some(item => item.activityId !== activity.activityId)) throw new Error('个人笔记列表不属于当前活动。')
      if (alive.current && epoch === listEpoch.current) { setMaterials(list); setError(''); setLoadError('') }
    } catch (error) {
      if (alive.current && epoch === listEpoch.current) { const message = failureText(error); setError(message); setLoadError(message) }
    }
    finally { if (alive.current && epoch === listEpoch.current) setLoading(false) }
  }, [scope, api, activity.activityId])
  useEffect(() => {
    setMaterials([]); setRequests([]); setReading(null); setEditing(false); setError(''); setLoadError(''); setNotice('')
    setBusy(false); setLoading(false)
  }, [scope])
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

  async function reconcileRequest(record: PersonalMaterialRequest): Promise<PersonalMaterial | undefined> {
    if (!canWrite() || operation.current) return
    ++listEpoch.current; setLoading(false)
    operation.current = true; setBusy(true); setError(''); setNotice('')
    try {
      let value: unknown
      // Query before replay; an unknown outcome never creates a replacement request identity.
      try { value = await api(`/requests/${record.input.requestId}`) }
      catch (error) { if ((error as { code?: string }).code !== 'missing') throw error }
      if (value === null || value === undefined) {
        const route = record.kind === 'save' ? '' : record.kind === 'update' ? `/${record.input.materialId}` : `/${record.input.materialId}/remove`
        value = await api(route, record.input)
      }
      const material = await acknowledgePersonalMaterialRequest(record, value)
      if (material.activityId !== activity.activityId) throw new Error('个人笔记接收结果不属于当前活动。')
      if (!alive.current) return
      const saved = await listPersonalMaterialRequests(scope)
      if (!alive.current) return
      setRequests(saved); adopt(material)
      setNotice(record.kind === 'save' ? `已保存「${record.name}」。` : record.kind === 'update'
        ? `已保存「${record.name}」的第 ${record.input.expectedVersion + 1} 版。` : `已移除「${record.name}」。`)
      return material
    } catch (error) {
      if (alive.current) setError(failureText(error))
      return undefined
    } finally { operation.current = false; if (alive.current) setBusy(false) }
  }

  async function save(input: { name: string; mediaType: PersonalMaterialMediaType; text: string }) {
    if (!canWrite() || operation.current) return
    ++listEpoch.current; setLoading(false)
    operation.current = true; setBusy(true); setError(''); setNotice('')
    try {
      const record = await retainPersonalMaterialSave(scope, activity.activityId, input)
      if (!canWrite()) return
      const saved = await listPersonalMaterialRequests(scope)
      if (!canWrite()) return
      setRequests(saved)
      operation.current = false; setBusy(false)
      return await reconcileRequest(record)
    } catch (error) { if (alive.current) setError(failureText(error)) }
    finally { operation.current = false; if (alive.current) setBusy(false) }
  }
  async function update(input: { text: string }) {
    const target = reading
    if (!target || !canWrite() || operation.current) return
    ++listEpoch.current; setLoading(false)
    operation.current = true; setBusy(true); setError(''); setNotice('')
    try {
      const record = await retainPersonalMaterialUpdate(scope, activity.activityId, target.material, input)
      if (!canWrite()) return
      const saved = await listPersonalMaterialRequests(scope)
      if (!canWrite()) return
      setRequests(saved)
      operation.current = false; setBusy(false)
      const material = await reconcileRequest(record)
      if (!material || !alive.current) return
      const version = versionOf(material, record.input.expectedVersion + 1)
      if (version) setReading(currentReading => currentReading && currentReading.material.materialId === material.materialId
        ? { material, version, text: input.text } : currentReading)
      setEditing(false)
      return material
    } catch (error) { if (alive.current) setError(failureText(error)) }
    finally { operation.current = false; if (alive.current) setBusy(false) }
  }
  async function remove(material: PersonalMaterial) {
    if (!canWrite() || operation.current) return
    ++listEpoch.current; setLoading(false)
    operation.current = true; setBusy(true); setError(''); setNotice('')
    try {
      const record = await retainPersonalMaterialRemove(scope, activity.activityId, material)
      if (!canWrite()) return
      const saved = await listPersonalMaterialRequests(scope)
      if (!canWrite()) return
      setRequests(saved)
      operation.current = false; setBusy(false)
      const updated = await reconcileRequest(record)
      if (updated) setReading(currentReading => currentReading && currentReading.material.materialId === updated.materialId
        ? { ...currentReading, material: updated } : currentReading)
      return !!updated
    } catch (error) { if (alive.current) setError(failureText(error)) }
    finally { operation.current = false; if (alive.current) setBusy(false) }
  }
  async function open(material: PersonalMaterial) {
    if (!alive.current || operation.current) return
    const epoch = ++readEpoch.current
    operation.current = true; setBusy(true); setError(''); setNotice(''); setEditing(false)
    try {
      await current.current.reveal()
      if (!alive.current || epoch !== readEpoch.current) return
      const content = await loadVersion(material.materialId, material.currentVersion)
      if (!alive.current || epoch !== readEpoch.current) return
      setReading(content)
    } catch (error) { if (alive.current && epoch === readEpoch.current) setError(failureText(error)) }
    finally { operation.current = false; if (alive.current && epoch === readEpoch.current) setBusy(false) }
  }
  async function beginUpdate(material: PersonalMaterial) {
    if (!alive.current || operation.current) return
    const epoch = ++readEpoch.current
    operation.current = true; setBusy(true); setError(''); setNotice('')
    try {
      await current.current.reveal()
      if (!alive.current || epoch !== readEpoch.current) return
      if (reading && reading.material.materialId === material.materialId && reading.version.version === material.currentVersion) {
        setEditing(true); return
      }
      const content = await loadVersion(material.materialId, material.currentVersion)
      if (!alive.current || epoch !== readEpoch.current) return
      setReading(content); setEditing(true)
    } catch (error) { if (alive.current && epoch === readEpoch.current) setError(failureText(error)) }
    finally { operation.current = false; if (alive.current && epoch === readEpoch.current) setBusy(false) }
  }
  const beginEditing = () => { if (reading && !reading.material.removedAt) setEditing(true) }
  const cancelEditing = () => setEditing(false)
  const clearReading = useCallback(() => {
    if (!alive.current) return
    ++readEpoch.current
    setReading(null); setEditing(false)
  }, [])
  const locate = async (value: unknown, referenceRange?: { start?: number; end?: number }): Promise<LocateResult> => {
    const parsed = personalMaterialReferenceSourceSchema.safeParse(value)
    if (!parsed.success) return { ok: false, reason: '个人笔记引用格式不完整，固定副本仍保留。' }
    if (parsed.data.activityId !== activity.activityId)
      return { ok: false, reason: '个人笔记引用不属于当前活动，固定副本仍保留。' }
    if (operation.current) return { ok: false, reason: '正在处理个人笔记，请完成后再定位原引用。' }
    const source = parsed.data
    const exact = reading && reading.material.materialId === source.materialId
      && reading.version.version === source.version && reading.version.sha256 === source.sha256
    const epoch = ++readEpoch.current
    operation.current = true; setBusy(true); setError('')
    try {
      await current.current.reveal()
      if (!alive.current || epoch !== readEpoch.current) return { ok: false, reason: '已离开原活动。' }
      let content = exact ? reading : null
      if (!content) {
        content = await loadVersion(source.materialId, source.version)
        if (content.material.activityId !== activity.activityId || content.material.materialId !== source.materialId
          || content.version.version !== source.version || content.version.sha256 !== source.sha256)
          throw new Error('固定版本内容与引用不一致，原引用仍保留。')
        if (!alive.current || epoch !== readEpoch.current) return { ok: false, reason: '已离开原活动。' }
        setReading(content); setEditing(false)
      }
      const key = `${source.materialId}:${source.version}`
      for (let attempt = 0; attempt < 120 && alive.current && epoch === readEpoch.current; attempt++) {
        await nextFrame()
        const root = window.document.querySelector<HTMLElement>(
          `[data-personal-material-reading="${escapeAttribute(key)}"] .wr-text-source`)
        if (!root) continue
        if (root.textContent !== content.text)
          return { ok: false, reason: '固定版本正文与引用不一致，原引用仍保留。' }
        if (referenceRange?.start !== undefined && referenceRange.end !== undefined) {
          const range = rangeAtOffsets(root, referenceRange.start, referenceRange.end)
          if (!range) return { ok: false, reason: '固定版本已读取，但原选区当前不可用；引用副本仍保留。' }
          root.scrollIntoView({ block: 'center' })
          root.focus({ preventScroll: true })
          const selected = document.getSelection()
          selected?.removeAllRanges()
          selected?.addRange(range)
        } else {
          root.scrollIntoView({ block: 'center' })
          root.focus({ preventScroll: true })
        }
        return { ok: true }
      }
      return { ok: false, reason: '固定版本已读取，但当前布局未能打开阅读位置。' }
    } catch (error) {
      const reason = failureText(error)
      if (alive.current && epoch === readEpoch.current) setError(reason)
      return { ok: false, reason }
    } finally { operation.current = false; if (alive.current && epoch === readEpoch.current) setBusy(false) }
  }
  const latest = useRef({ locate })
  latest.current = { locate }
  const shownSourceId = reading ? sourceIdOf(sourceOf(reading)) : null
  const sourceIds = JSON.stringify([...new Set([
    ...materials.map(materialSourceId).filter(Boolean),
    ...references.references.filter(reference => reference.source?.kind === 'personal-material').map(reference => reference.sourceId),
  ])].sort())
  useEffect(() => {
    const unregister = (JSON.parse(sourceIds) as string[]).filter(sourceId => sourceId !== shownSourceId)
      .map(sourceId => references.register({ sourceId,
        locate: reference => latest.current.locate(reference.source, reference.range) }))
    return () => unregister.forEach(stop => stop())
  }, [sourceIds, shownSourceId, references.register])

  return { materials, requests, reading, editing, busy, loading, error, loadError, notice,
    writable: authorized && !references.readOnly, canQuote: references.draftReady && !!reading && !reading.material.removedAt,
    refresh, save, update, remove, open, beginUpdate, beginEditing, cancelEditing, clearReading, receive: reconcileRequest, locate,
    reveal: async () => {
      try { await current.current.reveal() }
      catch (error) { if (alive.current) setError(failureText(error)) }
    } }
}
export type PersonalMaterialsController = ReturnType<typeof usePersonalMaterials>

export function PersonalMaterialEntries({ personal }: { personal: PersonalMaterialsController }) {
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [text, setText] = useState('')
  const [mediaType, setMediaType] = useState<PersonalMaterialMediaType>('text/plain')
  const localErrorToast = useRef<string | number | undefined>(undefined)
  const setLocalError = (message: string) => {
    if (message) localErrorToast.current = toast.error(message, { id: localErrorToast.current, duration: 8000 })
    else if (localErrorToast.current !== undefined) toast.dismiss(localErrorToast.current)
  }
  const visible = personal.materials.filter(material => !material.removedAt)
  const pending = personal.requests.filter(request => !request.material)
  const choose = async (file: File) => {
    setLocalError('')
    const markdown = /\.(md|markdown)$/i.test(file.name) || file.type === 'text/markdown'
    if (!/\.(txt|md|markdown)$/i.test(file.name) && !['text/plain', 'text/markdown'].includes(file.type)) {
      setLocalError('仅支持 .txt 或 .md 文本文件。'); return
    }
    if (file.size > PERSONAL_MATERIAL_LIMITS.inputBytes) { setLocalError('个人笔记超过 2 MiB，请缩减后再添加。'); return }
    try {
      const content = await file.text()
      if (!content.trim()) { setLocalError('所选文件没有可保存的文本内容。'); return }
      setText(content); setMediaType(markdown ? 'text/markdown' : 'text/plain')
      if (!name.trim()) setName(file.name.replace(/\.(txt|md|markdown)$/i, '').slice(0, PERSONAL_MATERIAL_LIMITS.nameLength))
    } catch { setLocalError('无法读取所选文件，请复制正文后粘贴。') }
  }
  const save = async () => {
    if (!name.trim()) { setLocalError('请填写个人笔记名称。'); return }
    if (!text.trim()) { setLocalError('请粘贴或选择个人笔记内容。'); return }
    setLocalError('')
    const saved = await personal.save({ name: name.trim(), mediaType, text })
    if (saved) { setAdding(false); setName(''); setText(''); setMediaType('text/plain') }
  }
  return <section className="personal-material-entries" aria-label="个人笔记列表与添加">
    <div className="personal-material-heading"><h3>我的个人笔记</h3>
      <button type="button" className="ws-btn ghost" disabled={!personal.writable || personal.busy}
        aria-expanded={adding} onClick={() => { setAdding(value => !value); setLocalError('') }}>
        {adding ? '收起添加' : '添加笔记'}</button></div>
    <p className="detail">仅用于你的学习活动 · 支持 .txt / .md，单份最多 2 MiB</p>
    {adding && <div className="personal-material-form">
      <label>名称<input aria-label="个人笔记名称" value={name} maxLength={PERSONAL_MATERIAL_LIMITS.nameLength}
        disabled={personal.busy} onChange={event => setName(event.target.value)} placeholder="例如：课堂笔记" /></label>
      <label>正文<textarea aria-label="个人笔记正文" value={text} disabled={personal.busy} rows={7}
        onChange={event => setText(event.target.value)} placeholder="粘贴个人笔记正文…" /></label>
      <label>从文件读取<input type="file" aria-label="选择个人笔记文件" accept=".txt,.md,.markdown,text/plain,text/markdown"
        disabled={personal.busy} onChange={event => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) void choose(file)
        }} /></label>
      <div className="personal-material-actions">
        <button type="button" className="ws-btn" disabled={!personal.writable || personal.busy || !name.trim() || !text.trim()}
          onClick={() => void save()}>保存笔记</button>
        <button type="button" className="ws-btn ghost" disabled={personal.busy}
          onClick={() => { setAdding(false); setLocalError('') }}>取消</button>
      </div>
    </div>}
    {visible.length > 0 ? <ul className="material-list personal-material-list" aria-label="个人笔记列表">
      {visible.map(material => <li key={material.materialId}>
        <div className="personal-material-row"><strong>{material.name}</strong>
          <span className="detail">第 {material.currentVersion} 版 · {MEDIA_LABEL[material.mediaType]}</span></div>
        <div className="personal-material-actions">
          <button type="button" className="ws-btn ghost" disabled={personal.busy}
            onClick={() => void personal.open(material)}>打开</button>
          <button type="button" className="ws-btn ghost" disabled={!personal.writable || personal.busy}
            onClick={() => void personal.beginUpdate(material)}>更新</button>
          <button type="button" className="ws-btn ghost" disabled={!personal.writable || personal.busy}
            onClick={() => void personal.remove(material)}>移除</button>
        </div>
      </li>)}
    </ul> : <p className="detail">还没有个人笔记。添加后可在阅读区选择正文引用到问题。</p>}
    {pending.map(request => <div className="personal-material-pending" key={request.key}>
      <span>「{request.name}」· {requestLabel(request)}尚未确认</span>
      <button type="button" className="ws-btn ghost" disabled={!personal.writable || personal.busy}
        onClick={() => void personal.receive(request)}>核对并继续原请求</button>
    </div>)}
    {personal.loading && <p className="detail" role="status">正在读取个人笔记列表…</p>}
    {personal.busy && <p className="detail" role="status">正在保存或读取个人笔记…</p>}
    {personal.loadError && <p className="detail">{personal.loadError}</p>}
    <div className="personal-material-actions">
      <button type="button" className="ws-btn ghost" disabled={personal.busy || personal.loading}
        onClick={() => void personal.refresh()}>刷新个人笔记列表</button>
      <button type="button" className="ws-btn ghost" onClick={() => void personal.reveal()}>打开个人笔记阅读区</button>
    </div>
  </section>
}

export function PersonalMaterials({ personal, onBack }: { personal: PersonalMaterialsController; onBack(): void }) {
  const { reading } = personal
  const [text, setText] = useState('')
  useEffect(() => { setText(reading?.text ?? '') }, [reading?.text, personal.editing])
  useEffect(() => () => { personal.clearReading() }, [personal.clearReading])
  const source = reading ? sourceOf(reading) : null
  return <section className="personal-materials" aria-label="个人笔记阅读区" aria-busy={personal.busy}>
    <header className="personal-material-toolbar">
      <button type="button" className="ws-btn ghost" onClick={onBack}>返回作品</button>
      <strong>{reading?.version.name ?? '个人笔记'}</strong>
      {reading && <span className="personal-material-version">第 {reading.version.version} 版</span>}
      {reading && reading.version.version !== reading.material.currentVersion
        && <span className="personal-material-muted">当前材料已到第 {reading.material.currentVersion} 版</span>}
      {reading && !personal.editing && <button type="button" className="ws-btn ghost"
        disabled={!personal.writable || personal.busy || !!reading.material.removedAt}
        onClick={() => personal.beginEditing()}>更新为当前文本</button>}
    </header>
    {!reading ? <div className="personal-material-empty">
      <h2>阅读个人笔记</h2>
      <p>从「目标与材料」添加或打开个人笔记；在正文中选择文字即可引用到问题。</p>
    </div> : <>
      {reading.material.removedAt && <p className="personal-material-notice" role="status">这份材料已移除；固定版本仍可阅读和引用。</p>}
      <div className="personal-material-reading" data-personal-material-reading={`${reading.material.materialId}:${reading.version.version}`}>
        {source && <TextReferenceSource sourceId={sourceIdOf(source)} sourceName={reading.version.name}
          text={reading.text} source={source} />}
      </div>
      {personal.editing && <div className="personal-material-form personal-material-editor">
        <label>更新为当前文本
          <textarea aria-label="更新个人笔记正文" value={text} rows={10} disabled={personal.busy}
            onChange={event => setText(event.target.value)} />
        </label>
        <p className="personal-material-muted">保存后将追加第 {reading.material.currentVersion + 1} 版，当前正文保持可见。</p>
        <div className="personal-material-actions">
          <button type="button" className="ws-btn" disabled={!personal.writable || personal.busy || !text.trim()}
            onClick={() => void personal.update({ text })}>保存新版本</button>
          <button type="button" className="ws-btn ghost" disabled={personal.busy} onClick={personal.cancelEditing}>取消更新</button>
        </div>
      </div>}
    </>}
    {personal.busy && <p className="personal-material-muted" role="status">正在保存或读取个人笔记…</p>}
  </section>
}
