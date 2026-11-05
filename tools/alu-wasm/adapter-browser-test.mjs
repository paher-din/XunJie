import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { release, cpus, loadavg, totalmem } from 'node:os';
import { chromium } from '@playwright/test';
import { resourceNames, adapterNames, bundleIdentity } from './runtime/identity.mjs';

const [runtimeDir, fixtureFile, outputDir] = process.argv.slice(2);
if (!runtimeDir || !fixtureFile || !outputDir) throw new Error('usage: node adapter-browser-test.mjs <runtime-dir> <fixture.json> <output-dir>');
const startedAt = new Date().toISOString();
await mkdir(outputDir, { recursive: true });
const assets = {};
for (const name of resourceNames) assets[name] = {
  bytes: (await stat(resolve(runtimeDir, name))).size,
  sha256: createHash('sha256').update(await readFile(resolve(runtimeDir, name))).digest('hex'),
};
const adapters = {};
for (const name of adapterNames) {
  const bytes = await readFile(resolve(process.env.XUNJIE_ALU_ADAPTER_ROOT ?? 'tools/alu-wasm/runtime', name));
  adapters[name] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
const identity = await bundleIdentity(assets, adapters);
const server = createServer(async (req, res) => {
  try {
    let file, mime;
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>ALU runtime adapter engineering acceptance</title><p>Real Chrome Worker adapter test</p>'); return; }
    if (req.url === '/tampered/ivlpp.js') { res.setHeader('content-type', 'text/javascript'); res.end('untrusted bytes'); return; }
    const name = req.url.split('/').at(-1);
    if ((req.url.startsWith('/assets/') || req.url.startsWith('/tampered/')) && resourceNames.includes(name)) { file = resolve(runtimeDir, name); mime = name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript'; }
    if (['/adapter/index.mjs', '/adapter/worker.mjs', '/adapter/identity.mjs'].includes(req.url)) { file = resolve(process.env.XUNJIE_ALU_ADAPTER_ROOT ?? 'tools/alu-wasm/runtime', req.url.split('/').at(-1)); mime = 'text/javascript'; }
    if (!file) { res.writeHead(404); res.end(); return; }
    res.setHeader('content-type', mime); res.end(await readFile(file));
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: false });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const fixture = JSON.parse(await readFile(fixtureFile, 'utf8'));
  const report = await page.evaluate(async ({ assets, adapters, identity, fixture }) => {
    const { createIcarusRuntime } = await import('/adapter/index.mjs');
    const { bundleIdentity } = await import('/adapter/identity.mjs');
    const passed = [], timings = [];
    const check = (condition, message) => { if (!condition) throw new Error(message); passed.push(message); };
    const runtime = await createIcarusRuntime({ identity, assets, adapters, baseUrl: location.origin + '/assets/' });
    const harness = fixture.testbench.replace('integer i;', 'integer i; integer xunjie_fd;')
      .replace('initial begin', 'initial begin\n xunjie_fd = $fopen("xunjie-observations.txt", "w");')
      .replace('$display("ROW', '$fdisplay(xunjie_fd, "ROW')
      .replace('$finish;', '$fclose(xunjie_fd); $finish;');
    const request = { top: 'tb', sources: [
      { path: 'design.sv', content: fixture.dut }, { path: 'tb.sv', content: harness },
    ] };
    const stamp = performance.now();
    const compiled = await runtime.compile(request);
    timings.push({ stage: 'cold-compile', ms: performance.now() - stamp });
    check(compiled.status === 'completed' && !compiled.cacheHit, 'actual compile succeeds: ' + JSON.stringify(compiled.status === 'completed' ? { status: compiled.status } : compiled));
    const indices = Array.from({ length: 4096 }, (_, i) => i);
    const runStart = performance.now();
    const first = await runtime.simulate({ artifact: compiled.artifact, expectedIndices: indices });
    timings.push({ stage: 'artifact-simulation', ms: performance.now() - runStart });
    check(first.status === 'completed' && first.observationState === 'complete', 'complete 4096 observations distinguished');
    check(first.diagnostics.length === 0 && first.vcd.includes('$enddefinitions') && first.vcd.includes('#4096000'), 'system tasks and VCD succeed without diagnostics');
    let mismatches = 0;
    for (const row of first.observations) {
      const i = row.index, a = (i >> 5) & 15, b = (i >> 1) & 15, cin = i & 1, control = i >> 9;
      const total = a + b + cin;
      const f = control === 4 ? total & 15 : [15 ^ a, a & b, a | b, a ^ b, 0, 0, 0, 0][control];
      if (parseInt(row.f, 2) !== f || parseInt(row.cout, 2) !== (control === 4 ? total >> 4 : 0)) mismatches++;
    }
    check(mismatches === 0, 'independent oracle matches all 4096 including reserved controls');
    const cacheStart = performance.now();
    check((await runtime.compile(request)).cacheHit, 'identical fixed compilation reuses artifact');
    timings.push({ stage: 'compile-cache-hit', ms: performance.now() - cacheStart });
    const invalid = await runtime.compile({ ...request, options: { strictExprWidth: 'invalid' } });
    check(invalid.status === 'failed' && !invalid.cacheHit, 'invalid options cannot bypass validation through cache');
    const strict = await runtime.compile({ ...request, options: { strictExprWidth: true } });
    check(strict.status === 'completed' && !strict.cacheHit && strict.artifact.dependencyId !== compiled.artifact.dependencyId, 'supported compiler option changes invalidate cache');
    const includeRequest = { top: 'tb', options: { includeDirs: ['include'] }, sources: [
      { path: 'design.sv', content: '`include "carry.svh"\n' + fixture.dut.replace("{4'b0000,Cin}", '`EXTRA') },
      { path: 'tb.sv', content: harness }, { path: 'include/carry.svh', content: "`define EXTRA {4'b0000,Cin}\n" },
    ] };
    const withInclude = await runtime.compile(includeRequest);
    check(withInclude.status === 'completed', 'real include preprocessing succeeds: ' + JSON.stringify(withInclude.status === 'completed' ? { status: withInclude.status } : withInclude));
    const explicitUnits = structuredClone(includeRequest);
    explicitUnits.entryFiles = ['design.sv', 'tb.sv'];
    explicitUnits.sources[0].content = explicitUnits.sources[0].content.replace('carry.svh', 'carry.v');
    explicitUnits.sources[2].path = 'include/carry.v';
    check((await runtime.compile(explicitUnits)).status === 'completed', 'explicit compilation entries permit .v include dependencies');
    const invalidUnits = await runtime.compile({ ...request, entryFiles: ['not-supplied.sv'] });
    check(invalidUnits.status === 'failed' && !invalidUnits.cacheHit, 'missing compilation entry cannot reuse cached output');
    const changed = structuredClone(includeRequest); changed.sources[2].content = "`define EXTRA 5'b00000\n";
    const changedCompile = await runtime.compile(changed);
    check(changedCompile.status === 'completed' && !changedCompile.cacheHit && changedCompile.artifact.dependencyId !== withInclude.artifact.dependencyId, 'include content invalidates compilation');
    const changedRun = await runtime.simulate({ artifact: changedCompile.artifact, expectedIndices: indices });
    check(changedRun.observations[2529].f !== first.observations[2529].f, 'include change affects real simulation');
    const changedSource = structuredClone(request);
    changedSource.sources[0].content = fixture.dut.replace("3'b000: F = ~A;", "3'b000: F = A;");
    const sourceCompile = await runtime.compile(changedSource);
    check(sourceCompile.status === 'completed' && !sourceCompile.cacheHit && sourceCompile.artifact.dependencyId !== compiled.artifact.dependencyId, 'source content invalidates compilation');
    const sourceRun = await runtime.simulate({ artifact: sourceCompile.artifact, expectedIndices: indices });
    check(sourceRun.observations[0].f !== first.observations[0].f && sourceRun.observationState === 'complete', 'source change affects real simulation');
    const changedHarness = structuredClone(request);
    changedHarness.sources[1].content = harness.replace('$dumpvars(0, tb);', '$dumpvars(0, tb); $display("HARNESS-MARKER");');
    const harnessCompile = await runtime.compile(changedHarness);
    check(harnessCompile.status === 'completed' && !harnessCompile.cacheHit && harnessCompile.artifact.dependencyId !== compiled.artifact.dependencyId, 'harness content invalidates compilation');
    const harnessRun = await runtime.simulate({ artifact: harnessCompile.artifact, expectedIndices: indices });
    check(harnessRun.output.includes('HARNESS-MARKER') && harnessRun.observationState === 'complete', 'harness change affects real execution logs');
    const badTop = await runtime.compile({ ...request, top: 'missing_top' });
    check(badTop.status === 'failed' && !badTop.cacheHit, 'top change fails rather than reusing old program');
    const badSource = await runtime.compile({ top: 'tb', sources: [{ path: 'bad.sv', content: 'not systemverilog' }] });
    check(badSource.status === 'failed' && badSource.diagnostics.length > 0, 'compile failure retains actual diagnostics');
    const short = await runtime.compile({ top: 'tb', sources: [{ path: 'short.sv', content: 'module tb; integer f; initial begin f=$fopen("xunjie-observations.txt","w"); $fdisplay(f,"ROW 0 zzzz z"); $fclose(f); $finish; end endmodule' }] });
    const shortRun = await runtime.simulate({ artifact: short.artifact, expectedIndices: [0] });
    check(shortRun.observationState === 'complete-with-unknown' && shortRun.observations[0].f === 'zzzz', 'Z retained distinctly from deterministic zero');
    const missing = await runtime.simulate({ artifact: short.artifact, expectedIndices: [0, 1] });
    check(missing.observationState === 'incomplete', 'incomplete output does not report complete observation');
    const stdoutOnly = await runtime.compile({ top: 'tb', sources: [{ path: 'spoof.sv', content: 'module tb; initial begin $display("ROW 0 0000 0"); $finish; end endmodule' }] });
    const spoof = await runtime.simulate({ artifact: stdoutOnly.artifact, expectedIndices: [0] });
    check(spoof.observationState === 'incomplete' && spoof.observations.length === 0, 'ordinary stdout cannot become an observation');
    check((await runtime.simulate({ artifact: stdoutOnly.artifact, expectedIndices: [] })).status === 'failed', 'empty expected set is rejected');
    const collision = await runtime.compile({ ...request, sources: [...request.sources, { path: 'pp.conf', content: 'unexpected' }] });
    check(collision.code === 'invalid-input', 'reserved preprocessor configuration cannot overwrite source');
    const spin = await runtime.compile({ top: 'tb', sources: [{ path: 'spin.sv', content: 'module tb; reg b; initial begin b=0; forever b=~b; end endmodule' }] });
    check(spin.status === 'completed', 'zero-time loop actually compiles');
    const controller = new AbortController();
    let stopStarted;
    const stopped = await runtime.simulate({ artifact: spin.artifact }, { signal: controller.signal, onStage: stage => {
      if (stage === 'simulate') setTimeout(() => { stopStarted = performance.now(); controller.abort(); }, 100);
    } });
    timings.push({ stage: 'stop-latency', ms: performance.now() - stopStarted });
    check(stopped.status === 'stopped' && stopped.stage === 'simulate', 'explicit stop terminates zero-time synchronous Worker');
    const timedOut = await runtime.simulate({ artifact: spin.artifact }, { timeoutMs: 1000 });
    check(timedOut.status === 'budget-exceeded', 'wall budget terminates synchronous Worker');
    const outputFlood = await runtime.compile({ top: 'tb', sources: [{ path: 'flood.sv', content: 'module tb; initial forever $display("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"); endmodule' }] });
    const flood = await runtime.simulate({ artifact: outputFlood.artifact });
    check(flood.code === 'output-budget', 'actual stdout flood hits output budget: ' + JSON.stringify(flood));
    const fileFlood = await runtime.compile({ top: 'tb', sources: [{ path: 'file.sv', content: 'module tb; integer fd; initial begin fd=$fopen("trace.vcd","w"); forever $fdisplay(fd,"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"); end endmodule' }] });
    const fileResult = await runtime.simulate({ artifact: fileFlood.artifact });
    check(fileResult.code === 'output-budget', 'actual file growth is bounded during native writes: ' + JSON.stringify(fileResult));
    const afterStarted = performance.now();
    const after = await runtime.simulate({ artifact: compiled.artifact, expectedIndices: indices });
    check(after.status === 'completed' && after.observationState === 'complete', 'normal simulation works after termination and output failures');
    timings.push({ stage: 'artifact-reuse-simulation', ms: performance.now() - afterStarted });
    const tooBig = await runtime.compile({ top: 'tb', sources: [{ path: 'large.sv', content: ' '.repeat(1024 * 1024 + 1) }] });
    check(tooBig.code === 'input-budget', 'input budget refuses oversized source');
    const tooManyFiles = await runtime.simulate({ artifact: compiled.artifact, files: Array.from({ length: 65 }, (_, index) => ({ path: `in-${index}.txt`, content: '' })) });
    check(tooManyFiles.code === 'input-budget', 'simulation input budget refuses excess files');
    const tooBigRunFile = await runtime.simulate({ artifact: compiled.artifact, files: [{ path: 'input.txt', content: ' '.repeat(1024 * 1024 + 1) }] });
    check(tooBigRunFile.code === 'input-budget', 'simulation input budget refuses oversized file');
    const busyController = new AbortController();
    let markSimulating;
    const simulating = new Promise(resolve => { markSimulating = resolve; });
    const pending = runtime.simulate({ artifact: spin.artifact }, { signal: busyController.signal, onStage: stage => { if (stage === 'simulate') markSimulating(); } });
    await simulating;
    const busy = await runtime.simulate({ artifact: compiled.artifact });
    check(busy.code === 'busy', 'parallel slot bound refuses a second live Worker');
    const secondAdapter = await createIcarusRuntime({ identity, assets, adapters, baseUrl: location.origin + '/assets/' });
    check((await secondAdapter.simulate({ artifact: compiled.artifact })).code === 'busy', 'parallel bound also applies across adapter instances');
    busyController.abort(); await pending;
    const corrupt = structuredClone(compiled.artifact); corrupt.program[0] ^= 1;
    check((await runtime.simulate({ artifact: corrupt })).code === 'invalid-input', 'corrupt reusable compilation is rejected');
    const invalidAssets = structuredClone(assets); invalidAssets['ivl.js'].sha256 = '0'.repeat(64);
    let rejectedManifest = false;
    try { await createIcarusRuntime({ identity, assets: invalidAssets, adapters, baseUrl: location.origin + '/assets/' }); } catch { rejectedManifest = true; }
    check(rejectedManifest, 'runtime manifest identity protects cache basis');
    const invalidAdapters = structuredClone(adapters); invalidAdapters['worker.mjs'].sha256 = '0'.repeat(64);
    let rejectedAdapter = false;
    try { await createIcarusRuntime({ identity, assets, adapters: invalidAdapters, baseUrl: location.origin + '/assets/' }); } catch { rejectedAdapter = true; }
    check(rejectedAdapter, 'adapter changes invalidate the runtime identity');
    const revisedIdentity = await bundleIdentity(assets, invalidAdapters);
    const revisedRuntime = await createIcarusRuntime({ identity: revisedIdentity, assets, adapters: invalidAdapters, baseUrl: location.origin + '/assets/' });
    check((await revisedRuntime.simulate({ artifact: compiled.artifact })).code === 'invalid-input', 'old compilation artifact is rejected by changed adapter identity');
    const damagedRuntime = await createIcarusRuntime({ identity, assets, adapters, baseUrl: location.origin + '/tampered/' });
    check((await damagedRuntime.compile(request)).code === 'resource-integrity', 'actual resource bytes are checked before JS evaluation');
    const memoryCompile = await runtime.compile({ top: 'tb', sources: [{ path: 'memory.sv', content: 'module tb; integer arr[0:100000000]; initial begin arr[100000000]=1; $display("%d",arr[100000000]); $finish; end endmodule' }] });
    check(memoryCompile.status === 'completed', 'oversized-memory fixture compiles as actual HDL');
    const memoryResult = await runtime.simulate({ artifact: memoryCompile.artifact });
    check(memoryResult.status !== 'completed', 'oversized-memory execution cannot report success');
    const final = await runtime.simulate({ artifact: compiled.artifact, expectedIndices: indices });
    check(final.observationState === 'complete', 'fresh normal task succeeds after memory-limit failure');
    const raceStatuses = [];
    for (let index = 0; index < 5; index++) {
      const raceController = new AbortController();
      const race = await runtime.simulate({ artifact: short.artifact, expectedIndices: [0] }, { signal: raceController.signal,
        onStage: stage => { if (stage === 'simulate') setTimeout(() => raceController.abort(), index); } });
      check(['completed', 'stopped'].includes(race.status), `stop/complete race ${index} has a single explicit outcome`);
      raceStatuses.push(race.status);
    }
    return { passed, timings, raceStatuses, memoryOutcome: memoryResult, userAgent: navigator.userAgent };
  }, { assets, adapters, identity, fixture });
  report.chrome = browser.version(); report.bundleIdentity = identity; report.assets = assets;
  report.startedAt = startedAt; report.finishedAt = new Date().toISOString();
  report.host = {
    platform: process.platform, architecture: process.arch, release: release(),
    cpu: cpus()[0]?.model, cores: cpus().length, totalMemoryBytes: totalmem(),
    loadAverage: loadavg(), chrome: browser.version(), headless: false,
  };
  report.runtimeDir = resolve(runtimeDir);
  report.adapterRoot = resolve(process.env.XUNJIE_ALU_ADAPTER_ROOT ?? 'tools/alu-wasm/runtime');
  report.deployment = 'Loopback static HTTP: runtime assets under /assets/, adapter modules under /adapter/; delivered Git component consumed directly';
  report.scope = `Actual desktop Chrome Worker and public adapter on ${process.platform}/${process.arch}; runtime package only; no product integration or teaching acceptance`;
  report.adapterFiles = {};
  for (const name of ['index.mjs', 'worker.mjs', 'identity.mjs', 'index.d.mts']) {
    const bytes = await readFile(resolve(process.env.XUNJIE_ALU_ADAPTER_ROOT ?? 'tools/alu-wasm/runtime', name));
    report.adapterFiles[name] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  await page.evaluate(summary => {
    document.body.textContent = '';
    document.body.style.font = '13px ui-monospace, monospace';
    const title = document.createElement('h1'); title.textContent = 'ALU Icarus/WASM public adapter acceptance';
    const meta = document.createElement('p');
    meta.textContent = `${summary.passed} checks passed; Chrome ${summary.chrome}; package ${summary.identity}; ${summary.host}`;
    const pre = document.createElement('pre'); pre.textContent = summary.checks.join('\n');
    document.body.append(title, meta, pre);
  }, { passed: report.passed.length, chrome: report.chrome, identity, host: `${report.host.platform}/${report.host.architecture} ${report.host.release}`, checks: report.passed });
  await page.screenshot({ path: resolve(outputDir, 'adapter-acceptance.png'), fullPage: true });
  await writeFile(resolve(outputDir, 'adapter.json'), JSON.stringify(report, null, 2));
  assert.ok(report.passed.length >= 15);
  console.log(JSON.stringify(report));
} finally {
  await browser?.close(); await new Promise(done => server.close(done));
}
