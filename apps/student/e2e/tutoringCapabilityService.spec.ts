import { clickWorkspaceAction } from './workspaceControls'
import { test, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { get } from 'node:https'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { create, edit } from './helpers'
import { loginThroughForm, startSessionHost } from './sessionHost'

test.use({ ignoreHTTPSErrors: true, trace: 'off' })
test.beforeEach(() => test.skip(!process.env.XUNJIE_E2E_SERVICE_NODE, 'Requires approved teaching Node 24.21.0'))

// Private test process only: original default 24-table factory + normal I0 HTTPS composition, no C3/provider.
// Its only IPC input is the isolated account password and port; no application HTTP route or response is mocked.
const cOnlyDriver = String.raw`
import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fixture, assigned } from './server/workspace/test-support.ts';
import { createPasswordRecord } from './server/access/password.ts';
import { createI0App } from './server/app/i0.ts';
const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
let f, service, certDirectory;
try {
  if (process.versions.node !== '24.21.0') throw Error('Approved runtime required');
  const input = JSON.parse((await lines.next()).value);
  if (input.synthetic !== true || typeof input.password !== 'string' || input.password.length < 16 ||
      !Number.isInteger(input.port) || input.port < 1024 || input.port > 65535) throw Error('Synthetic input required');
  f = await fixture();
  const teacher = await f.login('teacher'), allocation = await assigned(f, teacher);
  const password = await createPasswordRecord(input.password);
  f.db.withTransaction(tx => tx.run("UPDATE users SET password_hash=?,salt=? WHERE id='student'", password.hash, password.salt));
  const tableCount = f.db.withTransaction(tx => tx.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").length);
  if (tableCount !== 24) throw Error('Original C-only table set required');
  certDirectory = mkdtempSync(join(tmpdir(), 'xunjie-tutor-capability-tls-'));
  const keyFile = join(certDirectory, 'key.pem'), certFile = join(certDirectory, 'cert.pem');
  execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyFile,'-out',certFile,
    '-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1,DNS:localhost','-days','1'], { stdio:'ignore' });
  const base = 'https://127.0.0.1:' + input.port;
  const clockEpoch = Math.max(f.timestamp(), Date.now()), clockStart = performance.now();
  service = await createI0App({ db:f.db, origin:base, signingSecret:f.signingSecret, currentGeneration:f.generation,
    now:() => clockEpoch + Math.floor(performance.now()-clockStart),
    https:{ key:readFileSync(keyFile), cert:readFileSync(certFile) }, staticDirectory:resolve('../student/dist'), consumerIntervalMs:50 });
  await service.app.listen({ host:'127.0.0.1', port:input.port }); service.startConsumer();
  process.stdout.write(JSON.stringify({ synthetic:true, base, assignmentId:allocation.assignmentId, tableCount }) + '\n');
  await lines.next();
} catch { process.stderr.write('Isolated C-only host failed\n'); process.exitCode=1; }
finally { if(service)await service.close(); if(f)await f.close(); if(certDirectory)rmSync(certDirectory,{recursive:true,force:true}); }
`
async function startCOnlyHost() {
  const password = randomBytes(32).toString('base64url')
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
  const node = process.env.XUNJIE_E2E_SERVICE_NODE!
  const linuxPath = teaching.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive: string) => `/mnt/${drive.toLowerCase()}`)
  const child = process.platform === 'win32'
    ? spawn('wsl.exe', ['-d', 'Ubuntu', '--cd', linuxPath, '--', node, '--input-type=module', '-e', cOnlyDriver], { stdio: 'pipe', windowsHide: true })
    : spawn(node, ['--input-type=module', '-e', cOnlyDriver], { cwd: teaching, stdio: 'pipe' })
  child.stderr.resume()
  const closed = new Promise<number | null>(accept => child.on('close', accept))
  const ready = new Promise<{ synthetic: true; base: string; assignmentId: string; tableCount: number }>((accept, reject) => {
    const timer = setTimeout(() => reject(new Error('Isolated C-only startup timeout')), 25_000)
    let text = ''
    child.stdout.on('data', chunk => {
      text += String(chunk)
      if (!text.includes('\n')) return
      clearTimeout(timer)
      try { accept(JSON.parse(text.split('\n')[0]!)) } catch { reject(new Error('Invalid C-only readiness')) }
    })
    child.on('error', () => { clearTimeout(timer); reject(new Error('Isolated C-only startup failed')) })
    child.on('close', () => { clearTimeout(timer); reject(new Error('Isolated C-only exited before readiness')) })
  })
  const stop = async () => {
    child.stdin.end('stop\n')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const code = await Promise.race([closed, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Isolated C-only shutdown unconfirmed')), 15_000)
      })])
      if (code !== 0) throw new Error('Isolated C-only host exited with failure')
    } finally { clearTimeout(timer) }
  }
  child.stdin.write(JSON.stringify({ synthetic: true, port, password }) + '\n')
  try {
    const host = await ready
    expect(host.synthetic).toBe(true)
    const deadline = Date.now() + 20_000
    while (true) {
      const live = await new Promise<boolean>(accept => {
        const request = get(host.base + '/health/live', { rejectUnauthorized: false }, response => {
          response.resume(); accept(response.statusCode === 200)
        })
        request.on('error', () => accept(false))
        request.setTimeout(1000, () => { request.destroy(); accept(false) })
      })
      if (live) break
      if (Date.now() >= deadline) throw new Error('Isolated C-only HTTPS forwarding unavailable')
      await new Promise(accept => setTimeout(accept, 100))
    }
    return { ...host, password, stop }
  } catch (error) { await stop(); throw error }
}

