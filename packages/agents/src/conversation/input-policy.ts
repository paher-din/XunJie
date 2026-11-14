import { createHash } from 'node:crypto';
import { canonicalDigest } from '@xunjie/storage/identity';
import type { AgentWait } from '@xunjie/contracts/agent-runtime';
import type { Facts, FixedAgentInput } from '@xunjie/agent-runtime';

export interface ConversationPolicyInput { inputId: string; version: number; text: string; inputDigest: string; byteLength: number; encoding: 'utf8'; waitId?: string; responseDigest?: string; questionDigest?: string; question?: Facts; response?: Facts; }
export interface ConversationInputPolicy {
  id: string; version: number; maxOutputTokens: number; classifyResponses?: boolean;
  prompt(input: ConversationPolicyInput): { system: string; text: string };
  parse(text: string, input: ConversationPolicyInput): Facts;
}
export function fixedPolicyInput(input: FixedAgentInput): ConversationPolicyInput {
  const bytes = Buffer.from(input.input.text, 'utf8');
  return { inputId: input.inputId, version: input.version, text: input.input.text,
    inputDigest: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.byteLength, encoding: 'utf8' };
}

export function fixedPolicyResponse(wait: AgentWait): ConversationPolicyInput | null {
  if (wait.kind !== 'user' || wait.state !== 'consumed' || !wait.response || (wait.response.kind !== 'text' && wait.response.kind !== 'choice')
    || typeof wait.presentation.sourceInputId !== 'string') return null;
  if (wait.response.kind === 'choice' && (!Array.isArray(wait.presentation.options)
    || !wait.presentation.options.some(option => typeof option === 'object' && option !== null && 'id' in option && option.id === wait.response!.optionId))) return null;
  const text = wait.response.kind === 'text' ? wait.response.text : JSON.stringify(wait.response);
  if (typeof text !== 'string') return null;
  const bytes = Buffer.from(text, 'utf8');
  return { inputId: wait.presentation.sourceInputId, version: wait.version, text,
    inputDigest: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.byteLength, encoding: 'utf8', waitId: wait.waitId,
    responseDigest: canonicalDigest(wait.response), questionDigest: canonicalDigest(wait.presentation), question: wait.presentation as Facts, response: wait.response as Facts };
}
