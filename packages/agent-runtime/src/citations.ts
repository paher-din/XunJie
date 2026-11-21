import { operationId } from '@xunjie/storage/identity';
import type { AgentTool, ContextMaterial, Facts, ToolCall, ToolContext } from './ports.js';

export interface CitationFact extends Facts {
  citationId: string;
  claim: string;
  label: string;
  source: Facts;
  range: Facts | null;
  version: string | null;
  digest: string;
}

export const citationToolDefinition = {
  name: 'cite_source',
  description: 'v1. Attach one opening source to one concrete claim that depends on material you actually read in this Turn. '
    + 'Use a Step materialId, or the native toolCallId of a prior successful tool result. Do not cite general knowledge, '
    + 'do not invent a source, and do not call this merely to make an answer look researched.',
  inputSchema: {
    type: 'object',
    properties: {
      claim: { type: 'string', minLength: 1, maxLength: 1000 },
      materialId: { type: 'string', minLength: 1, maxLength: 200 },
      toolCallId: { type: 'string', minLength: 1, maxLength: 200 },
      locator: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: true }] },
    },
    required: ['claim'],
    additionalProperties: false,
  },
} as const;

function output(citation: CitationFact): { kind: 'completed'; outcome: 'success'; summary: string; data: Facts } {
  return { kind: 'completed', outcome: 'success', summary: JSON.stringify({ state: 'cited', citation }),
    data: { citation } };
}

function failure(reason: string): { kind: 'completed'; outcome: 'error'; summary: string } {
  return { kind: 'completed', outcome: 'error', summary: reason };
}

/** The Step owns the allowed source set; the tool never searches for a more flattering source. */
export function createCitationTool(materials: readonly ContextMaterial[]): AgentTool {
  const byId = new Map(materials.map(item => [item.materialId, item]));
  return {
    definition: citationToolDefinition,
    supportsBackground: false,
    async execute(call: ToolCall, ctx: ToolContext) {
      if (call.executionMode === 'background') return failure('引用只能在当前回答中记录。');
      const claim = typeof call.input.claim === 'string' ? call.input.claim.trim() : '';
      if (!claim) return failure('引用缺少具体判断。');
      const materialId = typeof call.input.materialId === 'string' ? call.input.materialId : null;
      const toolCallId = typeof call.input.toolCallId === 'string' ? call.input.toolCallId : null;
      if (!!materialId === !!toolCallId) return failure('每次引用必须且只能指定一个本步材料或一条工具结果。');
      const material = materialId ? byId.get(materialId) : materials.find(item => item.kind === 'tool-result'
        && item.source.nativeCallId === toolCallId);
      if (!material || !material.citationAllowed
        || material.readState !== 'included' && material.visibleInHistory !== true)
        return failure('该材料不在本步实际发送的范围内，不能作为出处。');
      const citation: CitationFact = { citationId: operationId('agent-citation:' + ctx.toolCallId + ':' + material.materialId),
        claim, label: material.label, materialId: material.materialId, source: material.source,
        range: material.range, version: material.version, digest: material.digest };
      return output(citation);
    },
  };
}
