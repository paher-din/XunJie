#!/usr/bin/env node
import { spawn, execFile } from 'node:child_process';
import { parseArgs, promisify } from 'node:util';
import { acquireNativeDesktop } from './lib/native-desktop-lock.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  platform: { type: 'string' }, session: { type: 'string' }, purpose: { type: 'string' },
} });
if (!positionals.length) throw new Error('Use --platform macos|windows --session ID --purpose TEXT -- COMMAND ARG...');
const release = await acquireNativeDesktop(values.platform, values.session, values.purpose ?? 'XunJie acceptance');
let child;
const interrupt = signal => child?.kill(signal);
process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
try {
  if (values.platform === 'macos') {
    const exec = promisify(execFile);
    const consoleState = await exec('ioreg', ['-l', '-n', 'Root', '-d1']);
    if (/"IOConsoleLocked"\s*=\s*Yes/.test(consoleState.stdout)) throw new Error('The physical Mac desktop is locked.');
    const front = await exec('osascript', ['-e', 'tell application "System Events" to get name of first application process whose frontmost is true']);
    console.log(JSON.stringify({ desktop: 'macos', unlocked: true, frontBefore: front.stdout.trim(), sessionId: values.session }));
  }
  const code = await new Promise((resolve, reject) => {
    child = spawn(positionals[0], positionals.slice(1), { stdio: 'inherit', shell: false, env: process.env });
    child.once('error', reject); child.once('exit', code => resolve(code ?? 1));
  });
  process.exitCode = code;
} finally {
  process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  await release();
}
