import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { teachingSkillLimits, teachingSkillImportSchema } from '@xunjie/contracts/agent-skills';
import { fetchGithubSkill, GithubSkillImportError } from './github-skill.ts';

const commitSha = 'a'.repeat(40), rootSha = 'b'.repeat(40), packageSha = 'c'.repeat(40);
const skillText = '---\nname: example\ndescription: A useful skill\n---\n# 示例\n';
const hash = (bytes: Buffer) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
type Entry = { path: string; sha: string; type: string; mode: string; size?: number };
type Reply = object | (() => Response | Promise<Response>);

function fixture(t: TestContext, options: { directory?: string; ref?: string; files?: Record<string, string | Buffer> } = {}) {
  const ref = options.ref ?? 'main', directory = options.directory ?? '';
  const sourceFiles = options.files ?? { 'SKILL.md': skillText, 'references/说明.md': '\ufeff保留 BOM\n',
    'scripts/run.py': 'print("hello")\n', 'assets/icon.bin': Buffer.from([0, 255, 1]), 'invalid.txt': Buffer.from([255]) };
  const routes = new Map<string, Reply>();
  const calls: string[] = [];
  const entries: Entry[] = [], directories = new Set<string>();
  for (const [path, value] of Object.entries(sourceFiles)) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const sha = hash(bytes);
    entries.push({ path, sha, type: 'blob', mode: path.endsWith('.py') ? '100755' : '100644', size: bytes.length });
    routes.set(`raw:${path}`, () => new Response(bytes));
    const parts = path.split('/');
    for (let depth = 1; depth < parts.length; depth++) directories.add(parts.slice(0, depth).join('/'));
  }
  for (const path of directories) entries.push({ path, sha: 'd'.repeat(40), type: 'tree', mode: '040000' });
  routes.set('', { private: false, full_name: 'example/skills', default_branch: ref });
  routes.set(`/commits/${encodeURIComponent(ref)}?per_page=1`, { sha: commitSha, commit: { tree: { sha: rootSha } } });
  const parts = directory ? directory.split('/') : [];
  let currentSha = rootSha;
  for (let index = 0; index < parts.length; index++) {
    const nextSha = index === parts.length - 1 ? packageSha : createHash('sha1').update(String(index)).digest('hex');
    routes.set(`/git/trees/${currentSha}`, { sha: currentSha, truncated: false,
      tree: [{ path: parts[index], sha: nextSha, type: 'tree', mode: '040000' },
        { path: 'unrelated-link', sha: 'e'.repeat(40), type: 'blob', mode: '120000', size: 1 }] });
    currentSha = nextSha;
  }
  const treeRoute = `/git/trees/${currentSha}?recursive=1`;
  const tree = { sha: currentSha, truncated: false, tree: entries };
  routes.set(treeRoute, tree);
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const endpoint = new URL(String(input));
    assert.equal(endpoint.username, ''); assert.equal(endpoint.password, '');
    assert.equal(init?.redirect, 'error'); assert.equal(init?.credentials, 'omit');
    assert.equal(init?.method, 'GET'); assert.ok(init.signal instanceof AbortSignal);
    assert.equal(new Headers(init.headers).get('authorization'), null);
    let route: string;
    if (endpoint.origin === 'https://raw.githubusercontent.com') {
      const prefix = `/example/skills/${commitSha}/${directory ? directory.split('/').map(encodeURIComponent).join('/') + '/' : ''}`;
      assert.ok(endpoint.pathname.startsWith(prefix));
      assert.equal(endpoint.search, '');
      route = 'raw:' + decodeURIComponent(endpoint.pathname.slice(prefix.length));
    } else {
      assert.equal(endpoint.origin, 'https://api.github.com');
      assert.ok(endpoint.pathname.startsWith('/repos/example/skills'));
      route = endpoint.pathname.slice('/repos/example/skills'.length) + endpoint.search;
    }
    calls.push(route);
    const reply = routes.get(route);
    if (!reply) return route.startsWith('/commits/')
      ? Response.json({ message: `No commit found for SHA: ${route}` }, { status: 422 })
      : Response.json({ message: 'Not Found' }, { status: 404 });
    return typeof reply === 'function' ? reply() : Response.json(reply);
  });
  return { routes, calls, entries, tree, treeRoute,
    url: `https://github.com/example/skills${directory || options.ref ? `/tree/${ref}${directory ? '/' + directory : ''}` : ''}` };
}
function code(expected: GithubSkillImportError['code']) {
  return (error: unknown) => error instanceof GithubSkillImportError && error.code === expected;
}

