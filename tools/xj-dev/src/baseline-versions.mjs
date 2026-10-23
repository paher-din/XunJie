import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { captureRepro, inspectRepro, restoreRepro } from './repro.mjs';
import { reproError } from './repro-archive.mjs';
import { BASELINE_VERSION } from './baseline.mjs';
import { acquireLock, writeJsonAtomic } from './state.mjs';

function versionName(version) {
  if (typeof version !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(version) || version === 'latest') throw reproError('INVALID_VERSION', '基线需显式不可变版本名（小写字母、数字、连字符），不接受 latest。');
  return version;
}
export function listBaselines(context) {
  const directory = join(context.home, 'baselines');
  const published = !existsSync(directory) ? [] : readdirSync(directory).filter(name => existsSync(join(directory, name, 'baseline.json'))).sort().map(name => {
    versionName(name);
    const record = JSON.parse(readFileSync(join(directory, name, 'baseline.json'), 'utf8'));
    const checked = inspectRepro(join(directory, name, 'package.zip'), { expectedDigest: record.digest });
    return { ...record, schema: checked.package.manifest.data.schema, bytes: checked.package.bytes };
  });
  return { baselines: published, builtin: { version: BASELINE_VERSION, availability: '首次 up 的内置合成基线；现有副本始终复用，不自动切换。' },
    next: ['baseline publish --context FILE --version VERSION', 'baseline use VERSION（另建工作树，保留旧环境）'] };
}
export async function publishBaseline(context, { version, contextFile }) {
  versionName(version);
  if (version === BASELINE_VERSION) throw reproError('BASELINE_EXISTS', '不能覆盖代码内置基线。');
  const root = join(context.home, 'baselines', version), file = join(root, 'package.zip');
  mkdirSync(dirname(root), { recursive: true });
  mkdirSync(root, { recursive: true });
  const lock = acquireLock({ root, lockFile: join(root, 'publish.lock') });
  try {
    if (existsSync(join(root, 'baseline.json'))) throw reproError('BASELINE_EXISTS', '此基线版本已存在；变更应发布新版本。');
    const result = await captureRepro(context, { contextFile, out: file });
    const record = { version, digest: result.package.digest, publishedAt: new Date().toISOString(), description: result.package.manifest.verification.reason };
    writeJsonAtomic(join(root, 'baseline.json'), record);
    return { baseline: record, package: result.package, verification: result.verification,
      next: [`baseline use ${version}：仅显式采用的成员会建立新副本。`] };
  } finally { lock.release(); }
}
export async function useBaseline(context, { version, target }) {
  versionName(version);
  const root = join(context.home, 'baselines', version);
  if (!existsSync(join(root, 'baseline.json'))) throw reproError('RESOURCE_MISSING', '本地没有此固定基线；请取得发布包或使用 list 查看已发布版本。');
  const record = JSON.parse(readFileSync(join(root, 'baseline.json'), 'utf8'));
  const result = await restoreRepro(context, { file: join(root, 'package.zip'), expectedDigest: record.digest, baselineVersion: version,
    target: target ?? join(dirname(context.worktree), `xj-baseline-${version}-${record.digest.slice(7, 15)}`) });
  return { ...result, baseline: { version, digest: record.digest }, previous: { worktree: context.worktree, environment: context.env.root, preserved: true },
    next: [`在 ${result.environment.worktree} 继续开发；xj-dev up --worktree ${result.environment.worktree}`, '旧工作树、数据库和浏览器现场均保留；其他成员不会自动升级。'] };
}
