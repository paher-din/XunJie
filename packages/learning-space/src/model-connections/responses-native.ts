import { isDeepStrictEqual } from 'node:util';
import { StorageError } from '@xunjie/storage';
import type { ModelTool, ModelToolIntent, ModelUsage } from '@xunjie/contracts/model-connections';
import { modelToolIntentSchema, modelUsageSchema } from '@xunjie/contracts/model-connections';
import { toolValidators } from './chat-native.js';
import { protocolJsonStrings } from './sensitive-output.js';

type ObjectValue = Record<string, unknown>;
export function object(value: unknown): ObjectValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new StorageError('corrupt');
  return value as ObjectValue;
}
function requireValue(condition: unknown): asserts condition { if (!condition) throw new StorageError('corrupt'); }
function index(value: unknown): number {
  requireValue(Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) < 4096);
  return value as number;
}
function string(value: unknown): string { requireValue(typeof value === 'string'); return value; }
function identifier(value: unknown): string { const result = string(value); requireValue(result.length > 0); return result; }
function array(value: unknown): unknown[] { requireValue(Array.isArray(value)); return value; }
function same(value: unknown, expected: unknown) { requireValue(isDeepStrictEqual(value, expected)); }
function contiguous(values: Map<number, unknown>) {
  [...values.keys()].sort((a, b) => a - b).forEach((value, position) => requireValue(value === position));
}

// Only function-call arguments are JSON-encoded by this protocol. Visible text,
// signatures and encrypted reasoning must retain their original representation.
function decodedArguments(value: string): unknown {
  return protocolJsonStrings(value);
}
export function responsesSensitiveValues(response: unknown): unknown[] {
  if (!response || typeof response !== 'object' || !('output' in response) || !Array.isArray(response.output)) return [];
  return response.output.flatMap((item: unknown) => item && typeof item === 'object' && 'type' in item
    && item.type === 'function_call' && 'arguments' in item && typeof item.arguments === 'string'
    ? [decodedArguments(item.arguments)] : []);
}

export function responsesEventSensitiveValues(events: unknown[]): unknown[] {
  return events.flatMap(value => {
    if (!value || typeof value !== 'object') return [];
    const event = value as ObjectValue;
    const item = event.item as ObjectValue | undefined;
    return [...responsesSensitiveValues(event.response),
      ...(item?.type === 'function_call' && typeof item.arguments === 'string' ? [decodedArguments(item.arguments)] : []),
      ...(event.type === 'response.function_call_arguments.done' && typeof event.arguments === 'string' ? [decodedArguments(event.arguments)] : [])];
  });
}

export function responsesUsage(value: unknown, final: boolean): ModelUsage {
  if (value == null) return { state: 'unknown' };
  const native = object(value);
  const result: ModelUsage = { state: 'partial' };
  for (const [key, target] of [['input_tokens', 'inputTokens'], ['output_tokens', 'outputTokens'], ['total_tokens', 'totalTokens']] as const) {
    if (native[key] !== undefined) {
      requireValue(Number.isSafeInteger(native[key]) && (native[key] as number) >= 0);
      result[target] = native[key] as number;
    }
  }
  for (const [key, detail, target] of [['input_tokens_details', 'cached_tokens', 'cachedTokens'],
    ['output_tokens_details', 'reasoning_tokens', 'reasoningTokens']] as const) {
    if (native[key] == null) continue;
    const details = object(native[key]);
    if (details[detail] !== undefined) {
      requireValue(Number.isSafeInteger(details[detail]) && (details[detail] as number) >= 0);
      result[target] = details[detail] as number;
    }
  }
  if (result.inputTokens !== undefined && result.outputTokens !== undefined && result.totalTokens !== undefined) {
    requireValue(Number.isSafeInteger(result.inputTokens + result.outputTokens) && result.inputTokens + result.outputTokens === result.totalTokens);
    if (final) result.state = 'final';
  }
  requireValue(result.cachedTokens === undefined || result.inputTokens === undefined || result.cachedTokens <= result.inputTokens);
  requireValue(result.reasoningTokens === undefined || result.outputTokens === undefined || result.reasoningTokens <= result.outputTokens);
  return Object.keys(result).length === 1 ? { state: 'unknown' } : modelUsageSchema.parse(result);
}

