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
  const result = {}, args = [...(options.extraArgs ?? [])];
  while (args.length) {
    const flag = args.shift();
    if (!allowed.includes(flag) || Object.hasOwn(result, flag)) throw new CliError('arguments', 'ENROLLMENT_ARGUMENTS_INVALID', '运行 --help 核对加入命令与私有文件参数。');
    if (['--no-start', '--invitation-stdin'].includes(flag)) { result[flag] = true; continue; }
    const value = args.shift();
    if (!value || value.startsWith('--')) throw new CliError('arguments', 'ENROLLMENT_ARGUMENTS_INVALID', '私有输入只接受文件路径。');
    result[flag] = value;
  }
  return result;
}
export async function readInvitationStdin(input = process.stdin) {
  const { MAX_INVITATION_STDIN_BYTES } = await import('./enrollment-client.mjs');
  if (input.isTTY) throw new CliError('arguments', 'INVITATION_STDIN_REQUIRES_PIPE', '邀请仅通过受控 stdin 或 --invitation-file FILE 输入；不在终端粘贴秘密。');
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of input) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_INVITATION_STDIN_BYTES) { bytes.fill(0); throw new CliError('arguments', 'INVITATION_TOO_LARGE', '邀请 stdin 超过 256 KiB 限制。'); }
      chunks.push(bytes);
    }
    if (!size) throw new CliError('arguments', 'INVITATION_STDIN_EMPTY', '邀请 stdin 为空；请提供现有完整邀请 JSON。');
    return Buffer.concat(chunks, size);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('enrollment', 'INVITATION_STDIN_FAILED', '邀请 stdin 读取中断；保留同一 home 与登记 key 后重试。');
  } finally { for (const bytes of chunks) bytes.fill(0); }
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
  const args = argumentsFor(options, ['--invitation-file', '--invitation-stdin', '--mode', '--no-start']);
  if (args['--invitation-file'] && args['--invitation-stdin']) throw new CliError('arguments', 'INVITATION_INPUT_CONFLICT', '--invitation-stdin 与 --invitation-file 互斥。');
  if (!args['--invitation-file'] && !args['--invitation-stdin']) throw new CliError('arguments', 'INVITATION_FILE_REQUIRED', 'join (--invitation-file FILE | --invitation-stdin) [--mode local|cloud-api|cloud] [--no-start]');
  const mode = args['--mode'] ?? 'local';
  if (!['local', 'cloud-api', 'cloud'].includes(mode)) throw new CliError('arguments', 'UNKNOWN_MODE', '模式必须为 local、cloud-api 或 cloud。');
  const { joinEnrollment, prepareEnrollment } = await import('./enrollment-client.mjs');
  let prepared;
  if (args['--invitation-stdin']) {
    const bytes = await readInvitationStdin();
    try { prepared = prepareEnrollment({ home: context.home, invitationBytes: bytes }); }
    finally { bytes.fill(0); }
  }
  const enrollment = publish(context, await joinEnrollment(prepared ? { deviceFile: prepared.deviceFile }
    : { home: context.home, invitationFile: args['--invitation-file'] }));
  if (!enrollment.identity.capabilities.includes('page')) return { enrollment, started: false, next: ['设备仅获文件权限；使用 repro share/fetch，不建立页面或 SSH 连接。'] };
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
