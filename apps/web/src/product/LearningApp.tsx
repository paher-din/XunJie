import { usePersonalProjectTitles } from './PersonalProjectPlan'
import { sessionInputProtection } from '../reliable-workspace/input-protection'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { activitySchema, courseActivityResultSchema } from '@xunjie/contracts/learning-data'
import type { LearningActivity, CourseActivityResult } from '@xunjie/contracts/learning-data'
import { courseCatalogSchema, courseReleaseSchema, courseMaterialContentSchema, createCourseActivitySchema } from '@xunjie/contracts/courses'
import type { Course, CourseRelease, CourseMaterial } from '@xunjie/contracts/courses'
import { schoolSubmissionListSchema } from '@xunjie/contracts/school-deliveries'
import { spaceIdentitySchema, type SpaceIdentity } from '@xunjie/contracts/spaces'
import { Button, ConfirmationDialog, SelectField, SessionLogin } from '@xunjie/ui/foundation'
import { WorkspaceResourceList, WorkspaceResourceRow, WorkspaceTaskIntro } from '@xunjie/ui/workspace'
import { Icon, IconText } from '@xunjie/ui/icons'
import { useTheme } from '../lib/theme'
import { formatDeadline } from '../lib/tasks'
import './product.css'
import './course-ui.css'
import type { ActivityWorkspaceHandle } from './ActivityWorkspace'
import { ProductShell } from '../components/ProductShell'
import { useModelSelection } from './ModelSelection'
import { ProductHome } from './ProductHome'
import { courseReleaseDate, courseTaskEntry, courseTaskProgress, type CourseTaskSelection } from './SchoolCourseTasks'
import { HomeNavigationProvider } from '../lib/homeCourseNavigation'
import { ProductConversationHistory } from './ProductConversationHistory'
import { ProductSettings, type ProductSettingsTab } from './ProductSettings'
import { SettingsFailureBoundary } from './SettingsFailureBoundary'
import { ProductProfile } from './ProductProfile'
import { SchoolConnectionRow, SchoolSessionRow } from './SchoolConnectionRows'
import { loadTeacherCatalog } from '../teacher-space/data'
import { clearTeacherCache } from '../teacher-space/teacher-cache'
import { Toaster, toast, useToastFeedback } from '@xunjie/ui/feedback'
import { SettingsStatus, TextInput } from '@xunjie/ui/settings'
import { createBrowserRouter, RouterProvider, useBlocker, useLocation, useNavigate } from 'react-router-dom'
import { LearningReadCache } from './learning-read-cache'
import { skillCatalogCacheKey, skillCatalogSchema } from './skills'
import { learningSubjectRequest } from './learningTransport'
import { useAgentSessionHistory } from './useAgentSession'
import type { AgentSession } from '@xunjie/contracts/agent-sessions'
import type { ExperimentReference } from './experiment-reference'
import type { CourseCitationDocument, CourseCitationLocation } from './ProductAgent'
import { isCoursePdf } from './CourseMaterials'
import { cacheableMaterial } from '../component-preparation/materials'
import { startSchoolAuthorization, rememberSchoolConnection, restoreSchoolConnection, schoolAuthorizationReturnUrl, returnToSchoolClient,
  type PendingSchoolConnection } from './school-authorization'

const loadActivityPage = () => import('./ActivityPage')
const loadReferences = () => import('./ActivityReferences')
const loadAgent = () => import('./ProductAgent')
const loadModelSettings = () => import('./PersonalModelSettings')
const prepareAgent = () => { void loadAgent().catch(() => {}) }
const ProductAgent = lazy(() => loadAgent().then(module => ({ default: module.ProductAgent })))
const ActivityPage = lazy(() => loadActivityPage().then(module => ({ default: module.ActivityPage })))
const ActivityReferences = lazy(() => loadReferences().then(module => ({ default: module.ActivityReferences })))
const CourseRequirementsReference = lazy(() => loadReferences().then(module => ({ default: module.CourseRequirementsReference })))
const PersonalModelSettings = lazy(() => loadModelSettings().then(module => ({ default: module.PersonalModelSettings })))

type Account = { key: string; accountName: string; schoolName: string }
type Context = { clientNamespace: string; profile: string; readOnly?: boolean; identities: { key: string; identity: SpaceIdentity }[]; account?: Account | null }

