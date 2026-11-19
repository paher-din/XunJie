import { useRef, useState } from 'react'
import { z } from 'zod'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import type { QuestionReferenceInput } from '@xunjie/contracts/question-drafts'
import { PERSONAL_MATERIAL_LIMITS, personalMaterialSchema, personalMaterialVersionContentSchema } from '@xunjie/contracts/personal-materials'
import { PDF_LIMITS, pdfDocumentSchema, pdfReadingSchema, pdfReferenceCopy } from '@xunjie/contracts/pdf-materials'
import { learningRequest } from './learningTransport'

const limit = 8
const cacheName = 'xunjie-composer-attachments-v1'
const attachmentSchema = z.object({ id: z.uuid(), readId: z.uuid(), name: z.string().min(1).max(240),
  kind: z.enum(['text', 'markdown', 'pdf']), sha256: z.string().regex(/^[0-9a-f]{64}$/), size: z.number().int().positive().optional() }).strict()
export const composerAttachmentsSchema = z.array(attachmentSchema).max(limit)
type ComposerAttachment = z.infer<typeof attachmentSchema>
const address = (id: string) => new URL(`/__xj_composer_attachment/${id}`, location.origin).href
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const digest = async (bytes: ArrayBuffer) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
  byte => byte.toString(16).padStart(2, '0')).join('')

export async function releaseComposerAttachments(items: readonly ComposerAttachment[]) {
  if (!items.length) return
  const cache = await caches.open(cacheName)
  await Promise.all(items.map(item => cache.delete(address(item.id))))
}

export function useComposerAttachments(scope: string) {
  const key = `${scope}:composer-attachments`
  const [items, setItems] = useState(() => {
    try { return composerAttachmentsSchema.parse(JSON.parse(sessionStorage.getItem(key) ?? '[]')) } catch { return [] }
  })
  const current = useRef(items)
  const adding = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  function save(next: ComposerAttachment[]) {
    sessionStorage.setItem(key, JSON.stringify(next))
    current.current = next
    setItems(next)
  }
  async function add(files: File[]) {
    if (!files.length || adding.current) return
    if (current.current.length + files.length > limit) { setError(`每条消息最多添加 ${limit} 个附件。`); return }
    adding.current = true
    setBusy(true)
    setError('')
    const staged: ComposerAttachment[] = []
    try {
      const cache = await caches.open(cacheName)
      for (const file of files) {
        const kind = /\.pdf$/i.test(file.name) || file.type === 'application/pdf' ? 'pdf' : /\.(md|markdown)$/i.test(file.name) ? 'markdown' : 'text'
        const maxBytes = kind === 'pdf' ? PDF_LIMITS.inputBytes : PERSONAL_MATERIAL_LIMITS.inputBytes
        if (!file.size || file.size > maxBytes || !file.name.trim() || file.name.trim().length > 240)
          throw new Error(`「${file.name}」为空、文件名过长或超过 ${maxBytes / 1048576} MiB。`)
        const bytes = await file.arrayBuffer()
        if (kind !== 'pdf') {
          let value: string
          try { value = decoder.decode(bytes) } catch { throw new Error(`「${file.name}」须为 UTF-8 文本、代码文件或 PDF。`) }
          if (!value.trim() || value.includes('\0')) throw new Error(`「${file.name}」没有可用的 UTF-8 正文。`)
        }
        const item = attachmentSchema.parse({ id: crypto.randomUUID(), readId: crypto.randomUUID(), name: file.name.trim(), kind,
          sha256: await digest(bytes), size: file.size })
        await cache.put(address(item.id), new Response(bytes))
        staged.push(item)
      }
      save([...current.current, ...staged])
    } catch (cause) {
      void releaseComposerAttachments(staged).catch(() => {})
      setError(cause instanceof Error ? cause.message : '附件未保存，请重新添加。')
    } finally { adding.current = false; setBusy(false) }
  }
  function remove(id: string) {
    const removed = current.current.filter(item => item.id === id)
    try { save(current.current.filter(item => item.id !== id)); void releaseComposerAttachments(removed).catch(() => {}); setError('') }
    catch { setError('附件列表无法保存，请检查浏览器存储。') }
  }
  function detach(sent: readonly ComposerAttachment[]) {
    const ids = new Set(sent.map(item => item.id))
    save(current.current.filter(item => !ids.has(item.id)))
  }
  return { items, add, remove, detach, busy, error }
}

