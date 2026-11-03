import { isDeepStrictEqual } from 'node:util';
import { StorageError } from '@xunjie/storage';
import type { ModelTool, ModelToolIntent, ModelUsage } from '@xunjie/contracts/model-connections';
import { modelToolIntentSchema } from '@xunjie/contracts/model-connections';
import { toolValidators } from './chat-native.js';
import { protocolJsonStrings } from './sensitive-output.js';

type ObjectValue = Record<string, unknown>;
const requireValue = (value: unknown): void => { if (!value) throw new StorageError('corrupt'); };
function object(value: unknown): ObjectValue {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value)); return value as ObjectValue;
}
function string(value: unknown): string { requireValue(typeof value === 'string'); return value as string; }
export function messagesUsage(value: unknown, final: boolean): ModelUsage {
  const native = object(value), usage: ModelUsage = { state: 'partial' };
  for (const [key, target] of [['input_tokens', 'inputTokens'], ['output_tokens', 'outputTokens'], ['cache_read_input_tokens', 'cachedTokens']] as const) {
    if (native[key] == null) continue;
    requireValue(Number.isSafeInteger(native[key]) && (native[key] as number) >= 0); usage[target] = native[key] as number;
  }
  // Messages has no total_tokens field. Do not invent a total or assume omitted cache counters are zero.
  if (usage.inputTokens !== undefined && usage.outputTokens !== undefined && final) usage.state = 'final';
  return Object.keys(usage).length === 1 ? { state: 'unknown' } : usage;
}
export function createMessagesAssembler() {
  let message: ObjectValue | null = null, terminal = false, delta = false, finalUsage: ObjectValue | null = null;
  const blocks = new Map<number, { content: ObjectValue; input: string; inputDelta: boolean; stopped: boolean }>();
  const content = () => [...blocks.values()].map(block => block.content);
  const snapshot = (): ObjectValue | null => message ? { ...message, content: content() } : null;
  function add(value: unknown) {
    const event = object(value), type = string(event.type);
    requireValue(!terminal);
    if (type === 'ping') return;
    if (type === 'message_start') {
      requireValue(!message); const start = object(event.message);
      requireValue(start.type === 'message' && start.role === 'assistant' && string(start.id).length && typeof start.model === 'string'
        && Array.isArray(start.content) && start.content.length === 0 && start.stop_reason === null);
      messagesUsage(start.usage, false); message = structuredClone(start); return;
    }
    requireValue(message);
    if (type === 'message_delta') {
      const next = object(event.delta), usage = object(event.usage);
      requireValue((blocks.size > 0 || next.stop_reason === 'end_turn') && [...blocks.values()].every(block => block.stopped));
      requireValue(['end_turn', 'tool_use', 'max_tokens', 'stop_sequence', 'refusal', 'pause_turn', 'model_context_window_exceeded'].includes(string(next.stop_reason)));
      requireValue(next.stop_sequence === null || typeof next.stop_sequence === 'string');
      requireValue(!delta || message!.stop_reason === next.stop_reason);
      const candidate = { ...message!, ...structuredClone(next), usage: { ...object(message!.usage), ...structuredClone(usage) } };
      messagesUsage(candidate.usage, false); message = candidate; finalUsage = structuredClone(usage); delta = true; return;
    }
    if (type === 'message_stop') {
      requireValue(delta && [...blocks.values()].every(block => block.stopped)); terminal = true; return;
    }
    requireValue(!delta && Number.isSafeInteger(event.index) && (event.index as number) >= 0 && (event.index as number) < 64);
    const index = event.index as number;
    if (type === 'content_block_start') {
      requireValue(index === blocks.size); const part = structuredClone(object(event.content_block));
      requireValue(['text', 'thinking', 'tool_use'].includes(string(part.type)));
      if (part.type === 'text') { string(part.text); requireValue(part.citations == null || Array.isArray(part.citations) && part.citations.length === 0); }
      else if (part.type === 'thinking') {
        requireValue(typeof part.thinking === 'string' || part.thinking === null);
        requireValue(typeof part.signature === 'string' || part.signature === null || part.signature === undefined);
      } else { requireValue(string(part.id).length && string(part.name).length); object(part.input); }
      blocks.set(index, { content: part, input: '', inputDelta: false, stopped: false }); return;
    }
    const block = blocks.get(index); requireValue(block && !block.stopped);
    if (!block) throw new StorageError('corrupt');
    if (type === 'content_block_stop') {
      if (block.inputDelta) {
        // max_tokens can end a tool block in the middle of its JSON. Keep reading
        // the message terminal and usage; only successful publication requires an object.
        try { block.content.input = JSON.parse(block.input) as unknown; }
        catch { block.content.input = block.input; }
      }
      block.stopped = true; return;
    }
    requireValue(type === 'content_block_delta'); const change = object(event.delta);
    if (change.type === 'input_json_delta') {
      requireValue(block.content.type === 'tool_use' && (block.inputDelta || Object.keys(object(block.content.input)).length === 0));
      block.input += string(change.partial_json); block.inputDelta = true;
    } else {
      const field = change.type === 'text_delta' ? 'text' : change.type === 'thinking_delta' ? 'thinking' : change.type === 'signature_delta' ? 'signature' : '';
      requireValue(field && block.content.type === (field === 'text' ? 'text' : 'thinking'));
      const initial = block.content[field];
      requireValue(typeof initial === 'string' || block.content.type === 'thinking' && initial == null);
      block.content[field] = (initial ?? '') + string(change[field]);
    }
  }
  return { add, get message() { return snapshot(); }, get terminal() { return terminal; }, get finalUsage() { return finalUsage; },
    get inputJson() { return [...blocks.values()].filter(block => block.inputDelta).map(block => block.input); },
    get inputStrings() { return [...blocks.values()].filter(block => block.inputDelta).flatMap(block => protocolJsonStrings(block.input)); },
    get text() { return content().flatMap(part => part.type === 'text' ? [string(part.text)] : []).join(''); } };
}
export function messagesOutput(messageValue: unknown, tools: ModelTool[]) {
  const message = object(messageValue), validators = toolValidators(tools), intents: ModelToolIntent[] = [];
  requireValue(Array.isArray(message.content)); let text = '';
  for (const value of message.content as unknown[]) {
    const part = object(value);
    if (part.type === 'text') text += string(part.text);
    else if (part.type === 'thinking') {
      requireValue(typeof part.thinking === 'string' || part.thinking === null);
      requireValue(typeof part.signature === 'string' || part.signature === null);
    } else {
      requireValue(part.type === 'tool_use'); const id = string(part.id), name = string(part.name), args = object(part.input);
      const validate = validators.get(name);
      requireValue(id.length && validate && validate(args) && !intents.some(intent => intent.callId === id));
      intents.push(modelToolIntentSchema.parse({ callId: id, name, arguments: args }));
    }
  }
  requireValue(intents.length <= 8 && (message.stop_reason === 'tool_use' ? intents.length > 0 : intents.length === 0));
  return { text, intents, usage: messagesUsage(message.usage, true) };
}
export function validateMessagesNative(value: unknown, tools: ModelTool[]) {
  const native = object(value);
  requireValue(native.formatVersion === 1 && native.sdk === '@anthropic-ai/sdk@1.1.0' && native.adapter === 'xunjie-messages-native-v1' && Array.isArray(native.events));
  const assembler = createMessagesAssembler();
  for (const event of native.events as unknown[]) assembler.add(event);
  requireValue(assembler.terminal && isDeepStrictEqual(assembler.message, native.message));
  const message = object(native.message); requireValue(['end_turn', 'tool_use', 'stop_sequence'].includes(string(message.stop_reason)));
  return messagesOutput(message, tools);
}
