import { z } from 'zod';
import { StorageError } from '@xunjie/storage';
import { teachingAgentCallSchema } from '@xunjie/contracts/teaching-agent';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import type { TeachingAgentCall } from '../teaching-agent/service.js';

/** Both the installed client and a hosted Agent translate the same product routes. */
export function teachingAgentHttpCall(identity: SpaceIdentity, route: string, method: string,
  body?: unknown, search = ''): TeachingAgentCall {
  const parts = route.split('/'), query = new URLSearchParams(search);
  const activityId = parts[0] === 'agent' ? z.uuid().parse(parts[1]) : query.has('activityId') ? z.uuid().parse(query.get('activityId')) : undefined;
  const tail = parts[0] === 'agent' ? parts.slice(2) : parts;
  const call = (operation: TeachingAgentCall['operation'], args: unknown[] = []) =>
    teachingAgentCallSchema.parse({ version: 1, operation, identity, ...(activityId ? { activityId } : {}), args });
  if (tail[0] === 'skills') {
    if (tail.length === 1 && method === 'GET') return call('skills.list');
    if (tail.length === 2 && method === 'POST' && ['import', 'select', 'disable', 'document', 'remove'].includes(tail[1]!))
      return call(`skills.${tail[1]}` as 'skills.import', [body]);
  }
  if (!activityId) throw new StorageError('missing');
  if (tail.length === 1 && method === 'GET' && ['conversation', 'events', 'capabilities'].includes(tail[0]!))
    return call(tail[0] as 'conversation', tail[0] === 'capabilities' ? []
      : [z.coerce.number().int().nonnegative().parse(query.get('after') ?? 0)]);
  if (tail.length === 1 && tail[0] === 'model-switches' && method === 'POST') return call('switchModel', [body]);
  if (tail.length === 2 && method === 'GET') {
    const operation = ({ runs: 'run', requests: 'request', snapshots: 'snapshot', responses: 'response', controls: 'inputControlReceipt' } as const)[tail[0] as 'runs'];
    if (operation) return call(operation, [z.uuid().parse(tail[1])]);
  }
  if (tail.length === 3 && method === 'POST') {
    const key = `${tail[0]}/${tail[2]}`;
    const operation = ({ 'runs/stop': 'stop', 'runs/continue': 'continueRun', 'questions/responses': 'respond',
      'questions/presentations': 'presentQuestion', 'inputs/control': 'controlInput' } as const)[key as 'runs/stop'];
    if (operation) return call(operation, [z.uuid().parse(tail[1]), body]);
  }
  throw new StorageError('missing');
}
