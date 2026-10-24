import { spawnSync } from 'node:child_process';
import { CliError } from './envelope.mjs';
import { privateJson, writePrivateJson } from './enrollment-protocol.mjs';

export async function accessRoute(context, options) {
  const args = [...options.extraArgs], operation = args.shift(), flags = {};
  while (args.length) {
    const flag = args.shift(), value = args.shift();
    if (!['--admin-config', '--input-file', '--out-file'].includes(flag) || !value || flags[flag]) throw new CliError('arguments', 'ACCESS_ARGUMENTS_INVALID', 'access <invite|inspect|revoke-invitation|revoke-device|revoke-member|snapshot> --admin-config FILE [--input-file FILE] [--out-file FILE]');
    flags[flag] = value;
  }
  if (!['github-approve', 'github-list', 'github-deny', 'invite', 'inspect', 'revoke-invitation', 'revoke-device', 'revoke-member', 'snapshot', 'package-quota', 'package-baselines', 'package-baseline', 'package-baseline-retire', 'package-cleanup'].includes(operation) || !flags['--admin-config'] || operation === 'invite' && !flags['--out-file']) throw new CliError('arguments', 'ACCESS_ARGUMENTS_INVALID', '生成邀请必须指定 --out-file；配置与输入从私有文件读取。');
  let config, input;
  try { config = privateJson(flags['--admin-config']); input = flags['--input-file'] ? privateJson(flags['--input-file']) : {}; }
  catch { throw new CliError('enrollment', 'ADMIN_PRIVATE_FILE_REQUIRED', '需要受限的维护配置或输入文件。'); }
  const safePath = value => typeof value === 'string' && /^\/[A-Za-z0-9/_.-]+$/.test(value);
  if (!safePath(config.remoteNode) || !safePath(config.remoteAdmin) || !safePath(config.remoteSocket) || !/^[a-z_][a-z0-9_-]{0,31}$/.test(config.serviceUser ?? '') || !/^[A-Za-z0-9_-]+$/.test(config.sshHost ?? '')) throw new CliError('enrollment', 'ADMIN_CONFIGURATION_INVALID', '维护入口只接受固定服务路径与现有 SSH profile。');
  const remote = ['sudo', '-n', '-u', config.serviceUser, config.remoteNode, config.remoteAdmin, config.remoteSocket].join(' ');
  const result = spawnSync('ssh', ['-F', config.sshConfigFile, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', config.sshHost, remote], {
    input: JSON.stringify({ operation, input }), encoding: 'utf8', timeout: 60000, windowsHide: true,
  });
  let response;
  try { response = JSON.parse(result.stdout); } catch { throw new CliError('enrollment', 'ADMIN_UNAVAILABLE', '维护通道未返回有效结果；私有诊断未输出。', { retryable: true }); }
  if (result.status !== 0 || !response.ok) throw new CliError('enrollment', /^[A-Z_]+$/.test(response.code ?? '') ? response.code : 'ADMIN_OPERATION_FAILED', '维护操作未完成；撤销记录保留，可重试同一操作。', { retryable: response.code === 'REVOCATION_INCOMPLETE' });
  if (flags['--out-file']) {
    writePrivateJson(flags['--out-file'], response.data);
    return { operation, resultFile: flags['--out-file'], ...(operation === 'invite' ? { invitationId: response.data.invitationId, memberId: response.data.memberId, expiresAt: response.data.expiresAt } : {}) };
  }
  return { operation, ...response.data };
}
