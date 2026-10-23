import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { digest, jsonBytes, reproError, safeEntry } from './repro-archive.mjs';

export const CODE_ROOTS = ['apps/student/', 'apps/teaching/', 'tools/xj-dev/', 'README.md', 'AGENTS.md', 'CONTEXT.md', 'DESIGN.md', '.gitignore'];
export function excludedPath(path) {
  return /(?:^|\/)(?:\.git|node_modules|dist|coverage|evidence|hdl\.evidence|secrets|browser-profile)(?:\/|$)/i.test(path)
    || /^(?:personal-agent|personal-models)(?:\/|$)/i.test(path)
    || /(?:^|\/)(?:\.env(?:\..*)?|id_(?:rsa|ed25519)|.*\.(?:pem|key|sqlite|db)|accounts\.private\.txt)$/i.test(path)
    || path.startsWith('docs/archive/');
}

// Free-form material is opt-in; reject recognizable credentials rather than silently changing evidence.
export function assertShareable(bytes, label = '选中内容') {
  const value = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes);
  const assignments = [...value.matchAll(/["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|signing[_-]?secret|private[_-]?key)["']?\s*[:=]\s*["']([^"'\n]{8,})["']/gi)];
  // Explicitly invalid fixtures are public test inputs, not credentials. Everything else stays checked.
  const fixture = text => /^(?:synthetic(?:[-_ ]|$)|test(?:[-_ ]|$)|invalid(?:[-_ ]|$)|unconfigured$|placeholder$|changeme$)/i.test(text)
    || text === 'offline-test-key' || /(?:^|[-_ ])not[-_ ]a[-_ ]real[-_ ](?:credential|key|secret)/i.test(text);
  if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{25,})\b/.test(value)
    || assignments.some(match => !fixture(match[1]))) {
    throw reproError('SECRET_DETECTED', `${label} 包含疑似凭据；请缩小范围或先清理后重新采集。`);
  }
}

export function git(cwd, args, options = {}) {
  const result = spawnSync('git', ['-c', `core.hooksPath=${join(dirname(process.execPath), '.xj-dev-no-hooks')}`, '-c', 'core.fsmonitor=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'protocol.file.allow=always', ...args], {
    cwd, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 60_000,
    ...options,
    env: { ...process.env, GIT_CONFIG_COUNT: '0', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'XunJie Repro', GIT_AUTHOR_EMAIL: 'repro@invalid', GIT_COMMITTER_NAME: 'XunJie Repro', GIT_COMMITTER_EMAIL: 'repro@invalid',
      GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' },
  });
  if (result.status !== 0) throw reproError('GIT_FAILED', `Git 操作失败（${args[0]}）。请检查工作树和包内代码资源。`);
  return result.stdout;
}

export function validateCodePaths(paths) {
  const names = new Set();
  for (const path of paths) {
    safeEntry(path);
    const folded = path.normalize('NFC').toLowerCase();
    if (names.has(folded) || folded === '.git' || folded.startsWith('.git/')) throw reproError('UNSAFE_PATH', '源码路径存在跨平台大小写/Unicode 冲突。');
    names.add(folded);
  }
  for (const path of names) {
    const parts = path.split('/');
    while (parts.length > 1) { parts.pop(); if (names.has(parts.join('/'))) throw reproError('UNSAFE_PATH', '源码存在文件/目录路径冲突。'); }
  }
}

function inScope(path, roots) { return roots.some(root => path === root || path.startsWith(root.endsWith('/') ? root : root + '/')); }
function localFile(root, path) {
  safeEntry(path);
  const file = resolve(root, path);
  if (!file.startsWith(resolve(root) + sep)) throw reproError('UNSAFE_PATH', '源码路径越界。');
  let current = root;
  for (const part of path.split('/')) {
    current = join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw reproError('UNSAFE_PATH', '选中源码包含符号链接。');
  }
  if (!existsSync(file)) return undefined;
  if (!lstatSync(file).isFile()) throw reproError('UNSAFE_PATH', '选中源码必须是普通文件。');
  return readFileSync(file);
}

export function collectCode(worktree, scratch, spec = {}) {
  const roots = spec.roots ?? CODE_ROOTS;
  const selected = spec.paths ?? [];
  if (!Array.isArray(roots) || !roots.length || !Array.isArray(selected)) throw reproError('INVALID_CONTEXT', 'code.roots/paths 必须是路径数组。');
  for (const path of [...roots.map(p => p.replace(/\/$/, '')), ...selected]) {
    safeEntry(path);
    if (excludedPath(path) || path.startsWith('-')) throw reproError('EXCLUDED_SOURCE', '选中源码位于禁止共享的目录。');
  }
  const sourceCommit = git(worktree, ['rev-parse', '--verify', 'HEAD']).trim();
  const tree = git(worktree, ['ls-tree', '-rz', '--full-tree', sourceCommit], { encoding: null });
  const records = tree.toString().split('\0').filter(Boolean).map(line => {
    const tab = line.indexOf('\t'), [mode, type, oid] = line.slice(0, tab).split(' ');
    return { mode, type, oid, path: line.slice(tab + 1) };
  }).filter(row => inScope(row.path, roots) && !excludedPath(row.path));
  const files = new Map(), modes = new Map();
  const output = git(worktree, ['cat-file', '--batch'], { input: records.map(row => row.oid + '\n').join(''), encoding: null });
  let cursor = 0;
  for (const row of records) {
    if (!['100644', '100755'].includes(row.mode) || row.type !== 'blob') throw reproError('UNSAFE_PATH', '可分发源码不支持符号链接或子模块。');
    safeEntry(row.path);
    const end = output.indexOf(10, cursor), size = Number(output.subarray(cursor, end).toString().split(' ')[2]);
    const bytes = output.subarray(end + 1, end + 1 + size);
    assertShareable(bytes, `提交源码 ${row.path}`);
    files.set(row.path, Buffer.from(bytes)); modes.set(row.path, row.mode);
    cursor = end + 1 + size + 1;
  }
  const changes = [];
  for (const path of selected) {
    if (!inScope(path, roots)) throw reproError('SOURCE_OUT_OF_SCOPE', '选中差异必须位于 code.roots 中。');
    const bytes = localFile(worktree, path);
    if (bytes) {
      assertShareable(bytes, '选中源码差异'); files.set(path, bytes);
      modes.set(path, process.platform === 'win32' ? (modes.get(path) ?? '100644') : (lstatSync(join(worktree, path)).mode & 0o111 ? '100755' : '100644'));
    }
    else if (!files.delete(path)) throw reproError('RESOURCE_MISSING', '选中的源码路径不存在。');
    changes.push({ path, operation: bytes ? 'write' : 'delete', ...(bytes ? { digest: digest(bytes) } : {}) });
  }
  if (git(worktree, ['rev-parse', 'HEAD']).trim() !== sourceCommit) throw reproError('SOURCE_CHANGED', '采集期间 HEAD 已变化，请重试。');
  validateCodePaths(files.keys());
  const exportRepo = join(scratch, 'export'); mkdirSync(exportRepo);
  git(exportRepo, ['init', '-q']);
  for (const [path, bytes] of files) {
    const file = join(exportRepo, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, bytes);
  }
  git(exportRepo, ['add', '--all']);
  for (const [path, mode] of modes) if (mode === '100755' && files.has(path)) git(exportRepo, ['update-index', '--chmod=+x', '--', path]);
  git(exportRepo, ['commit', '-qm', 'Portable selected code snapshot']);
  git(exportRepo, ['branch', '-M', 'repro-snapshot']);
  const bundle = join(scratch, 'source.bundle'); git(exportRepo, ['bundle', 'create', bundle, 'refs/heads/repro-snapshot']);
  const exportedCommit = git(exportRepo, ['rev-parse', 'HEAD']).trim();
  const sourceDigest = digest(jsonBytes([...files].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([path, bytes]) => ({ path, digest: digest(bytes) }))));
  return { bytes: readFileSync(bundle), sourceFiles: files, manifest: {
    sourceCommit, exportedCommit, sourceDigest, roots, selectedChanges: changes,
    representation: 'self-contained-git-bundle-selected-snapshot',
    history: '原提交号仅作来源；bundle 携带该提交已选源码及明确选定的本地差异，不携带历史、作者身份或无关路径。',
    files: [...files].map(([path, bytes]) => ({ path, bytes: bytes.length, digest: digest(bytes), mode: modes.get(path) ?? '100644' })),
  } };
}

// Decode objects without checking out attacker-controlled code or running filters/hooks.
export function restoreCode(repository, bundle, metadata, scratch, target) {
  const quarantine = join(scratch, 'quarantine.git'); mkdirSync(quarantine);
  git(quarantine, ['init', '--bare', '-q']);
  git(quarantine, ['bundle', 'verify', bundle]);
  git(quarantine, ['fetch', '--no-tags', bundle, 'refs/heads/repro-snapshot:refs/heads/repro-snapshot']);
  const commit = git(quarantine, ['rev-parse', 'refs/heads/repro-snapshot']).trim();
  if (commit !== metadata.exportedCommit) throw reproError('CODE_DIGEST_MISMATCH', 'bundle 提交与清单不符。');
  const records = git(quarantine, ['ls-tree', '-rz', commit]).split('\0').filter(Boolean);
  const expected = new Map(metadata.files.map(item => [safeEntry(item.path), item]));
  validateCodePaths(metadata.files.map(item => item.path));
  validateCodePaths(records.map(row => row.slice(row.indexOf('\t') + 1)));
  if (records.length !== expected.size) throw reproError('CODE_DIGEST_MISMATCH', 'bundle 文件数与清单不符。');
  const files = new Map();
  for (const row of records) {
    const tab = row.indexOf('\t'), [mode, type, oid] = row.slice(0, tab).split(' '), path = safeEntry(row.slice(tab + 1));
    const item = expected.get(path);
    if (!item || excludedPath(path) || !['100644', '100755'].includes(mode) || type !== 'blob' || item.mode !== mode) throw reproError('UNSAFE_PATH', 'bundle 含非清单源码或特殊文件。');
    const bytes = git(quarantine, ['cat-file', 'blob', oid], { encoding: null });
    if (digest(bytes) !== item.digest || bytes.length !== item.bytes) throw reproError('CODE_DIGEST_MISMATCH', 'bundle 源码摘要不符。');
    assertShareable(bytes, '包内源码'); files.set(path, bytes);
  }
  // Import verified objects, then create a genuine detached Git worktree with checkout disabled.
  // Files are written ourselves: Git checkout would invoke local smudge filters from attributes.
  git(repository, ['fetch', '--no-tags', '--no-write-fetch-head', bundle, 'refs/heads/repro-snapshot']);
  git(repository, ['worktree', 'add', '--detach', '--no-checkout', target, commit]);
  try {
    git(target, ['read-tree', commit]);
    for (const [path, bytes] of files) {
      const file = join(target, path); mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, bytes, { mode: expected.get(path).mode === '100755' ? 0o755 : 0o644, flag: 'wx' });
    }
  } catch (error) {
    git(repository, ['worktree', 'remove', '--force', target]);
    throw error;
  }
  return commit;
}
