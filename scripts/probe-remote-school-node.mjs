import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { parseArgs, createLearningApi } from './remote-probe-helpers.mjs';
import { dirname, resolve } from 'node:path';

/**
 * Runs on the school execution node. The client has no administrator token and no database, so the
 * node imports the course, enrolls one school-shared member and grants access to that course. The
 * emitted state file carries only what a browser needs: endpoint, release, login and password.
 */
const args = parseArgs();
const endpoint = args.endpoint;
const controlFile = args.control;
const payloadFile = args.payload;
const out = resolve(args.out ?? 'remote-school-state.json');
if (!endpoint || !controlFile || !payloadFile) {
  throw new Error('usage: --endpoint=URL --control=FILE --payload=FILE [--out=FILE]');
}
const token = (await readFile(controlFile, 'utf8')).trim();
const payload = JSON.parse(await readFile(payloadFile, 'utf8'));

const request = createLearningApi(endpoint, token);
async function api(route, body) {
  const result = await request(route, body);
  if (result.status < 200 || result.status >= 300)
    throw new Error(`${route} ${result.status}: ${JSON.stringify(result.value).slice(0, 300)}`);
  return result.value;
}

const definition = await api('manage/component-import', { requestId: randomUUID(), ...payload.definition });
// A release names the imported definition identity, not the package bytes it was imported from.
const release = {
  ...payload.release,
  components: payload.release.components.map(item => ({ ...item, definition })),
};
await api('manage/course-import', {
  formatVersion: 1, requestId: randomUUID(),
  course: payload.course, task: payload.task, release, resources: payload.resources,
});
const member = await api('manage/members', { requestId: randomUUID(), loginName: payload.loginName, password: payload.password });
await api('manage/course-access', { requestId: randomUUID(), courseId: payload.courseId, principalId: member.principalId, active: true });
const state = {
  endpoint, releaseId: payload.releaseId, courseId: payload.courseId, taskId: payload.taskId,
  releaseDigest: definition.digest ?? null, loginName: payload.loginName, password: payload.password,
  principalId: member.principalId, memberTarget: member.target ?? null,
};
await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(state, null, 2) + '\n');
console.log(JSON.stringify({ state: out, releaseId: state.releaseId, principalId: state.principalId }));
