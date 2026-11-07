/** Browser/server shared VCD facts. A valid EOF says nothing about execution completion. */
export type AluVcdTimescale = Readonly<{ magnitude: 1 | 10 | 100; unit: 's' | 'ms' | 'us' | 'ns' | 'ps' | 'fs' }>;
export type AluVcdChange = Readonly<{ timeTick: string; value: string }>;
export type AluVcdSignal = Readonly<{ id: string; width: number; code: string; changes: readonly AluVcdChange[] }>;
export type AluVcdIssue = Readonly<{ code: string; message: string; severity: 'error' | 'warning'; offset: number }>;
export type AluVcd = Readonly<{
  status: 'valid' | 'invalid' | 'incomplete';
  timescale: AluVcdTimescale | null;
  signals: readonly AluVcdSignal[];
  lastTick: string;
  issues: readonly AluVcdIssue[];
}>;

/** Inclusive original VCD ticks. Signal order and leading decimal zeroes are normalized. */
export type AluWaveRange = { signalIds: string[]; fromTick: string; toTick: string };

export const ALU_VCD_LIMITS = Object.freeze({
  inputBytes: 8 * 1024 * 1024,
  signals: 4096,
  signalWidth: 65536,
  declaredBits: 1024 * 1024,
  changes: 1000000,
  expandedBits: 32 * 1024 * 1024,
  scopeDepth: 128,
  identifierLength: 4096,
  tickDigits: 128,
  rangeCopyBytes: 256 * 1024,
});

function utf8Bytes(text: string, limit: number): number {
  let bytes = 0;
  for (let index = 0; index < text.length && bytes <= limit; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length
      && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) { bytes += 4; index++; }
    else bytes += 3;
  }
  return bytes;
}

class VcdFailure extends Error {
  constructor(readonly code: string, message: string, readonly status: 'invalid' | 'incomplete' = 'invalid') { super(message); }
}

// The object overload is an optimization for in-process parses, never a wire attestation.
const parsedFacts = new WeakSet<AluVcd>();

/**
 * Parses digital Icarus/IEEE VCD without guessing timescale, missing values or a completion flag.
 * IDs use dot-separated full scopes, with literal dots/backslashes escaped; declaration ranges
 * remain part of the leaf (e.g. tb.dut.F[3:0]). Changes retain order, including equal timestamps.
 * Invalid/truncated syntax fails closed: no partial waveform is returned. A syntactically valid
 * retained prefix can still be incomplete execution output; that knowledge belongs to its owner.
 * Non-digital real/string values and named events are explicitly refused: an event pulse has
 * no persistent four-state level and must not be drawn as a held logical one.
 */
