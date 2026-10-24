import { expect, test } from '@playwright/test'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loginThroughForm } from './sessionHost'
import { edit, openFileMenu, trackBusinessWrites } from './helpers'

// Real cloud acceptance: no interception, fixtures, mock accounts, or TLS bypass
// on the SSH->cloud leg. Browser TLS uses the existing local-development CA flow.
test.use({ ignoreHTTPSErrors: true, trace: 'off', screenshot: 'off', video: 'off' })
test.setTimeout(240_000)
const connection = process.env.XUNJIE_CLOUD_CONNECTION
const accountFile = process.env.XUNJIE_CLOUD_ACCOUNT_FILE
const root = resolve(process.cwd(), '../..')
const cliFile = resolve(root, 'tools/xj-dev/xj-dev.mjs')

function cli(args: string[], failure = false, env = process.env) {
  const result = spawnSync(process.execPath, [cliFile, ...args], { encoding: 'utf8', timeout: 120_000, env })
  const body = JSON.parse(result.stdout)
  expect(body.ok, body.failure?.code).toBe(!failure)
  return body
}
function cloudAccount() {
  const raw = readFileSync(accountFile!, 'utf8')
  if (raw.trim().startsWith('{')) return JSON.parse(raw) as { loginName: string; password: string }
  const lines = raw.split(/\r?\n/)
  const i = lines.findIndex(line => /学生|student/i.test(line))
  const section = lines.slice(i)
  const loginName = section.find(line => /账号\s*[：:]/.test(line))?.split(/[：:]/).slice(1).join(':').trim()
  const password = section.find(line => /密码\s*[：:]/.test(line))?.split(/[：:]/).slice(1).join(':').trim()
  if (!loginName || !password) throw new Error('Private student account file format is not recognized.')
  return { loginName, password }
}
function localPassword(environment: { environment: { root: string } }) {
  return (JSON.parse(readFileSync(resolve(environment.environment.root, 'secrets/baseline-accounts.json'), 'utf8')) as { loginName: string; password: string }[]).find(account => account.loginName === 'synthetic-student')!.password
}

test.beforeEach(() => test.skip(!connection || !accountFile, '需要现有获准云连接和私有账号文件，未提供时不算真实云端验收通过。'))

