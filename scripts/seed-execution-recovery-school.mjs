#!/usr/bin/env node
/**
 * Runs on the independent school node for #188. Imports the prepared course from
 * public bytes only, creates one scoped school member and emits the actor state.
 * Run with NODE_EXTRA_CA_CERTS pointing at this acceptance's CA so the public
 * HTTPS endpoint keeps full certificate verification. Passwords and the control
 * token stay in the supplied private output file, never in argv or stdout.
 */
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  endpoint: { type: 'string' }, root: { type: 'string' }, package: { type: 'string' },
  payload: { type: 'string' }, out: { type: 'string' },
} });
for (const key of ['endpoint', 'root', 'package', 'payload', 'out'])
  if (!values[key]) throw new Error(`usage: --endpoint=URL --root=DIR --package=DIR --payload=FILE --out=FILE`);
const root = resolve(values.root);
const product = resolve(values.package);
const runtime = await import(pathToFileURL(join(product, 'app/product-runtime.js')).href);
const token = await runtime.resolveCredential(root, 'control');
const payload = JSON.parse(await readFile(resolve(values.payload), 'utf8'));
const api = async (route, body) => {
  const response = await fetch(new URL('/api/learning/' + route, values.endpoint), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${route} ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
};
const identities = [];
for (const definition of payload.definitions)
  identities.push(await api('manage/component-import', { requestId: randomUUID(), ...definition }));
const release = { ...payload.release,
  components: payload.release.components.map((item, index) => ({ ...item, definition: identities[index] })) };
await api('manage/course-import', { formatVersion: 1, requestId: randomUUID(),
  course: payload.course, task: payload.task, release, resources: payload.resources });
const member = await api('manage/members', { requestId: randomUUID(), loginName: payload.loginName, password: payload.password });
await api('manage/course-access', { requestId: randomUUID(), courseId: payload.courseId,
  principalId: member.principalId, active: true });
const status = JSON.parse(await readFile(join(root, 'status.json'), 'utf8'));
const environment = status.environment;
const state = {
  endpoint: values.endpoint, environmentId: environment.environmentId,
  serviceId: environment.services[0].serviceId,
  receiverId: `${environment.environmentId}/${environment.services[0].serviceId}`,
  installationId: environment.installationId,
  courseId: payload.courseId, taskId: payload.taskId, releaseId: payload.releaseId,
  loginName: payload.loginName, password: payload.password, principalId: member.principalId,
  controlToken: token,
};
await writeFile(resolve(values.out), JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ state: resolve(values.out), receiverId: state.receiverId, releaseId: state.releaseId }));
