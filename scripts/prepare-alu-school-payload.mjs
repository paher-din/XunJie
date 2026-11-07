#!/usr/bin/env node
/**
 * Freeze the public #206 ALU component/course bytes on the workspace side.
 * The independent school node imports exactly this payload; no private value is echoed.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { aluPackage, aluCoursePackage } from '../components/alu-experiment/package.mjs';

const out = resolve(process.argv[2] ?? '.verification/wp04-206-cross/school-payload.json');
await mkdir(dirname(out), { recursive: true });
const component = await aluPackage(), course = await aluCoursePackage();
const payload = { component, course, loginName: 'wp04-206-cross-' + randomUUID().slice(0, 8), password: randomUUID() };
await writeFile(out, JSON.stringify(payload) + '\n', { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ out, releaseId: course.release.releaseId, courseId: course.course.courseId }));
