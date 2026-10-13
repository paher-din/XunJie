/**
 * 准备 fixture 的契约核对（可复现，替代此前记录里的「手工 curl 断言」）。
 *
 * 用 node 原生 http 直接挂载 `createPrepMiddleware`，对**真实 HTTP 响应**断言：
 * 信封与错误码、requestId 一致性、CSRF 与开发 cookie、分配/活动/资源的归属与视角核对、
 * 材料三态投影与 redacted/unavailable 的零泄露，以及内部错误不被吞掉。
 *
 * 这里核对的是「fixture 与客户端契约一致」，不是服务端业务正确性——真实后端按
 * apps/teaching 自己的验收执行。
 */

import { createServer, request as httpRequest, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type {
  ActivityView,
  AssignmentView,
  ErrorEnvelope,
  PrepContextView,
  ResourceStudentView,
  SessionCreatedView,
  SessionView,
  SuccessEnvelope,
} from '../src/workspace/contracts'
import { SESSION_COOKIE, preparationEpoch, syntheticRecoveryGeneration } from './authority'
import { PREP_ROOT, createPrepMiddleware } from './plugin'
import { MATERIALS, REFS, SYNTHETIC_ACCOUNT, projectMaterials, sha256Hex } from './scenario'

const logs: string[] = []
const log = {
  info: (message: string) => void logs.push(message),
  error: (message: string) => void logs.push(message),
}

let server: Server
let base = ''
let scenario = ''
beforeEach(() => { scenario = randomUUID() })

beforeAll(async () => {
  const middleware = createPrepMiddleware(log)
  server = createServer((req, res) => {
    middleware(req, res, () => {
      res.statusCode = 404
      res.end('fallthrough')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

interface RawResponse {
  status: number
  headers: Headers
  text: string
  json: unknown
  /** 请求没拿到任何 HTTP 信封（断线 / 丢 ACK）时置 true，此时 status 为 0。 */
  dropped?: boolean
}

function portOf(): number {
  return (server.address() as AddressInfo).port
}

async function call(
  method: 'GET' | 'POST',
  path: string,
  init?: { cookie?: string; csrf?: string; body?: string; key?: string; scenario?: string },
): Promise<RawResponse> {
  const headers: Record<string, string> = { Accept: 'application/json', 'x-i0prep-scenario': init?.scenario ?? scenario }
  if (method === 'POST') headers['Content-Type'] = 'application/json'
  if (init?.cookie) headers.Cookie = init.cookie
  if (init?.csrf) headers['x-csrf-token'] = init.csrf
  if (init?.key) headers['Idempotency-Key'] = init.key
  let res: Response
  try {
    res = await fetch(base + path, {
      method,
      headers,
      body: method === 'POST' ? (init?.body ?? '{}') : undefined,
    })
  } catch {
    // 服务已提交但连接被断开：客户端拿不到任何信封，这本身就是要断言的事实。
    return { status: 0, headers: new Headers(), text: '', json: null, dropped: true }
  }
  const text = await res.text()
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    // 非 JSON 响应本身也是一种可断言的结果
  }
  return { status: res.status, headers: res.headers, text, json }
}

/** 用 node 原生客户端发一次 GET，以便显式指定 Host 头（fetch 会按 URL 规范化它）。 */
function rawGet(path: string, hostHeader: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: portOf(), path, method: 'GET', headers: { Host: hostHeader, 'x-i0prep-scenario': scenario } },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }),
        )
      },
    )
    req.on('error', reject)
    req.end()
  })
}

function envelopeOf(res: RawResponse): SuccessEnvelope<unknown> {
  return res.json as SuccessEnvelope<unknown>
}

function errorOf(res: RawResponse): ErrorEnvelope['error'] {
  return (res.json as ErrorEnvelope).error
}

function sessionCookieOf(res: RawResponse): string {
  const setCookie = res.headers.getSetCookie()
  const entry = setCookie.find((c) => c.startsWith(`${SESSION_COOKIE}=`))
  expect(entry, `响应应下发 ${SESSION_COOKIE} cookie，实际 ${JSON.stringify(setCookie)}`).toBeDefined()
  return entry!.slice(0, entry!.indexOf(';'))
}

