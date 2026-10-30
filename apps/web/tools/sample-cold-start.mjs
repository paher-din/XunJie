import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

const script = fileURLToPath(import.meta.url)
const studentRoot = resolve(dirname(script), '..')
async function within(promise, ms, message) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
    })])
  } finally { clearTimeout(timer) }
}

// A worker uses the unchanged application config and normal Vite dependency discovery.
// Only the private sample cache and strict loopback port differ from dev:prep/dev.
if (process.argv[2] === '--worker') {
  const [mode, port, cacheDir] = process.argv.slice(3)
  const { createServer } = await import('vite')
  const started = performance.now()
  const server = await createServer({
    configFile: join(studentRoot, 'vite.config.ts'), mode, cacheDir,
    server: { host: '127.0.0.1', port: Number(port), strictPort: true },
  })
  await server.listen()
  process.send({ kind: 'ready', startupMs: Math.round(performance.now() - started) })
  process.on('message', async message => {
    if (message?.kind !== 'stop') return
    await server.close()
    process.send({ kind: 'stopped' })
    process.disconnect()
  })
} else {
  const options = new Map()
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index], value = process.argv[index + 1]
    if (!['--samples', '--port-base', '--output'].includes(key) || !value || options.has(key)) {
      throw new Error('use --samples <1..5> --port-base <port> --output <new JSON path>')
    }
    options.set(key, value)
  }
  const samples = Number(options.get('--samples') ?? 2)
  const portBase = Number(options.get('--port-base') ?? 5791)
  const output = options.get('--output')
  if (!Number.isInteger(samples) || samples < 1 || samples > 5) throw new Error('--samples must be 1..5')
  if (!Number.isInteger(portBase) || portBase < 1024 || portBase + 1 > 65535) throw new Error('--port-base must leave two valid ports')
  if (!output) throw new Error('--output is required (JSON evidence path)')
  const { chromium } = await import('@playwright/test')
  const dependencyRoot = await realpath(join(studentRoot, 'node_modules'))
  const scratch = await mkdtemp(join(dependencyRoot, '.i0-cold-start-'))
  const startedAt = new Date().toISOString()
  const results = []
  const cleanupErrors = []
  const cleanupFailed = (stage, error) => cleanupErrors.push({ stage, error: error instanceof Error ? error.message : String(error) })
  let browser
  let failure
  let scratchRemoved = false

  async function portAvailable(port) {
    const probe = net.createServer()
    return new Promise(resolveProbe => {
      probe.once('error', () => resolveProbe(false))
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolveProbe(true)))
    })
  }

  async function sample(mode, iteration) {
    const port = portBase + (mode === 'prep' ? 0 : 1)
    if (!await portAvailable(port)) throw new Error(`sample port ${port} already occupied; no existing process was stopped`)
    const cacheDir = join(scratch, `${iteration}-${mode}`)
    const child = spawn(process.execPath, [script, '--worker', mode, String(port), cacheDir], {
      cwd: studentRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    let logs = ''
    child.stdout.on('data', chunk => { logs += chunk.toString() })
    child.stderr.on('data', chunk => { logs += chunk.toString() })
    const exit = new Promise(resolveExit => child.once('exit', (code, signal) => resolveExit({ code, signal })))
    const result = { mode, iteration, port, cacheInitiallyAbsent: true, startupMs: null,
      browserLoadMs: null, optimizedResponses: 0, assetErrors: [], requestFailures: [],
      expectedApiFailures: [], optimizerMessages: [], stopped: false, exit: null, portReleased: false }
    results.push(result)
    let context
    let sampleFailure
    try {
      result.startupMs = await new Promise((resolveReady, rejectReady) => {
        const timer = setTimeout(() => rejectReady(new Error('cold Vite startup exceeded 60s')), 60_000)
        child.once('error', error => { clearTimeout(timer); rejectReady(error) })
        child.once('exit', (code, signal) => { clearTimeout(timer); rejectReady(new Error(`Vite exited before ready: ${code}/${signal}`)) })
        child.on('message', message => {
          if (message?.kind === 'ready') { clearTimeout(timer); resolveReady(message.startupMs) }
        })
      })
      context = await browser.newContext()
      const page = await context.newPage()
      page.on('response', response => {
        const url = new URL(response.url())
        if (url.hostname !== '127.0.0.1' || Number(url.port) !== port) return
        if (/\/deps\//.test(url.pathname)) result.optimizedResponses += 1
        if (response.status() < 400) return
        const detail = { path: url.pathname, status: response.status() }
        if (mode === 'development' && url.pathname.startsWith('/api/')) result.expectedApiFailures.push(detail)
        else result.assetErrors.push(detail)
      })
      page.on('requestfailed', request => {
        const url = new URL(request.url())
        if (url.hostname === '127.0.0.1' && Number(url.port) === port && !url.pathname.startsWith('/api/')) {
          result.requestFailures.push({ path: url.pathname, error: request.failure()?.errorText ?? 'unknown' })
        }
      })
      const loadStart = performance.now()
      const origin = `http://127.0.0.1:${port}`
      await page.goto(mode === 'prep'
        ? `${origin}/?scenario=cold-${crypto.randomUUID()}#/task/i0-prep-textscope-c`
        : `${origin}/#/task/cold-start-unassigned`, { waitUntil: 'networkidle', timeout: 60_000 })
      if (mode === 'prep') {
        await page.getByRole('button', { name: '开始 Attempt', exact: true }).click()
        await page.getByRole('button', { name: '新建文件', exact: true }).first().click()
        const filename = page.getByRole('textbox', { name: '新文件名' })
        await filename.fill('cold.c')
        await filename.press('Enter')
        await page.locator('.monaco-editor textarea').first().waitFor({ state: 'attached' })
        await page.locator('.monaco-editor textarea').first().press('Escape')
      } else {
        await page.getByRole('heading', { name: '登录学习空间', exact: true }).waitFor({ state: 'visible' })
      }
      await page.waitForLoadState('networkidle')
      result.browserLoadMs = Math.round(performance.now() - loadStart)
      if (result.assetErrors.length || result.requestFailures.length) throw new Error(`${mode} cold browser load had failed assets`)
    } catch (error) {
      sampleFailure = error
      result.failure = error instanceof Error ? error.message : String(error)
    } finally {
      if (context) {
        try { await within(context.close(), 10_000, 'sample browser context close timed out') }
        catch (error) { cleanupFailed(`${iteration}-${mode}:context.close`, error) }
      }
      const stopStart = performance.now()
      let outcome = null
      try {
        if (child.connected) await new Promise((resolveStop, rejectStop) => child.send({ kind: 'stop' }, error => error ? rejectStop(error) : resolveStop()))
        outcome = await within(exit, 10_000, 'Vite graceful stop timed out')
      } catch (error) {
        cleanupFailed(`${iteration}-${mode}:graceful-stop`, error)
        try {
          child.kill('SIGTERM')
          outcome = await within(exit, 5000, 'Vite terminate timed out')
        } catch (terminateError) {
          cleanupFailed(`${iteration}-${mode}:terminate`, terminateError)
          try {
            child.kill('SIGKILL')
            outcome = await within(exit, 5000, 'Vite kill timed out')
          } catch (killError) { cleanupFailed(`${iteration}-${mode}:kill`, killError) }
        }
      }
      result.exit = outcome
      result.stopped = outcome?.code === 0
      result.stopMs = Math.round(performance.now() - stopStart)
      try { result.portReleased = await portAvailable(port) }
      catch (error) { cleanupFailed(`${iteration}-${mode}:port-probe`, error) }
      result.optimizerMessages = logs.replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/)
        .filter(line => /optimiz|504|error|warn/i.test(line)).slice(-12)
      if (!result.stopped || !result.portReleased) cleanupFailed(`${iteration}-${mode}:shutdown`, new Error('worker shutdown or port release unconfirmed'))
    }
    if (sampleFailure) throw sampleFailure
    if (cleanupErrors.length) throw new Error('cold sample cleanup failed; inspect cleanupErrors')
  }

  try {
    browser = await chromium.launch({ channel: 'chrome' })
    for (let iteration = 1; iteration <= samples; iteration += 1) {
      for (const mode of ['prep', 'development']) await sample(mode, iteration)
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
    process.exitCode = 1
  } finally {
    if (browser) {
      try { await within(browser.close(), 10_000, 'Chrome close timed out') }
      catch (error) { cleanupFailed('browser.close', error) }
    }
    // Only this run's freshly created scratch tree is removable; shared Vite caches are untouched.
    try {
      const scratchActual = await realpath(scratch)
      if (dirname(scratchActual) !== dependencyRoot || !basename(scratchActual).startsWith('.i0-cold-start-') ||
        results.some(result => !result.exit || !result.portReleased)) {
        throw new Error('scratch removal refused: path or worker shutdown unconfirmed')
      }
      await rm(scratchActual, { recursive: true, force: false })
      scratchRemoved = true
    } catch (error) { cleanupFailed('scratch.remove', error) }
    const passed = !failure && cleanupErrors.length === 0
    if (!passed) process.exitCode = 1
    let sourceConfigSha256 = null
    try { sourceConfigSha256 = createHash('sha256').update(await readFile(join(studentRoot, 'vite.config.ts'))).digest('hex') }
    catch (error) { cleanupFailed('config.digest', error); process.exitCode = 1 }
    const summary = { startedAt, finishedAt: new Date().toISOString(), node: process.version,
      browser: browser?.version(), sourceConfig: 'apps/web/vite.config.ts', sourceConfigSha256,
      method: 'independent Vite workers, original config, fresh private cache per mode/sample, normal browser route loading',
      scope: 'synthetic preparation and frontend real-mode startup; no teaching host, execution node or provider',
      scratchRemoved, cleanupErrors, requestedSamplesPerMode: samples,
      passed: passed && cleanupErrors.length === 0, failure: failure ?? null, results }
    const destination = resolve(output)
    try {
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, `${JSON.stringify(summary, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    } catch (error) {
      process.exitCode = 1
      summary.passed = false
      summary.evidenceWriteError = error instanceof Error ? error.message : String(error)
    }
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  }
}
