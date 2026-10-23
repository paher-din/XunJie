import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CliError } from './envelope.mjs';
import { acquireLock, writeJsonAtomic } from './state.mjs';

export const enrollmentSelectionFile = context => join(context.env.root, 'enrollment.json');
export function enrollmentSelection(context) {
  const file = enrollmentSelectionFile(context);
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, 'utf8'));
}
function argumentsFor(options, allowed) {
  const result = {}, args = [...options.extraArgs];
  while (args.length) {
    const flag = args.shift();
    if (!allowed.includes(flag) || Object.hasOwn(result, flag)) throw new CliError('arguments', 'ENROLLMENT_ARGUMENTS_INVALID', '运行 --help 核对加入命令与私有文件参数。');
    if (flag === '--no-start') { result[flag] = true; continue; }
    const value = args.shift();
    if (!value || value.startsWith('--')) throw new CliError('arguments', 'ENROLLMENT_ARGUMENTS_INVALID', '私有输入只接受文件路径。');
    result[flag] = value;
  }
  return result;
}
function publish(context, result) {
  const { deviceFile, identityFile, connectionFile, accountFile, identity, state } = result;
  const selection = { deviceFile, identityFile, connectionFile, accountFile, identity, state };
  // Paths and safe IDs only. Account/SSH/invitation material stays in the
  // client's protected generation and is never copied into environment state.
  mkdirSync(context.env.root, { recursive: true, mode: 0o700 });
  const lock = acquireLock(context.env);
  try { writeJsonAtomic(enrollmentSelectionFile(context), selection); } finally { lock.release(); }
  return selection;
}
export async function joinRoute(context, options, log) {
  const args = argumentsFor(options, ['--invitation-file', '--mode', '--no-start']);
  if (!args['--invitation-file']) throw new CliError('arguments', 'INVITATION_FILE_REQUIRED', 'join --invitation-file FILE [--mode local|cloud-api|cloud] [--no-start]');
  const mode = args['--mode'] ?? 'local';
  if (!['local', 'cloud-api', 'cloud'].includes(mode)) throw new CliError('arguments', 'UNKNOWN_MODE', '模式必须为 local、cloud-api 或 cloud。');
  const { joinEnrollment } = await import('./enrollment-client.mjs');
  const enrollment = publish(context, await joinEnrollment({ home: context.home, invitationFile: args['--invitation-file'] }));
  if (args['--no-start']) return { enrollment, started: false, next: ['up 或 use cloud；尚未验收环境启动。'] };
  const { useMode } = await import('./modes.mjs');
  const environment = await useMode(context, mode, { connection: enrollment.connectionFile }, log);
  return { ...environment, enrollment, started: true };
}
export async function refreshRoute(context, options) {
  const args = argumentsFor(options, ['--device-file']);
  const deviceFile = args['--device-file'] ?? enrollmentSelection(context)?.deviceFile;
  if (!deviceFile) throw new CliError('arguments', 'DEVICE_FILE_REQUIRED', 'refresh --device-file FILE；当前工作树还没有登记设备。');
  const { refreshEnrollment } = await import('./enrollment-client.mjs');
  return { enrollment: publish(context, await refreshEnrollment({ deviceFile })), next: ['up 按当前模式使用已更新的连接配置；既有页面保持原目标。'] };
}
