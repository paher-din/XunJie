import assert from 'node:assert/strict';
import test from 'node:test';
import { ALU_VCD_LIMITS, AluVcdRangeError, describeAluVcdRange, normalizeAluWaveRange, parseAluVcd } from '@xunjie/contracts/alu-waveform';

// Captured from local Icarus Verilog 13.0, 2026-11-07. The testbench uses
// `timescale 1ps/1ps; bus = 4'bxxxx; #2 bus = 4'bxx01; #1 bus = 4'bzz10;
// #9007199254740993 bus = 4'b0001; #1 bus = 4'b1000; #1 $finish;
// echo dut(bus, mirror) supplies a nested scope and propagated vector changes.
const icarus = `$date
 Sat Nov 7 14:45:07 2026
$end
$version Icarus Verilog $end
$timescale 1ps $end
$scope module tb $end
$var wire 4 ! mirror [3:0] $end
$var reg 4 " bus [3:0] $end
$var reg 1 # clk $end
$scope module dut $end
$var wire 4 $ a [3:0] $end
$var wire 4 % y [3:0] $end
$upscope $end
$upscope $end
$enddefinitions $end
$comment Show the parameter values. $end
$dumpall
$end
#0
$dumpvars
bx %
bx $
0#
bx "
bx !
$end
#2
1#
bx01 !
bx01 %
bx01 "
bx01 $
#3
bz10 !
bz10 %
bz10 "
bz10 $
#9007199254740996
b1 !
b1 %
b1 "
b1 $
#9007199254740997
b1000 !
b1000 %
b1000 "
b1000 $
#9007199254740998
`;

test('reads actual Icarus scopes, compressed four-state vectors and exact large ticks', () => {
  const parsed = parseAluVcd(icarus);
  assert.equal(parsed.status, 'valid');
  assert.deepEqual(parsed.issues, []);
  assert.deepEqual(parsed.timescale, { magnitude: 1, unit: 'ps' });
  assert.equal(parsed.lastTick, '9007199254740998');
  assert.deepEqual(parsed.signals.map(signal => [signal.id, signal.width, signal.code]), [
    ['tb.mirror[3:0]', 4, '!'], ['tb.bus[3:0]', 4, '"'], ['tb.clk', 1, '#'],
    ['tb.dut.a[3:0]', 4, '$'], ['tb.dut.y[3:0]', 4, '%'],
  ]);
  assert.deepEqual(parsed.signals[0]!.changes, [
    { timeTick: '0', value: 'XXXX' }, { timeTick: '2', value: 'XX01' },
    { timeTick: '3', value: 'ZZ10' }, { timeTick: '9007199254740996', value: '0001' },
    { timeTick: '9007199254740997', value: '1000' },
  ]);
  assert.deepEqual(parsed.signals[2]!.changes, [{ timeTick: '0', value: '0' }, { timeTick: '2', value: '1' }]);
});

test('copies a canonical closed range with its held start value and exact observed changes', () => {
  const parsed = parseAluVcd(icarus);
  const range = { signalIds: ['tb.mirror[3:0]', 'tb.bus[3:0]', 'tb.mirror[3:0]'], fromTick: '0004', toTick: '9007199254740997' };
  const canonical = { signalIds: ['tb.bus[3:0]', 'tb.mirror[3:0]'], fromTick: '4', toTick: '9007199254740997' };
  assert.deepEqual(normalizeAluWaveRange(parsed, range), canonical);
  const copy = describeAluVcdRange(parsed, range);
  assert.equal(copy, describeAluVcdRange(icarus, canonical));
  assert.deepEqual(JSON.parse(copy), {
    format: 'alu-vcd-range-v1', interval: 'closed', range: canonical, timescale: { magnitude: 1, unit: 'ps' },
    signals: [
      { id: 'tb.bus[3:0]', width: 4, code: '"', atFrom: { timeTick: '3', value: 'ZZ10' }, changes: [
        { timeTick: '9007199254740996', value: '0001' }, { timeTick: '9007199254740997', value: '1000' }] },
      { id: 'tb.mirror[3:0]', width: 4, code: '!', atFrom: { timeTick: '3', value: 'ZZ10' }, changes: [
        { timeTick: '9007199254740996', value: '0001' }, { timeTick: '9007199254740997', value: '1000' }] },
    ],
  });
});

