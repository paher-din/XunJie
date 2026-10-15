/**
 * 工作区初始化读取（01 的只读范围）。
 *
 * 依据 docs/tasks/I0_UI_CLIENT_CONTRACT.md §2/§3 与 §8「Session/固定活动/资料读取」：
 * 只用 GET 读取业务对象，保留 Assignment / ActivityVersion / Resource 的归属与 visibility；
 * 缺失或 redacted 不补正文；载入不创建 Attempt、不开始学习。每个 await 之后重新核对上下文与
 * 读取序号，失效响应不写当前工作区。
 *
 * 两种模式的入口顺序不同，但路径、输入、信封与投影完全一致：
 * - preparation：`GET /__i0prep/context` 取合成账号与获准引用 → `POST /sessions` 建立开发会话
 *   → `GET /session` → 分配 → 活动 → 材料；
 * - real：`GET /session` → 获准深链的 Assignment bootstrap → 固定活动与资料。
 *   宿主未提供入口或授权失败时如实不可用，不猜 ID、不回退 fixture，不自动创建 Attempt。
 */

import type {
  ActivityView,
  AssignmentView,
  AssignmentBootstrapView,
  PrepContextView,
  ProjectedMaterial,
  ResourceStudentView,
  SessionCreatedView,
  SessionView,
} from './contracts'
import { ContextGuard, type WorkspaceContext } from './context'
import {
  apiGet,
  apiPost,
  setCsrfToken,
  type RequestFailure,
  type RequestOptions,
  WorkspaceRequestError,
} from './http'
import { PREP_BUILD, prepContextUrl, type WorkspaceMode } from './mode'
import { verifyHdlActivity } from './hdlActivity'

export type InitStage = 'context' | 'session' | 'discovery' | 'assignment' | 'activity' | 'resource'

/** 一条材料的读取结果：活动视图给出的裁剪状态与资源端点的实际结果分开保留。 */
export interface MaterialRead {
  /** 在活动 `content.materials` 里的位置，用于与 visibility 裁剪状态对齐。 */
  index: number
  projectedStatus: ProjectedMaterial['status']
  state:
    | { kind: 'not-readable'; reason: 'redacted' | 'unavailable' }
    | { kind: 'loaded'; view: ResourceStudentView }
    | { kind: 'failed'; resourceVersionId: string; failure: RequestFailure }
}

export type WorkspaceInit =
  | { kind: 'stale' }
  | { kind: 'unavailable'; stage: InitStage; reason: string; failure: RequestFailure | null }
  | {
      kind: 'ready'
      context: WorkspaceContext
      session: SessionView
      assignment: AssignmentView
      activity: ActivityView
      materials: MaterialRead[]
      /** 准备 bootstrap 元信息；真实模式恒为 null（不是正式 API，不进真实投影）。 */
      prepContext: PrepContextView | null
    }

