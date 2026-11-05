// Run the existing real-Worker experiment against THIS build, not research binaries.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { release } from 'node:os';
import { chromium } from '@playwright/test';

const [runtimeDir, fixtureFile, outputDir] = process.argv.slice(2);
if (!runtimeDir || !fixtureFile || !outputDir) throw new Error('usage: node browser-smoke.mjs <runtime-dir> <fixture.json> <output-dir>');
await mkdir(outputDir, { recursive: true });
const resources = new Map([
  ['/', [resolve('tools/research/alu-wasm-probe.html'), 'text/html']],
  ['/fixture.json', [resolve(fixtureFile), 'application/json']],
  ...['ivl', 'ivlpp', 'vvp'].flatMap(name => ['js', 'wasm'].map(ext =>
    [`/${name}.${ext}`, [resolve(runtimeDir, `${name}.${ext}`), ext === 'js' ? 'text/javascript' : 'application/wasm']])),
]);
let finish;
const result = new Promise(resolveResult => { finish = resolveResult; });
const server = createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/result') {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 1024 * 1024) throw new Error('oversized probe report');
      }
      const report = JSON.parse(body);
      res.end('ok');
      finish(report);
      return;
    }
    const resource = resources.get(req.url);
    if (!resource) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': resource[1] });
    res.end(await readFile(resource[0]));
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
let browser, timer;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: false });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const report = await Promise.race([result, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('browser smoke timeout')), 180_000);
  })]);
  report.probeDeclaredScope = report.scope;
  report.scope = 'Freshly source-built runtime; actual desktop Chrome Worker smoke only; no product integration or teaching acceptance';
  report.host = { platform: process.platform, architecture: process.arch, release: release(), chrome: browser.version(), headless: false };
  report.resources = await readFile(resolve(runtimeDir, 'checksums.txt'), 'utf8');
  await writeFile(resolve(outputDir, 'browser-smoke.json'), JSON.stringify(report, null, 2));
  await page.screenshot({ path: resolve(outputDir, 'browser-smoke.png'), fullPage: true });
  assert.equal(report.passed, true);
  assert.equal(report.hasRuntimeDiagnostics, false);
  console.log(JSON.stringify({ passed: true, chrome: browser.version(), modes: report.results.map(row => row.mode) }));
} finally {
  clearTimeout(timer);
  await browser?.close();
  await new Promise(resolveClose => server.close(resolveClose));
}
