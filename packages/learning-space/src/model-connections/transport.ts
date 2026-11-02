import { StorageError } from '@xunjie/storage';
import type { ModelConfiguration } from '@xunjie/contracts/model-connections';
import { checkPayload, runChat, type ChatPayload } from './chat.js';
import { responsesCheckPayload, runResponses, type ResponsesPayload } from './responses.js';

export type NativePayload = ChatPayload | ResponsesPayload;
export function adapterReady(configuration: ModelConfiguration) {
  return ['chat-completions', 'responses'].includes(configuration.protocol)
    && (configuration.parameterMode === 'plain' || configuration.dialect === 'deepseek');
}
export function connectionCheckPayload(configuration: ModelConfiguration, tokens: number): NativePayload {
  if (configuration.protocol === 'responses') return responsesCheckPayload(configuration, tokens);
  if (configuration.protocol === 'chat-completions') return checkPayload(configuration, tokens);
  throw new StorageError('unavailable');
}
export function limitPayload(configuration: ModelConfiguration, payload: NativePayload, tokens: number): NativePayload {
  return configuration.protocol === 'responses' ? { ...payload as ResponsesPayload, max_output_tokens: tokens }
    : { ...payload as ChatPayload, max_tokens: tokens };
}
export async function runModel(configuration: ModelConfiguration, apiKey: string, payload: NativePayload,
  signal: AbortSignal, timeoutMs: number, segment: boolean, applicationSchema?: Record<string, unknown>) {
  if (configuration.protocol === 'responses') {
    const request = payload as ResponsesPayload;
    const tools = segment ? request.tools?.map(tool => {
      if (tool.type !== 'function') throw new StorageError('corrupt');
      return { name: tool.name, description: tool.description ?? '', inputSchema: tool.parameters ?? {} };
    }) ?? [] : undefined;
    return runResponses(configuration, apiKey, request, signal, timeoutMs, tools, applicationSchema);
  }
  if (configuration.protocol !== 'chat-completions') throw new StorageError('unavailable');
  const request = payload as ChatPayload;
  const tools = segment ? request.tools?.map(tool => {
    if (tool.type !== 'function') throw new StorageError('corrupt');
    return { name: tool.function.name, description: tool.function.description ?? '', inputSchema: tool.function.parameters ?? {} };
  }) ?? [] : undefined;
  return runChat(configuration, apiKey, request, signal, timeoutMs, tools, applicationSchema);
}
