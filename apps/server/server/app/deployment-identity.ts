import type { FastifyInstance } from 'fastify';

/** The business host reads its verified, immutable release manifest at startup. */
export function registerDeploymentIdentity(app: FastifyInstance, manifest: unknown) {
  if (!manifest || typeof manifest !== 'object' || !('format' in manifest) || manifest.format !== 'xunjie-runtime-artifact'
    || !('version' in manifest) || manifest.version !== 1 || !('commit' in manifest)
    || typeof manifest.commit !== 'string' || !/^[0-9a-f]{40}$/.test(manifest.commit)) {
    throw new Error('Verified release identity required.');
  }
  const commit = manifest.commit;
  app.addHook('onSend', async (request, reply) => {
    if (['/health/live', '/health/ready'].includes(request.url.split('?', 1)[0]!)) {
      reply.header('x-xunjie-version', commit);
      reply.header('x-xunjie-protocol', 'xunjie/session-v1');
    }
  });
}
