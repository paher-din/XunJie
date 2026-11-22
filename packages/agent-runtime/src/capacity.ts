import { measureNativeCapacity, type LearningModelPort } from '@xunjie/model-gateway/service';
import { modelContextPressurePolicy, type ModelConnection } from '@xunjie/contracts/model-connections';
import type { GenerateInput, RequestCapacity } from './ports.js';

export function requestCapacity(input: GenerateInput, connection: ModelConnection,
  payload: unknown, maxOutputTokens: number, remainingInputTokens: number): RequestCapacity {
  const encoded = JSON.stringify(payload ?? {});
  const imageCount = input.images.length + input.history.reduce((sum, entry) => sum + (entry.images?.length ?? 0), 0);
  const safetyRate = imageCount > 0 ? modelContextPressurePolicy.imageSafetyRate : modelContextPressurePolicy.defaultSafetyRate;
  return describeCapacity(input, connection, measureNativeCapacity(Buffer.from(encoded),
    connection.contextWindow ?? null, maxOutputTokens, remainingInputTokens, safetyRate, connection.compactionHeadroomTokens));
}

export async function measureAttemptCapacity(gateway: LearningModelPort, input: GenerateInput,
  connection: ModelConnection, attemptId: string, maxOutputTokens: number, remainingInputTokens: number): Promise<RequestCapacity> {
  return gateway.checks.capacity
    ? describeCapacity(input, connection, await gateway.checks.capacity(input.identity, attemptId, remainingInputTokens))
    : requestCapacity(input, connection, await gateway.checks.requestPayload(input.identity, attemptId), maxOutputTokens, remainingInputTokens);
}

function describeCapacity(input: GenerateInput, connection: ModelConnection,
  measurement: ReturnType<typeof measureNativeCapacity>): RequestCapacity {
  const imageCount = input.images.length + input.history.reduce((sum, entry) => sum + (entry.images?.length ?? 0), 0);
  return {
    formatVersion: 1,
    ...measurement,
    method: 'utf8-byte-estimate',
    model: { connectionId: connection.connectionId, version: connection.version,
      protocol: connection.protocol, modelId: connection.modelId },
    parts: {
      systemBytes: Buffer.byteLength(input.system, 'utf8'),
      toolsBytes: Buffer.byteLength(JSON.stringify(input.tools), 'utf8'),
      historyBytes: Buffer.byteLength(JSON.stringify(input.history), 'utf8'),
      currentBytes: Buffer.byteLength(JSON.stringify({ text: input.text,
        toolResults: input.toolResults, images: input.images }), 'utf8'),
      imageCount,
    },
  };
}
