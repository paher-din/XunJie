import { createRequire } from "node:module";
import type { ModelUsage } from "../../contracts/tutoring/index.ts";
import type { DeepSeekInvoker, ProviderResponse } from "./providers.ts";
import { createDeepSeekProvider, type ModelProvider } from "./providers.ts";
import { getTutoringOutputSchema } from "./schemas.ts";

type SdkUsage = { inputTokens: number | undefined; outputTokens: number | undefined };
type SdkStructuredOutputError = Error & { text?: string; usage: SdkUsage };
type DeepSeekFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const require = createRequire(import.meta.url);
const { createDeepSeek } = require("@ai-sdk/deepseek") as {
  createDeepSeek(options: {
    apiKey: string;
    baseURL?: string;
    fetch?: DeepSeekFetch;
  }): (model: string) => unknown;
};
const { generateText, NoObjectGeneratedError, Output } = require("ai") as {
  generateText(options: Record<string, unknown>): Promise<{ output: unknown; usage: SdkUsage }>;
  NoObjectGeneratedError: {
    isInstance(error: unknown): error is SdkStructuredOutputError;
  };
  Output: {
    object(options: { schema: unknown; name: string; description: string }): unknown;
  };
};

export type AiSdkDeepSeekInvokerOptions = {
  apiKey: string;
  baseURL?: string;
  fetch?: DeepSeekFetch;
};

export function createAiSdkDeepSeekInvoker(options: AiSdkDeepSeekInvokerOptions): DeepSeekInvoker {
  if (!options.apiKey.trim()) {
    throw new Error("DeepSeek API key is required");
  }
  const provider = createDeepSeek({
    apiKey: options.apiKey,
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });

  return async (request) => {
    const schema = getTutoringOutputSchema(request.schemaKind);
    try {
      const result = await generateText({
        model: provider(request.model),
        system: request.system,
        prompt: request.prompt,
        output: Output.object({
          schema,
          name: request.schemaKind,
          description: "A validated XunJie tutoring proposal body without tools or side effects.",
        }),
        maxRetries: request.maxRetries,
        maxOutputTokens: request.maxOutputTokens,
        providerOptions: request.providerOptions,
        abortSignal: request.abortSignal,
        timeout: request.timeoutMs,
      });
      const usage = toModelUsage(result.usage);
      return {
        body: result.output,
        ...(usage === undefined ? {} : { usage }),
      };
    } catch (error) {
      if (!NoObjectGeneratedError.isInstance(error)) throw error;
      const body = parseInvalidStructuredBody(error.text);
      if (body === undefined) throw error;
      const usage = toModelUsage(error.usage);
      return {
        body,
        ...(usage === undefined ? {} : { usage }),
      } satisfies ProviderResponse;
    }
  };
}

export function createAiSdkDeepSeekProvider(options: AiSdkDeepSeekInvokerOptions): ModelProvider {
  return createDeepSeekProvider({ invoke: createAiSdkDeepSeekInvoker(options) });
}

function parseInvalidStructuredBody(text: string | undefined): unknown | undefined {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function toModelUsage(usage: {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
}): Extract<ModelUsage, { status: "actual" }> | undefined {
  if (!Number.isSafeInteger(usage.inputTokens) || !Number.isSafeInteger(usage.outputTokens)) {
    return undefined;
  }
  return {
    status: "actual",
    inputTokens: usage.inputTokens as number,
    outputTokens: usage.outputTokens as number,
  };
}
