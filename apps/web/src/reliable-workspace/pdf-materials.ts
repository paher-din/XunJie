import { PDF_LIMITS, pdfDocumentSchema, type PdfDocument } from '@xunjie/contracts/pdf-materials'
import { openWorkspaceDatabase } from './draft-store'
import { ReliableRecordStore } from './record-store'

export type PdfMaterialRequest = { key: string; scope: string; sha256?: string; document?: PdfDocument } & (
  | { kind: 'upload'; input: { requestId: string; documentId: string; name: string; dataBase64: string } }
  | { kind: 'course'; input: { requestId: string; documentId: string; materialId: string } }
)
const records = new ReliableRecordStore<PdfMaterialRequest>('pdfMaterials')
export const pdfMaterialKey = (scope: string, documentId: string) => JSON.stringify([scope, documentId])

/** Original bytes and immutable request identities commit before any network request. */
export async function retainPdfUpload(scope: string, file: File): Promise<PdfMaterialRequest> {
  if (!file.size) throw new Error('所选 PDF 是空文件，请重新选择。')
  if (file.size > PDF_LIMITS.inputBytes) throw new Error('PDF 超过 20 MiB，请缩减文件后再添加。')
  if (!file.name || file.name.length > 240) throw new Error('PDF 文件名需在 240 个字符以内，请重命名后再添加。')
  const bytes = new Uint8Array(await file.arrayBuffer())
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('')
  const chunks: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 32768) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)))
  const input = { requestId: crypto.randomUUID(), documentId: crypto.randomUUID(), name: file.name, dataBase64: btoa(chunks.join('')) }
  const record: PdfMaterialRequest = { key: pdfMaterialKey(scope, input.documentId), scope, kind: 'upload', input, sha256 }
  try { return await records.change(record.key, saved => saved ?? record) }
  catch { throw new Error('PDF 尚未在本机可靠保存，未开始上传。请检查浏览器存储空间后重试。') }
}
export async function retainCoursePdf(scope: string, materialId: string, document?: PdfDocument): Promise<PdfMaterialRequest> {
  const existing = (await listPdfRequests(scope)).find(item => item.kind === 'course' && item.input.materialId === materialId)
  if (existing) return existing
  const input = { requestId: document?.requestId ?? crypto.randomUUID(), documentId: document?.documentId ?? crypto.randomUUID(), materialId }
  const record: PdfMaterialRequest = { key: pdfMaterialKey(scope, input.documentId), scope, kind: 'course', input }
  return records.change(record.key, saved => saved ?? record)
}
export async function listPdfRequests(scope: string): Promise<PdfMaterialRequest[]> {
  const db = await openWorkspaceDatabase()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pdfMaterials', 'readonly')
    const request = tx.objectStore('pdfMaterials').index('scope').getAll(scope)
    tx.oncomplete = () => resolve(request.result)
    tx.onabort = () => reject(tx.error)
    tx.onerror = () => {}
  })
}
export async function acknowledgePdfRequest(record: PdfMaterialRequest, value: unknown): Promise<PdfDocument> {
  const document = pdfDocumentSchema.parse(value)
  if (document.documentId !== record.input.documentId || document.requestId !== record.input.requestId
    || (record.sha256 && document.sha256 !== record.sha256)
    || (record.kind === 'course' && document.courseSource?.materialId !== record.input.materialId)
    || (record.kind === 'upload' && document.courseSource)
    || (record.kind === 'upload' && (document.name !== record.input.name
      || document.byteLength !== record.input.dataBase64.length / 4 * 3 - (record.input.dataBase64.endsWith('==') ? 2 : record.input.dataBase64.endsWith('=') ? 1 : 0))))
    throw new Error('PDF 接收身份或内容不一致，已保留原请求，请核对原服务。')
  // "received" confirms retained bytes, but inspection still needs the original request to resume.
  if (document.state !== 'received') await records.change(record.key, saved => ({ ...(saved ?? record), document }))
  return document
}
