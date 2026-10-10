import type { RunIdentity } from '../../runner/control.ts';
import type { Snapshot } from '../../runner/snapshot.ts';
import type { TextScopeInput, Profile } from '../../runner/run-snapshot.ts';
import type { buildRunWork } from '../../runner/run-snapshot.ts';
import type { RunControl } from '../../runner/control.ts';
export type { RunIdentity, Snapshot, TextScopeInput, Profile };
export type { PhaseResult } from '../../runner/docker.ts';
export type { ResultFile } from '../../runner/result-files.ts';
export type { TrustedCase } from '../../runner/verify.ts';
export type RunFact = NonNullable<Awaited<ReturnType<RunControl['queryRun']>>>;
export type RunRecord = Awaited<ReturnType<ReturnType<typeof buildRunWork>>>;

export type SubmitRun = { identity:RunIdentity; snapshot:Snapshot; entryFileId:string;
  input:TextScopeInput; mode:'run'|'check'; checkRuleVersion?:string };
export type RunnerCommand =
  | {op:'submit';submission:SubmitRun}
  | {op:'query'|'cancel'|'readResult';identity:RunIdentity}
  | {op:'readiness'}
  | {op:'recover'}
  | {op:'advanceGeneration';generation:string};