test('imports the complete package, preserves bytes and paths, pins provenance to a commit', async t => {
  const f = fixture(t);
  const result = await fetchGithubSkill(f.url + '.git/');
  assert.equal(result.packageVersion, commitSha);
  assert.equal(result.source, `https://github.com/example/skills/tree/${commitSha}`);
  assert.deepEqual(result.files, [
    { path: 'SKILL.md', encoding: 'utf8', content: skillText },
    { path: 'assets/icon.bin', encoding: 'base64', content: 'AP8B' },
    { path: 'invalid.txt', encoding: 'base64', content: '/w==' },
    { path: 'references/说明.md', encoding: 'utf8', content: '\ufeff保留 BOM\n' },
    { path: 'scripts/run.py', encoding: 'utf8', content: 'print("hello")\n' },
  ]);
  assert.ok(teachingSkillImportSchema.safeParse({ requestId: '00000000-0000-4000-8000-000000000001', ...result }).success);
  assert.equal(f.calls.filter(path => path.startsWith('/commits/')).length, 1);
  assert.equal(f.calls.filter(path => path.startsWith('raw:')).length, 5);
});

test('reads only the selected subtree from the resolved commit; never follows returned API links', async t => {
  const f = fixture(t, { directory: 'skills/示例' });
  const result = await fetchGithubSkill(f.url.replace('示例', encodeURIComponent('示例')));
  assert.equal(result.source, `https://github.com/example/skills/tree/${commitSha}/skills/${encodeURIComponent('示例')}`);
  assert.ok(result.files.every(file => !file.path.startsWith('skills/')));
  assert.ok(f.calls.includes(`/git/trees/${rootSha}`));
  assert.ok(f.calls.includes(`/git/trees/${packageSha}?recursive=1`));
  assert.ok(!f.calls.includes(`/git/trees/${rootSha}?recursive=1`));
});

test('supports branches with slashes, tags and full commit URLs', async t => {
  for (const ref of ['feature/skill-import', 'v1.2.3', commitSha]) await t.test(ref, async t => {
    const f = fixture(t, { ref, directory: 'skills/demo' });
    const result = await fetchGithubSkill(f.url);
    assert.equal(result.packageVersion, commitSha);
    assert.ok(f.calls.includes(`/commits/${encodeURIComponent(ref)}?per_page=1`));
  });
});

test('latest follows the default branch while preserving the saved SHA source directory', async t => {
  for (const directory of ['', 'skills/示例']) await t.test(directory || 'root', async t => {
    const oldSha = 'e'.repeat(40), f = fixture(t, { ref: oldSha, directory });
    f.routes.set('', { private: false, full_name: 'example/skills', default_branch: 'release/current' });
    f.routes.delete(`/commits/${oldSha}?per_page=1`);
    f.routes.set('/commits/release%2Fcurrent?per_page=1', { sha: commitSha, commit: { tree: { sha: rootSha } } });
    const result = await fetchGithubSkill(f.url, { latest: true });
    assert.equal(result.packageVersion, commitSha);
    assert.equal(result.source, `https://github.com/example/skills/tree/${commitSha}${directory ? '/' + directory.split('/').map(encodeURIComponent).join('/') : ''}`);
    assert.equal(result.files.length, 5, 'Updates download the complete package, including attachments');
    assert.deepEqual(f.calls.filter(route => route.startsWith('/commits/')), ['/commits/release%2Fcurrent?per_page=1'],
      'Saved SHAs need not remain available to update their directory');
  });
});

test('latest resolves slash refs before switching to the default branch', async t => {
  const f = fixture(t, { ref: 'feature/skill-import', directory: 'skills/demo' });
  f.routes.set('', { private: false, full_name: 'example/skills', default_branch: 'main' });
  f.routes.set('/commits/feature%2Fskill-import?per_page=1', { sha: 'e'.repeat(40), commit: { tree: { sha: 'f'.repeat(40) } } });
  f.routes.set('/commits/main?per_page=1', { sha: commitSha, commit: { tree: { sha: rootSha } } });
  const result = await fetchGithubSkill(f.url, { latest: true });
  assert.equal(result.packageVersion, commitSha);
  assert.equal(result.source, `https://github.com/example/skills/tree/${commitSha}/skills/demo`);
});

