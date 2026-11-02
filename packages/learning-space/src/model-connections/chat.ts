import OpenAI from 'openai';
import type { ModelConfiguration, ModelUsage } from '@xunjie/contracts/model-connections';
import { modelUsageSchema } from '@xunjie/contracts/model-connections';

export const chatAdapterVersion = 'xunjie-chat-text-v1';
export const sdkVersion = 'openai@7.42.0';
class MalformedResponse extends Error {}
export function checkPayload(configuration: ModelConfiguration, maxOutputTokens: number) {
  return { model: configuration.modelId, messages: [{ role: 'user' as const, content: 'Reply briefly with OK to check this model connection.' }],
    max_tokens: maxOutputTokens, stream: true as const, stream_options: { include_usage: true },
    ...(configuration.dialect === 'deepseek' ? { thinking: { type: configuration.parameterMode === 'thinking' ? 'enabled' : 'disabled' } } : {}) };
}
export async function runChat(configuration: ModelConfiguration, apiKey: string, payload: ReturnType<typeof checkPayload>,
  signal: AbortSignal, timeoutMs: number) {
  const clean = (value: string) => apiKey ? value.split(apiKey).join('[redacted]') : value;
  const chunks: unknown[] = [];
  let text = '', finishReason: string | null = null, bytes = 0, usage: ModelUsage = { state: 'unknown' };
  let upstreamError: unknown = null;
  let reason = 'missing-terminal', state: 'completed' | 'incomplete' | 'failed' | 'unknown' | 'cancelled' = 'incomplete';
  const client = new OpenAI({ apiKey, baseURL: configuration.baseUrl.replace(/\/$/, ''), maxRetries: 0, timeout: timeoutMs,
    fetchOptions: { redirect: 'error' } });
  try {
    const stream = await client.chat.completions.create(payload, { signal });
    for await (const value of stream) {
      const encoded = clean(JSON.stringify(value));
      bytes += Buffer.byteLength(encoded);
      if (bytes > 2_000_000) { stream.controller.abort(); reason = 'response-limit'; break; }
      chunks.push(JSON.parse(encoded));
      if (!Array.isArray(value.choices)) throw new MalformedResponse();
      const choice = value.choices.find(item => item.index === 0);
      if (choice && (!choice.delta || choice.delta.content != null && typeof choice.delta.content !== 'string'
        || choice.finish_reason != null && typeof choice.finish_reason !== 'string')) throw new MalformedResponse();
      if (choice?.delta.content) text += clean(choice.delta.content);
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (value.usage) {
        const native = value.usage;
        if ([native.prompt_tokens, native.completion_tokens, native.total_tokens, native.prompt_tokens_details?.cached_tokens,
          native.completion_tokens_details?.reasoning_tokens].some(value => value != null && (!Number.isSafeInteger(value) || value < 0)))
          throw new MalformedResponse();
        const parsed = modelUsageSchema.safeParse({ state: 'partial',
          ...(typeof native.prompt_tokens === 'number' ? { inputTokens: native.prompt_tokens } : {}),
          ...(typeof native.completion_tokens === 'number' ? { outputTokens: native.completion_tokens } : {}),
          ...(typeof native.total_tokens === 'number' ? { totalTokens: native.total_tokens } : {}),
          ...(typeof native.prompt_tokens_details?.cached_tokens === 'number' ? { cachedTokens: native.prompt_tokens_details.cached_tokens } : {}),
          ...(typeof native.completion_tokens_details?.reasoning_tokens === 'number' ? { reasoningTokens: native.completion_tokens_details.reasoning_tokens } : {}) });
        if (!parsed.success) throw new MalformedResponse();
        usage = Object.keys(parsed.data).length > 1 ? parsed.data : { state: 'unknown' };
      }
    }
    if (reason !== 'response-limit') {
      reason = finishReason ?? 'missing-terminal';
      state = finishReason === 'stop' ? 'completed' : 'incomplete';
      if (state === 'completed' && usage.inputTokens !== undefined && usage.outputTokens !== undefined && usage.totalTokens !== undefined)
        usage = { ...usage, state: 'final' };
    }
  } catch (error) {
    const status = error instanceof OpenAI.APIError ? error.status : undefined;
    const unsupported = error instanceof OpenAI.APIError && ['unsupported_model', 'model_not_supported', 'model_not_found',
      'unsupported_parameter', 'unsupported_value'].includes(error.code ?? '');
    if (error instanceof OpenAI.APIError && error.error) upstreamError = JSON.parse(clean(JSON.stringify(error.error)));
    reason = error instanceof MalformedResponse ? 'malformed-response' : signal.aborted ? 'client-abort' : status === 401 || status === 403 ? 'authentication'
      : status === 429 ? 'rate-limited' : unsupported ? 'upstream-unsupported' : status ? 'upstream-http' : 'upstream-stream';
    state = error instanceof MalformedResponse ? 'failed' : signal.aborted ? 'cancelled' : status || upstreamError ? 'failed' : chunks.length ? 'incomplete' : 'unknown';
  }
  // The SDK may end its iterator cleanly after abort rather than throwing.
  // A terminal response already received still wins a later cancellation race.
  if (signal.aborted && finishReason !== 'stop') { state = 'cancelled'; reason = 'client-abort'; }
  return { state, reason, text: clean(text), usage, native: { formatVersion: 1, sdk: sdkVersion, adapter: chatAdapterVersion, chunks, finishReason, upstreamError } };
}
