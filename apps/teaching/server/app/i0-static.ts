import { constants, openSync, closeSync, fstatSync, readFileSync, realpathSync, lstatSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { ApiError } from './errors.ts';

const types:Record<string,string> = {
  '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png',
  '.jpg':'image/jpeg','.jpeg':'image/jpeg','.ico':'image/x-icon',
  '.ttf':'font/ttf','.woff':'font/woff','.woff2':'font/woff2',
};
export function registerI0Static(app:FastifyInstance,directory:string) {
  const root = realpathSync(directory);
  if (!lstatSync(root).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new ApiError('INVALID_CONFIGURATION');
  app.get('/*', (request,reply) => {
    let path:string;
    try { path = decodeURIComponent(request.raw.url!.split('?',1)[0]!); } catch { throw new ApiError('INVALID_REQUEST'); }
    const segments = path.slice(1).split('/');
    if (!path.startsWith('/') || path.includes('\\') || path.includes('\0')
      || segments.some(part => part === '..' || part.startsWith('.'))
      || path.startsWith('/api/') || path.startsWith('/health/')) throw new ApiError('INVALID_REQUEST');
    const requested = path === '/' ? 'index.html' : path.slice(1);
    const target = resolve(root,requested);
    const within = relative(root,target);
    if (!within || within.startsWith('..'+sep) || within === '..' || resolve(root,within) !== target) throw new ApiError('INVALID_REQUEST');
    const extension = requested.slice(requested.lastIndexOf('.'));
    const contentType = types[extension];
    if (!contentType) throw new ApiError('INVALID_REQUEST');
    try {
      let ancestor = root;
      for (const part of within.split(sep)) {
        ancestor = join(ancestor,part);
        if (lstatSync(ancestor).isSymbolicLink()) throw new ApiError('INVALID_REQUEST');
      }
      if (realpathSync(target) !== target) throw new ApiError('INVALID_REQUEST');
      const fd = openSync(target,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > 16*1024*1024) throw new ApiError('INVALID_REQUEST');
        return reply.header('x-content-type-options','nosniff').type(contentType).send(readFileSync(fd));
      } finally { closeSync(fd); }
    } catch { throw new ApiError('INVALID_REQUEST'); }
  });
}
