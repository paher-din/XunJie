import type { ModelTool, ModelToolProgress } from '@xunjie/contracts/model-connections';
import { createProgressPublisher } from './sensitive-output.js';

/** A protocol assembler's cumulative argument field, never an intent or repaired JSON. */
export interface ToolArgumentProgress { callId: string; name: string; arguments: string }
const previewLimit = 200_000;
const unicodePrefix = (text: string) => /[\uD800-\uDBFF]$/.test(text) ? text.slice(0, -1) : text;

/** Incremental JSON lexer/parser. Only the root object's first html string is projected.
 * All other strings/containers are consumed according to JSON grammar, never searched.
 * Incomplete escapes stay private; invalid input permanently stops this projection.
 */
function htmlDecoder() {
  type Frame = { object: boolean; state: 'key-or-end' | 'key' | 'colon' | 'value' | 'value-or-end' | 'comma-or-end'; key: string };
  const stack: Frame[] = [];
  let root = false, done = false, stopped = false, found = false, text = '';
  let token: 'key' | 'string' | 'primitive' | null = null, value = '', target = false, escape = false, hex: string | null = null;
  function fail(): never { throw new Error('invalid-json-prefix'); }
  function finishValue() { const frame = stack.at(-1); if (frame) frame.state = 'comma-or-end'; else done = true; }
  function character(char: string) {
    if (done) { if (!/^[\x20\t\r\n]$/.test(char)) fail(); return; }
    if (token === 'key' || token === 'string') {
      const append = (decoded: string) => { if (token === 'key') value += decoded; else if (target && text.length < previewLimit) text += decoded; };
      if (hex !== null) {
        if (!/^[\da-fA-F]$/.test(char)) fail();
        hex += char;
        if (hex.length === 4) { append(String.fromCharCode(Number.parseInt(hex, 16))); hex = null; }
      } else if (escape) {
        escape = false;
        if (char === 'u') hex = '';
        else {
          const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          const decoded = escapes[char]; if (decoded === undefined) fail(); append(decoded);
        }
      } else if (char === '\\') escape = true;
      else if (char === '"') {
        const key = token === 'key'; token = null;
        if (key) { stack.at(-1)!.key = value; stack.at(-1)!.state = 'colon'; }
        else finishValue();
      } else { if (char.charCodeAt(0) < 32) fail(); append(char); }
      return;
    }
    if (token === 'primitive') {
      if (!/^[\x20\t\r\n,}\]]$/.test(char)) { value += char; if (value.length > 1000) fail(); return; }
      if (!/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(value)) fail();
      token = null; finishValue(); character(char); return;
    }
    if (/^[\x20\t\r\n]$/.test(char)) return;
    if (!root) { if (char !== '{') fail(); root = true; stack.push({ object: true, state: 'key-or-end', key: '' }); return; }
    const frame = stack.at(-1); if (!frame) fail();
    const close = () => { stack.pop(); finishValue(); };
    if (frame.state === 'key-or-end' || frame.state === 'key') {
      if (char === '}' && frame.state === 'key-or-end') { close(); return; }
      if (char !== '"') fail(); token = 'key'; value = ''; return;
    }
    if (frame.state === 'colon') { if (char !== ':') fail(); frame.state = 'value'; return; }
    if (frame.state === 'comma-or-end') {
      if (char === (frame.object ? '}' : ']')) { close(); return; }
      if (char !== ',') fail(); frame.state = frame.object ? 'key' : 'value'; return;
    }
    if (frame.state === 'value-or-end' && char === ']') { close(); return; }
    const isHtml = stack.length === 1 && frame.object && frame.key === 'html';
    if (isHtml) { if (found) fail(); found = true; }
    if (char === '"') { token = 'string'; target = isHtml; return; }
    if (char === '{' || char === '[') {
      if (stack.length >= 128) fail();
      stack.push({ object: char === '{', state: char === '{' ? 'key-or-end' : 'value-or-end', key: '' }); return;
    }
    if (!/^[tfn\d-]$/.test(char)) fail(); token = 'primitive'; value = char;
  }
  return (fragment: string) => {
    if (!stopped) try { for (const char of fragment) character(char); } catch { stopped = true; }
    return unicodePrefix(text.slice(0, previewLimit));
  };
}

/** No rendering or dispatch occurs here. Consumers must isolate this static preview. */
export function createJsonToolProgress(tools: ModelTool[], apiKey: string, emit: (tools: ModelToolProgress[]) => void) {
  const declared = new Set(tools.filter(tool => tool.progress?.kind === 'json-string' && tool.progress.property === 'html').map(tool => tool.name));
  const calls = new Map<string, { name: string; raw: string; stopped: boolean; decode: ReturnType<typeof htmlDecoder>;
    publish: ReturnType<typeof createProgressPublisher> }>();
  const visible = new Map<string, ModelToolProgress>();
  let revision = 0;
  return (fields: ToolArgumentProgress[]) => {
    const previousRevision = revision;
    for (const field of fields) {
      if (!declared.has(field.name) || !field.callId || field.callId.length > 200
        || apiKey && (field.callId.includes(apiKey) || field.name.includes(apiKey))) continue;
      let call = calls.get(field.callId);
      if (!call) {
        if (calls.size >= 8) continue;
        call = { name: field.name, raw: '', stopped: false, decode: htmlDecoder(), publish: createProgressPublisher(apiKey, text => {
          text = unicodePrefix(text);
          const previous = visible.get(field.callId)?.text ?? '';
          if (text.length > previous.length && text.startsWith(previous)) {
            visible.set(field.callId, { callId: field.callId, name: field.name, property: 'html', text }); revision++;
          }
        }) };
        calls.set(field.callId, call);
      }
      if (call.stopped || field.arguments === call.raw) continue;
      if (field.name !== call.name || !field.arguments.startsWith(call.raw)) {
        // A stale snapshot cannot rewind the original call; conflicting data stops it.
        if (field.name !== call.name || !call.raw.startsWith(field.arguments)) call.stopped = true;
        continue;
      }
      if (field.arguments.length > 2_000_000) { call.stopped = true; continue; }
      const fragment = field.arguments.slice(call.raw.length); call.raw = field.arguments;
      call.publish(call.decode(fragment));
    }
    if (revision !== previousRevision) emit([...visible.values()].map(item => ({ ...item })));
  };
}