test('a parsed-object overload only accepts immutable facts produced by the parser', () => {
  const parsed = parseAluVcd(icarus);
  const range = { signalIds: ['tb.clk'], fromTick: '0', toTick: '2' };
  const invented = { ...parsed, signals: [{ id: 'tb.clk', width: 1, code: '#', changes: [{ timeTick: '0', value: '1' }] }] };
  assert.throws(() => describeAluVcdRange(invented, range), { code: 'invalid-source' });
  assert.throws(() => normalizeAluWaveRange(JSON.parse(JSON.stringify(parsed)), range), { code: 'invalid-source' });
  assert.throws(() => { (parsed.signals[0]!.changes as unknown as { value: string }[])[0]!.value = '0000'; }, TypeError);
  assert.equal(JSON.parse(describeAluVcdRange(parsed, range)).signals[0].atFrom.value, '0');
});

const header = `$scope module tb $end
$var wire 4 ! bus [3:0] $end
$var wire 4 ! alias [3:0] $end
$var wire 1 # late $end
$upscope $end
$enddefinitions $end\n`;

test('retains identifier aliases, unacquired values and all equal-tick endpoint events', () => {
  const text = header + '#3\nb1 !\n#5\nbx !\nbz !\n#7\n1#\n#9\n';
  const parsed = parseAluVcd(text);
  assert.equal(parsed.timescale, null);
  assert.equal(parsed.status, 'valid');
  assert.equal(parsed.issues[0]?.code, 'missing-timescale');
  assert.deepEqual(parsed.signals[0]!.changes, parsed.signals[1]!.changes);
  assert.deepEqual(parsed.signals[0]!.changes, [
    { timeTick: '3', value: '0001' }, { timeTick: '5', value: 'XXXX' }, { timeTick: '5', value: 'ZZZZ' },
  ]);
  const range = { signalIds: ['tb.alias[3:0]', 'tb.late'], fromTick: '5', toTick: '7' };
  const copy = JSON.parse(describeAluVcdRange(parsed, range));
  assert.equal(copy.timescale, null);
  assert.deepEqual(copy.signals[0].atFrom, { timeTick: '5', value: 'ZZZZ' });
  assert.deepEqual(copy.signals[0].changes, [{ timeTick: '5', value: 'XXXX' }, { timeTick: '5', value: 'ZZZZ' }]);
  assert.equal(copy.signals[1].atFrom, null);
  assert.deepEqual(copy.signals[1].changes, [{ timeTick: '7', value: '1' }]);
  assert.equal(Object.hasOwn(parsed, 'complete'), false, 'a clean EOF cannot certify the execution');
});

test('rejects damaged facts, distinguishes syntactic truncation, and never returns a fabricated partial waveform', () => {
  for (const tail of ['#5\nb1 !\n#4\n', '#0\nb10101 !\n', '#0\nb10 ?\n', '#0\n0!\n', '#0\nb10a !\n']) {
    const parsed = parseAluVcd(header + tail);
    assert.equal(parsed.status, 'invalid', tail);
    assert.deepEqual(parsed.signals, [], tail);
    assert.throws(() => describeAluVcdRange(parsed, { signalIds: ['tb.bus[3:0]'], fromTick: '0', toTick: '0' }), { code: 'invalid-source' });
  }
  for (const text of ['', '$scope module', header + '$dumpvars\nb1 !\n', header + '#0\nb1 ', header + '# ', header + '0 ']) {
    const parsed = parseAluVcd(text);
    assert.equal(parsed.status, 'incomplete', JSON.stringify(text));
    assert.deepEqual(parsed.signals, []);
  }
});