export function parseAluVcd(text: string): AluVcd {
  const tokens = /\S+/g;
  let offset = 0;
  let timescale: AluVcdTimescale | null = null;
  let lastTick = '0';
  const fail = (code: string, message: string, status: 'invalid' | 'incomplete' = 'invalid'): never => {
    throw new VcdFailure(code, message, status);
  };
  const next = (): string | null => {
    const match = tokens.exec(text);
    if (!match) { offset = text.length; return null; }
    offset = match.index;
    return match[0];
  };
  const required = (): string => next() ?? fail('unexpected-eof', 'VCD 在一条记录结束前中断。', 'incomplete');
  const atEof = () => !/\S/.test(text.slice(tokens.lastIndex));
  const end = () => { if (required() !== '$end') fail('expected-end', 'VCD 声明缺少 $end。'); };
  const escapeName = (name: string) => name.replaceAll('\\', '\\\\').replaceAll('.', '\\.');
  const printable = (value: string) => /^[\x21-\x7e]+$/.test(value);
  try {
    if (text.length > ALU_VCD_LIMITS.inputBytes || utf8Bytes(text, ALU_VCD_LIMITS.inputBytes) > ALU_VCD_LIMITS.inputBytes)
      fail('resource-limit', 'VCD 超过 8 MiB 资源上限。');
    const scopes: string[] = [];
    const signals: AluVcdSignal[] = [];
    const ids = new Set<string>();
    const groups = new Map<string, { width: number; changes: AluVcdChange[] }>();
    const warnings: AluVcdIssue[] = [];
    let definitions = false;
    let dumpBlock = false;
    let declaredBits = 0;
    let changes = 0;
    let expandedBits = 0;
    let tick = 0n;
    let token: string | null;
    while ((token = next()) !== null) {
      if (token === '$date' || token === '$version' || token === '$comment') {
        const start = tokens.lastIndex, commentOffset = offset;
        while (required() !== '$end') { /* Metadata contains no signal facts. */ }
        if (token === '$comment' && !warnings.length
          && /^\s*Dump file limit \(\d+ bytes\) exceeded\.\s*$/.test(text.slice(start, offset)))
          warnings.push(Object.freeze({ code: 'recording-limited', severity: 'warning', offset: commentOffset,
            message: 'Icarus 已达到波形转储上限，保留的记录不完整。' }));
      } else if (!definitions && token === '$timescale') {
        if (timescale) fail('timescale', 'VCD 重复声明时间单位。');
        let scale = required();
        const following = required();
        if (following !== '$end') { scale += following; end(); }
        const match = /^(1|10|100)(s|ms|us|ns|ps|fs)$/.exec(scale);
        if (!match) fail('timescale', 'VCD 时间单位无效。');
        timescale = Object.freeze({ magnitude: Number(match![1]) as AluVcdTimescale['magnitude'], unit: match![2] as AluVcdTimescale['unit'] });
      } else if (!definitions && token === '$scope') {
        const kind = required(), name = required();
        if (!['module', 'task', 'function', 'begin', 'fork', 'generate'].includes(kind) || !printable(name))
          fail('scope', 'VCD 层级声明无效。');
        end();
        scopes.push(escapeName(name));
        if (scopes.length > ALU_VCD_LIMITS.scopeDepth || scopes.join('.').length > ALU_VCD_LIMITS.identifierLength)
          fail('resource-limit', 'VCD 层级超过解析上限。');
      } else if (!definitions && token === '$upscope') {
        end();
        if (!scopes.length) fail('scope', 'VCD 层级结束与声明不匹配。');
        scopes.pop();
      } else if (!definitions && token === '$var') {
        const kind = required(), widthText = required(), code = required(), reference = required();
        if (!['integer', 'parameter', 'reg', 'supply0', 'supply1', 'time', 'tri', 'triand', 'trior', 'trireg',
          'tri0', 'tri1', 'wand', 'wire', 'wor', 'logic', 'bit'].includes(kind))
          fail('unsupported-variable', 'VCD 包含不支持四态波形的变量类型。');
        if (!/^\d+$/.test(widthText) || widthText.length > 6 || BigInt(widthText) < 1n
          || BigInt(widthText) > BigInt(ALU_VCD_LIMITS.signalWidth))
          fail('resource-limit', 'VCD 信号位宽无效或超过解析上限。');
        const width = Number(widthText);
        if (!printable(code) || !printable(reference) || !scopes.length)
          fail('variable', 'VCD 信号声明缺少有效层级、标识或名称。');
        let range = required();
        if (range !== '$end') {
          if (range.length > ALU_VCD_LIMITS.identifierLength) fail('resource-limit', 'VCD 信号位范围超过解析上限。');
          const indices = /^\[(-?\d+)(?::(-?\d+))?\]$/.exec(range);
          if (!indices) fail('variable', 'VCD 信号位范围无效。');
          const first = BigInt(indices![1]!), last = BigInt(indices![2] ?? indices![1]!);
          if ((first > last ? first - last : last - first) + 1n !== BigInt(width))
            fail('variable', 'VCD 信号位范围与声明位宽不匹配。');
          end();
        } else range = '';
        const id = [...scopes, escapeName(reference) + range].join('.');
        if (ids.has(id)) fail('duplicate-signal', 'VCD 重复声明同一层级信号。');
        if (id.length > ALU_VCD_LIMITS.identifierLength || code.length > ALU_VCD_LIMITS.identifierLength
          || signals.length >= ALU_VCD_LIMITS.signals || (declaredBits += width) > ALU_VCD_LIMITS.declaredBits)
          fail('resource-limit', 'VCD 信号声明超过解析上限。');
        ids.add(id);
        let group = groups.get(code);
        if (group && group.width !== width) fail('alias-width', 'VCD 同一标识的别名位宽不一致。');
        if (!group) { group = { width, changes: [] }; groups.set(code, group); }
        signals.push({ id, width, code, changes: group.changes });
      } else if (!definitions && token === '$enddefinitions') {
        end();
        if (scopes.length) fail('scope', 'VCD 定义结束时仍有未关闭的层级。');
        definitions = true;
      } else if (definitions && ['$dumpvars', '$dumpall', '$dumpon', '$dumpoff'].includes(token)) {
        if (dumpBlock) fail('dump-block', 'VCD 值块不能嵌套。');
        dumpBlock = true;
      } else if (definitions && token === '$end' && dumpBlock) {
        dumpBlock = false;
      } else if (definitions && token.startsWith('#')) {
        if (dumpBlock) fail('dump-block', 'VCD 值块内出现时间记录。');
        const digits = token.slice(1);
        if (!/^\d+$/.test(digits)) fail('time', 'VCD 时间记录无效。', digits === '' && atEof() ? 'incomplete' : 'invalid');
        if (digits.length > ALU_VCD_LIMITS.tickDigits) fail('resource-limit', 'VCD 时间精度超过解析上限。');
        const value = BigInt(digits);
        if (value < tick) fail('time-order', 'VCD 时间倒退，不能生成波形。');
        tick = value;
        lastTick = tick.toString();
      } else if (definitions && /^[01xXzZbB]/.test(token)) {
        const vector = /^[bB]/.test(token);
        let value = token.slice(0, 1).toUpperCase();
        const code = vector ? required() : token.slice(1);
        if (vector) value = token.slice(1).toUpperCase();
        if (!code || !value) fail('value', 'VCD 数值记录未结束。', atEof() ? 'incomplete' : 'invalid');
        const group = groups.get(code);
        if (!group) fail('unknown-code', 'VCD 数值引用未声明的信号标识。');
        if (!/^[01XZ]+$/.test(value) || (!vector && group!.width !== 1) || value.length > group!.width)
          fail('value', 'VCD 四态数值与声明位宽不匹配。');
        if (++changes > ALU_VCD_LIMITS.changes || (expandedBits += group!.width) > ALU_VCD_LIMITS.expandedBits)
          fail('resource-limit', 'VCD 变化数量或展开位数超过解析上限。');
        // IEEE VCD compression extends X/Z with the leading state; binary values with zero.
        const fill = value[0] === 'X' || value[0] === 'Z' ? value[0] : '0';
        group!.changes.push(Object.freeze({ timeTick: lastTick, value: value.padStart(group!.width, fill) }));
      } else fail('syntax', 'VCD 包含不支持或损坏的记录。');
    }
    if (!definitions || dumpBlock) fail('unexpected-eof', 'VCD 声明或值块尚未结束。', 'incomplete');
    for (const group of groups.values()) Object.freeze(group.changes);
    if (!timescale) warnings.push(Object.freeze({ code: 'missing-timescale', severity: 'warning',
      message: 'VCD 未声明时间单位，仅能使用原始 tick。', offset: 0 }));
    const result: AluVcd = Object.freeze({ status: 'valid', timescale, lastTick,
      signals: Object.freeze(signals.map(signal => Object.freeze(signal))),
      issues: Object.freeze(warnings),
    });
    parsedFacts.add(result);
    return result;
  } catch (error) {
    if (!(error instanceof VcdFailure)) throw error;
    return Object.freeze({ status: error.status, timescale, lastTick, signals: Object.freeze([]),
      issues: Object.freeze([Object.freeze({ code: error.code, severity: 'error' as const, message: error.message, offset })]),
    });
  }
}

