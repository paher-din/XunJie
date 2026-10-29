import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { RuntimeConnection, RuntimeService } from '@xunjie/contracts/product-runtime';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const maxBodyBytes = 1024 * 1024;
const defaultTimeoutMs = 5_000;

export class RuntimeConnectionError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`Runtime connection: ${code}`);
    this.name = 'RuntimeConnectionError';
    this.code = code;
  }
}

export interface ConnectionSource {
  sourceEnvironmentId: string;
  sourceServiceId: string;
}

export type CapabilityHandler = (
  payload: unknown,
  source: Readonly<ConnectionSource & { grantId: string }>,
) => unknown | Promise<unknown>;

export interface ConnectionAuthorization extends ConnectionSource {
  capabilities: readonly string[];
}

export interface ConnectionGrant extends ConnectionAuthorization {
  grantId: string;
  /** Private credential; returned once and never included in wire descriptors. */
  token: string;
}

interface StoredGrant extends ConnectionAuthorization {
  formatVersion: 1;
  grantId: string;
  tokenHash: string;
  targetEnvironmentId: string;
  targetServiceId: string;
  protocolVersion: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 100
    && value.every((item) => typeof item === 'string' && item.length > 0);
}

function digest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function errorCode(error: unknown): string | undefined {
  return record(error) && typeof error.code === 'string' ? error.code : undefined;
}

