import { execFileSync } from 'node:child_process';
import { chownSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RunIdentity } from './control.ts';
import type { DockerExecutor, PhaseResult } from './docker.ts';
import { collectResultFiles } from './result-files.ts';
import { compilerArgs, RunnerError, sha256, validatePath, validateSnapshot } from './snapshot.ts';
import type { Snapshot } from './snapshot.ts';
import { verifyCase } from './verify.ts';
import type { TrustedCase } from './verify.ts';

export type TextScopeInput = { operation: 'stats' | 'find' | 'top' | 'report'; fileIds: string[];
  word?: string; count?: string; resultFile?: string };
export type Profile = { runtimeProfileVersion: string; imageDigest: string; compilerImage: string;
  runtimeImage: string; approvedResultFiles: string[] };

export function textScopeArgs(snapshot: Snapshot, input: TextScopeInput, approvedResultFiles: string[]) {
  if (!input || !['stats', 'find', 'top', 'report'].includes(input.operation)
    || !Array.isArray(input.fileIds) || input.fileIds.length < 1
    || input.fileIds.length > 50 || new Set(input.fileIds).size !== input.fileIds.length) {
    throw new RunnerError('INVALID_REQUEST', 'Invalid course operation or input selection');
  }
  const files = input.fileIds.map(id => {
    const file = snapshot.files.find(file => file.fileId === id);
    if (!file || !/^[\x00-\x7f]*$/.test(file.text)) throw new RunnerError('INVALID_REFERENCE', 'Input must be an approved ASCII snapshot file');
    return `/snapshot/${file.path}`;
  });
  if (input.operation === 'stats') return ['stats', ...files];
  if (input.operation === 'find') {
    if (typeof input.word !== 'string' || !/^[A-Za-z0-9]+$/.test(input.word)) {
      throw new RunnerError('INVALID_REQUEST', 'Query must be one ASCII word');
    }
    return ['find', input.word, ...files];
  }
  if (input.operation === 'top') {
    if (typeof input.count !== 'string' || !/^[1-9][0-9]*$/.test(input.count)) {
      throw new RunnerError('INVALID_REQUEST', 'Top count must be a positive integer');
    }
    return ['top', '-n', input.count, ...files];
  }
  validatePath(input.resultFile);
  if (!approvedResultFiles.includes(input.resultFile)) throw new RunnerError('INVALID_CONFIGURATION', 'Result file is not approved');
  return ['report', '-o', `/work/${input.resultFile}`, ...files];
}

