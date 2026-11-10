import { StorageError } from '@xunjie/storage';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import { modelGrantInputSchema, modelCheckInputSchema, modelChatInputSchema, readModelCredentialSchema } from '@xunjie/contracts/model-connections';
import type { createModelGateway } from './index.js';

/** The same owner wire is consumed by school HTTP and an authenticated installed client. */
export async function routeModels(models: Awaited<ReturnType<typeof createModelGateway>>, identity: SpaceIdentity,
  route: string, body?: unknown, deviceOwner?: SpaceIdentity) {
  if (route === 'models/selection') return body === undefined ? models.selection.read(identity, deviceOwner) : models.selection.save(identity, body);
  if (route === 'models/grants' && body !== undefined) {
    const input = modelGrantInputSchema.parse(body);
    if (input.owner === 'device' && !deviceOwner) return models.selection.createDeviceGrant(identity, input);
    return models.selection.createGrant(identity, input.owner === 'device' ? deviceOwner! : identity, input);
  }
  if (/^models\/grants\/[^/]+\/revoke$/.test(route) && body !== undefined) return models.selection.revoke(identity, route.split('/')[2]!, body);
  if (route === 'models/connections') return body === undefined ? models.list(identity) : models.save(identity, body);
  if (route === 'models/providers') return body === undefined ? models.providers.list(identity) : models.providers.save(identity, body);
  if (route === 'models/profiles' && body !== undefined) return models.profiles.read(identity, body);
  if (route === 'models/directory' && body !== undefined) return models.directory.read(identity, body);
  const credential = /^models\/connections\/([^/]+)\/credential$/.exec(route);
  if (credential && body !== undefined) return models.readCredential(identity, credential[1]!, readModelCredentialSchema.parse(body).version);
  if (route === 'models/capabilities' && body !== undefined) return models.segments.decideCapabilities(identity, body);
  if (route === 'models/images' && body !== undefined) return models.images.upload(identity, body);
  if (/^models\/results\/[^/]+$/.test(route) && body === undefined) return models.results.read(identity, route.split('/')[2]!);
  if (route === 'models/segments' && body !== undefined) return models.segments.create(identity, body);
  if (/^models\/segments\/[^/]+$/.test(route) && body === undefined) return models.segments.read(identity, route.split('/')[2]!);
  if (/^models\/segments\/[^/]+\/tool-results$/.test(route) && body !== undefined) return models.segments.settle(identity, route.split('/')[2]!, body);
  if (/^models\/segments\/[^/]+\/close$/.test(route) && body !== undefined) return models.segments.close(identity, route.split('/')[2]!, body);
  // Learning attempts are created only by the authenticated RunDriver; the public call wire stays
  // a diagnostic probe path so it cannot bypass learning admission.
  if (route === 'models/calls' && body !== undefined) return models.checks.receive(identity, modelChatInputSchema.parse(body));
  if (route === 'models/checks') return body === undefined ? (await models.checks.list(identity)).filter(item => item.purpose === 'connection-check')
    : models.checks.receive(identity, modelCheckInputSchema.parse(body));
  const match = /^models\/(checks|calls)\/([^/]+)(?:\/(dispatch|cancel))?$/.exec(route);
  if (match) {
    const fact = await models.checks.read(identity, match[2]!);
    if (fact.purpose !== (match[1] === 'checks' ? 'connection-check' : 'chat-probe')) throw new StorageError('missing');
    if (!match[3] && body === undefined) return fact;
    if (body !== undefined && match[3] === 'dispatch') return models.checks.dispatch(identity, fact.attemptId);
    if (body !== undefined && match[3] === 'cancel') return models.checks.cancel(identity, fact.attemptId);
  }
  throw new StorageError('missing');
}
