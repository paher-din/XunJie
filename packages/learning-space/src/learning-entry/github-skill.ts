import { createHash } from 'node:crypto';
import { z } from 'zod';
import { teachingSkillLimits, teachingSkillPathSchema, type TeachingSkillImport } from '@xunjie/contracts/agent-skills';

export type GithubSkillPackage = Pick<TeachingSkillImport, 'source' | 'packageVersion' | 'files'>;
type ErrorCode = 'invalid-url' | 'not-found' | 'rate-limit' | 'too-large' | 'invalid-package' | 'upstream' | 'timeout';
export class GithubSkillImportError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) { super(message); this.name = 'GithubSkillImportError'; this.code = code; }
}
function fail(code: ErrorCode, message: string): never { throw new GithubSkillImportError(code, message); }
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const repositorySchema = z.object({ private: z.literal(false), full_name: z.string(), default_branch: z.string().min(1).max(255) });
const commitSchema = z.object({ sha, commit: z.object({ tree: z.object({ sha }) }) });
const entrySchema = z.object({ path: z.string().min(1).max(4096), sha, type: z.enum(['blob', 'tree', 'commit']),
  mode: z.enum(['100644', '100755', '040000', '120000', '160000']), size: z.number().int().nonnegative().optional() });
const maxDepth = 16, maxTreeEntries = teachingSkillLimits.files * maxDepth;
const treeSchema = z.object({ sha, truncated: z.literal(false), tree: z.array(entrySchema).max(maxTreeEntries) });
const textExtensions = /\.(?:md|txt|json|ya?ml|toml|csv|tsv|html?|css|[cm]?js|tsx?|jsx|py|sh|bash|sql|xml|svg)$/i;
const treeResponseBytes = maxTreeEntries * 512 + 65536;
const maxRequests = teachingSkillLimits.files + maxDepth * 2 + 8;
const maxWireBytes = teachingSkillLimits.packageBytes + treeResponseBytes * 2;

