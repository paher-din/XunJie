/**
 * I0-A 准备模式的 Vite 开发 fixture。
 *
 * 依据 docs/tasks/I0_UI_CLIENT_CONTRACT.md §2：`npm run dev:prep` 启动已有 Vite，并**仅在**
 * preparation 模式的开发进程里挂上这层 middleware。它提供与真实后端相同的路径、输入、信封与
 * 响应投影，只是 base 前缀换成开发专用的 `/__i0prep`。
 *
 * 边界：
 * - `apply: 'serve'` + `vite.config.ts` 的 `mode === 'prep' && command === 'serve'` 双重限定，
 *   因此 `npm run build` 的正式产物与 `npm run preview` 都不含这些端点；
 * - 只接受 loopback 请求，不对局域网开放；
 * - 不导入后端 implementation；HTTP 错误与公开契约通过 `@xunjie/contracts` 复用；
 * - 实现 01 的读取/开发会话和 03 的保存/快照/恢复脚本；不实现真实鉴权、GCC、调度、模型或完整后台，
 *   其状态转换不能用来验证服务端业务正确性。
 */

import { errorDefinitions as ERROR_DEFINITIONS } from '@xunjie/contracts/http'
import type { ApiErrorCode as ErrorCode } from '@xunjie/contracts/http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { Plugin } from 'vite'
import type {
  ActivityView,
  AssignmentView,
  LogoutView,
  PrepContextView,
  ResourceStudentView,
  SessionCreatedView,
  SessionView,
} from '../src/workspace/contracts'
import {
  SESSION_COOKIE,
  authoritySummary,
  createSession,
  destroySession,
  preparationEpoch,
  readSessionCookie,
  sessionOf,
  type PrepSession,
} from './authority'
import {
  ACTIVITY_CONTENT,
  HELP_POLICY,
  MATERIALS,
  REFS,
  SCENARIO_ID,
  SYNTHETIC_ACCOUNT,
  paragraphsOf,
  projectMaterials,
  sha256Hex,
} from './scenario'
import { createPrepAttempt, readPrepAttempt, syncPrepWorkspace, freezePrepSnapshot, readPrepSnapshot, recoverPrepWorkspace,
  setPrepAttemptState, PrepWorkspaceError, recoveryGenerationOf, existingPrepAttemptId } from './workspace'
import { createPrepRun, readPrepJob, readPrepRun, setPrepRunScript, cancelPrepRun, readPrepRunFiles, seedPrepHistory } from './workspace'
import { createPrepHelp, ownsPrepTutorJob, readPrepTutorJob, cancelPrepHelp, readPrepTutorEvents, recordPrepTutorReceipt, setPrepTutorScript, stopPrepTutoring, recordPrepTutorCoverage, readPrepTutorHistory } from './tutoring'
import { prepTeachingCommand } from './workspace'
import { createPrepControlHandler } from './tutoringControls'
const prepTutorControls=createPrepControlHandler({prepTeachingCommand,assignmentActive:()=>true,stopTeaching:stopPrepTutoring})
import { isPrepFault, prepFaultOf, setPrepFault } from './faults'

export const PREP_ROOT = '/__i0prep'

/* ---------- 响应工具（信封形状见 contracts/common/http.ts:1,23-26） ---------- */

/**
 * 一次响应只用一个 requestId：响应头 `x-request-id` 与信封里的 `requestId` 同值。
 * 真实后端也是同一个 `request.id`（apps/server/server/app.ts:21,53，`requestIdHeader: false`），
 * 因此客户端只从信封取 requestId，不依赖响应头。
 */
function send(
  res: ServerResponse,
  status: number,
  requestId: string,
  body: unknown,
  extraHeaders?: Record<string, string>,
): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('x-request-id', requestId)
  for (const [k, v] of Object.entries(extraHeaders ?? {})) res.setHeader(k, v)
  res.end(JSON.stringify(body))
}

function ok(res: ServerResponse, data: unknown, extraHeaders?: Record<string, string>): void {
  const requestId = randomUUID()
  send(res, 200, requestId, { requestId, data }, extraHeaders)
}

