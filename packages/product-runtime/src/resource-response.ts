import { StorageError } from '@xunjie/storage';

/**
 * A runtime resource path is bounded and traversal-free per segment. The manifest owner still resolves the
 * path against the pinned definition, so this only decides what may be forwarded, never what exists.
 */
const segment = '[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,199}';
export const runtimeResourcePathPattern = `(?:${segment}/){0,8}${segment}`;
/**
 * The one release payload large enough to need its own transport bound. A manifest may pin an 8 MiB runtime
 * file, which is about 10.7 MiB once base64-encoded; 16 MiB leaves room for the surrounding metadata.
 */
export const runtimeResourceResponseBytes = 16 * 1024 * 1024;
/**
 * Matched on the exact resource route so no unrelated operation can borrow this ceiling. A component import
 * request is a different route with a different bound; adding a resource to a release does not widen either.
 */
export const runtimeResourceRoute = new RegExp(
  `^releases/[0-9a-f-]{36}/components/[a-z][a-z0-9-]{0,47}/resources/${runtimeResourcePathPattern}$`);
/** V3 results carry bounded original logs/VCD as JSON, including JSON escaping overhead. */
export const executionArtifactRoute=/^executions\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/artifact$/;
export const executionArtifactResponseBytes=32*1024*1024;

/**
 * Reads a JSON response only while it stays inside `limit`. An overrun is refused as an upstream failure and
 * the body is cancelled, so a larger-than-declared answer is never silently truncated into valid-looking data.
 */
export async function boundedJsonResponse(response: Response, limit: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new StorageError('unavailable');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > limit) throw new StorageError('unavailable');
      chunks.push(item.value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new StorageError('unavailable'); }
}
