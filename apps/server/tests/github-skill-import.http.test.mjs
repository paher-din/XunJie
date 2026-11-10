import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, request } from 'node:http';
import { test } from 'node:test';
import { createLearningEntry } from '@xunjie/learning-space';
import { StorageError } from '@xunjie/storage';

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
    [`/git/blobs/${blob}`, { sha: blob, size: bytes.length, encoding: 'base64', content: bytes.toString('base64') }],
  ]);
  t.mock.method(globalThis, 'fetch', async url => {
    const parsed = new URL(url);
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
