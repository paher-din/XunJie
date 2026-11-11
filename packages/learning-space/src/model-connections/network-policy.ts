import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { StorageError } from '@xunjie/storage';
import type { ModelConfiguration } from '@xunjie/contracts/model-connections';

/** Supplied by the trusted holder, never by a model configuration or HTTP body. */
export type ModelTargetClass = 'public' | 'device' | 'school-approved';
type Address = { address: string; family: number };
type Resolver = (hostname: string) => Promise<Address[]>;
const resolveAddresses: Resolver = hostname => lookup(hostname, { all: true, verbatim: true });
const hostOf = (url: URL) => url.hostname.replace(/^\[|\]$/g, '');
const endpointOf = (configuration: ModelConfiguration) => new URL(configuration.baseUrl.replace(/\/+$/, '') + configuration.path);

function ipv4Class(address: string): 'public' | 'private' | 'loopback' | 'special' {
  const [a = 0, b = 0, c = 0] = address.split('.').map(Number);
  if (a === 127) return 'loopback';
  if (a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168) return 'private';
  if (a === 0 || a >= 224 || a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254
    || a === 192 && b === 0 && (c === 0 || c === 2) || a === 192 && b === 88 && c === 99
    || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113) return 'special';
  return 'public';
}
export function modelAddressAllowed(address: string, target: ModelTargetClass) {
  const family = isIP(address);
  if (family === 4) {
    const category = ipv4Class(address);
    return category === 'public' || target !== 'public' && (category === 'private' || category === 'loopback');
  }
  if (family !== 6) return false;
  // WHATWG canonicalization normalizes mapped addresses and alternative textual forms.
  const canonical = hostOf(new URL(`https://[${address}]/`)).toLowerCase();
  if (canonical === '::1') return target !== 'public';
  const first = parseInt(canonical.split(':')[0] || '0', 16);
  if ((first & 0xfe00) === 0xfc00) return target !== 'public';
  // Only global unicast. Exclude protocol assignments, documentation and 6to4 tunnels.
  if ((first & 0xe000) !== 0x2000 || first === 0x2002 || first === 0x3fff) return false;
  const second = parseInt(canonical.split(':')[1] || '0', 16);
  return !(first === 0x2001 && (second < 0x200 || second === 0xdb8));
}
function checkUrl(configuration: ModelConfiguration, target: ModelTargetClass) {
  const url = endpointOf(configuration), hostname = hostOf(url);
  if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) throw new StorageError('forbidden');
  const literal = isIP(hostname);
  if (literal && !modelAddressAllowed(hostname, target)) throw new StorageError('forbidden');
  if (target === 'public' && (url.protocol !== 'https:' || hostname === 'localhost' || /\.(?:localhost|local|internal|home|lan)\.?$/i.test(hostname)))
    throw new StorageError('forbidden');
  if (url.protocol === 'http:' && hostname !== 'localhost' && (!literal || !(hostname === '::1' || hostname.startsWith('127.'))))
    throw new StorageError('forbidden');
  return { url, hostname, literal };
}
export async function resolveModelTarget(configuration: ModelConfiguration, target: ModelTargetClass, resolve: Resolver = resolveAddresses) {
  const { url, hostname, literal } = checkUrl(configuration, target);
  let addresses: Address[];
  try { addresses = literal ? [{ address: hostname, family: literal }] : await resolve(hostname); }
  catch (cause) {
    const error = new StorageError('unavailable');
    const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined;
    const networkCode = typeof code === 'string' && ['ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME', 'ETIMEDOUT'].includes(code) ? code : undefined;
    // Preserve the storage code; only the allowlisted native network code survives.
    if (networkCode) error.cause = { code: networkCode };
    throw error;
  }
  if (!addresses.length || addresses.some(item => !modelAddressAllowed(item.address, target))) throw new StorageError('forbidden');
  return { url, hostname, addresses };
}
/** Saving on a device grants that device's local network scope, not the school's scope. */
export async function validateModelTarget(configuration: ModelConfiguration, target: ModelTargetClass, resolve: Resolver = resolveAddresses) {
  checkUrl(configuration, target);
  if (target === 'public') await resolveModelTarget(configuration, target, resolve);
}
/** One dispatch owns one pinned connection pool; DNS is never re-resolved by the SDK. */
export async function modelTargetFetch(configuration: ModelConfiguration, target: ModelTargetClass, resolve: Resolver = resolveAddresses): Promise<typeof fetch> {
  const fixed = await resolveModelTarget(configuration, target, resolve);
  // Lifecycle-only consumers need no HTTP pool; load its CommonJS graph on dispatch.
  const { Agent } = await import('undici');
  return async (input, init) => {
    const actual = new URL(input instanceof Request ? input.url : String(input));
    if (actual.href !== fixed.url.href) throw new StorageError('forbidden');
    const agent = new Agent({ connect: { lookup(_hostname, options, callback) {
      if (options.all) callback(null, fixed.addresses);
      else callback(null, fixed.addresses[0]!.address, fixed.addresses[0]!.family);
    } } });
    try {
      // Node's bundled undici-types and the pinned undici package expose different type versions.
      const dispatcher = agent as unknown as NonNullable<RequestInit['dispatcher']>;
      const response = await fetch(input, { ...init, redirect: 'error', dispatcher });
      // close() drains the current response before releasing the socket; it does not abort its body.
      void agent.close().catch(() => {});
      return response;
    } catch (error) { await agent.destroy(); throw error; }
  };
}