test('latest reports a missing directory, allows retry, and still verifies downloaded object hashes', async t => {
  const f = fixture(t, { directory: 'demo' }), source = `https://github.com/example/skills/tree/${'e'.repeat(40)}/demo`;
  const parentRoute = `/git/trees/${rootSha}`, parent = f.routes.get(parentRoute)!;
  f.routes.delete(parentRoute);
  await assert.rejects(fetchGithubSkill(source, { latest: true }), code('not-found'));
  assert.ok(!f.calls.some(route => route.startsWith('raw:')));
  f.routes.set(parentRoute, parent);
  assert.equal((await fetchGithubSkill(source, { latest: true })).packageVersion, commitSha);
  f.entries[0]!.sha = 'f'.repeat(40);
  await assert.rejects(fetchGithubSkill(source, { latest: true }), code('upstream'));
});

test('latest false keeps fixed-commit imports pinned and root latest uses one default-branch lookup', async t => {
  for (const latest of [false, true]) await t.test(String(latest), async t => {
    const f = fixture(t, latest ? {} : { ref: commitSha });
    assert.equal((await fetchGithubSkill(f.url, { latest })).packageVersion, commitSha);
    assert.deepEqual(f.calls.filter(route => route.startsWith('/commits/')),
      [`/commits/${latest ? 'main' : commitSha}?per_page=1`]);
  });
});

test('chooses the longest existing ref rather than interpreting a slash branch as a directory', async t => {
  const f = fixture(t, { ref: 'main/skill', directory: 'demo' });
  f.routes.set('/commits/main?per_page=1', () => { throw new Error('wrong branch chosen'); });
  const result = await fetchGithubSkill(f.url);
  assert.equal(result.source, `https://github.com/example/skills/tree/${commitSha}/demo`);
});

test('does not treat generic GitHub 422 validation or abuse errors as missing refs', async t => {
  const f = fixture(t, { directory: 'demo' });
  f.routes.set('/commits/main%2Fdemo?per_page=1', () => Response.json({ message: 'Validation Failed' }, { status: 422 }));
  await assert.rejects(fetchGithubSkill(f.url), code('upstream'));
  assert.ok(!f.calls.includes('/commits/main?per_page=1'));
});

test('falls back on 404 for missing ref candidates and reports an absent version', async t => {
  const f = fixture(t, { directory: 'demo' });
  f.routes.set('/commits/main%2Fdemo?per_page=1', () => Response.json({ message: 'Not Found' }, { status: 404 }));
  assert.equal((await fetchGithubSkill(f.url)).packageVersion, commitSha);
  f.routes.delete('/commits/main?per_page=1');
  await assert.rejects(fetchGithubSkill(f.url), code('not-found'));
});

test('rejects deceptive and normalized-away URLs before any request', async t => {
  const f = fixture(t);
  for (const url of [
    'http://github.com/example/skills', 'https://github.com.evil.test/example/skills',
    'https://github.com@evil.test/example/skills', 'https://evil.test@github.com/example/skills',
    'https://github.com:443/example/skills', 'https://github.com./example/skills',
    'https://raw.githubusercontent.com/example/skills/main/SKILL.md',
    'https://github.com/example/skills/blob/main/SKILL.md', 'https://github.com/example/skills/tree',
    'https://github.com/example/skills?tab=readme-ov-file', 'https://github.com/example/skills#readme',
    'https://github.com/example/skills/tree/main/../demo', 'https://github.com/example/skills/tree/main/%2e%2e/demo',
    'https://github.com/example/skills/tree/main/a%2fb', 'https://github.com/example/skills/tree/main/a%5cb',
    'https://github.com/example/skills/tree/main/%252e%252e', 'https://github.com/example/skills/tree/main/%00x',
    'https://github.com/example/skills/tree/main/%xx', 'https://github.com/example//skills',
    'https://github.com\\@evil.test/example/skills',
  ]) await assert.rejects(fetchGithubSkill(url), code('invalid-url'), url);
  assert.deepEqual(f.calls, []);
});

