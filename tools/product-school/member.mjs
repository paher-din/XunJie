#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const operations = ['course-catalog', 'course-import', 'course-result', 'course-access', 'course-execution-compile',
  'course-deployment-prepare', 'course-deployment-read', 'component-import', 'component-read', 'component-status'];
try {
  const { values } = parseArgs({ options: { 'account-file': { type: 'string' }, operation: { type: 'string' },
    file: { type: 'string' }, help: { type: 'boolean' } }, strict: true });
  if (values.help) {
    console.log('Usage: node tools/product-school/member.mjs --account-file <private.json> --operation <name> [--file <wire-input.json>]');
    console.log(operations.join(', '));
  } else {
    if (!values['account-file'] || !operations.includes(values.operation)) throw new Error('Provide a private account file and a supported operation.');
    const account = JSON.parse(await readFile(values['account-file'], 'utf8'));
    const endpoint = new URL(account.schoolEndpoint);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/')
      throw new Error('Account file must contain the school HTTPS origin.');
    if (typeof account.loginName !== 'string' || typeof account.password !== 'string') throw new Error('Invalid private account file.');
    const call = async (route, input, cookie) => {
      const response = await fetch(new URL('/api/learning/'+route, endpoint), { method: 'POST', redirect: 'error',
        signal: AbortSignal.timeout(120000), headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(input) });
      if (!response.ok) {
        const failure = await response.json().catch(() => ({}));
        const code = ['forbidden', 'invalid', 'missing', 'conflict', 'identity-conflict', 'maintenance', 'unavailable'].includes(failure.error) ? failure.error : 'request-failed';
        throw new Error(`${route}: ${code} (HTTP ${response.status})`);
      }
      return { value: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
    };
    const session = await call('login', { loginName: account.loginName, password: account.password });
    if (!session.cookie) throw new Error('School did not establish a session.');
    try {
      const input = values.file ? JSON.parse(await readFile(values.file, 'utf8')) : {};
      const result = await call('manage/'+values.operation, input, session.cookie);
      console.log(JSON.stringify(result.value));
    } finally { await call('logout', {}, session.cookie).catch(() => {}); }
  }
} catch (error) {
  // JSON parser and transport errors can include private input fragments. Only authored errors are displayed.
  const message = error instanceof Error && /^(Provide |Invalid private |Account file |School did |(?:manage\/|login:))/.test(error.message)
    ? error.message : 'Could not complete the school operation; check private input and connectivity.';
  console.error(message); process.exitCode = 1;
}
