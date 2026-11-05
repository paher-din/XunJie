import { mkdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { componentManifestSchema } from '@xunjie/contracts/components';
import { join, resolve } from 'node:path';
import { accumulatorPackage } from '../components/state-accumulator/package.mjs';
import { parseArgs } from './remote-probe-helpers.mjs';

/** Builds the native-session course payload the independent school node imports for #175. */
const output = resolve(process.env.XUNJIE_EXECUTION_OUTPUT ?? '.verification/wp03-175');
await mkdir(output, { recursive: true });
const args = parseArgs();
const published = await accumulatorPackage();
if (Object.hasOwn(args, 'linux-proc')) {
  published.manifest.componentId = '7b678a40-d654-4ead-81be-27a717e86d73';
  published.manifest.entry.resourceId = published.manifest.version === 2
    ? 'bf2020b5-d806-486d-9bda-54ab0bfe7117' : '0496a3c9-4d4a-40d6-a4c7-9b6b38d2b65d';
  published.manifest.title = 'Linux 进程累加观察';
  published.manifest.session.adapterId = 'linux-proc-accumulator';
  published.manifest.session.operation.result.properties.pid = { type: 'number' };
  published.manifest.session.operation.result.properties.threads = { type: 'number' };
}
published.manifest = componentManifestSchema.parse(published.manifest);
const definitionDigest = createHash('sha256').update(JSON.stringify(published.manifest)).digest('hex');
const courseId = randomUUID(), taskId = randomUUID(), releaseId = randomUUID();
const payload = {
  courseId, taskId, releaseId, definitionDigest,
  loginName: 'school-native-175-' + randomUUID().slice(0, 8), password: randomUUID(),
  course: { courseId, name: '跨机原生会话验收' },
  task: { taskId, title: '观察四态累加', summary: '在学校执行节点上连续输入并观察真实内部状态' },
  configuration: { title: published.manifest.title },
  release: { helpPolicy: { version: 1, questions: 'allowed', scope: 'course' },
    releaseId, objectives: ['连续输入并观察真实内部状态'], requirements: '依次输入 1、2、2，观察 1、3、1。',
    starterWorks: [], capabilities: [], materials: [],
  },
  resources: [],
  component: published,
};
const path = join(output, 'remote-native-payload.json');
await writeFile(path, JSON.stringify(payload, null, 2) + '\n');
console.log(JSON.stringify({ payload: path, releaseId, loginName: payload.loginName,
  adapterId: published.manifest.session.adapterId, definitionDigest }));