test('rejects private/mismatched repository metadata and mismatched commit SHA', async t => {
  for (const kind of ['private', 'repository', 'commit']) await t.test(kind, async t => {
    const f = fixture(t, { ref: commitSha });
    if (kind === 'private') f.routes.set('', { private: true, full_name: 'example/skills', default_branch: 'main' });
    if (kind === 'repository') f.routes.set('', { private: false, full_name: 'other/skills', default_branch: 'main' });
    if (kind === 'commit') f.routes.set(`/commits/${commitSha}?per_page=1`, { sha: 'f'.repeat(40), commit: { tree: { sha: rootSha } } });
    await assert.rejects(fetchGithubSkill(f.url), code('upstream'));
    assert.ok(!f.calls.some(path => path.startsWith('/git/')));
  });
});

test('fails closed on redirects and upstream errors without fetching another host', async t => {
  for (const status of [301, 302, 307, 308, 403, 404, 429, 500]) await t.test(String(status), async t => {
    const f = fixture(t);
    f.routes.set('', () => new Response(null, { status, headers: { location: 'http://127.0.0.1/private' } }));
    await assert.rejects(fetchGithubSkill(f.url), code(status === 404 ? 'not-found'
      : [403, 429].includes(status) ? 'rate-limit' : 'upstream'));
    assert.deepEqual(f.calls, ['']);
  });
});

test('rejects truncated trees, mismatched tree versions and non-directory subtree links', async t => {
  for (const kind of ['truncated', 'sha', 'link']) await t.test(kind, async t => {
    const f = fixture(t, { directory: kind === 'link' ? 'demo' : '' });
    if (kind === 'truncated') f.tree.truncated = true;
    if (kind === 'sha') f.tree.sha = 'f'.repeat(40);
    if (kind === 'link') f.routes.set(`/git/trees/${rootSha}`, { sha: rootSha, truncated: false,
      tree: [{ path: 'demo', type: 'blob', mode: '120000', sha: 'e'.repeat(40), size: 1 }] });
    await assert.rejects(fetchGithubSkill(f.url), code(kind === 'link' ? 'not-found' : 'upstream'));
    assert.ok(!f.calls.some(path => path.startsWith('raw:')));
  });
});

test('rejects unsafe package paths, aliases, symlinks, submodules and incomplete hierarchies', async t => {
  const cases: Record<string, Partial<Entry>> = {
    traversal: { path: '../escape' }, backslash: { path: 'a\\b' }, percent: { path: '%2e%2e' },
    reserved: { path: 'assets/CON.txt' }, unicode: { path: 'e\u0301.md' }, deep: { path: 'a/'.repeat(16) + 'b' },
    alias: { path: 'skill.MD' }, 'directory-alias': { path: 'Assets', type: 'tree', mode: '040000' },
    symlink: { path: 'link', mode: '120000' }, submodule: { path: 'module', type: 'commit', mode: '160000' },
    missingParent: { path: 'missing/file' }, fileParent: { path: 'SKILL.md/file' },
  };
  for (const [name, change] of Object.entries(cases)) await t.test(name, async t => {
    const f = fixture(t);
    f.entries.push({ path: 'bad', sha: 'e'.repeat(40), type: 'blob', mode: '100644', size: 1, ...change });
    await assert.rejects(fetchGithubSkill(f.url), code('invalid-package'));
    assert.ok(!f.calls.some(path => path.startsWith('raw:')));
  });
});

test('requires a single SKILL.md in the selected package root', async t => {
  for (const files of [{ 'readme.md': 'readme' }, { 'nested/SKILL.md': skillText },
    { 'SKILL.md': skillText, 'nested/SKILL.md': skillText }]) await t.test(Object.keys(files).join(','), async t => {
    const f = fixture(t, { files });
    await assert.rejects(fetchGithubSkill(f.url), code('invalid-package'));
    assert.ok(!f.calls.some(path => path.startsWith('raw:')));
  });
});

