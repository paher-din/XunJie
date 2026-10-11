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
 * - real：直接 `GET /session`。本人分配发现入口（H-02）与正常业务宿主（H-01）尚未交接，
 *   此时如实报告不可用，不硬编码正式对象 ID、不遍历猜测、不回退到准备 fixture 或 Mock 成功。
 */

import type {
  ActivityView,
  AssignmentView,
  PrepContextView,
  ProjectedMaterial,
  ResourceStudentView,
  SessionCreatedView,
  SessionView,
} from './contracts'
import { ContextGuard, type WorkspaceContext } from './context'
import { apiGet, apiPost, setCsrfToken, type RequestFailure, WorkspaceRequestError } from './http'
import { prepContextUrl, type WorkspaceMode } from './mode'

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

function unavailable(stage: InitStage, reason: string, e?: unknown): WorkspaceInit {
  return { kind: 'unavailable', stage, reason: e === undefined ? reason : `${reason}：${messageOf(e)}`, failure: e === undefined ? null : failureOf(e) }
}

/**
 * 按当前守卫执行一次完整的初始化读取。
 *
 * 守卫失效（换上下文、卸载、主动重载）时立刻返回 `{ kind: 'stale' }`，调用方丢弃结果。
 */
export async function loadWorkspaceInit(guard: ContextGuard): Promise<WorkspaceInit> {
  const mode: WorkspaceMode = guard.context.mode
  const opts = { mode }

  /* 0. 准备模式先取 bootstrap 元信息：合成账号与获准对象引用。真实模式没有这个入口。 */
  let prepContext: PrepContextView | null = null
  if (mode === 'preparation') {
    const url = prepContextUrl(mode)
    if (!url) return unavailable('context', '准备模式没有 bootstrap 端点')
    const seq = guard.nextReadSeq('prep-context')
    try {
      prepContext = await apiGet<PrepContextView>('', { ...opts, absolutePath: url })
    } catch (e) {
      return guard.stale ? { kind: 'stale' } : unavailable('context', '准备 bootstrap 元信息不可用', e)
    }
    if (!guard.acceptRead('prep-context', seq)) return { kind: 'stale' }
    if (!prepContext?.refs?.assignmentId || !prepContext.syntheticAccount?.loginName) {
      return unavailable('context', '准备 bootstrap 未给出获准的合成 Assignment 引用或合成账号')
    }
  }

  /* 1. 会话：身份只来自 Session，不从昵称或本地设置构造。 */
  const sessionSeq = guard.nextReadSeq('session')
  let session: SessionView
  try {
    if (mode === 'preparation') {
      // 准备身份由 fixture 生成：用合成账号建立开发会话（U-07：不自建登录页面）
      const account = prepContext!.syntheticAccount
      await apiPost<SessionCreatedView>(
        '/sessions',
        { loginName: account.loginName, password: account.password },
        opts,
      )
    }
    session = await apiGet<SessionView>('/session', opts)
  } catch (e) {
    if (guard.stale) return { kind: 'stale' }
    return unavailable(
      'session',
      mode === 'real'
        ? '真实模式取不到当前会话（正常业务宿主与同源 HTTPS 入口属交接项 H-01）'
        : '准备 fixture 未建立合成会话',
      e,
    )
  }
  if (!guard.acceptRead('session', sessionSeq)) return { kind: 'stale' }
  if (typeof session?.userId !== 'string' || !Array.isArray(session.courses)) {
    return unavailable('session', '会话响应缺少 userId / courses，无法确定身份归属')
  }
  setCsrfToken(typeof session.csrfToken === 'string' ? session.csrfToken : null)

  /* 2. 真实模式到此为止：没有获准的分配引用，不猜、不遍历。 */
  if (mode === 'real') {
    return unavailable(
      'discovery',
      '真实模式缺本人分配发现入口（H-02）：已建立会话但没有获准的 Assignment 引用。' +
        '不硬编码正式对象 ID，也不遍历猜测分配。',
    )
  }

  const assignmentId = prepContext!.refs.assignmentId

  /* 3. 分配：核对归属到当前 Session。 */
  const assignmentKey = `assignment:${assignmentId}`
  const asSeq = guard.nextReadSeq(assignmentKey)
  let assignment: AssignmentView
  try {
    assignment = await apiGet<AssignmentView>(`/assignments/${encodeURIComponent(assignmentId)}`, opts)
  } catch (e) {
    if (guard.stale) return { kind: 'stale' }
    return unavailable('assignment', '读取分配失败', e)
  }
  if (!guard.acceptRead(assignmentKey, asSeq)) return { kind: 'stale' }
  if (assignment.studentId !== session.userId) {
    return unavailable(
      'assignment',
      `分配归属不符：studentId=${assignment.studentId ?? '(缺)'} 与当前会话 userId=${session.userId} 不一致`,
    )
  }

  /* 4. 固定活动版本（student 视角）：核对版本 ID、视角与课程归属。 */
  const activityVersionId = assignment.activityVersionId
  const activityKey = `activity:${activityVersionId}`
  const avSeq = guard.nextReadSeq(activityKey)
  let activity: ActivityView
  try {
    activity = await apiGet<ActivityView>(
      `/activities/${encodeURIComponent(activityVersionId)}?audience=student`,
      opts,
    )
  } catch (e) {
    if (guard.stale) return { kind: 'stale' }
    return unavailable('activity', '读取活动版本失败', e)
  }
  if (!guard.acceptRead(activityKey, avSeq)) return { kind: 'stale' }
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
  if (!session.courses.some((c) => c.courseId === activity.courseId)) {
    return unavailable('activity', `活动课程 ${activity.courseId} 不在当前会话的课程归属里`)
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
    const resourceKey = `resource:${resourceVersionId}`
    const seq = guard.nextReadSeq(resourceKey)
    try {
      const view = await apiGet<ResourceStudentView>(`/resources/${encodeURIComponent(resourceVersionId)}`, opts)
      if (!guard.acceptRead(resourceKey, seq)) return { kind: 'stale' }
      if (view.resourceVersionId !== resourceVersionId || view.status !== 'available') {
        materials.push({
          index,
          projectedStatus: m.status,
          state: {
            kind: 'failed',
            resourceVersionId,
            failure: {
              kind: 'protocol',
              status: 200,
              message: `资源归属或状态不符（resourceVersionId=${view.resourceVersionId ?? '(缺)'}，status=${view.status ?? '(缺)'}）`,
            },
          },
        })
        continue
      }
      materials.push({ index, projectedStatus: m.status, state: { kind: 'loaded', view } })
    } catch (e) {
      if (guard.stale) return { kind: 'stale' }
      // 单条材料读取失败不推翻整个初始化：如实标失败，其余材料继续
      guard.acceptRead(resourceKey, seq)
      materials.push({
        index,
        projectedStatus: m.status,
        state: {
          kind: 'failed',
          resourceVersionId,
          failure: failureOf(e) ?? { kind: 'transport', message: messageOf(e) },
        },
      })
    }
  }

  const context: WorkspaceContext = {
    ...guard.context,
    userId: session.userId,
    assignmentId: assignment.assignmentId,
    activityVersionId: activity.activityVersionId,
    trustedRecoveryGeneration: prepContext?.recoveryGeneration ?? null,
    preparationEpoch: prepContext?.preparationEpoch ?? null,
  }

  return { kind: 'ready', context, session, assignment, activity, materials, prepContext }
}
