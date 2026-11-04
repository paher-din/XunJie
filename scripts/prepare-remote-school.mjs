import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { aggregationPackage } from '../components/table-aggregation/package.mjs';

/**
 * Builds the course payload an independent school node imports. The component itself is published
 * by the school node from these bytes; the client never needs the workspace or the component source.
 */
const output = resolve(process.env.XUNJIE_EXECUTION_OUTPUT ?? '.verification/wp03-175');
await mkdir(output, { recursive: true });
const definition = await aggregationPackage();
const courseId = randomUUID(), taskId = randomUUID(), releaseId = randomUUID();
const payload = {
  formatVersion: 1,
  courseId, taskId, releaseId,
  loginName: 'school-remote-175',
  password: randomUUID(),
  course: { courseId, name: '跨机远端执行验收' },
  task: { taskId, title: '学校入口浏览器计算', summary: '不装本机库，直接在学校网页上计算' },
  release: {
    releaseId, objectives: ['学校网页完成浏览器计算'], requirements: '在学校入口编辑表格并运行计算。',
    starterWorks: [], capabilities: [],
    components: [{ key: 'table', definition, configuration: { title: '表格聚合' }, materialIds: [] }],
    materials: [],
  },
  resources: [],
  definition,
};
const path = join(output, 'remote-school-payload.json');
await writeFile(path, JSON.stringify(payload, null, 2) + '\n');
console.log(JSON.stringify({ payload: path, releaseId, courseId, taskId, loginName: payload.loginName }));