test('enforces file count, per-file, SKILL.md and aggregate byte limits before downloading files', async t => {
  for (const kind of ['count', 'file', 'body', 'aggregate', 'missingSize']) await t.test(kind, async t => {
    const f = fixture(t, { files: { 'SKILL.md': skillText } });
    if (kind === 'count') for (let i = 0; i < teachingSkillLimits.files; i++) f.entries.push({ path: `${i}.txt`, sha: 'd'.repeat(40), type: 'blob', mode: '100644', size: 0 });
    if (kind === 'file') f.entries.push({ path: 'large.bin', sha: 'd'.repeat(40), type: 'blob', mode: '100644', size: teachingSkillLimits.fileBytes + 1 });
    if (kind === 'body') f.entries[0]!.size = teachingSkillLimits.bodyBytes + 1;
    if (kind === 'aggregate') for (let i = 0; i < 4; i++) f.entries.push({ path: `${i}.bin`, sha: 'd'.repeat(40), type: 'blob', mode: '100644', size: teachingSkillLimits.fileBytes });
    if (kind === 'missingSize') delete f.entries[0]!.size;
    await assert.rejects(fetchGithubSkill(f.url), code(kind === 'missingSize' ? 'upstream' : 'too-large'));
    assert.ok(!f.calls.some(path => path.startsWith('raw:')));
  });
});

test('accepts the full enlarged file and byte budgets without charging an API call for each file', async t => {
  const files: Record<string, string | Buffer> = { 'SKILL.md': skillText };
  files['assets/large.bin'] = Buffer.alloc(teachingSkillLimits.fileBytes, 255);
  files['assets/remainder.bin'] = Buffer.alloc(teachingSkillLimits.packageBytes - teachingSkillLimits.fileBytes - Buffer.byteLength(skillText), 254);
  for (let i = 0; i < teachingSkillLimits.files - 3; i++) files[`references/empty-${i}.txt`] = '';
  const f = fixture(t, { files });
  const result = await fetchGithubSkill(f.url);
  assert.equal(result.files.length, teachingSkillLimits.files);
  assert.equal(result.files.reduce((total, file) => total + Buffer.from(file.content, file.encoding === 'utf8' ? 'utf8' : 'base64').length, 0),
    teachingSkillLimits.packageBytes);
  assert.equal(f.calls.filter(path => !path.startsWith('raw:')).length, 3);
  assert.ok(teachingSkillImportSchema.safeParse({ requestId: '00000000-0000-4000-8000-000000000001', ...result }).success);
});

test('checks downloaded bytes against the size and Git object hash from the pinned tree', async t => {
  for (const kind of ['size', 'sha', 'bytes']) await t.test(kind, async t => {
    const f = fixture(t, { files: { 'SKILL.md': skillText } });
    const entry = f.entries[0]!;
    if (kind === 'sha') entry.sha = 'f'.repeat(40);
    const bytes = Buffer.from(kind === 'bytes' ? skillText.replace('example', 'changed') : skillText);
    f.routes.set('raw:SKILL.md', () => new Response(kind === 'size' ? bytes.subarray(1) : bytes));
    await assert.rejects(fetchGithubSkill(f.url), code('upstream'));
  });
});

test('rejects invalid UTF-8 in SKILL.md and unresolved LFS pointers', async t => {
  for (const value of [Buffer.from([255]), Buffer.from('version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 100\n')])
    await t.test(value[0] === 255 ? 'UTF-8' : 'LFS', async t => {
      const f = fixture(t, { files: { 'SKILL.md': value } });
      await assert.rejects(fetchGithubSkill(f.url), code('invalid-package'));
    });
});

test('bounds streamed bodies without trusting Content-Length and cancels an oversized stream', async t => {
  const f = fixture(t);
  let cancelled = false;
  f.routes.set('', () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(128 * 1024 + 1)); },
    cancel() { cancelled = true; },
  }), { headers: { 'content-length': '1' } }));
  await assert.rejects(fetchGithubSkill(f.url), code('too-large'));
  assert.ok(cancelled);
});

test('rejects oversized advertised responses without reading them', async t => {
  const f = fixture(t);
  let cancelled = false;
  f.routes.set('', () => new Response(new ReadableStream({ cancel() { cancelled = true; } }),
    { headers: { 'content-length': String(128 * 1024 + 1) } }));
  await assert.rejects(fetchGithubSkill(f.url), code('too-large'));
  assert.ok(cancelled);
});

test('the total deadline aborts a blocked request and releases its timer', async t => {
  const f = fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', async (_input: unknown, init: RequestInit) => new Promise<Response>((_, reject) => {
    init.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }));
  const pending = fetchGithubSkill(f.url);
  t.mock.timers.tick(teachingSkillLimits.githubReadTimeoutMs);
  await assert.rejects(pending, code('timeout'));
});