function validatePart(value: unknown, kind: 'message' | 'content' | 'summary') {
  const part = object(value);
  if (kind === 'message') {
    requireValue(part.type === 'output_text' || part.type === 'refusal');
    string(part.type === 'refusal' ? part.refusal : part.text);
    if (part.annotations !== undefined) for (const value of array(part.annotations)) {
      const annotation = object(value);
      requireValue(['url_citation', 'file_citation', 'container_file_citation', 'file_path'].includes(string(annotation.type)));
    }
  } else { requireValue(part.type === (kind === 'summary' ? 'summary_text' : 'reasoning_text')); string(part.text); }
  return part;
}
function validateItem(value: unknown, complete: boolean) {
  const item = object(value);
  identifier(item.id);
  requireValue(['message', 'function_call', 'reasoning'].includes(string(item.type)));
  if (item.status !== undefined) requireValue(complete ? item.status === 'completed' : ['in_progress', 'completed', 'incomplete'].includes(string(item.status)));
  if (item.type === 'message') {
    requireValue(item.role === 'assistant');
    for (const value of array(item.content)) validatePart(value, 'message');
  } else if (item.type === 'function_call') {
    identifier(item.call_id); identifier(item.name);
    if (complete || item.arguments !== undefined) string(item.arguments);
  } else {
    if (complete) requireValue(item.content !== undefined || item.summary !== undefined || typeof item.encrypted_content === 'string');
    if (item.content !== undefined) for (const value of array(item.content)) validatePart(value, 'content');
    if (item.summary !== undefined) for (const value of array(item.summary)) validatePart(value, 'summary');
    if (item.encrypted_content !== undefined && item.encrypted_content !== null) string(item.encrypted_content);
  }
  return item;
}

export function responsesOutput(responseValue: unknown, tools?: ModelTool[]) {
  const response = object(responseValue);
  identifier(response.id);
  requireValue(response.object === 'response' && response.status === 'completed' && response.error == null && response.incomplete_details == null);
  const output = array(response.output);
  const ids = new Set<string>(), callIds = new Set<string>(), intents: ModelToolIntent[] = [];
  const validators = tools === undefined ? undefined : toolValidators(tools);
  let text = '', refused = false;
  for (const value of output) {
    const item = validateItem(value, true);
    const id = identifier(item.id); requireValue(!ids.has(id)); ids.add(id);
    if (item.type === 'message') for (const value of array(item.content)) {
      const part = object(value);
      if (part.type === 'output_text') text += string(part.text); else refused = true;
    }
    if (item.type === 'function_call') {
      const callId = identifier(item.call_id), name = identifier(item.name);
      requireValue(!callIds.has(callId)); callIds.add(callId);
      const args: unknown = JSON.parse(string(item.arguments)); object(args);
      if (validators) { const validate = validators.get(name); requireValue(validate && validate(args)); }
      intents.push(modelToolIntentSchema.parse({ callId, name, arguments: args }));
    }
  }
  requireValue(intents.length <= 8);
  return { output, text, refused, intents, usage: responsesUsage(response.usage, true) };
}

type TextTrack = { value: string; delta: boolean; done: boolean; partAdded: boolean; partDone: boolean; type: string; initial?: ObjectValue; final?: ObjectValue };
type ItemTrack = { id: string; type?: string; added?: ObjectValue; final?: ObjectValue; done: boolean;
  fields: Map<string, TextTrack>; content: Map<number, TextTrack>; summary: Map<number, TextTrack> };

