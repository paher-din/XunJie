import type { AgentDispatchPermit } from '@xunjie/contracts/agent-runtime';
import type { LearningModelRequest } from './service.js';

/** Generation revokes authority; the remaining fields identify one immutable effect. */
export function fixedPermit(permit: AgentDispatchPermit) {
  const { generation: _generation, ...identity } = permit;
  return identity;
}

export function requestWithPermit(request: LearningModelRequest, permit?: AgentDispatchPermit): LearningModelRequest {
  if (!permit) return request;
  const authority = { formatVersion: 1 as const, permit };
  if (request.operation === 'checks.receive') return { ...request, args: [{ ...(request.args[0] as object), authority }] };
  if (request.operation === 'checks.dispatch') return { ...request, args: [request.args[0], authority] };
  return request;
}

/** Used only for retry fingerprints, never as a request or dispatch capability. */
export function fixedSessionRequest(request: LearningModelRequest): unknown {
  const index = request.operation === 'checks.receive' ? 0 : request.operation === 'checks.dispatch' ? 1 : -1;
  if (index < 0 || !request.args[index]) return request;
  const argument = request.args[index] as { authority?: { formatVersion: 1; permit: AgentDispatchPermit }; formatVersion?: 1; permit?: AgentDispatchPermit };
  const authority = index === 0 ? argument.authority : argument.permit ? { formatVersion: argument.formatVersion, permit: argument.permit } : undefined;
  if (!authority) return request;
  const fixed = { formatVersion: authority.formatVersion, permit: fixedPermit(authority.permit) };
  return { ...request, args: request.args.map((value, position) => position !== index ? value : index === 0 ? { ...argument, authority: fixed } : fixed) };
}
