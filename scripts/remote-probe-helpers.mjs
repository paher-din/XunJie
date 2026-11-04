import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const parseArgs = (argv = process.argv.slice(2)) => Object.fromEntries(argv.map(item => {
  const [key, ...rest] = item.replace(/^--/, '').split('=');
  return [key, rest.join('=')];
}));

const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en'))
      .map(([key, child]) => [key, canonical(child)]))
    : value;
export const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');


export async function remoteDevice(args, payload, state) {
  const recorded = args['device-state']
    ? JSON.parse(await readFile(args['device-state'], 'utf8')).device : state?.device;
  if (args['device-state'] && !recorded) throw new Error('--device-state file has no device observation');
  if (recorded) {
    if (args.platform && args.platform !== recorded.platform)
      throw new Error('--platform conflicts with the recorded Chrome device');
    return recorded;
  }
  if (!args.platform) return undefined;
  if (!['macos-arm64', 'windows-x64'].includes(args.platform))
    throw new Error('--platform must be macos-arm64 or windows-x64');
  if (payload.component.manifest.session.adapterId !== 'linux-proc-accumulator')
    throw new Error('--platform can only establish native unsupported for the Linux-only adapter');
  return { platform: args.platform,
    browser: { worker: false, webassembly: false, sandboxedFrame: false },
    native: { supported: false, installed: false, authorized: false, prepared: 'none' } };
}

export function createLearningApi(endpoint, token) {
  return async (route, body, headers = { authorization: `Bearer ${token}` }) => {
    const response = await fetch(new URL('/api/learning/' + route, endpoint), {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, value: text ? JSON.parse(text) : null };
  };
}

export const expectOk = (label, result) => {
  if (result.status !== 200) throw new Error(`${label} ${result.status}: ${JSON.stringify(result.value).slice(0, 300)}`);
  return result.value;
};

export async function loginMember(endpoint, payload) {
  const response = await fetch(new URL('/api/learning/login', endpoint), {
    method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ loginName: payload.loginName, password: payload.password }),
  });
  if (response.status !== 200) throw new Error('login failed: ' + response.status);
  const cookie = response.headers.get('set-cookie');
  if (!cookie) throw new Error('login did not return a session cookie');
  return { headers: { cookie: cookie.split(';')[0] }, identity: (await response.json()).identity };
}
