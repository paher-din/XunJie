import { execFile, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, statfsSync } from 'node:fs';
import { promisify } from 'node:util';
import { RunnerError } from './snapshot.ts';

const exec = promisify(execFile);

type ContainerInspection = {
  Id: string;
  State: { Status: string; Running: boolean; OOMKilled: boolean; ExitCode: number;
    Error: string; StartedAt: string; FinishedAt: string; Pid: number };
};

export type PhaseResult = {
  phase: 'compile' | 'execute';
  containerId: string;
  imageId?: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  outputBytes: number;
  durationMs: number;
  unitTerminated: boolean;
  pidsMaxEvents?: number;
  cgroupLimits?: { cpuMax: string; memoryMax: string; memorySwapMax: string; pidsMax: string };
  failureKind?: 'timeout' | 'output_limit' | 'cancelled' | 'oom' | 'process_limit' | 'temp_limit' | 'infrastructure_error';
};

export type PhaseSpec = {
  phase: 'compile' | 'execute';
  name: string;
  image: string;
  sourceDirectory: string;
  workDirectory: string;
  args: string[];
  timeoutMs: number;
  outputBudget: number;
  signal: AbortSignal;
  binaryPath?: string;
};

export class DockerExecutor {
  binary: string;
  socket: string;
  configDirectory: string;

  constructor(binary: string, socket: string, configDirectory: string) {
    this.binary = binary;
    this.socket = socket;
    this.configDirectory = configDirectory;
    mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
  }

  async command(args: string[], timeout = 30000): Promise<string> {
    const result = await exec(this.binary, [`--host=unix://${this.socket}`, ...args], {
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', DOCKER_CONFIG: this.configDirectory },
      timeout, maxBuffer: 65536,
    });
    return result.stdout.trim();
  }

  async inspect(name: string): Promise<ContainerInspection> {
    const value = JSON.parse(await this.command(['inspect', name]))[0];
    if (!value || !/^[0-9a-f]{64}$/.test(value.Id) || typeof value.State?.Running !== 'boolean'
      || typeof value.State?.OOMKilled !== 'boolean' || !Number.isInteger(value.State?.ExitCode)
      || typeof value.State?.Status !== 'string' || typeof value.State?.FinishedAt !== 'string') {
      throw new RunnerError('DEPENDENCY_UNAVAILABLE', 'Invalid execution unit inspection');
    }
    return value;
  }

  async stop(name: string): Promise<boolean> {
    try {
      const before = await this.inspect(name);
      if (before.State.Running) await this.command(['kill', '--signal=KILL', name]);
      return !(await this.inspect(name)).State.Running;
    } catch {
      return false;
    }
  }