function fail(res: ServerResponse, code: ErrorCode): void {
  const requestId = randomUUID()
  const d = ERROR_DEFINITIONS[code]
  send(res, d.status, requestId, {
    requestId,
    error: { code, message: d.message, retryable: d.retryable, recovery: d.recovery },
  })
}

function isLoopback(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? ''
  const local = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
  const host = (req.headers.host ?? '').replace(/:\d+$/, '')
  return local && (host === '127.0.0.1' || host === 'localhost' || host === '')
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.length === 0) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

function csrfHeader(req: IncomingMessage): string | undefined {
  const v = req.headers['x-csrf-token']
  return Array.isArray(v) ? v[0] : v
}

/* ---------- 各端点 ---------- */

function sessionCookieOf(req: IncomingMessage): string | undefined {
  const header = req.headers.cookie
  return readSessionCookie(Array.isArray(header) ? header.join('; ') : header)
}

function scenarioOf(req: IncomingMessage): string {
  const value = req.headers['x-i0prep-scenario']
  return typeof value === 'string' ? value : SCENARIO_ID
}

function requireSession(req: IncomingMessage, res: ServerResponse): PrepSession | null {
  const session = sessionOf(sessionCookieOf(req), scenarioOf(req))
  if (!session) fail(res, 'UNAUTHENTICATED')
  return session
}

/** 准备 bootstrap 元信息：开发 fixture 的配置入口，不是拟定的正式 API。 */
type WorkspacePrepContext = Omit<PrepContextView, 'capabilities' | 'refs'> & {
  refs: PrepContextView['refs'] & { attemptId?: string }
  capabilities: { attemptCreate: boolean; workspaceSync: boolean; snapshot: boolean; run: boolean }
}
function contextPayload(req: IncomingMessage): WorkspacePrepContext {
  const scenarioId = scenarioOf(req)
  const generation = recoveryGenerationOf(scenarioId)
  const attemptId = existingPrepAttemptId(scenarioId, sessionOf(sessionCookieOf(req), scenarioId))
  return {
    scenarioId,
    preparationEpoch,
    recoveryGeneration: generation,
    syntheticAccount: {
      loginName: SYNTHETIC_ACCOUNT.loginName,
      password: SYNTHETIC_ACCOUNT.password,
      userId: SYNTHETIC_ACCOUNT.userId,
      courseId: SYNTHETIC_ACCOUNT.courseId,
    },
    refs: {
      assignmentId: REFS.assignmentId,
      activityVersionId: REFS.activityVersionId,
      resourceVersionIds: MATERIALS.map((m) => m.resourceVersionId),
      ...(attemptId ? { attemptId } : {}),
    },
    capabilities: { attemptCreate: true, workspaceSync: true, snapshot: true, run: true },
    authority: { ...authoritySummary(scenarioId), recoveryGeneration: generation },
  }
}

/** POST sessions：形状见 `apps/server/server/access/app.ts:114-145`。 */
async function handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: unknown
  try {
    body = await readBody(req)
  } catch {
    fail(res, 'INVALID_REQUEST')
    return
  }
  const b = body as { loginName?: unknown; password?: unknown }
  if (typeof b?.loginName !== 'string' || typeof b.password !== 'string') {
    fail(res, 'INVALID_REQUEST')
    return
  }
  if (b.loginName !== SYNTHETIC_ACCOUNT.loginName || b.password !== SYNTHETIC_ACCOUNT.password) {
    fail(res, 'UNAUTHENTICATED')
    return
  }
  const session = createSession(b.loginName, scenarioOf(req))
  const data: SessionCreatedView = { csrfToken: session.csrfToken }
  // 开发专用 cookie：无 Secure（http://127.0.0.1 上无法下发 `__Host-`），见 authority.ts 文件头
  ok(res, data, {
    'Set-Cookie': `${SESSION_COOKIE}=${session.sessionId}; Path=/; HttpOnly; SameSite=Lax`,
  })
}

/** GET session：形状见 `apps/server/server/access/app.ts:102-113` 与 `tests/records-adapter.test.ts:105-108`。 */
function handleSession(req: IncomingMessage, res: ServerResponse): void {
  const session = requireSession(req, res)
  if (!session) return
  const data: SessionView = {
    userId: session.userId,
    courses: [{ courseId: session.courseId, role: 'student' }],
    csrfToken: session.csrfToken,
  }
  ok(res, data)
}

