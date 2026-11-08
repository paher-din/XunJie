import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp as makeTemporaryDirectory, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const temporaryDirectories = new Set();
const temporaryEvidence = new Set();

function cleanup() {
  for (const directory of [...temporaryDirectories].reverse()) {
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      temporaryDirectories.delete(directory);
    } catch (error) {
      console.error(`Probe temporary directory cleanup failed: ${directory}: ${error.code}`);
      process.exitCode = 1;
    }
  }
}
// Includes explicit process.exit() and errors before a probe reaches its own finally block.
process.once('beforeExit', cleanup);
process.once('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    // Existing owners may need to stop PostgreSQL before removing their working files.
    if (process.listenerCount(signal)) return;
    cleanup();
    process.kill(process.pid, signal);
  });
}

export async function mkdtemp(prefix, options) {
  const directory = await makeTemporaryDirectory(prefix, options);
  temporaryDirectories.add(directory);
  return directory;
}

function outputArgument() {
  const args = process.argv.slice(2);
  const outputs = new Map();
  for (let index = 0; index < args.length; index++) {
    const match = /^(--out|--output|--evidence-dir)(?:=(.*))?$/.exec(args[index]);
    if (!match) continue;
    const value = match[2] ?? args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${match[1]} requires an output path`);
    outputs.set(match[1], { path: value, directory: match[1] === '--evidence-dir' });
  }
  return outputs.get('--out') ?? outputs.get('--output') ?? outputs.get('--evidence-dir');
}

function temporaryEvidenceDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'xj-probe-evidence-'));
  temporaryDirectories.add(directory);
  temporaryEvidence.add(directory);
  return directory;
}

// A real directory remains available for inputs consumed inside the probe.
export function probeEvidenceDirectory(explicitPath) {
  const path = outputArgument()?.path ?? explicitPath;
  return path ? resolve(path) : temporaryEvidenceDirectory();
}

export function probeEvidenceFile(explicitPath, name = 'report.json') {
  const argument = outputArgument();
  const path = argument?.path ?? explicitPath;
  if (path && argument?.directory) return join(resolve(path), name);
  return path ? resolve(path) : join(temporaryEvidenceDirectory(), name);
}

export function hasProbeEvidence(path) {
  if (!path) return false;
  return ![...temporaryEvidence].some(directory => {
    const suffix = relative(directory, resolve(path));
    return suffix === '' || (suffix !== '..' && !suffix.startsWith('..' + sep) && !isAbsolute(suffix));
  });
}

// Diagnostic writes are optional; inputs must keep using fs.writeFile.
export async function writeEvidence(path, ...args) {
  if (hasProbeEvidence(path)) await writeFile(path, ...args);
}

export async function captureEvidence(target, options) {
  if (hasProbeEvidence(options.path)) return target?.screenshot(options);
}

// A worker's result JSON may be a required protocol input without any PNG consumer.
// Jobs predating the switch still explicitly supply their screenshot destination.
export async function captureJobEvidence(job, target, result, name, options = {}) {
  if (job.captureEvidence === false || !job.screenshot) return;
  const path = options.path ?? job.screenshot;
  await target.screenshot({ ...options, path });
  result.screenshots.push({ name, path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') });
}
