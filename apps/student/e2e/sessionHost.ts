import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { randomBytes, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { get } from 'node:https'
import { createRequire } from 'node:module'
import type { Page } from '@playwright/test'
import type { WorkspaceHead } from '../src/workspace/workspaceContracts'

export type HostRunnerOutcome = 'running' | 'success' | 'compile-error' | 'program-error' | 'timeout' | 'output-limit'
  | 'infrastructure-error' | 'unknown' | 'report-complete' | 'report-missing' | 'report-incomplete'
export type HostRunnerFinishedOutcome = Exclude<HostRunnerOutcome, 'running' | 'unknown'>
export interface HostRunnerConfiguration {
  ready: boolean; outcome: HostRunnerOutcome; stopConfirmed: boolean; link: 'online' | 'offline'
}
export interface HostRunnerCounts { submit: number; query: number; cancel: number; readResult: number; submitEffects: number }
export interface HostRunnerFact {
  identity: { runId: string; commandId: string; requestHash: string; recoveryGeneration: string; snapshotId: string;
    snapshotHash: string; inputHash: string; runtimeProfileVersion: string; imageDigest: string;
    authorizedScope: { userId: string; courseId: string; purpose: 'student_run' | 'teacher_sample'; attemptId?: string; activityVersionId?: string } }
  state: 'queued' | 'running' | 'cancelling' | 'cancelled' | 'succeeded' | 'failed' | 'stale' | 'outcome_unknown'
  reserved: boolean; stopRequested: boolean; units: string[]; pending: string[]; resultRef?: string; resultHash?: string
}
export interface HostRunnerInspection {
  readiness: number; totals: HostRunnerCounts; configuration: HostRunnerConfiguration
  runs: Array<{ runId: string; counts: HostRunnerCounts; fact: HostRunnerFact | null }>
}
export type HostControl =
  | { kind: 'generation'; value: string }
  | { kind: 'provider'; mode: 'normal' | 'unavailable' }
  | { kind: 'reopen' }
  | { kind: 'state'; attemptId: string; state: 'paused' | 'active' | 'submitted' | 'reviewed' }
  | { kind: 'inspect'; attemptId?: string }
  | { kind: 'clock-regress'; milliseconds: number }
  | ({ kind: 'runner'; action: 'configure' } & Partial<HostRunnerConfiguration>)
  | { kind: 'runner'; action: 'finish'; runId: string; outcome?: HostRunnerFinishedOutcome }
  | { kind: 'runner'; action: 'confirm-stop'; runId: string }
  | { kind: 'runner'; action: 'inspect'; runId?: string }
  | { kind: 'history'; attemptId: string; outcome: 'report-complete' | 'report-missing' | 'report-incomplete' | 'files-unavailable' | 'check' }
export interface HostInspection {
  requests: { businessWrites: number; activityReads: number }
  database: { attempts: number; files: number; snapshots: number; submissions: number; receipts: number }
  attempt?: WorkspaceHead
  attemptCounts?: { files: number; snapshots: number; submissions: number; receipts: number }
}
export type HostControlResult<T extends HostControl> =
  T extends { kind: 'runner'; action: 'inspect' } ? HostRunnerInspection :
  T extends { kind: 'runner'; action: 'configure' } ? HostRunnerConfiguration :
  T extends { kind: 'runner' } ? { runId: string; state: HostRunnerFact['state'] } :
  T extends { kind: 'history' } ? { jobId: string; runId: string; snapshotId: string; status: string } :
  T extends { kind: 'inspect' } ? HostInspection :
  T extends { kind: 'generation' } ? { recoveryGeneration: string } :
  T extends { kind: 'provider' } ? { providerMode: 'normal' | 'unavailable' } :
  T extends { kind: 'reopen' } ? { reopened: true; recoveryGeneration: string } :
  T extends { kind: 'clock-regress' } ? { regressed: true } :
  { attemptId: string; status: string; attemptRevision: number; workspaceRevision: number }

/** Linux listen readiness precedes Windows loopback forwarding after start/reopen. */
async function reachable(base: string) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const ready = await new Promise<boolean>(accept => {
      // Certificate bypass is scoped to this synthetic loopback probe only.
      const request = get(base + '/health/live', { rejectUnauthorized: false }, response => {
        response.resume(); accept(response.statusCode === 200)
      })
      request.on('error', () => accept(false))
      request.setTimeout(1000, () => { request.destroy(); accept(false) })
    })
    if (ready) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Isolated HTTPS loopback unavailable')
}

