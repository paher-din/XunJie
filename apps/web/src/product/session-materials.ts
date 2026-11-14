import { z } from 'zod'
import { sessionPdfDocumentSchema, sessionPdfReadingSchema } from '@xunjie/contracts/pdf-materials'
import { sessionPersonalMaterialSchema, scopedPersonalMaterialVersionContentSchema } from '@xunjie/contracts/personal-materials'
import { ReliableRecordStore } from '../reliable-workspace/record-store'
import { openWorkspaceDatabase } from '../reliable-workspace/draft-store'
import type { AgentSessionsClient } from './agent-sessions'

type Material = z.infer<typeof sessionPdfDocumentSchema> | z.infer<typeof sessionPersonalMaterialSchema>
export interface SessionMaterialUpload { key: string; scope: string; kind: 'pdf' | 'materials'; input: { requestId: string; name: string; dataBase64: string; documentId?: string; materialId?: string; mediaType?: 'text/plain' | 'text/markdown' }; confirmed?: boolean; remote?: Material }
const store = new ReliableRecordStore<SessionMaterialUpload>('personalMaterials')
export const sessionMaterialScope = (client: AgentSessionsClient, sessionId: string) => JSON.stringify([client.scope, 'session-materials', sessionId])
export async function sessionUploads(client: AgentSessionsClient, sessionId: string): Promise<SessionMaterialUpload[]> {
  const db = await openWorkspaceDatabase(), scope = sessionMaterialScope(client, sessionId)
  const saved: SessionMaterialUpload[] = await new Promise((resolve, reject) => { const tx = db.transaction('personalMaterials', 'readonly'), read = tx.objectStore('personalMaterials').index('scope').getAll(scope)
    tx.oncomplete = () => resolve(read.result); tx.onabort = () => reject(tx.error); tx.onerror = () => {} })
  const [pdfs, materials] = await Promise.all([
    client.request(`${sessionId}/pdf`).then(value => z.array(sessionPdfDocumentSchema).parse(value)),
    client.request(`${sessionId}/materials`).then(value => z.array(sessionPersonalMaterialSchema).parse(value)),
  ])
  const merged = new Map(saved.map(item => [item.input.requestId, item]))
  for (const remote of [...pdfs, ...materials]) {
    if (remote.scope.sessionId !== sessionId) throw new Error('资料不属于当前会话。')
    if ('removedAt' in remote && remote.removedAt) { merged.delete(remote.requestId); continue }
    const old = merged.get(remote.requestId)
    merged.set(remote.requestId, { key: JSON.stringify([scope, remote.requestId]), scope, kind: 'documentId' in remote ? 'pdf' : 'materials',
      input: { requestId: remote.requestId, name: remote.name, dataBase64: '', ...('documentId' in remote ? { documentId: remote.documentId } : { materialId: remote.materialId }) },
      ...old, confirmed: !('state' in remote) || remote.state !== 'received', remote })
  }
  return [...merged.values()]
}
export async function protectSessionUpload(client: AgentSessionsClient, sessionId: string, file: File) {
  const pdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
  if (!pdf && !/\.(txt|md|markdown)$/i.test(file.name) && !['text/plain', 'text/markdown'].includes(file.type)) throw new Error('请选择 PDF、Markdown 或纯文本资料。')
  if (!file.size || file.size > (pdf ? 20 : 2) * 1024 * 1024) throw new Error(pdf ? 'PDF 需在 20 MiB 以内。' : '文本资料需在 2 MiB 以内。')
  const bytes = new Uint8Array(await file.arrayBuffer()), chunks: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 32768) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)))
  const requestId = crypto.randomUUID(), id = crypto.randomUUID(), scope = sessionMaterialScope(client, sessionId)
  const record: SessionMaterialUpload = { key: JSON.stringify([scope, requestId]), scope, kind: pdf ? 'pdf' : 'materials',
    input: { requestId, name: file.name, dataBase64: btoa(chunks.join('')), ...(pdf ? { documentId: id } : { materialId: id, mediaType: /\.(md|markdown)$/i.test(file.name) ? 'text/markdown' as const : 'text/plain' as const }) } }
  return store.change(record.key, saved => saved ?? record)
}
export async function deliverSessionUpload(client: AgentSessionsClient, sessionId: string, record: SessionMaterialUpload) {
  if (record.scope !== sessionMaterialScope(client, sessionId)) throw new Error('资料不属于当前会话。')
  if (record.remote && (!('state' in record.remote) || record.remote.state !== 'received')) return record.kind === 'pdf' ? sessionPdfDocumentSchema.parse(record.remote) : sessionPersonalMaterialSchema.parse(record.remote)
  let value: unknown
  try { value = await client.request(record.kind === 'pdf' ? `${sessionId}/pdf/documents/${record.input.documentId}` : `${sessionId}/materials/requests/${record.input.requestId}`) }
  catch (cause) { if ((cause as { code?: string }).code !== 'missing') throw cause; value = null }
  if (!value || record.kind === 'pdf' && sessionPdfDocumentSchema.parse(value).state === 'received') {
    if (!record.input.dataBase64) throw new Error('资料尚未准备好，请在原上传页面继续。')
    value = await client.request(`${sessionId}/${record.kind}`, record.input)
  }
  const result = record.kind === 'pdf' ? sessionPdfDocumentSchema.parse(value) : sessionPersonalMaterialSchema.parse(value)
  if (result.scope.sessionId !== sessionId || result.requestId !== record.input.requestId
    || ('documentId' in result ? result.documentId !== record.input.documentId : result.materialId !== record.input.materialId)) throw new Error('资料回执不属于原上传。')
  await store.change(record.key, saved => ({ ...(saved ?? record), confirmed: true }))
  return result
}
export async function readSessionMaterial(client: AgentSessionsClient, sessionId: string, record: SessionMaterialUpload, page = 1) {
  const result = await deliverSessionUpload(client, sessionId, record)
  if ('documentId' in result) {
    if (result.state !== 'ready') throw new Error(result.detail || 'PDF 尚未准备好，请稍后重新读取。')
    if (!Number.isInteger(page) || page < 1 || page > result.pageCount) throw new Error('页码超出资料范围。')
    const key = 'xj.session-pdf-read.' + JSON.stringify([client.scope, sessionId, result.documentId, result.sha256, page])
    const old = localStorage.getItem(key), input = old ? JSON.parse(old) : { requestId: crypto.randomUUID(), documentId: result.documentId, pages: [page], region: null }
    localStorage.setItem(key, JSON.stringify(input))
    const read = sessionPdfReadingSchema.parse(await client.request(`${sessionId}/pdf/read`, input))
    if (read.scope.sessionId !== sessionId || read.documentId !== result.documentId || read.documentSha256 !== result.sha256 || read.requestedPages.length !== 1 || read.requestedPages[0] !== page || read.pages.some(value => value.page !== page)) throw new Error('阅读结果不属于原资料。')
    if (read.pages.some(value => value.state !== 'ready')) throw new Error('这一页暂时无法读取，请重试。')
    return { page, pageCount: result.pageCount, text: read.pages.map(page => page.text).join('\n\n'), images: read.pages.flatMap(page => page.image ? ['data:image/png;base64,' + page.image.dataBase64] : []) }
  }
  const read = scopedPersonalMaterialVersionContentSchema.parse(await client.request(`${sessionId}/materials/${result.materialId}/versions/${result.currentVersion}`))
  if (!('scope' in read.material) || read.material.scope.sessionId !== sessionId || read.material.materialId !== result.materialId || read.version.materialId !== result.materialId || read.version.version !== result.currentVersion) throw new Error('阅读结果不属于原资料。')
  return { text: read.text, images: [] as string[], page: 1, pageCount: 1 }
}
