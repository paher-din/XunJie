import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import type { Page } from '@playwright/test'

/** 复用已获准的隔离 HTTPS/SQLite 宿主。密码只走私有 stdin，不写日志/trace。 */
export async function startSessionHost() {
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
  const linuxPath = teaching.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive: string) => `/mnt/${drive.toLowerCase()}`)
  const node = process.env.XUNJIE_E2E_SERVICE_NODE!
  const child = process.platform === 'win32'
    ? spawn('wsl.exe', ['-d', 'Ubuntu', '--cd', linuxPath, '--', node, 'server/app/i0-browser-fixture.ts'], { stdio: 'pipe', windowsHide: true })
    : spawn(node, ['server/app/i0-browser-fixture.ts'], { cwd: teaching, stdio: 'pipe' })
  const closed = new Promise<number | null>(accept => child.on('close', code => accept(code)))
  const ready = new Promise<{ synthetic: true; base: string; assignmentId: string; otherAssignmentId: string }>((accept, reject) => {
    const deadline = setTimeout(() => reject(new Error('Isolated HTTPS startup timeout')), 25_000)
    let output = ''
    child.on('error', () => { clearTimeout(deadline); reject(new Error('Isolated HTTPS startup failed')) })
    child.on('close', () => { clearTimeout(deadline); reject(new Error('Isolated HTTPS exited before readiness')) })
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
      const end = output.indexOf('\n')
      if (end < 0) return
      clearTimeout(deadline)
      try { accept(JSON.parse(output.slice(0, end))) } catch { reject(new Error('Invalid public readiness')) }
    })
    // Drain diagnostics without recording possible account material in output.
    child.stderr.resume()
  })
  const stop = async () => {
    child.stdin.end('stop\n')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const code = await Promise.race([closed, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Isolated HTTPS shutdown unconfirmed')), 15_000)
      })])
      if (code !== 0) throw new Error('Isolated HTTPS exited with failure')
    } finally { clearTimeout(timer) }
  }
  child.stdin.write(JSON.stringify({ synthetic: true, port, password }) + '\n')
  try {
    const service = await ready
    if (service.synthetic !== true) throw new Error('Synthetic host required')
    return { ...service, password, stop }
  } catch (error) { await stop(); throw error }
}

export async function loginThroughForm(page: Page, loginName: string, password: string) {
  await page.getByRole('textbox', { name: '账号', exact: true }).fill(loginName)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
}
