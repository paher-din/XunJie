#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { failureEnvelope, printResult, resultEnvelope } from './src/envelope.mjs';
import { PINNED_NODE, TOOL_VERSION } from './src/paths.mjs';
import { locatePinnedRuntime } from './src/runtime.mjs';
import { reproRoute, baselineRoute } from './src/repro-routes.mjs';
import { joinRoute, refreshRoute } from './src/enrollment-routes.mjs';
import { accessRoute } from './src/enrollment-admin.mjs';
import { transferProjection } from './src/package-routes.mjs';

const HELP = `xj-dev — XunJie 本地全栈开发环境

用法：
  node tools/xj-dev/xj-dev.mjs <命令> [选项]

命令：
  doctor    检查运行时、仓库、依赖、openssl、证书与当前环境状态
  up        启动（或恢复）当前所选模式；新工作树默认本地全栈
  status    查看环境、进程、页面入口、数据归属与能力状态
  down      停止本工作树登记的各模式及节点连接；不删除任何数据
  delete    显式删除当前工作树/实例所选模式的已登记环境数据；保留永久锁守卫
  use <local|cloud-api|cloud>  检查成功后切换入口；原页面保持原数据目标
  node <connect|status|disconnect>  管理已登记节点回连，不重发或改派任务
  join --invitation-file FILE [--mode local|cloud-api|cloud] [--no-start]  登记本机并启动
  refresh [--device-file FILE]  用原设备身份刷新配置，不重新领取邀请
  access <invite|inspect|revoke-invitation|revoke-device|revoke-member|snapshot>
            --admin-config FILE [--input-file FILE] [--out-file FILE]
  access <package-quota|package-baselines|package-baseline|package-cleanup> --admin-config FILE [--input-file FILE]
  repro     capture --context FILE --out ZIP / inspect ZIP / restore ZIP [--target DIR] / verify ZIP
  repro     share ZIP [--digest SHA256] / resume ID / fetch ID / cache-delete ID [--device-file FILE]
            restore/verify 也接受稳定 ID，按设备授权下载、校验，再恢复或执行复现步骤
  baseline  list / publish --context FILE --version VERSION / use VERSION [--target DIR]

全局选项：
  --json            以 JSON 输出结果（默认即为 JSON；日志始终在 stderr）
  --worktree <dir>  指定工作树（默认：从当前目录向上查找）
  --instance <name> 同一工作树的额外独立环境实例（默认空）
  --connection <file>  已获准的 xj-dev/connection-v1 或现有私有连接配置
  --identity <file>    已获准 SSH 私钥路径（默认读取配置；不读取私钥正文）
  --help            显示帮助

说明：
  - 运行时需要精确的 Node ${PINNED_NODE}；doctor 会报告定位结果与安装方式。
  - 环境数据在仓库外工具目录（XJ_DEV_HOME，默认 ~/.xunjie/xj-dev/envs/<环境ID>/），
    重复 up 沿用数据不重置；显式 delete 删除已登记环境数据，之后 up 重建。
  - local：本地前后端与独立数据；cloud-api：本地 Vite/HMR + 云端 API/共享数据；
    cloud：云端部署页面/API/共享数据。切换不搬数据、不升基线、不上传代码、不部署。
  - 邀请/设备/维护配置从受限文件读取；只输出安全 ID 和私有文件路径，不输出秘密。
    join默认启动local；云端测试身份的凭据只保存在enrollment.accountFile。
  - 连接由后台受管进程监督；网络故障有限退避恢复，权限/主机身份失败停止重试。
    恢复不重放业务写入。不同模式使用固定入口、独立 Cookie 命名及 browser.profile。
`;

function parseArgs(argv) {
  const options = { command: undefined, argument: undefined, extraArgs: [], worktree: undefined, instance: undefined, help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--json') continue;
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (arg === '--worktree') { options.worktree = argv[++index]; continue; }
    if (arg === '--instance') { options.instance = argv[++index]; continue; }
    // Subcommands own their arguments; only the global environment flags above
    // are consumed here. #130 registers their handlers in commandRoutes below.
    if (['repro', 'baseline', 'join', 'refresh', 'access'].includes(options.command)) { options.extraArgs.push(arg); continue; }
    if (arg === '--connection') { options.connection = argv[++index]; continue; }
    if (arg === '--identity') { options.identity = argv[++index]; continue; }
    if (arg.startsWith('--')) throw Object.assign(new Error(`未知选项：${arg}`), { code: 'UNKNOWN_ARGUMENT' });
    if (options.command && ['use', 'node'].includes(options.command) && !options.argument) { options.argument = arg; continue; }
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
  const { resolveContext, doctor, up, status, down, deleteEnvironment, useMode, nodeCommand } = await import('./src/commands.mjs');
  const commandRoutes = {
    join: joinRoute,
    refresh: refreshRoute,
    access: accessRoute,
    repro: reproRoute,
    baseline: baselineRoute,
    doctor: (context) => doctor(context),
    up: (context, options, log) => up(context, log),
    status: (context) => status(context),
    down: (context) => down(context),
    delete: (context) => deleteEnvironment(context),
    use: (context, options, log) => useMode(context, options.argument, options, log),
    node: (context, options) => nodeCommand(context, options.argument, options),
  };
  if (!Object.hasOwn(commandRoutes, options.command)) {
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
  const { logLine } = await import('./src/envelope.mjs');
  const command = options.command;
  try {
    const context = resolveContext({ worktree: options.worktree, instance: options.instance });
    const log = message => logLine(message);
    const body = await commandRoutes[command](context, options, log);
    const envelope = resultEnvelope(TOOL_VERSION, command, body);
    printResult(envelope);
    if (!envelope.ok) process.exitCode = 1;
  } catch (error) {
    const transfer = transferProjection(error?.transfer);
    printResult(failureEnvelope(TOOL_VERSION, command, error, transfer ? { transfer } : {}));
    process.exitCode = 1;
  }
}

await main();
