import type { PhaseResult } from './docker.ts';
import type { ResultFile } from './result-files.ts';
import { RunnerError } from './snapshot.ts';
import { matchesReport } from './report.ts';
import type { ReportExpectation } from './report.ts';
import { matchesStdout } from './stdout-records.ts';
import type { StdoutRecords } from './stdout-records.ts';

export type TrustedCase = {
  checkRuleVersion: string;
  validatorVersion: string;
  expectedExitCode: number;
  expectedStdout?: string;
  expectedStderr?: string;
  requireDiagnostic?: 'stderr' | 'either';
  expectedReport?: { relativeName: string; expectation: ReportExpectation };
  stdoutRecords?: StdoutRecords;
};

// Rules are supplied by trusted course configuration, never by stdout or a student request.
export function verifyCase(mode: 'run' | 'check', execution: PhaseResult,
  rule: TrustedCase | undefined, resultFiles: ResultFile[] = []) {
  if (mode === 'run') return undefined;
  if (!rule || !rule.checkRuleVersion || !rule.validatorVersion
    || !Number.isInteger(rule.expectedExitCode)
    || (typeof rule.expectedStdout !== 'string' && !rule.expectedReport && !rule.requireDiagnostic && !rule.stdoutRecords)) {
    throw new RunnerError('INVALID_CONFIGURATION', 'Trusted check rule is required');
  }
  const report = rule.expectedReport ? resultFiles.find(file => file.relativeName === rule.expectedReport!.relativeName) : undefined;
  const incomplete = execution.phase !== 'execute' || !execution.unitTerminated || Boolean(execution.failureKind)
    || (resultFiles.length > 0 && !rule.expectedReport)
    || Boolean(rule.expectedReport && (!report || report.status !== 'complete' || typeof report.text !== 'string'));
  return {
    checkRuleVersion: rule.checkRuleVersion,
    validatorVersion: rule.validatorVersion,
    verdict: incomplete ? 'incomplete' : execution.exitCode === rule.expectedExitCode
      && (rule.expectedStdout === undefined || execution.stdout === rule.expectedStdout)
      && (rule.expectedStderr === undefined || execution.stderr === rule.expectedStderr)
      && (!rule.stdoutRecords || matchesStdout(execution.stdout, rule.stdoutRecords))
      && (!rule.requireDiagnostic || (rule.requireDiagnostic === 'stderr' ? execution.stderr : execution.stderr + execution.stdout).trim().length > 0)
      && (!rule.expectedReport || matchesReport(report!.text!, rule.expectedReport.expectation)) ? 'passed' : 'failed',
  };
}