  async execute(spec: PhaseSpec, created: (id: string) => void | Promise<void>): Promise<PhaseResult> {
    if (!['compile', 'execute'].includes(spec.phase)
      || !Array.isArray(spec.args) || spec.args.some(arg => typeof arg !== 'string' || arg.includes('\0'))
      || !/^sha256:[0-9a-f]{64}$/.test(spec.image) || !/^xunjie-[a-z0-9-]+$/.test(spec.name)
      || !Number.isInteger(spec.timeoutMs) || spec.timeoutMs < 1
      || spec.timeoutMs > (spec.phase === 'compile' ? 30000 : 10000)
      || !Number.isInteger(spec.outputBudget) || spec.outputBudget < 0 || spec.outputBudget > 65536
      || (spec.binaryPath !== undefined && (!spec.binaryPath.startsWith('/') || /[,\0]/.test(spec.binaryPath)))
      || [spec.sourceDirectory, spec.workDirectory].some(path => !path.startsWith('/') || /[,\0]/.test(path))) {
      throw new RunnerError('INVALID_CONFIGURATION', 'Invalid fixed execution profile');
    }
    const containerId = await this.command([
      'create', '--name', spec.name, '--label', 'xunjie.c1=true',
      '--cpus=1', '--memory=512m', '--memory-swap=512m', '--pids-limit=64',
      '--read-only', '--user=65534:65534', '--network=none', '--cap-drop=ALL',
      '--security-opt=no-new-privileges', '--ipc=private', '--log-driver=none',
      '--mount', `type=bind,src=${spec.sourceDirectory},dst=/snapshot,readonly,bind-propagation=rprivate,bind-recursive=readonly`,
      '--mount', `type=bind,src=${spec.workDirectory},dst=/work`,
      '--mount', `type=bind,src=${spec.workDirectory},dst=/tmp`,
      '--mount', `type=bind,src=${spec.workDirectory},dst=/dev/shm`,
      ...(spec.binaryPath ? ['--mount', `type=bind,src=${spec.binaryPath},dst=/work/textscope,readonly`] : []),
      '--workdir=/work', '--env=TMPDIR=/work/tmp', '--env=LANG=C', '--env=LC_ALL=C',
      '--entrypoint', spec.phase === 'compile' ? '/usr/local/bin/gcc' : '/work/textscope',
      spec.image, ...spec.args,
    ]);
    if (!/^[0-9a-f]{64}$/.test(containerId)) {
      throw new RunnerError('DEPENDENCY_UNAVAILABLE', 'Unconfirmed container creation');
    }
    await created(containerId);
    if (spec.signal.aborted) {
      return { phase: spec.phase, containerId, imageId: spec.image, exitCode: 0, stdout: '', stderr: '', outputBytes: 0,
        durationMs: 0, unitTerminated: await this.stop(containerId), failureKind: 'cancelled' };
    }
    const startedAt = performance.now();
    let outputBytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let failureKind: PhaseResult['failureKind'];
    let pidsMaxEvents = 0;
    let cgroupLimits: PhaseResult['cgroupLimits'];
    let cgroupPath: string | undefined;
    let observing = false;
    let stopping: Promise<boolean> | undefined;
    let stopTimer: NodeJS.Timeout | undefined;
    let stopInFlight = false;
    const retryStop = async () => {
      if (stopInFlight) return;
      stopInFlight = true;
      try { stopping = this.stop(containerId); await stopping; }
      finally { stopInFlight = false; }
    };
    const terminate = (kind: PhaseResult['failureKind']) => {
      if (!failureKind) failureKind = kind;
      void retryStop();
      // A start request can arrive after a stop observed the unit as merely created.
      stopTimer ??= setInterval(() => { void retryStop(); }, 100);
    };
    const receive = (chunks: Buffer[], bytes: Buffer) => {
      const remaining = Math.max(0, spec.outputBudget - outputBytes);
      if (remaining > 0) chunks.push(Buffer.from(bytes.subarray(0, remaining)));
      outputBytes += bytes.length;
      if (outputBytes > spec.outputBudget) terminate('output_limit');
    };
    const child = spawn(this.binary, [`--host=unix://${this.socket}`, 'start', '--attach', containerId], {
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', DOCKER_CONFIG: this.configDirectory },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (bytes: Buffer) => receive(stdout, bytes));
    child.stderr.on('data', (bytes: Buffer) => receive(stderr, bytes));
    const abort = () => terminate('cancelled');
    spec.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => terminate('timeout'), spec.timeoutMs);
    const resourceTimer = setInterval(async () => {
      if (observing) return;
      observing = true;
      try {
        if (!cgroupPath) {
          const pid = (await this.inspect(containerId)).State.Pid;
          if (pid > 0) {
            const group = readFileSync(`/proc/${pid}/cgroup`, 'utf8').match(/^0::(\/.*)$/m)?.[1];
            if (group) cgroupPath = `/sys/fs/cgroup${group}`;
          }
        }
        if (cgroupPath) {
          cgroupLimits ??= {
            cpuMax: readFileSync(`${cgroupPath}/cpu.max`, 'utf8').trim(),
            memoryMax: readFileSync(`${cgroupPath}/memory.max`, 'utf8').trim(),
            memorySwapMax: readFileSync(`${cgroupPath}/memory.swap.max`, 'utf8').trim(),
            pidsMax: readFileSync(`${cgroupPath}/pids.max`, 'utf8').trim(),
          };
          const value = readFileSync(`${cgroupPath}/pids.events`, 'utf8').match(/^max (\d+)$/m)?.[1];
          if (value) pidsMaxEvents = Math.max(pidsMaxEvents, Number(value));
        }
      } catch {
        // Short-lived units can disappear before observation; missing facts stay unknown.
      } finally {
        observing = false;
      }
    }, 50);
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', () => resolve());
      });
      if (stopping) await stopping;
      const state = (await this.inspect(containerId)).State;
      if (state.OOMKilled && !failureKind) failureKind = 'oom';
      if (pidsMaxEvents > 0 && !failureKind) failureKind = 'process_limit';
      if (state.Error && !failureKind) failureKind = 'infrastructure_error';
      const disk = statfsSync(spec.workDirectory);
      if (disk.bavail === 0 && !failureKind) failureKind = 'temp_limit';
      return { phase: spec.phase, containerId, imageId: spec.image, exitCode: state.ExitCode,
        stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'),
        outputBytes, durationMs: performance.now() - startedAt, pidsMaxEvents, ...(cgroupLimits ? { cgroupLimits } : {}),
        unitTerminated: !state.Running && state.Status === 'exited' && !state.FinishedAt.startsWith('0001-'),
        ...(failureKind ? { failureKind } : {}) };
    } finally {
      clearTimeout(timer);
      if (stopTimer) clearInterval(stopTimer);
      clearInterval(resourceTimer);
      spec.signal.removeEventListener('abort', abort);
    }
  }
}