test('正常24表宿主明确拒绝辅导读取后暂停自动轮询；显式重读重新判断，编辑和保存不受阻', async ({ page }) => {
  const host = await startCOnlyHost()
  try {
    expect(host.tableCount).toBe(24)
    let eventReads = 0
    const helpWrites: string[] = []
    page.on('request', request => {
      if (/\/events\?/.test(request.url())) eventReads++
      if (request.method() === 'POST' && request.url().endsWith('/help')) helpWrites.push(request.postData()!)
    })
    await page.goto(`${host.base}/#/task/${host.assignmentId}`)
    await loginThroughForm(page, 'student', host.password)
    const refused = page.waitForResponse(response => /\/events\?/.test(response.url()))
    const created = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/attempts'))
    await page.getByRole('button', { name: '开始 Attempt', exact: true }).click()
    const attemptId = String((await (await created).json()).data.result.attemptId)
    await expect(page.locator('.cw')).toBeVisible()
    const failure = await refused
    expect(failure.status()).toBe(400)
    expect((await failure.json()).error).toMatchObject({ code: 'INVALID_REQUEST', retryable: false })
    await page.waitForTimeout(6000) // Observe more than two original 2.5s automatic polling intervals.
    expect(eventReads).toBe(1)
    await clickWorkspaceAction(page, '就项目求助')
    const pane = page.getByTestId('tutoring-pane')
    await expect(pane).toContainText('自动读取已暂停')
    await expect(pane).not.toContainText('INVALID_REQUEST')
    await page.getByRole('textbox', { name: '就这个任务提问' }).fill('只保留原问题，不自动发送')
    const refusedAgain = page.waitForResponse(response => /\/events\?/.test(response.url()))
    await page.getByRole('button', { name: '重新读取辅导', exact: true }).click()
    expect((await refusedAgain).status()).toBe(400)
    await expect(pane).toContainText('自动读取已暂停')
    await expect(page.getByRole('textbox', { name: '就这个任务提问' })).toHaveValue('只保留原问题，不自动发送')
    await page.waitForTimeout(3000)
    expect(eventReads).toBe(2)
    expect(helpWrites).toEqual([])
    await page.getByRole('button', { name: '收起辅导', exact: true }).click()
    await create(page)
    const source = 'int main(void){return 0;}\n'
    await edit(page, source)
    await page.getByRole('button', { name: '确认保存', exact: true }).click()
    await expect(page.locator('.ws-flow')).toContainText('确认作品 v1')
    const head = await page.evaluate(async id => (await (await fetch(`/api/attempts/${encodeURIComponent(id)}`)).json()).data, attemptId)
    expect(head.attempt.workspaceRevision).toBe(1)
    expect(head.files[0].text).toBe(source)
    expect(eventReads).toBe(2)
    expect(helpWrites).toEqual([])
  } finally { await page.goto('about:blank'); await host.stop() }
})

test('有C3的正常宿主：一次传输故障不停止后续自动读取，真实成功读取继续轮询', async ({ page }) => {
  const host = await startSessionHost()
  try {
    let reads = 0, successes = 0
    page.on('response', response => { if (/\/events\?/.test(response.url()) && response.status() === 200) successes++ })
    await page.route('**/api/attempts/*/events?*', async route => {
      reads++
      if (reads === 1) await route.abort('failed')
      else await route.continue()
    })
    await page.goto(`${host.base}/#/task/${host.assignmentId}`)
    await loginThroughForm(page, 'student', host.password)
    await page.getByRole('button', { name: '开始 Attempt', exact: true }).click()
    await expect(page.locator('.cw')).toBeVisible()
    await expect.poll(() => successes).toBeGreaterThanOrEqual(2)
    expect(reads).toBeGreaterThanOrEqual(3)
    await clickWorkspaceAction(page, '就项目求助')
    await expect(page.getByTestId('tutoring-pane')).not.toContainText('自动读取已暂停')
  } finally { await page.goto('about:blank'); await host.stop() }
})
