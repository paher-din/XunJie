import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AgentEmptyState, ChatViewport, Markdown } from '@xunjie/ui/chat'
import { Button } from '@xunjie/ui/foundation'
import type { AgentSession } from '@xunjie/contracts/agent-sessions'
import type { SpaceIdentity } from '@xunjie/contracts/spaces'
import { agentInputReceiptSchema } from '@xunjie/contracts/agent-runtime'
import type { ModelSelectionController } from './ModelSelection'
import { useAgentModelPicker } from './AgentModelPicker'
import { AgentSessionsClient, SessionOutbox } from './agent-sessions'
import { useAgentSession, sessionError } from './useAgentSession'
import { SessionConversation } from './SessionConversation'
import { protectSessionUpload, deliverSessionUpload, sessionUploads, readSessionMaterial, type SessionMaterialUpload } from './session-materials'
import { useViewPolling } from './useViewPolling'
import { useSessionDraft, protectSessionDraft } from './session-drafts'
import { MODEL_MESSAGE_IMAGE_LIMIT, modelMessageImagesSchema, type ModelMessageImage } from '@xunjie/contracts/model-connections'
import { IMAGE_MODEL_HINT, isAgentImage, uploadAgentImage, useAgentImagePreviews, type AgentImageSource } from '../reliable-workspace/agent-images'
import { learningSubjectRequest } from './learningTransport'
import { ProductPromptInput, ProductComposerDock } from './ProductPromptInput'
import { sessionComposerActions } from './session-composer'
import { useSessionDraftSkills, sessionDraftSkillsKey, sessionSkillResetKey, consumeSessionSkillSelection } from './session-draft-skills'
import { sessionSkillStateSchema } from '@xunjie/contracts/agent-skills'
import { useConversationScroll } from './conversation-scroll'
import { SessionQuestionBox } from './SessionQuestion'
import './product-agent.css'
import './conversation-empty-state.css'