function activityBelongsTo(activity: LearningActivity, identity: SpaceIdentity) {
  return activity.identity.kind === identity.kind && activity.identity.environmentId === identity.environmentId
    && activity.identity.spaceId === identity.spaceId && activity.identity.principalId === identity.principalId
}
// Explicit null means unbound. Older servers fall back to one school identity,
// never the requested route, so a deep link cannot select a different account.
function normalizeContext(value: Context): Context {
  const schools = value.identities.filter(item => item.identity.kind === 'school')
  const school = schools[0]
  const inferSchool = !!school && (value.account === undefined || value.account === null && schools.length === 1)
  const account = inferSchool ? { key: school!.key, accountName: school!.identity.name, schoolName: school!.identity.name } : value.account
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
type HomeData = { scope: string; personal: LearningActivity[] | null; school: LearningActivity[] | null; courses: Course[] | null;
  personalError: string; courseError: string }
type CourseTaskPreview = CourseTaskSelection & { search: string; detail?: CourseRelease; error?: string; activityId?: string }

type PendingConnection = PendingSchoolConnection
type CreateCourseActivity = { requestId: string; releaseId: string }
function readCoursePending(storageKey: string): CreateCourseActivity | null {
  const saved = localStorage.getItem(storageKey)
  return saved ? createCourseActivitySchema.parse(JSON.parse(saved)) : null
}

const messages: Record<string, string> = {
  forbidden: '访问资格已失效，请重新登录或联系学校管理员。原活动仍属于原空间。',
  missing: '无法找到或无权访问这项内容，请返回列表核对。',
  'identity-conflict': '这个请求已使用其他内容，请先核对原请求结果。',
  unavailable: '暂时无法连接原服务，请稍后重试。',
  invalid: '请检查填写的内容。', maintenance: '学习服务正在维护，请稍后重试。', expired: '这次请求已过期，请重新发起。',
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
    const message = path === 'course-progress' && result.error === 'missing'
      ? '学习目标未保存。请重新打开任务，若仍无法保存，请联系学校管理员。'
      : messages[result.error] ?? '操作结果尚未确认，请核对原请求后重试。'
    const failure = new Error(message) as Error & { code?: string }
    failure.code = result.error
    throw failure
  }
  return result
}
const errorText = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请重试。'
const schoolAuthorizationError = (error: unknown) => {
  const code = (error as { code?: string })?.code
  if (code === 'expired') return new Error('学校认证请求已过期，请返回客户端重新发起认证。')
  if (code === 'forbidden') return new Error('这次认证请求不属于当前学校账号，或已被其他设备处理。请核对账号后重新发起。')
  if (code === 'missing') return new Error('学校认证请求已失效，请重新发起学校连接。')
  return error
}
const definitive = new Set(['invalid', 'forbidden', 'missing', 'corrupt', 'identity-conflict'])
const formatBytes = (value: number) => value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`

function CourseTools({ capabilities, components }: Pick<CourseRelease, 'capabilities' | 'components'>) {
  if (capabilities.length === 0) return null
  return <details className="capability-note"><summary>课程工具详情</summary>
    <ul className="course-tool-list">{capabilities.map((item, index) => {
      const bindings = item.kind === 'component' ? (components ?? []).filter(binding =>
        binding.definition.manifest.componentId === item.objectId && binding.definition.manifest.version === item.version) : []
      const names = [...new Set(bindings.map(binding => binding.configuration.title.trim() || binding.definition.manifest.title))]
      const title = names.join('、') || (item.kind === 'component' ? '学习工具' : '运行工具')
      const isAlu = bindings.some(binding => binding.definition.manifest.formatVersion === 3
        && binding.definition.manifest.runtime.adapterId === 'icarus-alu')
      const description = isAlu ? '用于观察运算结果和检查你的 ALU 实现。'
        : item.kind === 'executor' ? '用于执行本课程中的程序或检查任务。'
        : bindings.length > 0 ? '用于本课程的交互学习活动。' : '课程未提供工具名称，使用方式请查看任务要求。'
      return <li key={`${item.kind}:${item.objectId}:${item.version}:${index}`}>
        <strong className="course-tool-name">{title}</strong>
        <p className="course-tool-description">{description}{bindings.length > 0 && '使用说明和运行状态见学习工作区。'}</p>
        <details className="course-tool-technical"><summary>技术信息</summary>
          <dl>
            <div><dt>类型</dt><dd>{item.kind === 'component' ? '课程组件' : '运行工具'}</dd></div>
            <div><dt>版本</dt><dd>第 {item.version} 版</dd></div>
            <div><dt>内部编号</dt><dd><code>{item.objectId}</code></dd></div>
          </dl>
        </details>
      </li>
    })}</ul>
  </details>
}

type MaterialLocation = { releaseId: string; materialId: string }
type MaterialDownload = MaterialLocation & { title: string; url: string }
function saveMaterialFile(material: MaterialDownload) {
  const anchor = document.createElement('a')
  anchor.href = material.url; anchor.download = material.title; anchor.click()
}
function CourseInstructions({ content, busy, requirementsContent, objectiveProgress }: {
  content: Pick<CourseRelease, 'objectives' | 'requirements'>; busy: boolean
  requirementsContent?: ReactNode
  objectiveProgress?: { completed: readonly number[]; onChange?: (index: number, completed: boolean) => void }
}) {
  return <div className="course-content-main">
    <section className="course-content-section"><h3>学习目标</h3>
      <ul className={objectiveProgress ? 'course-points course-objectives' : 'course-points'}>
        {content.objectives.map((item, index) => <li key={index}>{objectiveProgress ? <label>
          <input type="checkbox" checked={objectiveProgress.completed.includes(index)} disabled={!objectiveProgress.onChange}
            aria-disabled={busy || undefined} onChange={event => {
              if (!busy) objectiveProgress.onChange?.(index, event.currentTarget.checked)
            }} />
          <span>{item}</span>
        </label> : item}</li>)}
      </ul>
    </section>
    <section className="course-content-section"><h3>任务要求</h3>
      {requirementsContent ?? <p className="preserve-lines">{content.requirements}</p>}
    </section>
  </div>
}

function CourseResources({ content, busy, onOpenMaterial, onDownload, readingMaterial, showMaterialsHeading = true }: {
  content: Pick<CourseRelease, 'releaseId' | 'materials' | 'starterWorks'>
  busy: boolean; onOpenMaterial?: (materialId: string) => void; onDownload: (item: CourseMaterial) => void
  readingMaterial: MaterialLocation | null; showMaterialsHeading?: boolean
}) {
  return <div className="course-content-resources">
    <section className="course-content-section" aria-label={showMaterialsHeading ? undefined : '学习材料'}>
      {showMaterialsHeading && <h3>学习材料</h3>}
      {content.materials.length === 0 ? <p className="detail">这个版本没有开放材料。</p>
        : <WorkspaceResourceList>{content.materials.map(item => {
          const reading = readingMaterial?.releaseId === content.releaseId && readingMaterial.materialId === item.materialId
          const canRead = onOpenMaterial && (cacheableMaterial(item.mediaType) || isCoursePdf(item.mediaType))
          return <WorkspaceResourceRow key={item.materialId} name={item.title} disabled={busy}
            onOpen={canRead ? () => onOpenMaterial(item.materialId) : undefined}
            actions={<div className="material-action" data-reading={reading} aria-live="polite">
              <span className="detail material-size">{formatBytes(item.byteLength)}</span>
              <span className="material-download">
                <Button className="material-download-trigger" type="button" variant="outline" disabled={busy}
                  aria-label={`下载 ${item.title}`} aria-disabled={reading || undefined} aria-busy={reading || undefined}
                  onClick={() => { if (!reading) onDownload(item) }}>
                  {reading ? '读取中…' : <IconText name="download-minimalistic">下载</IconText>}
                </Button>
              </span>
            </div>} />
        })}</WorkspaceResourceList>}
    </section>
    {content.starterWorks.length > 0 && <section className="course-content-section"><h3>起始作品</h3>
      <ul className="course-points">{content.starterWorks.map(work => <li key={work.workId}>
        <strong>{work.title}</strong>{work.description ? ` · ${work.description}` : ''}</li>)}</ul>
    </section>}
  </div>
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
  const routeSessionId = new URLSearchParams(route.search).get('session') ?? undefined
  const routeActivityId = new URLSearchParams(route.search).get('activity')
  const requestedArtifactId = new URLSearchParams(route.search).get('artifact')
  const requestedExperimentId = new URLSearchParams(route.search).get('experiment')
  const requestedExperimentKey = new URLSearchParams(route.search).get('component')
  const [context, setContext] = useState<Context | null>(null)
  const api = (path: string, body?: unknown, space?: string, signal?: AbortSignal) =>
    requestLearning(path, body, space, signal, context?.clientNamespace)
  const [contextVerified, setContextVerified] = useState(true)
  const [key, setKey] = useState('')
  const [activities, setActivities] = useState<LearningActivity[] | null>(null)
  const [activitiesFor, setActivitiesFor] = useState('')
  const [opened, setOpened] = useState<LearningActivity | null>(null)
  const [recordedProgress, setRecordedProgress] = useState<{ activity: LearningActivity; completed: readonly number[] }>()
  const [homeData, setHomeData] = useState<HomeData | null>(null)
  const [taskPreview, setTaskPreview] = useState<CourseTaskPreview | null>(null)
  const [taskInfoEntry, setTaskInfoEntry] = useState<HTMLButtonElement | null>(null)
  const finishTaskDocking = useCallback(() => setTaskPreview(null), [])
  const [material, setMaterial] = useState<MaterialDownload | null>(null)
  const [readingMaterial, setReadingMaterial] = useState<MaterialLocation | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
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
  const [coursePending, setCoursePending] = useState<CreateCourseActivity | null>(null)
  const [courseStart, setCourseStart] = useState<{ releaseId: string } | null>(null)
  const [notice, setNotice] = useState('')
  useToastFeedback(error)
  useToastFeedback(notice, 'success')
  const [reload, setReload] = useState(0)
  const epoch = useRef(0)
  const authEpoch = useRef(0)
  const pendingStatus = useRef(new Set<string>())
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
  const reopenAfterReconnect = useRef<string | null>(null)
  async function protectActivity() {
    await sessionInputProtection.leave()
    if (!currentView.current.opened) return
    if (!workspace.current) throw new Error('活动仍在准备，暂时无法保护当前内容。')
    await workspace.current.leave()
  }
  const returnFocus = useRef<{ key: string; activityId: string; scrollTop: number } | null>(null)
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    if (approvedSearch.current === nextLocation.search && !sessionInputProtection.hasPending()) { approvedSearch.current = null; return false }
    return (!!currentView.current.opened || sessionInputProtection.hasPending()) && currentLocation.search !== nextLocation.search
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
    if (!activity || activity.activityId !== url.searchParams.get('activity') || nextKey && nextKey !== key) {
      url.searchParams.delete('artifact')
      url.searchParams.delete('experiment')
      url.searchParams.delete('component')
    }
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
    const params = new URLSearchParams(currentSearch.current)
    if (courseId) {
      if (!context?.account) return
      params.set('space', context.account.key); params.delete('view'); params.delete('activity'); params.delete('artifact'); params.delete('session')
      params.set('course', courseId)
    }
    else params.delete('course')
    navigate({ pathname: route.pathname, search: params.toString() })
    setTaskPreview(null); rememberMaterial(null)
  }
  const materialUrl = useRef('')
  const authorize = new URLSearchParams(location.search).get('authorize')
  const [authorizationState, setAuthorizationState] = useState<'checking' | 'pending' | 'expired' | 'missing' | 'approved' | 'error'>(authorize ? 'checking' : 'pending')
  const [authorizationAttempt, setAuthorizationAttempt] = useState(0)
  let authorizationReturnUrl: string | null = null
  if (authorize) {
    try { authorizationReturnUrl = schoolAuthorizationReturnUrl(authorize, new URLSearchParams(location.search).get('returnTo')) }
    catch { /* The client is still reachable from the tab that opened this page. */ }
  }
  const identity = context?.identities.find(item => item.key === key)?.identity
  const accountName = context ? context.account?.accountName ?? '本地学习空间' : '本地学习空间'
  const personalKey = context?.identities.find(item => item.identity.kind === 'personal')?.key
  const schoolKey = context?.account?.key
  useEffect(() => {
    if (!context?.account?.key || authorize || context.profile === 'school') return
    let alive = true
    // Teacher accounts own the teacher workspace; this also covers a completed login/binding.
    loadTeacherCatalog(context.clientNamespace, context.account.key)
      .then(value => { if (alive && value.available) location.replace('/?teacher=overview') })
      .catch(() => {})
    return () => { alive = false }
  }, [context?.account?.key, context?.clientNamespace, context?.profile, authorize])
  useEffect(() => {
    if (!authorize) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()
    const abort = setTimeout(() => controller.abort(), 10000)
    setAuthorizationState('checking')
    void api('connections/status?requestId=' + encodeURIComponent(authorize), undefined, undefined, controller.signal).then(value => {
      if (!alive) return
      const status = value as { state?: unknown; expiresAt?: unknown }
      const state = status.state === 'pending' || status.state === 'approved' || status.state === 'expired' || status.state === 'missing'
        ? status.state : 'error'
      setAuthorizationState(state)
      if (state === 'pending' && typeof status.expiresAt === 'string') {
        const remaining = new Date(status.expiresAt).getTime() - Date.now()
        if (remaining <= 0) setAuthorizationState('expired')
        else timer = setTimeout(() => { if (alive) setAuthorizationState('expired') }, remaining)
      }
    }).catch(() => { if (alive) setAuthorizationState('error') })
    return () => { alive = false; clearTimeout(abort); if (timer) clearTimeout(timer); controller.abort() }
  }, [authorize, authorizationAttempt])
  const readTaskSubmission = useCallback(async (activity: LearningActivity, signal: AbortSignal) => {
    const binding = activity.course
    if (!schoolKey || !binding) throw new Error('无法核对任务提交状态。')
    const { submissions } = schoolSubmissionListSchema.parse(await requestLearning(
      'submissions/' + activity.activityId, undefined, schoolKey, signal, context?.clientNamespace))
    return submissions.some(receipt => receipt.scope.activityId === activity.activityId
      && receipt.scope.principalId === activity.identity.principalId
      && receipt.course.releaseId === binding.releaseId && receipt.course.contentDigest === binding.contentDigest)
  }, [context?.clientNamespace, schoolKey])
  const schoolLoginRequired = context?.profile === 'school' && !context.identities.some(item => item.key === 'school')
  useEffect(() => { if (schoolLoginRequired) schoolAccount.current?.focus() }, [schoolLoginRequired])
  const routeSpace = new URLSearchParams(route.search).get('space')
  const unavailableRoute = !!context && !!(new URLSearchParams(route.search).get('activity') || selectedCourseId) && !!routeSpace
    && !knownSpaceKey(context, routeSpace, new URLSearchParams(route.search).get('activity'))
  const modelSelection = useModelSelection(identity, key, context?.clientNamespace ?? '')
  const pendingKey = context && identity ? `xj.activity-request.${context.clientNamespace}.${identity.environmentId}.${identity.spaceId}.${identity.principalId}` : ''
  const personalIdentity = context?.identities.find(item => item.key === personalKey)?.identity
  const conversationHistory = useAgentSessionHistory(context && personalIdentity && personalKey
    ? { identity: personalIdentity, spaceKey: personalKey, namespace: context.clientNamespace } : undefined, contextVerified)
  const coursePendingKey = context && identity?.kind === 'school'
    ? `xj.course-activity-request.${context.clientNamespace}.${identity.environmentId}.${identity.spaceId}.${identity.principalId}` : ''
  const activityAuthorized = !!opened && !!identity && contextVerified && activityBelongsTo(opened, identity)

  useEffect(() => { setArchiveOpen(false); setHistoryQuery('') }, [pendingKey])

  function rememberMaterial(next: MaterialDownload | null) {
    if (materialUrl.current) URL.revokeObjectURL(materialUrl.current)
    materialUrl.current = next?.url ?? ''
    setMaterial(next)
    setReadingMaterial(null)
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
    rememberActivity(null, nextKey); setActivities(null); setTaskPreview(null); rememberMaterial(null)
    try { sessionStorage.setItem('xj.works-context.v1', JSON.stringify(next)) } catch { /* Optional reopening hint only. */ }
    setContextVerified(true)
    setContext(next)
    setReload(value => value + 1)
    setKey(nextKey)
    return true
  }
  useEffect(() => {
    let disposed = false
    void api('context').then(async result => {
      const next = normalizeContext(result as Context)
      // Resolve the teacher surface before the student shell mounts. Redirecting
      // after rendering makes a direct visit visibly flash the student home first.
      // A school authorization request must stay on this page so the approval
      // action is reachable even when the account is already signed in.
      // The school runtime only ships LearningApp; redirecting it to ?teacher
      // would reload forever because that entry never mounts TeacherSpace.
      if (next.account?.key && !authorize && next.profile !== 'school') {
        try {
          const catalog = await loadTeacherCatalog(next.clientNamespace, next.account.key)
          if (disposed) return
          if (catalog.available) { location.replace('/?teacher=overview'); return }
        } catch { /* A failed probe keeps the student surface available. */ }
      }
      if (!disposed) { setContext(next);
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
        reopenAfterReconnect.current = requestedActivity.current
        setContext(next); setContextVerified(true); setReload(n => n + 1)
        setKey(old => next.identities.some(i => i.key === old) ? old : next.identities[0]?.key ?? '')
        try { sessionStorage.setItem('xj.works-context.v1', JSON.stringify(next)) } catch { /* Optional hint. */ }
      }).catch(() => {}).finally(() => { checking = false })
    }, 3000)
    return () => clearInterval(timer)
  }, [contextVerified, context, opened])
  const homeVisible = !agentOpen && !modelsOpen && !new URLSearchParams(route.search).has('activity') && !unavailableRoute
  const homeScope = context ? JSON.stringify([context.clientNamespace, context.identities]) : ''
  const readCache = useMemo(() => new LearningReadCache(), [homeScope, reload, contextVerified])
  const activityView = useRef({ homeScope, readCache, key, pendingKey })
  activityView.current = { homeScope, readCache, key, pendingKey }
  const readActivities = (space: string) => readCache.read<LearningActivity[]>(space, 'activities', async () =>
    (await api('activities', undefined, space) as unknown[]).map(item => activitySchema.parse(item)))
  const readCourses = (space: string, refresh: boolean) => readCache.read<Course[]>(space, 'courses', async () =>
    courseCatalogSchema.parse(await api('courses', undefined, space)).courses, { maxAgeMs: refresh ? 0 : undefined })
  function publishActivity(activity: LearningActivity, space = key) {
    const view = activityView.current
    if (view.homeScope !== homeScope) return
    const cache = view.readCache
    cache.set(space, 'activities/' + activity.activityId, activity)
    const previous = cache.peek<LearningActivity[]>(space, 'activities') ?? readCache.peek<LearningActivity[]>(space, 'activities') ?? []
    const next = [activity, ...previous.filter(item => item.activityId !== activity.activityId)]
    cache.set(space, 'activities', next)
    if (view.key === space) {
      setActivities(next)
      setActivitiesFor(view.pendingKey)
    }
    setHomeData(previous => previous?.scope === homeScope ? { ...previous,
      ...(space === personalKey ? { personal: next } : { school: next }) } : previous)
  }
  useEffect(() => {
    if (modelsOpen) {
      void loadModelSettings().catch(() => {})
    } else if (routeActivityId) {
      void Promise.all([loadReferences(), loadActivityPage()]).catch(() => {})
    } else if (agentOpen) prepareAgent()
  }, [routeActivityId, agentOpen, modelsOpen, settingsPage])
  useEffect(() => {
    if (!context || !homeVisible) return
    const controller = new AbortController()
    const snapshot: HomeData = { scope: homeScope,
      personal: personalKey ? readCache.peek(personalKey, 'activities') ?? null : [],
      school: schoolKey ? readCache.peek(schoolKey, 'activities') ?? null : [],
      courses: schoolKey ? readCache.peek(schoolKey, 'courses') ?? null : [], personalError: '', courseError: '' }
    setHomeData(previous => previous?.scope === homeScope ? { ...previous, personalError: '', courseError: '' } : snapshot)
    const update = (patch: Partial<HomeData>) => {
      if (!controller.signal.aborted) setHomeData(previous => previous?.scope === homeScope ? { ...previous, ...patch } : previous)
    }
    if (personalKey) void readActivities(personalKey).then(value => {
      update({ personal: value })
    }).catch(cause => update({ personalError: errorText(cause) }))
    if (schoolKey) {
      void readActivities(schoolKey).then(value => {
        update({ school: value })
      }).catch(() => { /* Keep course status unknown when its activities cannot be read. */ })
      void readCourses(schoolKey, !!selectedCourseId).then(value => {
        update({ courses: value })
      }).catch(cause => update({ courseError: errorText(cause) }))
    }
    return () => controller.abort()
  }, [homeVisible, readCache, selectedCourseId])
  const visibleHome = homeData?.scope === homeScope ? homeData : null
  const projectTitles = usePersonalProjectTitles(visibleHome?.personal ?? null, personalKey, context?.clientNamespace ?? '', contextVerified)

  useEffect(() => {
    const target = returnFocus.current
    if (opened || !homeVisible || !visibleHome || !target || target.key !== key) return
    const frame = requestAnimationFrame(() => {
      const button = document.querySelector<HTMLButtonElement>(`[data-activity-id="${CSS.escape(target.activityId)}"]`)
      if (!button) return
      button.focus({ preventScroll: true })
      const main = document.querySelector('.main')
      if (main) main.scrollTop = target.scrollTop
      returnFocus.current = null
    })
    return () => cancelAnimationFrame(frame)
  }, [opened, homeVisible, visibleHome, key])

  useEffect(() => {
    ++epoch.current
    const controller = new AbortController()
    const restoreCoursePending = (event?: StorageEvent) => {
      if (!coursePendingKey || event && event.key !== coursePendingKey) return
      try { setCoursePending(readCoursePending(coursePendingKey)) }
      catch { setError('无法读取上次课程活动请求，请检查浏览器存储。') }
    }
    const retire = () => {
      ++epoch.current
      controller.abort()
      window.removeEventListener('storage', restoreCoursePending)
    }
    setActivities(readCache.peek(key, 'activities') ?? null); setActivitiesFor(pendingKey)
    setOpened(null); setTaskPreview(null); setCoursePending(null); rememberMaterial(null)
    setError(''); setBusy(false)
    if (coursePendingKey) {
      restoreCoursePending()
      window.addEventListener('storage', restoreCoursePending)
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
        return retire
      }
    }
    return retire
  }, [key, pendingKey, coursePendingKey, reload, contextVerified])

  useEffect(() => {
    if (!key || !pendingKey || !contextVerified || modelsOpen) return
    let active = true
    void readActivities(key).then(value => {
      if (active) { setActivities(value); setActivitiesFor(pendingKey) }
    }).catch(cause => { if (active) setError(errorText(cause)) })
    return () => { active = false }
  }, [key, pendingKey, contextVerified, modelsOpen, agentOpen, homeVisible, readCache])

  useEffect(() => {
    ++contentReadEpoch.current
    ++actionEpoch.current
    setBusy(false)
    setCourseStart(null)
    setTaskPreview(null); rememberMaterial(null)
  }, [selectedCourseId, key])

  useEffect(() => {
    const activityId = new URLSearchParams(route.search).get('activity')
    setTaskPreview(current => current && (current.search === route.search || current.activityId && current.activityId === activityId) ? current : null)
  }, [route.search])

  // Browser history uses the same leave gate as buttons. A route is only read after that gate succeeds.
  useEffect(() => {
    const readGeneration = ++routeReadEpoch.current
    const controller = new AbortController()
    const retire = () => controller.abort()
    if (!context || modelsOpen && !currentView.current.opened) return
    const params = new URLSearchParams(route.search)
    const activityId = params.get('activity')
    const requestedSpace = params.get('space') ?? (params.has('course') && !activityId ? schoolKey ?? null : null)
    const desiredKey = agentOpen && !activityId ? personalKey ?? currentView.current.key
      : knownSpaceKey(context, requestedSpace, activityId) ?? requestedSpace ?? preferredKey(context, null)
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
    const restoring = contextVerified && activityId !== null && reopenAfterReconnect.current === activityId
    reopenAfterReconnect.current = null
    // The reset effect clears the offline view in the same commit. Re-read even if it is still mounted here.
    if (!restoring && activityId === (currentView.current.opened?.activityId ?? null)) return retire
    if (!activityId) { ++epoch.current; setOpened(null); setBusy(false); return retire }
    if (!contextVerified) return retire
    const generation = ++epoch.current
    const search = route.search
    const applies = () => !controller.signal.aborted && generation === epoch.current
      && readGeneration === routeReadEpoch.current && currentSearch.current === search
    setOpened(null); setError(''); rememberMaterial(null)
    void readCache.read(desiredKey, 'activities/' + activityId, async () =>
      activitySchema.parse(await api('activities/' + activityId, undefined, desiredKey))).then(value => {
      if (applies()) {
        const activity = readCache.peek<LearningActivity>(desiredKey, 'activities/' + activityId) ?? value
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
    if (!coursePendingKey || !contextVerified || context?.readOnly) return
    const generation = epoch.current
    const startedSearch = currentSearch.current
    const startedAction = actionEpoch.current
    const selected = key
    const previewAtStart = taskPreview?.detail?.releaseId === releaseId && taskPreview.search === startedSearch ? taskPreview : null
    const applies = () => generation === epoch.current && startedSearch === currentSearch.current && startedAction === actionEpoch.current
    const enter = (activity: LearningActivity) => {
      if (!applies()) return
      if (previewAtStart) setTaskPreview(current => current === previewAtStart ? { ...current, activityId: activity.activityId } : current)
      rememberActivity(activity)
      publishActivity(activity, selected)
    }
    const openOrCreate = async () => {
      if (!applies()) return
      let pending = readCoursePending(coursePendingKey) ?? coursePending
      let existing: LearningActivity | undefined
      if (!pending && previewAtStart) {
        existing = previewEntry?.activity
        if (!existing) {
          const list = await api('activities', undefined, selected) as unknown[]
          const { courseId, task } = previewAtStart
          existing = courseTaskEntry(list.map(item => activitySchema.parse(item)), courseId, task.taskId, [releaseId]).activity
          pending = readCoursePending(coursePendingKey)
        }
      }
      if (!applies()) return
      if (pending && pending.releaseId !== releaseId) { setCoursePending(pending); return }
      if (!pending && existing) {
        enter(activitySchema.parse(await api('activities/' + existing.activityId, undefined, selected)))
        return
      }
      if (!pending && !previewAtStart) return
      const input = pending ?? createCourseActivitySchema.parse({ requestId: crypto.randomUUID(), releaseId })
      localStorage.setItem(coursePendingKey, JSON.stringify(input))
      setCoursePending(input)
      try {
        const raw = await api('course-activity-results/' + input.requestId, undefined, selected)
        const result = raw === null ? null : courseActivityResultSchema.parse(raw) as CourseActivityResult
        if (result?.state === 'rejected') {
          clearCoursePending(input, generation)
          throw Object.assign(new Error(messages[result.error ?? 'missing'] ?? '课程活动未能建立。'), { code: result.error ?? 'missing' })
        }
        const activity = result?.state === 'accepted' && result.activity
          ? activitySchema.parse(result.activity)
          : activitySchema.parse(await api('course-activities', input, selected))
        clearCoursePending(input, generation)
        enter(activity)
      } catch (error) {
        const code = (error as { code?: string }).code
        if (code && definitive.has(code)) clearCoursePending(input, generation)
        throw error
      }
    }
    const attempt = { releaseId }
    setCourseStart(attempt)
    try {
      // Serialize the lookup and start for one release across tabs of this school account.
      if (navigator.locks) await navigator.locks.request(`${coursePendingKey}.${releaseId}`, openOrCreate)
      else await openOrCreate()
    } finally {
      setCourseStart(current => current === attempt ? null : current)
    }
  }
  function discardCoursePending() {
    if (coursePendingKey) localStorage.removeItem(coursePendingKey)
    setCoursePending(null); setError(''); setNotice('')
  }
  async function openActivity(activityId: string, _asConversation = false, sourceKey = key, courseId?: string,
    experiment?: { requestId: string; bindingKey: string }) {
    if (!context?.identities.some(item => item.key === sourceKey)) return
    void Promise.all([loadReferences(), loadActivityPage()]).catch(() => {})
    await protectActivity()
    returnFocus.current = { key: sourceKey, activityId, scrollTop: document.querySelector('.main')?.scrollTop ?? 0 }
    const params = new URLSearchParams(currentSearch.current)
    params.set('activity', activityId); params.set('space', sourceKey); params.delete('artifact')
    if (courseId) params.set('course', courseId)
    else params.delete('course')
    params.delete('view'); params.delete('session')
    params.delete('experiment'); params.delete('component')
    if (experiment) { params.set('experiment', experiment.requestId); params.set('component', experiment.bindingKey) }
    navigate({ pathname: route.pathname, search: params.toString() })
  }
  async function changeStatus(activity: LearningActivity, source = key) {
    const owner = context?.identities.find(item => item.key === source)?.identity
    if (!context || !contextVerified || context.readOnly || !owner || !activityBelongsTo(activity, owner))
      throw new Error('当前学习空间无法更新该活动。')
    const authentication = authEpoch.current
    const pending = JSON.stringify([homeScope, source, activity.activityId])
    if (pendingStatus.current.has(pending)) throw new Error('活动状态正在更新，请稍后重试。')
    pendingStatus.current.add(pending)
    try {
      const status = activity.status === 'closed' ? 'open' : 'closed'
      const next = activitySchema.parse(await api('activity-status', {
        requestId: crypto.randomUUID(), activityId: activity.activityId, status,
      }, source))
      if (next.activityId !== activity.activityId || next.status !== status || !activityBelongsTo(next, owner))
        throw new Error('活动状态回执不匹配，请刷新列表核对后重试。')
      if (authentication !== authEpoch.current || activityView.current.homeScope !== homeScope)
        throw new Error('学习账号已切换，请在原学习空间核对活动状态。')
      // A navigation can retire the page that sent the write, but not its confirmed receipt.
      publishActivity(next, source)
      setOpened(current => currentView.current.key === source && current?.activityId === next.activityId ? next : current)
      try { sessionStorage.setItem(`xj.works-activity.${context.clientNamespace}.${source}.${next.activityId}`, JSON.stringify(next)) }
      catch { /* Optional reopening hint. */ }
    } finally {
      pendingStatus.current.delete(pending)
    }
  }
  async function changeCourseProgress(activity: LearningActivity, objectiveIndex: number, completed: boolean) {
    const generation = epoch.current
    const next = activitySchema.parse(await api('course-progress', { requestId: crypto.randomUUID(), activityId: activity.activityId,
      objectiveIndex, completed }, key))
    if (generation !== epoch.current || currentView.current.opened !== activity) return
    setRecordedProgress({ activity, completed: next.completedObjectives ?? [] })
    publishActivity(next)
    if (context) {
      try { sessionStorage.setItem(`xj.works-activity.${context.clientNamespace}.${key}.${activity.activityId}`, JSON.stringify(next)) }
      catch { /* The learning-data owner keeps the confirmed progress. */ }
    }
  }
  async function viewRelease(selection: CourseTaskSelection, releaseId = selection.releaseId) {
    if (!releaseId || identity?.kind !== 'school' || key !== schoolKey || selectedCourseId !== selection.courseId) return
    const generation = epoch.current
    const contentGeneration = ++contentReadEpoch.current
    const preview: CourseTaskPreview = { courseId: selection.courseId, courseName: selection.courseName, task: selection.task,
      releaseId, search: currentSearch.current }
    const applies = () => generation === epoch.current && contentGeneration === contentReadEpoch.current && preview.search === currentSearch.current
    setTaskPreview(preview); rememberMaterial(null)
    try {
      const detail = courseReleaseSchema.parse(await api('releases/' + releaseId, undefined, key))
      if (!applies()) return
      if (detail.courseId !== preview.courseId || detail.taskId !== preview.task.taskId || detail.releaseId !== releaseId) {
        throw new Error('任务发布版本不匹配，请重新读取。')
      }
      setTaskPreview({ ...preview, detail })
    } catch (cause) {
      if (applies()) setTaskPreview({ ...preview, error: errorText(cause) })
    }
  }
  function closeTaskPreview() {
    ++contentReadEpoch.current
    setTaskPreview(null); rememberMaterial(null)
  }
  async function downloadMaterial(releaseId: string, item: CourseMaterial) {
    if (material?.releaseId === releaseId && material.materialId === item.materialId) {
      saveMaterialFile(material)
      return
    }
    const generation = epoch.current
    const contentGeneration = ++contentReadEpoch.current
    const startedSearch = currentSearch.current
    const startedAction = actionEpoch.current
    const reading = { releaseId, materialId: item.materialId }
    setReadingMaterial(reading); setError(''); setNotice('')
    try {
      const content = courseMaterialContentSchema.parse(await api(`releases/${releaseId}/materials/${item.materialId}`, undefined, key))
      if (generation !== epoch.current || contentGeneration !== contentReadEpoch.current || startedSearch !== currentSearch.current) return
      const binary = atob(content.contentBase64)
      const data = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index++) data[index] = binary.charCodeAt(index)
      const url = URL.createObjectURL(new Blob([data], { type: content.mediaType }))
      const downloaded = { ...reading, title: content.title, url }
      rememberMaterial(downloaded)
      saveMaterialFile(downloaded)
    } catch (cause) {
      if (generation === epoch.current && contentGeneration === contentReadEpoch.current
        && startedSearch === currentSearch.current && startedAction === actionEpoch.current) setError(errorText(cause))
    } finally {
      setReadingMaterial(current => current === reading ? null : current)
    }
  }
  async function openCourseMaterialSource(source: CourseCitationLocation): Promise<CourseCitationDocument> {
    if (!context || !contextVerified) throw new Error('原学习身份当前不可访问。')
    const candidates = context.identities.filter(item => source.identity
      ? item.identity.kind === source.identity.kind && item.identity.environmentId === source.identity.environmentId
        && item.identity.spaceId === source.identity.spaceId && item.identity.principalId === source.identity.principalId
      : item.identity.kind === 'school')
    const original = source.sourceId?.startsWith('school:') ? candidates.find(item => item.key === source.sourceId)
      : candidates.length === 1 ? candidates[0] : undefined
    if (!original) throw new Error('原学习身份当前不可访问。')
    const read = (path: string) => learningSubjectRequest(original.identity, original.key, context.clientNamespace, path)
    if (source.pdfReading) {
      await learningSubjectRequest(original.identity, original.key, context.clientNamespace, 'course-pdf-reading', source.pdfReading)
    }
    const detail = courseReleaseSchema.parse(await read('releases/' + encodeURIComponent(source.releaseId)))
    if (detail.releaseId !== source.releaseId || source.contentDigest && detail.contentDigest !== source.contentDigest
      || !detail.materials.some(item => item.materialId === source.materialId && item.sha256 === source.materialSha256))
      throw new Error('课程资料的固定版本已变化。')
    const content = courseMaterialContentSchema.parse(await read(
      `releases/${encodeURIComponent(source.releaseId)}/materials/${encodeURIComponent(source.materialId)}`))
    if (content.materialId !== source.materialId || content.sha256 !== source.materialSha256) throw new Error('课程资料的固定版本已变化。')
    const binary = atob(content.contentBase64), bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
      byte => byte.toString(16).padStart(2, '0')).join('')
    if (digest !== source.materialSha256) throw new Error('课程资料正文校验失败。')
    const mediaType = content.mediaType.toLowerCase().split(';')[0]?.trim()
    if (mediaType === 'application/pdf') {
      if (!source.page) throw new Error('课程 PDF 出处缺少固定页码。')
      return { name: content.title, pdf: new Blob([bytes], { type: mediaType }), page: source.page }
    }
    if (!mediaType || !/^(?:text\/|application\/(?:json|xml|xhtml\+xml)$)/.test(mediaType)) throw new Error('这份课程资料不是可读文本。')
    const text = new TextDecoder().decode(bytes)
    if (source.from !== undefined && source.to !== undefined
      && (!Number.isInteger(source.from) || !Number.isInteger(source.to) || source.from < 0
        || source.to < source.from || source.to > text.length)) throw new Error('引用范围当前不可读取。')
    return { name: content.title, text: text.slice(source.from, source.to) }
  }

  async function disconnectSchool(schoolKey: string) {
    const authentication = ++authEpoch.current
    await protectActivity()
    await api('connections/revoke', { connectionId: schoolKey.slice(7) }, schoolKey)
    clearTeacherCache()
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
      setOpened(null); setActivities(null); setTaskPreview(null); rememberMaterial(null); setCoursePending(null)
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
    try { await api('connections/approve', { requestId: authorize }) }
    catch (cause) { throw schoolAuthorizationError(cause) }
    if (returnToSchoolClient(returnUrl)) return true
    const params = new URLSearchParams(location.search)
    params.delete('authorize'); params.delete('returnTo')
    navigate({ pathname: route.pathname, search: params.toString() }, { replace: true })
    setNotice('学校认证已完成，请返回原客户端完成连接。')
    return false
  }
  async function retrySchoolAuthorization(pending: PendingSchoolConnection) {
    const schoolEndpoint = new URL(pending.authorizationUrl).origin
    const request = schoolStartRequest.current?.schoolEndpoint === schoolEndpoint
      ? schoolStartRequest.current : { requestId: crypto.randomUUID(), schoolEndpoint }
    schoolStartRequest.current = request
    const next = await api('client/start', request) as PendingConnection
    schoolStartRequest.current = null
    rememberPendingConnection(next)
  }
  const pendingExpired = !!pendingConnection?.expired && !pendingConnection.connectionId
  const schoolConnectionForm = pendingConnection ? <div className="product-school-pending">
    <p role={pendingExpired ? 'alert' : 'status'}>{pendingConnection.connectionId ? '学校认证已完成，请重新读取连接。' : pendingExpired
      ? '学校认证请求已过期。学校链接已经保留，重新发起后不需要再次填写。'
      : pendingConnection.authenticated ? '学校认证已完成，点击下方按钮完成连接。' : '请在学校页面完成认证，然后返回这里完成连接。'}</p>
    <div className="product-school-actions">
      {pendingExpired
        ? <button type="button" className="primary" disabled={busy} aria-busy={busy || undefined}
          onClick={() => void action(() => retrySchoolAuthorization(pendingConnection))}>重新发起认证</button>
        : <button type="button" className="primary" disabled={busy} aria-busy={busy || undefined} onClick={() => void action(async generation => {
          let connectionId = pendingConnection.connectionId
          if (!connectionId) {
            let connection: { connectionId: string }
            // A new connection must not inherit the previous account's offline context.
            try { sessionStorage.removeItem('xj.works-context.v1') } catch { /* Optional hint. */ }
            try { connection = await api('client/complete', { requestId: pendingConnection.requestId }) as { connectionId: string } }
            catch (cause) { throw schoolAuthorizationError(cause) }
            if (generation !== epoch.current) return
            connectionId = connection.connectionId
            rememberPendingConnection({ ...pendingConnection, connectionId })
          }
          if (await refreshContext('school:' + connectionId, generation)) {
            rememberPendingConnection(null); setSchoolFormOpen(false); setSchoolEndpoint('')
            toast.success('学校已连接。')
          }
        })}>{busy ? pendingConnection.connectionId ? '正在读取连接…' : '正在完成连接…'
          : pendingConnection.connectionId ? '重新读取连接' : '已完成认证，连接学校'}</button>}
      {!pendingConnection.connectionId && !pendingExpired && <a className="outline product-school-auth-link" href={pendingConnection.authorizationUrl} target="_blank" rel="noreferrer">重新打开学校认证页面</a>}
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
        {schoolIdentities.map(item => <SchoolConnectionRow key={item.key} name={context.account?.schoolName ?? item.identity.name} busy={busy}
          onRebind={!schoolFormOpen && !pendingConnection ? event => {
            disconnectTrigger.current = event.currentTarget
            disconnectSection.current = event.currentTarget.closest<HTMLElement>('.product-school')
            setDisconnectError(''); setDisconnectTarget({ key: item.key, name: context.account?.schoolName ?? item.identity.name, replace: true })
          } : undefined}
          onDisconnect={item.key.startsWith('school:') ? event => {
            disconnectTrigger.current = event.currentTarget
            disconnectSection.current = event.currentTarget.closest<HTMLElement>('.product-school')
            setDisconnectError(''); setDisconnectTarget({ key: item.key, name: item.identity.name })
          } : undefined} />)}
      </div> : schoolConnectionForm)}
      {context.profile !== 'school' && schoolIdentities.length > 0 && (schoolFormOpen || pendingConnection) && schoolConnectionForm}
      {context.identities.some(item => item.key === 'school') ? <SchoolSessionRow busy={busy} onLogout={() => void action(async () => {
        const authentication = ++authEpoch.current
        await protectActivity()
        await api('logout', {}); clearTeacherCache(); if (authentication !== authEpoch.current) return
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
          rememberActivity(null, nextKey); setActivities(null); setTaskPreview(null); rememberMaterial(null); setCoursePending(null)
          setKey(nextKey)
          setReload(value => value + 1)
        }
      })} /> : null}
    </section>
  const preview = !modelsOpen && taskPreview && (taskPreview.activityId
    ? taskPreview.activityId === opened?.activityId : taskPreview.search === route.search) ? taskPreview : null
  // Persist a new request immediately, but only show recovery once it needs attention.
  const enteringCourse = busy && !!preview && courseStart?.releaseId === preview.releaseId
  const courseRecovery = enteringCourse && coursePending?.releaseId === preview.releaseId ? null : coursePending
  const visibleActivities = activitiesFor === pendingKey ? activities : null
  const previewEntry = preview && courseTaskEntry(visibleHome?.school ?? visibleActivities, preview.courseId, preview.task.taskId, [preview.releaseId])
  const previewRelease = preview?.task.releases.find(release => release.releaseId === preview.releaseId)
  const previewProgress = previewRelease && previewEntry?.status
    ? courseTaskProgress(previewRelease.objectives.length, previewEntry.activity?.completedObjectives) : undefined
  const openedObjectives = opened && (recordedProgress?.activity === opened ? recordedProgress.completed : opened.completedObjectives)
  const changePage = (page: 'home' | 'agent', experiment?: ExperimentReference) => void action(async () => {
    await protectActivity()
    if (experiment && context) sessionStorage.setItem('xj.agent-experiment.' + context.clientNamespace, JSON.stringify(experiment))
    const params = new URLSearchParams(currentSearch.current)
    params.delete('activity'); params.delete('course'); params.delete('settings'); params.delete('artifact'); params.delete('session')
    params.delete('experiment'); params.delete('component')
    if (page === 'agent') params.set('view', 'agent')
    else params.delete('view')
    const nextKey = page === 'agent' ? personalKey ?? key : key
    if (nextKey) params.set('space', nextKey)
    else params.delete('space')
    const search = params.toString()
    approvedSearch.current = search ? '?' + search : ''
    navigate({ pathname: route.pathname, search })
    ++epoch.current; setBusy(false)
    setOpened(null); setTaskPreview(null); rememberMaterial(null)
    if (nextKey !== key) setKey(nextKey)
  })
  const goHome = () => changePage('home')
  const returnFromWorkspace = () => {
    if (!opened?.course || opened.course.courseId !== selectedCourseId) { goHome(); return }
    void action(async generation => {
      await protectActivity()
      if (generation !== epoch.current) return
      rememberActivity(null); rememberMaterial(null)
    })
  }
  const openAgent = () => { prepareAgent(); conversationHistory.revalidate(); changePage('agent') }
  const askHomeFromExperiment = (reference: ExperimentReference) => {
    prepareAgent()
    changePage('agent', reference)
  }
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
  const conversationOpen = false
  const archivedCount = conversationHistory.items.filter(item => item.scenario === 'student-assistant' && item.archived && !item.deleted).length
  const openSession = (id: string) => void action(async () => {
    await protectActivity()
    const params = new URLSearchParams(currentSearch.current)
    for (const name of ['activity', 'course', 'settings', 'artifact']) params.delete(name)
    params.set('view', 'agent'); params.set('session', id)
    if (personalKey) params.set('space', personalKey)
    const search = params.toString(); approvedSearch.current = '?' + search
    navigate({ pathname: route.pathname, search }); setOpened(null)
    if (personalKey && personalKey !== key) setKey(personalKey)
  })
  const sessionCreated = (session: AgentSession) => { conversationHistory.upsert(session); openSession(session.sessionId) }
  const refreshCreatedWorkspaces = () => {
    if (!personalKey) return
    void api('activities', undefined, personalKey).then(value => {
      const list = (value as unknown[]).map(item => activitySchema.parse(item))
      readCache.set(personalKey, 'activities', list)
      setHomeData(previous => previous?.scope === homeScope ? { ...previous, personal: list } : previous)
      if (key === personalKey) { setActivities(list); setActivitiesFor(pendingKey) }
    }).catch(cause => setError(errorText(cause)))
  }
  async function changeConversationVisibility(id: string, remove: boolean) {
    const saved = await (remove ? conversationHistory.remove(id) : conversationHistory.setArchived(id, true))
    if (saved && remove && routeSessionId === id) openAgent()
    return saved
  }
  const schoolSessionActive = context ? context.identities.some(item => item.key === 'school') : undefined
  const authorizationExpiredTitle = authorizationState === 'missing'
    ? '这个认证请求已失效或不属于此客户端。' : '学校认证请求已过期。'
  const authorizationExpiredHelp = schoolSessionActive === undefined
    ? '返回客户端重新发起认证。学校链接会保留；当前学校登录状态仍在核对。'
    : schoolSessionActive
      ? '当前学校登录仍然有效。返回客户端重新发起认证后，可直接确认，不需要重新输入账号密码。'
      : '返回客户端重新发起认证。学校链接会保留，但需要重新登录学校账号。'
  const authorizationGate = authorize && authorizationState !== 'pending'
    ? <div className="content home-page"><section className="product-connection" aria-labelledby="authorization-status-title">
      <h2 id="authorization-status-title">学校认证</h2>
      {authorizationState === 'checking'
        ? <p role="status">正在核对学校认证请求…</p>
        : authorizationState === 'error'
          ? <><p role="alert">暂时无法核对学校认证请求，请重试。</p>
            <button type="button" className="outline" onClick={() => setAuthorizationAttempt(value => value + 1)}>重新核对</button>
            <button type="button" className="outline" onClick={() => setAuthorizationState('pending')}>继续登录</button></>
          : authorizationState === 'approved'
            ? <><p role="status">学校认证已完成，请返回客户端完成连接。</p>
              {authorizationReturnUrl && <a className="outline product-school-auth-link" href={authorizationReturnUrl}>返回客户端</a>}</>
            : <><p role="alert">{authorizationExpiredTitle}</p>
              <p>{authorizationExpiredHelp}</p>
              {authorizationReturnUrl && <a className="outline product-school-auth-link" href={authorizationReturnUrl}>返回客户端</a>}</>}
    </section></div> : null
  if (schoolLoginRequired) return authorizationGate ?? <SessionLogin entryRole="student" loginName={loginName} password={password}
    busy={busy} logoutFailed={false} accountRef={schoolAccount}
    description={authorize ? '使用学校账号登录并认证，完成后将返回客户端。' : '使用学校账号登录，继续你的学习。'}
    submitLabel={authorize ? '登录并认证' : undefined}
    onLoginNameChange={setLoginName} onPasswordChange={setPassword}
    onSubmit={() => void action(async generation => {
      ++authEpoch.current
      // Login may switch accounts; never let an old cached space list seed the new view.
      try { sessionStorage.removeItem('xj.works-context.v1') } catch { /* Optional hint. */ }
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

  return <HomeNavigationProvider scope={homeScope}><ProductShell immersive={!modelsOpen && (opened ? !conversationOpen : !!routeActivityId && !agentOpen)} accountName={accountName}
    active={modelsOpen ? 'settings' : agentOpen ? 'agent' : 'home'}
    onHome={goHome} onAgent={openAgent} onSettings={() => openSettings()} onProfile={() => setProfileOpen(true)}
    onAgentIntent={prepareAgent}
    archivedCount={archivedCount} archiveOpen={archiveOpen} onArchiveOpenChange={setArchiveOpen}
    agentHistory={(close, visible) => <ProductConversationHistory sessions={conversationHistory.items.filter(item => item.scenario === 'student-assistant')}
      activeId={routeSessionId} archiveOpen={archiveOpen} query={historyQuery} error={conversationHistory.error}
      ready={conversationHistory.ready} busy={conversationHistory.busy || busy} onRetry={() => void conversationHistory.retry()}
      scopeKey={personalKey ?? ''} visible={visible} readOnly={!!context?.readOnly || !contextVerified}
      onNew={() => { close(); setArchiveOpen(false); openAgent() }} onOpen={id => { close(); openSession(id) }}
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
    {modelsOpen && <ProductSettings accountName={accountName}
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
        identity={identity} spaceKey={key} namespace={context.clientNamespace} selection={modelSelection}
        readOnly={context.readOnly} activityId={opened?.activityId} courseId={opened?.course?.courseId} cache={readCache} /></Suspense>
      </SettingsFailureBoundary> : null} />}
    {context && identity && opened ? <div style={{ display: modelsOpen ? 'none' : 'contents' }} inert={modelsOpen} aria-hidden={modelsOpen || undefined}>
      <Suspense fallback={<div className="content" role="status" aria-label="正在打开学习活动" />}>
      <ActivityReferences key={context.clientNamespace + key + opened.activityId}
      activity={opened} spaceKey={key} namespace={context.clientNamespace} authorized={activityAuthorized} readOnly={context.readOnly} viewActive={!modelsOpen} readCache={readCache}>
      {<ActivityPage activity={opened} spaceKey={key} namespace={context.clientNamespace} authorized={activityAuthorized} selection={modelSelection}
        requestedArtifactId={requestedArtifactId}
        nativeAvailable={context.profile === 'local'}
        workspaceRef={workspace} busy={busy} onBack={returnFromWorkspace} onStatus={() => void action(() => changeStatus(opened))}
        taskInfoEntryRef={setTaskInfoEntry}
        taskProgress={opened.course && !opened.purpose ? courseTaskProgress(opened.course.objectives.length, openedObjectives ?? []) : undefined}
        onRefresh={() => void action(async generation => { await refreshContext(undefined, generation) })} onModels={openModels}
        onAskHome={askHomeFromExperiment} account={schoolControls}
        requestedExperiment={requestedExperimentId && requestedExperimentKey ? { requestId: requestedExperimentId, bindingKey: requestedExperimentKey } : undefined}
        courseResources={opened.course ? openCourseMaterial => <>
          <CourseResources content={opened.course!} busy={busy} readingMaterial={readingMaterial} showMaterialsHeading={false}
            onDownload={item => void downloadMaterial(opened.course!.releaseId, item)} onOpenMaterial={openCourseMaterial} />
          <CourseTools capabilities={opened.course!.capabilities} components={opened.course!.components} />
        </> : undefined}
        details={<>
          {opened.course ? <>
            <header className="product-task-details-heading">
              <h2>{opened.course.taskTitle}</h2>
              <p className="detail">{opened.course.courseName}</p>
            </header>
            <CourseInstructions content={opened.course} busy={busy}
              objectiveProgress={opened.purpose ? undefined : {
                completed: openedObjectives ?? [],
                onChange: activityAuthorized && !context.readOnly && opened.status === 'open'
                  ? (index, completed) => void action(() => changeCourseProgress(opened, index, completed)) : undefined,
              }}
              requirementsContent={<CourseRequirementsReference course={opened.course} />} />
          </>
          : <><h2>学习目标</h2><p className="preserve-lines">{opened.goal || opened.question || '资料学习'}</p>
            {opened.question && opened.goal && <><h3>起始问题</h3><p className="preserve-lines">{opened.question}</p></>}
          </>}
        </>} />}
    </ActivityReferences></Suspense></div> : modelsOpen ? null : unavailableRoute ? <div className="content home-page"><p>此活动属于未绑定的学校账号。请在设置中绑定原账号后打开，本机学习内容会保留。</p><Button onClick={() => openSettings('school')}>管理学校连接</Button><Button variant="outline" onClick={goHome}>返回首页</Button></div> : !context || !identity ? <div className="content home-page product-home">
      {!context && !error && <p role="status" aria-label="正在连接学习空间" />}
      {!context && error && <button type="button" className="outline" onClick={() => void action(async generation => { await refreshContext(undefined, generation) })}>重新连接</button>}
      {schoolControls}
    </div> : routeActivityId ? <div className="content" role="status">{error ? '学习活动暂时无法打开。' : ''}{error && <Button variant="outline" onClick={goHome}>返回首页</Button>}</div>
    : agentOpen && (!personalKey || key !== personalKey) ? <div className="content home-page"><p>请在本机客户端开始个人学习；学校课程请从首页进入。</p><Button onClick={goHome}>返回首页</Button></div> : agentOpen ? <Suspense fallback={<div className="content" role="status" aria-label="正在准备对话" />}><ProductAgent
      key={context.clientNamespace + identity.principalId + (routeSessionId ?? 'new')} identity={identity} spaceKey={key} namespace={context.clientNamespace}
      sessionId={routeSessionId} session={conversationHistory.items.find(item => item.sessionId === routeSessionId)} onSession={sessionCreated} onWorkspace={(id, source) => void action(async () => {
        if (!source) return openActivity(id, false, personalKey)
        const original = context.identities.find(item => item.identity.environmentId === source.environmentId
          && item.identity.spaceId === source.spaceId && item.identity.principalId === source.principalId)
        if (!original) { toast.error('原实验所属学习空间当前不可访问。'); return }
        return openActivity(id, false, original.key, undefined, typeof source.requestId === 'string' && typeof source.bindingKey === 'string'
          ? { requestId: source.requestId, bindingKey: source.bindingKey } : undefined)
      })} onOpenCourseMaterial={openCourseMaterialSource}
      onWorkspaceCreated={refreshCreatedWorkspaces} onSettings={openModels} selection={modelSelection} readOnly={!!context.readOnly || !contextVerified} /></Suspense>
    : <>
      {(context.readOnly || authorize || courseRecovery && !preview) && <div className="content product-home-alerts">
        {context.readOnly && <p role="status" className="product-workspace-notice">这是还原校验副本，作品与学习对话只读，不会启动 Agent 或实验；请由维护者完成接管后继续。</p>}
        {authorize && <section className="product-connection" aria-labelledby="approve-title"><h2 id="approve-title">学校认证</h2>
          {authorizationState === 'checking'
            ? <p role="status">正在核对学校认证请求…</p>
            : authorizationState === 'error'
              ? <><p role="alert">暂时无法核对学校认证请求，请重试。</p>
                <div className="product-school-actions">
                  <button type="button" className="outline" onClick={() => setAuthorizationAttempt(value => value + 1)}>重新核对</button>
                  <button type="button" className="outline" disabled={busy || !schoolSessionActive}
                    onClick={() => void action(async () => { await authenticateSchoolClient() })}>仍然认证</button>
                </div></>
              : authorizationState === 'approved'
                ? <><p role="status">学校认证已完成，请返回客户端完成连接。</p>
                  {authorizationReturnUrl && <a className="outline product-school-auth-link" href={authorizationReturnUrl}>返回客户端</a>}</>
                : authorizationState !== 'pending'
                  ? <><p role="alert">{authorizationExpiredTitle}</p><p>{authorizationExpiredHelp}</p>
                    {authorizationReturnUrl && <a className="outline product-school-auth-link" href={authorizationReturnUrl}>返回客户端</a>}</>
                  : <><p>使用当前学校账号认证，完成后返回客户端连接学校。</p>
                    <button type="button" className="primary" disabled={busy || !schoolSessionActive}
                      onClick={() => void action(async () => { await authenticateSchoolClient() })}>认证并返回客户端</button></>}
        </section>}
        {courseRecovery && !preview && <div className="course-pending"><p>{busy ? '正在准备课程活动…' : '上次课程活动的请求结果尚未核对，将先查询原请求。'}</p>
          <button type="button" className="outline" disabled={busy} onClick={() => void action(() => startCourse(courseRecovery.releaseId))}>核对并继续原请求</button>
          <button type="button" className="outline" disabled={busy} onClick={discardCoursePending}>放弃这次请求</button></div>}
      </div>}
      <ProductHome projectTitles={projectTitles} accountName={accountName} personalActivities={visibleHome?.personal ?? null} schoolActivities={visibleHome?.school ?? null}
        courses={visibleHome?.courses ?? null} selectedCourseId={selectedCourseId} personalKey={personalKey} schoolKey={schoolKey}
        initialCategory={schoolKey ? 'school' : 'personal'} dashboardKey={(context.clientNamespace + ':home-dashboard')}
        busy={busy || !!selectedCourseId && key !== schoolKey} personalError={visibleHome?.personalError} courseError={visibleHome?.courseError}
        onOpenActivity={(id, source, courseId) => void action(() => openActivity(id, source === personalKey, source, courseId))}
        onOpenCourse={selectCourse}
        onActivityStatus={contextVerified && !context.readOnly ? changeStatus : undefined}
        onOpenTask={selection => void viewRelease(selection)} readTaskSubmission={readTaskSubmission}
        onStartConversation={openAgent} onConnectSchool={() => openSettings('school')}
        onRefresh={() => void action(async generation => { await refreshContext(undefined, generation) })} />
    </>}
    {preview && previewEntry && <WorkspaceTaskIntro status={previewEntry.status} name={preview.detail?.taskTitle ?? preview.task.title} course={preview.courseName}
      deadline={previewRelease?.deadlineAt ? `截止 ${formatDeadline(previewRelease.deadlineAt)}` : '无截止时间'}
      percent={previewProgress?.percent} done={previewProgress?.done}
      actionLabel={enteringCourse || preview.activityId ? '正在进入学习工作区…'
        : courseRecovery?.releaseId === preview.releaseId ? '核对并继续原请求' : previewEntry.action}
      onStart={() => void action(() => startCourse(preview.releaseId))}
      dialog={{ onClose: closeTaskPreview, busy: enteringCourse || !!preview.activityId,
        startDisabled: busy || !!preview.activityId || !preview.detail || !contextVerified || !!context?.readOnly
          || !!coursePending && coursePending.releaseId !== preview.releaseId,
        dock: preview.activityId && taskInfoEntry ? { target: taskInfoEntry, onComplete: finishTaskDocking } : undefined }}>
      {preview.task.releases.length > 1 && <SelectField className="course-version-select" label="任务发布版本"
        value={preview.releaseId} disabled={busy || !!preview.activityId}
        options={preview.task.releases.map((item, index) => ({ value: item.releaseId,
          label: `发布于 ${courseReleaseDate(item.publishedAt)}${index === 0 ? ' · 最新版本' : ''}` }))}
        onChange={id => void viewRelease(preview, id)} />}
      {courseRecovery && <div className="course-pending"><p>{courseRecovery.releaseId === preview.releaseId
        ? '上次课程任务的请求结果尚未核对。' : '请先返回课程列表处理上次课程任务请求。'}</p>
        {courseRecovery.releaseId === preview.releaseId && <Button variant="outline" disabled={busy} onClick={discardCoursePending}>放弃这次请求</Button>}
      </div>}
      {preview.detail ? <>
        <div className="product-course-sections">
          <CourseInstructions content={preview.detail} busy={busy || !!preview.activityId} />
          <CourseResources content={preview.detail} busy={busy || !!preview.activityId} readingMaterial={readingMaterial}
            onDownload={item => void downloadMaterial(preview.releaseId, item)} />
        </div>
        <CourseTools capabilities={preview.detail.capabilities} components={preview.detail.components} />
      </>
        : preview.error ? <div className="course-preview-status" role="alert"><p>{preview.error}</p>
          <Button variant="outline" onClick={() => void viewRelease(preview, preview.releaseId)}>重新读取任务</Button></div>
          : <p className="course-preview-status" role="status">正在读取任务要求…</p>}
    </WorkspaceTaskIntro>}
  </ProductShell></HomeNavigationProvider>
}