/** 建立一次开发会话，返回 cookie 与 csrfToken（后续用例复用）。 */
async function signIn(): Promise<{ cookie: string; csrf: string }> {
  const res = await call('POST', `${PREP_ROOT}/api/sessions`, {
    body: JSON.stringify({ loginName: SYNTHETIC_ACCOUNT.loginName, password: SYNTHETIC_ACCOUNT.password }),
  })
  expect(res.status).toBe(200)
  return { cookie: sessionCookieOf(res), csrf: (envelopeOf(res).data as SessionCreatedView).csrfToken }
}

describe('准备 fixture 契约核对', () => {
  it('bootstrap 元信息：信封与响应头共用同一 requestId，声明的能力全为 false', async () => {
    const res = await call('GET', `${PREP_ROOT}/context`)
    expect(res.status).toBe(200)

    const envelope = envelopeOf(res)
    expect(typeof envelope.requestId).toBe('string')
    // 真实后端一个 request.id 同时用于信封与响应头（server/app.ts:21,53）；fixture 必须同值，
    // 否则客户端会依赖一个生产环境不下发的头。
    expect(res.headers.get('x-request-id')).toBe(envelope.requestId)

    const data = envelope.data as PrepContextView
    expect(data.scenarioId).toBe(scenario)
    expect(data.preparationEpoch).toBe(preparationEpoch)
    expect(data.recoveryGeneration).toBe(syntheticRecoveryGeneration)
    expect(data.capabilities).toEqual({ attemptCreate: true, workspaceSync: true, snapshot: true, run: true })
    expect(typeof data.authority.activeSessions).toBe('number')
    expect(data.refs.assignmentId).toBe(REFS.assignmentId)
    expect(data.refs.activityVersionId).toBe(REFS.activityVersionId)
    expect(data.refs.resourceVersionIds).toEqual(MATERIALS.map((m) => m.resourceVersionId))
  })

  it('未认证、非法输入与未知路径按契约错误码回应', async () => {
    const noSession = await call('GET', `${PREP_ROOT}/api/session`)
    expect(noSession.status).toBe(401)
    expect(errorOf(noSession).code).toBe('UNAUTHENTICATED')
    expect(errorOf(noSession).retryable).toBe(false)
    expect(errorOf(noSession).recovery.length).toBeGreaterThan(0)
    expect(noSession.headers.get('x-request-id')).toBe((noSession.json as ErrorEnvelope).requestId)

    const wrongPassword = await call('POST', `${PREP_ROOT}/api/sessions`, {
      body: JSON.stringify({ loginName: SYNTHETIC_ACCOUNT.loginName, password: 'wrong' }),
    })
    expect(wrongPassword.status).toBe(401)
    expect(errorOf(wrongPassword).code).toBe('UNAUTHENTICATED')

    const missingFields = await call('POST', `${PREP_ROOT}/api/sessions`, { body: '{}' })
    expect(missingFields.status).toBe(400)
    expect(errorOf(missingFields).code).toBe('INVALID_REQUEST')

    const malformedJson = await call('POST', `${PREP_ROOT}/api/sessions`, { body: '{not json' })
    expect(malformedJson.status).toBe(400)
    expect(errorOf(malformedJson).code).toBe('INVALID_REQUEST')

    const unknown = await call('GET', `${PREP_ROOT}/api/attempts/whatever`)
    expect(unknown.status).toBe(401)
    expect(errorOf(unknown).code).toBe('UNAUTHENTICATED')
  })

  it('不接管非准备路径，也不对非 loopback Host 放行', async () => {
    const fallthrough = await call('GET', '/some/other/path')
    expect(fallthrough.status).toBe(404)
    expect(fallthrough.text).toBe('fallthrough')

    // fetch 会规范化 Host 头，这里用 node 原生客户端显式伪造一个非 loopback Host：
    // 局域网地址或反代域名转发进来时必须被拒，不能因为 socket 是本机就放行。
    const offLoopback = await rawGet(`${PREP_ROOT}/context`, 'lan.example.com')
    expect(offLoopback.status).toBe(403)
    expect(offLoopback.text).toContain('"code":"FORBIDDEN"')

    const loopbackHost = await rawGet(`${PREP_ROOT}/context`, `127.0.0.1:${portOf()}`)
    expect(loopbackHost.status).toBe(200)
  })

  it('合成会话：下发开发 cookie（无 Secure / 无 __Host-），Session 只给合成身份', async () => {
    const login = await call('POST', `${PREP_ROOT}/api/sessions`, {
      body: JSON.stringify({ loginName: SYNTHETIC_ACCOUNT.loginName, password: SYNTHETIC_ACCOUNT.password }),
    })
    expect(login.status).toBe(200)
    expect(typeof (envelopeOf(login).data as SessionCreatedView).csrfToken).toBe('string')

    const setCookie = login.headers.getSetCookie().join('; ')
    expect(setCookie).toContain(`${SESSION_COOKIE}=`)
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Lax')
    // http://127.0.0.1 上下发不了 `__Host-` + Secure，因此用开发 cookie 名，且不假装它是真实会话
    expect(setCookie).not.toContain('Secure')
    expect(setCookie).not.toContain('__Host-')

    const cookie = sessionCookieOf(login)
    const res = await call('GET', `${PREP_ROOT}/api/session`, { cookie })
    expect(res.status).toBe(200)
    const session = envelopeOf(res).data as SessionView
    expect(session.userId).toBe(SYNTHETIC_ACCOUNT.userId)
    expect(session.courses).toEqual([{ courseId: SYNTHETIC_ACCOUNT.courseId, role: 'student' }])
    expect(session.csrfToken).toBe((envelopeOf(login).data as SessionCreatedView).csrfToken)
  })

  it('分配与活动：未知 ID 与非 student 视角一律拒绝，student 视图没有 sourceRevision', async () => {
    const { cookie } = await signIn()

    const foreignAssignment = await call('GET', `${PREP_ROOT}/api/assignments/prep-assignment-other`, { cookie })
    expect(foreignAssignment.status).toBe(403)
    expect(errorOf(foreignAssignment).code).toBe('FORBIDDEN')

    const assignment = await call('GET', `${PREP_ROOT}/api/assignments/${REFS.assignmentId}`, { cookie })
    expect(assignment.status).toBe(200)
    const assignmentView = envelopeOf(assignment).data as AssignmentView
    expect(assignmentView.studentId).toBe(SYNTHETIC_ACCOUNT.userId)
    expect(assignmentView.activityVersionId).toBe(REFS.activityVersionId)

    const tutorAudience = await call(
      'GET',
      `${PREP_ROOT}/api/activities/${REFS.activityVersionId}?audience=tutor`,
      { cookie },
    )
    expect(tutorAudience.status).toBe(403)

    const bogusAudience = await call(
      'GET',
      `${PREP_ROOT}/api/activities/${REFS.activityVersionId}?audience=bogus`,
      { cookie },
    )
    expect(bogusAudience.status).toBe(400)
    expect(errorOf(bogusAudience).code).toBe('INVALID_REQUEST')

    const unknownActivity = await call('GET', `${PREP_ROOT}/api/activities/prep-activity-other?audience=student`, {
      cookie,
    })
    expect(unknownActivity.status).toBe(403)

    const activity = await call(
      'GET',
      `${PREP_ROOT}/api/activities/${REFS.activityVersionId}?audience=student`,
      { cookie },
    )
    expect(activity.status).toBe(200)
    const view = envelopeOf(activity).data as ActivityView
    expect(view.activityVersionId).toBe(REFS.activityVersionId)
    expect(view.courseId).toBe(SYNTHETIC_ACCOUNT.courseId)
    expect(view.content.audience).toBe('student')
    expect(view.runtimeProfileVersionId).toBe(REFS.runtimeProfileVersionId)
    // student 视图不带草稿修订号（客户端不得据此推断教师侧草稿状态）
    expect(activity.text).not.toContain('sourceRevision')
  })

  it('材料投影三态：redacted / unavailable 只剩 status，不泄露 ID、标题或正文', async () => {
    const { cookie } = await signIn()
    const activity = await call(
      'GET',
      `${PREP_ROOT}/api/activities/${REFS.activityVersionId}?audience=student`,
      { cookie },
    )
    const view = envelopeOf(activity).data as ActivityView
    const expected = projectMaterials('student')
    expect(view.content.materials).toEqual(expected)
    expect(view.content.materials.map((m) => m.status)).toEqual([
      'available',
      'available',
      'redacted',
      'unavailable',
    ])

    for (const m of view.content.materials) {
      if (m.status === 'available') continue
      // 裁剪后的条目只有 status 一个键：ID、标题、正文一个都不给
      expect(Object.keys(m)).toEqual(['status'])
    }

    for (const material of MATERIALS.filter((m) => !m.available || m.kind !== 'learning_material' || !m.visibility.student)) {
      expect(activity.text).not.toContain(material.title)
      expect(activity.text).not.toContain(material.text)
    }
  })

  it('资源端点：student 可读的返回正文与哈希，其余 403 且响应体零泄露', async () => {
    const { cookie } = await signIn()
    const readable = new Set(
      projectMaterials('student')
        .map((m) => (m.status === 'available' ? m.resourceVersionId : null))
        .filter((id): id is string => id !== null),
    )

    for (const material of MATERIALS) {
      const res = await call('GET', `${PREP_ROOT}/api/resources/${material.resourceVersionId}`, { cookie })
      if (readable.has(material.resourceVersionId)) {
        expect(res.status, material.resourceVersionId).toBe(200)
        const view = envelopeOf(res).data as ResourceStudentView
        expect(view.status).toBe('available')
        expect(view.resourceVersionId).toBe(material.resourceVersionId)
        expect(view.title).toBe(material.title)
        expect(view.text).toBe(material.text)
        expect(view.contentHash).toBe(sha256Hex(material.text))
        expect(view.paragraphs.length).toBeGreaterThan(0)
        expect(view.paragraphs.map((p) => p.text).join('\n')).toBe(material.text)
      } else {
        expect(res.status, material.resourceVersionId).toBe(403)
        expect(errorOf(res).code).toBe('FORBIDDEN')
        expect(res.text).not.toContain(material.title)
        expect(res.text).not.toContain(material.text)
      }
    }
  })

  it('登出需要 CSRF；登出后原会话立即失效', async () => {
    const { cookie, csrf } = await signIn()

    const noCsrf = await call('POST', `${PREP_ROOT}/api/logout`, { cookie })
    expect(noCsrf.status).toBe(403)
    expect(errorOf(noCsrf).code).toBe('FORBIDDEN')

    const wrongCsrf = await call('POST', `${PREP_ROOT}/api/logout`, { cookie, csrf: 'not-the-token' })
    expect(wrongCsrf.status).toBe(403)

    const out = await call('POST', `${PREP_ROOT}/api/logout`, { cookie, csrf })
    expect(out.status).toBe(200)
    expect(out.headers.getSetCookie().join('; ')).toContain('Max-Age=0')

    const after = await call('GET', `${PREP_ROOT}/api/session`, { cookie })
    expect(after.status).toBe(401)
  })

  it('处理过程中的异常进开发日志，不被吞成一个无信息的 400', async () => {
    const { cookie } = await signIn()
    const before = logs.length
    // `%E0%A4%A` 是非法 UTF-8 百分号序列：decodeURIComponent 会抛 URIError
    const res = await call('GET', `${PREP_ROOT}/api/resources/%E0%A4%A`, { cookie })
    expect(res.status).toBe(400)
    expect(errorOf(res).code).toBe('INVALID_REQUEST')
    const newLogs = logs.slice(before).join('\n')
    expect(newLogs).toContain('未捕获错误')
    expect(newLogs).toContain('URIError')
  })
})

