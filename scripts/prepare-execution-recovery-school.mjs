#!/usr/bin/env node
/**
 * Builds the course payload an independent school node imports for #188.
 * Runs in the workspace: component packages need the workspace contracts and esbuild.
 * The emitted JSON is public teaching material plus a fresh member name/password;
 * keep the file in the acceptance private root and never commit credentials.
 */
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { annotationPackage } from '../components/material-annotation/package.mjs';
import { aggregationPackage } from '../components/table-aggregation/package.mjs';
import { accumulatorPackage } from '../components/state-accumulator/package.mjs';

const { values } = parseArgs({ options: { out: { type: 'string' } } });
if (!values.out) throw new Error('usage: --out <payload.json>');
const out = resolve(values.out);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const definitions = [await annotationPackage(), await aggregationPackage(), await accumulatorPackage()];
const material = Buffer.from('先区分观察到的事实与自己的解释。保留原始记录，再根据新的证据修订理解。');
const courseId = randomUUID(), taskId = randomUUID(), releaseId = randomUUID(), materialId = randomUUID();
const payload = {
  formatVersion: 1, courseId, taskId, releaseId,
  loginName: 'wp03-188-' + randomUUID().slice(0, 8), password: randomUUID(),
  course: { courseId, name: 'WP03 #188 跨机恢复验收' },
  task: { taskId, title: '重开原作品与实验记录', summary: '真实备份、隔离还原与正式接管' },
  release: {
    releaseId, objectives: ['保持原作品、输入与执行身份'],
    requirements: '标注材料、计算固定表格，并为真实会话保存检查点。',
    starterWorks: [], capabilities: [],
    components: [
      { key: 'annotation', definition: definitions[0], configuration: { title: '材料标注' }, materialIds: [materialId] },
      { key: 'table', definition: definitions[1], configuration: { title: '表格聚合' }, materialIds: [] },
      { key: 'accumulator', definition: definitions[2], configuration: { title: '四态累加模拟' }, materialIds: [] },
    ],
    materials: [{ materialId, title: '阅读材料', path: 'material.txt', mediaType: 'text/plain', access: 'student',
      byteLength: material.length, sha256: hash(material) }],
  },
  resources: [{ path: 'material.txt', contentBase64: material.toString('base64') }],
  definitions,
};
await writeFile(out, JSON.stringify(payload) + '\n', { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ payload: out, courseId, taskId, releaseId, loginName: payload.loginName }));
