import Anthropic from '@anthropic-ai/sdk';
import { StorageError } from '@xunjie/storage';
import type { ModelConfiguration, ModelTool, ModelToolIntent, ModelUpstream } from '@xunjie/contracts/model-connections';
import { createMessagesAssembler, messagesUsage, messagesOutput, validateMessagesNative } from './messages-native.js';
import { compileOutputSchema } from './chat-native.js';
export { validateMessagesNative } from './messages-native.js';

export const messagesSdkVersion = '@anthropic-ai/sdk@1.1.0';
export const messagesAdapterVersion = 'xunjie-messages-native-v1';
export type MessagesPayload = Anthropic.MessageCreateParamsStreaming;
export const unsupportedMessagesRoute = (configuration: ModelConfiguration) => configuration.protocol === 'messages'
  && configuration.baseUrl.replace(/\/$/, '') + configuration.path === 'https://api.commandcode.ai/provider/v1/messages'
  && configuration.modelId === 'deepseek/deepseek-v4.1-flash';
export function messagesCheckPayload(configuration: ModelConfiguration, tokens: number): MessagesPayload {
  return { model: configuration.modelId, max_tokens: tokens, stream: true,
    messages: [{ role: 'user', content: 'Reply briefly with OK to check this model connection.' }],
    ...(configuration.dialect === 'deepseek' ? { thinking: configuration.parameterMode === 'thinking'
      ? { type: 'enabled' as const, budget_tokens: 1024 } : { type: 'disabled' as const } } : {}) };
}
export async function runMessages(configuration: ModelConfiguration, apiKey: string, payload: MessagesPayload,
  signal: AbortSignal, timeoutMs: number, nativeTools: ModelTool[] = [], applicationSchema?: Record<string, unknown>) {
  let limited = false, upstream: ModelUpstream | undefined;
  const responseFacts = (status: number, headers: Headers): ModelUpstream => {
    const facts: ModelUpstream = { httpStatus: status };
    const id = headers.get('request-id') ?? headers.get('x-request-id');
    if (id && /^[A-Za-z0-9._:-]{1,200}$/.test(id) && (!apiKey || !id.includes(apiKey))) facts.requestId = id;
    const retry = headers.get('retry-after'), milliseconds = headers.get('retry-after-ms');
    const numeric = retry && /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry)
      : !retry && milliseconds && /^\d+(?:\.\d+)?$/.test(milliseconds) ? Number(milliseconds) / 1000 : undefined;
    if (numeric !== undefined && Number.isFinite(numeric) && numeric <= 31536000) facts.retryAfterSeconds = numeric;
    else if (retry && /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(retry) && Number.isFinite(Date.parse(retry)))
      facts.retryAt = new Date(retry).toISOString();
    return facts;
  };
  const client = new Anthropic({ apiKey, baseURL: configuration.baseUrl.replace(/\/$/, ''), maxRetries: 0,
    timeout: timeoutMs, logLevel: 'off', fetchOptions: { redirect: 'error' },
    ...(configuration.dialect === 'deepseek' ? { defaultHeaders: { 'anthropic-version': '2023-06-01' } } : {}),
    fetch: async (input, init) => {
      const response = await fetch(input, init); upstream = responseFacts(response.status, response.headers); if (!response.body) return response;
      let received = 0;
      return new Response(response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > 2_000_000) { limited = true; controller.error(new Error('response-limit')); } else controller.enqueue(chunk);
      } })), { status: response.status, statusText: response.statusText, headers: response.headers });
    } });
  const events: unknown[] = [], assembler = createMessagesAssembler();
  const deadline = AbortSignal.timeout(timeoutMs), requestSignal = AbortSignal.any([signal, deadline]);
  let state: 'completed' | 'incomplete' | 'failed' | 'unknown' | 'cancelled' = 'incomplete', reason = 'missing-terminal';
  try {
    // Raw SDK events, with bounded explicit aggregation. No SDK multi-turn/tool helpers.
    // In SDK 1.1.0 MessageStream overwrites each signature_delta; we preserve all fragments.
    const stream = await client.messages.create(payload, { signal: requestSignal });
    for await (const event of stream) { events.push(structuredClone(event)); assembler.add(event); }
  } catch (error) {
    const status = (error instanceof Anthropic.APIError ? error.status : undefined)
      ?? (upstream?.httpStatus && upstream.httpStatus >= 400 ? upstream.httpStatus : undefined);
    if (!upstream && status && error instanceof Anthropic.APIError) upstream = responseFacts(status, error.headers ?? new Headers());
    const malformed = error instanceof StorageError || error instanceof SyntaxError;
    const confirmedStreamError = error instanceof Anthropic.APIError && !(error instanceof Anthropic.APIConnectionError)
      && !(error instanceof Anthropic.APIUserAbortError);
    const type = error instanceof Anthropic.APIError && error.error && typeof error.error === 'object'
      ? JSON.stringify(error.error) : '';
    const unsupported = /unsupported_model|model_not_supported|model_not_found|unsupported_parameter|unsupported_value/.test(type);
    state = malformed || status || confirmedStreamError ? 'failed'
      : signal.aborted ? 'cancelled' : events.length ? 'incomplete' : 'unknown';
    reason = malformed ? 'malformed-response' : status === 401 || status === 403 ? 'authentication'
      : status === 429 ? 'rate-limited' : unsupported ? 'upstream-unsupported' : status ? 'upstream-http'
      : confirmedStreamError ? 'upstream-stream-error' : signal.aborted ? 'client-abort'
      : deadline.aborted || error instanceof Anthropic.APIConnectionTimeoutError ? 'upstream-timeout' : 'upstream-stream';
  }
  const message = assembler.message;
  const counters = configuration.dialect === 'deepseek' && assembler.finalUsage ? assembler.finalUsage : message?.usage ?? {};
  let text = assembler.text, usage = messagesUsage(counters, assembler.terminal && assembler.finalUsage?.output_tokens !== undefined), toolIntents: ModelToolIntent[] = [];
  if (state !== 'failed' && assembler.terminal) {
    reason = String(message?.stop_reason);
    state = ['end_turn', 'tool_use', 'stop_sequence'].includes(reason) ? 'completed' : reason === 'refusal' ? 'failed' : 'incomplete';
    if (state === 'completed') try { const result = messagesOutput(message, nativeTools); toolIntents = result.intents; }
    catch { state = 'failed'; reason = 'invalid-native-result'; }
  } else if (state !== 'failed' && signal.aborted) { state = 'cancelled'; reason = 'client-abort'; }
  if (limited) { state = 'incomplete'; reason = 'response-limit'; }
  if (state === 'completed' && (payload.tool_choice?.type === 'none' && toolIntents.length
    || payload.tool_choice?.type === 'tool' && (toolIntents.length !== 1 || toolIntents[0]?.name !== payload.tool_choice.name))) {
    state = 'failed'; reason = 'tool-choice-not-honored';
  }
  const format = payload.output_config?.format;
  if (state === 'completed' && !toolIntents.length && (applicationSchema || format)) try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || applicationSchema && !compileOutputSchema(applicationSchema)(value)
      || format && !compileOutputSchema(format.schema)(value)) throw new Error();
  } catch { state = 'failed'; reason = 'invalid-structured-output'; }
  let native: { formatVersion: number; sdk: string; adapter: string; events: unknown[]; message: typeof message; redacted?: boolean; upstream?: ModelUpstream }
    = { formatVersion: 1, sdk: messagesSdkVersion, adapter: messagesAdapterVersion, events, message, ...(upstream ? { upstream } : {}) };
  const fields = new Map<string, string>();
  const clean = (value: string) => apiKey ? value.split(apiKey).join('[redacted]') : value;
  function redact(value: unknown, field = ''): unknown {
    if (typeof value === 'string') { fields.set(field, (fields.get(field) ?? '') + value); return clean(value); }
    if (Array.isArray(value)) return value.map(item => redact(item, field));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [clean(key), redact(item, key)]));
    return value;
  }
  const safe = redact(native);
  if (JSON.stringify(safe) !== JSON.stringify(native) || [...fields.values()].some(value => clean(value) !== value)) {
    if (state === 'completed') { state = 'failed'; reason = 'credential-in-output'; }
    native = { ...native, events: [], message: null, redacted: true };
  }
  if (state === 'completed') try { validateMessagesNative(native, nativeTools); }
  catch { state = 'failed'; reason = 'invalid-native-result'; }
  return { state, reason, text: clean(text), usage, toolIntents: state === 'completed' ? toolIntents : [], native, ...(upstream ? { upstream } : {}) };
}