test('真实三模式：同context身份隔离、草稿固定目标、本地HMR、云端登录与CSRF', async ({ context }) => {
  // Restart owned gateways so this run uses the exact source under acceptance.
  cli(['down'])
  const local = cli(['use', 'local'])
  const secondRoot = process.env.XUNJIE_LOCAL_SECOND_WORKTREE
  const secondArgs = secondRoot ? ['--worktree', secondRoot] : ['--instance', 'mode-isolation']
  cli(['down', ...secondArgs])
  const second = cli(['up', ...secondArgs])
  const pageA = await context.newPage(), pageB = await context.newPage()
  try {
    await pageA.goto(local.page.url)
    await loginThroughForm(pageA, 'synthetic-student', localPassword(local))
    await expect.poll(async () => (await pageA.request.get(local.page.url + '/api/session')).status()).toBe(200)
    const assignments = await (await pageA.request.get(local.page.url + '/api/courses/synthetic-textscope-c/assignments')).json()
    const assignment = assignments.data[0].assignmentId as string
    const bootstrap = await (await pageA.request.get(local.page.url + `/api/assignments/${assignment}/bootstrap`)).json()
    const attemptUrl = local.page.url + `/api/attempts/${bootstrap.data.currentAttemptId}`
    const revision = (await (await pageA.request.get(attemptUrl)).json()).data.attempt.workspaceRevision
    await pageA.goto(local.page.url + `/#/task/${assignment}`)
    await expect(pageA.locator('.cw')).toBeVisible()
    const writes = trackBusinessWrites(pageA)
    await openFileMenu(pageA)
    await pageA.locator('.cw-filemenu').getByRole('menuitem', { name: '新建文件', exact: true }).click()
    const fileName = `mode-unsaved-${Date.now().toString(36)}.txt`
    await pageA.getByRole('textbox', { name: '新文件名' }).fill(fileName)
    await pageA.getByRole('textbox', { name: '新文件名' }).press('Enter')
    const draft = `mode-draft-${Date.now().toString(36)}`
    await edit(pageA, draft)
    await pageB.goto(second.page.url)
    await loginThroughForm(pageB, 'synthetic-student', localPassword(second))
    await expect.poll(async () => (await pageB.request.get(second.page.url + '/api/session')).status()).toBe(200)
    expect((await pageA.request.get(local.page.url + '/api/session')).status()).toBe(200)

    const cloudApi = cli(['use', 'cloud-api', '--connection', connection!])
    const apiPage = await context.newPage()
    let hmrConnected = false
    apiPage.on('websocket', socket => socket.on('framereceived', frame => {
      if (typeof frame.payload === 'string' && frame.payload.includes('"connected"') && socket.url().startsWith(cloudApi.page.url.replace('https:', 'wss:'))) hmrConnected = true
    }))
    await apiPage.goto(cloudApi.page.url)
    expect((await apiPage.request.get(cloudApi.page.url + '/api/session')).status()).toBe(401)
    const source = resolve(root, 'apps/student/src/brand/XunjieLogo.tsx')
    const original = readFileSync(source, 'utf8')
    try {
      await apiPage.evaluate(() => { (window as unknown as Record<string, unknown>).__modeHmr = 'alive' })
      writeFileSync(source, original.replace('className={`xunjie-logo ${className}`.trim()}', 'className={`xunjie-logo mode-hmr-proof ${className}`.trim()}'))
      await expect(apiPage.locator('svg.mode-hmr-proof').first()).toBeVisible()
      expect(await apiPage.evaluate(() => (window as unknown as Record<string, unknown>).__modeHmr)).toBe('alive')
    } finally { writeFileSync(source, original) }
    const account = cloudAccount()
    await loginThroughForm(apiPage, account.loginName, account.password)
    await expect.poll(async () => (await apiPage.request.get(cloudApi.page.url + '/api/session')).status()).toBe(200)
    const session = await apiPage.request.get(cloudApi.page.url + '/api/session')
    expect(session.status()).toBe(200)
    const csrf = (await session.json()).data.csrfToken as string
    expect((await apiPage.request.post(cloudApi.page.url + '/api/logout', { headers: { origin: cloudApi.page.url } })).status()).toBe(403)
    expect((await apiPage.request.post(cloudApi.page.url + '/api/logout', { headers: { origin: 'https://evil.example', 'x-csrf-token': csrf } })).status()).toBe(403)
    expect(hmrConnected).toBe(true)
    expect((await apiPage.request.get(cloudApi.page.url + '/src/main.tsx')).status()).toBe(200)
    expect((await apiPage.request.get(cloudApi.page.url + '/health/ready')).status()).toBe(200)

    const cloud = cli(['use', 'cloud', '--connection', connection!])
    const cloudPage = await context.newPage()
    await cloudPage.goto(cloud.page.url)
    expect((await cloudPage.request.get(cloud.page.url + '/api/session')).status()).toBe(401)
    await loginThroughForm(cloudPage, account.loginName, account.password)
    await expect.poll(async () => (await cloudPage.request.get(cloud.page.url + '/api/session')).status()).toBe(200)
    const html = await (await cloudPage.request.get(cloud.page.url)).text()
    expect(html).toContain('/assets/')
    expect(html).not.toContain('/@vite/client')
    const cookieNames = (await context.cookies()).filter(cookie => cookie.name.startsWith('__Host-xunjie')).map(cookie => cookie.name)
    expect(new Set(cookieNames).size).toBe(4)
    expect((await pageA.request.get(local.page.url + '/api/session')).status()).toBe(200)
    expect((await pageB.request.get(second.page.url + '/api/session')).status()).toBe(200)
    expect((await apiPage.request.get(cloudApi.page.url + '/api/session')).status()).toBe(200)
    const cloudSession = (await (await cloudPage.request.get(cloud.page.url + '/api/session')).json()).data
    expect((await cloudPage.request.post(cloud.page.url + '/api/logout', { headers: { origin: cloud.page.url, 'x-csrf-token': cloudSession.csrfToken } })).status()).toBe(200)
    expect((await apiPage.request.get(cloudApi.page.url + '/api/session')).status()).toBe(200)
    await expect(pageA.locator('.monaco-editor .view-lines').first()).toContainText(draft)
    expect(writes).toEqual([])
    expect((await (await pageA.request.get(attemptUrl)).json()).data.attempt.workspaceRevision).toBe(revision)
    const returned = cli(['use', 'local'])
    expect(returned.page.url).toBe(local.page.url)
    expect(returned.data.database).toBe(local.data.database)
    expect((await pageA.request.get(local.page.url + '/api/session')).status()).toBe(200)
    cli(['use', 'cloud-api', '--connection', resolve(root, 'missing-private-connection.json')], true)
    expect(cli(['status']).mode).toBe('local')
  } finally { cli(['down', ...secondArgs]); cli(['down']) }
})

