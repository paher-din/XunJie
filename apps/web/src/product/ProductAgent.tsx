import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type UIEvent } from 'react'
import { AgentEmptyState, ChatViewport, Markdown, UserMessage } from '@xunjie/ui/chat'
import { Button } from '@xunjie/ui/foundation'
import { toast } from '@xunjie/ui/feedback'
import { teacherChatInputContextSchema } from '@xunjie/contracts/teacher-agent'
import type { AgentSession } from '@xunjie/contracts/agent-sessions'
import type { SpaceIdentity } from '@xunjie/contracts/spaces'
import { agentInputReceiptSchema, type AgentInput } from '@xunjie/contracts/agent-runtime'
import type { ModelSelectionController } from './ModelSelection'
import { useAgentModelPicker } from './AgentModelPicker'
import { AgentSessionRequestError, AgentSessionsClient, SessionOutbox } from './agent-sessions'
import { teacherConversationCache } from './agent-conversation-cache'
import { useAgentSession, sessionError } from './useAgentSession'
import { SessionConversation } from './SessionConversation'
import { ConversationSkeleton } from './ConversationSkeleton'
import { toolResultData } from './workspace-conversation'
import { protectSessionUpload, deliverSessionUpload, sessionUploads, readSessionMaterial, type SessionMaterialUpload } from './session-materials'
import { useViewPolling } from './useViewPolling'
import { useSessionDraft, protectSessionDraft, type TeacherDraftTarget } from './session-drafts'
import { MODEL_MESSAGE_IMAGE_LIMIT, modelMessageImagesSchema, type ModelMessageImage } from '@xunjie/contracts/model-connections'
import { IMAGE_MODEL_HINT, isAgentImage, uploadAgentImage, useAgentImagePreviews, type AgentImageSource } from '../reliable-workspace/agent-images'
import { learningSubjectRequest } from './learningTransport'
import { ProductPromptInput, ProductComposerDock } from './ProductPromptInput'
import { sessionComposerActions } from './session-composer'
import { useSessionDraftSkills, sessionDraftSkillsKey, sessionSkillResetKey, consumeSessionSkillSelection } from './session-draft-skills'
import { sessionSkillStateSchema } from '@xunjie/contracts/agent-skills'
import { useConversationScroll, type ConversationScrollPosition } from './conversation-scroll'
import { SessionQuestionBox } from './SessionQuestion'
import './product-agent.css'
import './conversation-empty-state.css'
import type { CitationRecord } from '@xunjie/ui/chat'
import { parseExperimentReference, type ExperimentReference } from './experiment-reference'
import { coursePdfCitationSourceSchema, learningReferenceSchema } from '@xunjie/contracts/student-learning'
import type { z } from 'zod'

export interface CourseCitationLocation {
  releaseId: string; materialId: string; materialSha256: string
  sourceId?: string; identity?: Pick<SpaceIdentity, 'environmentId' | 'spaceId' | 'principalId' | 'kind'>
  contentDigest?: string; from?: number; to?: number; page?: number
  pdfReading?: z.infer<typeof coursePdfCitationSourceSchema>
}

export type CourseCitationDocument = { name: string; text: string } | { name: string; pdf: Blob; page: number }

function CoursePdfOriginal({ pdf, page }: { pdf: Blob; page: number }) {
  const [url, setUrl] = useState('')
  useEffect(() => {
    const original = URL.createObjectURL(pdf)
    setUrl(original)
    return () => URL.revokeObjectURL(original)
  }, [pdf])
  return url ? <a href={url + '#page=' + page} target="_blank" rel="noopener noreferrer">打开 PDF 第 {page} 页</a> : null
}

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

function teacherExcerpt(value: unknown) {
  return value && typeof value === 'object' && 'text' in value && typeof value.text === 'string' ? value.text : ''
}

export interface TeacherAgentSeed {
  text: string
  target?: TeacherDraftTarget
}

type PostedMessage = Pick<AgentInput, 'sessionId' | 'requestId' | 'text'> & { at: string; first: boolean; inputId?: string }

