import { createHash } from 'node:crypto';
import { accessSync, constants, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';

/**
 * The macOS runtime is confined by a generated seatbelt profile applied by the fixed system
 * launcher. The product ships no native helper and needs no signing identity: only the system
 * binary and a text profile are involved, so an unsigned distribution package behaves the same.
 */
export const seatbeltLauncherPath = '/usr/bin/sandbox-exec';
export const seatbeltProfileVersion = 'xunjie-native-session-v1';

/** What the platform actually enforces for one session; recorded so evidence never implies more. */
export interface NativeSessionIsolation {
  kind: 'seatbelt' | 'app-container' | 'systemd-unit' | 'process-group';
  launcher: string | null;
  profileVersion: string | null;
  profileDigest: string | null;
  network: 'denied' | 'unrestricted';
  reads: 'system-runtime-and-session' | 'unrestricted';
  writes: 'session-directory' | 'unrestricted';
  exec: 'fixed-node-only' | 'unrestricted';
  signals: 'same-sandbox-only' | 'control-group' | 'unrestricted';
  /** V8 stops the JS heap; the supervisor stops a working set that grows past the baseline. */
  memory: 'heap-cap-and-rss-watchdog' | 'job-object' | 'cgroup-v2' | 'heap-cap-only';
  /** A confirmed stop means the whole managed process group is empty, not just the direct child. */
  processes: 'supervisor-group-confirmed' | 'job-object' | 'control-group-confirmed' | 'direct-child-only';
  supervisorDeath: 'session-watchdog' | 'job-close' | 'runtime-bound' | 'none';
}

export interface SeatbeltPlan {
  launcher: string;
  profileVersion: string;
  profileText: string;
  profileDigest: string;
  /** Paths the profile refuses to read, recorded for evidence and for the acceptance probe. */
  readDenied: string[];
  readAllowed: string[];
  isolation: NativeSessionIsolation;
}

/** Reads outside these roots are refused; the session directory and the runtime are re-allowed. */
const protectedRoots = ['/Users', '/Volumes', '/private/tmp', '/private/var'];

const literal = (value: string) => '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
const subpaths = (values: readonly string[]) => values.map(value => `(subpath ${literal(value)})`).join(' ');

function canonical(path: string): string {
  try { return realpathSync.native(path) } catch { return path }
}

/** `null` means this platform cannot host a seatbelt session, so the caller must not fake one. */
export function planSeatbelt(nodePath: string, sessionDirectory: string,
  extraProtectedRoots: readonly string[] = [], platform: NodeJS.Platform = process.platform): SeatbeltPlan | null {
  if (platform !== 'darwin') return null;
  try { accessSync(seatbeltLauncherPath, constants.X_OK) } catch { return null }
  const node = canonical(nodePath);
  const session = canonical(sessionDirectory);
  const runtimeDirectory = dirname(node);
  const readDenied = [...new Set([...protectedRoots, ...extraProtectedRoots.map(canonical), homedir()].filter(Boolean))];
  const readAllowed = [...new Set([session, runtimeDirectory, '/private/var/db/timezone'])];
  // Order matters: the launcher evaluates every matching rule and the last one wins, so the
  // specific allows below survive the broad denies above them.
  const profileText = [
    '(version 1)',
    '(deny default)',
    `(allow process-exec (literal ${literal(node)}))`,
    '(allow process-fork)',
    '(allow signal (target same-sandbox))',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow file-read*)',
    `(deny file-read* ${subpaths(readDenied)})`,
    `(allow file-read* ${subpaths(readAllowed)})`,
    `(allow file-write* (subpath ${literal(session)}) (literal "/dev/null"))`,
    '(deny network*)',
  ].join('\n') + '\n';
  return {
    launcher: seatbeltLauncherPath,
    profileVersion: seatbeltProfileVersion,
    profileText,
    profileDigest: createHash('sha256').update(profileText).digest('hex'),
    readDenied,
    readAllowed,
    isolation: {
      kind: 'seatbelt', launcher: seatbeltLauncherPath, profileVersion: seatbeltProfileVersion,
      profileDigest: createHash('sha256').update(profileText).digest('hex'),
      network: 'denied', reads: 'system-runtime-and-session', writes: 'session-directory',
      exec: 'fixed-node-only', signals: 'same-sandbox-only', memory: 'heap-cap-and-rss-watchdog',
      processes: 'supervisor-group-confirmed', supervisorDeath: 'session-watchdog',
    },
  };
}

/**
 * Prepended to every session source. A supervisor that dies without a protocol stop still ends the
 * managed group: the watchdog pipe reports EOF immediately and a parent-identity poll bounds the
 * worst case when the pipe is unavailable.
 */
export const supervisorWatchdogSource = [
  "import { createReadStream as __xjRead } from 'node:fs';",
  "const __xjSupervisor = process.ppid;",
  "const __xjEnd = () => { try { process.kill(-process.pid, 'SIGKILL') } catch { process.exit(137) } };",
  // A supervisor that disappears closes both ends: stdin reports EOF and so does the watchdog pipe.
  "process.stdin.once('end', __xjEnd);",
  "try { const __xjDeath = __xjRead(null, { fd: 3 }); __xjDeath.on('end', __xjEnd); __xjDeath.on('error', __xjEnd); } catch { /* The poll below still bounds the exit. */ }",
  "setInterval(() => { if (process.ppid !== __xjSupervisor) __xjEnd() }, 250).unref();",
].join('\n');

/**
 * The Linux unit runs its adapter as a systemd service, so the supervisor cannot signal a process
 * group it does not own. Losing the client pipe still ends the session through stdin EOF, and the
 * unit's `RuntimeMaxSec` bounds the case where even that signal is lost.
 */
export const linuxWatchdogSource = [
  "const __xjEnd = () => { try { process.exit(137) } catch { /* The unit still ends it. */ } };",
  "process.stdin.once('end', __xjEnd);",
  "process.stdin.once('error', __xjEnd);",
].join('\n');

export const unboundedIsolation: NativeSessionIsolation = {
  kind: 'process-group', launcher: null, profileVersion: null, profileDigest: null,
  network: 'unrestricted', reads: 'unrestricted', writes: 'unrestricted', exec: 'unrestricted',
  signals: 'unrestricted', memory: 'heap-cap-only', processes: 'direct-child-only', supervisorDeath: 'none',
};

export const appContainerIsolation: NativeSessionIsolation = {
  kind: 'app-container', launcher: null, profileVersion: null, profileDigest: null,
  network: 'denied', reads: 'system-runtime-and-session', writes: 'session-directory',
  exec: 'fixed-node-only', signals: 'unrestricted', memory: 'job-object', processes: 'job-object',
  supervisorDeath: 'job-close',
};
