import type { z } from 'zod';
import type { teachingDependencyCallSchema } from '@xunjie/contracts/teaching-agent';

export function isTeachingDependencyRead(input: z.infer<typeof teachingDependencyCallSchema>): boolean {
  // Uploads retain facts/resources. They must never enter pure-query discard/reissue recovery.
  if (input.operation === 'execution.record') return false;
  if (input.operation === 'execution') return ['read', 'artifact', 'controlReceipt', 'agent.read',
    'agent.original', 'agent.status', 'agent.cleanupStatus'].includes(String(input.args[0]));
  return input.operation === 'activity' || input.operation === 'course'
    || input.operation === 'data' && !['pdf.read', 'artifacts.publish'].includes(String(input.args[0]));
}
