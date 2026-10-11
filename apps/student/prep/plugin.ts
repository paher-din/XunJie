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
 * - 不导入 `apps/teaching` 的任何模块（前后端独立构建），需要的契约表在本地复制并逐项标注来源；
 * - 只实现 01 需要的读取能力与一个开发会话；不实现真实鉴权、GCC、调度、模型或完整后台，
 *   其状态转换不能用来验证服务端业务正确性。
 */

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
  syntheticRecoveryGeneration,
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

/** 与 `apps/teaching/contracts/common/http.ts:3-19` 的 errorDefinitions 对应条目逐字一致。 */
const ERROR_DEFINITIONS = {
  INVALID_REQUEST: { status: 400, message: 'Invalid request.', retryable: false, recovery: 'Correct the request before retrying.' },
  UNAUTHENTICATED: { status: 401, message: 'Authentication required.', retryable: false, recovery: 'Sign in using a valid account.' },
  FORBIDDEN: { status: 403, message: 'Access denied.', retryable: false, recovery: 'Use an account authorized for this resource.' },
} as const

type ErrorCode = keyof typeof ERROR_DEFINITIONS

const PREP_ROOT = '/__i0prep'

/* ---------- 响应工具（信封形状见 contracts/common/http.ts:1,23-26） ---------- */

function send(res: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  const requestId = randomUUID()
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('x-request-id', requestId)
  for (const [k, v] of Object.entries(extraHeaders ?? {})) res.setHeader(k, v)
  res.end(JSON.stringify(body))
}

function ok(res: ServerResponse, data: unknown, extraHeaders?: Record<string, string>): void {
  send(res, 200, { requestId: randomUUID(), data }, extraHeaders)
}

function fail(res: ServerResponse, code: ErrorCode): void {
  const d = ERROR_DEFINITIONS[code]
  send(res, d.status, {
    requestId: randomUUID(),
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

function requireSession(req: IncomingMessage, res: ServerResponse): PrepSession | null {
  const session = sessionOf(sessionCookieOf(req))
  if (!session) fail(res, 'UNAUTHENTICATED')
  return session
}

/** 准备 bootstrap 元信息：开发 fixture 的配置入口，不是拟定的正式 API。 */
function contextPayload(): PrepContextView {
  return {
    scenarioId: SCENARIO_ID,
    preparationEpoch,
    recoveryGeneration: syntheticRecoveryGeneration,
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
    },
    capabilities: { attemptCreate: false, workspaceSync: false, snapshot: false, run: false },
    authority: authoritySummary(),
  }
}

/** POST sessions：形状见 `apps/teaching/server/access/app.ts:114-145`。 */
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
  const session = createSession(b.loginName)
  const data: SessionCreatedView = { csrfToken: session.csrfToken }
  // 开发专用 cookie：无 Secure（http://127.0.0.1 上无法下发 `__Host-`），见 authority.ts 文件头
  ok(res, data, {
    'Set-Cookie': `${SESSION_COOKIE}=${session.sessionId}; Path=/; HttpOnly; SameSite=Lax`,
  })
}

/** GET session：形状见 `apps/teaching/server/access/app.ts:102-113` 与 `tests/records-adapter.test.ts:105-108`。 */
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

/** POST logout：形状见 `apps/teaching/server/access/app.ts:146-150`。 */
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
    return ok(res, contextPayload())
  }

  if (!path.startsWith(`${PREP_ROOT}/api/`)) {
    // 与后端 notFound 行为一致：未知路径转 400 INVALID_REQUEST（`server/app.ts:39-41`）
    return fail(res, 'INVALID_REQUEST')
  }

  const route = path.slice(`${PREP_ROOT}/api`.length)

  if (route === '/sessions' && method === 'POST') return void (await handleLogin(req, res))
  if (route === '/session' && method === 'GET') return handleSession(req, res)
  if (route === '/logout' && method === 'POST') return handleLogout(req, res)

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

/** 准备 fixture 插件：只在开发进程注册，构建与预览不加载。 */
export function i0PrepFixture(): Plugin {
  return {
    name: 'xunjie-i0-prep-fixture',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? ''
        if (!url.startsWith(PREP_ROOT)) return next()
        if (!isLoopback(req)) return fail(res, 'FORBIDDEN')
        void handle(req, res, url).catch(() => fail(res, 'INVALID_REQUEST'))
      })
      server.config.logger.info(
        `[i0-prep] fixture 就绪 · scenario=${SCENARIO_ID} · epoch=${preparationEpoch} · 端点 ${PREP_ROOT}/context 与 ${PREP_ROOT}/api/*（仅 loopback，不进构建产物）`,
      )
    },
  }
}
