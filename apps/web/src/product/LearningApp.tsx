import { useEffect, useRef, useState, type ReactNode } from 'react'
import { activitySchema, createActivitySchema, courseActivityResultSchema } from '@xunjie/contracts/learning-data'
import type { LearningActivity, CourseActivityResult } from '@xunjie/contracts/learning-data'
import { courseCatalogSchema, courseReleaseSchema, courseMaterialContentSchema, createCourseActivitySchema } from '@xunjie/contracts/courses'
import type { Course, CourseRelease, CourseMaterial } from '@xunjie/contracts/courses'
import { spaceIdentitySchema, type SpaceIdentity } from '@xunjie/contracts/spaces'
import { useTheme } from '../lib/theme'
import './product.css'
import type { ActivityWorkspaceHandle } from './ActivityWorkspace'
import { ActivityPage } from './ActivityPage'
import { ProductShell } from '../components/ProductShell'
import { PersonalModelSettings } from './PersonalModelSettings'
import { useModelSelection } from './ModelSelection'
import { CourseTiles, LearningTaskCard, LearningCardGrid } from '../components/home/LearningCards'
import { createBrowserRouter, RouterProvider, useBlocker, useLocation, useNavigate } from 'react-router-dom'
import { ActivityReferences, CourseMaterialReferences, CourseRequirementsReference } from './ActivityReferences'
import { parsePendingActivityRequest, rememberFirstQuestion, type PendingActivityRequest } from './first-question'


