import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, request } from 'node:http';
import { test } from 'node:test';
import { createLearningEntry } from '@xunjie/learning-space';
import { StorageError } from '@xunjie/storage';
import { parseTeachingSkillPackage } from '../../../packages/learning-space/dist/teaching-agent/skills-package.js';
import { teachingSkillLimits } from '@xunjie/contracts/agent-skills';

test('GitHub package reads use the current identity and stay local for paired school spaces', async t => {
  const identity = { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), kind: 'personal', name: '学生' };
  const expected = [identity.environmentId, identity.spaceId, identity.principalId].join('.');
  const content = '---\nname: example\ndescription: 示例\n---\n正文';
  const bytes = Buffer.from(content), blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  const commit = 'a'.repeat(40), tree = 'b'.repeat(40), calls = [];
  const github = new Map([
    ['', { private: false, full_name: 'example/skills', default_branch: 'main' }],
    ['/commits/main?per_page=1', { sha: commit, commit: { tree: { sha: tree } } }],
    [`/git/trees/${tree}?recursive=1`, { sha: tree, truncated: false, tree: [{ path: 'SKILL.md', sha: blob, type: 'blob', mode: '100644', size: bytes.length }] }],
  ]);
  t.mock.method(globalThis, 'fetch', async url => {
    const parsed = new URL(url);
    if (parsed.origin === 'https://raw.githubusercontent.com') {
      assert.equal(parsed.pathname, `/example/skills/${commit}/SKILL.md`);
      return new Response(bytes);
    }
    assert.equal(parsed.origin, 'https://api.github.com');
    const value = github.get(parsed.pathname.slice('/repos/example/skills'.length) + parsed.search);
    assert.ok(value); return Response.json(value);
  });
  let entry;
  const server = createServer((req, res) => { void entry(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  entry = createLearningEntry({ environment: { environmentId: identity.environmentId, profile: 'local', clientNamespace: 'test', services: [{ endpoint }] },
    target: {}, spaces: { personal: async () => identity, bindMember: async () => {} }, learning: {}, teaching: {}, administratorToken: 'unused',
    client: { forward: async (...args) => { calls.push(args); if (args[3] !== expected) throw new StorageError('forbidden'); return { skills: [] }; } } });
  const post = (space, subject, url) => new Promise((resolve, reject) => {
    const req = request(endpoint + '/api/learning/skills/github-package', { method: 'POST', headers: {
      'content-type': 'application/json', 'x-xj-space': space, 'x-xj-namespace': 'test', 'x-xj-expected-subject': subject,
    } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on('error', reject); req.end(JSON.stringify({ url }));
  });
  const url = 'https://github.com/example/skills', school = `school:${randomUUID()}`;
  const personal = await post('personal', expected, url);
  assert.equal(personal.status, 200);
  assert.deepEqual(personal.body.files, [{ path: 'SKILL.md', encoding: 'utf8', content }]);
  assert.equal(personal.body.packageVersion, commit);
  const paired = await post(school, expected, url);
  assert.equal(paired.status, 200);
  assert.deepEqual(paired.body, personal.body);
  assert.equal(calls[0][1], 'skills');
  assert.equal((await post(school, 'wrong-subject', url)).status, 403);
  const invalid = await post('personal', expected, 'https://example.com/not-github');
  assert.deepEqual(invalid, { status: 400, body: { error: 'github-invalid-url' } });
});

test('larger local and GitHub envelopes reach direct, activity and paired-school import owners', async t => {
  const identity = { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), kind: 'personal', name: '学生' };
  const activityId = randomUUID(), school = `school:${randomUUID()}`, received = [];
  const input = { requestId: randomUUID(), source: 'larger-package', packageVersion: '1.0', files: [
    { path: 'SKILL.md', encoding: 'utf8', content: '---\nname: larger-package\ndescription: Larger package\n---\n' + 'x'.repeat(300000) },
    { path: 'sample.bin', encoding: 'base64', content: Buffer.alloc(9 * 1024 * 1024, 255).toString('base64') },
  ] };
  const body = JSON.stringify(input);
  assert.ok(Buffer.byteLength(body) > 8 * 1024 * 1024);
  const consume = value => {
    const parsed = parseTeachingSkillPackage(value);
    assert.equal(parsed.attachments[1].byteLength, 9 * 1024 * 1024);
    received.push(value.requestId);
    return { imported: true };
  };
  let entry;
  const server = createServer((req, res) => { void entry(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  entry = createLearningEntry({ environment: { environmentId: identity.environmentId, profile: 'local', clientNamespace: 'test', services: [{ endpoint }] },
    target: {}, spaces: { personal: async () => identity, bindMember: async () => {} }, learning: {}, teaching: { skills: { import: async (_identity, value) => consume(value) } }, administratorToken: 'unused',
    client: { forward: async (_id, _route, value) => consume(value) } });
  for (const space of ['personal', school]) for (const route of ['skills/import', `agent/${activityId}/skills/import`]) {
    const result = await new Promise((resolve, reject) => {
      const req = request(endpoint + '/api/learning/' + route, { method: 'POST', headers: {
        'content-type': 'application/json', 'x-xj-space': space, 'x-xj-namespace': 'test',
      } }, res => {
        res.resume(); res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject); req.end(body);
    });
    assert.equal(result, 200, space + ': ' + route);
  }
  assert.equal(received.length, 4);
});

test('package parsing checks decoded bytes and SKILL.md after the encoded string ceilings are enlarged', () => {
  const input = { requestId: randomUUID(), source: 'test', packageVersion: '1', files: [
    { path: 'SKILL.md', encoding: 'utf8', content: '---\nname: test\ndescription: Test\n---\n' },
  ] };
  assert.throws(() => parseTeachingSkillPackage({ ...input, files: [
    ...input.files, { path: 'too-large.txt', encoding: 'utf8', content: 'x'.repeat(teachingSkillLimits.fileBytes + 1) },
  ] }), { code: 'invalid' });
  assert.throws(() => parseTeachingSkillPackage({ ...input, files: [
    { ...input.files[0], content: input.files[0].content + 'x'.repeat(teachingSkillLimits.bodyBytes) },
  ] }), { code: 'invalid' });
});
