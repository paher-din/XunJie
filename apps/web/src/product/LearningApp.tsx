import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { activitySchema, createActivitySchema, courseActivityResultSchema } from '@xunjie/contracts/learning-data'
import type { LearningActivity, CourseActivityResult } from '@xunjie/contracts/learning-data'
import { courseCatalogSchema, courseReleaseSchema, courseMaterialContentSchema, createCourseActivitySchema } from '@xunjie/contracts/courses'
import type { Course, CourseRelease, CourseMaterial } from '@xunjie/contracts/courses'
import { spaceIdentitySchema, type SpaceIdentity } from '@xunjie/contracts/spaces'
import { useTheme } from '../lib/theme'
import './product.css'
import type { ActivityWorkspaceHandle } from './ActivityWorkspace'
import { ProductShell } from '../components/ProductShell'
import { useModelSelection } from './ModelSelection'
import { ProductHome } from './ProductHome'
import { ProductConversationHistory, conversationTitle, useConversationHistory } from './ProductConversationHistory'
import { ProductSettings, type ProductSettingsTab } from './ProductSettings'
import { SettingsFailureBoundary } from './SettingsFailureBoundary'
import { ProductProfile } from './ProductProfile'
import { Button, ConfirmationDialog, SessionLogin } from '@xunjie/ui/foundation'
import { Toaster, toast, useToastFeedback } from '@xunjie/ui/feedback'
import { Icon } from '@xunjie/ui/icons'
import { SettingsStatus, TextInput } from '@xunjie/ui/settings'
import { createBrowserRouter, RouterProvider, useBlocker, useLocation, useNavigate } from 'react-router-dom'
import { LearningReadCache } from './learning-read-cache'
import { skillCatalogCacheKey, skillCatalogSchema } from './skills'
import { learningSubjectRequest } from './learningTransport'
import { parsePendingActivityRequest, rememberFirstQuestion, type PendingActivityRequest } from './first-question'
import { startSchoolAuthorization, rememberSchoolConnection, restoreSchoolConnection, schoolAuthorizationReturnUrl, returnToSchoolClient,
  type PendingSchoolConnection } from './school-authorization'

const loadActivityPage = () => import('./ActivityPage')
const loadConversation = () => import('./ProductConversation')
const loadReferences = () => import('./ActivityReferences')
const loadAgent = () => import('./ProductAgent')
const loadModelSettings = () => import('./PersonalModelSettings')
const prepareAgent = () => { void loadAgent().catch(() => {}) }
const ProductAgent = lazy(() => loadAgent().then(module => ({ default: module.ProductAgent })))
const ActivityPage = lazy(() => loadActivityPage().then(module => ({ default: module.ActivityPage })))
const ProductConversation = lazy(() => loadConversation().then(module => ({ default: module.ProductConversation })))
const ActivityReferences = lazy(() => loadReferences().then(module => ({ default: module.ActivityReferences })))
const CourseMaterialReferences = lazy(() => loadReferences().then(module => ({ default: module.CourseMaterialReferences })))
const CourseRequirementsReference = lazy(() => loadReferences().then(module => ({ default: module.CourseRequirementsReference })))
const PersonalModelSettings = lazy(() => loadModelSettings().then(module => ({ default: module.PersonalModelSettings })))

type Account = { key: string; accountName: string; schoolName: string }
type Context = { clientNamespace: string; profile: string; readOnly?: boolean; identities: { key: string; identity: SpaceIdentity }[]; account?: Account | null }
// Explicit null means unbound. Older servers fall back to one school identity,
// never the requested route, so a deep link cannot select a different account.
function normalizeContext(value: Context): Context {
  const school = value.identities.find(item => item.identity.kind === 'school')
  const account = value.account === undefined ? school ? { key: school.key, accountName: school.identity.name, schoolName: school.identity.name } : null : value.account
  return { ...value, account, identities: value.identities.filter(item => item.identity.kind === 'personal' || item.key === account?.key) }
}
function knownSpaceKey(context: Context, requested: string | null, activityId: string | null) {
  if (context.identities.some(item => item.key === requested)) return requested!
  if (!requested?.startsWith('school:') || !activityId || !context.account) return undefined
  const bound = context.identities.find(item => item.key === context.account!.key)?.identity
  if (!bound || bound.kind !== 'school') return undefined
  try {
    const cached = activitySchema.parse(JSON.parse(sessionStorage.getItem(
      `xj.works-activity.${context.clientNamespace}.${requested}.${activityId}`) ?? 'null'))
    if (cached.activityId === activityId && cached.identity.kind === 'school'
      && cached.identity.environmentId === bound.environmentId && cached.identity.spaceId === bound.spaceId
      && cached.identity.principalId === bound.principalId) return context.account.key
  } catch { /* An unknown old link cannot select or bind another account. */ }
  return undefined
}
function preferredKey(context: Context, preferred: string | null, agent = false) {
  const personal = context.identities.find(item => item.identity.kind === 'personal')?.key
  if (agent && personal) return personal
  return knownSpaceKey(context, preferred, new URLSearchParams(location.search).get('activity'))
    ?? personal ?? context.identities[0]?.key ?? ''
}
type HomeData = { scope: string; personal: LearningActivity[] | null; school: LearningActivity[] | null; courses: Course[] | null; personalError: string; schoolError: string }