export class AluVcdRangeError extends Error {
  constructor(readonly code: 'invalid-source' | 'invalid-range' | 'unknown-signal' | 'range-too-large', message: string) {
    super(message);
    this.name = 'AluVcdRangeError';
  }
}

function rangeSource(source: string | AluVcd): AluVcd {
  const parsed = typeof source === 'string' ? parseAluVcd(source) : source;
  if (!parsed || !parsedFacts.has(parsed) || parsed.status !== 'valid')
    throw new AluVcdRangeError('invalid-source', '请从有效的原始 VCD 生成范围副本；不接受自报的解析事实。');
  return parsed;
}

function canonicalTick(value: string): string {
  if (typeof value !== 'string' || value.length > ALU_VCD_LIMITS.tickDigits || !/^\d+$/.test(value))
    throw new AluVcdRangeError('invalid-range', '时间范围必须使用非负十进制整数 tick。');
  return BigInt(value).toString();
}

/** Only normalized non-negative decimal tick strings are compared here. */
function compareTicks(left: string, right: string): number {
  return left.length - right.length || (left < right ? -1 : left > right ? 1 : 0);
}

export function normalizeAluWaveRange(source: string | AluVcd, range: AluWaveRange): AluWaveRange {
  const parsed = rangeSource(source);
  if (!range || !Array.isArray(range.signalIds) || !range.signalIds.length || range.signalIds.length > ALU_VCD_LIMITS.signals
    || range.signalIds.some(id => typeof id !== 'string' || !id || id.length > ALU_VCD_LIMITS.identifierLength))
    throw new AluVcdRangeError('invalid-range', '请选择有效的波形信号。');
  const fromTick = canonicalTick(range.fromTick), toTick = canonicalTick(range.toTick);
  if (compareTicks(fromTick, toTick) > 0 || compareTicks(toTick, parsed.lastTick) > 0)
    throw new AluVcdRangeError('invalid-range', '时间范围越界或起点晚于终点。');
  const signalIds = [...new Set(range.signalIds)].sort();
  const known = new Set(parsed.signals.map(signal => signal.id));
  if (signalIds.some(id => !known.has(id))) throw new AluVcdRangeError('unknown-signal', '所选信号不在这份 VCD 中。');
  return { signalIds, fromTick, toTick };
}