function failureOf(e: unknown): RequestFailure | null {
  return e instanceof WorkspaceRequestError ? e.failure : null
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * 构造不可用状态。
 *
 * `reason` 是给学生的结论（为什么进不去、还能做什么），**不带**接口路径、HTTP 状态或错误码；
 * 异常的原文与失败体放在 `failure` 里，由界面写进控制台诊断（`workspace.initialize-failed`）。
 */
function unavailable(stage: InitStage, reason: string, e?: unknown): WorkspaceInit {
  return { kind: 'unavailable', stage, reason, failure: e === undefined ? null : failureOf(e) }
}

type GuardedRead<T> =
  | { kind: 'stale' }
  | { kind: 'failed'; error: unknown }
  | { kind: 'read'; data: T }

/**
 * 一次带上下文守卫的 GET。
 *
 * 读取序号在 await 之前领取，返回之后先核对是否仍可接纳：较早发出、迟到返回的读取判为
 * `stale`，调用方必须丢弃，不得覆盖已接受的权威状态（§3）。失败的读取不推进已接受序号——
 * 它没有数据可写，接纳它只会让同键的后续读取被误判。
 */
async function guardedGet<T>(
  guard: ContextGuard,
  opts: RequestOptions,
  key: string,
  path: string,
): Promise<GuardedRead<T>> {
  const seq = guard.nextReadSeq(key)
  let data: T
  try {
    data = await apiGet<T>(path, opts)
  } catch (e) {
    return guard.stale ? { kind: 'stale' } : { kind: 'failed', error: e }
  }
  return guard.acceptRead(key, seq) ? { kind: 'read', data } : { kind: 'stale' }
}

/**
 * 按当前守卫执行一次完整的初始化读取。
 *
 * 守卫失效（换上下文、卸载、主动重载）时立刻返回 `{ kind: 'stale' }`，调用方丢弃结果。
 */
export async function loadWorkspaceInit(guard: ContextGuard): Promise<WorkspaceInit> {
  if (guard.stale) return { kind: 'stale' }
  if (guard.context.mode === 'preparation') setCsrfToken(null)
  const mode: WorkspaceMode = guard.context.mode
  const opts: RequestOptions = { mode }

  /* 0. 准备模式先取 bootstrap 元信息：合成账号与获准对象引用。真实模式没有这个入口。 */
  let prepContext: PrepContextView | null = null
  if (PREP_BUILD && mode === 'preparation') {
    const url = prepContextUrl(mode)
    if (!url) return unavailable('context', '准备模式没有 bootstrap 端点')
    const read = await guardedGet<PrepContextView>(guard, { ...opts, absolutePath: url }, 'prep-context', '')
    if (read.kind === 'stale') return { kind: 'stale' }
    if (read.kind === 'failed') return unavailable('context', '准备 bootstrap 元信息不可用', read.error)
    prepContext = read.data
    if (!prepContext?.refs?.assignmentId || !prepContext.syntheticAccount?.loginName) {
      return unavailable('context', '准备 bootstrap 未给出获准的合成 Assignment 引用或合成账号')
    }
  }

  /* 1. 会话：身份只来自 Session，不从昵称或本地设置构造。 */
  if (PREP_BUILD && mode === 'preparation') {
    // 准备身份由 fixture 生成：用合成账号建立开发会话（U-07：不自建登录页面）
    const account = prepContext!.syntheticAccount
    try {
      await apiPost<SessionCreatedView>(
        '/sessions',
        { loginName: account.loginName, password: account.password },
        opts,
      )
      if (guard.stale) return { kind: 'stale' }
    } catch (e) {
      if (guard.stale) return { kind: 'stale' }
      return unavailable('session', '准备 fixture 未建立合成会话', e)
    }
  }
  const sessionRead = await guardedGet<SessionView>(guard, opts, 'session', '/session')
  if (sessionRead.kind === 'stale') return { kind: 'stale' }
  if (sessionRead.kind === 'failed') {
    return unavailable(
      'session',
      mode === 'real'
        ? '当前会话没有读取成功，请先登录后重新读取。'
        : '准备 fixture 未建立合成会话',
      sessionRead.error,
    )
  }
  const session = sessionRead.data
  if (!validId(session?.userId) || !Array.isArray(session.courses) ||
    !validId(session.csrfToken) || !session.courses.every(c => validId(c?.courseId) && ['student', 'teacher'].includes(c.role))) {
    return unavailable('session', '会话响应缺少 userId / courses，无法确定身份归属')
  }
  setCsrfToken(typeof session.csrfToken === 'string' ? session.csrfToken : null)

  /* 2. 正常模式只读深链的授权 bootstrap；代际来自服务，首次作品仍由学生显式开始。 */
  let assignment: AssignmentView
  let recoveryGeneration: string
  let currentAttemptId: string | null = null
  if (mode === 'real') {
    const assignmentId = guard.context.assignmentId
    if (!validId(assignmentId)) return unavailable('discovery', '请从获准的任务链接进入工作区。')
    const read = await guardedGet<AssignmentBootstrapView>(guard, opts, `bootstrap:${assignmentId}`,
      `/assignments/${encodeURIComponent(assignmentId)}/bootstrap`,
    )
    if (read.kind === 'stale') return { kind: 'stale' }
    if (read.kind === 'failed') {
      const failure = failureOf(read.error)
      const forbidden = failure?.kind === 'api' && failure.status === 403 && failure.error.code === 'FORBIDDEN'
      return unavailable('assignment', forbidden
        ? '当前账号无法访问这个任务。课程或任务范围可能已调整，请返回“我的任务”选择当前可访问的任务。'
        : '这项分配没有读取成功，请核对任务链接或重新登录。', read.error)
    }
    if (!validId(read.data?.recoveryGeneration)) return unavailable('assignment', '工作区恢复状态没有读取完整，请重新读取。')
    assignment = read.data.assignment
    recoveryGeneration = read.data.recoveryGeneration
    if (!(read.data.currentAttemptId === null || validId(read.data.currentAttemptId))) {
      return unavailable('assignment', '当前作品引用没有读取完整，请重新读取。')
    }
    currentAttemptId = read.data.currentAttemptId
    if (!validAssignment(assignment, assignmentId)) return unavailable('assignment', '分配信息与任务链接不符，请重新读取。')
  } else if (PREP_BUILD && prepContext) {
    // 登录前 context 不暴露已有 Attempt；准备模式登录后才回取获准引用。
    const authorized = await guardedGet<PrepContextView>(guard,
      { ...opts, absolutePath: prepContextUrl(mode)! }, 'prep-context', '')
    if (authorized.kind === 'stale') return { kind: 'stale' }
    if (authorized.kind === 'failed') return unavailable('context', '准备工作区引用没有读取成功', authorized.error)
    if (authorized.data.preparationEpoch !== prepContext.preparationEpoch ||
      authorized.data.recoveryGeneration !== prepContext.recoveryGeneration ||
      authorized.data.syntheticAccount.userId !== session.userId ||
      authorized.data.refs.assignmentId !== prepContext.refs.assignmentId) return unavailable('context', '准备工作区已变化，请重新读取。')
    prepContext = authorized.data
    const assignmentId = prepContext.refs.assignmentId
    const read = await guardedGet<AssignmentView>(guard, opts, `assignment:${assignmentId}`,
      `/assignments/${encodeURIComponent(assignmentId)}`)
    if (read.kind === 'stale') return { kind: 'stale' }
    if (read.kind === 'failed') return unavailable('assignment', '读取分配失败', read.error)
    assignment = read.data
    recoveryGeneration = prepContext.recoveryGeneration
    if (!validAssignment(assignment, assignmentId) || assignment.activityVersionId !== prepContext.refs.activityVersionId) {
      return unavailable('assignment', '分配信息与准备引用不符，请重新读取。')
    }
  } else return unavailable('context', '当前工作区模式不可用。')

  /* 3. 分配归属始终来自当前 Session。 */
  if (assignment.studentId !== session.userId) {
    return unavailable(
      'assignment',
      '当前账号不是这项分配的学生，请核对任务链接或重新登录。',
    )
  }

  /* 4. 固定活动版本（student 视角）：核对版本 ID、视角与课程归属。 */
  const activityVersionId = assignment.activityVersionId
  const activityRead = await guardedGet<ActivityView>(
    guard,
    opts,
    `activity:${activityVersionId}`,
    `/activities/${encodeURIComponent(activityVersionId)}?audience=student`,
  )
  if (activityRead.kind === 'stale') return { kind: 'stale' }
  if (activityRead.kind === 'failed') return unavailable('activity', '读取活动版本失败', activityRead.error)
  const activity = activityRead.data
  if (!activity || typeof activity !== 'object' || !activity.content || !activity.content.content ||
    !validId(activity.courseId) || !validId(activity.runtimeProfileVersionId) || !activity.helpPolicy ||
    typeof activity.helpPolicy.helpAllowed !== 'boolean' || !Array.isArray(activity.content.materials) ||
    !['routes', 'goals', 'tasks', 'observations', 'rubricCriteria', 'milestones'].every(key =>
      Array.isArray(activity.content.content[key as keyof typeof activity.content.content]))) {
    return unavailable('activity', '活动信息没有读取完整，请重新读取。')
  }
  if (activity.activityVersionId !== activityVersionId) {
    return unavailable(
      'activity',
      `活动版本不匹配：分配指向 ${activityVersionId}，响应给出 ${activity.activityVersionId ?? '(缺)'}`,
    )
  }
  if (activity.content?.audience !== 'student') {
    return unavailable(
      'activity',
      `活动投影视角不是 student（实际 ${activity.content?.audience ?? '(缺)'}），不采用非学生视角内容`,
    )
  }
  if (!session.courses.some((c) => c.courseId === activity.courseId && c.role === 'student')) {
    return unavailable('activity', '当前账号不属于这项活动的学生范围。')
  }
  if (activity.activityControlRevision !== assignment.activityControlRevision ||
    !['active', 'paused'].includes(activity.status) || (assignment.active && activity.status !== 'active')) {
    return unavailable('activity', '活动状态已变化，请重新读取。')
  }
  try {
    await verifyHdlActivity(activity.execution, activity.runtimeProfileVersionId)
    if (guard.stale) return { kind: 'stale' }
  } catch {
    return unavailable('activity', 'HDL 活动配置或版本不完整，请重新读取；不会使用模拟板卡。')
  }

  /* 5. 材料：只对活动投影标为 available 的条目发起读取；redacted / unavailable 不补正文。 */
  const projected = activity.content.materials ?? []
  const materials: MaterialRead[] = []
  for (let index = 0; index < projected.length; index++) {
    const m = projected[index]!
    if (m.status !== 'available') {
      materials.push({ index, projectedStatus: m.status, state: { kind: 'not-readable', reason: m.status } })
      continue
    }
    const resourceVersionId = m.resourceVersionId
    const read = await guardedGet<ResourceStudentView>(
      guard,
      opts,
      `resource:${resourceVersionId}`,
      `/resources/${encodeURIComponent(resourceVersionId)}`,
    )
    if (read.kind === 'stale') return { kind: 'stale' }
    if (read.kind === 'failed') {
      // 单条材料读取失败不推翻整个初始化：如实标失败，其余材料继续
      materials.push({
        index,
        projectedStatus: m.status,
        state: {
          kind: 'failed',
          resourceVersionId,
          failure: failureOf(read.error) ?? { kind: 'transport', message: messageOf(read.error) },
        },
      })
      continue
    }
    const view = read.data
    if (!view || view.resourceVersionId !== resourceVersionId || view.status !== 'available' ||
      typeof view.text !== 'string' || typeof view.title !== 'string' || !Array.isArray(view.paragraphs)) {
      materials.push({
        index,
        projectedStatus: m.status,
        state: {
          kind: 'failed',
          resourceVersionId,
          failure: {
            kind: 'protocol',
            status: 200,
            message: `资源归属、状态或正文不符（resourceVersionId=${view?.resourceVersionId ?? '(缺)'}，status=${view?.status ?? '(缺)'}）`,
          },
        },
      })
      continue
    }
    materials.push({ index, projectedStatus: m.status, state: { kind: 'loaded', view } })
  }

  const context: WorkspaceContext = {
    ...guard.context,
    userId: session.userId,
    assignmentId: assignment.assignmentId,
    activityVersionId: activity.activityVersionId,
    attemptId: mode === 'real' ? currentAttemptId : guard.context.attemptId,
    trustedRecoveryGeneration: recoveryGeneration,
    preparationEpoch: prepContext?.preparationEpoch ?? null,
  }

  return { kind: 'ready', context, session, assignment, activity, materials, prepContext }
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
}
function validAssignment(value: AssignmentView | undefined, expectedId: string): value is AssignmentView {
  return !!value && value.assignmentId === expectedId && validId(value.activityVersionId) && validId(value.studentId) &&
    Number.isSafeInteger(value.assignmentRevision) && value.assignmentRevision > 0 &&
    Number.isSafeInteger(value.activityControlRevision) && value.activityControlRevision > 0 &&
    typeof value.active === 'boolean' && ['active', 'paused'].includes(value.status) &&
    !(value.active && value.status === 'paused') && typeof value.reasons?.individual === 'string' && typeof value.reasons?.activity === 'string'
}
