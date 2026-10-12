import type { Snapshot } from './index.ts';

export type HdlSignal = 'clock'|'switches'|'buttons'|'resetN'|'leds'|'anodes'|'segments'|'dp';
export type HdlBinding = {signal:HdlSignal;offset:number;port:string;portOffset:number;width:number};
export type BoardProfile = {boardProfileVersion:string;mappingVersion:string;topModule:string;bindings:HdlBinding[]};
export type HdlIdentity = {id:string;commandId:string;requestHash:string;recoveryGeneration:string;
  scope:{courseId:string;studentId:string;attemptId:string;activityVersionId:string}};
export type HdlBuildRequest = {identity:HdlIdentity;snapshot:Snapshot;board:BoardProfile;runtimeProfileVersion:string};
export type HdlDiagnostic = {severity:'error'|'warning';message:string;fileId?:string;path?:string;line?:number;location:'line-only'|'unavailable'};
export type HdlBuild = {buildId:string;identity:HdlIdentity;snapshotId:string;snapshotHash:string;board:BoardProfile;
  runtimeProfileVersion:string;engineVersion:string;imageDigest:string;configurationHash:string;
  status:'queued'|'running'|'succeeded'|'failed'|'cancelled'|'outcome_unknown';terminationConfirmed:boolean;
  artifactHash?:string;diagnostics:HdlDiagnostic[];stdout:string;stderr:string;failureKind?:string};
export type HdlInputs = {switches:string;buttons:string;resetN:string};
export type SignalFrame = {simTimePs:string;switches:string;buttons:string;resetN:string;
  leds:string;anodes:string;segments:string;dp:string};
export type HdlOperation = {identity:HdlIdentity;sessionId:string;expectedSessionRevision:number;expectedSequence:number;
  inputs:HdlInputs;advanceCycles:number};
export type HdlOperationResult = {operationId:string;sessionId:string;buildId:string;snapshotId:string;snapshotHash:string;
  boardProfileVersion:string;mappingVersion:string;engineVersion:string;sequence:number;sessionRevision:number;
  frames:SignalFrame[];finalFrame:SignalFrame;sampleCount:number;droppedFrames:number;coverage:'complete'|'incomplete';resultHash:string};
export type HdlSession = {sessionId:string;identity:HdlIdentity;buildId:string;snapshotId:string;snapshotHash:string;
  boardProfileVersion:string;mappingVersion:string;engineVersion:string;runtimeProfileVersion:string;
  sessionRevision:number;confirmedSequence:number;simTimePs:string;
  status:'starting'|'active'|'stopping'|'stopped'|'failed'|'outcome_unknown';terminationConfirmed:boolean;
  stopRequested:boolean;createdAt:string;deadline:string;lastOperationAt:string;pendingOperationId?:string|undefined;failureKind?:string|undefined};
export type HdlProgram = {identity:HdlIdentity;buildId:string;replaceSessionId?:string;expectedSessionRevision?:number};
export type HdlCommand =
  | {op:'hdl_readiness'}
  | {op:'hdl_build';request:HdlBuildRequest}
  | {op:'hdl_program';request:HdlProgram}
  | {op:'hdl_interact';request:HdlOperation}
  | {op:'hdl_query'|'hdl_stop';identity:HdlIdentity}
  | {op:'hdl_result';identity:HdlIdentity;operationId:string};
export type HdlRuntime = {runtimeProfileVersion:string;engineVersion:string;buildImage:string;runtimeImage:string;sourceHash:string};
