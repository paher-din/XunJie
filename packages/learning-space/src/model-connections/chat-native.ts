import { Ajv, type ValidateFunction } from 'ajv';
import { Ajv2019 } from 'ajv/dist/2019.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { StorageError } from '@xunjie/storage';
import type { ModelTool, ModelToolIntent } from '@xunjie/contracts/model-connections';
import { modelToolIntentSchema } from '@xunjie/contracts/model-connections';
import { protocolJsonStrings } from './sensitive-output.js';

export type NativeChatAssistant = { role: 'assistant'; content: string | null; reasoning_content?: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]; [field: string]: unknown };
export function compileOutputSchema(schema: Record<string, unknown>) {
  function check(value: unknown, depth = 0) {
    if (depth > 32) throw new StorageError('invalid');
    if (Array.isArray(value)) { for (const item of value) check(item, depth + 1); }
    else if (value !== null && typeof value === 'object') for (const item of Object.values(value)) check(item, depth + 1);
  }
  if (Buffer.byteLength(JSON.stringify(schema)) > 16000) throw new StorageError('invalid'); check(schema);
  try {
    // Compile synchronously: local references and regex are JSON Schema, while unresolved
    // external references fail here without fetching anything. Never mutate model inputs.
    const Validator = schema.$schema === 'https://json-schema.org/draft/2020-12/schema' ? Ajv2020
      : schema.$schema === 'https://json-schema.org/draft/2019-09/schema' ? Ajv2019 : Ajv;
    const validate = new Validator({ strict: true, strictTypes: false, strictTuples: false, strictRequired: false,
      allowMatchingProperties: true, allErrors: false }).compile(schema);
    if ('$async' in validate && validate.$async) throw new StorageError('invalid');
    return validate;
  } catch { throw new StorageError('invalid'); }
}
export function toolValidators(tools: ModelTool[]) {
  if (new Set(tools.map(tool => tool.name)).size !== tools.length || Buffer.byteLength(JSON.stringify(tools)) > 24000) throw new StorageError('invalid');
  const compiled = new Map<string, ValidateFunction>();
  for (const tool of tools) {
    if (tool.inputSchema.type !== 'object') throw new StorageError('invalid');
    compiled.set(tool.name, compileOutputSchema(tool.inputSchema));
  }
  return compiled;
}