test('真实连接中断和浏览器离线后恢复；只监督一个SSH隧道', async ({ context }) => {
  const environment = cli(['use', 'cloud-api', '--connection', connection!])
  const page = await context.newPage()
  try {
    await page.goto(environment.page.url)
    const account = cloudAccount()
    await loginThroughForm(page, account.loginName, account.password)
    await expect.poll(async () => (await page.request.get(environment.page.url + '/api/session')).status()).toBe(200)
    await context.setOffline(true)
    await context.setOffline(false)
    const supervisor = JSON.parse(readFileSync(resolve(environment.environment.root, 'pids/connection.json'), 'utf8')).pid as number
    const children = () => process.platform === 'win32'
      ? execFileSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${supervisor}").ProcessId`], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean).map(Number)
      : execFileSync('pgrep', ['-P', String(supervisor)], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean).map(Number)
    const previous = children()
    expect(previous).toHaveLength(1)
    // Suspend the actual SSH stream on macOS, forcing its health timeout and
    // replacement. Windows terminates the actual tunnel to simulate link loss.
    process.kill(previous[0], process.platform === 'win32' ? 'SIGTERM' : 'SIGSTOP')
    await expect.poll(() => { try { const current = children(); return current.length === 1 && current[0] !== previous[0] } catch { return false } }, { timeout: 90_000 }).toBe(true)
    await expect.poll(async () => (await page.request.get(environment.page.url + '/api/session')).status(), { timeout: 45_000 }).toBe(200)
    expect(cli(['status']).connection.state).toBe('ready')
    cli(['up'])
    expect(children()).toHaveLength(1)
  } finally { cli(['down']) }
})

test('真实云端健康响应公开运行中后端提交，配置版本不能替代', async () => {
  try {
    const environment = cli(['use', 'cloud', '--connection', connection!])
    expect(environment.sources.backend.versionSource).toBe('server')
    expect(environment.sources.backend.backendVersion).toMatch(/^[0-9a-f]{40}$/)
  } finally { cli(['down']) }
})

test('真实SSH权限/主机pin/TLS/版本不符分别停止，保留原环境', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'xj mode negatives ')))
  const env = { ...process.env, XJ_DEV_HOME: join(directory, 'tool-home') }
  const { loadConnection } = await import(pathToFileURL(resolve(root, 'tools/xj-dev/src/connection.mjs')).href)
  const current = loadConnection(connection)
  const config = { schema: 'xj-dev/connection-v1', host: current.host, port: current.port, browserUser: current.browserUser, applicationPort: current.applicationPort, browserOrigin: current.browserOrigin, identityFile: current.identityFile, knownHostsFile: current.knownHostsFile, caFile: current.caFile }
  try {
    const local = cli(['use', 'local'], false, env)
    const key = join(directory, 'unregistered')
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key], { stdio: 'ignore' })
    const knownHosts = join(directory, 'unrelated known hosts')
    const host = current.port === 22 ? current.host : `[${current.host}]:${current.port}`
    const publicKey = readFileSync(key + '.pub', 'utf8').trim().split(/\s+/).slice(0, 2).join(' ')
    writeFileSync(knownHosts, `${host} ${publicKey}\n`)
    for (const [overrides, expected] of [
      [{ identityFile: key }, 'PERMISSION_REVOKED'],
      ...(current.browserUser === 'xj-candidate-128' ? [[{ applicationPort: 13447 }, 'PERMISSION_REVOKED'] as const] : []),
      [{ knownHostsFile: knownHosts }, 'HOST_IDENTITY_CHANGED'],
      [{ caFile: resolve(local.environment.root, '../../ca/ca-cert.pem') }, 'TLS_IDENTITY_CHANGED'],
      [{ expectedBackendVersion: '0'.repeat(40) }, 'BACKEND_INCOMPATIBLE'],
    ] as const) {
      const file = join(directory, 'negative.json')
      writeFileSync(file, JSON.stringify({ ...config, ...overrides }))
      const failed = cli(['use', 'cloud-api', '--connection', file], true, env)
      expect(failed.failure.code).toBe(expected)
      expect(failed.failure.retryable).toBe(false)
      expect(cli(['status'], false, env).page.url).toBe(local.page.url)
    }
  } finally { cli(['down'], false, env); rmSync(directory, { recursive: true, force: true }) }
})
