#!/usr/bin/env node
/**
 * Deploy and seed the independent #206 school node. Runs ON the school machine (cloud ECS).
 *
 * No browser and no student traffic originate here: student desktop Chrome clients on
 * different machines open the returned endpoint over pinned strict HTTPS. SSH is used
 * only to deploy, import public course bytes and read the control credential.
 * Secrets stay in the payload / private state file, never in argv or stdout.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  endpoint: { type: 'string' }, root: { type: 'string' }, package: { type: 'string' },
  payload: { type: 'string' }, out: { type: 'string' }, cert: { type: 'string' }, key: { type: 'string' },
} });
for (const name of ['endpoint', 'root', 'package', 'payload', 'out', 'cert', 'key'])
  if (!values[name]) throw new Error(`usage: --endpoint=URL --root=DIR --package=DIR --payload=FILE --out=FILE --cert=FILE --key=FILE`);

const product = resolve(values.package);
const runtime = await import(pathToFileURL(join(product, 'app/product-runtime.js')).href);
const root = resolve(values.root);
const endpoint = values.endpoint;
const url = new URL(endpoint);
const port = Number(url.port || 443);

const instance = runtime.openProductRuntime({ root, resources: {
  nodePath: join(product, 'resources/node/bin/node'), nodeVersion: '24.21.0',
  postgresBin: join(product, 'resources/postgres/bin'), postgresVersion: '18.6',
  webRoot: join(product, 'web'),
} });
await instance.install({ profile: 'school', database: { mode: 'managed' }, host: '0.0.0.0', port,
  publicEndpoint: endpoint, tls: { certificateFile: resolve(values.cert), keyFile: resolve(values.key) } });
const started = await instance.start();
assert.equal(started.environment.profile, 'school');
// A Linux school node has no Windows native-session helper: #188's node reports the same
// `degraded` state with required PostgreSQL ready and an optional `native-sessions` entry.
assert.ok(['ready', 'degraded'].includes(started.state), `unexpected school state ${started.state}`);
const status = JSON.parse(await readFile(join(root, 'status.json'), 'utf8'));
const required = (status.dependencies ?? []).filter(item => item.required);
assert.ok(required.length > 0 && required.every(item => item.state === 'ready'),
  `required dependencies not ready: ${JSON.stringify(required)}`);
const schoolState = { state: started.state, requiredDependencies: required, optionalDependencies: (status.dependencies ?? []).filter(item => !item.required) };

const admin = { authorization: `Bearer ${await runtime.resolveCredential(root, 'control')}` };
const api = async (route, body) => {
  const response = await fetch(new URL('/api/learning/' + route, endpoint), { method: 'POST',
    headers: { 'content-type': 'application/json', ...admin }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000) });
  const value = await response.json();
  assert.equal(response.status, 200, `${route}: ${JSON.stringify(value)}`);
  return value;
};
const payload = JSON.parse(await readFile(resolve(values.payload), 'utf8'));
const definition = await api('manage/component-import', payload.component);
payload.course.release.components[0].definition = definition;
await api('manage/course-import', payload.course);
const member = await api('manage/members', { requestId: randomUUID(), loginName: payload.loginName, password: payload.password });
assert.equal(member.target, undefined, 'the school member must not carry a device target');
await api('manage/course-access', { requestId: randomUUID(), courseId: payload.course.course.courseId,
  principalId: member.principalId, active: true });

// Pin the exact key the listener really serves; clients never disable TLS verification.
const spki = createHash('sha256').update(new X509Certificate(await readFile(resolve(values.cert)))
  .publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
const state = {
  endpoint, spki, loginName: payload.loginName, password: payload.password,
  courseId: payload.course.course.courseId, releaseId: payload.course.release.releaseId,
  courseTitle: payload.course.task.title, schoolHost: url.hostname, port,
  nodePlatform: process.platform, nodeArch: process.arch, nodeVersion: process.version,
  distributionSha256: createHash('sha256').update(await readFile(join(product, 'distribution.json'))).digest('hex'),
  startedAt: new Date().toISOString(),
};
await mkdir(dirname(resolve(values.out)), { recursive: true });
await writeFile(resolve(values.out), JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ endpoint, state: resolve(values.out), schoolHost: state.schoolHost,
  distributionSha256: state.distributionSha256 }));