/** Inspect protocol fields even in the final chunk rejected by the assembler. */
export function chatSensitiveValues(chunks: unknown[], structuredText = false) {
  const fields = new Map<string, string>(), decoded: unknown[] = [];
  const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  function append(key: string, value: unknown, json = false) {
    if (typeof value !== 'string') return;
    fields.set(key, (fields.get(key) ?? '') + value);
    if (json) decoded.push(protocolJsonStrings(value));
  }
  for (const chunk of chunks) {
    const choices = record(chunk).choices;
    for (const value of Array.isArray(choices) ? choices : []) {
      const choice = record(value), delta = record(choice.delta), prefix = String(choice.index);
      for (const [key, part] of Object.entries(delta)) append(`${prefix}:${key}`, part, structuredText && key === 'content');
      for (const value of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        const tool = record(value), fn = record(tool.function), key = `${prefix}:tool:${String(tool.index)}`;
        append(`${key}:name`, fn.name); append(`${key}:arguments`, fn.arguments, true);
      }
      for (const value of Array.isArray(delta.reasoning_details) ? delta.reasoning_details : []) {
        const detail = record(value); append(`${prefix}:detail:${String(detail.index)}`, detail.text);
      }
    }
  }
  for (const [key, value] of fields) if (key.endsWith(':arguments') || structuredText && key.endsWith(':content')) {
    decoded.push(protocolJsonStrings(value));
  }
  return [...fields.values(), ...decoded];
}
export function createChatAssembler(dialect: string) {
  type ReasoningText = { type: 'reasoning.text'; text: string; format: string; index: number };
  const choices = new Map<number, { assistant: NativeChatAssistant; tools: Map<number, NonNullable<NativeChatAssistant['tool_calls']>[number]>;
    details: Map<number, ReasoningText>; finish: string | null }>();
  let unsupported = false;
  function add(value: unknown) {
    const chunk = value as { choices?: { index: number; delta: Record<string, unknown>; finish_reason?: string | null }[] };
    if (!Array.isArray(chunk.choices)) throw new StorageError('invalid');
    for (const choice of chunk.choices) {
      if (!Number.isSafeInteger(choice.index) || choice.index < 0 || choice.index > 7 || !choice.delta || typeof choice.delta !== 'object'
        || choice.finish_reason != null && typeof choice.finish_reason !== 'string') throw new StorageError('invalid');
      let current = choices.get(choice.index);
      if (!current) { current = { assistant: { role: 'assistant', content: null }, tools: new Map(), details: new Map(), finish: null }; choices.set(choice.index, current); }
      if (current.finish && (Object.keys(choice.delta).length || choice.finish_reason)) throw new StorageError('invalid');
      for (const [key, part] of Object.entries(choice.delta)) {
        if (!['role', 'content', 'reasoning_content', 'refusal', 'tool_calls'].includes(key)
          && !(dialect === 'command-code' && ['reasoning', 'reasoning_details'].includes(key))) unsupported = true;
        if (key === 'reasoning_details' && dialect === 'command-code' && Array.isArray(part)) {
          current.assistant.reasoning_details ??= [];
          for (const item of part as ReasoningText[]) {
            if (!item || !Number.isSafeInteger(item.index) || item.index < 0 || item.index > 7 || item.type !== 'reasoning.text'
              || typeof item.text !== 'string' || typeof item.format !== 'string'
              || Object.keys(item).some(key => !['type', 'text', 'format', 'index'].includes(key))) { unsupported = true; continue; }
            const previous = current.details.get(item.index);
            if (previous && previous.format !== item.format) throw new StorageError('invalid');
            current.details.set(item.index, { ...item, text: (previous?.text ?? '') + item.text });
          }
        } else if (key === 'tool_calls') {
          if (!Array.isArray(part)) throw new StorageError('invalid');
          for (const item of part as { index: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }[]) {
            if (!Number.isSafeInteger(item.index) || item.index < 0 || item.index > 7 || item.type && item.type !== 'function') throw new StorageError('invalid');
            if (item.id !== undefined && typeof item.id !== 'string' || item.function?.name !== undefined && typeof item.function.name !== 'string'
              || item.function?.arguments !== undefined && typeof item.function.arguments !== 'string') throw new StorageError('invalid');
            const tool = current.tools.get(item.index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
            if (!current.tools.has(item.index) && (item.type !== 'function' || !item.id)) throw new StorageError('invalid');
            if (item.id) { if (tool.id && tool.id !== item.id) throw new StorageError('invalid'); tool.id = item.id; }
            if (item.function?.name !== undefined) tool.function.name += item.function.name;
            if (item.function?.arguments !== undefined) tool.function.arguments += item.function.arguments;
            current.tools.set(item.index, tool);
          }
        } else if (key === 'role') { if (part !== 'assistant') throw new StorageError('invalid'); }
        else if (typeof part === 'string') current.assistant[key] = (typeof current.assistant[key] === 'string' ? current.assistant[key] : '') + part;
        else if (part === null) { if (!(key in current.assistant)) current.assistant[key] = null; }
        else { current.assistant[key] = structuredClone(part); unsupported = true; }
      }
      if (choice.finish_reason) current.finish = choice.finish_reason;
    }
  }
  function result(tools: ModelTool[]) {
    const all = [...choices].sort(([a], [b]) => a - b).map(([index, choice]) => ({ index, finishReason: choice.finish,
      assistant: { ...choice.assistant, ...(choice.details.size ? { reasoning_details: [...choice.details].sort(([a], [b]) => a - b).map(([, value]) => value) } : {}),
        ...(choice.tools.size ? { tool_calls: [...choice.tools].sort(([a], [b]) => a - b).map(([, value]) => value) } : {}) } as NativeChatAssistant }));
    const primary = all.find(choice => choice.index === 0);
    const assistant = primary?.assistant;
    const intents: ModelToolIntent[] = [];
    const decodedArguments: unknown[] = [];
    // Decode only the protocol's function.arguments field, including incomplete results
    // and non-primary choices. Schema failures must not hide an escaped credential.
    for (const choice of all) for (const tool of choice.assistant.tool_calls ?? []) {
      try { decodedArguments.push(JSON.parse(tool.function.arguments)); } catch { /* Partial JSON remains raw evidence. */ }
    }
    let valid = !unsupported && all.length === 1 && !!primary && !!assistant;
    if (primary && [...choices.get(0)!.tools.keys()].sort((a, b) => a - b).some((index, position) => index !== position)) valid = false;
    if (valid && primary!.finishReason === 'tool_calls') {
      const validators = toolValidators(tools), ids = new Set<string>();
      if (!assistant!.tool_calls?.length) valid = false;
      for (const tool of assistant!.tool_calls ?? []) {
        try {
          const args: unknown = JSON.parse(tool.function.arguments), validate = validators.get(tool.function.name);
          if (!tool.id || ids.has(tool.id) || !validate || !validate(args)) { valid = false; continue; }
          ids.add(tool.id); intents.push(modelToolIntentSchema.parse({ callId: tool.id, name: tool.function.name, arguments: args }));
        } catch { valid = false; }
      }
    } else if (assistant?.tool_calls?.length) valid = false;
    return { valid, choices: all, assistant, decodedArguments, intents: valid ? intents : [] };
  }
  return { add, result };
}
