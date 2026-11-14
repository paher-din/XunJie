// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { AgentSessionsClient } from './agent-sessions'
import { sessionUploads, readSessionMaterial, protectSessionUpload, deliverSessionUpload } from './session-materials'
const id = () => crypto.randomUUID()
const identity = { kind: 'personal' as const, environmentId: id(), spaceId: id(), principalId: id(), name: '个人' }
let client: AgentSessionsClient
beforeEach(() => { localStorage.clear(); client = new AgentSessionsClient({ identity, namespace: id(), spaceKey: 'personal' }) })
afterEach(() => vi.unstubAllGlobals())
it('lists server session PDFs without local upload bytes and reads the selected page without uploading again', async () => {
  const sessionId = id(), documentId = id(), requestId = id(), posts: any[] = []
  const document = { documentId, requestId, scope: { kind: 'session', sessionId }, name: '课程.pdf', sha256: 'a'.repeat(64), byteLength: 300, state: 'ready', pageCount: 4, pageLabels: ['1', '2', '3', '4'] }
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit = {}) => {
    const value = options.body ? JSON.parse(String(options.body)) : undefined
    if (value) posts.push({ url, value })
    const result = url.endsWith('/materials') ? [] : url.endsWith('/pdf') ? [document] : url.endsWith('/pdf/read') ? {
      readingId: id(), documentId, scope: document.scope, documentSha256: document.sha256, documentName: document.name,
      coordinates: 'rotated-cropbox-top-left-normalized', requestedPages: value.pages, region: null,
      pages: value.pages.map((page: number) => ({ page, label: String(page), state: 'ready', text: '第 ' + page + ' 页', textOrigin: 'native', ocr: 'not-performed', image: null, transform: { rotation: 0, cropBox: [], region: null, scale: 1, engine: 'pdf' } }))
    } : null
    return new Response(JSON.stringify(result))
  }))
  const uploads = await sessionUploads(client, sessionId)
  expect(uploads.map(item => item.input.name)).toEqual(['课程.pdf'])
  const reading = await readSessionMaterial(client, sessionId, uploads[0]!, 3)
  expect(reading.text).toBe('第 3 页'); expect(reading.pageCount).toBe(4)
  expect(posts).toHaveLength(1); expect(posts[0].value.pages).toEqual([3])
  await expect(readSessionMaterial(client, id(), uploads[0]!)).rejects.toThrow('当前会话')
})
it('an upload with a lost reply is recovered by its original document identity without sending the bytes twice', async () => {
  const sessionId = id(), file = new File(['pdf bytes'], '笔记.pdf', { type: 'application/pdf' })
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode('pdf bytes').buffer })
  let document: any, writes = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit = {}) => {
    if (options.body) {
      writes++; const body = JSON.parse(String(options.body))
      document = { documentId: body.documentId, requestId: body.requestId, scope: { kind: 'session', sessionId }, name: body.name, sha256: 'a'.repeat(64), byteLength: 9, state: 'ready', pageCount: 1, pageLabels: ['1'] }
      throw new Error('lost ACK')
    }
    expect(url).toContain('/pdf/documents/')
    return new Response(JSON.stringify(document ?? { error: 'missing' }), { status: document ? 200 : 404 })
  }))
  const protectedUpload = await protectSessionUpload(client, sessionId, file)
  await expect(deliverSessionUpload(client, sessionId, protectedUpload)).rejects.toThrow('lost ACK')
  expect((await deliverSessionUpload(client, sessionId, protectedUpload)).requestId).toBe(protectedUpload.input.requestId)
  expect(writes).toBe(1)
})
