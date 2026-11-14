import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AgentEmptyState, ChatComposerDock, PromptInput, type PromptAttachment, Markdown } from '@xunjie/ui/chat'
import { Button, SelectField } from '@xunjie/ui/foundation'
import type { AgentSession } from '@xunjie/contracts/agent-sessions'
import type { SpaceIdentity } from '@xunjie/contracts/spaces'
import type { ModelSelectionController } from './ModelSelection'
import { useAgentModelPicker, AgentModelFeedback } from './AgentModelPicker'
import { AgentSessionsClient, SessionOutbox } from './agent-sessions'
import { useAgentSession, sessionError } from './useAgentSession'
import { SessionConversation } from './SessionConversation'
import { protectSessionUpload, deliverSessionUpload, sessionUploads, readSessionMaterial, type SessionMaterialUpload } from './session-materials'
import { useViewPolling } from './useViewPolling'
import { useSessionDraft, protectSessionDraft } from './session-drafts'
import './product-agent.css'

export function ProductAgent({ identity, spaceKey, namespace, sessionId, session: directorySession, onSession, onWorkspace, onWorkspaceCreated,
  onSettings, selection, readOnly, viewActive = true }: {
  identity: SpaceIdentity; spaceKey: string; namespace: string; sessionId?: string; session?: AgentSession
  onSession(session: AgentSession): void; onWorkspace(activityId: string): void; onWorkspaceCreated(): void
  onSettings(): void; selection: ModelSelectionController; readOnly: boolean; viewActive?: boolean
}) {
  const scope = JSON.stringify([namespace, spaceKey, identity.environmentId, identity.spaceId, identity.principalId])
  const client = useMemo(() => new AgentSessionsClient({ identity, spaceKey, namespace }), [scope])
  const outbox = useMemo(() => new SessionOutbox(client), [client])
  const [metadata, setMetadata] = useState<AgentSession | null>(null), [uploads, setUploads] = useState<SessionMaterialUpload[]>([])
  const ownMetadata = directorySession?.sessionId === sessionId ? directorySession : metadata?.sessionId === sessionId ? metadata : null
  const writable = !readOnly && (!sessionId || !!ownMetadata && !ownMetadata.archived && !ownMetadata.deleted)
  const controller = useAgentSession(client, sessionId, writable, viewActive)
  const anchor = useRef<HTMLDivElement>(null), scroll = useRef<HTMLDivElement>(null), following = useRef(true)
  const picker = useAgentModelPicker(selection)
  const draftKey = 'xj.agent-draft.' + scope + '.' + (sessionId ?? 'new')
  const composer = useSessionDraft(client.scope, sessionId, 'composer', { text: '', editing: true, expectedVersion: 1 }, draftKey)
  const text = composer.value.text
  const [mode, setMode] = useState<'steering' | 'queue'>('steering'), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [excluded, setExcluded] = useState<string[]>([]), [reading, setReading] = useState<{ name: string; text: string; images: string[]; record: SessionMaterialUpload; page: number; pageCount: number } | null>(null)
  const [pending, setPending] = useState(() => outbox.start())
  const viewKey = scope + ':' + sessionId
  const route = useRef(viewKey); route.current = viewKey
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    let live = true
    setReading(null); setUploads([]); setExcluded([]); setMetadata(null); setBusy(false); setError(''); setPending(outbox.start())
    if (sessionId) {
      void client.read(sessionId).then(value => { if (live) setMetadata(value) }).catch(cause => { if (live) setError(sessionError(cause)) })
    }
    return () => { live = false }
  }, [draftKey, client, sessionId])
  useViewPolling(async () => {
    if (!sessionId) return
    try { const items = await sessionUploads(client, sessionId); if (alive.current && route.current === viewKey) setUploads(items) }
    catch (cause) { if (alive.current && route.current === viewKey) setError(sessionError(cause)) }
  }, viewKey + ':materials', 10000, !!sessionId && viewActive)
  useEffect(() => { if (directorySession && directorySession.sessionId === sessionId) setMetadata(directorySession) }, [directorySession, sessionId])
  const completeStart = useCallback(async () => {
    setBusy(true)
    try {
      const original = outbox.start()
      const value = await outbox.deliverStart(); if (alive.current && route.current === viewKey) setPending(null)
      if (alive.current && route.current === viewKey && !sessionId) {
        const nextDraft = composer.latest()
        const retained = nextDraft.text && nextDraft.text !== original?.input.text
          ? protectSessionDraft(client.scope, value.session.sessionId, 'composer', nextDraft) : Promise.resolve()
        const cleared = original ? composer.clearIfMatches(original.input.text) : Promise.resolve()
        onSession(value.session)
        await Promise.all([retained, cleared])
      }
    } catch (cause) { if (alive.current && route.current === viewKey) setError(sessionError(cause)) }
    finally { if (alive.current && route.current === viewKey) setBusy(false) }
  }, [outbox, draftKey, onSession])
  useEffect(() => { if (pending && !sessionId && !readOnly && composer.ready) void completeStart() }, [client, composer.ready])
  useEffect(() => { if (following.current) scroll.current?.scrollTo?.({ top: scroll.current.scrollHeight }) }, [controller.conversation])
  async function ensureSession() {
    if (sessionId) return sessionId
    const key = 'xj.agent-material-session.' + scope
    const raw = localStorage.getItem(key), input = raw ? JSON.parse(raw) : { requestId: crypto.randomUUID(), sessionId: crypto.randomUUID(), scenario: 'student-assistant' }
    localStorage.setItem(key, JSON.stringify(input))
    let value: AgentSession
    try { value = await client.read(input.sessionId) } catch (cause) { if ((cause as { code?: string }).code !== 'missing') throw cause; value = await client.create(input) }
    if (value.state !== 'ready') value = await client.create(input)
    return value.sessionId
  }
  const addFiles = async (files: File[]) => {
    if (!writable || busy) return
    setBusy(true); setError('')
    try {
      const id = await ensureSession()
      const records: SessionMaterialUpload[] = []
      for (const file of files) {
        const record = await protectSessionUpload(client, id, file); records.push(record)
        if (alive.current && route.current === viewKey) setUploads(items => [...items.filter(item => item.key !== record.key), record])
      }
      if (!sessionId && alive.current && route.current === viewKey) onSession(await client.read(id))
      localStorage.removeItem('xj.agent-material-session.' + scope)
      for (const record of records) await deliverSessionUpload(client, id, record)
      const items = await sessionUploads(client, id)
      if (alive.current && route.current === viewKey) setUploads(items)
    } catch (cause) { if (alive.current && route.current === viewKey) setError(sessionError(cause)) }
    finally { if (alive.current && route.current === viewKey) setBusy(false) }
  }
  const send = async () => {
    if (!writable || busy || !text.trim() || picker.blocked || !composer.ready) return
    setError(''); setBusy(true)
    try {
      await composer.protect()
      const context = { materials: uploads.filter(item => !excluded.includes(item.key)).map(item => ({ kind: item.kind === 'pdf' ? 'pdf' : 'personal-material',
        scope: { kind: 'session', sessionId }, objectId: item.input.documentId ?? item.input.materialId, requestId: item.input.requestId })) }
      if (!sessionId) { const value = outbox.begin(text); setPending(value); await completeStart() }
      else {
        await controller.send(text, mode, JSON.parse(JSON.stringify(context)))
        await composer.clearIfMatches(text)
      }
    } catch (cause) { if (alive.current && route.current === viewKey) setError(sessionError(cause)) }
    finally { if (alive.current && route.current === viewKey) setBusy(false) }
  }
  async function openMaterial(record: SessionMaterialUpload, page = 1) {
    if (!sessionId) return
    setBusy(true)
    try { const value = await readSessionMaterial(client, sessionId, record, page)
      if (alive.current && route.current === viewKey) setReading({ ...value, record, name: record.input.name })
    } catch (cause) { if (alive.current && route.current === viewKey) setError(sessionError(cause)) }
    finally { if (alive.current && route.current === viewKey) setBusy(false) }
  }
  const attachments: PromptAttachment[] = uploads.filter(item => !excluded.includes(item.key)).map(item => ({ id: item.key, name: item.input.name,
    size: (item.remote && ('byteLength' in item.remote ? item.remote.byteLength : item.remote.versions.find(version => version.version === ('currentVersion' in item.remote! ? item.remote.currentVersion : 0))?.byteLength)) ?? Math.floor(item.input.dataBase64.length * 3 / 4), kind: 'document', ...(item.confirmed ? {} : { progress: 50 }) }))
  return <div className="agent-layout product-agent">
    {ownMetadata && <header className="product-conversation-head"><h1>{ownMetadata.title ?? '新对话'}</h1>{ownMetadata.archived && <span>已归档</span>}</header>}
    <div className={sessionId ? 'product-conversation-scroll' : 'product-agent-body'} ref={scroll} onScroll={() => {
      const node = scroll.current; if (node) following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80
    }}>
      {sessionId ? <div className="product-conversation-inner"><SessionConversation controller={controller} readOnly={!writable}
        onOpenWorkspace={onWorkspace} onWorkspaceCreated={onWorkspaceCreated} /></div> : <AgentEmptyState title="今天想探讨什么？" />}
      {reading && <section className="product-conversation-inner session-material-reading"><h2>{reading.name}</h2>
        <Button variant="outline" onClick={() => setReading(null)}>返回对话</Button><Markdown text={reading.text} />
        {reading.pageCount > 1 && <nav aria-label="PDF 翻页"><Button variant="outline" disabled={busy || reading.page === 1} onClick={() => void openMaterial(reading.record, reading.page - 1)}>上一页</Button><span>{reading.page} / {reading.pageCount}</span><Button variant="outline" disabled={busy || reading.page === reading.pageCount} onClick={() => void openMaterial(reading.record, reading.page + 1)}>下一页</Button></nav>}
        {reading.images.map((src, index) => <img key={index} src={src} alt={`${reading.name} 第 ${reading.page + index} 页`} />)}</section>}
    </div>
    <div className="product-agent-notices">
      {pending && <p role="status">原问题已保留。<Button variant="outline" disabled={busy} onClick={() => void completeStart()}>核对并继续原请求</Button></p>}
      {composer.error && <p role="alert">{composer.error} <button type="button" onClick={() => void composer.protect().catch(() => {})}>重试保留输入</button></p>}
      {error && <p role="alert">{error}</p>}
      {!picker.models.length && !readOnly && !selection.stale && <p>尚未配置模型。<button type="button" className="product-agent-settings-link" onClick={onSettings}>打开设置</button></p>}
      {!writable && <p role="status">{ownMetadata?.archived ? '这段对话已归档，恢复后可以继续。' : '当前会话只读。'}</p>}
      {sessionId && uploads.length > 0 && <details><summary>会话资料</summary>{uploads.map(item => <div key={item.key}>
        <button type="button" disabled={busy} onClick={() => void openMaterial(item)}>{item.input.name}</button>
        {!item.confirmed && <button type="button" disabled={busy} onClick={() => { setBusy(true); void deliverSessionUpload(client, sessionId, item).then(() => sessionUploads(client, sessionId)).then(setUploads).catch(cause => setError(sessionError(cause))).finally(() => setBusy(false)) }}>继续上传</button>}
      </div>)}</details>}
      <SelectField label="发送方式" value={mode} disabled={!writable || busy} onChange={value => setMode(value as 'steering' | 'queue')}
        options={[{ value: 'steering', label: '引导当前回答' }, { value: 'queue', label: '排队处理' }]} />
    </div>
    <ChatComposerDock anchorRef={anchor} atBottom suggestions={{ items: [], show: false, onPick: () => {} }} followUps={{ items: [], show: false, onPick: () => {}, label: '' }}
      onBackToBottom={() => { following.current = true; scroll.current?.scrollTo?.({ top: scroll.current.scrollHeight }) }}
      input={<PromptInput value={text} onChange={value => { void composer.change({ ...composer.value, text: value }).catch(() => {}) }} autoFocus
        onSend={send} canSend={composer.ready && !!text.trim() && !busy && !pending && writable && !picker.blocked && !uploads.some(item => !item.confirmed)}
        submitting={busy || !writable} busy={controller.active} onStop={() => { const run = controller.conversation?.runs.find(run => !run.stopRequested && ['received', 'running', 'waiting'].includes(run.state)); if (run) void controller.control(run.runId, 'stop').catch(() => {}) }}
        attachments={attachments} onAddFiles={addFiles} onRemoveAttachment={id => setExcluded(items => [...items, id])} attachmentTitle="添加会话资料" accept=".pdf,.txt,.md,.markdown"
        model={picker.model} models={picker.models} modelDisabled={busy || !writable || picker.busy || picker.stale || !picker.models.length} onModelChange={picker.change}
        effort="" efforts={[]} onEffortChange={() => {}} showEffort={false} contextIndicator={<AgentModelFeedback controller={picker} />} />}
      disclaimer="对话自动保存在本机" />
  </div>
}
