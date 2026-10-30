// Backend-only runner protocol. Authorization and trusted course rules are not browser API.

export type SnapshotFile = {
  fileId: string;
  path: string;
  documentVersion: number;
  text: string;
  contentHash: string;
};

export type Snapshot = {
  snapshotId: string;
  hashFormat: 'sha256-manifest-v1';
  hash: string;
  files: SnapshotFile[];
};

export type RunIdentity = {
  runId: string;
  commandId: string;
  requestHash: string;
  recoveryGeneration: string;
  snapshotId: string;
  snapshotHash: string;
  inputHash: string;
  runtimeProfileVersion: string;
  imageDigest: string;
  authorizedScope: { userId: string; courseId: string; purpose: 'student_run' | 'teacher_sample';
    attemptId?: string; activityVersionId?: string };
};

export type RunState = 'queued' | 'running' | 'cancelling' | 'cancelled' | 'succeeded' | 'failed' | 'stale' | 'outcome_unknown';
export type RunFact = { identity: RunIdentity; state: RunState; reserved: boolean; stopRequested: boolean;
  units: string[]; pending: string[]; resultRef?: string; resultHash?: string };

export type TextScopeInput = { operation: 'stats' | 'find' | 'top' | 'report'; fileIds: string[];
  word?: string; count?: string; resultFile?: string };
export type Profile = { runtimeProfileVersion: string; imageDigest: string; compilerImage: string;
  runtimeImage: string; approvedResultFiles: string[] };

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

export type ResultFile = {
  relativeName: string;
  status: 'complete' | 'missing' | 'incomplete';
  text?: string;
  contentHash?: string;
  bytes?: number;
};

export type FileStatistics = { path: string; lines: number; words: number; bytes: number };
export type ReportExpectation = { files: FileStatistics[]; total: [number, number, number];
  unique: number; top: { word: string; count: number }[] };

export type StdoutRecords =
  | {kind:'stats';records:{path:string;values:number[]}[];total:number[]}
  | {kind:'top';records:{word:string;count:number}[]}
  | {kind:'find';records:{path:string;line:number;text:string}[]};

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

export type RunRecord = {
  runId: string; snapshotId: string; snapshotHash: string; inputHash: string;
  runtimeProfileVersion: string; imageDigest: string; unitTerminated: boolean;
  phases: PhaseResult[]; failureKind: string | undefined;
  verdict: string | undefined;
  resultFiles?: (ResultFile & { runId: string; snapshotId: string; resultFileId: string;
    source: string; caseIndex: number })[];
  checkResults: { checkRuleVersion?: string; validatorVersion?: string; verdict?: string;
    runId: string; snapshotId: string; snapshotHash: string; inputHash: string;
    imageDigest: string; caseIndex: number; source: string }[] | undefined;
};