export function buildRunWork(executor: DockerExecutor, root: string, identity: RunIdentity,
  snapshot: Snapshot, entryFileId: string, input: TextScopeInput, profile: Profile,
  checks?: { args: string[]; rule: TrustedCase }[]) {
  snapshot = structuredClone(snapshot);
  input = structuredClone(input);
  profile = structuredClone(profile);
  identity = structuredClone(identity);
  checks = checks ? structuredClone(checks) : undefined;
  validateSnapshot(snapshot);
  const compile = compilerArgs(snapshot, entryFileId);
  const args = textScopeArgs(snapshot, input, profile.approvedResultFiles);
  if (identity.snapshotId !== snapshot.snapshotId || identity.snapshotHash !== snapshot.hash
    || identity.inputHash !== sha256(JSON.stringify(args))
    || identity.runtimeProfileVersion !== profile.runtimeProfileVersion || identity.imageDigest !== profile.imageDigest) {
    throw new RunnerError('INVALID_REFERENCE', 'Original run references do not match the fixed payload');
  }
  profile.approvedResultFiles.forEach(validatePath);
  if (new Set(profile.approvedResultFiles).size !== profile.approvedResultFiles.length
    || ![profile.compilerImage, profile.runtimeImage].every(image => /^sha256:[0-9a-f]{64}$/.test(image))) {
    throw new RunnerError('INVALID_CONFIGURATION', 'Invalid fixed runtime profile');
  }
  return async (signal: AbortSignal, phase: <T extends { unitTerminated: boolean }>(name: string,
    operation: () => Promise<T>) => Promise<T>) => {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const directory = mkdtempSync(join(root, 'run-'));
    const sourceDirectory = join(directory, 'snapshot');
    const workDirectory = join(directory, 'work');
    mkdirSync(sourceDirectory, { mode: 0o755 });
    mkdirSync(workDirectory, { mode: 0o700 });
    for (const file of snapshot.files) {
      const path = join(sourceDirectory, file.path);
      mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
      writeFileSync(path, file.text, { flag: 'wx', mode: 0o444 });
    }
    execFileSync('/usr/bin/mount', ['-t', 'tmpfs', '-o', 'size=134217728,mode=0700,uid=65534,gid=65534,nosuid,nodev', 'tmpfs', workDirectory]);
    mkdirSync(join(workDirectory, 'tmp'), { mode: 0o700 });
    chownSync(join(workDirectory, 'tmp'), 65534, 65534);
    const name = `xunjie-${sha256(identity.runId)}`;
    const compiled = await phase(`${name}-compile`, () => executor.execute({ phase: 'compile', name: `${name}-compile`,
      image: profile.compilerImage, sourceDirectory, workDirectory, args: compile, timeoutMs: 30000,
      outputBudget: 65536, signal }, () => {}));
    if (compiled.failureKind || compiled.exitCode !== 0 || signal.aborted) {
      return { runId: identity.runId, snapshotId: snapshot.snapshotId, snapshotHash: snapshot.hash,
        inputHash: identity.inputHash, runtimeProfileVersion: profile.runtimeProfileVersion,
        imageDigest: profile.imageDigest, unitTerminated: compiled.unitTerminated,
        phases: [compiled], failureKind: compiled.failureKind ?? (signal.aborted ? 'cancelled' : 'compile_error'),
        verdict: checks ? 'incomplete' : undefined, checkResults: checks ? [] : undefined };
    }
    const cases = checks ?? [{ args, rule: undefined }];
    const executions = [];
    const checkResults = [];
    const allResultFiles = [];
    let outputBytes = compiled.outputBytes;
    let elapsedMs = 0;
    let failureKind: PhaseResult['failureKind'];
    let unitTerminated = true;
    for (let index = 0; index < cases.length; index++) {
      if (signal.aborted || elapsedMs >= 10000 || outputBytes > 65536) {
        failureKind = signal.aborted ? 'cancelled' : elapsedMs >= 10000 ? 'timeout' : 'output_limit';
        break;
      }
      const caseWork = checks ? join(workDirectory, `case-${index}`) : workDirectory;
      if (checks) {
        mkdirSync(caseWork, { mode: 0o700 });
        chownSync(caseWork, 65534, 65534);
        mkdirSync(join(caseWork, 'tmp'), { mode: 0o700 });
        chownSync(join(caseWork, 'tmp'), 65534, 65534);
      }
      const caseName = checks ? `${name}-execute-${index}` : `${name}-execute`;
      const executed = await phase(caseName, () => executor.execute({ phase: 'execute', name: caseName,
        image: profile.runtimeImage, sourceDirectory, workDirectory: caseWork, args: cases[index]!.args,
        ...(checks ? { binaryPath: join(workDirectory, 'textscope') } : {}),
        timeoutMs: Math.max(1, Math.floor(10000 - elapsedMs)), outputBudget: Math.max(0, 65536 - outputBytes), signal }, () => {}));
      executions.push(executed);
      elapsedMs += executed.durationMs;
      outputBytes += executed.outputBytes;
      unitTerminated &&= executed.unitTerminated;
      failureKind = executed.failureKind;
      let resultFiles;
      try {
        resultFiles = collectResultFiles(caseWork, checks && !cases[index]!.rule?.expectedReport ? [] : profile.approvedResultFiles,
          Math.max(0, 65536 - outputBytes), executed.unitTerminated);
      } catch (error) {
        if (error instanceof RunnerError && error.code === 'CONTENT_LIMIT') failureKind = 'output_limit';
        else throw error;
      }
      if (failureKind) resultFiles = resultFiles?.map(file => file.status === 'complete' ? { ...file, status: 'incomplete' as const } : file);
      for (const file of resultFiles ?? []) {
        outputBytes += file.bytes ?? 0;
        allResultFiles.push({ ...file, runId: identity.runId, snapshotId: snapshot.snapshotId,
          resultFileId: sha256(JSON.stringify([identity.runId, snapshot.snapshotId, index, file.relativeName, file.contentHash])),
          source: 'runner_result_file', caseIndex: index });
      }
      if (checks) checkResults.push({ ...verifyCase('check', { ...executed, ...(failureKind ? { failureKind } : {}) }, cases[index]!.rule, resultFiles),
        runId: identity.runId, snapshotId: snapshot.snapshotId, snapshotHash: snapshot.hash, inputHash: identity.inputHash,
        imageDigest: profile.imageDigest, caseIndex: index, source: 'trusted_validator' });
      if (failureKind) break;
    }
    return { runId: identity.runId, snapshotId: snapshot.snapshotId, snapshotHash: snapshot.hash,
      inputHash: identity.inputHash, runtimeProfileVersion: profile.runtimeProfileVersion,
      imageDigest: profile.imageDigest, unitTerminated,
      phases: [compiled, ...executions], resultFiles: allResultFiles, checkResults: checks ? checkResults : undefined,
      verdict: checks ? failureKind || checkResults.length !== checks.length ? 'incomplete'
        : checkResults.every(result => result.verdict === 'passed') ? 'passed' : 'failed' : undefined,
      failureKind: failureKind ?? (!checks && executions[0]?.exitCode ? 'program_error' : undefined) };
  };
}
