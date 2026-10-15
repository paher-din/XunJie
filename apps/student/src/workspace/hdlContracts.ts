import type { SnapshotView } from './workspaceContracts'
import type { JobView, JobStatus } from './runContracts'

/** Browser projections of the existing HDL HTTP contract. No runner imports. */
export type HdlSignal = 'clock' | 'switches' | 'buttons' | 'resetN' | 'leds' | 'anodes' | 'segments' | 'dp'
export interface HdlBoardProfile { boardProfileVersion: string; mappingVersion: string; topModule: string
  bindings: Array<{ signal: HdlSignal; offset: number; port: string; portOffset: number; width: number }> }
export interface HdlIdentity { id: string; commandId: string; requestHash: string; recoveryGeneration: string
  scope: { courseId: string; studentId: string; attemptId: string; activityVersionId: string } }
export interface HdlInputs { switches: string; buttons: string; resetN: string }
export interface HdlFrame extends HdlInputs { simTimePs: string; leds: string; anodes: string; segments: string; dp: string }
export type HdlSignalFrame = HdlFrame
export interface HdlDiagnostic { severity: 'error' | 'warning'; message: string; fileId?: string; path?: string
  line?: number; location: 'line-only' | 'unavailable' }
export type HdlBuildStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'outcome_unknown'
export interface HdlBuildResult { buildId: string; identity: HdlIdentity; snapshotId: string; snapshotHash: string
  board: HdlBoardProfile; runtimeProfileVersion: string; engineVersion: string; imageDigest: string; configurationHash: string
  status: HdlBuildStatus; terminationConfirmed: boolean; artifactHash?: string; diagnostics: HdlDiagnostic[]
  stdout: string; stderr: string; failureKind?: string }
export interface HdlBuildView { request: { identity: HdlIdentity; snapshot: SnapshotView; board: HdlBoardProfile; runtimeProfileVersion: string }
  result: HdlBuildResult | null; status: HdlBuildStatus; jobId: string
  /** Browser-verified binding from the authorized Job, never trusted from the Build body. */
  execution?: HdlExecutionBinding }
export interface HdlSessionView { sessionId: string; identity: HdlIdentity; buildId: string; snapshotId: string; snapshotHash: string
  boardProfileVersion: string; mappingVersion: string; engineVersion: string; runtimeProfileVersion: string
  sessionRevision: number; confirmedSequence: number; simTimePs: string
  status: 'starting' | 'active' | 'stopping' | 'stopped' | 'failed' | 'outcome_unknown'
  terminationConfirmed: boolean; stopRequested: boolean; createdAt: string; deadline: string; lastOperationAt: string
  pendingOperationId?: string; failureKind?: string }
export interface HdlOperationResult { operationId: string; sessionId: string; buildId: string; snapshotId: string; snapshotHash: string
  boardProfileVersion: string; mappingVersion: string; engineVersion: string; sequence: number; sessionRevision: number
  frames: HdlFrame[]; finalFrame: HdlFrame; sampleCount: number; droppedFrames: number
  coverage: 'complete' | 'incomplete'; resultHash: string }
export type HdlTraceResult = HdlOperationResult
export interface HdlTraceOperation { operationId: string; sequence: number; status: string; result: HdlOperationResult | null }
export interface HdlTraceView { operation: HdlTraceOperation | null; nextSequence: number }
export interface HdlExecutionBinding { nodeId: string; nodeGeneration: string }
export type HdlJobView = Omit<JobView, 'kind'> & { kind: 'hdl_build' | 'hdl_program' | 'hdl_interact'; status: JobStatus; execution?: HdlExecutionBinding }
/** These identities come from an authorized Activity and same-origin readiness, never from the file extension. */
export interface HdlRuntimeProfile { runtimeProfileVersion: string; engineVersion: string; boardProfileVersion: string; mappingVersion: string
  buildImage?: string; recoveryGeneration: string | null; read?: () => Promise<boolean>
  readBuild?: () => Promise<boolean>; executionNodeId?: () => string | undefined
  configurationVersion?: string; contentHash?: string; sourceHash?: string }
export interface HdlReplacement { sessionId: string; sessionRevision: number }
export type HdlCommandKind = 'hdl.build' | 'hdl.program' | 'hdl.interact' | 'hdl.stop'
export interface HdlCreated { buildId?: string; sessionId?: string; operationId?: string; jobId?: string; attemptId?: string; stopRequested?: true }
