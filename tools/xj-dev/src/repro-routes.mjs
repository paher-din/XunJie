import { captureRepro, inspectRepro, restoreRepro } from './repro.mjs';
import { verifyRepro } from './repro-verify.mjs';
import { listBaselines, publishBaseline, useBaseline } from './baseline-versions.mjs';
import { reproError } from './repro-archive.mjs';
import { isPackageId, packageFile, packageRoute } from './package-routes.mjs';

function parse(options) {
  const args = [...(options.extraArgs ?? [])], verb = args.shift(), positional = [], flags = {};
  while (args.length) {
    const value = args.shift();
    if (!value.startsWith('--')) { positional.push(value); continue; }
    if (!['--context', '--out', '--target', '--digest', '--version', '--device-file', '--idempotency-key'].includes(value) || value in flags || !args.length || args[0].startsWith('--')) throw reproError('INVALID_ARGUMENTS', '复现/基线参数无效或缺值。');
    flags[value] = args.shift();
  }
  return { verb, positional, flags };
}
export async function reproRoute(context, options) {
  const { verb, positional, flags } = parse(options);
  if (['share','resume','fetch','cache-delete'].includes(verb)) return packageRoute(context,{verb,positional,flags});
  const allowed = { capture: ['--context', '--out'], inspect: ['--digest','--device-file'], restore: ['--target', '--digest','--device-file'], verify: ['--digest','--device-file'] };
  if (!allowed[verb] || Object.keys(flags).some(flag => !allowed[verb].includes(flag)) || (verb === 'capture' && positional.length)) throw reproError('INVALID_ARGUMENTS', 'repro 参数与子命令不匹配，支持 capture/inspect/restore/verify。');
  if (positional.length > 1) throw reproError('INVALID_ARGUMENTS', '复现命令只接受一个 ZIP 路径。');
  const args = { contextFile: flags['--context'], out: flags['--out'], file: positional[0], target: flags['--target'], expectedDigest: flags['--digest'] };
  if (verb === 'capture') return captureRepro(context, args);
  if (!args.file) throw reproError('INVALID_ARGUMENTS', '需要 ZIP 文件路径。');
  let transfer;
  if (isPackageId(args.file)) {
    transfer = await packageFile(context,args.file,flags['--device-file']);
    if (args.expectedDigest && args.expectedDigest !== transfer.digest) throw reproError('DIGEST_MISMATCH','稳定编号摘要与显式预期不符。');
    args.file = transfer.file; args.expectedDigest = transfer.digest;
  }
  if (verb === 'inspect') return inspectRepro(args.file, args);
  if (verb === 'restore') return { ...await restoreRepro(context, args), ...(transfer?{transfer}: {}) };
  if (verb === 'verify') return { ...await verifyRepro(context, args), ...(transfer?{transfer}: {}) };
  throw reproError('INVALID_ARGUMENTS', 'repro 支持 capture/inspect/restore/verify。');
}
export async function baselineRoute(context, options) {
  const { verb, positional, flags } = parse(options);
  const allowed = { list: [], publish: ['--context', '--version'], use: ['--target'] };
  if (!allowed[verb] || Object.keys(flags).some(flag => !allowed[verb].includes(flag)) || (verb !== 'use' && positional.length)) throw reproError('INVALID_ARGUMENTS', 'baseline 参数与子命令不匹配，支持 list/publish/use。');
  if (positional.length > 1) throw reproError('INVALID_ARGUMENTS', 'baseline use 只接受一个版本。');
  if (verb === 'list') return listBaselines(context);
  if (verb === 'publish') return publishBaseline(context, { version: flags['--version'], contextFile: flags['--context'] });
  if (verb === 'use') return useBaseline(context, { version: positional[0], target: flags['--target'] });
  throw reproError('INVALID_ARGUMENTS', 'baseline 支持 list/publish/use。');
}