/** POST logout：形状见 `apps/server/server/access/app.ts:146-150`。 */
function handleLogout(req: IncomingMessage, res: ServerResponse): void {
  const session = requireSession(req, res)
  if (!session) return
  if (csrfHeader(req) !== session.csrfToken) {
    fail(res, 'FORBIDDEN')
    return
  }
  destroySession(session.sessionId)
  const data: LogoutView = { loggedOut: true }
  ok(res, data, { 'Set-Cookie': `${SESSION_COOKIE}=; Path=/; Max-Age=0` })
}

/** GET assignments/:id：形状见 `contracts/design/results.ts:55-56`（assignmentViewSchema）。 */
function handleAssignment(req: IncomingMessage, res: ServerResponse, id: string): void {
  const session = requireSession(req, res)
  if (!session) return
  // 未知 / 跨课程 / 非本人的分配一律 403（`server/design/activities.ts:83-87,106-108`）
  if (id !== REFS.assignmentId) {
    fail(res, 'FORBIDDEN')
    return
  }
  const data: AssignmentView = {
    assignmentId: REFS.assignmentId,
    activityVersionId: REFS.activityVersionId,
    studentId: session.userId,
    assignmentRevision: 1,
    active: true,
    status: 'active',
    reasons: { individual: '', activity: '' },
    activityControlRevision: 1,
  }
  ok(res, data)
}

/** GET activities/:id?audience=student：形状见 `contracts/design/results.ts:52-54`（activityViewSchema）。 */
function handleActivity(req: IncomingMessage, res: ServerResponse, id: string, audience: string | null): void {
  const session = requireSession(req, res)
  if (!session) return
  if (id !== REFS.activityVersionId) {
    fail(res, 'FORBIDDEN')
    return
  }
  const requested = audience ?? 'student'
  if (!['student', 'tutor', 'teacher-validator'].includes(requested)) {
    fail(res, 'INVALID_REQUEST')
    return
  }
  // 合成身份只有 student 角色：请求其它视角按 `server/design/application.ts:66` 返回 403
  if (requested !== 'student') {
    fail(res, 'FORBIDDEN')
    return
  }
  const data: ActivityView = {
    activityVersionId: REFS.activityVersionId,
    courseId: session.courseId,
    activityControlRevision: 1,
    status: 'active',
    content: {
      audience: 'student',
      content: ACTIVITY_CONTENT,
      materials: projectMaterials('student'),
    },
    helpPolicy: HELP_POLICY,
    runtimeProfileVersionId: REFS.runtimeProfileVersionId,
  }
  ok(res, data)
}

/** GET resources/:id：student 视角只返回可投影的学习材料，其余 403（`server/design/application.ts:87,91-96`）。 */
function handleResource(req: IncomingMessage, res: ServerResponse, id: string): void {
  const session = requireSession(req, res)
  if (!session) return
  const material = MATERIALS.find((m) => m.resourceVersionId === id)
  if (!material || !material.available || material.kind !== 'learning_material' || !material.visibility.student) {
    fail(res, 'FORBIDDEN')
    return
  }
  const data: ResourceStudentView = {
    status: 'available',
    resourceVersionId: material.resourceVersionId,
    title: material.title,
    text: material.text,
    contentHash: sha256Hex(material.text),
    paragraphs: paragraphsOf(material.resourceVersionId, material.text),
  }
  ok(res, data)
}

/* ---------- 路由分发 ---------- */

