import type { RunIdentity, Snapshot, TextScopeInput } from '../internal/run.ts';
export type { RunIdentity, Snapshot, TextScopeInput, Profile, PhaseResult, ResultFile, TrustedCase, RunFact, RunRecord } from '../internal/run.ts';

export type SubmitRun = { identity:RunIdentity; snapshot:Snapshot; entryFileId:string;
  input:TextScopeInput; mode:'run'|'check'; checkRuleVersion?:string };
export type RunnerCommand =
  | {op:'submit';submission:SubmitRun}
  | {op:'query'|'cancel'|'readResult';identity:RunIdentity}
  | {op:'readiness'}
  | {op:'editor_diagnostics';packet:import('../workspace/editor-diagnostics.ts').EditorDiagnosticsPacket}
  | {op:'recover'}
  | {op:'advanceGeneration';generation:string}
  | import('./hdl.ts').HdlCommand;