/**
 * A factual selection-time copy, not a summary. Both bounds are inclusive. atFrom is the
 * last recorded value at/before fromTick (null means not yet acquired); changes contains
 * every original event inside [fromTick,toTick], including all events at either endpoint.
 * An event at fromTick may therefore also supply atFrom. Equal-tick order is retained.
 * Missing timescale stays null. No completeness/ownership claim is inferred from EOF.
 */
export function describeAluVcdRange(source: string | AluVcd, range: AluWaveRange): string {
  const parsed = rangeSource(source);
  const normalized = normalizeAluWaveRange(parsed, range);
  const chunks: string[] = [];
  let bytes = 0;
  const append = (chunk: string) => {
    bytes += utf8Bytes(chunk, ALU_VCD_LIMITS.rangeCopyBytes);
    if (bytes > ALU_VCD_LIMITS.rangeCopyBytes)
      throw new AluVcdRangeError('range-too-large', '波形范围副本超过 256 KiB，请缩小时间范围或减少信号。');
    chunks.push(chunk);
  };
  append(JSON.stringify({ format: 'alu-vcd-range-v1', interval: 'closed', range: normalized, timescale: parsed.timescale }).slice(0, -1));
  append(',"signals":[');
  const byId = new Map(parsed.signals.map(signal => [signal.id, signal]));
  for (const [index, id] of normalized.signalIds.entries()) {
    const signal = byId.get(id)!;
    // Find the first included event without scanning the unrelated history on every selection.
    let low = 0, high = signal.changes.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (compareTicks(signal.changes[middle]!.timeTick, normalized.fromTick) < 0) low = middle + 1;
      else high = middle;
    }
    const first = low;
    let atFrom: AluVcdChange | null = signal.changes[first - 1] ?? null;
    while (low < signal.changes.length && signal.changes[low]!.timeTick === normalized.fromTick) atFrom = signal.changes[low++]!;
    if (index) append(',');
    append(JSON.stringify({ id, width: signal.width, code: signal.code, atFrom }).slice(0, -1));
    append(',"changes":[');
    let count = 0;
    for (let cursor = first; cursor < signal.changes.length; cursor++) {
      const change = signal.changes[cursor]!;
      if (compareTicks(change.timeTick, normalized.toTick) > 0) break;
      if (count++) append(',');
      append(JSON.stringify(change));
    }
    append(']}');
  }
  append(']}');
  return chunks.join('');
}