export function ProductAgent({ identity, spaceKey, namespace, sessionId, session: directorySession, onSession, onWorkspace, onWorkspaceCreated,
  onSettings, selection, readOnly, viewActive = true, onOpenCourseMaterial, teacher, directoryPending, directoryError, onRetryDirectory, onNewConversation, scrollMemory }: {
  identity: SpaceIdentity; spaceKey: string; namespace: string; sessionId?: string; session?: AgentSession
  onSession(session: AgentSession): void; onWorkspace?(activityId: string, source?: Record<string, unknown>): void; onWorkspaceCreated?(): void
  onSettings(): void; selection: ModelSelectionController; readOnly: boolean; viewActive?: boolean
  teacher?: { courseId: string; seed: TeacherAgentSeed | null; onSeedApplied(): void }
  directoryPending?: boolean; directoryError?: string; onRetryDirectory?(): void; onNewConversation?(): void
  /** 教师课程页签之间保留阅读位置；换课程时由父级换一个新的 ref。 */
  scrollMemory?: MutableRefObject<ConversationScrollPosition | null>
  onOpenCourseMaterial?: (source: CourseCitationLocation) => Promise<CourseCitationDocument>
}) {
  const scope = JSON.stringify([namespace, spaceKey, identity.environmentId, identity.spaceId, identity.principalId, ...(teacher ? [teacher.courseId] : [])])
  const client = useMemo(() => new AgentSessionsClient({ identity, spaceKey, namespace, teacherCourseId: teacher?.courseId }), [scope])
  const outbox = useMemo(() => new SessionOutbox(client), [client])
  const [metadata, setMetadata] = useState<AgentSession | null>(null), [uploads, setUploads] = useState<SessionMaterialUpload[]>([])
  const [imageDraft, setImageDraft] = useState(() => ({ sessionId, images: readImageDraft(client.scope, sessionId) }))
  const images = imageDraft.sessionId === sessionId ? imageDraft.images : []
  const imagePreviews = useAgentImagePreviews(client.scope, images)
  const ownMetadata = directorySession?.sessionId === sessionId ? directorySession : metadata?.sessionId === sessionId ? metadata : null
  const writable = !readOnly && (!sessionId || !!ownMetadata && !ownMetadata.archived && !ownMetadata.deleted)
  const { scroller: scroll, atBottom, onScroll, onJump, backToBottom, restore } = useConversationScroll()
  const sessionRef = useRef(sessionId); sessionRef.current = sessionId
  const rememberScroll = useCallback(() => {
    const element = scroll.current, id = sessionRef.current
    if (!scrollMemory || !id || !element) return
    scrollMemory.current = { sessionId: id, top: element.scrollTop,
      atBottom: element.scrollHeight - element.clientHeight - element.scrollTop < 64 }
  }, [scrollMemory, scroll])
  const handleScroll = (event: UIEvent<HTMLDivElement>) => { onScroll(event); rememberScroll() }
  useEffect(() => () => rememberScroll(), [rememberScroll])
  const picker = useAgentModelPicker(selection)
  const needsImageModel = images.length > 0 && !picker.supportsImages
  const skills = useSessionDraftSkills(identity, spaceKey, namespace, sessionId, teacher?.courseId)
  const selectSkills = useCallback(async (id: string, input: { requestId: string; context: Record<string, unknown> }) => {
    if (!Array.isArray(input.context.skills) || input.context.skills.length === 0) return
    sessionSkillStateSchema.parse(await client.request(id + '/skills/select', { requestId: input.requestId, skills: input.context.skills }))
  }, [client])
  const clearSkills = useCallback(async (id: string, input: { requestId: string }) => {
    sessionSkillStateSchema.parse(await client.request(id + '/skills/select', { requestId: input.requestId, skills: [] }))
  }, [client])
  const canUseModel = !teacher || !!selection.selection?.selected && !selection.stale
  const draftKey = 'xj.agent-draft.' + scope + '.' + (sessionId ?? 'new')
  const composer = useSessionDraft(client.scope, sessionId, 'composer', { text: '', editing: true, expectedVersion: 1 }, draftKey)
  const text = composer.value.text
  const clearTeacherDraft = async (input: Pick<AgentInput, 'text' | 'context'>) => {
    const current = composer.latest()
    const target = current.teacherTarget
    const skill = skills.selected[0]
    const context = teacherChatInputContextSchema.safeParse(input.context)
    if (!context.success || current.text !== input.text
      || target?.releaseId !== context.data.teacherTarget?.releaseId) return
    if (skill?.skillId === context.data.teacherSkill?.skillId && skill?.version === context.data.teacherSkill?.version)
      skills.choose([])
    await composer.clearIfMatches(input.text)
  }
  const controller = useAgentSession(client, sessionId, writable, viewActive,
    teacher ? { ready: composer.ready, delivered: clearTeacherDraft } : undefined,
    teacher ? teacherConversationCache : undefined)
  // 教师课程页签回来时恢复上次阅读位置；换课程没有记忆，落到底部。只在这段会话第一次可见时做一次。
  const restoredSession = useRef<string | null>(null)
  const settleTimers = useRef<number[]>([])
  useEffect(() => () => { for (const timer of settleTimers.current) window.clearTimeout(timer) }, [])
  useLayoutEffect(() => {
    if (!teacher || !sessionId || !controller.conversation) return
    if (restoredSession.current === sessionId) return
    restoredSession.current = sessionId
    const saved = scrollMemory?.current
    const position = saved?.sessionId === sessionId ? saved : null
    if (position && !position.atBottom) restore(position)
    else backToBottom()
    rememberScroll()
    // 消息落版会让高度在提交后再补足；开场直接补到底，别先露出半截再滑。只补底部，不碰用户选中的历史位置。
    if (!position || position.atBottom) {
      const settle = (delay: number) => {
        const timer = window.setTimeout(() => {
          if (restoredSession.current !== sessionId || scrollMemory?.current?.atBottom === false) return
          backToBottom(); rememberScroll()
        }, delay)
        settleTimers.current.push(timer)
      }
      settle(0); settle(120)
    }
  }, [teacher, sessionId, controller.conversation?.sessionId, scrollMemory, restore, backToBottom, rememberScroll])
  const controls = sessionComposerActions(controller, !writable)
  const pendingQuestion = controller.conversation?.questions.find(question => question.state === 'pending')
  const appliedSeed = useRef<TeacherAgentSeed | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const seed = teacher?.seed
    if (!composer.ready || !seed || appliedSeed.current === seed) return
    appliedSeed.current = seed
    if (directoryPending) onNewConversation?.()
    const draft = composer.latest()
    void composer.change({ ...draft, text: draft.text.trim() ? draft.text + '\n' + seed.text : seed.text, teacherTarget: seed.target }).catch(() => {})
    teacher.onSeedApplied()
    inputRef.current?.focus({ preventScroll: true })
  }, [composer.ready, teacher, directoryPending, onNewConversation])
  const [working, setBusy] = useState(false), [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const [posted, setPosted] = useState<PostedMessage[]>([])
  const alreadyPresented = useMemo(() => new Set(controller.conversation?.messages.map(message => message.inputId)), [controller.conversation?.messages])
  const showPosted = ({ sessionId, requestId, text }: Pick<AgentInput, 'sessionId' | 'requestId' | 'text'>, first = false) =>
    setPosted(items => [...items, { sessionId, requestId, text, at: new Date().toISOString(), first }])
  const settlePosted = (requestId: string, inputId?: string) => setPosted(items => inputId
    ? items.map(item => item.requestId === requestId ? { ...item, inputId } : item)
    : items.filter(item => item.requestId !== requestId))
  const busy = working || sending
  const [experiment, setExperiment] = useState<ExperimentReference | null>(null)
  const experimentKey = 'xj.agent-experiment.' + namespace
  const loadedExperiment = useRef('')
  const [excluded, setExcluded] = useState<string[]>([]), [reading, setReading] = useState<{ name: string; text: string; images: string[]; record?: SessionMaterialUpload; page: number; pageCount: number } | null>(null)
  const [courseReading, setCourseReading] = useState<CourseCitationDocument | null>(null)
  const courseRead = useRef(0)
  const [pending, setPending] = useState(() => outbox.start())
  const viewKey = scope + ':' + sessionId
  const route = useRef(viewKey); route.current = viewKey
  const alive = useRef(true)
  const attaching = useRef(false)
  const starting = useRef<string | null>(null)
  const resettingSkills = useRef<string | null>(null)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    let live = true
    courseRead.current++
    setReading(null); setCourseReading(null); setUploads([]); setExcluded([]); setMetadata(null); setBusy(false); setSending(false); setError(''); setPending(outbox.start())
    setPosted(items => items.filter(item => item.sessionId === sessionId))
    if (!teacher) backToBottom()
    setImageDraft({ sessionId, images: readImageDraft(client.scope, sessionId) })
    if (sessionId && directorySession?.sessionId !== sessionId) {
      void client.read(sessionId).then(value => { if (live) setMetadata(value) }).catch(cause => { if (live) setError(sessionError(cause)) })
    }
    return () => { live = false }
  }, [draftKey, client, sessionId, directorySession?.sessionId])
  useEffect(() => {
    if (posted.some(item => item.inputId && alreadyPresented.has(item.inputId)))
      setPosted(items => items.filter(item => !item.inputId || !alreadyPresented.has(item.inputId)))
  }, [alreadyPresented, posted])
  useEffect(() => {
    if (teacher || !composer.ready || loadedExperiment.current === viewKey) return
    loadedExperiment.current = viewKey
    try {
      const value = parseExperimentReference(JSON.parse(sessionStorage.getItem(experimentKey) ?? 'null'))
      setExperiment(value)
      if (value && !composer.value.text.trim()) void composer.change({ ...composer.value, text: value.question }).catch(() => {})
    } catch { setExperiment(null); sessionStorage.removeItem(experimentKey) }
  }, [viewKey, composer.ready])
  useViewPolling(async () => {
    if (!sessionId) return
    try { const items = await sessionUploads(client, sessionId); if (alive.current && route.current === viewKey) setUploads(items) }
    catch (cause) { if (alive.current && route.current === viewKey) setError(sessionError(cause)) }
  }, viewKey + ':materials', 10000, !teacher && !!sessionId && viewActive)
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
    const original = outbox.start()
    if (!original || starting.current === viewKey) return
    starting.current = viewKey
    setSending(true)
    showPosted(original.input, true)
    try {
      const value = await outbox.deliverStart(original)
      settlePosted(original.input.requestId, value.receipt.inputId)
      if (alive.current && route.current === viewKey) setPending(null)
      if (experiment) { sessionStorage.removeItem(experimentKey); setExperiment(null) }
      if (alive.current && route.current === viewKey && !sessionId) {
        if (Array.isArray(original?.input.context.skills) && original.input.context.skills.length) {
          consumeSessionSkillSelection({ identity, spaceKey, namespace, nextSessionId: value.session.sessionId,
            clientScope: client.scope, turnId: value.receipt.turnId })
          skills.choose([])
        }
        if (teacher && original?.input.context.teacherSkill) skills.choose([])
        const nextDraft = composer.latest()
        const retained = nextDraft.text && nextDraft.text !== original?.input.text
          ? protectSessionDraft(client.scope, value.session.sessionId, 'composer', nextDraft) : Promise.resolve()
        const cleared = original ? composer.clearIfMatches(original.input.text) : Promise.resolve()
        onSession(value.session)
        await Promise.all([retained, cleared])
      }
    } catch (cause) {
      settlePosted(original.input.requestId)
      if (teacher && cause instanceof AgentSessionRequestError && cause.rejected) {
        outbox.discardStart(original.input.requestId)
        if (alive.current && route.current === viewKey) setPending(null)
      }
      if (alive.current && route.current === viewKey) setError(sessionError(cause))
      skills.restoreVisible?.()
    } finally {
      if (starting.current === viewKey) starting.current = null
      if (alive.current && route.current === viewKey) setSending(false)
    }
  }, [outbox, draftKey, onSession, identity, spaceKey, namespace, client.scope, skills.choose, experiment, experimentKey, teacher])
  useEffect(() => { if (!sessionId && !readOnly && composer.ready) void completeStart() }, [client, sessionId, readOnly, composer.ready])
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
    if (!writable || busy || pending || attaching.current || !text.trim() || !canUseModel || picker.blocked || needsImageModel || !composer.ready) return
    setError(''); setSending(true)
    const selectedSkills = [...skills.selected]
    let requestId: string | undefined
    if (selectedSkills.length) skills.consumeVisible?.()
    try {
      const target = teacher && composer.value.teacherTarget
      const context = teacher ? teacherChatInputContextSchema.parse({
        ...(target ? { teacherTarget: { kind: target.kind, taskId: target.taskId, releaseId: target.releaseId } } : {}),
        ...(selectedSkills[0] ? { teacherSkill: selectedSkills[0] } : {}),
      }) : { skills: selectedSkills, ...(images.length ? { messageImages: images } : {}), materials: uploads.filter(item => !excluded.includes(item.key)).map(item => ({ kind: item.kind === 'pdf' ? 'pdf' : 'personal-material',
        scope: { kind: 'session', sessionId }, objectId: item.input.documentId ?? item.input.materialId, requestId: item.input.requestId })),
        ...(experiment ? { experimentReferences: [{ activityId: experiment.activityId, requestId: experiment.requestId,
          executionRef: experiment.executionRef, inputDigest: experiment.inputDigest, label: experiment.label,
          source: experiment.source }] } : {}) }
      const inputContext = JSON.parse(JSON.stringify(context)) as AgentInput['context']
      if (!sessionId) { const value = outbox.begin(text, inputContext); setPending(value); await completeStart() }
      else {
        requestId = crypto.randomUUID()
        showPosted({ requestId, sessionId, text })
        if (!teacher) {
          // Student skill selection has a separate receipt. Keep that selection and the draft recoverable until submission.
          const selectionKey = 'xj.session-skill-selection.' + client.scope + ':' + sessionId
          const raw = localStorage.getItem(selectionKey)
          if (raw || selectedSkills.length) {
            await composer.protect()
            const choice = raw ? JSON.parse(raw) : { requestId: crypto.randomUUID(), context: { skills: selectedSkills } }
            localStorage.setItem(selectionKey, JSON.stringify(choice))
            await selectSkills(sessionId, choice)
            localStorage.removeItem(selectionKey)
          }
        }
        const receipt = agentInputReceiptSchema.parse(await controller.send(text, inputContext, requestId))
        settlePosted(requestId, receipt.inputId)
        if (experiment) { sessionStorage.removeItem(experimentKey); setExperiment(null) }
        if (selectedSkills.length) {
          if (!teacher) consumeSessionSkillSelection({ identity, spaceKey, namespace, currentSessionId: sessionId, nextSessionId: sessionId,
            clientScope: client.scope, turnId: receipt.turnId })
          skills.choose([])
        }
        if (images.length) {
          const sent = new Set(images.map(image => image.imageId))
          const remaining = readImageDraft(client.scope, sessionId).filter(image => !sent.has(image.imageId))
          writeImageDraft(client.scope, sessionId, remaining)
          if (alive.current && route.current === viewKey) setImageDraft({ sessionId, images: remaining })
        }
        void composer.clearIfMatches(text).catch(() => {})
      }
    } catch (cause) {
      if (requestId) settlePosted(requestId)
      skills.restoreVisible?.()
      if (alive.current && route.current === viewKey) setError(sessionError(cause))
    }
    finally { if (alive.current && route.current === viewKey) setSending(false) }
  }
  async function openMaterial(record: SessionMaterialUpload, page = 1) {
    courseRead.current++
    setCourseReading(null)
    if (!sessionId) return
    setBusy(true)
    try { const value = await readSessionMaterial(client, sessionId, record, page)
      if (alive.current && route.current === viewKey) setReading({ ...value, record, name: record.input.name })
    } catch (cause) { if (alive.current && route.current === viewKey) setError(sessionError(cause)) }
    finally { if (alive.current && route.current === viewKey) setBusy(false) }
  }
  async function openCitation(item: CitationRecord) {
    let source: Record<string, unknown> = item.citation.source as unknown as Record<string, unknown>
    if (teacher && source.kind === 'tool-call') {
      const tool = controller.conversation?.tools.find(entry => entry.toolCallId === source.toolCallId)
      const result = tool && toolResultData(tool)
      if (result && tool?.name === 'read_course_task' && typeof result.taskTitle === 'string') {
        const requirements = teacherExcerpt(result.requirements)
        const objectives = Array.isArray(result.objectives) ? result.objectives.filter(value => typeof value === 'string') : []
        setCourseReading({ name: result.taskTitle, text: [...objectives, requirements].filter(Boolean).join('\n\n') })
        return
      }
      if (result && tool?.name === 'read_design_material' && typeof result.title === 'string' && typeof result.text === 'string') {
        setCourseReading({ name: result.title, text: result.text })
        return
      }
      if (result && tool?.name === 'list_design_materials' && Array.isArray(result.materials)) {
        const titles = result.materials.flatMap(material => material && typeof material === 'object'
          && 'title' in material && typeof material.title === 'string' ? [material.title] : [])
        setCourseReading({ name: '公开材料列表', text: titles.join('\n\n') || '此版本未返回公开材料。' })
        return
      }
      toast.info('可在本轮的「思考与执行」中查看读取记录。')
      return
    }
    if (source.kind === 'tool-call' && source.source && typeof source.source === 'object' && !Array.isArray(source.source))
      source = source.source as Record<string, unknown>
    if (source.kind === 'experiment-reference' && typeof source.activityId === 'string') {
      const fixed = source.source
      if (fixed && typeof fixed === 'object' && !Array.isArray(fixed)) onWorkspace?.(source.activityId, fixed as Record<string, unknown>)
      else toast.error('这条实验出处没有可核对的原始位置。')
      return
    }
    if (source.kind === 'component' && typeof source.activityId === 'string') {
      onWorkspace?.(source.activityId, source)
      return
    }
    const parsedPdf = coursePdfCitationSourceSchema.safeParse(source)
    const pdfReading = parsedPdf.success ? parsedPdf.data : undefined
    if (pdfReading) source = pdfReading.reference
    if (source.kind === 'course-material' && typeof source.releaseId === 'string') {
      if (!onOpenCourseMaterial) { toast.error('课程资料入口当前不可用，固定出处仍保留。'); return }
      const parsed = learningReferenceSchema.safeParse(source)
      const ref = parsed.success ? parsed.data : null
      const materialId = ref?.objectId ?? source.materialId
      const materialSha256 = ref?.version ?? source.materialSha256
      if (typeof materialId !== 'string' || typeof materialSha256 !== 'string') { toast.error('课程出处缺少固定版本。'); return }
      const range = item.citation.range
      const from = range?.offset ?? range?.start
      const to = range?.end ?? (typeof from === 'number' && typeof range?.length === 'number' ? from + range.length : undefined)
      const target = range?.target
      const targetPages = target && typeof target === 'object' && !Array.isArray(target) ? target.pages : undefined
      const page = pdfReading?.page ?? range?.page ?? (Array.isArray(range?.pages) ? range.pages[0] : undefined)
        ?? (Array.isArray(targetPages) ? targetPages[0] : undefined) ?? source.page
      const read = ++courseRead.current
      const current = () => alive.current && route.current === viewKey && courseRead.current === read
      setReading(null)
      setCourseReading(null)
      try {
        const value = await onOpenCourseMaterial({ releaseId: source.releaseId, materialId, materialSha256,
          ...(pdfReading ? { pdfReading } : {}),
          ...(ref ? { sourceId: ref.sourceId, identity: ref.identity } : {}),
          ...(typeof source.contentDigest === 'string' ? { contentDigest: source.contentDigest } : {}),
          ...(typeof from === 'number' && typeof to === 'number' ? { from, to } : {}),
          ...(typeof page === 'number' && Number.isInteger(page) && page > 0 ? { page } : {}) })
        if (current()) setCourseReading(value)
      } catch { if (current()) toast.error('这份课程资料的固定版本当前无法读取，原出处仍保留。') }
      return
    }
    const objectId = typeof source.objectId === 'string' ? source.objectId
      : typeof source.documentId === 'string' ? source.documentId
        : typeof source.materialId === 'string' ? source.materialId : null
    if (!objectId) { toast.error('这份出处当前没有可打开的固定原件。'); return }
    const upload = uploads.find(record => record.input.documentId === objectId || record.input.materialId === objectId)
    if (!upload) { toast.error('原资料已不在当前会话中，固定引用仍保留。'); return }
    const candidates = [source.page, item.citation.range?.page, Array.isArray(item.citation.range?.pages)
      ? item.citation.range.pages[0] : undefined].filter((value): value is number => Number.isInteger(value) && Number(value) > 0)
    await openMaterial(upload, candidates[0] ?? 1)
  }
  const activeUploads = uploads.filter(item => !excluded.includes(item.key))
  const files = { items: [
    ...activeUploads.map(item => ({ id: item.key, name: item.input.name,
      size: (item.remote && ('byteLength' in item.remote ? item.remote.byteLength : item.remote.versions.find(version => version.version === ('currentVersion' in item.remote! ? item.remote.currentVersion : 0))?.byteLength)) ?? Math.floor(item.input.dataBase64.length * 3 / 4),
      ...(!item.confirmed ? { progress: 50 } : {}) })),
    ...images.map(image => ({ id: image.imageId, name: image.name, attachmentKind: 'image' as const, src: imagePreviews[image.imageId] })),
  ], busy: attaching.current || activeUploads.some(item => !item.confirmed), error: '',
  add: addFiles, remove: (id: string) => {
    if (sessionId && images.some(image => image.imageId === id)) {
      const remaining = readImageDraft(client.scope, sessionId).filter(image => image.imageId !== id)
      writeImageDraft(client.scope, sessionId, remaining)
      setImageDraft({ sessionId, images: remaining })
    } else setExcluded(items => [...items, id])
  } }
  const visibleText = sending ? '' : text
  const hasDraft = !!visibleText.trim() || files.items.length > 0
  const pendingMessages = posted.filter(item => (sessionId ? item.sessionId === sessionId : item.first)
    && (!item.inputId || !alreadyPresented.has(item.inputId))).map(item => <UserMessage key={item.requestId} text={item.text} at={item.at} busy />)
  const conversationPending = !!teacher && !!sessionId && !controller.conversation && !controller.error
  const directoryLoading = !!directoryPending && !sessionId && pendingMessages.length === 0
  const showSkeleton = !pendingMessages.length && (directoryLoading || conversationPending)
  return <div className="agent-layout product-conversation product-agent">
    {!teacher && ownMetadata && <header className="product-conversation-head"><h1>{ownMetadata.title ?? '新对话'}</h1>{ownMetadata.archived && <span>已归档</span>}</header>}
    {pendingMessages.length > 0 || sessionId && (!teacher || !controller.conversation || controller.conversation.messages.length > 0 || controller.conversation.turns.length > 0) || directoryLoading ? <ChatViewport scrollerRef={scroll} onScroll={handleScroll} onJump={onJump} phase={controller.active ? 'streaming' : undefined}
      busy={controller.active || conversationPending || directoryLoading} padSuggestions={false} queued={false}>
      {showSkeleton ? <ConversationSkeleton /> : <SessionConversation controller={controller} readOnly={!writable} onOpenWorkspace={onWorkspace}
        onWorkspaceCreated={onWorkspaceCreated} onOpenCitation={openCitation} pendingMessages={pendingMessages.length > 0 ? pendingMessages : undefined} />}
      {courseReading && <section className="product-conversation-inner session-material-reading" aria-label={courseReading.name}>
        <h2>{courseReading.name}</h2>
        <Button variant="outline" onClick={() => setCourseReading(null)}>返回对话</Button>
        {'pdf' in courseReading ? <CoursePdfOriginal pdf={courseReading.pdf} page={courseReading.page} /> : <Markdown text={courseReading.text} />}
      </section>}
      {reading && <section className="product-conversation-inner session-material-reading"><h2>{reading.name}</h2>
        <Button variant="outline" onClick={() => setReading(null)}>返回对话</Button><Markdown text={reading.text} />
        {!!reading.images.length && <Button variant="outline" disabled={busy || !writable} onClick={() => void addFiles(reading.images.map((src, index) => ({
          name: `${reading.name.slice(0, 200)} · 第 ${reading.page + index} 页`, dataBase64: src.slice('data:image/png;base64,'.length),
        })))}>将此页添加为图片</Button>}
        {reading.pageCount > 1 && reading.record && <nav aria-label="PDF 翻页"><Button variant="outline" disabled={busy || reading.page === 1} onClick={() => void openMaterial(reading.record!, reading.page - 1)}>上一页</Button><span>{reading.page} / {reading.pageCount}</span><Button variant="outline" disabled={busy || reading.page === reading.pageCount} onClick={() => void openMaterial(reading.record!, reading.page + 1)}>下一页</Button></nav>}
        {reading.images.map((src, index) => <img key={index} src={src} alt={`${reading.name} 第 ${reading.page + index} 页`} />)}</section>}
    </ChatViewport> : <div className="product-agent-body"><AgentEmptyState title="今天想探讨什么？" /></div>}
    <div className="product-agent-notices">
      {directoryError && <p role="alert">{directoryError}{' '}
        {onRetryDirectory && <button type="button" className="product-agent-settings-link" onClick={onRetryDirectory}>重试</button>}</p>}
      {pending && !sending && <p role="status">原问题已保留。<Button variant="outline" disabled={busy} onClick={() => void completeStart()}>核对并继续原请求</Button></p>}
      {experiment && <p role="status">已固定工作区实验「{experiment.label}」。<button type="button" disabled={busy}
        onClick={() => { sessionStorage.removeItem(experimentKey); setExperiment(null) }}>移除引用</button></p>}
      {composer.error && <p role="alert">{composer.error} <button type="button" onClick={() => void composer.protect().catch(() => {})}>重试保留输入</button></p>}
      {error && <p role="alert">{error}</p>}
      {needsImageModel && <p role="status">{IMAGE_MODEL_HINT}</p>}
      {teacher && composer.value.teacherTarget && <p role="status">本条消息参考发布任务「{composer.value.teacherTarget.title}」。
        <button type="button" className="product-agent-settings-link" disabled={busy || !!pending} onClick={() => void composer.change({ ...composer.value, teacherTarget: undefined }).catch(() => {})}>移除任务引用</button></p>}
      {teacher && selection.selection && !selection.selection.selected && <p role="status">当前教师模型不可用。
        <button type="button" className="product-agent-settings-link" onClick={onSettings}>管理模型</button></p>}
      {!teacher && !picker.models.length && !readOnly && !selection.stale && <p>尚未配置模型。<button type="button" className="product-agent-settings-link" onClick={onSettings}>打开设置</button></p>}
      {!writable && <p role="status">{ownMetadata?.archived ? '这段对话已归档，恢复后可以继续。' : '当前会话只读。'}</p>}
      {sessionId && uploads.length > 0 && <details><summary>会话资料</summary>{uploads.map(item => <div key={item.key}>
        <button type="button" disabled={busy} onClick={() => void openMaterial(item)}>{item.input.name}</button>
        {!item.confirmed && <button type="button" disabled={busy} onClick={() => { setBusy(true); void deliverSessionUpload(client, sessionId, item).then(() => sessionUploads(client, sessionId)).then(setUploads).catch(cause => setError(sessionError(cause))).finally(() => setBusy(false)) }}>继续上传</button>}
      </div>)}</details>}

    </div>
    <ProductComposerDock atBottom={atBottom} onBackToBottom={backToBottom} disclaimer={teacher && spaceKey === 'school' ? '对话自动保存在学校' : undefined}>
      {pendingQuestion ? <SessionQuestionBox key={pendingQuestion.questionId + ':' + pendingQuestion.version}
        question={pendingQuestion} controller={controller} readOnly={!writable} />
        : <ProductPromptInput value={visibleText} inputRef={inputRef} onChange={value => {
          if (directoryPending && value.trim()) onNewConversation?.()
          void composer.change({ ...composer.value, text: value }).catch(() => {})
        }} autoFocus
        onSend={send} canSend={composer.ready && !!text.trim() && !busy && !pending && writable && canUseModel && !picker.blocked && !needsImageModel && !uploads.some(item => !excluded.includes(item.key) && !item.confirmed)}
        submitting={busy || !writable} busy={controls.active && (!!teacher || !hasDraft)} onStop={controls.stop}
        onResume={controls.canResume && !hasDraft && canUseModel ? controls.resume : undefined} actionDisabled={controls.disabled} resumeLabel="继续生成"
        files={files} pasteImages={!teacher} skills={skills} allowFiles={!teacher} singleSkill={!!teacher}
        textareaProps={teacher ? { 'aria-label': '向教师 Agent 提问' } : undefined} selection={selection} modelLocked={controller.active} readOnly={!writable}
        onModelSettings={onSettings} contextUsage={controller.conversation?.contextUsage} />}
    </ProductComposerDock>
  </div>
}
