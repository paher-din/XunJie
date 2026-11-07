import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { release, cpus, loadavg, totalmem } from 'node:os';
import { chromium } from '@playwright/test';

// Engineering acceptance for the #193 four-round check scaffold. It uses the delivered runtime
// package and the actual check.sv, but a synthetic correct/negative DUT instead of a student account
// or product database. It is not browser/product acceptance.
const root = resolve(import.meta.dirname, '../..');
const runtimeDir = resolve(root, 'components/alu-icarus-runtime');
const scaffoldFile = resolve(root, 'components/alu-experiment/check.sv');
const outputDir = resolve(root, process.argv[2] ?? '.verification/alu-check');
const startedAt = new Date().toISOString();
await mkdir(outputDir, { recursive: true });
const manifest = JSON.parse(await readFile(resolve(runtimeDir, 'manifest.json'), 'utf8'));
const assets = {}, adapters = {};
for (const name of ['ivl.js', 'ivl.wasm', 'ivlpp.js', 'ivlpp.wasm', 'vvp.js', 'vvp.wasm']) assets[name] = {
  bytes: (await stat(resolve(runtimeDir, name))).size,
  sha256: createHash('sha256').update(await readFile(resolve(runtimeDir, name))).digest('hex'),
};
const adapterNames = ['index.mjs', 'worker.mjs', 'identity.mjs', 'index.d.mts'];
for (const name of adapterNames) adapters[name] = {
  bytes: (await stat(resolve(runtimeDir, name))).size,
  sha256: createHash('sha256').update(await readFile(resolve(runtimeDir, name))).digest('hex'),
};
const checkSource = await readFile(scaffoldFile, 'utf8');
const server = createServer(async (request, response) => {
  try {
    let file, type;
    if (request.url === '/') { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><title>ALU 4096 check scaffold</title><p>Real Chrome Worker check'); return; }
    const name = request.url.split('/').at(-1);
    if (request.url.startsWith('/assets/') && assets[name]) {
      file = resolve(runtimeDir, name); type = name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript';
    } else if (request.url.startsWith('/adapter/') && adapterNames.includes(name)) {
      file = resolve(runtimeDir, name); type = 'text/javascript';
    } else if (request.url === '/scaffold/check.sv') {
      response.setHeader('content-type', 'text/plain'); response.end(checkSource); return;
    }
    if (!file) { response.writeHead(404); response.end(); return; }
    response.setHeader('content-type', type); response.end(await readFile(file));
  } catch (error) { response.writeHead(500); response.end(String(error)); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  await page.goto(origin);
  const report = await page.evaluate(async ({ assets, adapters, manifest, checkSource }) => {
    const { createIcarusRuntime } = await import('/adapter/index.mjs');
    const identity = manifest.identity;
    const runtime = await createIcarusRuntime({ identity, assets, adapters, baseUrl: location.origin + '/assets/' });
    const indices = Array.from({ length: 4096 }, (_, index) => index);
    const check = (condition, message, detail) => {
      if (!condition) throw new Error(message + (detail === undefined ? '' : ': ' + JSON.stringify(detail).slice(0, 600)));
      passed.push(message);
    };
    const passed = [], timings = [], rounds = [];
    const design = (variant) => `\`timescale 1ns/1ps
module alu(input logic [3:0] A, B, input logic M, input logic [1:0] S, input logic Cin,
  output logic [3:0] F, output logic Cout);
${variant === 'delayed' ? 'always @* begin #1.5;' : 'always_comb begin'}
  ${variant === 'omitted-assignment' ? '' : "F = 4'b0000; Cout = 1'b0;"}
  case ({M,S})
    3'b000: F = ~A;
    3'b001: F = A & B;
    3'b010: F = A | B;
    3'b011: F = A ^ B;
    3'b100: ${variant === 'drop-carry' ? 'F = A + B + Cin;' : '{Cout,F} = {1\'b0,A} + {1\'b0,B} + {4\'b0000,Cin};'}
    default: begin ${variant === 'x-reserved' ? "F = 4'bxxxx; Cout = 1'bx;" : variant === 'z-reserved' ? "F = 4'bzzzz; Cout = 1'bz;" : variant === 'wrong-reserved' ? "F = 4'b0001; Cout = 1'b0;" : variant === 'omitted-assignment' ? '' : "F = 4'b0000; Cout = 1'b0;"} end
  endcase
end
endmodule`;
    const expected = (index) => {
      const A = (index >> 5) & 15, B = (index >> 1) & 15, Cin = index & 1, M = index >> 11, S = (index >> 9) & 3;
      if (M === 1 && S !== 0) return { f: '0000', cout: '0' };
      if (M === 1) {
        const total = A + B + Cin;
        return { f: (total & 15).toString(2).padStart(4, '0'), cout: String((total >> 4) & 1) };
      }
      const f = [15 - A, A & B, A | B, A ^ B][S];
      return { f: f.toString(2).padStart(4, '0'), cout: '0' };
    };
    const runVariant = async (name, variant) => {
      const compileStart = performance.now();
      const compiled = await runtime.compile({ top: 'experiment', entryFiles: ['design.sv', 'check.sv'], sources: [
        { path: 'design.sv', content: design(variant) }, { path: 'check.sv', content: checkSource },
      ] });
      timings.push({ variant: name, stage: 'compile', ms: Math.round(performance.now() - compileStart), status: compiled.status, cacheHit: compiled.cacheHit ?? null });
      check(compiled.status === 'completed', name + ' compiles the real check scaffold', compiled);
      const variantRounds = [];
      for (const spec of [{ round: 0, precursor: 'P0', sampleTime: 1 }, { round: 1, precursor: 'P0', sampleTime: 2 },
        { round: 2, precursor: 'P1', sampleTime: 1 }, { round: 3, precursor: 'P1', sampleTime: 2 }]) {
        const start = performance.now();
        const result = await runtime.simulate({ artifact: compiled.artifact,
          plusargs: [`+ROUND=${spec.precursor === 'P1' ? 1 : 0}`, `+SAMPLE=${spec.sampleTime}`], expectedIndices: indices });
        const durationMs = Math.round(performance.now() - start);
        timings.push({ variant: name, stage: `simulate-${spec.round}`, ms: durationMs });
        check(result.status === 'completed', `${name} round ${spec.round} completes`, result);
        check(result.observations.length === 4096, `${name} round ${spec.round} returns 4096 rows`, result.observations.length);
        check(result.observations.every((row, index) => !('invalid' in row) && row.index === index), `${name} round ${spec.round} returns ordered indices`);
        check(['omitted-assignment', 'delayed'].includes(variant) ? ['complete', 'complete-with-unknown'].includes(result.observationState)
          : result.observationState === (['x-reserved','z-reserved'].includes(variant) ? 'complete-with-unknown' : 'complete'),
          `${name} round ${spec.round} distinguishes four-state coverage`, result.observationState);
        check(typeof result.vcd === 'string' && result.vcd.includes('$enddefinitions') && result.vcd.includes('#'),
          `${name} round ${spec.round} retains VCD`, result.vcd === null ? null : result.vcd.slice(0, 80));
        variantRounds.push({ ...spec, durationMs, rows: result.observations.length, vcdBytes: new TextEncoder().encode(result.vcd ?? '').length,
          observationState: result.observationState, observations: result.observations });
      }
      return variantRounds;
    };
    const correct = await runVariant('correct', 'correct');
    const correctRows = correct.flatMap(round => round.observations);
    let mismatches = 0, unknown = 0;
    for (const round of correct) for (const row of round.observations) {
      if ('invalid' in row) continue;
      if (/[xz]/.test(row.f + row.cout)) { unknown++; continue; }
      const value = expected(row.index);
      if (row.f !== value.f || row.cout !== value.cout) mismatches++;
    }
    check(mismatches === 0, 'correct implementation matches the independent public rule on all 16384 sampled rows', mismatches);
    check(unknown === 0, 'correct implementation has no unknown rows', unknown);
    check(correctRows.length === 16384, 'four rounds produce exactly 16384 target samples', correctRows.length);
    const carry = correct[0].observations[(1 << 11) | (15 << 5) | 1];
    check(carry && !('invalid' in carry) && carry.f === '0000' && carry.cout === '1', 'carry example F=0000/Cout=1 is real', carry);
    const reserved = correct[0].observations[(1 << 11) | (1 << 9)];
    check(reserved && !('invalid' in reserved) && reserved.f === '0000' && reserved.cout === '0', 'reserved combination is sampled and zero', reserved);

    const drop = await runVariant('drop-carry', 'drop-carry');
    const badRows = drop.flatMap(round => round.observations).filter(row => !('invalid' in row) && row.cout === '0'
      && expected(row.index).cout === '1');
    const badIndices = new Set(badRows.map(row => row.index));
    check(badIndices.size === 256, 'drop-carry fixture produces 256 unique wrong inputs', badIndices.size);
    check(badRows.length === 1024, 'drop-carry fixture produces 1024 wrong target rows over four rounds', badRows.length);

    const x = await runVariant('x-reserved', 'x-reserved');
    const unknownRows = x.flatMap(round => round.observations).filter(row => !('invalid' in row) && /[xz]/.test(row.f + row.cout));
    const unknownIndices = new Set(unknownRows.map(row => row.index));
    check(unknownIndices.size === 1536, 'X fixture produces 1536 unique unknown-input rows', unknownIndices.size);
    check(unknownRows.length === 6144, 'X fixture produces 6144 unknown target rows over four rounds', unknownRows.length);
    const z = await runVariant('z-reserved', 'z-reserved');
    const zRows = z.flatMap(round => round.observations).filter(row => /z/.test(row.f + row.cout));
    check(new Set(zRows.map(row => row.index)).size === 1536 && zRows.length === 6144, 'Z remains high impedance in 1536 unique inputs and 6144 samples');
    const wrongReserved = await runVariant('wrong-reserved', 'wrong-reserved');
    const wrongRows = wrongReserved.flatMap(round => round.observations).filter(row => row.f !== expected(row.index).f || row.cout !== expected(row.index).cout);
    check(new Set(wrongRows.map(row => row.index)).size === 1536, 'all 1536 binary wrong reserved inputs are sampled and rejected');
    const omitted = await runVariant('omitted-assignment', 'omitted-assignment');
    const different = (a,b) => a.observations.filter((row,index)=>row.f !== b.observations[index].f || row.cout !== b.observations[index].cout).length;
    check(different(omitted[0],omitted[2]) >= 1536, 'complementary precursors expose real omitted-assignment dependence');
    const delayed = await runVariant('delayed', 'delayed');
    check(different(delayed[0],delayed[1]) > 0, 'two sample times expose a real delayed-output implementation');
    const shortCompiled = await runtime.compile({ top:'experiment', entryFiles:['design.sv','check.sv'],sources:[
      {path:'design.sv',content:design('correct')},{path:'check.sv',content:checkSource.replace('i < 4096','i < 100')}] });
    check(shortCompiled.status === 'completed','short-output engineering scaffold compiles');
    const short = await runtime.simulate({artifact:shortCompiled.artifact,plusargs:['+ROUND=0','+SAMPLE=1'],expectedIndices:indices});
    check(short.status === 'completed' && short.observationState === 'incomplete' && short.observations.length === 100,
      'real incomplete simulation retains exactly 100 rows without claiming full coverage');
    const vcdBytes = correct.reduce((total, round) => total + round.vcdBytes, 0) + drop.reduce((total, round) => total + round.vcdBytes, 0) + x.reduce((total, round) => total + round.vcdBytes, 0);
    return { passed, timings, mismatches, unknown, badIndices: badIndices.size, badRows: badRows.length,
      unknownIndices: unknownIndices.size, unknownRows: unknownRows.length, vcdBytes, chrome: navigator.userAgent,
      extraNegatives:{zInputs:new Set(zRows.map(row=>row.index)).size,wrongReservedInputs:new Set(wrongRows.map(row=>row.index)).size,
        predecessorDifferences:different(omitted[0],omitted[2]),sampleTimeDifferences:different(delayed[0],delayed[1]),incompleteRows:short.observations.length},
      sample: { carry, reserved } };
  }, { assets, adapters, manifest, checkSource });
  report.startedAt = startedAt; report.finishedAt = new Date().toISOString();
  report.host = { platform: process.platform, architecture: process.arch, release: release(), cpu: cpus()[0]?.model,
    cores: cpus().length, totalMemoryBytes: totalmem(), loadAverage: loadavg(), chrome: browser.version(), headless: true };
  report.identity = manifest.identity; report.assets = assets; report.adapters = adapters;
  report.scope = 'Real desktop Chrome Worker and delivered runtime/scaffold; synthetic HDL; no product UI, account, database or teaching acceptance.';
  await writeFile(resolve(outputDir, 'check.json'), JSON.stringify(report, null, 2));
  await page.evaluate(summary => {
    document.body.textContent = '';
    const title = document.createElement('h1'); title.textContent = 'ALU 4096 check scaffold acceptance';
    const meta = document.createElement('p'); meta.textContent = `${summary.passed.length} checks passed; Chrome ${summary.chrome}`;
    const pre = document.createElement('pre'); pre.textContent = summary.passed.join('\n');
    document.body.append(title, meta, pre);
  }, { passed: report.passed, chrome: report.chrome });
  await page.screenshot({ path: resolve(outputDir, 'check.png'), fullPage: true });
  assert.ok(report.passed.length >= 20);
  console.log(JSON.stringify({ output: outputDir, checks: report.passed.length, timings: report.timings,
    vcdBytes: report.vcdBytes, badIndices: report.badIndices, badRows: report.badRows,
    unknownIndices: report.unknownIndices, unknownRows: report.unknownRows }));
} finally {
  await browser?.close(); await new Promise(done => server.close(done));
}