const imageDraftKey = (scope: string, sessionId: string) => 'xj.agent-image-draft.' + JSON.stringify([scope, sessionId])
function readImageDraft(scope: string, sessionId?: string): ModelMessageImage[] {
  if (!sessionId) return []
  try { return modelMessageImagesSchema.parse(JSON.parse(localStorage.getItem(imageDraftKey(scope, sessionId)) ?? '[]')) }
  catch { return [] }
}
function writeImageDraft(scope: string, sessionId: string, images: ModelMessageImage[]) {
  const key = imageDraftKey(scope, sessionId)
  if (images.length) localStorage.setItem(key, JSON.stringify(images))
  else localStorage.removeItem(key)
}

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
  const [imageDraft, setImageDraft] = useState(() => ({ sessionId, images: readImageDraft(client.scope, sessionId) }))
  const images = imageDraft.sessionId === sessionId ? imageDraft.images : []
  const imagePreviews = useAgentImagePreviews(client.scope, images)
  const ownMetadata = directorySession?.sessionId === sessionId ? directorySession : metadata?.sessionId === sessionId ? metadata : null
  const writable = !readOnly && (!sessionId || !!ownMetadata && !ownMetadata.archived && !ownMetadata.deleted)
  const controller = useAgentSession(client, sessionId, writable, viewActive)
  const { scroller: scroll, atBottom, onScroll, onJump, backToBottom } = useConversationScroll()
  const picker = useAgentModelPicker(selection)
  const needsImageModel = images.length > 0 && !picker.supportsImages
  const skills = useSessionDraftSkills(identity, spaceKey, namespace, sessionId)
  const controls = sessionComposerActions(controller, !writable)
  const pendingQuestion = controller.conversation?.questions.find(question => question.state === 'pending')
  const selectSkills = useCallback(async (id: string, input: { requestId: string; context: Record<string, unknown> }) => {
    if (!Array.isArray(input.context.skills) || input.context.skills.length === 0) return
    sessionSkillStateSchema.parse(await client.request(id + '/skills/select', { requestId: input.requestId, skills: input.context.skills }))
  }, [client])
  const clearSkills = useCallback(async (id: string, input: { requestId: string }) => {
    sessionSkillStateSchema.parse(await client.request(id + '/skills/select', { requestId: input.requestId, skills: [] }))
  }, [client])
  const draftKey = 'xj.agent-draft.' + scope + '.' + (sessionId ?? 'new')
  const composer = useSessionDraft(client.scope, sessionId, 'composer', { text: '', editing: true, expectedVersion: 1 }, draftKey)
  const text = composer.value.text
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [excluded, setExcluded] = useState<string[]>([]), [reading, setReading] = useState<{ name: string; text: string; images: string[]; record: SessionMaterialUpload; page: number; pageCount: number } | null>(null)
  const [pending, setPending] = useState(() => outbox.start())
  const viewKey = scope + ':' + sessionId
  const route = useRef(viewKey); route.current = viewKey
  const alive = useRef(true)
  const attaching = useRef(false)
  const resettingSkills = useRef<string | null>(null)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    let live = true
    setReading(null); setUploads([]); setExcluded([]); setMetadata(null); setBusy(false); setError(''); setPending(outbox.start())
    setImageDraft({ sessionId, images: readImageDraft(client.scope, sessionId) })
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
  useEffect(() => {
    if (!sessionId) return
    const key = sessionSkillResetKey(client.scope, sessionId), raw = localStorage.getItem(key)
    if (!raw) return
    let pending: { requestId: string; turnId: string }
    try {
      const value = JSON.parse(raw) as { requestId?: unknown; turnId?: unknown }
      if (typeof value.requestId !== 'string' || typeof value.turnId !== 'string') throw new Error('invalid')
      pending = { requestId: value.requestId, turnId: value.turnId }
    } catch {
      localStorage.removeItem(key)
      return
    }
    const turn = controller.conversation?.turns.find(item => item.turnId === pending.turnId)
    if (!turn || turn.state === 'active' || resettingSkills.current === raw) return
    resettingSkills.current = raw
    void clearSkills(sessionId, { requestId: pending.requestId }).then(() => {
      if (localStorage.getItem(key) === raw) localStorage.removeItem(key)
      skills.reload()
    }).catch(cause => {
      if (alive.current && route.current === viewKey) setError(sessionError(cause))
    }).finally(() => {
      if (resettingSkills.current === raw) resettingSkills.current = null
    })
  }, [sessionId, controller.conversation?.turns, client.scope, clearSkills, skills.reload, viewKey])
  useEffect(() => { if (directorySession && directorySession.sessionId === sessionId) setMetadata(directorySession) }, [directorySession, sessionId])
  useEffect(() => {
    if (!sessionId || !controller.conversation || !images.length) return
    const sent = new Set(controller.conversation.inputs.flatMap(input => (input.images ?? []).map(image => image.imageId)))
    if (!images.some(image => sent.has(image.imageId))) return
    const remaining = readImageDraft(client.scope, sessionId).filter(image => !sent.has(image.imageId))
    writeImageDraft(client.scope, sessionId, remaining)
    setImageDraft({ sessionId, images: remaining })
  }, [client, sessionId, controller.conversation, images])
  const completeStart = useCallback(async () => {
    setBusy(true)
    try {
      const original = outbox.start()
      const value = await outbox.deliverStart(undefined, (session, input) => selectSkills(session.sessionId, input)); if (alive.current && route.current === viewKey) setPending(null)
      if (alive.current && route.current === viewKey && !sessionId) {
        if (Array.isArray(original?.input.context.skills) && original.input.context.skills.length) {
          consumeSessionSkillSelection({ identity, spaceKey, namespace, nextSessionId: value.session.sessionId,
            clientScope: client.scope, turnId: value.receipt.turnId })
          skills.choose([])
        }
        const nextDraft = composer.latest()
        const retained = nextDraft.text && nextDraft.text !== original?.input.text
          ? protectSessionDraft(client.scope, value.session.sessionId, 'composer', nextDraft) : Promise.resolve()
        const cleared = original ? composer.clearIfMatches(original.input.text) : Promise.resolve()
        onSession(value.session)
        await Promise.all([retained, cleared])
      }
    } catch (cause) {
      if (alive.current && route.current === viewKey) setError(sessionError(cause))
      skills.restoreVisible?.()
    } finally { if (alive.current && route.current === viewKey) setBusy(false) }
  }, [outbox, draftKey, onSession, identity, spaceKey, namespace, client.scope, skills.choose])
  useEffect(() => { if (pending && !sessionId && !readOnly && composer.ready) void completeStart() }, [client, composer.ready])
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
  const addFiles = async (files: AgentImageSource[]) => {
    if (!writable || busy || attaching.current || !files.length || !composer.ready) return
    const imageFiles = files.filter(file => 'dataBase64' in file || isAgentImage(file))
    if (images.length + imageFiles.length > MODEL_MESSAGE_IMAGE_LIMIT) {
      setError(`每条消息最多附带 ${MODEL_MESSAGE_IMAGE_LIMIT} 张图片。`); return
    }
    attaching.current = true
    setBusy(true); setError('')
    try {
      const id = await ensureSession()
      const records: SessionMaterialUpload[] = []
      const draftImages = readImageDraft(client.scope, id)
      for (const file of imageFiles) {
        const image = await uploadAgentImage(client.scope, { kind: 'session', sessionId: id }, file,
          body => learningSubjectRequest(identity, spaceKey, namespace, 'models/images', body))
        if (draftImages.some(item => item.sha256 === image.sha256 && item.name === image.name)) continue
        draftImages.push(image)
        writeImageDraft(client.scope, id, draftImages)
        if (alive.current && route.current === viewKey && sessionId) setImageDraft({ sessionId, images: [...draftImages] })
      }
      for (const file of files.filter((file): file is File => !('dataBase64' in file) && !isAgentImage(file))) {
        const record = await protectSessionUpload(client, id, file); records.push(record)
        if (alive.current && route.current === viewKey) setUploads(items => [...items.filter(item => item.key !== record.key), record])
      }
      if (!sessionId && alive.current && route.current === viewKey) {
        const retained = composer.latest()
        await protectSessionDraft(client.scope, id, 'composer', retained)
        localStorage.setItem(sessionDraftSkillsKey(identity, spaceKey, namespace, id), JSON.stringify(skills.selected))
        await composer.clearIfMatches(retained.text)
        onSession(await client.read(id))
      }
      localStorage.removeItem('xj.agent-material-session.' + scope)
      for (const record of records) await deliverSessionUpload(client, id, record)
      const items = await sessionUploads(client, id)
      if (alive.current && route.current === viewKey) setUploads(items)
    } catch (cause) { if (alive.current && route.current === viewKey)
      setError(cause instanceof Error && !('code' in cause) ? cause.message : sessionError(cause)) }
    finally { attaching.current = false; if (alive.current && route.current === viewKey) setBusy(false) }
  }
  const send = async () => {
    if (!writable || busy || attaching.current || !text.trim() || picker.blocked || needsImageModel || !composer.ready) return
    setError(''); setBusy(true)
    const selectedSkills = [...skills.selected]
    if (selectedSkills.length) skills.consumeVisible?.()
    try {
      await composer.protect()
      const context = { skills: selectedSkills, ...(images.length ? { messageImages: images } : {}), materials: uploads.filter(item => !excluded.includes(item.key)).map(item => ({ kind: item.kind === 'pdf' ? 'pdf' : 'personal-material',
        scope: { kind: 'session', sessionId }, objectId: item.input.documentId ?? item.input.materialId, requestId: item.input.requestId })) }
      if (!sessionId) { const value = outbox.begin(text, JSON.parse(JSON.stringify(context))); setPending(value); await completeStart() }
      else {
        // Select fixed capabilities before delivery, with a protected request identity for retries.
        const selectionKey = 'xj.session-skill-selection.' + client.scope + ':' + sessionId
        const raw = localStorage.getItem(selectionKey)
        const choice = raw ? JSON.parse(raw) : { requestId: crypto.randomUUID(), context: { skills: selectedSkills } }
        localStorage.setItem(selectionKey, JSON.stringify(choice))
        await selectSkills(sessionId, choice)
        localStorage.removeItem(selectionKey)
        const receipt = agentInputReceiptSchema.parse(await controller.send(text, JSON.parse(JSON.stringify(context))))
        if (selectedSkills.length) {
          consumeSessionSkillSelection({ identity, spaceKey, namespace, currentSessionId: sessionId, nextSessionId: sessionId,
            clientScope: client.scope, turnId: receipt.turnId })
          skills.choose([])
        }
        if (images.length) {
          const sent = new Set(images.map(image => image.imageId))
          const remaining = readImageDraft(client.scope, sessionId).filter(image => !sent.has(image.imageId))
          writeImageDraft(client.scope, sessionId, remaining)
          if (alive.current && route.current === viewKey) setImageDraft({ sessionId, images: remaining })
        }
        await composer.clearIfMatches(text)
      }
    } catch (cause) {
      skills.restoreVisible?.()
      if (alive.current && route.current === viewKey) setError(sessionError(cause))
    }
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
  const activeUploads = uploads.filter(item => !excluded.includes(item.key))
  const files = { items: [
    ...activeUploads.map(item => ({ id: item.key, name: item.input.name,
      size: (item.remote && ('byteLength' in item.remote ? item.remote.byteLength : item.remote.versions.find(version => version.version === ('currentVersion' in item.remote! ? item.remote.currentVersion : 0))?.byteLength)) ?? Math.floor(item.input.dataBase64.length * 3 / 4),
      ...(!item.confirmed ? { progress: 50 } : {}) })),
    ...images.map(image => ({ id: image.imageId, name: image.name, attachmentKind: 'image' as const, src: imagePreviews[image.imageId] })),
  ], busy: busy || activeUploads.some(item => !item.confirmed), error: '',
  add: addFiles, remove: (id: string) => {
    if (sessionId && images.some(image => image.imageId === id)) {
      const remaining = readImageDraft(client.scope, sessionId).filter(image => image.imageId !== id)
      writeImageDraft(client.scope, sessionId, remaining)
      setImageDraft({ sessionId, images: remaining })
    } else setExcluded(items => [...items, id])
  } }
  const hasDraft = !!text.trim() || files.items.length > 0
  return <div className="agent-layout product-conversation product-agent">
    {ownMetadata && <header className="product-conversation-head"><h1>{ownMetadata.title ?? '新对话'}</h1>{ownMetadata.archived && <span>已归档</span>}</header>}
    {sessionId ? <ChatViewport scrollerRef={scroll} onScroll={onScroll} onJump={onJump} phase={controller.active ? 'streaming' : undefined}
      busy={controller.active} padSuggestions={false} queued={false}>
      <SessionConversation controller={controller} readOnly={!writable} onOpenWorkspace={onWorkspace} onWorkspaceCreated={onWorkspaceCreated} />
      {reading && <section className="product-conversation-inner session-material-reading"><h2>{reading.name}</h2>
        <Button variant="outline" onClick={() => setReading(null)}>返回对话</Button><Markdown text={reading.text} />
        {!!reading.images.length && <Button variant="outline" disabled={busy || !writable} onClick={() => void addFiles(reading.images.map((src, index) => ({
          name: `${reading.name.slice(0, 200)} · 第 ${reading.page + index} 页`, dataBase64: src.slice('data:image/png;base64,'.length),
        })))}>将此页添加为图片</Button>}
        {reading.pageCount > 1 && <nav aria-label="PDF 翻页"><Button variant="outline" disabled={busy || reading.page === 1} onClick={() => void openMaterial(reading.record, reading.page - 1)}>上一页</Button><span>{reading.page} / {reading.pageCount}</span><Button variant="outline" disabled={busy || reading.page === reading.pageCount} onClick={() => void openMaterial(reading.record, reading.page + 1)}>下一页</Button></nav>}
        {reading.images.map((src, index) => <img key={index} src={src} alt={`${reading.name} 第 ${reading.page + index} 页`} />)}</section>}
    </ChatViewport> : <div className="product-agent-body"><AgentEmptyState title="今天想探讨什么？" /></div>}
    <div className="product-agent-notices">
      {pending && <p role="status">原问题已保留。<Button variant="outline" disabled={busy} onClick={() => void completeStart()}>核对并继续原请求</Button></p>}
      {composer.error && <p role="alert">{composer.error} <button type="button" onClick={() => void composer.protect().catch(() => {})}>重试保留输入</button></p>}
      {error && <p role="alert">{error}</p>}
      {needsImageModel && <p role="status">{IMAGE_MODEL_HINT}</p>}
      {!picker.models.length && !readOnly && !selection.stale && <p>尚未配置模型。<button type="button" className="product-agent-settings-link" onClick={onSettings}>打开设置</button></p>}
      {!writable && <p role="status">{ownMetadata?.archived ? '这段对话已归档，恢复后可以继续。' : '当前会话只读。'}</p>}
      {sessionId && uploads.length > 0 && <details><summary>会话资料</summary>{uploads.map(item => <div key={item.key}>
        <button type="button" disabled={busy} onClick={() => void openMaterial(item)}>{item.input.name}</button>
        {!item.confirmed && <button type="button" disabled={busy} onClick={() => { setBusy(true); void deliverSessionUpload(client, sessionId, item).then(() => sessionUploads(client, sessionId)).then(setUploads).catch(cause => setError(sessionError(cause))).finally(() => setBusy(false)) }}>继续上传</button>}
      </div>)}</details>}

    </div>
    <ProductComposerDock atBottom={atBottom} onBackToBottom={backToBottom}>
      {pendingQuestion ? <SessionQuestionBox key={pendingQuestion.questionId + ':' + pendingQuestion.version}
        question={pendingQuestion} controller={controller} readOnly={!writable} />
        : <ProductPromptInput value={text} onChange={value => { void composer.change({ ...composer.value, text: value }).catch(() => {}) }} autoFocus
        onSend={send} canSend={composer.ready && !!text.trim() && !busy && !pending && writable && !picker.blocked && !needsImageModel && !uploads.some(item => !excluded.includes(item.key) && !item.confirmed)}
        submitting={busy || !writable} busy={controls.active && !hasDraft} onStop={controls.stop}
        onResume={controls.canResume && !hasDraft ? controls.resume : undefined} actionDisabled={controls.disabled} resumeLabel="继续生成"
        files={files} pasteImages
        skills={skills} selection={selection} readOnly={!writable} onModelSettings={onSettings} contextUsage={controller.conversation?.contextUsage} />}
    </ProductComposerDock>
  </div>
}
