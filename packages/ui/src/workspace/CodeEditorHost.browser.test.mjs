// Run explicitly: node --test packages/ui/src/workspace/CodeEditorHost.browser.test.mjs
// Requires installed desktop Chrome. Uses real Monaco, one document, and no business server.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from '@playwright/test'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const html = `<!doctype html><html><head><link rel="icon" href="data:,"></head>
<body><div id="root"></div><script type="module">
import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {workspaceEntries} from '/apps/web/src/ui-catalog/examples/workspace.tsx';
import {CodeEditorHost,loadMonaco} from '/packages/ui/src/workspace/index.ts';
import '@xunjie/ui/styles.css';
const root=createRoot(document.getElementById('root'));
const entry=workspaceEntries.find(e=>e.name==='CodeEditorHost');
window.showSample=()=>flushSync(()=>root.render(React.createElement(entry.states[0].component)));
window.monaco=await loadMonaco();
window.burst=(key)=>flushSync(()=>root.render(key===null?null:React.createElement(CodeEditorHost,{
 key,workspaceKey:'browser-lifecycle',fileId:'same-file',language:'c',initialText:'int value = 1;\\n',
 readOnly:false,readOnlyReason:null,onTextChange:()=>{},onCursorChange:()=>{}
})));
window.showSample();
window.ready=true;
</script></body></html>`

test('same-document Monaco remounts preserve identity and undo without disposed context errors', { timeout: 120_000 }, async () => {
  const cacheDir = await mkdtemp(new URL('../../../../node_modules/.vite-monaco-lifecycle-', import.meta.url))
  let server, browser
  try {
    const setup = await readFile(new URL('./monacoSetup.ts', import.meta.url), 'utf8')
    const modules = [...setup.matchAll(/import\('(monaco-editor\/[^']+)'\)/g)]
      .map(match => match[1]).filter(path => !path.includes('?worker'))
    server = await createServer({
      configFile: false, root, cacheDir, logLevel: 'error',
      plugins: [react(), { name: 'monaco-lifecycle', configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (req.url !== '/') return next()
          try {
            res.setHeader('Content-Type', 'text/html')
            res.end(await vite.transformIndexHtml('/', html))
          } catch (error) { next(error) }
        })
      } }],
      server: { host: '127.0.0.1', port: 0 },
      optimizeDeps: { include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime',
        'marked', 'remend', '@radix-ui/react-dialog', ...new Set([...modules, 'monaco-editor/features/diffEditor/register'])] },
    })
    await server.listen()
    browser = await chromium.launch({ channel: 'chrome', headless: true })
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    const errors = [], requests = []
    let phase = 'initial load'
    page.on('pageerror', error => errors.push({ phase, message: error.message, stack: error.stack }))
    page.on('request', request => {
      if (/\/(?:api|__i0prep)(?:\/|$)/.test(new URL(request.url()).pathname)) requests.push(request.url())
    })
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`, { waitUntil: 'networkidle' })
    await page.waitForFunction(() => window.ready)
    const editorReady = () => page.locator('.cw-editor .monaco-editor textarea.inputarea').waitFor({ state: 'attached' })
    const original = () => page.locator('details pre').textContent().then(JSON.parse)
    const modelIdentity = () => page.evaluate(() => window.monaco.editor.getModels()
      .filter(model => model.uri.scheme === 'xunjie-project')
      .map(model => ({ uri: model.uri.toString(), version: model.getAlternativeVersionId() })))
    const click = label => page.getByRole('button', { name: label, exact: true }).evaluate(button => button.click())
    await editorReady()
    const before = await original()
    await page.locator('.cw-editor textarea.inputarea').focus()
    await page.keyboard.press('ControlOrMeta+Home')
    await page.keyboard.insertText('界')
    await page.waitForFunction(() => JSON.parse(document.querySelector('details pre').textContent).includes('界'))
    const edited = await original(), identity = await modelIdentity()
    assert.notEqual(edited, before)
    assert.equal(edited.replace('界', ''), before, 'BOM and mixed EOL remain authoritative')

    for (let round = 0; round < 80; round++) {
      phase = `catalog comparison round ${round}`
      await click('切到比较')
      await page.locator('.monaco-diff-editor').waitFor({ state: 'attached' })
      // Await a result only for the normal navigation scenario. Burst unmounts below do not wait for idle.
      await page.evaluate(async () => {
        await Promise.all(window.monaco.editor.getDiffEditors().map(editor => editor.waitForDiff()))
      })
      await click('返回编辑')
      await editorReady()
      phase = `catalog hidden round ${round}`
      await click('隐藏编辑器')
      await page.waitForFunction(() => !document.querySelector('.monaco-editor'))
      await click('显示编辑器')
      await editorReady()
    }
    assert.deepEqual(await modelIdentity(), identity, 'same file retains its URI and undo version across views')
    assert.equal(await original(), edited)
    await page.locator('.cw-editor textarea.inputarea').focus()
    await page.keyboard.press('ControlOrMeta+z')
    await page.waitForFunction(value => JSON.parse(document.querySelector('details pre').textContent) === value, before)
    await page.keyboard.press('ControlOrMeta+Shift+z')
    await page.waitForFunction(value => JSON.parse(document.querySelector('details pre').textContent) === value, edited)
    await click('切换同名文件实例')
    await page.waitForFunction(() => JSON.parse(document.querySelector('details pre').textContent).includes('第二个文件实例'))
    await click('切换同名文件实例')
    await page.waitForFunction(value => JSON.parse(document.querySelector('details pre').textContent) === value, edited)

    // Bypass the catalog entirely: mount the actual public host, focus, then destroy before idle contributions.
    await page.evaluate(() => window.burst(null))
    for (let round = 0; round < 200; round++) {
      phase = `public host burst ${round}`
      await page.evaluate(key => window.burst(key), round)
      await editorReady()
      await page.evaluate(() => document.querySelector('.cw-editor textarea.inputarea').focus())
      await page.waitForTimeout([0, 1, 5, 15][round % 4])
      await page.evaluate(() => window.burst(null))
    }
    await page.waitForTimeout(1500)
    assert.deepEqual(errors, [], 'includes full stack and phase for any disposed-context regression')
    assert.deepEqual(requests, [], 'no business services')
    assert.equal(await page.evaluate(() => window.monaco.editor.getEditors().length), 0, 'no mounted editor leaked')
  } finally {
    await browser?.close()
    await server?.close()
    await rm(cacheDir, { recursive: true, force: true })
  }
})
