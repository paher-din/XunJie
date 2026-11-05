import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { NativeSessionIsolation } from './native-sandbox.js';

const exec = promisify(execFile);

/**
 * The Linux session entry is a fixed root command installed by the school host administrator.
 * It is the only path that can enforce a network namespace and a read-only root on Ubuntu 24.04:
 * an unprivileged `systemd-run --user --scope` silently skips `PrivateNetwork=` and rejects
 * namespace properties, and unprivileged user namespaces are blocked by AppArmor. The product
 * therefore does not pretend a plain child process is confined; without this entry it reports no
 * native capability at all.
 */
export interface LinuxSessionEntry {
  /** Absolute path of the installed entry script. */
  entry: string;
  /** `sudo` binary used to reach the fixed entry; it must run without a password. */
  sudo: string;
  /** Writable root whose direct children are the per-session directories. */
  workRoot: string;
  /** Account the unit runs as. It owns `workRoot` and must not be root. */
  runUser: string;
  /** Root that contains the product's Node runtime; the entry refuses other executables. */
  nodeRoot: string;
}

export const defaultLinuxEntry: LinuxSessionEntry = {
  entry: '/usr/local/lib/xunjie/native-session-entry',
  sudo: '/usr/bin/sudo',
  workRoot: '/var/lib/xunjie-native',
  runUser: 'xunjie',
  nodeRoot: '/opt/xunjie',
};

/** `/etc/xunjie/native-session.conf` is the only configurable part of the entry; the defaults are
 * the paths the installer writes. A missing entry is not an error to log: the host simply cannot
 * run native sessions. */
export function linuxSessionEntry(): LinuxSessionEntry {
  const invalid = () => Object.assign(new Error('Linux 原生会话资源配置无效。'), { code: 'resource-unavailable' });
  let descriptor: number;
  try {
    descriptor = fs.openSync('/etc/xunjie/native-session.conf', fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...defaultLinuxEntry };
    throw invalid();
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) throw invalid();
    const entry = { ...defaultLinuxEntry };
    const seen = new Set<string>();
    for (const line of fs.readFileSync(descriptor, 'utf8').split('\n')) {
      const value = line.trim();
      if (!value || value.startsWith('#')) continue;
      const match = /^(XJ_RUN_USER|XJ_WORK_ROOT|XJ_NODE_ROOT|XJ_STATE_ROOT)=(.+)$/.exec(value);
      if (!match || seen.has(match[1]!)) throw invalid();
      const key = match[1]!;
      const setting = match[2]!;
      seen.add(key);
      if (key === 'XJ_RUN_USER') {
        if (!/^[a-z_][a-z0-9_-]*[$]?$/.test(setting) || setting === 'root') throw invalid();
        entry.runUser = setting;
      } else {
        if (!/^\/[A-Za-z0-9/_.-]+$/.test(setting) || setting.includes('..')
          || setting.split('/').slice(1).some(part => !part || part === '.')) throw invalid();
        if (key === 'XJ_WORK_ROOT') entry.workRoot = setting;
        if (key === 'XJ_NODE_ROOT') entry.nodeRoot = setting;
      }
    }
    return entry;
  } catch {
    throw invalid();
  } finally {
    fs.closeSync(descriptor);
  }
}

export const linuxSessionUnit = (instanceId: string) => `xj-session-${instanceId}`;

const allowed = (value: string) => /^[A-Za-z0-9/_.-]+$/.test(value);

async function run(entry: LinuxSessionEntry, args: string[], timeout = 20000) {
  return exec(entry.sudo, ['-n', entry.entry, ...args], {
    timeout, maxBuffer: 1024 * 1024, windowsHide: true,
    env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' },
  });
}

/**
 * Starts the entry once inside the real unit and returns what the unit actually enforces. Anything
 * short of a denied network, a read-only system root and an inaccessible school state yields
 * `null`, so the caller refuses native sessions instead of reporting an unconfined capability.
 */
export async function probeLinuxIsolation(entry: LinuxSessionEntry, nodePath: string): Promise<NativeSessionIsolation | null> {
  if (!allowed(entry.workRoot) || !allowed(entry.entry) || !allowed(nodePath)) return null;
  let directory: string | null = null;
  try {
    directory = await mkdtemp(join(entry.workRoot, 'session-'));
    const unit = linuxSessionUnit(randomUUID());
    const { stdout } = await run(entry, ['selftest', unit, directory, nodePath], 60000);
    const line = stdout.split('\n').map(item => item.trim()).filter(Boolean).at(-1);
    if (!line) return null;
    const fact = JSON.parse(line) as Record<string, unknown>;
    if (fact.kind !== 'systemd-unit' || fact.unit !== unit || fact.network !== 'denied'
      || fact.writes !== 'session-directory' || fact.reads !== 'system-runtime-and-session'
      || fact.processes !== 'control-group-confirmed' || fact.memory !== 'cgroup-v2') return null;
    const measured = fact.measured as { hostConfirmed?: unknown; loopback?: { denied?: unknown };
      internet?: { denied?: unknown }; stateRoot?: unknown } | undefined;
    if (measured?.hostConfirmed !== 'yes' || measured.loopback?.denied !== true
      || measured.internet?.denied !== true || !measured.stateRoot) return null;
    const checks = fact.checks as { failed?: unknown; passed?: unknown } | undefined;
    if (!checks || !Array.isArray(checks.failed) || (checks.failed as unknown[]).length > 0
      || !Array.isArray(checks.passed)) return null;
    // The remaining properties are the fixed unit properties in `native-session-entry`: a
    // control-group kill, a cgroup budget and a supervisor-bound runtime are enforced by the unit
    // definition, which the same root-owned entry installs, not by a claim from inside the unit.
    return {
      kind: 'systemd-unit', launcher: entry.entry, profileVersion: 'xunjie-linux-session-v1',
      profileDigest: null, network: 'denied', reads: 'system-runtime-and-session',
      writes: 'session-directory', exec: 'unrestricted', signals: 'unrestricted',
      memory: 'cgroup-v2', processes: 'control-group-confirmed', supervisorDeath: 'runtime-bound',
    };
  } catch { return null }
  finally { if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {}) }
}

/** `inactive`/`failed` after a stop is the only confirmation the product accepts. */
export async function unitStopped(entry: LinuxSessionEntry, unit: string, instanceId: string): Promise<boolean> {
  try {
    const { stdout } = await run(entry, ['state', unit, instanceId], 10000);
    const value = Object.fromEntries(stdout.split('\n').map(line => line.split('=')).filter(pair => pair.length === 2));
    return value.ActiveState === 'inactive' || value.ActiveState === 'failed';
  } catch { return false }
}

export async function stopUnit(entry: LinuxSessionEntry, unit: string, instanceId: string): Promise<void> {
  await run(entry, ['stop', unit, instanceId], 15000).catch(() => { /* The state check decides. */ });
}