function parseUrl(input: string) {
  // Validate the original spelling before URL can normalize backslashes or dot segments.
  if (typeof input !== 'string' || input.length > 2000) fail('invalid-url', '请填写 GitHub 公共仓库或 tree 目录链接。');
  const match = /^https:\/\/github\.com\/([^?#]+)$/i.exec(input.trim());
  if (!match) fail('invalid-url', '仅支持 https://github.com 的仓库或 tree 目录链接，不支持查询参数和片段。');
  let parts: string[];
  try { parts = match[1]!.replace(/\/$/, '').split('/').map(part => decodeURIComponent(part)); }
  catch { return fail('invalid-url', 'GitHub 链接编码无效。'); }
  if (parts.some(part => !part || part === '.' || part === '..' || /[\/\\%:\x00-\x20\x7f]/.test(part)
    || part.normalize('NFC') !== part)) fail('invalid-url', 'GitHub 链接包含不规范路径。');
  const owner = parts[0]!, repo = (parts[1] ?? '').replace(/\.git$/, '');
  if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i.test(owner)
    || !/^[a-z0-9_.-]{1,100}$/i.test(repo) || repo === '.' || repo === '..'
    || (parts.length > 2 && (parts[2] !== 'tree' || parts.length < 4)) || parts.length > maxDepth + 4)
    fail('invalid-url', '请使用完整仓库链接或 /tree/版本/目录 链接。');
  return { owner, repo, tail: parts.slice(3) };
}
function validRef(ref: string) {
  return ref.length <= 255 && ref !== '@' && !/[~^:?*\[\\\x00-\x20\x7f]/.test(ref)
    && !ref.includes('..') && !ref.includes('@{')
    && ref.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock'));
}
function packagePath(path: string) {
  if (!teachingSkillPathSchema.safeParse(path).success || path.split('/').length > maxDepth)
    fail('invalid-package', 'Skill 包含不规范或过深的相对路径。');
}

/** Server only. No token, arbitrary URL, returned API link, download_url or redirect is ever followed.
 * Root URLs use the default branch; tree URLs resolve the longest existing ref prefix (including slash refs).
 * The chosen directory itself must contain the sole SKILL.md. No ancestor/sibling package is inferred.
 * API requests only resolve metadata. Files use commit-pinned raw URLs, bounded concurrency,
 * and Git object hashes, so larger packages do not require one API quota entry per file.
 * YAML metadata validation remains with the existing skills.import operation.
 */
export async function fetchGithubSkill(url: string): Promise<GithubSkillPackage> {
  const { owner, repo, tail } = parseUrl(url);
  const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), teachingSkillLimits.githubReadTimeoutMs);
  let requests = 0, wireBytes = 0;
  async function read(endpoint: string, limit: number, api: boolean, allowMissing = false) {
    controller.signal.throwIfAborted();
    if (++requests > maxRequests) fail('too-large', 'GitHub 导入请求数超出限制。');
    const response = await fetch(endpoint, { method: 'GET', redirect: 'error', credentials: 'omit',
      headers: { 'user-agent': 'XunJie-Skill-Import', ...(api
        ? { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' } : { accept: 'application/octet-stream' }) },
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) });
    const cancel = async () => { await response.body?.cancel(); };
    if (response.redirected || (response.url && response.url !== endpoint) || (response.status >= 300 && response.status < 400)) {
      await cancel(); fail('upstream', 'GitHub 返回了重定向；请使用仓库当前的规范链接。');
    }
    const missingCommit = allowMissing && response.status === 422;
    if (response.status !== 200 && !missingCommit) {
      await cancel();
      if (response.status === 404 && allowMissing) return null;
      if (response.status === 404) fail('not-found', '未找到 GitHub 公共仓库、版本或目录。');
      if (response.status === 403 || response.status === 429) fail('rate-limit', 'GitHub 暂时拒绝读取或已达到公共 API 限流，请稍后重试。');
      fail('upstream', `GitHub 读取失败（HTTP ${response.status}）。`);
    }
    const length = response.headers.get('content-length');
    if (length && (!/^\d+$/.test(length) || Number(length) > limit || wireBytes + Number(length) > maxWireBytes)) {
      await cancel(); fail('too-large', 'GitHub 响应超出读取限制。');
    }
    if (!response.body) fail('upstream', 'GitHub 返回了空响应。');
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength; wireBytes += value.byteLength;
        if (size > limit || wireBytes > maxWireBytes) fail('too-large', 'GitHub 响应超出读取限制。');
        chunks.push(value);
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
    return { bytes: Buffer.concat(chunks), missingCommit };
  }
  async function request<T>(path: string, schema: z.ZodType<T>, limit: number, allowMissing = false): Promise<T | null> {
    const response = await read(`${base}${path}`, limit, true, allowMissing);
    if (!response) return null;
    let raw: unknown;
    try { raw = JSON.parse(response.bytes.toString('utf8')); }
    catch { return fail('upstream', 'GitHub 返回了无效 JSON。'); }
    if (response.missingCommit) {
      const error = z.object({ message: z.string() }).safeParse(raw);
      if (error.success && error.data.message.startsWith('No commit found for SHA: ')) return null;
      fail('upstream', 'GitHub 读取版本失败（HTTP 422）。');
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) fail('upstream', 'GitHub 返回了无效数据或不完整的目录。');
    return parsed.data;
  }
  try {
    const repository = (await request('', repositorySchema, 128 * 1024))!;
    if (repository.full_name.toLowerCase() !== `${owner}/${repo}`.toLowerCase())
      fail('upstream', 'GitHub 返回的仓库与链接不符。');
    let commit: z.infer<typeof commitSchema> | null = null, directory: string[] = [];
    const refs = tail.length ? tail : [repository.default_branch];
    // Longest prefix prevents silently selecting main when main/skill is itself a branch.
    const fixedCommit = /^[a-f0-9]{40}$/i.test(refs[0]!);
    for (let count = fixedCommit ? 1 : refs.length; count >= 1; count--) {
      const ref = refs.slice(0, count).join('/');
      if (!validRef(ref)) continue;
      commit = await request(`/commits/${encodeURIComponent(ref)}?per_page=1`, commitSchema, 256 * 1024, true);
      if (!commit) continue;
      if (/^[a-f0-9]{40}$/i.test(ref) && commit.sha !== ref.toLowerCase()) fail('upstream', 'GitHub commit 与固定版本不符。');
      directory = tail.length ? tail.slice(count) : [];
      break;
    }
    if (!commit) fail('not-found', '未找到 GitHub 分支、标签或 commit。');
    if (directory.length) packagePath(directory.join('/'));
    let treeSha = commit.commit.tree.sha;
    for (const part of directory) {
      const parent = (await request(`/git/trees/${treeSha}`, treeSchema, treeResponseBytes))!;
      if (parent.sha !== treeSha) fail('upstream', 'GitHub 目录版本不符。');
      const children = parent.tree.filter(entry => entry.path === part);
      if (children.length !== 1 || children[0]!.type !== 'tree' || children[0]!.mode !== '040000')
        fail('not-found', 'GitHub 链接必须指向真实的 Skill 包目录。');
      treeSha = children[0]!.sha;
    }
    const tree = (await request(`/git/trees/${treeSha}?recursive=1`, treeSchema, treeResponseBytes))!;
    if (tree.sha !== treeSha) fail('upstream', 'GitHub 目录版本不符。');
    const paths = new Map<string, z.infer<typeof entrySchema>>();
    for (const entry of tree.tree) {
      packagePath(entry.path);
      const key = entry.path.toLowerCase();
      if (paths.has(key)) fail('invalid-package', 'Skill 包中包含重名路径。');
      paths.set(key, entry);
      if (!(entry.type === 'tree' && entry.mode === '040000')
        && !(entry.type === 'blob' && (entry.mode === '100644' || entry.mode === '100755')))
        fail('invalid-package', 'Skill 包不能包含符号链接或 Git 子模块。');
    }
    const entries = tree.tree.filter(entry => entry.type === 'blob').sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    if (!entries.length || entries.length > teachingSkillLimits.files) fail('too-large', `Skill 包最多包含 ${teachingSkillLimits.files} 个文件。`);
    const roots = entries.filter(entry => entry.path === 'SKILL.md' || entry.path.endsWith('/SKILL.md'));
    if (roots.length !== 1 || roots[0]!.path !== 'SKILL.md')
      fail('invalid-package', '所选目录必须包含唯一的根文件 SKILL.md；请链接到具体 Skill 包目录。');
    let total = 0;
    for (const entry of entries) {
      const parts = entry.path.toLowerCase().split('/');
      for (let depth = 1; depth < parts.length; depth++) {
        if (paths.get(parts.slice(0, depth).join('/'))?.type !== 'tree') fail('invalid-package', 'Skill 包目录结构不完整或存在路径冲突。');
      }
      if (entry.size === undefined) fail('upstream', 'GitHub 未提供文件大小。');
      total += entry.size;
      if (entry.size > teachingSkillLimits.fileBytes || total > teachingSkillLimits.packageBytes
        || (entry.path === 'SKILL.md' && entry.size > teachingSkillLimits.bodyBytes))
        fail('too-large', `Skill 包超出大小限制：单文件 ${teachingSkillLimits.fileBytes / 1048576} MiB、整包 ${teachingSkillLimits.packageBytes / 1048576} MiB、SKILL.md ${teachingSkillLimits.bodyBytes / 1048576} MiB。`);
    }
    const files: GithubSkillPackage['files'] = new Array(entries.length);
    const rawBase = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${commit.sha}/`;
    let next = 0;
    async function download() {
      for (;;) {
        const index = next++, entry = entries[index];
        if (!entry) return;
        const path = [...directory, ...entry.path.split('/')].map(encodeURIComponent).join('/');
        const { bytes } = (await read(rawBase + path, entry.size!, false))!;
        if (bytes.length !== entry.size
          || createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== entry.sha)
          fail('upstream', 'GitHub 文件内容、大小或摘要与固定版本不符。');
        if (bytes.subarray(0, 100).toString('utf8').startsWith('version https://git-lfs.github.com/spec/v1'))
          fail('invalid-package', 'Skill 包包含 Git LFS 指针，无法读取完整包。');
        if (entry.path === 'SKILL.md' || textExtensions.test(entry.path)) {
          try {
            files[index] = { path: entry.path, encoding: 'utf8', content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) };
            continue;
          } catch { if (entry.path === 'SKILL.md') fail('invalid-package', 'SKILL.md 必须是 UTF-8 文本。'); }
        }
        files[index] = { path: entry.path, encoding: 'base64', content: bytes.toString('base64') };
      }
    }
    await Promise.all(Array.from({ length: Math.min(8, entries.length) }, download));
    const path = directory.length ? `/${directory.map(encodeURIComponent).join('/')}` : '';
    return { source: `https://github.com/${owner}/${repo}/tree/${commit.sha}${path}`, packageVersion: commit.sha, files };
  } catch (error) {
    if (error instanceof GithubSkillImportError) throw error;
    if (controller.signal.aborted || (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)))
      fail('timeout', 'GitHub 读取超时，请稍后重试。');
    fail('upstream', '无法连接 GitHub 公共 API，或请求发生了不允许的重定向。');
  } finally { clearTimeout(timer); controller.abort(); }
}