test('refuses unknown signals and out-of-bounds or inexact ranges', () => {
  const parsed = parseAluVcd(icarus);
  const range = { signalIds: ['tb.clk'], fromTick: '0', toTick: '2' };
  for (const patch of [{ fromTick: '-1' }, { toTick: '1.5' }, { toTick: '1e3' }, { toTick: '9007199254740999' },
    { fromTick: '3' }, { signalIds: [] }]) {
    assert.throws(() => describeAluVcdRange(parsed, { ...range, ...patch }), { code: 'invalid-range' });
  }
  assert.throws(() => normalizeAluWaveRange(parsed, { ...range, signalIds: ['tb.unknown'] }), { code: 'unknown-signal' });
});

test('enforces the original 8 MiB byte budget and refuses oversized full copies without dropping events', () => {
  assert.equal(parseAluVcd(' '.repeat(ALU_VCD_LIMITS.inputBytes + 1)).issues[0]?.code, 'resource-limit');
  const multibyte = '$comment ' + '汉'.repeat(2800000) + ' $end\n' + header;
  assert.ok(multibyte.length < ALU_VCD_LIMITS.inputBytes);
  assert.equal(parseAluVcd(multibyte).issues[0]?.code, 'resource-limit');
  const large = header + Array.from({ length: 9000 }, (_, index) => `#${index}\nb1 !\n`).join('');
  const parsed = parseAluVcd(large);
  assert.equal(parsed.status, 'valid');
  assert.equal(parsed.signals[0]!.changes.length, 9000);
  assert.throws(() => describeAluVcdRange(parsed, { signalIds: ['tb.bus[3:0]'], fromTick: '0', toTick: '8999' }),
    (error: unknown) => error instanceof AluVcdRangeError && error.code === 'range-too-large' && /缩小/.test(error.message));
  assert.equal(JSON.parse(describeAluVcdRange(parsed, { signalIds: ['tb.bus[3:0]'], fromTick: '6998', toTick: '6999' })).signals[0].changes.length, 2);
  const bomb = header.replaceAll('4 !', '65536 !').replaceAll('[3:0]', '[65535:0]') + Array.from({ length: 514 }, () => 'bx !\n').join('');
  assert.equal(parseAluVcd(bomb).issues[0]?.code, 'resource-limit');
});

test('validates declaration ranges and alias widths while retaining literal escaped hierarchy names', () => {
  assert.equal(parseAluVcd(header.replace('[3:0]', '[2:0]')).status, 'invalid');
  assert.equal(parseAluVcd(header.replace('4 ! alias', '3 ! alias').replace('alias [3:0]', 'alias [2:0]')).issues[0]?.code, 'alias-width');
  assert.equal(parseAluVcd(header.replace('4 !', '0004 !')).status, 'valid');
  const escaped = `$scope module tb.top $end\n$var wire 1 __proto__ signal.dot [4] $end\n$upscope $end\n$enddefinitions $end\n1__proto__\n`;
  const parsed = parseAluVcd(escaped);
  assert.equal(parsed.status, 'valid');
  assert.equal(parsed.signals[0]!.id, 'tb\\.top.signal\\.dot[4]');
  assert.deepEqual(parsed.signals[0]!.changes, [{ timeTick: '0', value: '1' }]);
});

test('reports the actual Icarus dump-limit marker without treating an ordinary EOF as a finish certificate', () => {
  // Icarus vpi/sys_vcd.c writes this comment when recording stops at $dumplimit.
  const text = icarus + '$comment Dump file limit (1024 bytes) exceeded. $end\n';
  const parsed = parseAluVcd(text);
  assert.equal(parsed.status, 'valid', 'the retained prefix is syntactically valid');
  assert.equal(parsed.issues[0]?.code, 'recording-limited');
  assert.equal(parsed.issues[0]?.severity, 'warning');
  assert.equal(parsed.signals[0]!.changes.length, 5);
  assert.deepEqual(parseAluVcd(icarus).issues, []);
});

test('refuses real values and named events instead of inventing a held four-state digital level', () => {
  for (const kind of ['real', 'realtime', 'event', 'string']) {
    const text = `$scope module tb $end\n$var ${kind} 1 ! value $end\n$upscope $end\n$enddefinitions $end\n1!\n#10\n`;
    const parsed = parseAluVcd(text);
    assert.equal(parsed.issues[0]?.code, 'unsupported-variable', kind);
    assert.deepEqual(parsed.signals, []);
  }
});