async function handle(req: IncomingMessage, res: ServerResponse, url: string): Promise<void> {
  const method = req.method ?? 'GET'
  const qIndex = url.indexOf('?')
  const path = qIndex >= 0 ? url.slice(0, qIndex) : url
  const query = new URLSearchParams(qIndex >= 0 ? url.slice(qIndex + 1) : '')

  if (path === `${PREP_ROOT}/context`) {
    if (method !== 'GET') return fail(res, 'INVALID_REQUEST')
    return ok(res, contextPayload(req))
  }

  if (path === `${PREP_ROOT}/fault` && method === 'POST') {
    const session = requireSession(req, res)
    if (!session) return
    if (csrfHeader(req) !== session.csrfToken) return fail(res, 'FORBIDDEN')
    let body: unknown
    try { body = await readBody(req) } catch { return fail(res, 'INVALID_REQUEST') }
    const kind = (body as { kind?: unknown }).kind
    if (!isPrepFault(kind)) return fail(res, 'INVALID_REQUEST')
    return ok(res, { scenarioId: scenarioOf(req), fault: setPrepFault(scenarioOf(req), kind) })
  }

  // 06B：开发专用公开历史样例，不增加 Core 的 Report/课程检查创建能力。
  if (path === `${PREP_ROOT}/history-sample` && method === 'POST') {
    const session = requireSession(req, res)
    if (!session) return
    if (csrfHeader(req) !== session.csrfToken) return fail(res, 'FORBIDDEN')
    let body: unknown
    try { body = await readBody(req) } catch { return fail(res, 'INVALID_REQUEST') }
    try { return ok(res, seedPrepHistory(scenarioOf(req), session, body)) } catch (error) {
      if (error instanceof PrepWorkspaceError) return fail(res, error.code)
      throw error
    }
  }

  // 06：开发专用运行状态脚本。
  if (path === `${PREP_ROOT}/tutor-script` && method === 'POST') {
    const session=requireSession(req,res)
    if (!session) return
    if (csrfHeader(req)!==session.csrfToken) return fail(res,'FORBIDDEN')
    let body:unknown
    try {body=await readBody(req)} catch {return fail(res,'INVALID_REQUEST')}
    try {return ok(res,setPrepTutorScript(scenarioOf(req),body,session))} catch(error) {
      if (error instanceof PrepWorkspaceError) return fail(res,error.code)
      throw error
    }
  }
  if (path === `${PREP_ROOT}/run-script` && method === 'POST') {
    const session = requireSession(req, res)
    if (!session) return
    if (csrfHeader(req) !== session.csrfToken) return fail(res, 'FORBIDDEN')
    let body: unknown
    try { body = await readBody(req) } catch { return fail(res, 'INVALID_REQUEST') }
    try { return ok(res, setPrepRunScript(scenarioOf(req), body)) } catch (error) {
      if (error instanceof PrepWorkspaceError) return fail(res, error.code)
      throw error
    }
  }

  // 05：开发专用 Attempt 状态开关（暂停 / 终态），只用于核对「不可操作」的门控。
  if (path === `${PREP_ROOT}/attempt-state` && method === 'POST') {
    const session = requireSession(req, res)
    if (!session) return
    if (csrfHeader(req) !== session.csrfToken) return fail(res, 'FORBIDDEN')
    let body: unknown
    try { body = await readBody(req) } catch { return fail(res, 'INVALID_REQUEST') }
    try { return ok(res, setPrepAttemptState(scenarioOf(req), session, body)) } catch (error) {
      if (error instanceof PrepWorkspaceError) return fail(res, error.code)
      throw error
    }
  }

  if (path === `${PREP_ROOT}/recover` && method === 'POST') {
    const session = requireSession(req, res)
    if (!session) return
    if (csrfHeader(req) !== session.csrfToken) return fail(res, 'FORBIDDEN')
    let body: unknown
    try { body = await readBody(req) } catch { return fail(res, 'INVALID_REQUEST') }
    try { return ok(res, recoverPrepWorkspace(scenarioOf(req), session, body)) } catch (error) {
      if (error instanceof PrepWorkspaceError) return fail(res, error.code)
      throw error
    }
  }

  if (!path.startsWith(`${PREP_ROOT}/api/`)) {
    // 与后端 notFound 行为一致：未知路径转 400 INVALID_REQUEST（`server/app.ts:39-41`）
    return fail(res, 'INVALID_REQUEST')
  }

  const route = path.slice(`${PREP_ROOT}/api`.length)

  if (route === '/sessions' && method === 'POST') return void (await handleLogin(req, res))
  if (route === '/session' && method === 'GET') return handleSession(req, res)
  if (route === '/logout' && method === 'POST') return handleLogout(req, res)

  const scenario = scenarioOf(req)
  const attemptCreate = route.match(/^\/assignments\/([^/]+)\/attempts$/)
  const attemptRead = route.match(/^\/attempts\/([^/]+)$/)
  const sync = route.match(/^\/attempts\/([^/]+)\/sync$/)
  const snapshotCreate = route.match(/^\/attempts\/([^/]+)\/snapshots$/)
  const snapshotRead = route.match(/^\/attempts\/([^/]+)\/snapshots\/([^/]+)$/)
  const runCreate = route.match(/^\/attempts\/([^/]+)\/runs$/)
  const runRead = route.match(/^\/attempts\/([^/]+)\/runs\/([^/]+)$/)
  const runFiles = route.match(/^\/attempts\/([^/]+)\/runs\/([^/]+)\/files$/)
  const jobRead = route.match(/^\/jobs\/([^/]+)$/)
  const jobCancel = route.match(/^\/jobs\/([^/]+)\/cancel$/)
  const tutorHelp = route.match(/^\/attempts\/([^/]+)\/help$/)
  const tutorEvents = route.match(/^\/attempts\/([^/]+)\/events$/)
  const tutorHistory = route.match(/^\/attempts\/([^/]+)\/teaching-records$/)
  const tutorReceipt = route.match(/^\/actions\/([^/]+)\/receipts$/)
  const tutorControl = route.match(/^\/attempts\/([^/]+)\/controls$/)
  if ((attemptCreate && method === 'POST') || (attemptRead && method === 'GET') || (sync && method === 'POST')
    || (snapshotCreate && method === 'POST') || (snapshotRead && method === 'GET') || (runCreate && method === 'POST')
    || (runRead && method === 'GET') || (runFiles && method === 'GET') || (jobRead && method === 'GET') || (jobCancel && method === 'POST')
    || (tutorHelp && method === 'POST') || (tutorEvents && method === 'GET') || (tutorHistory && method === 'GET') || (tutorReceipt && method === 'POST') || (tutorControl && method === 'POST')) {
    const session = requireSession(req, res)
    if (!session) return
    if (method === 'POST' && csrfHeader(req) !== session.csrfToken) return fail(res, 'FORBIDDEN')
    let body: unknown
    if (method === 'POST') {
      try { body = await readBody(req) } catch { return fail(res, 'INVALID_REQUEST') }
    }
    // 写命令故障（仅 prep 开发/测试进程）：
    // - fail-write：命令不提交，返回服务端真实存在的一类暂时不可用，用于核对「可重试的拒绝」；
    // - drop-ack：命令照常提交，但不下发响应并断开连接，用于核对「服务已提交、ACK 丢失」。
    // 错误响应走 fail()，因此服务拒绝不会被伪装成「结果未知」。
    if (method === 'POST' && prepFaultOf(scenario) === 'fail-write') return fail(res, 'PERSISTENCE_UNAVAILABLE')
    const dropAck = method === 'POST' && prepFaultOf(scenario) === 'drop-ack'
    const respond = (data: unknown): void => {
      if (dropAck) { req.socket.destroy(); return }
      ok(res, data)
    }
    try {
      if (tutorControl) {
        const id=decodeURIComponent(tutorControl[1]!),result=prepTutorControls(scenario,session,id,body,req.headers['idempotency-key'])
        recordPrepTutorCoverage(scenario,session,id,result.serverSeq)
        return respond(result)
      }
      if (tutorHelp) return respond(createPrepHelp(scenario, session, decodeURIComponent(tutorHelp[1]!), body, req.headers['idempotency-key']))
      if (tutorEvents) return ok(res, readPrepTutorEvents(scenario, session, decodeURIComponent(tutorEvents[1]!), query))
      // Existing workspace/application.ts:293 and records/teaching.ts:653 student projection.
      if (tutorHistory) return ok(res, readPrepTutorHistory(scenario, session, decodeURIComponent(tutorHistory[1]!)))
      if (tutorReceipt) return respond(recordPrepTutorReceipt(scenario, session, decodeURIComponent(tutorReceipt[1]!), body, req.headers['idempotency-key']))
      if (jobCancel && ownsPrepTutorJob(scenario, decodeURIComponent(jobCancel[1]!))) return respond(cancelPrepHelp(scenario, session, decodeURIComponent(jobCancel[1]!), body, req.headers['idempotency-key']))
      if (jobRead && ownsPrepTutorJob(scenario, decodeURIComponent(jobRead[1]!))) return ok(res, readPrepTutorJob(scenario, session, decodeURIComponent(jobRead[1]!)))
      if (jobCancel) return respond(cancelPrepRun(scenario, session, decodeURIComponent(jobCancel[1]!), body, req.headers['idempotency-key']))
      if (jobRead) return ok(res, readPrepJob(scenario, session, decodeURIComponent(jobRead[1]!)))
      if (runFiles) return ok(res, readPrepRunFiles(scenario, session, decodeURIComponent(runFiles[1]!), decodeURIComponent(runFiles[2]!)))
      if (runRead) return ok(res, readPrepRun(scenario, session, decodeURIComponent(runRead[1]!), decodeURIComponent(runRead[2]!)))
      if (runCreate) return respond(createPrepRun(scenario, session, decodeURIComponent(runCreate[1]!), body, req.headers['idempotency-key']))
      if (snapshotRead) return ok(res, readPrepSnapshot(scenario, session, decodeURIComponent(snapshotRead[1]!), decodeURIComponent(snapshotRead[2]!)))
      if (snapshotCreate) return respond(freezePrepSnapshot(scenario, session, decodeURIComponent(snapshotCreate[1]!), body, req.headers['idempotency-key']))
      if (sync) return respond(syncPrepWorkspace(scenario, session, decodeURIComponent(sync[1]!), body, req.headers['idempotency-key']))
      if (attemptCreate) return respond(createPrepAttempt(scenario, session, decodeURIComponent(attemptCreate[1]!), body, req.headers['idempotency-key']))
      return ok(res, readPrepAttempt(scenario, session, decodeURIComponent(attemptRead![1]!)))
    } catch (error) {
      if (error instanceof PrepWorkspaceError) return fail(res, error.code)
      throw error
    }
  }

  const segments = route.split('/').filter((s) => s.length > 0)
  if (segments.length === 2 && method === 'GET') {
    const [kind, rawId] = segments as [string, string]
    const id = decodeURIComponent(rawId)
    if (kind === 'assignments') return handleAssignment(req, res, id)
    if (kind === 'activities') return handleActivity(req, res, id, query.get('audience'))
    if (kind === 'resources') return handleResource(req, res, id)
  }

  return fail(res, 'INVALID_REQUEST')
}