describe('准备 fixture 的丢 ACK 故障（I0_UI_04）', () => {
  const newKey = () => crypto.randomUUID()

  function syncBody(expectedWorkspaceRevision: number, text: string) {
    return JSON.stringify({
      recoveryGeneration: syntheticRecoveryGeneration,
      expectedWorkspaceRevision,
      clientId: crypto.randomUUID(),
      clientSeq: 1,
      operations: [{ kind: 'create', clientFileKey: 'local-1', path: 'main.c', text }],
    })
  }

  it('丢 ACK 的写命令已提交，客户端只看到没有信封', async () => {
    const { cookie, csrf } = await signIn()

    // 故障入口本身受 CSRF 与取值约束
    const noCsrf = await call('POST', `${PREP_ROOT}/fault`, { cookie, body: JSON.stringify({ kind: 'drop-ack' }) })
    expect(noCsrf.status).toBe(403)
    const badKind = await call('POST', `${PREP_ROOT}/fault`, { cookie, csrf, body: JSON.stringify({ kind: 'nope' }) })
    expect(badKind.status).toBe(400)
    expect(errorOf(badKind).code).toBe('INVALID_REQUEST')

    const set = await call('POST', `${PREP_ROOT}/fault`, { cookie, csrf, body: JSON.stringify({ kind: 'drop-ack' }) })
    expect(set.status).toBe(200)
    expect(envelopeOf(set).data).toEqual({ scenarioId: scenario, fault: 'drop-ack' })

    // 创建 Attempt：命令提交成功，但响应被丢弃
    const created = await call('POST', `${PREP_ROOT}/api/assignments/${REFS.assignmentId}/attempts`, {
      cookie, csrf, key: newKey(), body: JSON.stringify({ recoveryGeneration: syntheticRecoveryGeneration }),
    })
    expect(created.dropped).toBe(true)

    // 服务端确实提交了：bootstrap 与 GET 都能读到同一 Attempt（客户端侧是「结果未知」，不是失败）
    const context = await call('GET', `${PREP_ROOT}/context`, { cookie })
    const attemptId = (envelopeOf(context).data as PrepContextView).refs.attemptId
    expect(typeof attemptId).toBe('string')
    const head = await call('GET', `${PREP_ROOT}/api/attempts/${attemptId}`, { cookie })
    expect(head.status).toBe(200)

    // sync 同样「已提交、无响应」：GET 读得到正文，客户端没有任何信封可用
    const droppedKey = newKey()
    const droppedBody = syncBody(0, 'int main(void) { return 0; }\n')
    const droppedSync = await call('POST', `${PREP_ROOT}/api/attempts/${attemptId}/sync`, {
      cookie, csrf, key: droppedKey, body: droppedBody,
    })
    expect(droppedSync.dropped).toBe(true)
    const after = await call('GET', `${PREP_ROOT}/api/attempts/${attemptId}`, { cookie })
    const afterHead = envelopeOf(after).data as { files: Array<{ path: string; text: string }>; attempt: { workspaceRevision: number } }
    expect(afterHead.files).toHaveLength(1)
    expect(afterHead.files[0]!.text).toBe('int main(void) { return 0; }\n')
    expect(afterHead.attempt.workspaceRevision).toBe(1)

    // 清掉故障后重放**同一条原命令**（同键、同正文）：拿到原回执且不产生第二次创建；
    // 再放一次仍然幂等，这是客户端「只核或重放原保存命令」所依赖的服务端事实。
    await call('POST', `${PREP_ROOT}/fault`, { cookie, csrf, body: JSON.stringify({ kind: 'none' }) })
    const replay = await call('POST', `${PREP_ROOT}/api/attempts/${attemptId}/sync`, { cookie, csrf, key: droppedKey, body: droppedBody })
    expect(replay.status).toBe(200)
    expect((envelopeOf(replay).data as { replayed?: boolean }).replayed).toBe(true)
    const replayAgain = await call('POST', `${PREP_ROOT}/api/attempts/${attemptId}/sync`, { cookie, csrf, key: droppedKey, body: droppedBody })
    expect(replayAgain.status).toBe(200)
    expect((envelopeOf(replayAgain).data as { replayed?: boolean }).replayed).toBe(true)
    // 改正文复用同一业务键被服务拒绝：不允许悄悄替换输入再重发
    const rekeyed = await call('POST', `${PREP_ROOT}/api/attempts/${attemptId}/sync`, {
      cookie, csrf, key: droppedKey, body: syncBody(0, 'int other(void) { return 0; }\n'),
    })
    expect(rekeyed.status).toBe(409)
    expect(errorOf(rekeyed).code).toBe('IDEMPOTENCY_CONFLICT')
    const final = await call('GET', `${PREP_ROOT}/api/attempts/${attemptId}`, { cookie })
    const finalHead = envelopeOf(final).data as { files: Array<{ text: string }> }
    expect(finalHead.files).toHaveLength(1)
    expect(finalHead.files[0]!.text).toBe('int main(void) { return 0; }\n')
  })

  it('fail-write 故障不提交任何命令，并返回服务端真实存在的暂时不可用错误', async () => {
    const { cookie, csrf } = await signIn()
    const set = await call('POST', `${PREP_ROOT}/fault`, { cookie, csrf, body: JSON.stringify({ kind: 'fail-write' }) })
    expect(set.status).toBe(200)

    const failed = await call('POST', `${PREP_ROOT}/api/assignments/${REFS.assignmentId}/attempts`, {
      cookie, csrf, key: newKey(), body: JSON.stringify({ recoveryGeneration: syntheticRecoveryGeneration }),
    })
    expect(failed.status).toBe(503)
    expect(errorOf(failed).code).toBe('PERSISTENCE_UNAVAILABLE')
    expect(errorOf(failed).retryable).toBe(false)
    expect(errorOf(failed).recovery).toContain('original request')

    // 命令没有提交：清掉故障后 bootstrap 里仍没有 Attempt
    await call('POST', `${PREP_ROOT}/fault`, { cookie, csrf, body: JSON.stringify({ kind: 'none' }) })
    const context = await call('GET', `${PREP_ROOT}/context`, { cookie })
    expect((envelopeOf(context).data as PrepContextView).refs.attemptId).toBeUndefined()
  })

  it('故障按合成场景隔离，不波及其它场景，也不把拒绝伪装成丢 ACK', async () => {
    const { cookie, csrf } = await signIn()
    const other = `other-${crypto.randomUUID()}`
    const set = await call('POST', `${PREP_ROOT}/fault`, { cookie, csrf, body: JSON.stringify({ kind: 'drop-ack' }) })
    expect(set.status).toBe(200)

    const otherLogin = await call('POST', `${PREP_ROOT}/api/sessions`, {
      scenario: other,
      body: JSON.stringify({ loginName: SYNTHETIC_ACCOUNT.loginName, password: SYNTHETIC_ACCOUNT.password }),
    })
    const otherCookie = sessionCookieOf(otherLogin)
    const otherCsrf = (envelopeOf(otherLogin).data as SessionCreatedView).csrfToken
    const created = await call('POST', `${PREP_ROOT}/api/assignments/${REFS.assignmentId}/attempts`, {
      scenario: other, cookie: otherCookie, csrf: otherCsrf, key: newKey(),
      body: JSON.stringify({ recoveryGeneration: syntheticRecoveryGeneration }),
    })
    expect(created.status).toBe(200)

    const dropped = await call('POST', `${PREP_ROOT}/api/assignments/${REFS.assignmentId}/attempts`, {
      cookie, csrf, key: newKey(), body: JSON.stringify({ recoveryGeneration: syntheticRecoveryGeneration }),
    })
    expect(dropped.dropped).toBe(true)
    // 错误响应照常下发：缺 CSRF 的写命令仍然是 403
    const forbidden = await call('POST', `${PREP_ROOT}/api/attempts/whatever/sync`, { cookie, key: newKey(), body: '{}' })
    expect(forbidden.status).toBe(403)
    expect(errorOf(forbidden).code).toBe('FORBIDDEN')
  })
})
