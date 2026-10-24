import { CliError } from './envelope.mjs';
import { enrollmentSelection } from './enrollment-routes.mjs';
import { authenticatedRequest, readRegistration } from './enrollment-client.mjs';

export const isPackageId = value => /^xjp_[a-f0-9-]{36}$/.test(value ?? '');
export function transferProjection(value) {
  if (!value || !['interrupted','published','downloaded'].includes(value.state)) return undefined;
  return Object.fromEntries(['state','transferId','reproId','file','digest','bytes','confirmedParts'].filter(k => Object.hasOwn(value,k)).map(k => [k,value[k]]));
}
export function registeredDeviceFile(context, explicit) {
  const deviceFile = explicit ?? enrollmentSelection(context)?.deviceFile ?? readRegistration({ home: context.home })?.deviceFile;
  if (!deviceFile) throw new CliError('transfer','DEVICE_FILE_REQUIRED','先 join 取得文件能力，或使用 --device-file FILE。');
  return deviceFile;
}
export async function teamBaselineCatalog(context, deviceFile) {
  const response = await authenticatedRequest(registeredDeviceFile(context, deviceFile), '/v1/packages/resolve', { catalog: 'baselines' });
  const invalid = () => new CliError('transfer', 'BASELINE_CATALOG_INVALID', '团队基线目录无效；保留现有工作树与数据。');
  if (!Array.isArray(response.baselines)) throw invalid();
  const seen = new Set();
  return response.baselines.map(entry => {
    if (!entry || typeof entry.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(entry.name)
      || typeof entry.version !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(entry.version)
      || typeof entry.reproId !== 'string' || !isPackageId(entry.reproId) || typeof entry.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(entry.digest)
      || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || !Number.isSafeInteger(entry.createdAt) || entry.createdAt < 0) throw invalid();
    const key = `${entry.name}/${entry.version}`;
    if (seen.has(key)) throw invalid();
    seen.add(key);
    return { name: entry.name, version: entry.version, reproId: entry.reproId, digest: entry.digest, bytes: entry.bytes, createdAt: entry.createdAt };
  });
}
export async function packageRoute(context, { verb, positional, flags }) {
  const allowed = { share: ['--device-file','--digest','--idempotency-key'], resume: ['--device-file'], fetch: ['--device-file'], 'cache-delete': ['--device-file'] };
  if (!allowed[verb] || Object.keys(flags).some(k => !allowed[verb].includes(k)) || positional.length !== 1) throw new CliError('arguments','PACKAGE_ARGUMENTS_INVALID','repro share ZIP / resume ID / fetch ID / cache-delete ID [--device-file FILE]');
  const deviceFile = registeredDeviceFile(context, flags['--device-file']);
  const transfer = await import('./package-transfer.mjs');
  if (verb === 'share') return transfer.publishFrozen(context,{deviceFile,file:positional[0],expectedDigest:flags['--digest'],idempotencyKey:flags['--idempotency-key']});
  if (!isPackageId(positional[0])) throw new CliError('arguments','PACKAGE_ID_INVALID','需要 xjp_ 开头的稳定复现编号。');
  if (verb === 'resume') return transfer.resumeUpload(context,{deviceFile,transferId:positional[0]});
  if (verb === 'cache-delete') return transfer.pruneCache(context,{deviceFile,reproId:positional[0]});
  return transfer.fetchRepro(context,{deviceFile,reproId:positional[0]});
}

export async function packageFile(context, id, deviceFile) {
  const result = await packageRoute(context,{verb:'fetch',positional:[id],flags:deviceFile?{'--device-file':deviceFile}:{}});
  return result;
}