/** fixture 需要的最小日志面；Vite 的 `server.config.logger` 结构上满足它。 */
export interface PrepFixtureLog {
  info(message: string): void
  error(message: string): void
}

/**
 * 准备 fixture 的 middleware。
 *
 * 与 Vite 解耦，因此契约核对可以用 node 原生 http 直接挂载它（`prep/contract.test.ts`），
 * 不必为了跑断言启动整个开发服务器；插件只是把它接到开发进程的 middleware 栈上。
 */
export function createPrepMiddleware(
  log: PrepFixtureLog,
): (req: IncomingMessage, res: ServerResponse, next: () => void) => void {
  return (req, res, next) => {
    const url = req.url ?? ''
    if (!url.startsWith(PREP_ROOT)) return next()
    if (!isLoopback(req)) return fail(res, 'FORBIDDEN')
    const scenario = req.headers['x-i0prep-scenario']
    if (scenario !== undefined && (typeof scenario !== 'string' || !scenario.length || scenario.length > 128)) return fail(res, 'INVALID_REQUEST')
    void handle(req, res, url).catch((e: unknown) => {
      // 不把根因吞成一个 400：原始错误（含栈）先进开发日志，再按客户端错误回应。
      log.error(
        `[i0-prep] 处理 ${url} 抛出未捕获错误：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
      )
      if (!res.headersSent) fail(res, 'INVALID_REQUEST')
    })
  }
}

/** 准备 fixture 插件：只在开发进程注册，构建与预览不加载。 */
export function i0PrepFixture(): Plugin {
  return {
    name: 'xunjie-i0-prep-fixture',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(createPrepMiddleware(server.config.logger))
      server.config.logger.info(
        `[i0-prep] fixture 就绪 · scenario=${SCENARIO_ID} · epoch=${preparationEpoch} · 端点 ${PREP_ROOT}/context 与 ${PREP_ROOT}/api/*（仅 loopback，不进构建产物）`,
      )
    },
  }
}