/** Validates streamed claims against the authoritative full terminal output; never synthesizes replay items. */
export function createResponsesAssembler() {
  const items = new Map<number, ItemTrack>();
  let terminal: ObjectValue | null = null, terminalType: string | null = null, responseId: string | undefined;
  let sequence: number | undefined, partialText = '', streamError = false;
  const lifecycle = new Set<string>();
  function track(event: ObjectValue) {
    const position = index(event.output_index), id = identifier(event.item_id);
    let item = items.get(position);
    if (!item) { item = { id, done: false, fields: new Map(), content: new Map(), summary: new Map() }; items.set(position, item); }
    requireValue(item.id === id && !item.done); return item;
  }
  function field(item: ItemTrack, key: string, type: string) {
    let current = item.fields.get(key);
    if (!current) { current = { value: '', delta: false, done: false, partAdded: false, partDone: false, type }; item.fields.set(key, current); }
    requireValue(current.type === type); return current;
  }
  function part(item: ItemTrack, event: ObjectValue, summary: boolean, type: string) {
    const position = index(event[summary ? 'summary_index' : 'content_index']);
    const current = field(item, `${summary ? 'summary' : 'content'}:${position}`, type);
    (summary ? item.summary : item.content).set(position, current); return current;
  }
  function finishText(current: TextTrack, value: unknown) {
    const full = string(value); requireValue(!current.done);
    if (current.delta) same(current.value, full);
    else if (current.value) requireValue(full.startsWith(current.value));
    current.value = full; current.done = true;
  }
  function compareItem(item: ItemTrack, final: ObjectValue) {
    same(item.id, final.id);
    if (item.type !== undefined) same(item.type, final.type);
    if (item.added) {
      for (const key of ['role', 'call_id', 'name'] as const) if (item.added[key] !== undefined) same(item.added[key], final[key]);
      if (typeof item.added.arguments === 'string') requireValue(string(final.arguments).startsWith(item.added.arguments));
      for (const key of ['content', 'summary'] as const) if (item.added[key] !== undefined) {
        const initial = array(item.added[key]), complete = array(final[key]); requireValue(initial.length <= complete.length);
        initial.forEach((value, position) => {
          const before = object(value), after = object(complete[position]); same(before.type, after.type);
          for (const name of ['text', 'refusal'] as const) if (before[name] !== undefined) requireValue(string(after[name]).startsWith(string(before[name])));
        });
      }
    }
    if (item.final) same(item.final, final);
    contiguous(item.content); contiguous(item.summary);
    for (const [key, current] of item.fields) {
      let value: unknown;
      if (key === 'arguments') { requireValue(final.type === 'function_call'); value = final.arguments; }
      else {
        const [kind, position] = key.split(':');
        const valuePart = object(array(final[kind!])[Number(position)]);
        same(current.type, valuePart.type);
        value = valuePart[current.type === 'refusal' ? 'refusal' : 'text'];
        if (current.final) same(current.final, valuePart);
        if (current.initial) {
          for (const name of ['text', 'refusal'] as const) if (current.initial[name] !== undefined)
            requireValue(string(valuePart[name]).startsWith(string(current.initial[name])));
        }
      }
      if (current.delta || current.done || current.partDone) same(current.value, value);
      else requireValue(string(value).startsWith(current.value));
    }
  }
  function add(value: unknown) {
    const event = object(value), type = string(event.type);
    requireValue(!terminal && !streamError);
    if (event.sequence_number !== undefined) {
      const next = event.sequence_number;
      requireValue(Number.isSafeInteger(next) && (next as number) >= 0 && (sequence === undefined || next === sequence + 1));
      sequence = next as number;
    }
    if (['response.created', 'response.in_progress', 'response.queued', 'response.completed', 'response.incomplete', 'response.failed'].includes(type)) {
      const response = object(event.response), id = identifier(response.id);
      requireValue(response.object === 'response' && (!responseId || responseId === id)); responseId = id;
      responsesUsage(response.usage, false);
      if (['response.completed', 'response.incomplete', 'response.failed'].includes(type)) {
        same(response.status, type.slice('response.'.length));
        // Keep the full terminal before checking it, including malformed/unsupported native output.
        terminal = response; terminalType = type;
        if (type === 'response.completed') {
          responsesOutput(response);
          const output = array(response.output); contiguous(items);
          for (const [position, item] of items) compareItem(item, object(output[position]));
        }
      } else { requireValue(!lifecycle.has(type)); same(response.status, type === 'response.created' ? 'in_progress' : type.slice('response.'.length)); lifecycle.add(type); }
      return;
    }
    if (type === 'error') { streamError = true; return; }
    if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      const value = validateItem(event.item, false);
      const item = track({ ...event, item_id: value.id });
      if (item.type !== undefined) same(item.type, value.type); item.type = string(value.type);
      if (type.endsWith('.added')) {
        requireValue(!item.added && !item.final); item.added = value;
        if (value.type === 'function_call' && value.arguments !== undefined) field(item, 'arguments', 'function_call').value = string(value.arguments);
      } else {
        if (value.status !== 'incomplete') compareItem(item, value);
        item.final = value; item.done = true;
      }
      return;
    }
    const partEvent = type === 'response.content_part.added' || type === 'response.content_part.done'
      || type === 'response.reasoning_summary_part.added' || type === 'response.reasoning_summary_part.done';
    if (partEvent) {
      const item = track(event), summary = type.includes('summary_part'), partValue = object(event.part);
      const kind = summary ? 'summary' : partValue.type === 'reasoning_text' ? 'content' : 'message';
      validatePart(partValue, kind);
      if (item.type) requireValue(item.type === (kind === 'message' ? 'message' : 'reasoning'));
      const current = part(item, event, summary, string(partValue.type));
      const text = partValue[partValue.type === 'refusal' ? 'refusal' : 'text'];
      if (type.endsWith('.added')) {
        requireValue(!current.partAdded && !current.delta && !current.done && !current.partDone);
        current.partAdded = true; current.initial = partValue; current.value = string(text);
      } else {
        requireValue(!current.partDone && event.status !== 'incomplete');
        if (current.done) same(current.value, text); else finishText(current, text);
        current.partDone = true; current.final = partValue;
      }
      return;
    }
    const match = /^response\.(output_text|refusal|reasoning_text|reasoning_summary_text|function_call_arguments)\.(delta|done)$/.exec(type);
    requireValue(match);
    const item = track(event), name = match[1]!, done = match[2] === 'done';
    const expected = name === 'function_call_arguments' ? 'function_call' : name.startsWith('reasoning') ? 'reasoning' : 'message';
    if (item.type) same(item.type, expected);
    const current = name === 'function_call_arguments' ? field(item, 'arguments', 'function_call')
      : part(item, event, name === 'reasoning_summary_text', name === 'reasoning_summary_text' ? 'summary_text' : name);
    if (done) finishText(current, event[name === 'function_call_arguments' ? 'arguments' : name === 'refusal' ? 'refusal' : 'text']);
    else {
      requireValue(!current.done && !current.partDone); const delta = string(event.delta);
      current.value += delta; current.delta = true;
      if (name === 'output_text') partialText += delta;
    }
  }
  return { add, get response() { return terminal; }, get terminalType() { return terminalType; },
    get partialText() { return partialText; }, get streamError() { return streamError; },
    // Retain aggregation for safety checks even if EOF/reset arrives before a terminal.
    get sensitiveValues() { return [...items.values()].flatMap(item => [...item.fields].flatMap(([key, field]) =>
      key === 'arguments' ? [field.value, decodedArguments(field.value)] : [field.value])); } };
}

/** Non-completed records remain evidence; only a complete, understood native result can be replayed. */
export function validateResponsesNative(value: unknown, tools?: ModelTool[]): void {
  try {
    const native = object(value);
    requireValue(native.formatVersion === 1 && native.sdk === 'openai@7.42.0' && native.adapter === 'xunjie-responses-native-v1');
    requireValue(Buffer.byteLength(JSON.stringify(value)) <= 8_000_000);
    const assembler = createResponsesAssembler();
    for (const event of array(native.events)) assembler.add(event);
    requireValue(assembler.terminalType === 'response.completed');
    same(assembler.response, native.response);
    const result = responsesOutput(native.response, tools);
    same(result.output, native.output); requireValue(!result.refused);
  } catch { throw new StorageError('corrupt'); }
}
