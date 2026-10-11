import type { ModelUsage, TutoringPurpose } from "../../contracts/tutoring/index.ts";

export type ProviderRequest = {
  purpose: TutoringPurpose;
  systemPolicy: string;
  untrustedInput: unknown;
  repair: boolean;
  remainingMs: number;
  signal: AbortSignal;
};

export type ProviderResponse = {
  body: unknown;
  usage?: Extract<ModelUsage, { status: "actual" }>;
  needsAnotherCall?: boolean;
};

export type ModelProvider = {
  generate(request: ProviderRequest): Promise<ProviderResponse>;
};

export type SyntheticStep =
  | ProviderResponse
  | Error
  | ((request: ProviderRequest) => ProviderResponse | Promise<ProviderResponse>);

export class SyntheticProvider implements ModelProvider {
  readonly calls: ProviderRequest[] = [];
  readonly #steps: SyntheticStep[];

  constructor(steps: readonly SyntheticStep[]) {
    this.#steps = [...steps];
  }

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    this.calls.push(request);
    const step = this.#steps.shift();
    if (step === undefined) {
      throw new Error("Synthetic provider has no configured response");
    }
    if (step instanceof Error) {
      throw step;
    }
    return typeof step === "function" ? await step(request) : step;
  }
}
export type DeepSeekInvocation = {
  model: "deepseek-flash";
  maxRetries: 0;
  maxOutputTokens: 4096;
  providerOptions: {
    deepseek: {
      thinking: { type: "disabled" };
    };
  };
  purpose: TutoringPurpose;
  systemPolicy: string;
  untrustedInput: unknown;
  abortSignal: AbortSignal;
  timeoutMs: number;
};

export type DeepSeekInvoker = (request: DeepSeekInvocation) => Promise<ProviderResponse>;
export type TokenCounter = (value: string) => number;

export function createDeepSeekProvider(options: {
  invoke: DeepSeekInvoker;
  countTokens: TokenCounter;
}): ModelProvider {
  return {
    async generate(request) {
      const inputTokens = options.countTokens(
        JSON.stringify({
          systemPolicy: request.systemPolicy,
          untrustedInput: request.untrustedInput,
        }),
      );
      if (!Number.isSafeInteger(inputTokens) || inputTokens < 0) {
        throw new Error("Token counter returned an invalid value");
      }
      if (inputTokens > 16_000) {
        throw new InputLimitError(inputTokens);
      }
      return options.invoke({
        model: "deepseek-flash",
        maxRetries: 0,
        maxOutputTokens: 4096,
        providerOptions: { deepseek: { thinking: { type: "disabled" } } },
        purpose: request.purpose,
        systemPolicy: request.systemPolicy,
        untrustedInput: request.untrustedInput,
        abortSignal: request.signal,
        timeoutMs: request.remainingMs,
      });
    },
  };
}

export class InputLimitError extends Error {
  readonly inputTokens: number;

  constructor(inputTokens: number) {
    super(`Input token estimate ${inputTokens} exceeds 16000`);
    this.name = "InputLimitError";
    this.inputTokens = inputTokens;
  }
}
