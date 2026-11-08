// Run: node --test packages/ui/src/workspace/CompareText.browser.test.mjs
// Real desktop Chrome and Monaco worker; no catalog, waitForDiff(), or business services.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from '@playwright/test'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const providerModule = 'monaco-editor/editor/browser/widget/diffEditor/diffProviderFactoryService'
const html = `<!doctype html><html><head><link rel="icon" href="data:,"></head><body>
<div id="root" style="height:500px"></div><script type="module">
import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {CompareDiff,loadMonaco} from '/packages/ui/src/workspace/index.ts';
import {WorkerBasedDocumentDiffProvider as Provider} from '${providerModule}';
import '@xunjie/ui/styles.css';
const root=createRoot(document.getElementById('root'));
window.monaco=await loadMonaco();
window.pending=[];
window.completed=0;
// Pause only scheduling of the real worker request. Do not fabricate a diff result or an error.
// This makes unmount-before-worker-reply deterministic without depending on machine speed.
const compute=Provider.prototype.computeDiff;
Provider.prototype.computeDiff=function(original,modified,options,token){
 const service=this.editorWorkerService, workerCompute=service.computeDiff;
 service.computeDiff=async function(...args){
  await new Promise(release=>window.pending.push({release,original,modified,token}));
  try{return await workerCompute.apply(service,args)}
  finally{window.completed++}
 };
 try{return compute.call(this,original,modified,options,token)}
 finally{service.computeDiff=workerCompute}
};
window.show=(key)=>flushSync(()=>root.render(React.createElement(CompareDiff,{
 key,path:'same.c',leftText:'int value = 1;\\n',rightText:'int value = 2;\\n',
 leftLabel:'原文',rightLabel:'当前原文',readOnlyReason:'只读比较'
})));
window.hide=()=>flushSync(()=>root.render(null));
window.ready=true;
</script></body></html>`

test('CompareDiff cancels pending computation before releasing its text models', { timeout: 60_000 }, async () => {
  const cacheDir = await mkdtemp(new URL('../../../../node_modules/.vite-compare-lifecycle-', import.meta.url))
  let server, browser
  try {
    const setup = await readFile(new URL('./monacoSetup.ts', import.meta.url), 'utf8')
    const modules = [...setup.matchAll(/import\('(monaco-editor\/[^']+)'\)/g)]
      .map(match => match[1]).filter(path => !path.includes('?worker'))
    server = await createServer({
      configFile: false, root, cacheDir, logLevel: 'error',
      plugins: [react(), { name: 'compare-lifecycle', configureServer(vite) {
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
        'marked', 'remend', '@radix-ui/react-dialog', providerModule,
        ...new Set([...modules, 'monaco-editor/features/diffEditor/register'])] },
    })
    await server.listen()
    browser = await chromium.launch({ channel: 'chrome', headless: true })
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.stack || error.message))
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`, { waitUntil: 'networkidle' })
    await page.waitForFunction(() => window.ready)
    // An unrelated project model must survive comparison teardown.
    await page.evaluate(() => {
      window.projectModel=window.monaco.editor.createModel('project draft', 'c', window.monaco.Uri.parse('xunjie-project://test/file'))
    })
    const states = []
    for (let round = 0; round < 12; round++) {
      await page.evaluate(key => window.show(key), round)
      await page.waitForFunction(() => window.pending.length > 0)
      await page.locator('.monaco-diff-editor').waitFor({ state: 'visible' })
      await page.evaluate(() => window.hide())
      states.push(await page.evaluate(() => {
        const pending = window.pending.splice(0)
        const state = pending.map(item => ({ canceled: item.token.isCancellationRequested,
          originalDisposed: item.original.isDisposed(), modifiedDisposed: item.modified.isDisposed() }))
        pending.forEach(item => item.release())
        return state
      }))
    }
    // Drain real worker requests, including any unhandled async autorun rejection.
    await page.waitForFunction(() => window.completed === 12)
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)))
    assert.deepEqual(errors, [], 'unmount must not produce no diff result available; full browser stacks follow')
    assert.ok(states.flat().every(state => state.canceled && state.originalDisposed && state.modifiedDisposed), JSON.stringify(states))
    assert.equal(await page.evaluate(() => window.monaco.editor.getDiffEditors().length), 0)
    assert.equal(await page.evaluate(() => window.monaco.editor.getModels().length), 1)
    assert.equal(await page.evaluate(() => window.projectModel.getValue()), 'project draft')
  } finally {
    await browser?.close()
    await server?.close()
    await rm(cacheDir, { recursive: true, force: true })
  }
})
