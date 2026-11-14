import { StorageError } from '@xunjie/storage';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import type { createTeachingArtifacts } from '@xunjie/learning-space/learning-data/teaching-artifacts';
import { teachingArtifactPublishSchema } from '@xunjie/contracts/teaching-artifacts';
/** Called only after the shared HTTP boundary derives the authenticated subject. */
export async function routeArtifacts(artifacts: ReturnType<typeof createTeachingArtifacts>, identity: SpaceIdentity, route: string,
  method: string | undefined, body?: unknown) {
  const parts = route.split('/');
  if (parts.length > 6) throw new StorageError('missing');
  const [, activityId, a, b, c, d] = parts;
  if (!activityId) throw new StorageError('missing');
  if (!a && method === 'GET') return artifacts.list(identity, activityId);
  if (!a && method === 'POST') return artifacts.publish(identity, activityId, teachingArtifactPublishSchema.parse(body));
  if (method === 'POST' && !b && a === 'check') return artifacts.check(identity, activityId, body);
  if (method === 'POST' && !b && a === 'adopt') return artifacts.adopt(identity, activityId, body);
  if (method === 'POST' && !b && a === 'shelf') return artifacts.shelf(identity, activityId, body);
  if (method === 'GET' && a === 'receipts' && b && !c) return artifacts.receipt(identity, activityId, b);
  if (method === 'GET' && a === 'checks' && b && !c) return artifacts.checkReceipt(identity, activityId, b);
  if (method === 'GET' && a === 'candidates' && b && !c) return artifacts.candidate(identity, activityId, b);
  if (method === 'GET' && a && !b) return artifacts.read(identity, activityId, a);
  if (method === 'GET' && a && b === 'revisions' && c && !d) return artifacts.revision(identity, activityId, a, c);
  if (method === 'GET' && a && b === 'revisions' && c && d === 'resource') return artifacts.resource(identity, activityId, a, c);
  throw new StorageError('missing');
}