type PendingConnection = PendingSchoolConnection
type CreateCourseActivity = { requestId: string; releaseId: string }
const messages: Record<string, string> = {
  forbidden: '访问资格已失效，请重新登录或联系学校管理员。原活动仍属于原空间。',
  missing: '无法找到或无权访问这项内容，请返回列表核对。',
  'identity-conflict': '这个请求已使用其他内容，请先核对原请求结果。',
  unavailable: '暂时无法连接原服务，请稍后重试。',
  invalid: '请检查填写的内容。', maintenance: '学习服务正在维护，请稍后重试。',
  corrupt: '课程材料或发布版本已损坏，请联系课程管理员。', 'resource-busy': '材料正在准备中，请稍后重试。',
}
async function requestLearning(path: string, body?: unknown, key?: string, signal?: AbortSignal, namespace?: string): Promise<unknown> {
  const request = () => sendLearningRequest(path, body, key, signal, namespace)
  return path === 'client/start' ? startSchoolAuthorization(body, request, namespace ?? '') : request()
}
async function sendLearningRequest(path: string, body?: unknown, key?: string, signal?: AbortSignal, namespace?: string): Promise<unknown> {
  // Course coordination includes several authenticated owner calls; timeout still leaves the original request queryable.
  const timeout = path === 'course-activities' || path === 'activity-status' ? 60000 : 30000
  const response = await fetch('/api/learning/' + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { 'x-xj-space': key } : {}),
      ...(namespace ? { 'x-xj-namespace': namespace } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: signal ?? AbortSignal.timeout(timeout), credentials: 'same-origin' })
    .catch(() => { throw Object.assign(new Error(messages.unavailable), { code: 'unavailable' }) })
  const result = await response.json()
  if (!response.ok) {
    const failure = new Error(messages[result.error] ?? '操作结果尚未确认，请核对原请求后重试。') as Error & { code?: string }
    failure.code = result.error
    throw failure
  }
  return result
}
const errorText = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请重试。'
const definitive = new Set(['invalid', 'forbidden', 'missing', 'corrupt', 'identity-conflict'])
const published = (value: string) => new Date(value).toLocaleDateString('zh-CN')
const formatBytes = (value: number) => value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`

type CourseSectionsContent = Pick<CourseRelease, 'releaseId' | 'objectives' | 'requirements' | 'materials' | 'starterWorks' | 'capabilities'>
function CourseSections({ content, level, busy, onMaterial, requirementsContent }: {
  content: CourseSectionsContent; level: 3 | 4; busy: boolean; onMaterial: (item: CourseMaterial) => void
  requirementsContent?: ReactNode
}) {
  const Heading = level === 4 ? 'h4' : 'h3'
  return <>
    <Heading>学习目标</Heading><ul className="course-points">{content.objectives.map((item, index) => <li key={index}>{item}</li>)}</ul>
    <Heading>任务要求</Heading>{requirementsContent ?? <p className="preserve-lines">{content.requirements}</p>}
    <Heading>学习材料</Heading>
    {content.materials.length === 0 ? <p className="detail">这个版本没有开放材料。</p>
      : <ul className="material-list">{content.materials.map(item => <li key={item.materialId}>
        <button type="button" disabled={busy} onClick={() => onMaterial(item)}>{item.title}</button>
        <span className="detail">{item.mediaType} · {formatBytes(item.byteLength)}</span></li>)}</ul>}
    {content.starterWorks.length > 0 && <><Heading>起始作品</Heading>
      <ul className="course-points">{content.starterWorks.map(work => <li key={work.workId}>
        <strong>{work.title}</strong>{work.description ? ` · ${work.description}` : ''}</li>)}</ul></>}
    {content.capabilities.length > 0 && <details className="capability-note"><summary>课程工具详情</summary>
      <p>本课程声明的工具尚未接入当前工作区。</p>
      <ul>{content.capabilities.map(item => <li key={item.objectId}>{item.kind} · {item.objectId} · {item.version}</li>)}</ul>
    </details>}
  </>
}

export function LearningApp() {
  const router = useRef<ReturnType<typeof createBrowserRouter> | null>(null)
  if (!router.current) router.current = createBrowserRouter([{ path: '*', element: <LearningView /> }])
  return <><RouterProvider router={router.current} /><Toaster /></>
}

function LearningView() {
  useTheme()
  const route = useLocation()
  const navigate = useNavigate()
  const currentSearch = useRef(route.search)
  currentSearch.current = route.search
  const routeReadEpoch = useRef(0)
  const contentReadEpoch = useRef(0)
  const actionEpoch = useRef(0)
  const approvedSearch = useRef<string | null>(null)
  const [profileOpen, setProfileOpen] = useState(false)
  const [historyQuery, setHistoryQuery] = useState('')
  const [archiveOpen, setArchiveOpen] = useState(false)
  const selectedCourseId = new URLSearchParams(route.search).get('course')
  const settingsPage = new URLSearchParams(route.search).get('settings')
  const modelsOpen = settingsPage !== null
  const agentOpen = new URLSearchParams(route.search).get('view') === 'agent'
  const routeActivityId = new URLSearchParams(route.search).get('activity')
  const requestedArtifactId = new URLSearchParams(route.search).get('artifact')
  const [context, setContext] = useState<Context | null>(null)
  const api = (path: string, body?: unknown, space?: string, signal?: AbortSignal) =>
    requestLearning(path, body, space, signal, context?.clientNamespace)
  const [contextVerified, setContextVerified] = useState(true)
  const [key, setKey] = useState('')
  const [activities, setActivities] = useState<LearningActivity[] | null>(null)
  const [activitiesFor, setActivitiesFor] = useState('')
  const [opened, setOpened] = useState<LearningActivity | null>(null)
  const [homeData, setHomeData] = useState<HomeData | null>(null)
  const [catalog, setCatalog] = useState<Course[] | null>(null)
  const [release, setRelease] = useState<CourseRelease | null>(null)
  const [material, setMaterial] = useState<{ title: string; url: string } | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [goal, setGoal] = useState('')
  const [question, setQuestion] = useState('')
  const [reference, setReference] = useState('')
  const [loginName, setLoginName] = useState('')
  const [password, setPassword] = useState('')
  const schoolAccount = useRef<HTMLInputElement>(null)
  const [schoolEndpoint, setSchoolEndpoint] = useState('')
  const [pendingConnection, setPendingConnection] = useState<PendingConnection | null>(null)
  const [schoolFormOpen, setSchoolFormOpen] = useState(false)
  const [disconnectTarget, setDisconnectTarget] = useState<{ key: string; name: string; replace?: boolean } | null>(null)
  const [disconnectError, setDisconnectError] = useState('')
  const disconnectTrigger = useRef<HTMLButtonElement | null>(null)
  const disconnectSection = useRef<HTMLElement | null>(null)
  const disconnectPending = useRef(false)
  const schoolStartRequest = useRef<{ requestId: string; schoolEndpoint: string } | null>(null)
  const [pendingRequest, setPendingRequest] = useState<PendingActivityRequest | null>(null)
  const [coursePending, setCoursePending] = useState<CreateCourseActivity | null>(null)
  const [notice, setNotice] = useState('')
  useToastFeedback(error)
  useToastFeedback(notice, 'success')
  const [reload, setReload] = useState(0)
  const epoch = useRef(0)
  const authEpoch = useRef(0)
  const currentView = useRef({ context, key, opened })
  currentView.current = { context, key, opened }
  useEffect(() => {
    if (!context || context.profile === 'school') return
    const params = new URLSearchParams(location.search)
    const returned = params.get('schoolAuthorization')
    const pending = restoreSchoolConnection(context.clientNamespace, returned)
    setPendingConnection(pending)
    if (returned) {
      if (!pending) toast.error('学校认证请求已过期或不属于此客户端，请重新填写学校链接。')
      else rememberSchoolConnection(context.clientNamespace, pending)
      params.delete('schoolAuthorization')
      navigate({ pathname: route.pathname, search: params.toString() }, { replace: true })
    }
  }, [context?.clientNamespace, context?.profile])
  function rememberPendingConnection(pending: PendingConnection | null) {
    if (context) rememberSchoolConnection(context.clientNamespace, pending)
    setPendingConnection(pending)
  }
  const workspace = useRef<ActivityWorkspaceHandle>(null)
  async function protectActivity() {
    if (!currentView.current.opened) return
    if (!workspace.current) throw new Error('活动仍在准备，暂时无法保护当前内容。')
    await workspace.current.leave()
  }
  const returnFocus = useRef<{ key: string; activityId: string; scrollTop: number } | null>(null)
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    if (approvedSearch.current === nextLocation.search) { approvedSearch.current = null; return false }
    return !!currentView.current.opened && currentLocation.search !== nextLocation.search
  })
  useEffect(() => {
    if (blocker.state !== 'blocked') return
    let active = true
    void protectActivity().then(() => { if (active) blocker.proceed() }).catch(() => {
      if (active) { setError('本机内容尚未得到保护，请保留当前页面并复制或导出作品。'); blocker.reset() }
    })
    return () => { active = false }
  }, [blocker])
  const requestedActivity = useRef(new URLSearchParams(location.search).get('activity'))
  function rememberActivity(activity: LearningActivity | null, nextKey = key) {
    if (activity) returnFocus.current = { key: nextKey, activityId: activity.activityId,
      scrollTop: document.querySelector('.main')?.scrollTop ?? 0 }
    ++epoch.current
    setBusy(false)
    const url = new URL(location.href)
    if (!activity || activity.activityId !== url.searchParams.get('activity') || nextKey && nextKey !== key) url.searchParams.delete('artifact')
    if (activity) url.searchParams.set('activity', activity.activityId)
    else url.searchParams.delete('activity')
    if (nextKey && nextKey !== key) url.searchParams.delete('course')
    if (nextKey) url.searchParams.set('space', nextKey)
    if (url.search !== location.search) {
      approvedSearch.current = url.search
      navigate({ pathname: route.pathname, search: url.search })
    }
    if (activity && context) {
      try { sessionStorage.setItem(`xj.works-activity.${context.clientNamespace}.${nextKey}.${activity.activityId}`, JSON.stringify(activity)) } catch { /* IndexedDB owns work protection. */ }
    }
    setOpened(activity)
  }
  function selectCourse(courseId: string | null) {
    ++contentReadEpoch.current
    const params = new URLSearchParams(route.search)
    if (courseId) {
      if (!context?.account) return
      params.set('space', context.account.key); params.delete('view'); params.delete('activity'); params.delete('artifact')
      params.set('course', courseId)
    }
    else params.delete('course')
    navigate({ pathname: route.pathname, search: params.toString() })
    setRelease(null); rememberMaterial(null)
    requestAnimationFrame(() => { const heading = document.getElementById('course-title'); heading?.focus(); heading?.scrollIntoView({ block: 'start' }) })
  }
  const formScope = useRef('')
  const materialUrl = useRef('')
  const authorize = new URLSearchParams(location.search).get('authorize')
  const identity = context?.identities.find(item => item.key === key)?.identity
  const accountName = context ? context.account?.accountName ?? '本地学习空间' : '本地学习空间'
  const personalKey = context?.identities.find(item => item.identity.kind === 'personal')?.key
  const schoolKey = context?.account?.key
  const schoolLoginRequired = context?.profile === 'school' && !context.identities.some(item => item.key === 'school')
  useEffect(() => { if (schoolLoginRequired) schoolAccount.current?.focus() }, [schoolLoginRequired])
  const routeSpace = new URLSearchParams(route.search).get('space')
  const unavailableRoute = !!context && !!(new URLSearchParams(route.search).get('activity') || selectedCourseId) && !!routeSpace
    && !knownSpaceKey(context, routeSpace, new URLSearchParams(route.search).get('activity'))
  const modelSelection = useModelSelection(identity, key, context?.clientNamespace ?? '')
  const pendingKey = context && identity ? `xj.activity-request.${context.clientNamespace}.${identity.environmentId}.${identity.spaceId}.${identity.principalId}` : ''
  const conversationHistory = useConversationHistory(pendingKey ? pendingKey + ':conversation-archive' : '', key,
    context?.clientNamespace ?? '', identity ? [identity.environmentId, identity.spaceId, identity.principalId].join('.') : '')
  const draftKey = pendingKey ? pendingKey + ':draft' : ''
  const coursePendingKey = context && identity?.kind === 'school'
    ? `xj.course-activity-request.${context.clientNamespace}.${identity.environmentId}.${identity.spaceId}.${identity.principalId}` : ''
  const activityAuthorized = !!opened && !!identity && contextVerified
    && opened.identity.environmentId === identity.environmentId && opened.identity.spaceId === identity.spaceId
    && opened.identity.principalId === identity.principalId

  const openedConversationDeleted = !!opened && conversationHistory.items.some(item => item.activityId === opened.activityId && item.deleted)
  useEffect(() => {
    if (!openedConversationDeleted || !agentOpen || modelsOpen || !activityAuthorized) return
    let current = true
    const activityId = opened!.activityId, generation = epoch.current
    void protectActivity().then(() => {
      if (current && generation === epoch.current && currentView.current.opened?.activityId === activityId) rememberActivity(null)
    }).catch(() => { if (current) setError('当前输入尚未得到保护，请保留此页面并复制或导出作品。') })
    return () => { current = false }
  }, [openedConversationDeleted, agentOpen, modelsOpen, activityAuthorized, opened?.activityId, pendingKey])

  useEffect(() => { setArchiveOpen(false); setHistoryQuery('') }, [pendingKey])

  useEffect(() => {
    const target = returnFocus.current
    if (opened || !activities || activitiesFor !== pendingKey || !target || target.key !== key) return
    const frame = requestAnimationFrame(() => {
      const button = document.querySelector<HTMLButtonElement>(`[data-activity-id="${CSS.escape(target.activityId)}"]`)
      if (!button) return
      button.focus({ preventScroll: true })
      const main = document.querySelector('.main')
      if (main) main.scrollTop = target.scrollTop
      returnFocus.current = null
    })
    return () => cancelAnimationFrame(frame)
  }, [opened, activities, activitiesFor, pendingKey, key])

  function rememberMaterial(next: { title: string; url: string } | null) {
    if (materialUrl.current) URL.revokeObjectURL(materialUrl.current)
    materialUrl.current = next?.url ?? ''
    setMaterial(next)
  }
  useEffect(() => () => { if (materialUrl.current) URL.revokeObjectURL(materialUrl.current) }, [])

  async function refreshContext(prefer?: string, generation = epoch.current) {
    const authentication = authEpoch.current
    await protectActivity()
    const next = normalizeContext(await api('context') as Context)
    if (generation !== epoch.current || authentication !== authEpoch.current) return false
    await protectActivity()
    if (generation !== epoch.current || authentication !== authEpoch.current) return false
    const nextKey = prefer && next.identities.some(item => item.key === prefer) ? prefer
      : next.identities.some(item => item.key === key) ? key : next.identities[0]?.key ?? ''
    rememberActivity(null, nextKey); setActivities(null); setCatalog(null); setRelease(null); rememberMaterial(null)
    try { sessionStorage.setItem('xj.works-context.v1', JSON.stringify(next)) } catch { /* Optional reopening hint only. */ }
    setContextVerified(true)
    setContext(next)
    setReload(value => value + 1)
    setKey(nextKey)
    return true
  }
  useEffect(() => {
    let disposed = false
    void api('context').then(result => {
      if (!disposed) { const next = normalizeContext(result as Context); setContext(next);
        try { sessionStorage.setItem('xj.works-context.v1', JSON.stringify(next)) } catch { /* Optional hint. */ }
        const preferred = new URLSearchParams(location.search).get('space')
        setKey(preferredKey(next, preferred, agentOpen && !requestedActivity.current)) }
    }).catch(error => {
      if (disposed) return
      try {
        if ((error as { code?: string }).code === 'forbidden') throw error
        const stored = JSON.parse(sessionStorage.getItem('xj.works-context.v1') ?? 'null') as Context | null
        const cached = stored ? normalizeContext(stored) : null
        if (!cached || typeof cached.clientNamespace !== 'string') throw error
        cached.identities.forEach(i => spaceIdentitySchema.parse(i.identity))
        const preferred = new URLSearchParams(location.search).get('space')
        const selected = cached.identities.find(i => i.key === preferredKey(cached, preferred, agentOpen && !requestedActivity.current))
        if (!selected) throw error
        setContextVerified(false); setContext(cached); setKey(selected.key)
      } catch { setError(errorText(error)) }
    })
    return () => { disposed = true }
  }, [])
  useEffect(() => {
    if (contextVerified || !context) return
    let checking = false
    const timer = setInterval(() => {
      if (checking) return
      checking = true
      const generation = epoch.current
      const authentication = authEpoch.current
      void api('context').then(async value => {
        if (generation !== epoch.current || authentication !== authEpoch.current) return
        await protectActivity()
        if (generation !== epoch.current || authentication !== authEpoch.current) return
        const next = normalizeContext(value as Context)
        // 恢复请求可能早于当前活动挂载完成；按最新视图保留已打开或 URL 请求的活动，避免恢复后落回列表。
        requestedActivity.current = currentView.current.opened?.activityId ?? requestedActivity.current
        setContext(next); setContextVerified(true); setReload(n => n + 1)
        setKey(old => next.identities.some(i => i.key === old) ? old : next.identities[0]?.key ?? '')
        try { sessionStorage.setItem('xj.works-context.v1', JSON.stringify(next)) } catch { /* Optional hint. */ }
      }).catch(() => {}).finally(() => { checking = false })
    }, 3000)
    return () => clearInterval(timer)
  }, [contextVerified, context, opened])
  const homeVisible = !agentOpen && !modelsOpen && !new URLSearchParams(route.search).has('activity') && !selectedCourseId
  const homeScope = context ? JSON.stringify([context.clientNamespace, context.identities]) : ''
  const readCache = useMemo(() => new LearningReadCache(), [homeScope, reload, contextVerified])
  const readActivities = (space: string) => readCache.read<LearningActivity[]>(space, 'activities', async () =>
    (await api('activities', undefined, space) as unknown[]).map(item => activitySchema.parse(item)))
  const readCourses = (space: string) => readCache.read<Course[]>(space, 'courses', async () =>
    courseCatalogSchema.parse(await api('courses', undefined, space)).courses)
  function publishActivity(activity: LearningActivity, space = key) {
    readCache.set(space, 'activities/' + activity.activityId, activity)
    const previous = readCache.peek<LearningActivity[]>(space, 'activities') ?? []
    const next = [activity, ...previous.filter(item => item.activityId !== activity.activityId)]
    readCache.set(space, 'activities', next)
    setActivities(next); setActivitiesFor(pendingKey)
    setHomeData(previous => previous?.scope === homeScope ? { ...previous,
      ...(space === personalKey ? { personal: next } : { school: next }) } : previous)
  }
  useEffect(() => {
    if (modelsOpen) {
      void loadModelSettings().catch(() => {})
    } else if (routeActivityId) {
      void Promise.all([loadReferences(), agentOpen ? loadConversation() : loadActivityPage()]).catch(() => {})
    } else if (agentOpen) prepareAgent()
  }, [routeActivityId, agentOpen, modelsOpen, settingsPage])
  useEffect(() => {
    if (!context || !homeVisible) return
    const controller = new AbortController()
    const snapshot: HomeData = { scope: homeScope,
      personal: personalKey ? readCache.peek(personalKey, 'activities') ?? null : [],
      school: schoolKey ? readCache.peek(schoolKey, 'activities') ?? null : [],
      courses: schoolKey ? readCache.peek(schoolKey, 'courses') ?? null : [], personalError: '', schoolError: '' }
    setHomeData(previous => previous?.scope === homeScope ? { ...previous, personalError: '', schoolError: '' } : snapshot)
    const update = (patch: Partial<HomeData>) => {
      if (!controller.signal.aborted) setHomeData(previous => previous?.scope === homeScope ? { ...previous, ...patch } : previous)
    }
    if (personalKey) void readActivities(personalKey).then(value => {
      update({ personal: value })
    }).catch(cause => update({ personalError: errorText(cause) }))
    if (schoolKey) {
      void readActivities(schoolKey).then(value => {
        update({ school: value })
      }).catch(cause => update({ schoolError: errorText(cause) }))
      void readCourses(schoolKey).then(value => {
        update({ courses: value })
      }).catch(cause => update({ schoolError: errorText(cause) }))
    }
    return () => controller.abort()
  }, [homeVisible, readCache])
  const visibleHome = homeData?.scope === homeScope ? homeData : null

  useEffect(() => {
    ++epoch.current
    const controller = new AbortController()
    setActivities(readCache.peek(key, 'activities') ?? null); setActivitiesFor(pendingKey)
    setOpened(null); setCatalog(readCache.peek(key, 'courses') ?? null); setRelease(null); setCoursePending(null); rememberMaterial(null)
    setError(''); setPendingRequest(null); setBusy(false)
    if (formScope.current !== pendingKey) {
      formScope.current = pendingKey; setGoal(''); setReference('')
      try { setQuestion(draftKey ? sessionStorage.getItem(draftKey) ?? '' : '') } catch { setQuestion('') }
    }
    if (coursePendingKey) {
      try {
        const saved = localStorage.getItem(coursePendingKey)
        if (saved) setCoursePending(createCourseActivitySchema.parse(JSON.parse(saved)))
      } catch { setError('无法读取上次课程活动请求，请检查浏览器存储。') }
    }
    if (key && pendingKey) {
      if (!contextVerified && context) {
        try {
          const activityId = requestedActivity.current
          const value = sessionStorage.getItem(`xj.works-activity.${context.clientNamespace}.${key}.${activityId}`)
          if (value) {
            const activity = activitySchema.parse(JSON.parse(value))
            if (activity.identity.principalId !== identity?.principalId || activity.identity.spaceId !== identity?.spaceId
              || activity.identity.environmentId !== identity?.environmentId) throw new Error('活动归属不匹配。')
            setOpened(activity)
          }
        } catch { setError('无法读取原活动定位。已保留的作品没有被改动。') }
        return () => { ++epoch.current; controller.abort() }
      }
      try {
        const saved = localStorage.getItem(pendingKey)
        if (saved) {
          const pending = parsePendingActivityRequest(JSON.parse(saved))
          setPendingRequest(pending); setGoal(pending.input.goal); setQuestion(pending.input.question); setReference(pending.input.references[0]?.url ?? '')
        }
      } catch { setError('无法读取上次活动请求，请保留当前输入并检查浏览器存储。') }
    }
    return () => { ++epoch.current; controller.abort() }
  }, [key, pendingKey, coursePendingKey, reload, contextVerified])

  useEffect(() => {
    if (!key || !pendingKey || !contextVerified || modelsOpen) return
    let active = true
    void readActivities(key).then(value => {
      if (active) { setActivities(value); setActivitiesFor(pendingKey) }
    }).catch(cause => { if (active) setError(errorText(cause)) })
    if (identity?.kind === 'school') void readCourses(key).then(value => {
      if (active) setCatalog(value)
    }).catch(cause => { if (active) setError(errorText(cause)) })
    return () => { active = false }
  }, [key, pendingKey, contextVerified, modelsOpen, agentOpen, homeVisible, readCache])

  useEffect(() => {
    ++contentReadEpoch.current
    ++actionEpoch.current
    setBusy(false)
    setRelease(null); rememberMaterial(null)
  }, [selectedCourseId, key])

  // Browser history uses the same leave gate as buttons. A route is only read after that gate succeeds.
  useEffect(() => {
    const readGeneration = ++routeReadEpoch.current
    const controller = new AbortController()
    const retire = () => controller.abort()
    if (!context || modelsOpen && !currentView.current.opened) return
    const params = new URLSearchParams(route.search)
    const activityId = params.get('activity')
    const desiredKey = agentOpen && !activityId ? personalKey ?? currentView.current.key
      : knownSpaceKey(context, params.get('space'), activityId) ?? params.get('space') ?? preferredKey(context, null)
    if ((activityId || params.has('course')) && !context.identities.some(item => item.key === desiredKey)) {
      setOpened(null); setError('此活动属于未绑定的学校账号，请在设置中绑定原账号后打开。'); return retire
    }
    requestedActivity.current = activityId
    if (desiredKey !== currentView.current.key) {
      if (!context.identities.some(item => item.key === desiredKey)) return retire
      requestedActivity.current = activityId
      setOpened(null); setActivities(null); setActivitiesFor(''); setKey(desiredKey)
      return retire
    }
    if (activityId === (currentView.current.opened?.activityId ?? null)) return retire
    if (!activityId) { ++epoch.current; setOpened(null); setBusy(false); return retire }
    if (!contextVerified) return retire
    const generation = ++epoch.current
    const search = route.search
    const applies = () => !controller.signal.aborted && generation === epoch.current
      && readGeneration === routeReadEpoch.current && currentSearch.current === search
    setOpened(null); setError(''); rememberMaterial(null)
    if (agentOpen && identity?.kind === 'personal') {
      void import('./conversation-read').then(({ readConversation }) =>
        readConversation({ identity, activityId }, desiredKey, context.clientNamespace, readCache)).catch(() => {})
    }
    void readCache.read(desiredKey, 'activities/' + activityId, async () =>
      activitySchema.parse(await api('activities/' + activityId, undefined, desiredKey))).then(value => {
      if (applies()) {
        const activity = activitySchema.parse(value)
        try { sessionStorage.setItem(`xj.works-activity.${context.clientNamespace}.${desiredKey}.${activity.activityId}`, JSON.stringify(activity)) } catch { /* Optional reopening hint. */ }
        setOpened(activity)
        returnFocus.current ??= { key: desiredKey, activityId: activity.activityId, scrollTop: 0 }
      }
    }).catch(cause => { if (applies()) setError(errorText(cause)) })
    return retire
  }, [route.search, context?.clientNamespace, key, pendingKey, contextVerified, schoolKey, personalKey])

  async function action(operation: (generation: number) => Promise<void>) {
    const generation = epoch.current
    const operationId = ++actionEpoch.current
    const startedSearch = currentSearch.current
    setBusy(true); setError(''); setNotice('')
    try { await operation(generation) } catch (error) {
      if (operationId === actionEpoch.current && generation === epoch.current && startedSearch === currentSearch.current) setError(errorText(error))
    }
    finally { if (operationId === actionEpoch.current && generation === epoch.current) setBusy(false) }
  }
  async function createActivity(firstMessage?: string) {
    if (!personalKey || key !== personalKey || identity?.kind !== 'personal') return
    const generation = epoch.current
    const startedSearch = currentSearch.current
    const scopeKey = pendingKey
    const selected = key
    const protectedRequest = localStorage.getItem(scopeKey)
    const previous = protectedRequest ? parsePendingActivityRequest(JSON.parse(protectedRequest)) : pendingRequest
    const input = previous?.input ?? createActivitySchema.parse({ requestId: crypto.randomUUID(),
      goal: firstMessage === undefined ? goal : '', question: firstMessage ?? question,
      references: firstMessage === undefined && reference ? [{ kind: 'url', url: reference, label: reference }] : [] })
    const firstQuestion = previous?.firstQuestion ?? (firstMessage !== undefined && input.question.trim()
      ? { requestId: crypto.randomUUID(), question: input.question } : null)
    // Protect both operations before creation. A lost creation reply must not erase
    // the already authorized first question or manufacture another Agent identity.
    const pending: PendingActivityRequest = { version: 1, input, firstQuestion }
    localStorage.setItem(scopeKey, JSON.stringify(pending))
    setPendingRequest(pending)
    try {
      const existing = await api('receipts/' + input.requestId, undefined, selected)
      const activity = activitySchema.parse(existing ?? await api('activities', input, selected))
      // Complete the durable handoff even if the student changed views while the
      // creation was in flight. View generations control presentation only.
      const saved = localStorage.getItem(scopeKey)
      const current = saved ? parsePendingActivityRequest(JSON.parse(saved)) : null
      const completing = current?.input.requestId === input.requestId
      const currentIdentity = currentView.current.context?.identities.find(item => item.key === selected)?.identity
      const sameScope = currentView.current.key === selected && currentView.current.context?.clientNamespace === context?.clientNamespace
        && currentIdentity?.environmentId === identity?.environmentId && currentIdentity?.spaceId === identity?.spaceId
        && currentIdentity?.principalId === identity?.principalId
      // A deliberately discarded/replaced pending request no longer authorizes
      // a late response to recreate its automatic-send intent.
      if (completing && current.firstQuestion) rememberFirstQuestion(activity.activityId, current.firstQuestion)
      if (completing && localStorage.getItem(scopeKey) === saved) localStorage.removeItem(scopeKey)
      if (completing) {
        try { if (sessionStorage.getItem(scopeKey + ':draft') === input.question) sessionStorage.removeItem(scopeKey + ':draft') } catch { /* Optional draft cache. */ }
        if (sameScope) {
          setQuestion(currentQuestion => currentQuestion === input.question ? '' : currentQuestion)
          setPendingRequest(currentRequest => currentRequest?.input.requestId === input.requestId ? null : currentRequest)
          publishActivity(activity, selected)
        }
      }
      if (completing && generation === epoch.current && startedSearch === currentSearch.current) {
        rememberActivity(activity)
        setGoal(''); setQuestion(''); setReference('')
      }
    } catch (error) {
      // A rejected input can never succeed under this request identity; let the student edit again.
      if ((error as { code?: string }).code === 'invalid') {
        const saved = localStorage.getItem(scopeKey)
        if (saved && parsePendingActivityRequest(JSON.parse(saved)).input.requestId === input.requestId) localStorage.removeItem(scopeKey)
        if (generation === epoch.current && startedSearch === currentSearch.current) setPendingRequest(null)
      }
      throw error
    }
  }
  function clearCoursePending(input: CreateCourseActivity, generation: number) {
    if (coursePendingKey) {
      const saved = localStorage.getItem(coursePendingKey)
      try {
        if (saved && createCourseActivitySchema.parse(JSON.parse(saved)).requestId === input.requestId) localStorage.removeItem(coursePendingKey)
      } catch { localStorage.removeItem(coursePendingKey) }
    }
    if (generation === epoch.current) setCoursePending(current => current?.requestId === input.requestId ? null : current)
  }
  async function startCourse(releaseId: string) {
    const generation = epoch.current
    const startedSearch = currentSearch.current
    const selected = key
    const input = coursePending ?? createCourseActivitySchema.parse({ requestId: crypto.randomUUID(), releaseId })
    if (!coursePendingKey) return
    localStorage.setItem(coursePendingKey, JSON.stringify(input))
    setCoursePending(input)
    try {
      const raw = await api('course-activity-results/' + input.requestId, undefined, selected)
      const existing = raw === null ? null : courseActivityResultSchema.parse(raw) as CourseActivityResult
      if (existing?.state === 'rejected') {
        clearCoursePending(input, generation)
        throw Object.assign(new Error(messages[existing.error ?? 'missing'] ?? '课程活动未能建立。'), { code: existing.error ?? 'missing' })
      }
      const activity = existing?.state === 'accepted' && existing.activity
        ? activitySchema.parse(existing.activity)
        : activitySchema.parse(await api('course-activities', input, selected))
      clearCoursePending(input, generation)
      if (generation === epoch.current && startedSearch === currentSearch.current) {
        rememberActivity(activity)
        publishActivity(activity)
      }
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code && definitive.has(code)) clearCoursePending(input, generation)
      throw error
    }
  }
  function discardCoursePending() {
    if (coursePendingKey) localStorage.removeItem(coursePendingKey)
    setCoursePending(null); setError(''); setNotice('')
  }
  function discardPending() {
    if (pendingKey) localStorage.removeItem(pendingKey)
    try { if (draftKey) sessionStorage.removeItem(draftKey) } catch { /* Optional draft cache. */ }
    setPendingRequest(null); setGoal(''); setQuestion(''); setReference(''); setError('')
  }
  async function openActivity(activityId: string, asConversation = false, sourceKey = key) {
    if (!context?.identities.some(item => item.key === sourceKey)) return
    void Promise.all([loadReferences(), asConversation ? loadConversation() : loadActivityPage()]).catch(() => {})
    await protectActivity()
    returnFocus.current = { key: sourceKey, activityId, scrollTop: document.querySelector('.main')?.scrollTop ?? 0 }
    const params = new URLSearchParams(currentSearch.current)
    params.set('activity', activityId); params.set('space', sourceKey); params.delete('course'); params.delete('artifact')
    if (asConversation && sourceKey === personalKey) params.set('view', 'agent')
    else params.delete('view')
    navigate({ pathname: route.pathname, search: params.toString() })
  }
  async function changeStatus(activity: LearningActivity) {
    const generation = epoch.current
    const next = activitySchema.parse(await api('activity-status', { requestId: crypto.randomUUID(), activityId: activity.activityId,
      status: activity.status === 'closed' ? 'open' : 'closed' }, key))
    if (generation === epoch.current) { setOpened(next); publishActivity(next) }
  }
  async function viewRelease(releaseId: string) {
    const generation = epoch.current
    const contentGeneration = ++contentReadEpoch.current
    const courseId = selectedCourseId
    setRelease(null); rememberMaterial(null)
    const detail = courseReleaseSchema.parse(await api('releases/' + releaseId, undefined, key))
    if (generation === epoch.current && contentGeneration === contentReadEpoch.current
      && new URLSearchParams(currentSearch.current).get('course') === courseId && detail.courseId === courseId) setRelease(detail)
  }
  async function readMaterial(releaseId: string, item: CourseMaterial) {
    const generation = epoch.current
    const contentGeneration = ++contentReadEpoch.current
    const content = courseMaterialContentSchema.parse(await api(`releases/${releaseId}/materials/${item.materialId}`, undefined, key))
    if (generation !== epoch.current || contentGeneration !== contentReadEpoch.current) return
    const binary = atob(content.contentBase64)
    const data = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index++) data[index] = binary.charCodeAt(index)
    const url = URL.createObjectURL(new Blob([data], { type: content.mediaType }))
    rememberMaterial({ title: content.title, url })
  }

  async function disconnectSchool(schoolKey: string) {
    const authentication = ++authEpoch.current
    await protectActivity()
    await api('connections/revoke', { connectionId: schoolKey.slice(7) }, schoolKey)
    if (authentication !== authEpoch.current) return
    if (currentView.current.key === schoolKey) await protectActivity()
    const current = currentView.current.context
    if (authentication !== authEpoch.current || !current) return
    const next = { ...current, account: null, identities: current.identities.filter(item => item.key !== schoolKey) }
    try { sessionStorage.setItem('xj.works-context.v1', JSON.stringify(next)) } catch { /* Optional hint. */ }
    setContext(next)
    if (currentView.current.key === schoolKey) {
      const nextKey = next.identities.some(item => item.key === 'personal') ? 'personal' : next.identities[0]?.key ?? ''
      const params = new URLSearchParams(currentSearch.current)
      params.delete('activity'); params.delete('artifact'); params.delete('course')
      if (nextKey) params.set('space', nextKey)
      else params.delete('space')
      const search = params.toString()
      approvedSearch.current = search ? '?' + search : ''
      navigate({ pathname: route.pathname, search })
      ++epoch.current
      setOpened(null); setActivities(null); setCatalog(null); setRelease(null); rememberMaterial(null); setCoursePending(null)
      setKey(nextKey); setBusy(false); setReload(value => value + 1)
    }
  }

  function confirmDisconnect() {
    if (!disconnectTarget || disconnectPending.current || busy) return
    const target = disconnectTarget
    disconnectPending.current = true
    setDisconnectError('')
    void action(async () => {
      try {
        await disconnectSchool(target.key)
        setDisconnectTarget(null)
        if (target.replace) {
          setPendingConnection(null); schoolStartRequest.current = null
          openSchoolForm(disconnectSection.current)
        }
      } catch (cause) {
        setDisconnectError(errorText(cause))
      } finally {
        disconnectPending.current = false
      }
    })
  }

  const schoolIdentities = context?.identities.filter(item => item.identity.kind === 'school') ?? []
  function openSchoolForm(section: HTMLElement | null) {
    setError(''); setSchoolFormOpen(true)
    requestAnimationFrame(() => section?.querySelector<HTMLInputElement>('.product-school-connect-form input')?.focus())
  }
  async function authenticateSchoolClient() {
    if (!authorize) return false
    const returnUrl = schoolAuthorizationReturnUrl(authorize, new URLSearchParams(location.search).get('returnTo'))
    await api('connections/approve', { requestId: authorize })
    if (returnToSchoolClient(returnUrl)) return true
    const params = new URLSearchParams(location.search)
    params.delete('authorize'); params.delete('returnTo')
    navigate({ pathname: route.pathname, search: params.toString() }, { replace: true })
    setNotice('学校认证已完成，请返回原客户端完成连接。')
    return false
  }
  const schoolConnectionForm = pendingConnection ? <div className="product-school-pending">
    <p role="status">{pendingConnection.connectionId ? '学校认证已完成，请重新读取连接。' : pendingConnection.authenticated
      ? '学校认证已完成，点击下方按钮完成连接。' : '请在学校页面完成认证，然后返回这里完成连接。'}</p>
    <div className="product-school-actions">
      <button type="button" className="primary" disabled={busy} aria-busy={busy || undefined} onClick={() => void action(async generation => {
        let connectionId = pendingConnection.connectionId
        if (!connectionId) {
          const connection = await api('client/complete', { requestId: pendingConnection.requestId }) as { connectionId: string }
          if (generation !== epoch.current) return
          connectionId = connection.connectionId
          rememberPendingConnection({ ...pendingConnection, connectionId })
        }
        if (await refreshContext('school:' + connectionId, generation)) {
          rememberPendingConnection(null); setSchoolFormOpen(false); setSchoolEndpoint('')
          toast.success('学校已连接。')
        }
      })}>{busy ? pendingConnection.connectionId ? '正在读取连接…' : '正在完成连接…'
        : pendingConnection.connectionId ? '重新读取连接' : '已完成认证，连接学校'}</button>
      {!pendingConnection.connectionId && <a className="outline product-school-auth-link" href={pendingConnection.authorizationUrl} target="_blank" rel="noreferrer">重新打开学校认证页面</a>}
    </div>
    {!pendingConnection.connectionId && <button type="button" className="product-school-text-action" disabled={busy} onClick={event => {
      rememberPendingConnection(null); openSchoolForm(event.currentTarget.closest<HTMLElement>('.product-school'))
    }}>重新填写学校链接</button>}
  </div> : schoolFormOpen ? <form className="product-school-form product-school-connect-form" onSubmit={event => { event.preventDefault(); void action(async () => {
    const request = schoolStartRequest.current?.schoolEndpoint === schoolEndpoint
      ? schoolStartRequest.current : { requestId: crypto.randomUUID(), schoolEndpoint }
    schoolStartRequest.current = request
    const pending = await api('client/start', request) as PendingConnection
    schoolStartRequest.current = null
    rememberPendingConnection(pending)
  }) }}>
    <label>学校链接<TextInput type="url" autoComplete="url" required placeholder="https://school.example.edu" value={schoolEndpoint} onChange={event => setSchoolEndpoint(event.target.value)} /></label>
    <div className="product-school-actions">
      <Button type="submit" disabled={busy} aria-busy={busy || undefined}>{busy ? '正在连接…' : '连接'}</Button>
      <Button type="button" variant="outline" disabled={busy} onClick={event => {
        const section = event.currentTarget.closest<HTMLElement>('.product-school')
        setError(''); setSchoolFormOpen(false)
        requestAnimationFrame(() => section?.querySelector<HTMLButtonElement>('.product-school-add')?.focus())
      }}>取消</Button>
    </div>
  </form> : <Button type="button" variant="outline" className="product-school-add" disabled={busy}
    onClick={event => openSchoolForm(event.currentTarget.closest<HTMLElement>('.product-school'))}>
      <span className="product-school-add-icon"><Icon name="add" size={22} /></span>
      <span>添加学校</span>
    </Button>
  const schoolControls = context && <section className="product-school" tabIndex={-1} aria-busy={busy || undefined}><h2>学校连接</h2>
      {context.profile !== 'school' && (schoolIdentities.length > 0 ? <div className="product-school-list">
        {schoolIdentities.map(item => <div className="product-school-row" key={item.key}>
          <div className="product-school-name"><span className="product-school-icon"><Icon name="link" size={18} /></span>
            <div><strong>{context.account?.schoolName ?? item.identity.name}</strong><span className="product-school-status">已绑定</span></div></div>
          <div className="product-school-row-actions">
          {!schoolFormOpen && !pendingConnection && <button type="button" className="product-school-rebind" disabled={busy}
            onClick={event => {
              disconnectTrigger.current = event.currentTarget
              disconnectSection.current = event.currentTarget.closest<HTMLElement>('.product-school')
              setDisconnectError(''); setDisconnectTarget({ key: item.key, name: context.account?.schoolName ?? item.identity.name, replace: true })
            }}>换绑学校</button>}
          {item.key.startsWith('school:') && <button type="button" className="product-school-disconnect" aria-label={`断开${item.identity.name}的连接`} disabled={busy}
            onClick={event => {
              disconnectTrigger.current = event.currentTarget
              disconnectSection.current = event.currentTarget.closest<HTMLElement>('.product-school')
              setDisconnectError(''); setDisconnectTarget({ key: item.key, name: item.identity.name })
            }}>断开连接</button>}
          </div>
        </div>)}
      </div> : schoolConnectionForm)}
      {context.profile !== 'school' && schoolIdentities.length > 0 && (schoolFormOpen || pendingConnection) && schoolConnectionForm}
      {context.identities.some(item => item.key === 'school') ? <div className="product-school-session"><span className="product-school-status">已登录此学校</span><button type="button" className="outline" disabled={busy} onClick={() => void action(async () => {
        const authentication = ++authEpoch.current
        await protectActivity()
        await api('logout', {}); if (authentication !== authEpoch.current) return
        // Authentication outlives a view switch; a later login still supersedes this response.
        if (currentView.current.key === 'school') await protectActivity()
        if (authentication !== authEpoch.current || !currentView.current.context) return
        ++authEpoch.current
        const signedOut = { ...currentView.current.context, account: null, identities: currentView.current.context.identities.filter(item => item.key !== 'school') }
        // The logout response already confirms this fact; clearing it must not depend on a later context request.
        try { sessionStorage.setItem('xj.works-context.v1', JSON.stringify(signedOut)) } catch { /* Optional hint. */ }
        setContext(signedOut)
        if (currentView.current.key === 'school') {
          const nextKey = signedOut.identities.some(item => item.key === 'personal') ? 'personal' : signedOut.identities[0]?.key ?? ''
          rememberActivity(null, nextKey); setActivities(null); setCatalog(null); setRelease(null); rememberMaterial(null); setCoursePending(null)
          setKey(nextKey)
          setReload(value => value + 1)
        }
      })}>{busy ? '正在退出…' : '退出学校登录'}</button></div> : null}
    </section>
  const selectedCourse = catalog?.find(course => course.courseId === selectedCourseId)
  const visibleRelease = release?.courseId === selectedCourseId ? release : null
  const visibleActivities = activitiesFor === pendingKey ? activities : null
  const changePage = (page: 'home' | 'agent') => void action(async () => {
    await protectActivity()
    const params = new URLSearchParams(currentSearch.current)
    params.delete('activity'); params.delete('course'); params.delete('settings'); params.delete('artifact')
    if (page === 'agent') params.set('view', 'agent')
    else params.delete('view')
    const nextKey = page === 'agent' ? personalKey ?? key : key
    if (nextKey) params.set('space', nextKey)
    else params.delete('space')
    const search = params.toString()
    approvedSearch.current = search ? '?' + search : ''
    navigate({ pathname: route.pathname, search })
    ++epoch.current; setBusy(false)
    setOpened(null); setRelease(null); rememberMaterial(null)
    if (nextKey !== key) setKey(nextKey)
  })
  const goHome = () => changePage('home')
  const openAgent = () => { prepareAgent(); changePage('agent') }
  const openSettings = (tab: ProductSettingsTab | 'school' = 'account') => void action(async () => {
    void loadModelSettings().catch(() => {})
    // Warm the personal skill catalog so the Agent pane opens from cache instead of a cold read.
    if (context && identity) void readCache.read(key, skillCatalogCacheKey(context.clientNamespace, identity),
      () => learningSubjectRequest(identity, key, context.clientNamespace, 'skills').then(value => skillCatalogSchema.parse(value)),
      { maxAgeMs: 0 }).catch(() => {})
    await protectActivity()
    const params = new URLSearchParams(currentSearch.current); params.set('settings', tab)
    const search = params.toString()
    approvedSearch.current = search ? '?' + search : ''
    navigate({ pathname: route.pathname, search })
  })
  const openModels = () => openSettings('models')
  const openWorkspace = (artifactId?: string) => action(async () => {
    await protectActivity()
    const params = new URLSearchParams(currentSearch.current); params.delete('view')
    if (artifactId) params.set('artifact', artifactId)
    else params.delete('artifact')
    const search = params.toString()
    approvedSearch.current = search ? '?' + search : ''
    navigate({ pathname: route.pathname, search })
  })
  const closeModels = () => {
    const params = new URLSearchParams(currentSearch.current); params.delete('settings')
    const search = params.toString()
    // Settings keeps the protected activity mounted; returning changes visibility only.
    approvedSearch.current = search ? '?' + search : ''
    navigate({ pathname: route.pathname, search })
  }
  const selectSettingsTab = (tab: ProductSettingsTab) => {
    const params = new URLSearchParams(currentSearch.current); params.set('settings', tab)
    const search = params.toString()
    approvedSearch.current = search ? '?' + search : ''
    navigate({ pathname: route.pathname, search })
  }
  const settingsTab: ProductSettingsTab = settingsPage === 'privacy' ? 'about'
    : settingsPage === 'models' || settingsPage === 'agent'
      || settingsPage === 'portrait' || settingsPage === 'about' ? settingsPage : 'account'
  const conversationOpen = !!opened && agentOpen && identity?.kind === 'personal' && !opened.course
  const archivedCount = visibleActivities?.filter(activity => !activity.course && conversationHistory.archivedIds.includes(activity.activityId)).length ?? 0
  async function changeConversationVisibility(id: string, remove: boolean) {
    let saved = false
    await action(async generation => {
      const wasOpen = currentView.current.opened?.activityId === id
      if (wasOpen) {
        await protectActivity()
        if (generation !== epoch.current || currentView.current.opened?.activityId !== id) return
      }
      saved = await (remove ? conversationHistory.remove(id) : conversationHistory.setArchived(id, true))
      if (saved && wasOpen && generation === epoch.current && currentView.current.opened?.activityId === id) rememberActivity(null)
    })
    return saved
  }
  if (schoolLoginRequired) return <SessionLogin entryRole="student" loginName={loginName} password={password}
    busy={busy} logoutFailed={false} accountRef={schoolAccount}
    description={authorize ? '使用学校账号登录并认证，完成后将返回客户端。' : '使用学校账号登录，继续你的学习。'}
    submitLabel={authorize ? '登录并认证' : undefined}
    onLoginNameChange={setLoginName} onPasswordChange={setPassword}
    onSubmit={() => void action(async generation => {
      ++authEpoch.current
      await api('login', { loginName, password }); if (generation !== epoch.current) return
      setPassword('')
      if (authorize) {
        try { if (await authenticateSchoolClient()) return }
        catch (cause) {
          // Refresh establishes the signed-in view and retires the old action
          // generation. Keep the approval failure visible on that new view.
          if (await refreshContext('school', generation)) toast.error(errorText(cause))
          return
        }
      }
      await refreshContext('school', generation)
    })}
    onRetryLogout={() => void action(async generation => { await refreshContext(undefined, generation) })}
    onRestoreSession={() => void action(async generation => { await refreshContext(undefined, generation) })} />

  return <ProductShell immersive={!modelsOpen && (opened ? !conversationOpen : !!routeActivityId && !agentOpen)} accountName={accountName}
    active={modelsOpen ? 'settings' : agentOpen ? 'agent' : 'home'}
    onHome={goHome} onAgent={openAgent} onSettings={() => openSettings()} onProfile={() => setProfileOpen(true)}
    onAgentIntent={prepareAgent}
    archivedCount={archivedCount} archiveOpen={archiveOpen} onArchiveOpenChange={setArchiveOpen}
    agentHistory={(close, visible) => <ProductConversationHistory activities={key === personalKey ? visibleActivities?.filter(activity => !activity.course) ?? null : []} activeId={opened?.activityId}
      labels={conversationHistory.items} archiveOpen={archiveOpen} query={historyQuery} error={conversationHistory.error}
      ready={conversationHistory.ready} busy={conversationHistory.busy || busy} onRetry={conversationHistory.retry}
      scopeKey={pendingKey} visible={visible} readOnly={!!context?.readOnly || !contextVerified}
      onNew={() => { close(); setArchiveOpen(false); openAgent() }} onOpen={id => { close(); void action(() => openActivity(id, true)) }}
      onArchiveOpenChange={setArchiveOpen} onQueryChange={setHistoryQuery}
      onArchive={id => changeConversationVisibility(id, false)} onDelete={id => changeConversationVisibility(id, true)}
      onRename={conversationHistory.rename} onPin={conversationHistory.setPinned}
      onRestore={id => conversationHistory.setArchived(id, false)} />}>
    <ConfirmationDialog open={!!disconnectTarget} title={disconnectTarget?.replace ? '换绑学校？' : '断开学校连接？'}
      description={<>{disconnectTarget?.replace && '先解绑当前账号，再绑定新的学校账号。'}断开后，将无法在此访问<strong>「{disconnectTarget?.name}」</strong>的学习内容。{disconnectTarget?.key === key && context?.identities.some(item => item.key === 'personal') && '你将返回本地学习空间。'}本机数据会保留，重新绑定原账号后可继续学习。</>}
      confirmLabel={disconnectTarget?.replace ? '确认解绑并换绑' : '确认断开'} busy={busy} error={disconnectError}
      onClose={() => { setDisconnectTarget(null); setDisconnectError('') }} onConfirm={confirmDisconnect}
      onReturnFocus={() => {
        requestAnimationFrame(() => {
          if (disconnectTrigger.current?.isConnected) disconnectTrigger.current.focus()
          else (disconnectSection.current?.querySelector<HTMLElement>('.product-school-add, input') ?? disconnectSection.current)?.focus()
        })
      }} />
    {profileOpen && <ProductProfile accountName={accountName} schoolName={context?.account?.schoolName}
      onClose={() => setProfileOpen(false)} onSettings={() => { setProfileOpen(false); openSettings() }} />}
    {modelsOpen && <ProductSettings accountName={accountName} onBack={closeModels}
      accountState={context ? { status: 'ready' } : error
        ? { status: 'error', busy, message: error, onRetry: () => void action(async generation => { await refreshContext(undefined, generation) }) }
        : { status: 'loading' }} readOnly={!!context?.readOnly}
      accountFeedback={error && (schoolFormOpen || pendingConnection) ? <SettingsStatus tone="error"
        title="学校连接未完成" description={error} /> : undefined}
      initialTab={settingsTab} focusSchool={settingsPage === 'school'} onTabChange={selectSettingsTab}
      schoolName={context?.account?.schoolName} isLocal={!!context && !context.account}
      schoolControls={schoolControls ?? (error ? <button type="button" className="outline" onClick={() => void action(async generation => { await refreshContext(undefined, generation) })}>重新连接</button> : null)}
      modelSettings={context && identity ? <SettingsFailureBoundary key={context.clientNamespace + key + identity.principalId} onBack={closeModels}>
        <Suspense fallback={<SettingsStatus tone="loading" title="正在读取个人设置" />}><PersonalModelSettings
        identity={identity} spaceKey={key} namespace={context.clientNamespace} onBack={closeModels} selection={modelSelection}
        readOnly={context.readOnly} activityId={opened?.activityId} courseId={opened?.course?.courseId} cache={readCache} /></Suspense>
      </SettingsFailureBoundary> : null} />}
    {context && identity && opened ? <div style={{ display: modelsOpen ? 'none' : 'contents' }} inert={modelsOpen} aria-hidden={modelsOpen || undefined}>
      <Suspense fallback={<div className="content" role="status" aria-label="正在打开学习活动" />}>
      <ActivityReferences key={context.clientNamespace + key + opened.activityId}
      activity={opened} spaceKey={key} namespace={context.clientNamespace} authorized={activityAuthorized} readOnly={context.readOnly} viewActive={!modelsOpen} readCache={readCache}>
      {conversationOpen ? <ProductConversation activity={opened} spaceKey={key} namespace={context.clientNamespace} selection={modelSelection}
        title={conversationTitle(opened, conversationHistory.items)}
        authorized={activityAuthorized}
        workspaceRef={workspace} onWorkspace={openWorkspace} onModels={openModels} /> : <ActivityPage activity={opened} spaceKey={key} namespace={context.clientNamespace} authorized={activityAuthorized} selection={modelSelection}
        requestedArtifactId={requestedArtifactId}
        nativeAvailable={context.profile === 'local'}
        workspaceRef={workspace} busy={busy} onBack={goHome} onStatus={() => void action(() => changeStatus(opened))}
        onRefresh={() => void action(async generation => { await refreshContext(undefined, generation) })} onModels={openModels} account={schoolControls}
        details={openCoursePdf => <>
          {opened.course ? <><CourseSections content={opened.course} level={3} busy={busy}
            requirementsContent={<CourseRequirementsReference course={opened.course} />}
            onMaterial={item => item.mediaType.toLowerCase().split(';')[0].trim() === 'application/pdf'
              ? openCoursePdf(item.materialId) : void action(() => readMaterial(opened.course!.releaseId, item))} />
            <CourseMaterialReferences activity={opened} course={opened.course} spaceKey={key} namespace={context.clientNamespace} />
          </> : <><h2>学习目标</h2><p className="preserve-lines">{opened.goal || opened.question || '资料学习'}</p>
            {opened.question && opened.goal && <><h3>起始问题</h3><p className="preserve-lines">{opened.question}</p></>}
            {opened.references.length > 0 && <><h3>学习材料</h3>{opened.references.map((item, index) => <p key={index}><a href={item.url} target="_blank" rel="noreferrer">{item.label}</a></p>)}</>}
          </>}
          {material && <p className="material-note" role="status">已读取 {material.title}：<a href={material.url} target="_blank" rel="noreferrer" download={material.title}>打开或下载材料</a></p>}
        </>} />}
    </ActivityReferences></Suspense></div> : modelsOpen ? null : unavailableRoute ? <div className="content home-page"><p>此活动属于未绑定的学校账号。请在设置中绑定原账号后打开，本机学习内容会保留。</p><Button onClick={() => openSettings('school')}>管理学校连接</Button><Button variant="outline" onClick={goHome}>返回首页</Button></div> : !context || !identity ? <div className="content home-page product-home">
      {!context && !error && <p role="status" aria-label="正在连接学习空间" />}
      {!context && error && <button type="button" className="outline" onClick={() => void action(async generation => { await refreshContext(undefined, generation) })}>重新连接</button>}
      {schoolControls}
    </div> : routeActivityId ? <div className="content" role="status">{error ? '学习活动暂时无法打开。' : ''}{error && <Button variant="outline" onClick={goHome}>返回首页</Button>}</div>
    : agentOpen && (!personalKey || key !== personalKey) ? <div className="content home-page"><p>请在本机客户端开始个人学习；学校课程请从首页进入。</p><Button onClick={goHome}>返回首页</Button></div> : agentOpen ? <Suspense fallback={<div className="content" role="status" aria-label="正在准备对话" />}><ProductAgent question={question} onQuestion={value => {
      setQuestion(value)
      try { if (draftKey) sessionStorage.setItem(draftKey, value) } catch { /* Optional draft cache. */ }
    }} onSend={() => void action(() => createActivity(question))} pending={pendingRequest}
      onRetry={() => void action(() => createActivity())} onDiscard={discardPending}
      onSettings={openModels} selection={modelSelection} busy={busy} readOnly={!!context.readOnly} /></Suspense>
    : <>
      {(context.readOnly || authorize || pendingRequest || coursePending) && <div className="content product-home-alerts">
        {context.readOnly && <p role="status" className="product-workspace-notice">这是还原校验副本，作品与学习对话只读，不会启动 Agent 或实验；请由维护者完成接管后继续。</p>}
        {authorize && <section className="product-connection" aria-labelledby="approve-title"><h2 id="approve-title">学校认证</h2>
          <p>使用当前学校账号认证，完成后返回客户端连接学校。</p>
          <button type="button" className="primary" disabled={busy || !context.identities.some(item => item.key === 'school')}
            onClick={() => void action(async () => { await authenticateSchoolClient() })}>认证并返回客户端</button>
        </section>}
        {pendingRequest && <p role="status">上次发起的学习尚未确认。 <button type="button" className="outline" onClick={openAgent}>查看原请求</button></p>}
        {coursePending && <div className="course-pending"><p>上次课程活动的请求结果尚未核对，将先查询原请求。</p>
          <button type="button" className="outline" disabled={busy} onClick={() => void action(() => startCourse(coursePending.releaseId))}>核对并继续原请求</button>
          <button type="button" className="outline" disabled={busy} onClick={discardCoursePending}>放弃这次请求</button></div>}
      </div>}
      {selectedCourseId && identity.kind === 'school' ? <div className="content home-page product-home">
        <section className="course-region" aria-labelledby="course-title">
          <div className="sectionhead"><h2 id="course-title" tabIndex={-1}>{selectedCourse?.name ?? '我的课程'}<small>{selectedCourse ? `${selectedCourse.tasks.length} 个任务` : ''}</small></h2>
            <button type="button" className="outline" onClick={() => selectCourse(null)}>全部课程</button></div>
          {catalog === null ? <p>{error ? '课程列表尚未读取成功。' : ''}</p>
            : !selectedCourse ? <p className="empty">无法找到这门课程。</p>
            : <div className="task-card-grid">{selectedCourse.tasks.map(task => <article key={task.taskId} className="product-course-task">
              <h3>{task.title}</h3>{task.summary && <p>{task.summary}</p>}
              <div className="product-release-list">{task.releases.map((item, index) => <button type="button" className="outline" key={item.releaseId} disabled={busy}
                onClick={() => void action(() => viewRelease(item.releaseId))}>{published(item.publishedAt)}{index === 0 ? ' · 最近发布' : ''}</button>)}</div>
            </article>)}</div>}
          {visibleRelease && <article className="product-release" aria-labelledby="release-title"><h3 id="release-title">{visibleRelease.taskTitle}</h3>
            <CourseSections content={visibleRelease} level={4} busy={busy} onMaterial={item => void action(() => readMaterial(visibleRelease.releaseId, item))} />
            {material && <p role="status">已读取 {material.title}：<a href={material.url} target="_blank" rel="noreferrer" download={material.title}>打开或下载材料</a></p>}
            <button type="button" className="primary" disabled={busy || !!coursePending || context.readOnly} onClick={() => void action(() => startCourse(visibleRelease.releaseId))}>从这一版本开始活动</button>
          </article>}
        </section>
      </div> : <ProductHome accountName={accountName} personalActivities={visibleHome?.personal ?? null} schoolActivities={visibleHome?.school ?? null}
        courses={visibleHome?.courses ?? null} personalKey={personalKey} schoolKey={schoolKey}
        initialCategory={schoolKey ? 'school' : 'personal'} dashboardKey={(context.clientNamespace + ':home-dashboard')}
        busy={busy} personalError={visibleHome?.personalError} schoolError={visibleHome?.schoolError}
        onOpenActivity={(id, source) => void action(() => openActivity(id, source === personalKey, source))} onOpenCourse={selectCourse}
        onStartConversation={openAgent} onConnectSchool={() => openSettings('school')}
        onRefresh={() => void action(async generation => { await refreshContext(undefined, generation) })} />}
    </>}
  </ProductShell>
}