type Context = { clientNamespace: string; profile: string; readOnly?: boolean; identities: { key: string; identity: SpaceIdentity }[] }
type PendingConnection = { requestId: string; authorizationUrl: string }
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
  return <RouterProvider router={router.current} />
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
  const [connectionsOpen, setConnectionsOpen] = useState(false)
  const selectedCourseId = new URLSearchParams(route.search).get('course')
  const modelsOpen = new URLSearchParams(route.search).get('settings') === 'models'
  const [context, setContext] = useState<Context | null>(null)
  const api = (path: string, body?: unknown, space?: string, signal?: AbortSignal) =>
    requestLearning(path, body, space, signal, context?.clientNamespace)
  const [contextVerified, setContextVerified] = useState(true)
  const [key, setKey] = useState('')
  const [activities, setActivities] = useState<LearningActivity[] | null>(null)
  const [activitiesFor, setActivitiesFor] = useState('')
  const [opened, setOpened] = useState<LearningActivity | null>(null)
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
  const [schoolEndpoint, setSchoolEndpoint] = useState('')
  const [pendingConnection, setPendingConnection] = useState<PendingConnection | null>(null)
  const [pendingRequest, setPendingRequest] = useState<PendingActivityRequest | null>(null)
  const askNext = useRef<boolean | null>(null)
  const [coursePending, setCoursePending] = useState<CreateCourseActivity | null>(null)
  const [notice, setNotice] = useState('')
  const [reload, setReload] = useState(0)
  const epoch = useRef(0)
  const authEpoch = useRef(0)
  const currentView = useRef({ context, key, opened })
  currentView.current = { context, key, opened }
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
    if (activity) url.searchParams.set('activity', activity.activityId)
    else url.searchParams.delete('activity')
    if (nextKey) url.searchParams.set('space', nextKey)
    if (url.search !== location.search) {
      approvedSearch.current = url.search
      navigate({ pathname: route.pathname, search: url.search })
    }
    if (activity && context) {
      try { sessionStorage.setItem(`xj.works-activity.${context.clientNamespace}.${key}.${activity.activityId}`, JSON.stringify(activity)) } catch { /* IndexedDB owns work protection. */ }
    }
    setOpened(activity)
  }
  function selectCourse(courseId: string | null) {
    ++contentReadEpoch.current
    const params = new URLSearchParams(route.search)
    if (courseId) params.set('course', courseId)
    else params.delete('course')
    navigate({ pathname: route.pathname, search: params.toString() })
    setRelease(null); rememberMaterial(null)
    requestAnimationFrame(() => { const heading = document.getElementById('course-title'); heading?.focus(); heading?.scrollIntoView({ block: 'start' }) })
  }
  const formScope = useRef('')
  const materialUrl = useRef('')
  const authorize = new URLSearchParams(location.search).get('authorize')
  const identity = context?.identities.find(item => item.key === key)?.identity
  const modelSelection = useModelSelection(identity, key, context?.clientNamespace ?? '')
  const pendingKey = context && identity ? `xj.activity-request.${context.clientNamespace}.${identity.environmentId}.${identity.spaceId}.${identity.principalId}` : ''
  const coursePendingKey = context && identity?.kind === 'school'
    ? `xj.course-activity-request.${context.clientNamespace}.${identity.environmentId}.${identity.spaceId}.${identity.principalId}` : ''
  const activityAuthorized = !!opened && !!identity && contextVerified
    && opened.identity.environmentId === identity.environmentId && opened.identity.spaceId === identity.spaceId
    && opened.identity.principalId === identity.principalId

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
    const next = await api('context') as Context
    if (generation !== epoch.current || authentication !== authEpoch.current) return
    await protectActivity()
    if (generation !== epoch.current || authentication !== authEpoch.current) return
    const nextKey = prefer && next.identities.some(item => item.key === prefer) ? prefer
      : next.identities.some(item => item.key === key) ? key : next.identities[0]?.key ?? ''
    rememberActivity(null, nextKey); setActivities(null); setCatalog(null); setRelease(null); rememberMaterial(null)
    try { sessionStorage.setItem('xj.works-context.v1', JSON.stringify(next)) } catch { /* Optional reopening hint only. */ }
    setContextVerified(true)
    setContext(next)
    setReload(value => value + 1)
    setKey(nextKey)
  }
  useEffect(() => {
    let disposed = false
    void api('context').then(result => {
      if (!disposed) { const next = result as Context; setContext(next);
        try { sessionStorage.setItem('xj.works-context.v1', JSON.stringify(next)) } catch { /* Optional hint. */ }
        const preferred = new URLSearchParams(location.search).get('space')
        setKey(next.identities.some(i => i.key === preferred) ? preferred! : next.identities[0]?.key ?? '') }
    }).catch(error => {
      if (disposed) return
      try {
        if ((error as { code?: string }).code === 'forbidden') throw error
        const cached = JSON.parse(sessionStorage.getItem('xj.works-context.v1') ?? 'null') as Context | null
        if (!cached || typeof cached.clientNamespace !== 'string') throw error
        cached.identities.forEach(i => spaceIdentitySchema.parse(i.identity))
        const preferred = new URLSearchParams(location.search).get('space')
        const selected = cached.identities.find(i => i.key === preferred) ?? cached.identities[0]
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
        const next = value as Context
        // 恢复请求可能早于当前活动挂载完成；按最新视图保留已打开或 URL 请求的活动，避免恢复后落回列表。
        requestedActivity.current = currentView.current.opened?.activityId ?? requestedActivity.current
        setContext(next); setContextVerified(true); setReload(n => n + 1)
        setKey(old => next.identities.some(i => i.key === old) ? old : next.identities[0]?.key ?? '')
        try { sessionStorage.setItem('xj.works-context.v1', JSON.stringify(next)) } catch { /* Optional hint. */ }
      }).catch(() => {}).finally(() => { checking = false })
    }, 3000)
    return () => clearInterval(timer)
  }, [contextVerified, context, opened])
  useEffect(() => {
    const generation = ++epoch.current
    const controller = new AbortController()
    setActivities(null); setOpened(null); setCatalog(null); setRelease(null); setCoursePending(null); rememberMaterial(null)
    setError(''); setPendingRequest(null); setBusy(false)
    if (formScope.current !== pendingKey) {
      formScope.current = pendingKey; setGoal(''); setQuestion(''); setReference('')
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
      void api('activities', undefined, key, controller.signal).then(value => {
        if (epoch.current === generation) {
          setActivities((value as unknown[]).map(item => activitySchema.parse(item)))
          setActivitiesFor(pendingKey)
        }
      }).catch(error => { if (epoch.current === generation && !controller.signal.aborted) setError(errorText(error)) })
      if (identity?.kind === 'school') {
        void api('courses', undefined, key, controller.signal).then(value => {
          if (epoch.current === generation) setCatalog(courseCatalogSchema.parse(value).courses)
        }).catch(error => { if (epoch.current === generation && !controller.signal.aborted) setError(errorText(error)) })
      }
    }
    return () => { ++epoch.current; controller.abort() }
  }, [key, pendingKey, coursePendingKey, reload, contextVerified])

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
    if (!context) return
    const params = new URLSearchParams(route.search)
    const desiredKey = params.get('space') ?? context.identities[0]?.key ?? ''
    const activityId = params.get('activity')
    requestedActivity.current = activityId
    if (desiredKey !== currentView.current.key) {
      if (!context.identities.some(item => item.key === desiredKey)) return retire
      requestedActivity.current = activityId
      setOpened(null); setActivities(null); setActivitiesFor(''); setKey(desiredKey)
      return retire
    }
    if (activityId === (currentView.current.opened?.activityId ?? null)) return retire
    if (!activityId) { ++epoch.current; setOpened(null); setBusy(false); setReload(n => n + 1); return retire }
    if (!contextVerified || !activities || activitiesFor !== pendingKey) return retire
    const generation = ++epoch.current
    const search = route.search
    const applies = () => !controller.signal.aborted && generation === epoch.current
      && readGeneration === routeReadEpoch.current && currentSearch.current === search
    setOpened(null); setError(''); rememberMaterial(null)
    void api('activities/' + activityId, undefined, desiredKey, controller.signal).then(value => {
      if (applies()) {
        const activity = activitySchema.parse(value)
        try { sessionStorage.setItem(`xj.works-activity.${context.clientNamespace}.${desiredKey}.${activity.activityId}`, JSON.stringify(activity)) } catch { /* Optional reopening hint. */ }
        setOpened(activity)
        returnFocus.current ??= { key: desiredKey, activityId: activity.activityId, scrollTop: 0 }
      }
    }).catch(cause => { if (applies()) setError(errorText(cause)) })
    return retire
  }, [route.search, context?.clientNamespace, key, pendingKey, contextVerified, activities !== null, activitiesFor])

  async function switchSpace(next: string) {
    if (next === key) return
    try { await protectActivity() } catch { setError('本机内容尚未得到保护，请保留当前页面并复制或导出作品。'); return }
    rememberActivity(null, next)
    ++epoch.current; setKey(next); setOpened(null); setActivities(null); setError(''); setNotice('')
    setCatalog(null); setRelease(null); rememberMaterial(null); setCoursePending(null)
    setGoal(''); setQuestion(''); setReference(''); setBusy(false)
  }
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
  async function createActivity() {
    const generation = epoch.current
    const startedSearch = currentSearch.current
    const scopeKey = pendingKey
    const selected = key
    const protectedRequest = localStorage.getItem(scopeKey)
    const previous = protectedRequest ? parsePendingActivityRequest(JSON.parse(protectedRequest)) : pendingRequest
    const input = previous?.input ?? createActivitySchema.parse({ requestId: crypto.randomUUID(), goal, question,
      references: reference ? [{ kind: 'url', url: reference, label: reference }] : [] })
    const firstQuestion = previous?.firstQuestion ?? (askNext.current === true && input.question.trim()
      ? { requestId: crypto.randomUUID(), question: input.question } : null)
    askNext.current = null
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
      // A deliberately discarded/replaced pending request no longer authorizes
      // a late response to recreate its automatic-send intent.
      if (completing && current.firstQuestion) rememberFirstQuestion(activity.activityId, current.firstQuestion)
      if (completing && localStorage.getItem(scopeKey) === saved) localStorage.removeItem(scopeKey)
      if (completing && generation === epoch.current && startedSearch === currentSearch.current) {
        setPendingRequest(null); rememberActivity(activity); setActivities(previous => [activity, ...(previous ?? []).filter(item => item.activityId !== activity.activityId)])
        setActivitiesFor(scopeKey)
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
        setActivities(previous => [activity, ...(previous ?? []).filter(item => item.activityId !== activity.activityId)])
        setActivitiesFor(pendingKey)
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
    setPendingRequest(null); setGoal(''); setQuestion(''); setReference(''); setError('')
  }
  async function openActivity(activityId: string) {
    await protectActivity()
    returnFocus.current = { key, activityId, scrollTop: document.querySelector('.main')?.scrollTop ?? 0 }
    const params = new URLSearchParams(currentSearch.current)
    params.set('activity', activityId); params.set('space', key)
    navigate({ pathname: route.pathname, search: params.toString() })
  }
  async function changeStatus(activity: LearningActivity) {
    const generation = epoch.current
    const next = activitySchema.parse(await api('activity-status', { requestId: crypto.randomUUID(), activityId: activity.activityId,
      status: activity.status === 'closed' ? 'open' : 'closed' }, key))
    if (generation === epoch.current) { setOpened(next); setActivities(previous => previous?.map(item => item.activityId === next.activityId ? next : item) ?? null) }
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

  const schoolControls = context && <section aria-labelledby="school-title"><h2 id="school-title">学校学习空间</h2>
      {context.identities.some(item => item.key === 'school') ? <button type="button" disabled={busy} onClick={() => void action(async () => {
        const authentication = ++authEpoch.current
        await protectActivity()
        await api('logout', {}); if (authentication !== authEpoch.current) return
        // Authentication outlives a view switch; a later login still supersedes this response.
        if (currentView.current.key === 'school') await protectActivity()
        if (authentication !== authEpoch.current || !currentView.current.context) return
        ++authEpoch.current
        const signedOut = { ...currentView.current.context, identities: currentView.current.context.identities.filter(item => item.key !== 'school') }
        // The logout response already confirms this fact; clearing it must not depend on a later context request.
        try { sessionStorage.setItem('xj.works-context.v1', JSON.stringify(signedOut)) } catch { /* Optional hint. */ }
        setContext(signedOut)
        if (currentView.current.key === 'school') {
          const nextKey = signedOut.identities.some(item => item.key === 'personal') ? 'personal' : signedOut.identities[0]?.key ?? ''
          rememberActivity(null, nextKey); setActivities(null); setCatalog(null); setRelease(null); rememberMaterial(null); setCoursePending(null)
          setKey(nextKey)
          setReload(value => value + 1)
        }
      })}>退出学校登录</button> : context.profile === 'school' && <form onSubmit={event => { event.preventDefault(); void action(async generation => {
        ++authEpoch.current
        await api('login', { loginName, password }); if (generation !== epoch.current) return
        setPassword(''); await refreshContext('school', generation)
      }) }}><label>学校账号<input autoComplete="username" required value={loginName} onChange={event => setLoginName(event.target.value)} /></label>
        <label>密码<input type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} /></label>
        <button type="submit" disabled={busy}>登录此学校</button></form>}
      {context.profile !== 'school' && <details><summary>连接学校提供的入口</summary>
        <form onSubmit={event => { event.preventDefault(); void action(async () => {
          const pending = await api('client/start', { requestId: crypto.randomUUID(), schoolEndpoint }) as PendingConnection
          setPendingConnection(pending)
        }) }}><label>学校入口<input type="url" required value={schoolEndpoint} onChange={event => setSchoolEndpoint(event.target.value)} /></label>
          <button type="submit" disabled={busy}>前往学校认证</button></form>
        {pendingConnection && <div><p><a href={pendingConnection.authorizationUrl} target="_blank" rel="noreferrer">打开学校认证页面</a></p>
          <button type="button" disabled={busy} onClick={() => void action(async generation => {
            const connection = await api('client/complete', { requestId: pendingConnection.requestId }) as { connectionId: string }
            if (generation !== epoch.current) return
            setPendingConnection(null); await refreshContext('school:' + connection.connectionId, generation)
          })}>已在学校批准，完成连接</button></div>}
      </details>}
      {key.startsWith('school:') && <button type="button" disabled={busy} onClick={() => void action(async generation => {
        await protectActivity()
        await api('connections/revoke', { connectionId: key.slice(7) }, key)
        // The revoked connection is gone; re-read so the stale school space cannot be selected again.
        if (generation === epoch.current) await refreshContext(context.identities.some(item => item.key === 'personal') ? 'personal' : undefined, generation)
      })}>撤销此客户端连接</button>}
    </section>
  const feedback = <>{error && <p className="learning-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}</>
  const selectedCourse = catalog?.find(course => course.courseId === selectedCourseId)
  const visibleRelease = release?.courseId === selectedCourseId ? release : null
  const visibleActivities = activitiesFor === pendingKey ? activities : null
  const goHome = () => void action(async () => { await protectActivity(); rememberActivity(null); rememberMaterial(null); setReload(value => value + 1) })
  const now = new Date()
  const greeting = now.getHours() < 12 ? '上午好' : now.getHours() < 18 ? '下午好' : '晚上好'
  const openModels = () => void action(async () => {
    await workspace.current?.leave()
    const params = new URLSearchParams(currentSearch.current); params.set('settings', 'models')
    navigate({ pathname: route.pathname, search: params.toString() })
  })
  const closeModels = () => {
    const params = new URLSearchParams(currentSearch.current); params.delete('settings')
    const search = params.toString()
    // Settings keeps the protected activity mounted; returning changes visibility only.
    approvedSearch.current = search ? '?' + search : ''
    navigate({ pathname: route.pathname, search })
  }
  return <ProductShell immersive={!!opened && !modelsOpen} identityName={identity?.name ?? '学习空间'}
    spaces={context?.identities.map(item => ({ key: item.key, label: item.identity.kind === 'personal' ? '个人空间'
      : context.identities.filter(other => other.identity.kind === 'school').length > 1 ? `学校空间 · ${item.identity.name}` : '学校空间' })) ?? []}
    spaceKey={key} onSpaceChange={next => void switchSpace(next)} onHome={() => { closeModels(); goHome() }} onModels={openModels}
    modelName={modelSelection.selection?.selected?.connection.name ?? '未选用模型'}
    onConnections={() => { closeModels(); goHome(); setConnectionsOpen(true) }}>
    {modelsOpen && context && identity ? <PersonalModelSettings key={context.clientNamespace + key + identity.principalId}
      identity={identity} spaceKey={key} namespace={context.clientNamespace} onBack={closeModels} selection={modelSelection}
      readOnly={context.readOnly} activityId={opened?.activityId} courseId={opened?.course?.courseId} /> : null}
    {context && identity && opened ? <div style={{ display: modelsOpen ? 'none' : 'contents' }} inert={modelsOpen} aria-hidden={modelsOpen || undefined}>
      <ActivityReferences key={context.clientNamespace + key + opened.activityId}
      activity={opened} spaceKey={key} namespace={context.clientNamespace} authorized={activityAuthorized} readOnly={context.readOnly} viewActive={!modelsOpen}>
      <ActivityPage activity={opened} spaceKey={key} namespace={context.clientNamespace} authorized={activityAuthorized}
        nativeAvailable={context.profile === 'local'}
        workspaceRef={workspace} busy={busy} onBack={goHome} onStatus={() => void action(() => changeStatus(opened))}
        onRefresh={() => void action(async generation => { await refreshContext(undefined, generation) })} onModels={openModels} account={schoolControls}
        error={error || notice ? feedback : null} details={<>
          {opened.course ? <><CourseSections content={opened.course} level={3} busy={busy}
            requirementsContent={<CourseRequirementsReference course={opened.course} />}
            onMaterial={item => void action(() => readMaterial(opened.course!.releaseId, item))} />
            <CourseMaterialReferences activity={opened} course={opened.course} spaceKey={key} namespace={context.clientNamespace} />
          </> : <><h2>学习目标</h2><p className="preserve-lines">{opened.goal || opened.question || '资料学习'}</p>
            {opened.question && opened.goal && <><h3>起始问题</h3><p className="preserve-lines">{opened.question}</p></>}
            {opened.references.length > 0 && <><h3>学习材料</h3>{opened.references.map((item, index) => <p key={index}><a href={item.url} target="_blank" rel="noreferrer">{item.label}</a></p>)}</>}
          </>}
          {material && <p className="material-note" role="status">已读取 {material.title}：<a href={material.url} target="_blank" rel="noreferrer" download={material.title}>打开或下载材料</a></p>}
        </>} />
    </ActivityReferences></div> : !(modelsOpen && context && identity) ? <div className="content home-page product-home">
      {context?.readOnly && <p role="status" className="product-workspace-notice">这是还原校验副本，作品与学习对话只读，不会启动 Agent 或实验；请由维护者完成接管后继续。</p>}
      <div className="intro"><h1>{greeting}{identity ? `，${identity.name}` : '，从这里开始学习'}</h1><span className="date">{now.getMonth() + 1} 月 {now.getDate()} 日</span></div>
      {feedback}
      {!context && !error && <p role="status">正在连接学习空间…</p>}
      {!context && error && <button type="button" className="outline" onClick={() => void action(async generation => { await refreshContext(undefined, generation) })}>重新连接</button>}
      {authorize && <section className="product-connection" aria-labelledby="approve-title"><h2 id="approve-title">连接这台客户端</h2>
        <p>确认后，此客户端可以使用你在本学校的学习活动。你可以随时撤销连接。</p>
        <button type="button" className="primary" disabled={busy || !context?.identities.some(item => item.key === 'school')}
          onClick={() => void action(async () => { await api('connections/approve', { requestId: authorize }); setNotice('连接已批准，请返回原客户端完成连接。') })}>允许连接</button>
      </section>}
      {(connectionsOpen || context?.profile === 'school' && !identity || authorize) && schoolControls}
      {context && identity && <>
        {identity.kind === 'school' && <section className="course-region" aria-labelledby="course-title">
          <div className="sectionhead"><h2 id="course-title" tabIndex={-1}>{selectedCourse?.name ?? '我的课程'}<small>{selectedCourse ? `${selectedCourse.tasks.length} 个任务` : catalog ? `${catalog.length} 门` : ''}</small></h2>
            {selectedCourse && <button type="button" className="outline" onClick={() => selectCourse(null)}>全部课程</button>}</div>
          {coursePending && <div className="course-pending"><p>上次课程活动的请求结果尚未核对，将先查询原请求。</p>
            <button type="button" className="outline" disabled={busy} onClick={() => void action(() => startCourse(coursePending.releaseId))}>核对并继续原请求</button>
            <button type="button" className="outline" disabled={busy} onClick={discardCoursePending}>放弃这次请求</button></div>}
          {catalog === null ? <p>{error ? '课程列表尚未读取成功。' : '正在读取课程…'}</p>
            : catalog.length === 0 ? <div className="empty">尚未获得课程资格。请联系课程管理员授予后再刷新。</div>
            : !selectedCourse ? <CourseTiles courses={catalog.map(course => course.courseId)} toneOf={id => catalog.findIndex(course => course.courseId === id)}
              titleOf={id => catalog.find(course => course.courseId === id)!.name}
              summaryOf={id => `${catalog.find(course => course.courseId === id)!.tasks.length} 个任务`} onOpen={id => selectCourse(id)} />
            : <div className="task-card-grid">{selectedCourse.tasks.map(task => <article key={task.taskId} className="product-course-task">
              <h3>{task.title}</h3>{task.summary && <p>{task.summary}</p>}
              <div className="product-release-list">{task.releases.map((item, index) => <button type="button" className="outline" key={item.releaseId} disabled={busy}
                onClick={() => void action(() => viewRelease(item.releaseId))}>{published(item.publishedAt)}{index === 0 ? ' · 最近发布' : ''}</button>)}</div>
            </article>)}</div>}
          {visibleRelease && <article className="product-release" aria-labelledby="release-title"><h3 id="release-title">{visibleRelease.taskTitle}</h3>
            <CourseSections content={visibleRelease} level={4} busy={busy} onMaterial={item => void action(() => readMaterial(visibleRelease.releaseId, item))} />
            {material && <p role="status">已读取 {material.title}：<a href={material.url} target="_blank" rel="noreferrer" download={material.title}>打开或下载材料</a></p>}
            <button type="button" className="primary" disabled={busy || !!coursePending || context?.readOnly} onClick={() => void action(() => startCourse(visibleRelease.releaseId))}>从这一版本开始活动</button>
          </article>}
        </section>}
        <section aria-labelledby="activities-title">
          <div className="sectionhead"><h2 id="activities-title">我的学习活动</h2><button type="button" className="outline" disabled={busy}
            onClick={() => void action(async generation => { await refreshContext(undefined, generation) })}>刷新列表</button></div>
          {visibleActivities === null ? <p>{error ? '列表尚未读取成功。' : '正在读取活动…'}</p>
            : visibleActivities.length === 0 ? <p className="empty">从一个目标、问题或资料开始。</p>
            : <LearningCardGrid>{register => visibleActivities.map((activity, index) => <LearningTaskCard key={activity.activityId} register={register} index={index}
              activityId={activity.activityId}
              accessibleLabel={activity.course?.taskTitle || activity.goal || activity.question || '资料学习'}
              title={activity.course?.taskTitle || activity.goal || activity.question || '资料学习'}
              goal={activity.course?.objectives[0] || activity.question || undefined}
              badge={<span className={'status' + (activity.status === 'closed' ? ' pending' : '')}>{activity.status === 'closed' ? '已关闭' : '进行中'}</span>}
              footer={activity.course?.courseName ?? '自主学习'} action={activity.status === 'closed' ? '重新开始' : '继续学习'}
              onOpen={() => void action(() => openActivity(activity.activityId))} />)}</LearningCardGrid>}
        </section>
        <section aria-labelledby="new-activity-title" className="product-new-activity"><details open={identity.kind === 'personal' || !!pendingRequest}>
          <summary><h2 id="new-activity-title">开始一次自主学习</h2></summary>
          <form onSubmit={event => { event.preventDefault(); void action(createActivity) }}>
            <label>学习目标<input value={goal} maxLength={4000} disabled={!!pendingRequest} onChange={event => setGoal(event.target.value)} placeholder="你想完成什么？" /></label>
            <label>起始问题<textarea value={question} maxLength={10000} disabled={!!pendingRequest} onChange={event => setQuestion(event.target.value)} rows={2} /></label>
            <label>资料链接（可选）<input type="url" value={reference} disabled={!!pendingRequest} onChange={event => setReference(event.target.value)} placeholder="https://" /></label>
            {pendingRequest && <p className="detail">上次建立活动的结果尚未核对，将先查询原请求。</p>}
            {pendingRequest && <button type="button" className="outline" disabled={busy} onClick={discardPending}>放弃这次请求并重新填写</button>}
            <div className="product-create-actions">
              <button className="primary" type="submit" disabled={busy || context?.readOnly || !pendingRequest && !goal.trim() && !question.trim() && !reference}
                onClick={() => { askNext.current = false }}>
                {busy ? '正在处理…' : pendingRequest ? '核对并继续原请求' : '建立学习活动'}</button>
              <button className="outline" type="submit" disabled={busy || context?.readOnly || !question.trim()}
                onClick={() => { askNext.current = true }}>建立并开始对话</button>
            </div>
            <p className="detail">「建立并开始对话」会把你填写的起始问题发送给 Agent；「建立学习活动」只保存目标与问题，稍后可在活动中发送。</p>
          </form>
        </details></section>
      </>}
    </div> : null}
  </ProductShell>
}
