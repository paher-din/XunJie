// Engineering smoke check of the built modules. Browser Worker acceptance is separate.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const [runtimeDir, fixtureFile] = process.argv.slice(2);
if (!runtimeDir || !fixtureFile) throw new Error('usage: node smoke.mjs <runtime-dir> <fixture.json>');
const fixture = JSON.parse(await readFile(fixtureFile, 'utf8'));
// Exercise the Worker-only module in Node for engineering smoke checks.
// Browser checks below use the actual Chrome Worker, without these shims.
globalThis.self = globalThis;
globalThis.location = { href: pathToFileURL(resolve(runtimeDir, 'smoke-worker.js')).href };
globalThis.importScripts = () => { throw new Error('Unexpected external script load'); };
const diagnostics = [];
async function module(name, lines) {
  const factory = (await import(pathToFileURL(resolve(runtimeDir, `${name}.js`)).href)).default;
  const wasmBinary = await readFile(resolve(runtimeDir, `${name}.wasm`));
  return factory({ wasmBinary, print: line => lines.push(line), printErr: line => diagnostics.push(line) });
}
function run(instance, args) {
  const code = instance.callMain(args);
  assert.ok(code === 0 || code === undefined, `exit=${code}: ${diagnostics.join('\n')}`);
}
for (const mode of ['correct', 'lost-carry', 'unknown']) {
  let dut = fixture.dut;
  if (mode === 'lost-carry') dut = dut.replace('{Cout,F} =', 'F =');
  if (mode === 'unknown') dut = dut.replace("default: begin F = 4'b0000;", "default: begin F = 4'bxxxx;");
  diagnostics.length = 0;
  const ppOutput = [];
  const pp = await module('ivlpp', ppOutput);
  pp.FS.writeFile('/design.sv', `${dut}\n`);
  pp.FS.writeFile('/tb.sv', `${fixture.testbench}\n`);
  run(pp, ['-L', '/design.sv', '/tb.sv']);
  const compiler = await module('ivl', []);
  compiler.FS.writeFile('/src.v', `${ppOutput.join('\n')}\n`);
  compiler.FS.writeFile('/ivl.conf', [
    'basedir:/', 'module:system.vpi', 'generation:2012', 'generation:no-specify',
    'root:tb', 'out:/out.vvp', 'iwidth:32', 'widthcap:65536',
    'functor:cprop', 'functor:nodangle', 'flag:DLL=vvp.tgt', '',
  ].join('\n'));
  run(compiler, ['-C/ivl.conf', '--', '/src.v']);
  const program = compiler.FS.readFile('/out.vvp');
  const lines = [];
  const runtime = await module('vvp', lines);
  runtime.FS.writeFile('/sim.vvp', program);
  run(runtime, ['/sim.vvp']);
  const rows = lines.filter(line => line.startsWith('ROW '));
  assert.equal(rows.length, 4096);
  let mismatches = 0, unknown = 0;
  rows.forEach((line, index) => {
    const match = /^ROW (\d+) ([01xz]{4}) ([01xz])$/.exec(line);
    assert.ok(match, line);
    const [, number, f, c] = match;
    assert.equal(Number(number), index);
    const control = index >> 9, a = (index >> 5) & 15, b = (index >> 1) & 15, cin = index & 1;
    const sum = a + b + cin;
    const expected = control === 4 ? sum & 15 : [15 ^ a, a & b, a | b, a ^ b, 0, 0, 0, 0][control];
    const carry = control === 4 ? sum >> 4 : 0;
    if (/[xz]/.test(f + c)) unknown++;
    if (/[xz]/.test(f + c) || parseInt(f, 2) !== expected || parseInt(c, 2) !== carry) mismatches++;
  });
  assert.equal(mismatches, { correct: 0, 'lost-carry': 256, unknown: 1536 }[mode]);
  assert.equal(unknown, mode === 'unknown' ? 1536 : 0);
  const vcd = runtime.FS.readFile('/trace.vcd', { encoding: 'utf8' });
  assert.ok(vcd.includes('$enddefinitions') && vcd.includes('#4096000'));
  assert.ok(!diagnostics.some(line => /failed to open|dynamic linking not enabled|undefined system/i.test(line)), diagnostics.join('\n'));
  console.log(JSON.stringify({ mode, vectors: rows.length, mismatches, unknown, diagnostics,
    rowsSha256: createHash('sha256').update(rows.map(row => row.slice(4)).join('\n')).digest('hex'),
    vcdBytes: Buffer.byteLength(vcd) }));
}
