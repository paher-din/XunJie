#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { failureEnvelope, printResult, resultEnvelope } from './src/envelope.mjs';
import { PINNED_NODE, TOOL_VERSION } from './src/paths.mjs';
import { locatePinnedRuntime } from './src/runtime.mjs';

const HELP = `xj-dev — XunJie 本地全栈开发环境

用法：
  node tools/xj-dev/xj-dev.mjs <命令> [选项]

命令：
  doctor    检查运行时、仓库、依赖、openssl、证书与当前环境状态
  up        启动（或恢复）本工作树的本地全栈环境：Vite 热更新 + 真实后端 + HTTPS 网关 + 独立数据
  status    查看环境、进程、页面入口、数据归属与能力状态
  down      停止本工具管理的进程；不删除任何数据

全局选项：
  --json            以 JSON 输出结果（默认即为 JSON；日志始终在 stderr）
  --worktree <dir>  指定工作树（默认：从当前目录向上查找）
  --instance <name> 同一工作树的额外独立环境实例（默认空）
  --help            显示帮助

说明：
  - 运行时需要精确的 Node ${PINNED_NODE}；doctor 会报告定位结果与安装方式。
  - 环境数据在仓库外工具目录（XJ_DEV_HOME，默认 ~/.xunjie/xj-dev/envs/<环境ID>/），
    重复 up 沿用数据不重置；重置 = down 后删除对应环境目录。
  - 本地闭环不连接执行节点与模型服务：运行/仿真返回 RUNTIME_NOT_READY，模型调用停用。
`;

function parseArgs(argv) {
  const options = { command: undefined, worktree: undefined, instance: undefined, help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--json') continue;
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (arg === '--worktree') { options.worktree = argv[++index]; continue; }
    if (arg === '--instance') { options.instance = argv[++index]; continue; }
    if (arg.startsWith('--')) throw Object.assign(new Error(`未知选项：${arg}`), { code: 'UNKNOWN_ARGUMENT' });
    if (options.command) throw Object.assign(new Error(`多余参数：${arg}`), { code: 'UNKNOWN_ARGUMENT' });
    options.command = arg;
  }
  return options;
}

async function main() {
  const argv = process.argv.slice(2);
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    printResult(failureEnvelope(TOOL_VERSION, 'parse', { stage: 'arguments', code: error.code ?? 'INVALID_ARGUMENTS', message: error.message, retryable: false, recovery: '运行 --help 查看用法。' }));
    process.exitCode = 1;
    return;
  }
  if (options.help || !options.command) {
    process.stdout.write(HELP);
    return;
  }
  if (!['doctor', 'up', 'status', 'down'].includes(options.command)) {
    printResult(failureEnvelope(TOOL_VERSION, options.command, { stage: 'arguments', code: 'UNKNOWN_COMMAND', message: `未知命令：${options.command}`, retryable: false, recovery: '运行 --help 查看命令。' }));
    process.exitCode = 1;
    return;
  }
  if (process.version !== PINNED_NODE) {
    let located;
    try {
      located = locatePinnedRuntime(process.env, undefined);
    } catch (error) {
      printResult(failureEnvelope(TOOL_VERSION, options.command, error));
      process.exitCode = 1;
      return;
    }
    const result = spawnSync(located.path, [fileURLToPath(import.meta.url), ...argv], { stdio: 'inherit' });
    process.exit(result.status ?? 1);
  }
  const { resolveContext, doctor, up, status, down } = await import('./src/commands.mjs');
  const { logLine } = await import('./src/envelope.mjs');
  const command = options.command;
  try {
    const context = resolveContext({ worktree: options.worktree, instance: options.instance });
    const log = message => logLine(message);
    const body = command === 'doctor' ? await doctor(context)
      : command === 'up' ? await up(context, log)
        : command === 'status' ? await status(context)
          : await down(context);
    const envelope = resultEnvelope(TOOL_VERSION, command, body);
    printResult(envelope);
    if (!envelope.ok) process.exitCode = 1;
  } catch (error) {
    printResult(failureEnvelope(TOOL_VERSION, command, error));
    process.exitCode = 1;
  }
}

await main();
