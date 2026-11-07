// Shared real-product setup for the Mac/Windows native IME acceptance probes.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function createAluImeProduct({ productRoot, packages }) {
  const candidate = resolve(productRoot);
  const declared = JSON.parse(await readFile(join(candidate, 'resources.json'), 'utf8'));
  const resources = { ...declared };
  for (const field of ['nodePath', 'postgresBin', 'webRoot', 'windowsPrerequisitePath', 'windowsSessionHelper']) {
    if (declared[field]) resources[field] = resolve(candidate, declared[field]);
  }
  const bundled = await import(pathToFileURL(join(candidate, 'app/product-runtime.js')).href);
  const root = await mkdtemp(join(tmpdir(), 'xj-alu-211-ime-'));
  const runtime = bundled.openProductRuntime({ root, resources });
  let environmentId, closed = false;
  const close = async () => {
    if (closed) return;
    environmentId ??= (await runtime.status()).environment.environmentId;
    await runtime.stop();
    await runtime.deleteEnvironment({ environmentId });
    closed = true;
  };
  try {
    environmentId = (await runtime.install({ profile: 'local' })).environment.environmentId;
    const { endpoint } = await runtime.start();
    const admin = { authorization: `Bearer ${await bundled.resolveCredential(root, 'control')}` };
    const api = async (route, body) => {
      const response = await fetch(endpoint + '/api/learning/' + route, { method: 'POST',
        headers: { 'content-type': 'application/json', ...admin }, body: JSON.stringify(body) });
      assert.equal(response.status, 200, `${route} status ${response.status}`);
      return response.json();
    };
    const component = JSON.parse(await readFile(join(resolve(packages), 'component.json'), 'utf8'));
    const course = JSON.parse(await readFile(join(resolve(packages), 'course.json'), 'utf8'));
    course.release.components[0].definition = await api('manage/component-import', component);
    await api('manage/course-import', course);
    const loginName = 'alu-ime-' + randomUUID(), password = randomUUID();
    const member = await api('manage/members', { requestId: randomUUID(), loginName, password });
    await api('manage/course-access', { requestId: randomUUID(), courseId: course.course.courseId,
      principalId: member.principalId, active: true });
    return { state: { endpoint, loginName, password, releaseId: course.release.releaseId }, close,
      provenance: { candidate, root, productNodeVersion: resources.nodeVersion,
        distributionSha256: createHash('sha256').update(await readFile(join(candidate, 'distribution.json'))).digest('hex') } };
  } catch (error) {
    try { await close(); }
    catch (cleanup) { throw new Error(`Product setup failed: ${error}; owner cleanup failed at ${root}: ${cleanup}`); }
    throw error;
  }
}