export type ComposerAttachments = ReturnType<typeof useComposerAttachments>

function base64(bytes: ArrayBuffer) {
  const values = new Uint8Array(bytes), chunks: string[] = []
  for (let start = 0; start < values.length; start += 32768) chunks.push(String.fromCharCode(...values.subarray(start, start + 32768)))
  return btoa(chunks.join(''))
}

/** Replay the same upload and read identities after a lost reply. Only owner-verified sources enter the question. */
export async function resolveComposerAttachments(activity: LearningActivity, spaceKey: string, namespace: string,
  items: readonly ComposerAttachment[], active = () => true): Promise<QuestionReferenceInput[]> {
  if (!items.length) return []
  const cache = await caches.open(cacheName)
  const result: QuestionReferenceInput[] = []
  const activityId = activity.activityId
  const request = (route: string, body?: unknown) => {
    if (!active()) throw new Error('附件仍保留在原对话。')
    return learningRequest(activity, spaceKey, namespace, route, body)
  }
  for (const item of items) {
    const saved = await cache.match(address(item.id))
    const bytes = await saved?.arrayBuffer()
    if (!bytes || await digest(bytes) !== item.sha256) throw new Error(`无法读取原附件「${item.name}」，请重新添加。`)
    const dataBase64 = base64(bytes)
    if (item.kind === 'pdf') {
      const path = `pdf/${activityId}`
      const document = pdfDocumentSchema.parse(await request(path, { requestId: item.id, documentId: item.id, name: item.name, dataBase64 }))
      if (document.activityId !== activityId || document.documentId !== item.id || document.sha256 !== item.sha256 || document.state !== 'ready')
        throw new Error(`PDF「${item.name}」未完成读取${document.detail ? `：${document.detail}` : '，请重试原请求。'}`)
      const pages = [1], region = null
      const reading = pdfReadingSchema.parse(await request(`${path}/read`, { requestId: item.readId, documentId: item.id, pages, region }))
      if (reading.activityId !== activityId || reading.documentId !== item.id || reading.documentSha256 !== item.sha256 || reading.readingId !== item.readId)
        throw new Error('PDF 阅读回执与原附件不匹配。')
      const copy = pdfReferenceCopy(reading)
      result.push({ referenceId: item.id, sourceName: item.name,
        source: { kind: 'pdf', activityId, documentId: item.id, documentSha256: item.sha256, readingId: item.readId },
        range: { kind: 'semantic', formatVersion: 1, typeId: 'pdf-pages', version: 1, start: 0, end: copy.length,
          target: { pages, region, coordinates: reading.coordinates } }, copy })
      continue
    }
    const path = `materials/${activityId}`
    const material = personalMaterialSchema.parse(await request(path, { requestId: item.id, materialId: item.id,
      name: item.name, mediaType: item.kind === 'markdown' ? 'text/markdown' : 'text/plain', dataBase64 }))
    if (material.activityId !== activityId || material.materialId !== item.id || material.versions[0]?.sha256 !== item.sha256)
      throw new Error('个人材料回执与原附件不匹配。')
    const content = personalMaterialVersionContentSchema.parse(await request(`${path}/${item.id}/versions/1`))
    if (content.material.materialId !== item.id || content.version.sha256 !== item.sha256) throw new Error('个人材料版本与原附件不匹配。')
    const copy = content.text.slice(0, PERSONAL_MATERIAL_LIMITS.readChars)
    result.push({ referenceId: item.id, sourceName: item.name, source: { kind: 'personal-material', activityId,
      materialId: item.id, version: 1, sha256: item.sha256 }, range: { kind: 'text', start: 0, end: copy.length }, copy })
  }
  return result
}