/** 复用已获准的隔离 HTTPS/SQLite 宿主。密码只走私有 stdin，不写日志/trace。 */
export async function startSessionHost(options: { runs?: boolean } = {}) {
  const password = randomBytes(32).toString('base64url')
  const playwrightCore = createRequire(import.meta.url)('playwright-core/lib/coreBundle') as {
    utils: { generateSelfSignedCertificate(): { cert: string; key: string } }
  }
  const certificate = playwrightCore.utils.generateSelfSignedCertificate()
  const port = await new Promise<number>((accept, reject) => {
    const listener = createServer()
    listener.on('error', reject)
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address()
      if (!address || typeof address === 'string') { listener.close(); reject(new Error('No isolated port')); return }
      listener.close(error => error ? reject(error) : accept(address.port))
    })
  })
  const teaching = resolve(import.meta.dirname, '../../teaching')
  const linuxPath = teaching.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive: string) => `/mnt/${drive.toLowerCase()}`)
  const node = process.env.XUNJIE_E2E_SERVICE_NODE
  if (!node) throw new Error('Approved teaching runtime required')
  const windowsNode = process.platform === 'win32' && /^[A-Za-z]:[\\/].*\.exe$/i.test(node)
  const child = process.platform === 'win32' && !windowsNode
    ? spawn('wsl.exe', ['-d', 'Ubuntu', '--cd', linuxPath, '--', node, 'server/app/i0-browser-fixture.ts'], { stdio: 'pipe', windowsHide: true })
    : spawn(node, ['server/app/i0-browser-fixture.ts'], { cwd: teaching, stdio: 'pipe', windowsHide: true })
  const pending = new Map<string, { accept(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  let stopping = false
  const rejectPending = (message: string) => {
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error(message))
    }
    pending.clear()
  }
  const closed = new Promise<number | null>(accept => child.on('close', code => {
    rejectPending('Isolated HTTPS exited during control')
    accept(code)
  }))
  child.stdin.on('error', () => rejectPending('Isolated HTTPS control input unavailable'))
  const output = createInterface({ input: child.stdout })
  let base = ''
  const ready = new Promise<{ synthetic: true; base: string; assignmentId: string; otherAssignmentId: string }>((accept, reject) => {
    const deadline = setTimeout(() => reject(new Error('Isolated HTTPS startup timeout')), 25_000)
    let seenReady = false
    child.on('error', () => { clearTimeout(deadline); reject(new Error('Isolated HTTPS startup failed')) })
    child.on('close', () => { clearTimeout(deadline); reject(new Error('Isolated HTTPS exited before readiness')) })
    output.on('line', line => {
      try {
        if (line.length > 2 * 1024 * 1024) throw new Error('Invalid public response')
        const message = JSON.parse(line)
        if (!seenReady) {
          clearTimeout(deadline)
          if (message.synthetic !== true || typeof message.base !== 'string' || typeof message.assignmentId !== 'string'
            || typeof message.otherAssignmentId !== 'string') throw new Error('Invalid public readiness')
          seenReady = true
          base = message.base
          accept(message)
          return
        }
        const request = typeof message.requestId === 'string' ? pending.get(message.requestId) : undefined
        if (!request) return
        clearTimeout(request.timer)
        pending.delete(message.requestId)
        if (message.ok === true) request.accept(message.data)
        else request.reject(new Error(`Isolated HTTPS control failed: ${typeof message.stage === 'string' && /^[a-z-]{1,32}$/.test(message.stage) ? message.stage : 'unknown'}`))
      } catch {
        clearTimeout(deadline)
        reject(new Error('Invalid public readiness'))
        rejectPending('Invalid public control response')
      }
    })
    // Drain diagnostics without recording possible account material in output.
    child.stderr.resume()
  })
  const control = async <T extends HostControl>(input: T): Promise<HostControlResult<T>> => {
    if (stopping || child.exitCode !== null || child.killed) return Promise.reject(new Error('Isolated HTTPS unavailable for control'))
    const requestId = randomUUID()
    const result = await new Promise<HostControlResult<T>>((accept, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId)
        reject(new Error('Isolated HTTPS control timeout'))
      }, 25_000)
      pending.set(requestId, { accept: value => accept(value as HostControlResult<T>), reject, timer })
      child.stdin.write(JSON.stringify({ requestId, ...input }) + '\n', error => {
        if (!error) return
        clearTimeout(timer)
        pending.delete(requestId)
        reject(new Error('Isolated HTTPS control input unavailable'))
      })
    })
    if (input.kind === 'reopen') await reachable(base)
    return result
  }
  let shutdown: Promise<void> | undefined
  const stop = () => shutdown ??= (async () => {
    stopping = true
    rejectPending('Isolated HTTPS stopping')
    if (!child.stdin.destroyed) child.stdin.end('stop\n')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const code = await Promise.race([closed, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Isolated HTTPS shutdown unconfirmed')), 15_000)
      })])
      if (code !== 0) throw new Error('Isolated HTTPS exited with failure')
    } finally { clearTimeout(timer); output.close() }
  })()
  child.stdin.write(JSON.stringify({ synthetic: true, port, password, ...certificate,
    ...(options.runs ? { runs: true } : {}) }) + '\n')
  try {
    const service = await ready
    if (service.synthetic !== true) throw new Error('Synthetic host required')
    await reachable(service.base)
    return { ...service, password, control, stop }
  } catch (error) { await stop(); throw error }
}

export async function loginThroughForm(page: Page, loginName: string, password: string) {
  await page.getByRole('textbox', { name: '账号', exact: true }).fill(loginName)
  try { await page.getByLabel('密码', { exact: true }).fill(password) }
  catch { throw new Error('Synthetic login password entry unavailable') }
  await page.getByRole('button', { name: '登录', exact: true }).click()
}