function send(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

async function readPayload(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  const timer = setTimeout(() => request.destroy(), defaultTimeoutMs);
  timer.unref();
  try {
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.length;
      if (length > maxBodyBytes) throw new RuntimeConnectionError('payload_too_large');
      chunks.push(bytes);
    }
    if (length === 0) return undefined;
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {
      throw new RuntimeConnectionError('invalid_json');
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Only registered capabilities are advertised and dispatched. No domain behavior is built in. */
export function createConnectionAuthority(options: {
  root: string;
  service: RuntimeService;
  handlers?: Readonly<Record<string, CapabilityHandler>>;
}) {
  const service = structuredClone(options.service);
  if (!uuid.test(service.environmentId) || !uuid.test(service.serviceId)) {
    throw new RuntimeConnectionError('invalid_service_identity');
  }
  const handlers = new Map(Object.entries(options.handlers ?? {}));
  for (const capability of handlers.keys()) {
    if (!service.capabilities.includes(capability)) {
      throw new RuntimeConnectionError('undeclared_capability');
    }
  }
  const privateRoot = join(options.root, 'private');
  const grantsRoot = join(privateRoot, 'connections', service.environmentId, service.serviceId);
  const grantPath = (grantId: string) => join(grantsRoot, `${grantId}.json`);

  async function authorize(input: ConnectionAuthorization): Promise<ConnectionGrant> {
    if (!uuid.test(input.sourceEnvironmentId) || !uuid.test(input.sourceServiceId)
      || !strings(input.capabilities) || input.capabilities.some((capability) => !handlers.has(capability))) {
      throw new RuntimeConnectionError('invalid_authorization');
    }
    const grantId = randomUUID();
    const token = `${grantId}.${randomBytes(32).toString('hex')}`;
    const grant: StoredGrant = {
      formatVersion: 1, grantId, tokenHash: digest(token),
      sourceEnvironmentId: input.sourceEnvironmentId,
      sourceServiceId: input.sourceServiceId,
      capabilities: [...new Set(input.capabilities)],
      targetEnvironmentId: service.environmentId,
      targetServiceId: service.serviceId,
      protocolVersion: service.protocolVersion,
    };
    await mkdir(grantsRoot, { recursive: true, mode: 0o700 });
    // Recursive mkdir does not change permissions on pre-existing private directories.
    for (const directory of [privateRoot, join(privateRoot, 'connections'),
      join(privateRoot, 'connections', service.environmentId), grantsRoot]) {
      await chmod(directory, 0o700);
    }
    await writeFile(grantPath(grantId), JSON.stringify(grant), { mode: 0o600, flag: 'wx' });
    return {
      grantId, token, sourceEnvironmentId: grant.sourceEnvironmentId,
      sourceServiceId: grant.sourceServiceId, capabilities: [...grant.capabilities],
    };
  }

  async function revoke(grantId: string): Promise<boolean> {
    if (!uuid.test(grantId)) throw new RuntimeConnectionError('invalid_grant_id');
    try {
      await unlink(grantPath(grantId));
      return true;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return false;
      throw new RuntimeConnectionError('grant_storage_unavailable');
    }
  }

  async function authenticate(request: IncomingMessage): Promise<StoredGrant | undefined> {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) return undefined;
    const token = authorization.slice(7);
    const parts = token.split('.');
    const grantId = parts[0];
    if (parts.length !== 2 || !grantId || !uuid.test(grantId)
      || !/^[0-9a-f]{64}$/.test(parts[1] ?? '')) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(await readFile(grantPath(grantId), 'utf8')) as unknown;
    } catch (error) {
      if (errorCode(error) === 'ENOENT' || error instanceof SyntaxError) return undefined;
      throw new RuntimeConnectionError('grant_storage_unavailable');
    }
    if (!record(value) || value.formatVersion !== 1 || value.grantId !== grantId
      || typeof value.tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.tokenHash)
      || !strings(value.capabilities) || typeof value.sourceEnvironmentId !== 'string'
      || typeof value.sourceServiceId !== 'string'
      || value.targetEnvironmentId !== service.environmentId || value.targetServiceId !== service.serviceId
      || value.protocolVersion !== service.protocolVersion
      || !timingSafeEqual(Buffer.from(value.tokenHash, 'hex'), Buffer.from(digest(token), 'hex'))
      || request.headers['x-runtime-source-environment-id'] !== value.sourceEnvironmentId
      || request.headers['x-runtime-source-service-id'] !== value.sourceServiceId) return undefined;
    return value as unknown as StoredGrant;
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const pathname = (request.url ?? '').split('?')[0] ?? '';
    const handshake = pathname === '/runtime/connect';
    const match = /^\/runtime\/capabilities\/([^/]+)$/.exec(pathname);
    if (!handshake && !match) return false;
    try {
      if (request.method !== 'POST') {
        response.setHeader('allow', 'POST');
        send(response, 405, { error: 'method_not_allowed' });
        return true;
      }
      let grant = await authenticate(request);
      if (!grant) {
        send(response, 401, { error: 'unauthorized' });
        return true;
      }
      if (request.headers['x-runtime-target-environment-id'] !== service.environmentId
        || request.headers['x-runtime-target-service-id'] !== service.serviceId) {
        send(response, 409, { error: 'target_identity_mismatch' });
        return true;
      }
      if (request.headers['x-runtime-protocol-version'] !== String(service.protocolVersion)) {
        send(response, 409, { error: 'protocol_mismatch' });
        return true;
      }
      const available = () => ({
        ...service,
        capabilities: service.capabilities.filter((capability) =>
          grant!.capabilities.includes(capability) && handlers.has(capability)),
      });
      if (handshake) {
        send(response, 200, { service: available() });
        return true;
      }
      let capability: string;
      try {
        capability = decodeURIComponent(match![1]!);
      } catch {
        send(response, 400, { error: 'invalid_capability' });
        return true;
      }
      const handler = handlers.get(capability);
      if (!grant.capabilities.includes(capability) || !handler) {
        send(response, 403, { error: 'capability_forbidden' });
        return true;
      }
      const payload = await readPayload(request);
      // A revoked grant must not survive a slow request body or a cached handshake.
      grant = await authenticate(request);
      if (!grant) {
        send(response, 401, { error: 'unauthorized' });
        return true;
      }
      const result = await handler(payload, Object.freeze({
        grantId: grant.grantId,
        sourceEnvironmentId: grant.sourceEnvironmentId,
        sourceServiceId: grant.sourceServiceId,
      }));
      send(response, 200, { service: available(), result: result ?? null });
    } catch (error) {
      const code = error instanceof RuntimeConnectionError ? error.code : 'request_failed';
      const status = code === 'payload_too_large' ? 413 : code === 'invalid_json' ? 400 : 500;
      if (!response.headersSent && !response.destroyed) send(response, status, { error: code });
      else response.destroy();
    }
    return true;
  }
  return { authorize, revoke, handle };
}

export interface ConnectionCheck {
  state: 'ready' | 'degraded' | 'unavailable';
  target: RuntimeService;
  availableCapabilities: string[];
  missingRequiredCapabilities: string[];
  missingOptionalCapabilities: string[];
  reason?: string;
}

