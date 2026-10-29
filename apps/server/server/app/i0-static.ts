import { closeSync, constants, createReadStream, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import type { ReadStream } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { ApiError } from './errors.ts';

const types:Record<string,string> = {
  '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png',
  '.jpg':'image/jpeg','.jpeg':'image/jpeg','.ico':'image/x-icon',
  '.ttf':'font/ttf','.woff':'font/woff','.woff2':'font/woff2',
};
// Only these representations are pre-compressed at build time; the host never compresses on the request path.
const compressible = new Set(['.html','.js','.css','.svg']);
const digestPattern = /^[0-9a-f]{64}$/;
// Build outputs at or below this size are sent as one buffered write; larger files stream.
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

// Optional build-time map `<relative path> -> sha256` written next to the built assets.
function readDigests(root:string):Map<string,string> {
  let parsed:unknown;
  try { parsed = JSON.parse(readFileSync(join(root,'asset-digests.json'),'utf8')); }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw new ApiError('INVALID_CONFIGURATION');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new ApiError('INVALID_CONFIGURATION');
  const digests = new Map<string,string>();
  for (const [path,digest] of Object.entries(parsed as Record<string,unknown>)) {
    if (path.includes('\\') || path.includes('\0') || path.startsWith('/')
      || path.split('/').some(part => !part || part === '..' || part.startsWith('.'))
      || typeof digest !== 'string' || !digestPattern.test(digest)) throw new ApiError('INVALID_CONFIGURATION');
    digests.set(path,digest);
  }
  return digests;
}

// Highest accepted quality wins; pre-compressed brotli is preferred over gzip.
function acceptedEncoding(header:string|undefined):'br'|'gzip'|null {
  if (!header) return null;
  const qualities = new Map<string,number>();
  for (const part of header.split(',')) {
    const [token,...parameters] = part.trim().split(';');
    const name = token?.trim().toLowerCase();
    if (!name) continue;
    let quality = 1;
    for (const parameter of parameters) {
      const [key,value] = parameter.trim().split('=');
      if (key?.toLowerCase() === 'q') quality = Number(value);
    }
    if (Number.isFinite(quality) && quality > 0) qualities.set(name,quality);
  }
  const brotli = qualities.get('br') ?? 0, gzip = qualities.get('gzip') ?? 0;
  if (brotli > 0 && brotli >= gzip) return 'br';
  return gzip > 0 ? 'gzip' : null;
}

export function registerI0Static(app:FastifyInstance,directory:string) {
  const root = realpathSync(directory);
  if (!lstatSync(root).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new ApiError('INVALID_CONFIGURATION');
  const digests = readDigests(root);
  const openValidated = (requested:string) => {
    try {
      const target = resolve(root,requested);
      const within = relative(root,target);
      if (!within || within.startsWith('..'+sep) || within === '..' || resolve(root,within) !== target) throw new Error('outside');
      let ancestor = root;
      for (const part of within.split(sep)) {
        ancestor = join(ancestor,part);
        if (lstatSync(ancestor).isSymbolicLink()) throw new Error('symlink');
      }
      if (realpathSync(target) !== target) throw new Error('resolved');
      const fd = openSync(target,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile()) throw new Error('not-file');
        return {fd,stat,within:within.split(sep).join('/')};
      } catch (error) {
        closeSync(fd);
        throw error;
      }
    } catch { throw new ApiError('INVALID_REQUEST'); }
  };
  app.get('/*', (request,reply) => {
    let path:string;
    try { path = decodeURIComponent(request.raw.url!.split('?',1)[0]!); } catch { throw new ApiError('INVALID_REQUEST'); }
    const segments = path.slice(1).split('/');
    if (!path.startsWith('/') || path.includes('\\') || path.includes('\0')
      || segments.some(part => part === '..' || part.startsWith('.'))
      || path.startsWith('/api/') || path.startsWith('/health/')) throw new ApiError('INVALID_REQUEST');
    const requested = path === '/' ? 'index.html' : path.slice(1);
    const extension = requested.slice(requested.lastIndexOf('.'));
    const contentType = types[extension];
    if (!contentType) throw new ApiError('INVALID_REQUEST');
    const identity = openValidated(requested);
    let representation = identity;
    let stream:ReadStream|undefined;
    try {
      const encoding = compressible.has(extension) ? acceptedEncoding(request.headers['accept-encoding']) : null;
      if (encoding) {
        try { representation = openValidated(encoding === 'br' ? requested + '.br' : requested + '.gz'); }
        catch { representation = identity; }
      }
      const digest = digests.get(requested);
      const variant = representation === identity ? '' : representation.within.endsWith('.br') ? '-br' : '-gz';
      const tag = digest === undefined ? undefined : `"${digest}${variant}"`;
      const headers:Record<string,string> = {
        'x-content-type-options':'nosniff',
        'content-type':contentType,
        // Content-hashed build outputs never change under their URL; every other entry revalidates per deployment.
        'cache-control':requested.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
        ...(compressible.has(extension) ? {'vary':'accept-encoding'} : {}),
        ...(representation !== identity ? {'content-encoding':representation.within.endsWith('.br') ? 'br' : 'gzip'} : {}),
        ...(tag !== undefined ? {etag:tag} : {}),
      };
      if (tag !== undefined && request.headers['if-none-match'] === tag) {
        closeSync(representation.fd);
        if (representation !== identity) closeSync(identity.fd);
        return reply.code(304).headers(headers).send();
      }
      if (representation.stat.size <= MAX_BUFFERED_BYTES) {
        // Small build outputs are handed over in one write; anything larger streams
        // so a huge asset is never buffered whole inside this process.
        const body = readFileSync(representation.fd);
        closeSync(representation.fd);
        if (representation !== identity) closeSync(identity.fd);
        return reply.headers(headers).send(body);
      }
      // The stream owns the descriptor (autoClose); a stalled reader only holds its own response.
      stream = createReadStream(join(root,representation.within),{fd:representation.fd});
      const response = reply.headers(headers).header('content-length',representation.stat.size).send(stream);
      if (representation !== identity) closeSync(identity.fd);
      return response;
    } catch (error) {
      if (representation !== identity) closeSync(identity.fd);
      if (stream === undefined) closeSync(representation.fd);
      else stream.close();
      throw error;
    }
  });
}