export function createOutboundConnection(options: {
  connection: RuntimeConnection;
  credential: () => Promise<string>;
  allowInsecureLoopback?: boolean;
  timeoutMs?: number;
}) {
  // Callers may mutate their descriptors; an established connection never changes ownership.
  const connection = structuredClone(options.connection);
  const credential = options.credential;
  const endpoint = new URL(connection.target.endpoint);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname);
  if ((endpoint.protocol !== 'https:' && !(options.allowInsecureLoopback && loopback && endpoint.protocol === 'http:'))
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') {
    throw new RuntimeConnectionError('secure_endpoint_required');
  }
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new RuntimeConnectionError('invalid_timeout');
  }

  async function bounded<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work(controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new RuntimeConnectionError('timeout'));
          }, timeoutMs);
        }),
      ]);
    } catch (error) {
      if (error instanceof RuntimeConnectionError) throw error;
      throw new RuntimeConnectionError(controller.signal.aborted ? 'timeout' : 'connection_unavailable');
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
  }

  async function exchange(path: string, token: string, signal: AbortSignal, payload?: unknown): Promise<Record<string, unknown>> {
    if (signal.aborted) throw new RuntimeConnectionError('timeout');
    if (typeof token !== 'string' || !token || /[\r\n]/.test(token)) {
      throw new RuntimeConnectionError('credential_unavailable');
    }
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    if (body !== undefined && Buffer.byteLength(body) > maxBodyBytes) {
      throw new RuntimeConnectionError('payload_too_large');
    }
    const response = await fetch(new URL(path, endpoint), {
      method: 'POST', redirect: 'manual', signal,
      headers: {
        // Each call re-establishes transport; a restarted target cannot leave a stale pooled socket.
        connection: 'close',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-runtime-source-environment-id': connection.sourceEnvironmentId,
        'x-runtime-source-service-id': connection.sourceServiceId,
        'x-runtime-target-environment-id': connection.target.environmentId,
        'x-runtime-target-service-id': connection.target.serviceId,
        'x-runtime-protocol-version': String(connection.target.protocolVersion),
      },
      ...(body === undefined ? {} : { body }),
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new RuntimeConnectionError('redirect_refused');
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new RuntimeConnectionError(`http_${response.status}`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new RuntimeConnectionError('invalid_response');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > maxBodyBytes) throw new RuntimeConnectionError('response_too_large');
        chunks.push(item.value);
      }
    } finally {
      await reader.cancel();
    }
    let value: unknown;
    try {
      value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {
      throw new RuntimeConnectionError('invalid_response');
    }
    if (!record(value) || !record(value.service)) throw new RuntimeConnectionError('invalid_response');
    if (value.service.environmentId !== connection.target.environmentId
      || value.service.serviceId !== connection.target.serviceId) throw new RuntimeConnectionError('target_identity_mismatch');
    if (value.service.protocolVersion !== connection.target.protocolVersion) throw new RuntimeConnectionError('protocol_mismatch');
    if (!strings(value.service.capabilities)) throw new RuntimeConnectionError('invalid_response');
    return value;
  }

  function status(availableCapabilities: string[], reason?: string): ConnectionCheck {
    const missingRequiredCapabilities = connection.requiredCapabilities.filter((item) => !availableCapabilities.includes(item));
    const missingOptionalCapabilities = connection.optionalCapabilities.filter((item) => !availableCapabilities.includes(item));
    return {
      state: reason || missingRequiredCapabilities.length ? 'unavailable'
        : missingOptionalCapabilities.length ? 'degraded' : 'ready',
      target: structuredClone(connection.target), availableCapabilities: [...availableCapabilities],
      missingRequiredCapabilities, missingOptionalCapabilities,
      ...(reason ? { reason } : missingRequiredCapabilities.length ? { reason: 'required_capability_unavailable' } : {}),
    };
  }

  async function handshake(token: string, signal: AbortSignal): Promise<ConnectionCheck> {
    const value = await exchange('/runtime/connect', token, signal);
    return status((value.service as RuntimeService).capabilities);
  }

  async function check(): Promise<ConnectionCheck> {
    try {
      return await bounded(async (signal) => handshake(await credential(), signal));
    } catch (error) {
      return status([], error instanceof RuntimeConnectionError ? error.code : 'connection_unavailable');
    }
  }

  async function request(capability: string, payload?: unknown): Promise<unknown> {
    if (!connection.requiredCapabilities.includes(capability) && !connection.optionalCapabilities.includes(capability)) {
      throw new RuntimeConnectionError('capability_not_configured');
    }
    return bounded(async (signal) => {
      const token = await credential();
      const current = await handshake(token, signal);
      if (current.state === 'unavailable') throw new RuntimeConnectionError(current.reason ?? 'connection_unavailable');
      if (!current.availableCapabilities.includes(capability)) throw new RuntimeConnectionError('capability_unavailable');
      const value = await exchange(`/runtime/capabilities/${encodeURIComponent(capability)}`, token, signal, payload);
      const after = status((value.service as RuntimeService).capabilities);
      if (after.state === 'unavailable' || !after.availableCapabilities.includes(capability)) {
        throw new RuntimeConnectionError('required_capability_unavailable');
      }
      return value.result;
    });
  }
  return { check, request };
}
